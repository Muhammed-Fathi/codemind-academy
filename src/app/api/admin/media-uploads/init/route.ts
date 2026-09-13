// POST /api/admin/media-uploads/init — Phase 23 presigned direct-upload init.
//
// The FIRST leg of the direct-browser-to-R2 flow for large admin media:
//   1. requireRole("ADMIN")        — anonymous/student/teacher never get a URL.
//   2. Shared rate limiter         — same admin-upload limiter as the buffered
//      PDF path ("pdfUpload"), applied before anything is issued.
//   3. initPresignedUpload()       — validates the target entity (batch /
//      lesson / archived state), the declared MIME allow-list and size
//      ceiling, the volume quota, generates the EXACT storage key server-side,
//      presigns a SHORT-LIVED PUT carrying the granted Content-Type, and
//      returns an HMAC
//      upload-intent token bound to key/user/purpose/kind/type/max-bytes/exp.
//
// The response is the MINIMUM the browser needs: URL, method, token, content
// type, ceiling, expiry. No storage key (it rides in the URL + token), no
// bucket configuration, no credential. There is NO presigned GET and NO list
// capability anywhere in this flow. MEDIA_BACKEND=local deployments receive
// PRESIGNED_UNSUPPORTED and the client falls back to the buffered endpoints.
//
// Quiz evidence uploads are deliberately NOT served here (unchanged path).

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
  initPresignedUpload,
} from "@/lib/media-upload";
import { getServerT } from "@/lib/i18n-server";

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  // Same shared admin-upload limiter the buffered PDF upload applies — the
  // two-step flow is bounded identically per admin.
  const rl = await applyRateLimit("pdfUpload", user?.id ?? "anonymous-admin");
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return err(tApi("api.187"), 400);

  const result = await initPresignedUpload({
    purpose: (body as Record<string, unknown>).purpose,
    actorUserId: user?.id ?? null,
    sizeBytes: (body as Record<string, unknown>).sizeBytes,
    contentType: (body as Record<string, unknown>).contentType,
    fileName: (body as Record<string, unknown>).fileName,
    batchId: (body as Record<string, unknown>).batchId,
    lessonId: (body as Record<string, unknown>).lessonId,
  });

  if (!result.ok) {
    // Machine code rides along so the client can branch (e.g. fall back to
    // the buffered path on PRESIGNED_UNSUPPORTED).
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: UPLOAD_ERROR_STATUS[result.code] ?? 400 }
    );
  }

  return ok(result.init);
}
