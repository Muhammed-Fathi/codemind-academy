// POST /api/students/me/homework-upload/complete — Phase G
//
// Completion leg of the student submission upload. Verifies the intent token
// (bound to THIS student + the exact homework + key), re-runs the target
// authorization, verifies the stored object (size, Content-Type, magic bytes,
// optional sha256) and ONLY THEN creates the private MediaAsset row.
//
// The asset is NOT linked to a submission here: linking happens in
// POST /api/students/me/homework, which re-authorizes the submission itself
// (graded-immutable, closed-assignment, ownership) and verifies the asset
// belongs to the submitting student. An uploaded-but-never-submitted asset is
// inert: private, authorized-download-only, and owned by the student.

import { NextRequest, NextResponse } from "next/server";
import {
  err,
  ok,
  requireUser,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { UPLOAD_ERROR_STATUS, completePresignedUpload } from "@/lib/media-upload";

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const rl = await applyRateLimit("homeworkUpload", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return err(tApi("api.187"), 400);
  const b = body as Record<string, unknown>;

  const result = await completePresignedUpload({
    token: b.token,
    // Bearer binding: completion must come from the student the grant was
    // issued to — verifyUploadIntent rejects a mismatch.
    actorUserId: user.id,
    sha256: b.sha256,
    originalName: b.originalName ?? b.fileName,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: UPLOAD_ERROR_STATUS[result.code] ?? 400 }
    );
  }

  // Homework purposes only: the mediaAssetId is what the submit route links.
  if (
    result.purpose !== "HOMEWORK_SUBMISSION" &&
    result.purpose !== "HOMEWORK_ATTACHMENT"
  ) {
    return err(tApi("api.187"), 400);
  }

  return ok({
    mediaAssetId: result.mediaAssetId,
    replay: result.replay === true,
  });
}
