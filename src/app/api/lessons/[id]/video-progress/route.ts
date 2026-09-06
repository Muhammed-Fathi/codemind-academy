// POST /api/lessons/[id]/video-progress
// Body: { positionSec: number, durationSec: number }
//
// Server-verified video watch tracking used for the 95% completion rule.
//
// Anti-tampering: the client sends a heartbeat every few seconds with its
// current playhead. The server credits watch time by the WALL-CLOCK gap since
// the previous heartbeat, capped at the elapsed real time. A client that
// simply posts `positionSec = duration` therefore gains only the few seconds
// that have actually passed, and cannot jump to completion. Watched time is
// monotonic, so seeking backwards or refreshing never loses progress.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { canAccessLesson } from "@/lib/session-progress";
import { getServerT } from "@/lib/i18n-server";

/** Heartbeats further apart than this are treated as a resumed session. */
const MAX_CREDIT_PER_BEAT_SEC = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err(tApi("api.095"), 404);

  // Backend authorization — a locked lesson cannot accrue progress.
  const access = await canAccessLesson(student.id, id);
  if (!access.allowed) {
    if (access.reason === "NOT_ENROLLED") return err(tApi("api.208"), 403);
    if (access.reason === "LESSON_NOT_FOUND") return err("Lesson not found", 404);
    return err(tApi("api.209"), 403);
  }

  const body = await req.json().catch(() => ({}));
  const positionSec = Math.max(0, Math.floor(Number(body.positionSec) || 0));
  const durationSec = Math.max(0, Math.floor(Number(body.durationSec) || 0));
  if (durationSec <= 0) return err("durationSec is required", 400);

  const now = new Date();
  const existing = await db.lessonProgress.findUnique({
    where: { studentId_lessonId: { studentId: student.id, lessonId: id } },
  });

  // Real seconds since the last heartbeat — this is the credit ceiling.
  const elapsedSec = existing?.lastHeartbeatAt
    ? Math.max(0, Math.floor((now.getTime() - existing.lastHeartbeatAt.getTime()) / 1000))
    : 0;
  const credit = Math.min(elapsedSec, MAX_CREDIT_PER_BEAT_SEC);

  // Monotonic watched time, additionally capped by the playhead and duration:
  // you cannot have watched more than where you are, or more than the video.
  const previousWatched = existing?.videoWatchedSec ?? 0;
  const watchedSec = Math.min(
    durationSec,
    Math.max(previousWatched, Math.min(previousWatched + credit, positionSec))
  );

  const percent = Math.min(100, Math.round((watchedSec / durationSec) * 100));
  const alreadyCompleted = existing?.videoCompleted ?? false;
  const videoCompleted = alreadyCompleted || percent >= VIDEO_COMPLETION_THRESHOLD;

  const record = await db.lessonProgress.upsert({
    where: { studentId_lessonId: { studentId: student.id, lessonId: id } },
    create: {
      studentId: student.id,
      lessonId: id,
      progress: percent,
      videoDurationSec: durationSec,
      videoWatchedSec: watchedSec,
      videoPercent: percent,
      videoCompleted,
      videoCompletedAt: videoCompleted ? now : null,
      lastHeartbeatAt: now,
      lastViewedAt: now,
    },
    update: {
      videoDurationSec: durationSec,
      videoWatchedSec: watchedSec,
      videoPercent: percent,
      videoCompleted,
      // Never overwrite the original completion timestamp.
      ...(videoCompleted && !alreadyCompleted ? { videoCompletedAt: now } : {}),
      lastHeartbeatAt: now,
      lastViewedAt: now,
      // Keep the coarse legacy `progress` column in step, never decreasing.
      progress: Math.max(existing?.progress ?? 0, percent),
    },
  });

  return ok({
    lessonId: id,
    videoPercent: record.videoPercent,
    videoWatchedSec: record.videoWatchedSec,
    videoCompleted: record.videoCompleted,
    threshold: VIDEO_COMPLETION_THRESHOLD,
  });
}
