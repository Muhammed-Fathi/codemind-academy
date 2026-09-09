import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { canTransition, getLessonReadiness } from "@/lib/session-lifecycle";

// POST /api/admin/lessons/[id]/open — authoritative publishing ceremony
// ADMIN only, idempotent, readiness-aware, track-safe, progression-safe.
// Implements READY → PUBLISHED via server-side check. DRAFT → PUBLISHED is forbidden.
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const role = await requireRole("ADMIN");
  if (role.error) return role.error;

  const { id } = await params;

  const lesson = await db.lesson.findUnique({
    where: { id },
    include: {
      unit: { select: { part: { select: { courseId: true } } } },
      topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } },
      quizzes: {
        include: { questions: { select: { id: true } } },
      },
      homeworks: { select: { id: true, trackScope: true, deadline: true } },
      sessionVideos: { select: { id: true } },
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  const curriculumStatus = (lesson as any).curriculumStatus;
  const currentStatus = (lesson as any).status as string;

  // ARCHIVED can never be published
  if (curriculumStatus === "ARCHIVED") {
    return err("Archived lessons cannot be published", 400);
  }

  // Idempotent: already PUBLISHED
  if (currentStatus === "PUBLISHED") {
    const readiness = getLessonReadiness({
      id: lesson.id,
      status: currentStatus,
      curriculumStatus,
      trackScope: (lesson as any).trackScope,
      videoUrl: (lesson as any).videoUrl,
      pdfUrl: (lesson as any).pdfUrl,
      quizzes: lesson.quizzes.map((q: any) => ({
        trackScope: q.trackScope,
        questions: q.questions,
      })),
      homeworks: lesson.homeworks.map((h: any) => ({
        trackScope: h.trackScope,
        deadline: h.deadline,
      })),
      sessionVideos: (lesson as any).sessionVideos,
    });
    return ok({
      lesson: {
        id: lesson.id,
        status: "PUBLISHED",
        publishedAt: (lesson as any).publishedAt,
      },
      readiness,
      alreadyPublished: true,
    });
  }

  // Only READY may be opened — DRAFT must stage via READY first
  if (currentStatus !== "READY") {
    return err(
      `Lesson must be READY to publish (current: ${currentStatus}). Stage to READY first.`,
      400
    );
  }

  // Compute readiness using SAME helper as the readiness endpoint
  const readiness = getLessonReadiness({
    id: lesson.id,
    status: currentStatus,
    curriculumStatus,
    trackScope: (lesson as any).trackScope,
    videoUrl: (lesson as any).videoUrl,
    pdfUrl: (lesson as any).pdfUrl,
    quizzes: lesson.quizzes.map((q: any) => ({
      trackScope: q.trackScope,
      questions: q.questions,
    })),
    homeworks: lesson.homeworks.map((h: any) => ({
      trackScope: h.trackScope,
      deadline: h.deadline,
    })),
    sessionVideos: (lesson as any).sessionVideos,
  });

  if (!readiness.isReady) {
    return err(`Lesson is not ready: ${readiness.errors.join(", ")}`, 400);
  }

  // Validate transition via pure state machine (defense-in-depth)
  const trans = canTransition(currentStatus, "PUBLISHED", {
    readiness,
    curriculumStatus,
  });
  if (!trans.ok) {
    return err(trans.message, 400);
  }

  // Transactional publish — mirror isPublished for compatibility
  const updated = await db.lesson.update({
    where: { id },
    data: {
      status: "PUBLISHED",
      isPublished: true,
      publishedAt: new Date(),
    },
    select: { id: true, status: true, publishedAt: true },
  });

  return ok({
    lesson: updated,
    readiness,
    alreadyPublished: false,
  });
}
