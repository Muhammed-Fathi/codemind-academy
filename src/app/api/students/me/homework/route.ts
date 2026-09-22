import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import {
  canAccessHomework,
  EXCLUDE_ARCHIVED_LESSON,
  getUnlockedLessonIds,
} from "@/lib/session-progress";
import { getServerT } from "@/lib/i18n-server";
import { getStudentSchoolType } from "@/lib/enrollment";
import { trackScopeWhere } from "@/lib/track-scope";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { homeworkAttachmentPayload } from "@/lib/homework-lifecycle";
import { STUDENT_HOMEWORK_LIST_FILTER } from "@/lib/student-visibility";
import { validateHomeworkFile } from "@/lib/homework-files";
import {
  activeMediaStorageValue,
  makeStorageKey,
  sanitizeOriginalFilename,
  writePrivateFile,
} from "@/lib/media";
import { assertVolumeQuota } from "@/lib/storage-quotas";
import { extFromHomeworkFileMime } from "@/lib/homework-files";
import { syncDerivedCompletion } from "@/lib/progression";
import { maybeResolveCatchup } from "@/lib/catchup";

/** Longest accepted free-text answer. Generous, but not an upload channel. */
const MAX_ANSWER_CHARS = 4000;

function publicSubmission(
  sub: {
    status: string;
    grade: number | null;
    feedback: string | null;
    submittedAt: Date | null;
    gradedAt: Date | null;
    attachment: {
      id: string;
      mimeType: string | null;
      sizeBytes: number | null;
      originalName: string | null;
    } | null;
  } | null,
  deadline: Date | null
) {
  if (!sub) return null;
  // Phase G — the lateness FACT is preserved through grading: derived from
  // the actual submission timestamp vs the original deadline, independent of
  // the stored status (which becomes GRADED once the teacher grades it).
  const late =
    sub.status === "LATE" ||
    (!!sub.submittedAt && !!deadline && sub.submittedAt > deadline);
  return {
    status: sub.status,
    late,
    grade: sub.grade,
    feedback: sub.feedback,
    submittedAt: sub.submittedAt,
    gradedAt: sub.gradedAt,
    attachment: homeworkAttachmentPayload(sub.attachment),
  };
}

// GET /api/students/me/homework
// Lists the assignments of the student's course, with their submissions.
//
// Only assignments belonging to sessions the student has UNLOCKED are returned:
// the title, the instructions and the deadline of a future session's assignment
// are protected content, not a to-do item.
//
// Phase G lifecycle: only PUBLISHED and CLOSED assignments are real to a
// student. A DRAFT does not exist here (404-equivalent: filtered out); a
// CLOSED one stays historically visible (read-only) with its grades.
export async function GET(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const s = await getStudentProfile(user.id);
  if (!s) return err("Student profile not found", 404);

  const courseId = s.group?.course?.id ?? null;
  const unlocked =
    courseId && s.group?.isActive
      ? await getUnlockedLessonIds(s.id, courseId)
      : new Set<string>();

  // Phase 12 — the unlocked-lesson set already excludes the other track's
  // lessons (the progression engine filters the universe), but a SHARED lesson
  // may legitimately carry an ARABIC and a LANGUAGE assignment, so the
  // assignment's OWN trackScope is filtered here too. Server-side, from the
  // student's row — never from a request parameter.
  const schoolType = await getStudentSchoolType(s.id);

  // The unlocked-lesson set (from the exclusion-aware engine) is the scope;
  // the legacy topic-chain guard below it used to drop every unit-linked
  // official lesson, so it is now just an archived-history backstop.
  const homeworks = await db.homework.findMany({
    where: {
      lessonId: { in: [...unlocked] },
      // Phase G — DRAFT assignments are invisible to students; PUBLISHED and
      // CLOSED are the only student-real states.
      status: { in: [...STUDENT_HOMEWORK_LIST_FILTER.status.in] },
      // Phase 13: the lifecycle clause is not redundant bookkeeping — it is
      // what keeps this list correct if `unlocked` is ever widened, and it is
      // the same predicate the engine that produced `unlocked` uses.
      lesson: { ...LESSON_STUDENT_STATUS_FILTER, ...EXCLUDE_ARCHIVED_LESSON },
      ...trackScopeWhere(schoolType),
    },
    include: {
      lesson: { select: { id: true, titleAr: true, title: true } },
      attachment: {
        select: { id: true, mimeType: true, sizeBytes: true, originalName: true },
      },
      submissions: {
        where: { studentId: s.id },
        include: {
          attachment: {
            select: { id: true, mimeType: true, sizeBytes: true, originalName: true },
          },
        },
      },
    },
    orderBy: { deadline: "asc" },
  });

  const items = homeworks.map((h) => {
    const sub = h.submissions[0] ?? null;
    const now = new Date();
    return {
      id: h.id,
      title: h.titleAr || h.title,
      instructions: h.instructions,
      deadline: h.deadline,
      maxMarks: h.maxMarks,
      lessonId: h.lesson.id,
      lessonTitle: h.lesson.titleAr || h.lesson.title,
      // Phase G lifecycle — the UI derives the operational state from these:
      // open for submission (PUBLISHED, deadline future), late window
      // (PUBLISHED, deadline past), closed (CLOSED, read-only).
      status: h.status,
      closed: h.status === "CLOSED",
      deadlinePassed: now > h.deadline,
      // The teacher's assignment file (downloadable through /api/media/[id]).
      attachment: homeworkAttachmentPayload(h.attachment),
      submission: publicSubmission(sub, h.deadline),
    };
  });

  return ok({ items });
}

// POST /api/students/me/homework
// Body (JSON): { homeworkId, content?, attachmentId? }
//      (multipart, local-dev fallback): homeworkId, content?, file
//
// Submits (or re-submits) the student's OWN answer for an assignment.
//
// Rules:
//   * the studentId always comes from the session, never from the body, so
//     nobody can submit on somebody else's behalf;
//   * the assignment must belong to a session the student has unlocked AND be
//     PUBLISHED (Phase G: CLOSED refuses new submissions, DRAFT is a 404);
//   * content and/or a submitted file — at least one is required;
//   * submitting sets SUBMITTED (or LATE past the deadline) — grading stays
//     teacher-only, this route never assigns a grade;
//   * an already-GRADED assignment is immutable, so a grade cannot be reset by
//     re-submitting;
//   * @@unique([homeworkId, studentId]) plus an upsert make rapid duplicate
//     submissions collapse onto one row.
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const s = await getStudentProfile(user.id);
  if (!s) return err("Student profile not found", 404);

  const contentType = req.headers.get("content-type") || "";
  let homeworkId = "";
  let content = "";
  let attachmentId: string | null = null;
  let uploadedFile: File | null = null;

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    homeworkId = String(form.get("homeworkId") || "").trim();
    content = typeof form.get("content") === "string" ? String(form.get("content")).trim() : "";
    const f = form.get("file");
    if (f && typeof f !== "string") uploadedFile = f as File;
  } else {
    const body = await req.json().catch(() => ({}));
    homeworkId = String(body.homeworkId || "").trim();
    content = typeof body.content === "string" ? body.content.trim() : "";
    attachmentId =
      body.attachmentId === null || body.attachmentId === undefined
        ? null
        : String(body.attachmentId).trim() || null;
  }

  if (!homeworkId) return err(tApi("api.221"), 400);
  if (!content && !attachmentId && !uploadedFile) return err(tApi("api.222"), 400);
  if (content.length > MAX_ANSWER_CHARS)
    return err(tApi("api.223", { p1: MAX_ANSWER_CHARS }), 413);

  // Server-side progression gate — the same rule that unlocks the session.
  const access = await canAccessHomework(s.id, homeworkId);
  if (!access.allowed)
    return denyProgression(access.reason, "Homework not found", {
      state: access.evaluation?.state ?? null,
      reason: access.evaluation?.reason ?? null,
      reasonCode: access.evaluation?.reasonCode ?? null,
      unmet: access.evaluation?.unmet ?? [],
      holdBlocked: access.reason === "ABSENCE_HOLD",
    });

  const homework = await db.homework.findUnique({
    where: { id: homeworkId },
    select: {
      id: true,
      lessonId: true,
      title: true,
      titleAr: true,
      deadline: true,
      maxMarks: true,
      status: true,
      lesson: { select: { status: true, curriculumStatus: true } },
    },
  });
  // Phase G — a DRAFT assignment does not exist for students (uniform 404).
  if (!homework || homework.status === "DRAFT")
    return err("Homework not found", 404);
  if (homework.status === "CLOSED") return err(tApi("api.357"), 409);

  const existing = await db.homeworkSubmission.findUnique({
    where: { homeworkId_studentId: { homeworkId, studentId: s.id } },
    select: { id: true, status: true, attachmentId: true },
  });
  if (existing?.status === "GRADED") return err(tApi("api.224"), 409);

  // ---- resolve the submitted file (exactly ONE of the two channels) -------
  let fileAssetId: string | null = attachmentId;
  if (uploadedFile) {
    if (attachmentId) return err(tApi("api.222"), 400);
    // Local-development fallback: the buffered multipart path (the presigned
    // flow answers PRESIGNED_UNSUPPORTED when MEDIA_BACKEND=local, and the
    // client drops to this route — same pattern as the lesson PDFs).
    const buf = Buffer.from(await uploadedFile.arrayBuffer());
    const originalName = sanitizeOriginalFilename(uploadedFile.name, "submission.bin");
    const check = validateHomeworkFile({
      role: "STUDENT_SUBMISSION",
      buffer: buf,
      claimedMime: uploadedFile.type || null,
      originalName,
    });
    if (!check.ok) return err(tApi("api.358"), 400);
    const quota = await assertVolumeQuota(check.sizeBytes);
    if (!quota.ok) return err(tApi("api.359"), 413);
    const ext = extFromHomeworkFileMime("STUDENT_SUBMISSION", check.mimeType) ?? check.extension;
    const key = makeStorageKey("homework-submissions", ext);
    await writePrivateFile(key, buf);
    const asset = await db.mediaAsset.create({
      data: {
        kind: "DOCUMENT",
        storage: activeMediaStorageValue(),
        storageKey: key,
        mimeType: check.mimeType,
        sizeBytes: check.sizeBytes,
        originalName: check.originalName,
        isPrivate: true,
        createdById: user.id,
      },
    });
    fileAssetId = asset.id;
  } else if (attachmentId) {
    // Presigned channel: the asset was created by the student's own upload
    // completion. Re-verify ownership + shape before trusting the id — a
    // foreign asset id must never become someone else's submission file.
    const asset = await db.mediaAsset.findUnique({
      where: { id: attachmentId },
      include: { homeworkSubmissions: { select: { id: true, studentId: true } } },
    });
    const admissible =
      !!asset &&
      asset.kind === "DOCUMENT" &&
      asset.isPrivate === true &&
      asset.createdById === user.id &&
      asset.homeworkSubmissions.every((sub) => sub.studentId === s.id);
    if (!admissible) return err(tApi("api.355"), 400);
  }

  const now = new Date();
  // Phase G late policy — accepted after the deadline, explicitly LATE.
  const status = now > homework.deadline ? "LATE" : "SUBMITTED";

  // Upsert on the (homeworkId, studentId) unique pair: two parallel submits
  // converge on the same row instead of racing into a duplicate.
  const submission = await db.homeworkSubmission.upsert({
    where: { homeworkId_studentId: { homeworkId, studentId: s.id } },
    create: {
      homeworkId,
      studentId: s.id,
      content: content || null,
      attachmentId: fileAssetId,
      submittedAt: now,
      status,
    },
    update: {
      content: content || null,
      // A re-submission REPLACES the file (the previous asset row stays in
      // storage history; the pointer moves) and clears the previous verdict —
      // the teacher re-grades.
      attachmentId: fileAssetId !== null ? fileAssetId : existing?.attachmentId ?? null,
      submittedAt: now,
      status,
      grade: null,
      feedback: null,
      gradedById: null,
      gradedAt: null,
    },
    include: {
      attachment: {
        select: { id: true, mimeType: true, sizeBytes: true, originalName: true },
      },
    },
  });

  // Phase H — a submission may complete its lesson or complete a catch-up.
  // Best-effort, never throws: the submission already committed.
  await syncDerivedCompletion(s.id, homework.lessonId);
  await maybeResolveCatchup(s.id, user.id);

  return ok({
    message: tApi("api.225"),
    late: status === "LATE",
    submission: publicSubmission(submission, homework.deadline),
  });
}
