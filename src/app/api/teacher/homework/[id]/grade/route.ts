// PATCH /api/teacher/homework/[id]/grade
//   body: { studentId, grade: number, feedback: string }
//   Updates the HomeworkSubmission for that homework + student, sets
//   status=GRADED. Returns the updated submission.
//
// Phase G hardening:
//   * `0 ≤ grade ≤ maxMarks` enforced SERVER-SIDE (previously 0..100, which
//     let a grade exceed the assignment's own ceiling);
//   * grader identity + instant recorded (`gradedById` / `gradedAt`);
//   * DRAFT assignments cannot be graded (they do not exist for students, so
//     there is nothing a student could have submitted against them);
//   * first grade audited HOMEWORK_GRADED, every re-grade HOMEWORK_REGRADED
//     (with old/new values), so the grade history is attributable.
import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  teacherCourseIds as teacherCourseIdsOf,
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

  const homeworkId = id;
  const body = await req.json().catch(() => ({}));
  const studentId = String(body.studentId || "");
  const gradeNum = Number(body.grade);
  const feedback =
    body.feedback === undefined || body.feedback === null
      ? null
      : String(body.feedback).trim() || null;
  if (feedback && feedback.length > 4000) return err(tApi("api.234"), 400);

  if (!studentId) return err(tApi("api.168"), 400);
  if (!Number.isInteger(gradeNum) || Number.isNaN(gradeNum))
    return err(tApi("api.169"), 400);

  // Verify the homework belongs to one of the teacher's courses.
  //
  // Phase 18 FIX: this check used to read ONLY the legacy Topic chain
  // (`lesson.topic?.unit.part.courseId`). Official lessons are unit-linked
  // with a NULL topicId (Phase 11), so every assignment on a canonical lesson
  // was refused with a 403 and could never be graded. The chain is now
  // resolved CANONICAL FIRST — the same precedence the progression engine and
  // every Phase 18 write route use (src/lib/teacher-content.ts).
  const hw = await db.homework.findUnique({
    where: { id: homeworkId },
    include: { lesson: { select: LESSON_PLACEMENT_SELECT } },
  });
  if (!hw) return err(tApi("api.171"), 404);
  const teacherCourseIds = teacherCourseIdsOf(teacher);
  const placement = lessonPlacement((hw.lesson ?? null) as ChainLesson | null);
  if (!placement || !teacherCourseIds.includes(placement.courseId)) {
    return err(tApi("api.172"), 403);
  }

  // Phase G — the grade is bounded by the assignment's OWN ceiling, not a
  // global 0..100: an 18 on a 10-mark assignment is a corrupt record.
  if (gradeNum < 0 || gradeNum > hw.maxMarks)
    return err(tApi("api.170", { p1: hw.maxMarks }), 400);

  // Phase G — a DRAFT assignment is invisible to students; nothing could have
  // been submitted against it, so grading one is refused (publish first).
  if (hw.status === "DRAFT") return err(tApi("api.356"), 409);

  // Phase 26D FIX — validate the STUDENT before writing anything.
  //
  // This route will happily CREATE a submission for a student who never
  // submitted ("teacher pre-grades"), so an unvalidated `studentId` went
  // straight into an INSERT. Two consequences:
  //   * a nonexistent id hit the foreign key and surfaced as an unhandled 500
  //     rather than a clean refusal;
  //   * more seriously, a VALID id from another teacher's course would have
  //     been graded — the homework was scope-checked, the student was not.
  // Both are now refused: unknown student → 404, a student outside the
  // teacher's own courses → 403.
  const target = await db.student.findUnique({
    where: { id: studentId },
    select: { id: true, group: { select: { courseId: true } } },
  });
  if (!target) return err(tApi("api.168"), 404);
  const targetCourseId = target.group?.courseId ?? null;
  if (!targetCourseId || !teacherCourseIds.includes(targetCourseId)) {
    return err(tApi("api.172"), 403);
  }

  // Find or create the submission row
  const existing = await db.homeworkSubmission.findUnique({
    where: { homeworkId_studentId: { homeworkId, studentId } },
  });

  // Phase G — late/on-time survives grading: it is derived from the preserved
  // `submittedAt` vs the assignment deadline (the stored status becomes
  // GRADED; the lateness FACT is never lost).
  const gradedAt = new Date();
  const effectiveSubmittedAt = existing?.submittedAt || gradedAt;
  const wasLate = effectiveSubmittedAt > hw.deadline;

  let updated;
  if (existing) {
    updated = await db.homeworkSubmission.update({
      where: { id: existing.id },
      data: {
        grade: gradeNum,
        feedback,
        status: "GRADED",
        submittedAt: effectiveSubmittedAt,
        // Phase G — grader identity (re-grade overwrites: the LAST grader is
        // the attributable one; the audit trail keeps the full history).
        gradedById: user.id,
        gradedAt,
      },
      include: {
        student: {
          include: { user: { select: { name: true, email: true } } },
        },
      },
    });
  } else {
    // No submission yet — create a GRADED record anyway (teacher pre-grades)
    updated = await db.homeworkSubmission.create({
      data: {
        homeworkId,
        studentId,
        grade: gradeNum,
        feedback,
        status: "GRADED",
        submittedAt: effectiveSubmittedAt,
        gradedById: user.id,
        gradedAt,
      },
      include: {
        student: {
          include: { user: { select: { name: true, email: true } } },
        },
      },
    });
  }

  // Phase G — grading is an IMPORTANT action: first grade vs re-grade are
  // audited distinctly, with the old/new values, so a changed verdict is
  // attributable. Best-effort: an audit failure never fails the grade write.
  const regrade = existing?.grade !== null && existing?.grade !== undefined;
  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: regrade ? "HOMEWORK_REGRADED" : "HOMEWORK_GRADED",
        entity: "HomeworkSubmission",
        entityId: updated.id,
        details: JSON.stringify({
          homeworkId,
          studentId,
          previousGrade: existing?.grade ?? null,
          grade: gradeNum,
          previousStatus: existing?.status ?? null,
          late: wasLate,
        }),
      },
    })
    .catch(() => {});

  // Send QUIZ_RESULT-style notification to the student's user
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { userId: true },
  });
  if (student) {
    await db.notification
      .create({
        data: {
          userId: student.userId,
          type: "QUIZ_RESULT",
          title: tApi("api.173", { p1: hw.titleAr || hw.title }),
          message: tApi("api.174", {
            p1: gradeNum,
            p2: hw.maxMarks,
            p3: feedback ? tApi("api.175", { p1: feedback }) : "",
          }),
          link: "student-homework",
        },
      })
      .catch(() => {});
  }

  return ok({
    submission: {
      id: updated.id,
      homeworkId: updated.homeworkId,
      studentId: updated.studentId,
      grade: updated.grade,
      feedback: updated.feedback,
      status: updated.status,
      // Phase G — lateness fact + grader identity alongside the verdict.
      late: wasLate,
      gradedAt: updated.gradedAt,
      submittedAt: updated.submittedAt,
      student: {
        id: updated.student.id,
        name: updated.student.user.name,
        email: updated.student.user.email,
      },
    },
  });
}
