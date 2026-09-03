import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";

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
    data.isCompleted = completedFlag;
    if (completedFlag && progressValue === undefined) {
      data.progress = 100;
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
