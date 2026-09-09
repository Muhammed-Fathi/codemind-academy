import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { getLessonReadiness } from "@/lib/session-lifecycle";

// GET /api/admin/lessons/[id]/readiness — ADMIN only
// Returns deterministic readiness for the lesson, using the same helper as OPEN.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const role = await requireRole("ADMIN");
  if (role.error) return role.error;

  const { id } = await params;
  const lesson = await db.lesson.findUnique({
    where: { id },
    include: {
      quizzes: {
        include: { questions: { select: { id: true } } },
      },
      homeworks: { select: { id: true, trackScope: true, deadline: true } },
      sessionVideos: { select: { id: true } },
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  const readiness = getLessonReadiness({
    id: lesson.id,
    status: (lesson as any).status,
    curriculumStatus: (lesson as any).curriculumStatus,
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

  return ok({ readiness });
}
