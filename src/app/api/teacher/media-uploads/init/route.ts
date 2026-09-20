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
//   PURPOSE IS PINNED SERVER-SIDE. Phase E: LESSON_PDF. Phase G adds ONE
//   more teacher grant — HOMEWORK_ATTACHMENT (a request carrying homeworkId)
//   with the identical ownership-chain-first rule, resolved through
//   homework → lesson → course. A teacher gets no video grant here: video
//   lifecycle stays admin-owned, unchanged.
//
// MEDIA_BACKEND=local ⇒ PRESIGNED_UNSUPPORTED (409, code) — the client then
// falls back to the buffered teacher endpoint, exactly like the admin UI
// (homework attachments fall back to POST /api/teacher/homework/[id]/attachment).

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
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  loadOwnedLesson,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";
import { db } from "@/lib/db";
import {
  UPLOAD_ERROR_STATUS,
  initPresignedUpload,
} from "@/lib/media-upload";

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("TEACHER");
  if (error) return error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return err(tApi("api.187"), 400);
  const b = body as Record<string, unknown>;

  // Phase G — a request carrying `homeworkId` asks for an ASSIGNMENT file
  // grant (PDF/DOCX/PPTX/ZIP, 25 MB); without it, the Phase E lesson-PDF
  // grant. The two legs share one limiter family but DIFFERENT keys so a
  // burst of assignment uploads cannot starve lesson-PDF management.
  const homeworkId = typeof b.homeworkId === "string" ? b.homeworkId.trim() : "";
  const rl = await applyRateLimit(
    homeworkId ? "homeworkUpload" : "pdfUpload",
    user?.id ?? "anonymous-teacher"
  );
  if (!rl.allowed) return rateLimitedResponse(rl);

  // Teacher ownership chain — evaluated BEFORE any grant is issued.
  const teacher = await getTeacherProfile(user!.id);
  if (!teacher) return err(tApi("api.180"), 403);

  if (homeworkId) {
    // HOMEWORK_ATTACHMENT leg: homework → lesson → course must be the
    // teacher's own; CLOSED assignments take no attachment change (reopen
    // first); DRAFT and PUBLISHED are both authorable.
    const homework = await db.homework.findUnique({
      where: { id: homeworkId },
      include: { lesson: { select: LESSON_PLACEMENT_SELECT } },
    });
    if (!homework) return err(tApi("api.238"), 404);
    const placement = lessonPlacement(homework.lesson as ChainLesson | null);
    if (!placement || !teacherCourseIds(teacher).includes(placement.courseId)) {
      return err(tApi("api.180"), 403);
    }
    if (String(homework.lesson?.curriculumStatus ?? "").toUpperCase() === "ARCHIVED") {
      return err(tApi("api.242"), 409);
    }
    if (homework.status === "CLOSED") return err(tApi("api.354"), 409);

    const result = await initPresignedUpload({
      // Purpose is server-pinned: assignment files only.
      purpose: "HOMEWORK_ATTACHMENT",
      actorUserId: user?.id ?? null,
      sizeBytes: b.sizeBytes,
      contentType: b.contentType,
      fileName: b.fileName,
      homeworkId,
    });

    if (!result.ok) {
      return NextResponse.json(
        { error: result.message, code: result.code },
        { status: UPLOAD_ERROR_STATUS[result.code] ?? 400 }
      );
    }
    return ok(result.init);
  }

  const lessonId = typeof b.lessonId === "string" ? b.lessonId.trim() : "";
  if (!lessonId) return err(tApi("api.179"), 404);

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
