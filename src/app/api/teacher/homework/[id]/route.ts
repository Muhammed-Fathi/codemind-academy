// PATCH /api/teacher/homework/[id] — Phase 18
//
// Edit an assignment the teacher owns. NO new versioning model is introduced
// (the phase forbids one): `Homework` keeps a single row, and the edits that
// would invalidate the history already attached to it are REFUSED instead of
// versioned. The three destructive changes, and the rule for each:
//
//   1. Change the lesson. Refused: submissions are keyed to the homework, so
//      moving it would silently re-home another lesson's graded history
//      (`lessonId` is immutable — api.241).
//   2. Lower `maxMarks` below an existing grade. Refused: an 18/20 recorded
//      submission would become 18/10 — a corrupt record. `maxMarks` may only
//      stay at or above the highest grade already handed out (api.240).
//   3. Change `trackScope` once the assignment has been GRADED. Refused: the
//      graded submissions were produced under the old audience, and widening
//      the scope would show another track's students a graded assignment they
//      never received (api.239). Before the first grade the scope may still be
//      corrected, because no record depends on it yet.
//
// Everything else (title, instructions, deadline, raising maxMarks) is a
// legitimate correction and never touches a `HomeworkSubmission` row — this
// route performs no submission writes at all.
//
// AUTHORIZATION: same chain as creation — TEACHER role, own course resolved
// from the teacher's groups, homework → lesson → (canonical) course.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { resolveContentTrackScope } from "@/lib/track-scope";
import {
  LESSON_PLACEMENT_SELECT,
  TEACHER_LIMITS,
  boundedText,
  lessonPlacement,
  lessonTrackScope,
  parseDeadline,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const existing = await db.homework.findUnique({
    where: { id },
    include: {
      lesson: { select: LESSON_PLACEMENT_SELECT },
      submissions: { select: { id: true, grade: true, status: true } },
    },
  });
  if (!existing) return err(tApi("api.238"), 404);

  const placement = lessonPlacement(existing.lesson as ChainLesson | null);
  if (!placement || !teacherCourseIds(teacher).includes(placement.courseId)) {
    return err(tApi("api.180"), 403);
  }

  const body = await req.json().catch(() => ({}));

  // ---- immutable fields ---------------------------------------------------
  if (body.lessonId !== undefined && String(body.lessonId) !== existing.lessonId) {
    return err(tApi("api.241"), 400);
  }

  // ---- graded history -----------------------------------------------------
  const grades = existing.submissions
    .map((s) => s.grade)
    .filter((g): g is number => typeof g === "number");
  const gradedCount = existing.submissions.filter(
    (s) => s.status === "GRADED"
  ).length;
  const highestGrade = grades.length ? Math.max(...grades) : null;

  const data: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = boundedText(body.title, TEACHER_LIMITS.TITLE_MAX, {
      required: true,
    });
    if (!title.ok || !title.value) return err(tApi("api.234"), 400);
    data.title = title.value;
  }
  if (body.titleAr !== undefined) {
    const titleAr = boundedText(body.titleAr, TEACHER_LIMITS.TITLE_AR_MAX);
    if (!titleAr.ok) return err(tApi("api.234"), 400);
    data.titleAr = titleAr.value ?? data.title ?? existing.title;
  }
  if (body.instructions !== undefined) {
    const instructions = boundedText(
      body.instructions,
      TEACHER_LIMITS.INSTRUCTIONS_MAX,
      { required: true }
    );
    if (!instructions.ok || !instructions.value) {
      return err(tApi("api.237", { p1: TEACHER_LIMITS.INSTRUCTIONS_MAX }), 400);
    }
    data.instructions = instructions.value;
  }
  if (body.deadline !== undefined) {
    const deadline = parseDeadline(body.deadline);
    if (!deadline) return err(tApi("api.235"), 400);
    data.deadline = deadline;
  }
  if (body.maxMarks !== undefined) {
    const maxMarks = Number(body.maxMarks);
    if (
      !Number.isInteger(maxMarks) ||
      maxMarks < TEACHER_LIMITS.MARKS_MIN ||
      maxMarks > TEACHER_LIMITS.MARKS_MAX
    ) {
      return err(
        tApi("api.236", {
          p1: TEACHER_LIMITS.MARKS_MIN,
          p2: TEACHER_LIMITS.MARKS_MAX,
        }),
        400
      );
    }
    if (highestGrade !== null && maxMarks < highestGrade) {
      return err(tApi("api.240", { p1: highestGrade }), 409);
    }
    data.maxMarks = maxMarks;
  }
  if (body.trackScope !== undefined) {
    const scope = resolveContentTrackScope(
      body.trackScope,
      lessonTrackScope(existing.lesson as ChainLesson)
    );
    if (!scope.ok) {
      return err(
        scope.reason === "OUT_OF_LESSON_SCOPE" ? tApi("api.243") : tApi("api.228"),
        400
      );
    }
    if (scope.scope !== existing.trackScope && gradedCount > 0) {
      return err(tApi("api.239"), 409);
    }
    data.trackScope = scope.scope;
  }

  if (Object.keys(data).length === 0) return err(tApi("api.234"), 400);

  const updated = await db.homework.update({ where: { id }, data });

  return ok({
    homework: {
      id: updated.id,
      lessonId: updated.lessonId,
      title: updated.title,
      titleAr: updated.titleAr,
      instructions: updated.instructions,
      deadline: updated.deadline,
      maxMarks: updated.maxMarks,
      trackScope: updated.trackScope,
      lesson: {
        id: existing.lessonId,
        officialCode: (existing.lesson as ChainLesson | null)?.officialCode ?? null,
        courseId: placement.courseId,
        chain: placement.chain,
      },
      /** Graded submissions that were preserved untouched by this edit. */
      preservedGrades: grades.length,
      gradedCount,
    },
  });
}
