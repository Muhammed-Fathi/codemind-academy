import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  ok,
  err,
  requireUser,
  getStudentProfile,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
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

  // Phase 20 — shared limiter (see rate-limit.ts). Applied before the gating
  // computation so a spammy client cannot DoS the progression query.
  const rl = await applyRateLimit("progress", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

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

  // The 95% video rule is evaluated ONCE, up front, and applies to EVERY route
  // that can set isCompleted. Previously `progress: 100` set isCompleted
  // directly without consulting the video threshold, which re-opened exactly
  // the bypass the `completed` flag guards against: a client could POST
  // { progress: 100 } and complete a lesson it never watched.
  //
  // `videoWatchedSec` / `videoPercent` are only ever written by the heartbeat
  // route, which credits real elapsed wall-clock time — so this check cannot
  // be satisfied by a forged request.
  const existingProgress = await db.lessonProgress.findUnique({
    where: { studentId_lessonId: { studentId: s.id, lessonId: id } },
    select: { videoCompleted: true, videoPercent: true },
  });
  const videoSatisfied =
    !lesson.videoUrl ||
    !!existingProgress?.videoCompleted ||
    (existingProgress?.videoPercent ?? 0) >= VIDEO_COMPLETION_THRESHOLD;

  if (progressValue !== undefined) {
    data.progress = progressValue;
    if (progressValue >= 100) {
      if (!videoSatisfied) return err(tApi("api.209"), 403);
      data.isCompleted = true;
    }
  }
  if (completedFlag !== undefined) {
    if (completedFlag) {
      if (!videoSatisfied) return err(tApi("api.209"), 403);
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
