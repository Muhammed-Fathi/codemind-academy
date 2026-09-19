// POST /api/teacher/media-uploads/init — Phase E teacher presigned upload init.
//
// The TEACHER leg of the Phase 23 direct-to-R2 architecture. It exists for
// exactly one purpose: a teacher uploading a lesson PDF outside the Vercel
// function body (browser → private R2 directly), so production PDF sizes are
// not bounded by serverless request-body limits — the same ceiling and the
// same verification the buffered teacher endpoint enforces, moved off the
// function.
//
// WHY THIS IS NOT THE ADMIN ROUTE
//   /api/admin/media-uploads/init is requireRole("ADMIN") and validates no
//   ownership (the admin owns everything by role). A teacher must never
//   receive a presigned WRITE grant for a lesson outside their
//   Group.courseId scope, so THIS route performs the full teacher chain
//   BEFORE any grant exists:
//
//     authenticated → TEACHER role → share the pdfUpload limiter → own
//     courses (Group.courseId, derived server-side — never the request) →
//     loadOwnedLesson → not ARCHIVED → only then initPresignedUpload,
//     which re-validates the target, the declared size/MIME ceilings, the
//     quota, and binds the intent token to THIS teacher's user id.
//
//   PURPOSE IS PINNED TO LESSON_PDF. A teacher gets no video grant here:
//   video lifecycle stays admin-owned, unchanged.
//
// MEDIA_BACKEND=local ⇒ PRESIGNED_UNSUPPORTED (409, code) — the client then
// falls back to the buffered teacher endpoint, exactly like the admin UI.

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
  initPresignedUpload,
} from "@/lib/media-upload";

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("TEACHER");
  if (error) return error;

  const rl = await applyRateLimit("pdfUpload", user?.id ?? "anonymous-teacher");
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return err(tApi("api.187"), 400);
  const b = body as Record<string, unknown>;

  const lessonId = typeof b.lessonId === "string" ? b.lessonId.trim() : "";
  if (!lessonId) return err(tApi("api.179"), 404);

  // Teacher ownership chain — evaluated BEFORE any grant is issued.
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

  const result = await initPresignedUpload({
    // Purpose is server-pinned: only lesson PDFs. Any requested purpose is
    // deliberately ignored (the teacher surface has no video grant).
    purpose: "LESSON_PDF",
    actorUserId: user?.id ?? null,
    sizeBytes: b.sizeBytes,
    contentType: b.contentType,
    fileName: b.fileName,
    lessonId,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.message, code: result.code },
      { status: UPLOAD_ERROR_STATUS[result.code] ?? 400 }
    );
  }

  return ok(result.init);
}
