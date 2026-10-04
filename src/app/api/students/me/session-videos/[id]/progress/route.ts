// POST /api/students/me/session-videos/[id]/progress
// Body: { positionSec, durationSec }
//
// Same server-verified, tamper-resistant heartbeat model as lesson videos:
// watch time is credited by real elapsed wall-clock time between heartbeats,
// is monotonic, and completion requires the batch video's requiredPercent
// (95% by default).
//
// Access is server-side, in order:
//   * batch ownership is enforced server-side (`video.batchId === student.batchId`);
//   * only PUBLISHED videos are viewable (a staged recording cannot accrue
//     progress);
//   * Phase B (fix) — a video LINKED TO A LESSON accrues progress only when
//     the student is authorized to access that lesson (the SAME
//     `canAccessLesson` verdict the lesson page and the media route use).
//     Progress is an academic claim: a heartbeat for a locked lesson's
//     recording is a 403 — never a silently-stored row. Legacy lesson-less
//     videos (lessonId = null) keep the historical batch-publication
//     behaviour.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  requireUser,
  ok,
  err,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import { canAccessLesson } from "@/lib/session-progress";
import { isManagedPrivateStorage } from "@/lib/media";
import { syncDerivedCompletion } from "@/lib/progression";
import { maybeResolveCatchup } from "@/lib/catchup";

const MAX_CREDIT_PER_BEAT_SEC = 60;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  // Phase 20 — batch-video heartbeat, same shared limiter as lesson videos.
  const rl = await applyRateLimit("heartbeat", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

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
      // Phase B (fix) — needed for the lesson gate below.
      lessonId: true,
      // Trackability gate below: only managed storage accrues watch %.
      media: { select: { storage: true } },
    },
  });
  if (!video || !video.isPublished) return err("Not found", 404);
  if (!student.batchId || video.batchId !== student.batchId)
    return err("Forbidden", 403);

  // Phase B (fix) — lesson authority (see header): a recording of a lesson
  // the student may not open must not accrue watch time for that lesson.
  // `canAccessLesson` carries the existing policy (enrollment, course,
  // PUBLISHED lifecycle, non-archived, track, progression unlock), so this
  // is the same verdict the Lesson page and the media route apply. Lesson-
  // less legacy rows skip the gate (no lesson exists to authorize against).
  if (video.lessonId) {
    const lessonAccess = await canAccessLesson(student.id, video.lessonId);
    if (!lessonAccess.allowed) {
      // Phase H: a hold refuses FORWARD recordings only; the missed lesson's
      // own recording stays accessible, so recovery watch time accrues.
      if (lessonAccess.reason === "ABSENCE_HOLD") {
        return err("عندك غياب محتاج تعويض", 403);
      }
      return err("Forbidden", 403);
    }
  }

  // Untrackable media (EXTERNAL_URL — embeds AND direct files alike) accrues
  // NOTHING: the student-visible contract (course.227 / course.243) promises
  // exactly this, and only managed private bytes the server meters can become
  // academic facts. The refusal stores no row, like every other denial here.
  // (Literal Arabic: this route's convention for student-facing blocks.)
  if (!isManagedPrivateStorage(video.media?.storage)) {
    return err("الفيديو ده بيشتغل من مصدر خارجي، فمش بيتسجل منه نسبة مشاهدة.", 409);
  }

  const body = await req.json().catch(() => ({}));
  const positionSec = Math.max(0, Math.floor(Number(body.positionSec) || 0));
  const durationSec = Math.max(0, Math.floor(Number(body.durationSec) || 0));
  if (durationSec <= 0) return err("durationSec is required", 400);

  const now = new Date();
  const existing = await db.sessionVideoView.findUnique({
    where: { sessionVideoId_studentId: { sessionVideoId: id, studentId: student.id } },
  });

  // Phase M4.6 — the anchor advances by exactly what was CREDITED, not to
  // `now` on every beat.
  //
  // The old shape reset `lastHeartbeatAt` to the request clock on every beat,
  // so the credit of the NEXT beat was `floor(now - last)`. Any beat cadence
  // faster than one beat per second therefore rounded every gap down to zero:
  // a burst of beats forfeited the whole gap instead of the sub-second sliver,
  // and a short recording (shorter than the client's 15s interval — see
  // `session-videos-view.tsx`) could be watched end-to-end while every beat
  // paid 0 seconds, leaving `watchedSec = 0` and `percent = 0` at the final
  // "ended" flush. The watch-integrity rule itself is unchanged: credit is
  // still bounded by REAL elapsed wall-clock time and by the playhead, so a
  // seek to the end still earns only the seconds that actually passed.
  //
  // Carrying the remainder is safe and cannot be banked: the anchor only ever
  // moves forward by the integer seconds that were credited (so the carried
  // remainder stays below 1s), and when the 60s cap clipped the window the
  // anchor jumps to `now` exactly as before — the clipped excess is dropped,
  // never deferred.
  const lastAt = existing?.lastHeartbeatAt ?? null;
  const elapsedSec = lastAt
    ? Math.max(0, Math.floor((now.getTime() - lastAt.getTime()) / 1000))
    : 0;
  const credit = Math.min(elapsedSec, MAX_CREDIT_PER_BEAT_SEC);
  const anchorAt =
    credit >= MAX_CREDIT_PER_BEAT_SEC
      ? now
      : new Date((lastAt ?? now).getTime() + credit * 1000);
  const previous = existing?.watchedSec ?? 0;
  const watchedSec = Math.min(
    durationSec,
    Math.max(previous, Math.min(previous + credit, positionSec))
  );
  const percent = Math.min(100, Math.round((watchedSec / durationSec) * 100));
  const wasCompleted = existing?.isCompleted ?? false;
  const isCompleted = wasCompleted || percent >= video.requiredPercent;

  const view = await db.sessionVideoView.upsert({
    where: { sessionVideoId_studentId: { sessionVideoId: id, studentId: student.id } },
    create: {
      sessionVideoId: id,
      studentId: student.id,
      watchedSec,
      durationSec,
      percent,
      isCompleted,
      completedAt: isCompleted ? now : null,
      // First beat: there is no prior anchor to carry, so the clock starts now.
      lastHeartbeatAt: anchorAt,
    },
    update: {
      watchedSec,
      durationSec,
      percent,
      isCompleted,
      ...(isCompleted && !wasCompleted ? { completedAt: now } : {}),
      // Advances by the credited seconds only — see the anchor note above.
      lastHeartbeatAt: anchorAt,
    },
  });

  // Phase H — on the transition to completion only (bounded: once per
  // video): converge the linked lesson's legacy marker and sweep catch-up.
  // Best-effort, never throws — the heartbeat already committed.
  if (isCompleted && !wasCompleted && video.lessonId) {
    await syncDerivedCompletion(student.id, video.lessonId);
    await maybeResolveCatchup(student.id, user.id);
  }

  return ok({
    percent: view.percent,
    isCompleted: view.isCompleted,
    // LIVE satisfaction (the engine's rule): kept alongside the sticky flag
    // so REQUIRED-video UI never contradicts the requirements card after a
    // retroactive threshold change. Always trackable here (refused above).
    satisfied: view.percent >= video.requiredPercent,
    requiredPercent: video.requiredPercent,
  });
}
