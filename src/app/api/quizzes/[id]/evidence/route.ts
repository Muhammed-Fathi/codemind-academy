// POST /api/quizzes/[id]/evidence
//
// Records quiz camera evidence for the CURRENT student's own in-progress
// attempt. Two kinds are accepted:
//   * kind=STATUS   — a camera state change (granted / denied / unavailable /
//                     interrupted / unclear). No media is stored.
//   * kind=SNAPSHOT — a single still image captured with the student's
//                     consent. Stored privately, never in a public path.
//
// Privacy: snapshots only (no continuous recording), a strict size/type limit,
// a retention deadline, and a hard cap per attempt so we never store more data
// than necessary.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { requireUser, ok, err } from "@/lib/api";
import {
  MAX_IMAGE_BYTES,
  extFromMime,
  isAllowedImageMime,
  makeStorageKey,
  writePrivateFile,
} from "@/lib/media";
import { getServerT } from "@/lib/i18n-server";

const MAX_SNAPSHOTS_PER_ATTEMPT = 12;
const RETENTION_DAYS = Number(process.env.QUIZ_EVIDENCE_RETENTION_DAYS || 30);

const VALID_STATUSES = new Set([
  "GRANTED",
  "DENIED",
  "UNAVAILABLE",
  "INTERRUPTED",
  "UNCLEAR",
  "ENDED",
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id: quizId } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!student) return err("Student profile not found", 404);

  const contentType = req.headers.get("content-type") || "";
  let attemptId = "";
  let kind = "STATUS";
  let status: string | null = null;
  let file: File | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    attemptId = String(form.get("attemptId") || "");
    kind = String(form.get("kind") || "SNAPSHOT").toUpperCase();
    status = form.get("status") ? String(form.get("status")).toUpperCase() : null;
    const f = form.get("file");
    if (f && typeof f !== "string") file = f as File;
  } else {
    const body = await req.json().catch(() => ({}));
    attemptId = String(body.attemptId || "");
    kind = String(body.kind || "STATUS").toUpperCase();
    status = body.status ? String(body.status).toUpperCase() : null;
  }

  // The attempt must exist, belong to THIS student, be for THIS quiz and
  // still be running — evidence can never be attached to someone else's work.
  const attempt = await db.quizAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, studentId: true, quizId: true, finishedAt: true },
  });
  if (!attempt || attempt.studentId !== student.id || attempt.quizId !== quizId)
    return err("Forbidden", 403);
  if (attempt.finishedAt) return err("Attempt already finished", 400);

  if (status && !VALID_STATUSES.has(status)) status = null;

  // Keep the attempt-level camera status in sync for admin review.
  if (status) {
    await db.quizAttempt.update({
      where: { id: attempt.id },
      data: { cameraStatus: status },
    });
  }

  const retainUntil = new Date(Date.now() + RETENTION_DAYS * 24 * 3600 * 1000);

  if (kind !== "SNAPSHOT" || !file) {
    await db.quizAttemptEvidence.create({
      data: { attemptId: attempt.id, kind: "STATUS", status, retainUntil },
    });
    return ok({ ok: true, stored: "status" });
  }

  // ---- Snapshot -----------------------------------------------------------
  const existing = await db.quizAttemptEvidence.count({
    where: { attemptId: attempt.id, kind: "SNAPSHOT" },
  });
  // Data minimisation: silently stop storing beyond the cap.
  if (existing >= MAX_SNAPSHOTS_PER_ATTEMPT) {
    return ok({ ok: true, stored: "skipped-cap" });
  }

  if (file.size > MAX_IMAGE_BYTES) return err(tApi("api.215"), 413);
  const mime = file.type || "image/jpeg";
  if (!isAllowedImageMime(mime)) return err(tApi("api.216"), 415);

  const storageKey = makeStorageKey("quiz-evidence", extFromMime(mime));
  const buffer = Buffer.from(await file.arrayBuffer());
  await writePrivateFile(storageKey, buffer);

  const asset = await db.mediaAsset.create({
    data: {
      kind: "IMAGE",
      storage: "LOCAL_PRIVATE",
      storageKey,
      mimeType: mime,
      sizeBytes: buffer.length,
      isPrivate: true,
      createdById: user.id,
    },
  });

  await db.quizAttemptEvidence.create({
    data: {
      attemptId: attempt.id,
      mediaAssetId: asset.id,
      kind: "SNAPSHOT",
      status,
      retainUntil,
    },
  });

  return ok({ ok: true, stored: "snapshot" });
}
