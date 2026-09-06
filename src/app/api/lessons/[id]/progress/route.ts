import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { canAccessLesson } from "@/lib/session-progress";
import { getServerT } from "@/lib/i18n-server";

// POST /api/lessons/[id]/progress
// Body: { progress?: number, completed?: boolean }
// Upserts LessonProgress for the current student.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const s = await getStudentProfile(user.id);
  if (!s) return err("Student profile not found", 404);

  const lesson = await db.lesson.findUnique({ where: { id } });
  if (!lesson) return err("Lesson not found", 404);

  // Backend authorization: enrollment + session progression are enforced here,
  // not only hidden in the UI.
  const tApi = await getServerT();
  const access = await canAccessLesson(s.id, id);
  if (!access.allowed) {
    if (access.reason === "NOT_ENROLLED") return err(tApi("api.208"), 403);
    return err(tApi("api.209"), 403);
  }

  const body = await req.json().catch(() => ({}));
  const progressValue =
    typeof body.progress === "number"
      ? Math.max(0, Math.min(100, body.progress))
      : undefined;
  const completedFlag =
    typeof body.completed === "boolean" ? body.completed : undefined;

  const data: {
    progress?: number;
    isCompleted?: boolean;
    lastViewedAt: Date;
  } = { lastViewedAt: new Date() };

  if (progressValue !== undefined) {
    data.progress = progressValue;
    if (progressValue >= 100) data.isCompleted = true;
  }
  if (completedFlag !== undefined) {
    if (completedFlag) {
      // A lesson that HAS a video can only be marked complete once the
      // server-tracked watch time reached the 95% threshold. This closes the
      // trivial "click Mark as complete" bypass.
      const existing = await db.lessonProgress.findUnique({
        where: { studentId_lessonId: { studentId: s.id, lessonId: id } },
        select: { videoCompleted: true, videoPercent: true },
      });
      const videoSatisfied =
        !lesson.videoUrl ||
        !!existing?.videoCompleted ||
        (existing?.videoPercent ?? 0) >= VIDEO_COMPLETION_THRESHOLD;
      if (!videoSatisfied) {
        return err(tApi("api.209"), 403);
      }
      data.isCompleted = true;
      if (progressValue === undefined) data.progress = 100;
    } else {
      data.isCompleted = false;
    }
  }

  const lp = await db.lessonProgress.upsert({
    where: { studentId_lessonId: { studentId: s.id, lessonId: id } },
    update: data,
    create: {
      studentId: s.id,
      lessonId: id,
      progress: data.progress ?? 0,
      isCompleted: data.isCompleted ?? false,
      lastViewedAt: new Date(),
    },
  });

  return ok({
    lessonId: id,
    progress: lp.progress,
    isCompleted: lp.isCompleted,
    lastViewedAt: lp.lastViewedAt,
  });
}
