import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { canTransition, getLessonReadiness } from "@/lib/session-lifecycle";

// POST /api/admin/lessons/[id]/ready — DRAFT → READY staging
// ADMIN only, readiness-gated. Idempotent: READY stays READY.
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
      quizzes: { include: { questions: { select: { id: true } } } },
      homeworks: { select: { id: true, trackScope: true, deadline: true } },
      sessionVideos: { select: { id: true } },
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  const curriculumStatus = (lesson as any).curriculumStatus;
  const currentStatus = (lesson as any).status as string;

  if (curriculumStatus === "ARCHIVED") {
    return err("Archived lessons cannot be staged", 400);
  }

  if (currentStatus === "READY") {
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
      lesson: { id: lesson.id, status: "READY" },
      readiness,
      alreadyReady: true,
    });
  }

  if (currentStatus !== "DRAFT") {
    return err(`Lesson must be DRAFT to stage READY (current: ${currentStatus})`, 400);
  }

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

  const trans = canTransition(currentStatus, "READY", {
    readiness,
    curriculumStatus,
  });
  if (!trans.ok) {
    return err(trans.message, 400);
  }

  const updated = await db.lesson.update({
    where: { id },
    data: {
      status: "READY",
      isPublished: false,
    },
    select: { id: true, status: true },
  });

  return ok({ lesson: updated, readiness, alreadyReady: false });
}
