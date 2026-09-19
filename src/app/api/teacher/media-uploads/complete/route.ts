// POST /api/teacher/media-uploads/complete — Phase E teacher presigned completion.
//
// The third leg of the teacher direct-to-R2 PDF flow. Steps:
//
//   1. TEACHER role + shared pdfUpload limiter (same as every upload path).
//   2. Verify the intent token LOCALLY (verifyUploadIntent is pure): the
//      signed payload — not the request body — carries the lesson id and
//      purpose. A purpose ≠ LESSON_PDF is refused outright (teachers get no
//      video grant anywhere in Phase E).
//   3. Re-authorize the teacher against the SIGNED lesson id (Group.courseId
//      scope + not ARCHIVED) — the same fail-closed check the init ran,
//      re-run because the group/lesson may have changed since.
//   4. completePresignedUpload({ manageOwn: { userId } }): object HEAD +
//      content-type + magic bytes + size + (optional) sha256 verification,
//      then the ownership-scoped finalize — inside ONE transaction, a
//      foreign/unproven ACTIVE material of the same (lesson × trackScope)
//      fails closed FOREIGN_ACTIVE (409) and deactivation touches only rows
//      this teacher provably uploaded (MediaAsset.createdById).
//
// The route never returns a storage key, never echoes a bucket, and the
// intent's bearer binding makes a token issued to one teacher useless to any
// other account.

import { NextRequest, NextResponse } from "next/server";
import {
  err,
  ok,
  requireRole,
  applyRateLimit,
  rateLimitedResponse,
  getTeacherProfile,
} from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { loadOwnedLesson, teacherCourseIds } from "@/lib/teacher-content";
import {
  UPLOAD_ERROR_STATUS,
  completePresignedUpload,
  verifyUploadIntent,
} from "@/lib/media-upload";

/** Server-code → dictionary key for the localized teacher-facing message. */
const CODE_TO_API_KEY: Record<string, string> = {
  INVALID_SIZE: "api.215",
  TOO_LARGE: "api.215",
  EMPTY_OBJECT: "api.215",
  INVALID_CONTENT_TYPE: "api.216",
  MIME_MISMATCH: "api.216",
  MAGIC_REJECTED: "api.216",
  EXTENSION_REJECTED: "api.216",
  INVALID_TRACK_SCOPE: "api.228",
  QUOTA_EXCEEDED: "api.213",
  LESSON_ARCHIVED: "api.242",
  LESSON_NOT_FOUND: "api.179",
  TITLE_REQUIRED: "api.187",
  FOREIGN_ACTIVE: "api.318",
  INTENT_EXPIRED: "api.324",
  INTENT_INVALID: "api.324",
  INTENT_BAD_SIGNATURE: "api.324",
  INTENT_USER_MISMATCH: "api.324",
  MISSING_OBJECT: "api.324",
  ALREADY_LINKED: "api.325",
};

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("TEACHER");
  if (error) return error;

  const rl = await applyRateLimit("pdfUpload", user?.id ?? "anonymous-teacher");
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return err(tApi("api.324"), 400);
  const b = body as Record<string, unknown>;

  // Token-first authorization: the lesson id inside the SIGNED intent is the
  // only identity this flow trusts (the service re-derives it the same way).
  const intent = verifyUploadIntent(b.token, { expectedUser: user!.id });
  if (!intent.ok) {
    const code =
      intent.reason === "EXPIRED"
        ? "INTENT_EXPIRED"
        : intent.reason === "USER_MISMATCH"
          ? "INTENT_USER_MISMATCH"
          : "INTENT_INVALID";
    return NextResponse.json(
      { error: tApi("api.324"), code },
      { status: UPLOAD_ERROR_STATUS[code] }
    );
  }
  // Lesson PDFs only — no teacher completes a video upload, ever.
  if (intent.payload.purpose !== "LESSON_PDF") {
    return NextResponse.json(
      { error: tApi("api.180"), code: "UNSUPPORTED_PURPOSE" },
      { status: 403 }
    );
  }
  const lessonId = intent.payload.lessonId;
  if (!lessonId) return err(tApi("api.179"), 404);

  const teacher = await getTeacherProfile(user!.id);
  if (!teacher) return err(tApi("api.180"), 403);
  const owned = await loadOwnedLesson(lessonId, teacherCourseIds(teacher));
  if (!owned.ok) {
    return err(
      owned.status === 403 ? tApi("api.180") : tApi("api.179"),
      owned.status
    );
  }
  if (String(owned.lesson.curriculumStatus).toUpperCase() === "ARCHIVED") {
    return err(tApi("api.242"), 409);
  }

  const result = await completePresignedUpload(
    {
      token: b.token,
      actorUserId: user?.id ?? null,
      title: b.title,
      trackScope: b.trackScope,
      originalName: b.originalName,
      sha256: b.sha256,
      // Teacher manage-own finalization — see the route header. NEVER set by
      // the admin route; the Phase 23 path semantics are untouched.
      manageOwn: { userId: user!.id },
    }
  );

  if (!result.ok) {
    return NextResponse.json(
      {
        error: CODE_TO_API_KEY[result.code]
          ? tApi(CODE_TO_API_KEY[result.code])
          : result.message,
        code: result.code,
      },
      { status: UPLOAD_ERROR_STATUS[result.code] ?? 400 }
    );
  }

  return ok({
    purpose: result.purpose,
    material: result.material,
    replaced: result.replaced ?? [],
    replay: result.replay === true,
    // Explicit, as on the buffered route: legacy pdfUrl is never written.
    pdfUrlWritten: false,
  });
}
