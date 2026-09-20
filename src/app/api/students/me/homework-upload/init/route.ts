// POST /api/students/me/homework-upload/init — Phase G
//
// The STUDENT leg of the presigned direct-upload architecture (the teacher
// leg lives at /api/teacher/media-uploads/init, the admin leg at
// /api/admin/media-uploads/init — ONE flow, three authorized surfaces).
//
// Purpose is server-pinned to HOMEWORK_SUBMISSION. The full access gate runs
// BEFORE any grant exists:
//
//   authenticated → STUDENT role → rate limit → the assignment exists, is
//   PUBLISHED, is on the student's track, and belongs to a lesson the student
//   has UNLOCKED → only then initPresignedUpload, which re-validates the
//   target, the declared size/MIME ceilings and binds the intent token to
//   THIS student's user id.
//
// MEDIA_BACKEND=local ⇒ PRESIGNED_UNSUPPORTED (409, code) — the client then
// falls back to the buffered multipart path of POST /api/students/me/homework.

import { NextRequest, NextResponse } from "next/server";
import {
  err,
  ok,
  requireUser,
  getStudentProfile,
  applyRateLimit,
  rateLimitedResponse,
  denyProgression,
} from "@/lib/api";
import { db } from "@/lib/db";
import { getServerT } from "@/lib/i18n-server";
import { canAccessHomework } from "@/lib/session-progress";
import { UPLOAD_ERROR_STATUS, initPresignedUpload } from "@/lib/media-upload";

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  const rl = await applyRateLimit("homeworkUpload", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return err(tApi("api.187"), 400);
  const b = body as Record<string, unknown>;

  const homeworkId = typeof b.homeworkId === "string" ? b.homeworkId.trim() : "";
  if (!homeworkId) return err(tApi("api.221"), 400);

  // Access gate — identical to the submit route: progression unlock + track.
  const access = await canAccessHomework(student.id, homeworkId);
  if (!access.allowed) return denyProgression(access.reason, "Homework not found");

  const homework = await db.homework.findUnique({
    where: { id: homeworkId },
    select: { id: true, status: true },
  });
  if (!homework || homework.status === "DRAFT") return err("Homework not found", 404);
  if (homework.status === "CLOSED") return err(tApi("api.357"), 409);

  const result = await initPresignedUpload({
    // Purpose is server-pinned: submission files only. Any requested purpose
    // is deliberately ignored.
    purpose: "HOMEWORK_SUBMISSION",
    actorUserId: user.id,
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
