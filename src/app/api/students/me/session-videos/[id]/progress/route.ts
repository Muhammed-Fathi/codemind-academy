// POST /api/students/me/session-videos/[id]/progress
// Body: { positionSec, durationSec }
//
// Same server-verified, tamper-resistant heartbeat model as lesson videos:
// watch time is credited by real elapsed wall-clock time between heartbeats,
// is monotonic, and completion requires the batch video's requiredPercent
// (95% by default).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser, ok, err } from "@/lib/api";
import { canAccessLesson } from "@/lib/session-progress";

const MAX_CREDIT_PER_BEAT_SEC = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    select: { id: true, batchId: true },
  });
  if (!student) return err("Student profile not found", 404);

  // The video must be published AND belong to the student's own batch.
  const video = await db.sessionVideo.findUnique({
    where: { id },
    select: {
      id: true,
      batchId: true,
      isPublished: true,
      requiredPercent: true,
      lessonId: true,
    },
  });
  if (!video || !video.isPublished) return err("Not found", 404);
  if (!student.batchId || video.batchId !== student.batchId)
    return err("Forbidden", 403);

  // SECURITY: accruing watch time against a locked session's video would let a
  // student satisfy the 95% requirement of a session they were never allowed
  // to open, and thereby unlock everything before it. Gate the heartbeat with
  // the same rule that gates the lesson itself.
  if (video.lessonId) {
    const access = await canAccessLesson(student.id, video.lessonId);
    if (!access.allowed) return err("Forbidden", 403);
  }

  const body = await req.json().catch(() => ({}));
  const positionSec = Math.max(0, Math.floor(Number(body.positionSec) || 0));
  const durationSec = Math.max(0, Math.floor(Number(body.durationSec) || 0));
  if (durationSec <= 0) return err("durationSec is required", 400);

  const now = new Date();

  // CONCURRENCY: two heartbeats in flight at once (duplicated tab, retried
  // request, flaky network) both read the same `previous` value and then both
  // write. Under last-write-wins the smaller result can land second and pull
  // watchedSec BACKWARDS, which is visible to the student as progress that
  // resets and — worse — can un-satisfy a completion requirement that had
  // already unlocked the next session.
  //
  // The read-compute-write is therefore done inside a transaction, and the
  // final write is additionally guarded so it can only ever raise watchedSec.
  // Both constructs are plain SQL semantics and behave identically on
  // PostgreSQL, so this does not add a SQLite-specific dependency.
  const view = await db.$transaction(async (tx) => {
    const existing = await tx.sessionVideoView.findUnique({
      where: {
        sessionVideoId_studentId: { sessionVideoId: id, studentId: student.id },
      },
    });

    const elapsedSec = existing?.lastHeartbeatAt
      ? Math.max(
          0,
          Math.floor((now.getTime() - existing.lastHeartbeatAt.getTime()) / 1000)
        )
      : 0;
    const credit = Math.min(elapsedSec, MAX_CREDIT_PER_BEAT_SEC);
    const previous = existing?.watchedSec ?? 0;
    const watchedSec = Math.min(
      durationSec,
      Math.max(previous, Math.min(previous + credit, positionSec))
    );
    const percent = Math.min(100, Math.round((watchedSec / durationSec) * 100));
    const wasCompleted = existing?.isCompleted ?? false;
    // Completion is a latch: once earned it is never revoked by a later
    // heartbeat, so an unlocked session cannot silently re-lock.
    const isCompleted = wasCompleted || percent >= video.requiredPercent;

    if (!existing) {
      return tx.sessionVideoView.create({
        data: {
          sessionVideoId: id,
          studentId: student.id,
          watchedSec,
          durationSec,
          percent,
          isCompleted,
          completedAt: isCompleted ? now : null,
          lastHeartbeatAt: now,
        },
      });
    }

    // Monotonic guard: only apply when this result is actually an advance.
    await tx.sessionVideoView.updateMany({
      where: { id: existing.id, watchedSec: { lte: watchedSec } },
      data: {
        watchedSec,
        durationSec,
        percent,
        isCompleted,
        ...(isCompleted && !wasCompleted ? { completedAt: now } : {}),
        lastHeartbeatAt: now,
      },
    });

    return tx.sessionVideoView.findUniqueOrThrow({ where: { id: existing.id } });
  });

  return ok({
    percent: view.percent,
    isCompleted: view.isCompleted,
    requiredPercent: video.requiredPercent,
  });
}
