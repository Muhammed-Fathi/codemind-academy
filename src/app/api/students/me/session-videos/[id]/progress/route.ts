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
    select: { id: true, batchId: true, isPublished: true, requiredPercent: true },
  });
  if (!video || !video.isPublished) return err("Not found", 404);
  if (!student.batchId || video.batchId !== student.batchId)
    return err("Forbidden", 403);

  const body = await req.json().catch(() => ({}));
  const positionSec = Math.max(0, Math.floor(Number(body.positionSec) || 0));
  const durationSec = Math.max(0, Math.floor(Number(body.durationSec) || 0));
  if (durationSec <= 0) return err("durationSec is required", 400);

  const now = new Date();
  const existing = await db.sessionVideoView.findUnique({
    where: { sessionVideoId_studentId: { sessionVideoId: id, studentId: student.id } },
  });

  const elapsedSec = existing?.lastHeartbeatAt
    ? Math.max(0, Math.floor((now.getTime() - existing.lastHeartbeatAt.getTime()) / 1000))
    : 0;
  const credit = Math.min(elapsedSec, MAX_CREDIT_PER_BEAT_SEC);
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
      lastHeartbeatAt: now,
    },
    update: {
      watchedSec,
      durationSec,
      percent,
      isCompleted,
      ...(isCompleted && !wasCompleted ? { completedAt: now } : {}),
      lastHeartbeatAt: now,
    },
  });

  return ok({
    percent: view.percent,
    isCompleted: view.isCompleted,
    requiredPercent: video.requiredPercent,
  });
}
