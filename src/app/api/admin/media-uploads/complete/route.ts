// POST /api/admin/media-uploads/complete — Phase 23 presigned upload finalize.
//
// The LAST leg of the direct-browser-to-R2 flow. Runs AFTER the browser has
// PUT the bytes straight into the private bucket:
//   1. requireRole("ADMIN")     — re-checked; the token's user must ALSO be
//      this very admin (INTENT_USER_MISMATCH otherwise).
//   2. Shared rate limiter      — same admin-upload limiter as init.
//   3. completePresignedUpload():
//        token (HMAC signature / expiry / user / purpose / exact key /
//               content type / max bytes) →
//        re-authorization of the target entity →
//        HEAD/stat: exists → non-empty → size ≤ signed max → stored
//        Content-Type matches the signed one → magic bytes (PDF) → SHA-256
//        (when the browser provided one) →
//        ONLY THEN MediaAsset + SessionVideo / Material rows.
//      IDEMPOTENT: a replayed token whose exact key is already linked to the
//      same resource returns the ORIGINAL result (replay: true) — no
//      duplicate rows, no deletes. A key linked differently fails closed
//      (ALREADY_LINKED) untouched. Cleanup refuses to delete any object that
//      still has a MediaAsset row.
//      Every object-level failure DELETES the object by its EXACT key — only
//      after proving no DB record references it. Never a prefix delete,
//      never a listing.
//
// The response carries the created rows only — no storage key, no bucket
// details, no token echo.

import { NextRequest, NextResponse } from "next/server";
import {
  err,
  ok,
  requireRole,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import {
  UPLOAD_ERROR_STATUS,
  completePresignedUpload,
} from "@/lib/media-upload";

export async function POST(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const rl = await applyRateLimit("pdfUpload", user?.id ?? "anonymous-admin");
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") return err("JSON body required", 400);

  const result = await completePresignedUpload({
    token: body.token,
    actorUserId: user?.id ?? null,
    sha256: body.sha256,
    originalName: body.originalName,
    // SESSION_VIDEO payload:
    batchId: body.batchId,
    title: body.title,
    titleAr: body.titleAr,
    description: body.description,
    publish: body.publish,
    isRequiredForProgression: body.isRequiredForProgression,
    requiredPercent: body.requiredPercent,
    // Shared / LESSON_PDF payload:
    lessonId: body.lessonId,
    trackScope: body.trackScope,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.message,
        code: result.code,
        ...(result.cleaned === true ? { cleaned: true } : {}),
      },
      { status: UPLOAD_ERROR_STATUS[result.code] ?? 400 }
    );
  }

  if (result.purpose === "SESSION_VIDEO") {
    return ok({
      purpose: result.purpose,
      mediaAssetId: result.mediaAssetId,
      replay: result.replay === true,
      video: result.video ?? null,
    });
  }
  return ok({
    purpose: result.purpose,
    mediaAssetId: result.mediaAssetId,
    replay: result.replay === true,
    material: result.material ?? null,
    replaced: result.replaced ?? [],
    cleanedUpAssets: result.cleanedUpAssets ?? [],
    // Explicit contract marker, same as the buffered materials route.
    pdfUrlWritten: false,
  });
}
