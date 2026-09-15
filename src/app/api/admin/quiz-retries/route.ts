// /api/admin/quiz-retries — Phase 26D
//
//   POST — grant ONE additional Lesson Quiz attempt to ONE student. ADMIN ONLY.
//   GET  — list grants (filter by studentId / quizId), newest first.
//
// WHY THIS ROUTE IS ADMIN-ONLY AND NOTHING ELSE IS
//   "May this student retake the quiz?" is an assessment-integrity decision. A
//   teacher authors the quiz and sees the results, but must not be able to
//   issue extra attempts to their own students — that is the difference between
//   a graded assessment and a favour. So:
//     ADMIN   → 200/201 here.
//     TEACHER → 403. There is no teacher equivalent of this route at all.
//     STUDENT → 403. A student cannot forge their own grant.
//
// WHAT A GRANT IS
//   One row. `consumedAt = null` until the student actually starts the new
//   attempt, at which point the start route stamps it and links the attempt via
//   `QuizAttempt.retryGrantId`. One grant ⇒ exactly one extra attempt. Granting
//   never deletes, resets, reopens or regrades anything: every previous attempt
//   and its score stay exactly as they were.
//
// VALIDATION
//   * student and quiz must both exist (404, not 403 — an id probe must not be
//     an oracle that distinguishes "exists but not yours" from "does not exist";
//     for an Admin everything exists or does not);
//   * the student must actually be able to reach the quiz: same course as the
//     quiz's lesson, and a track the quiz is eligible for. Granting a retry on a
//     quiz the student can never open would create a permanently unusable
//     permission and a misleading audit trail;
//   * at most ONE unconsumed grant per (student, quiz) — a second POST returns
//     409 `ALREADY_PENDING` with the existing grant rather than stacking two
//     extra attempts behind one operator click.
//
// AUDIT
//   Every successful grant writes `QUIZ_RETRY_GRANTED` to AuditLog naming the
//   acting admin, the student, the quiz and the reason.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { issueRetryGrant } from "@/lib/quiz-retry";
import { isQuestionEligible } from "@/lib/track-scope";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const studentId = url.searchParams.get("studentId")?.trim() || "";
  const quizId = url.searchParams.get("quizId")?.trim() || "";
  const pendingOnly = url.searchParams.get("pending") === "1";
  const take = Math.min(200, Math.max(1, parseInt(url.searchParams.get("take") || "50", 10)));

  const where: Record<string, unknown> = {};
  if (studentId) where.studentId = studentId;
  if (quizId) where.quizId = quizId;
  if (pendingOnly) where.consumedAt = null;

  const grants = await db.quizRetryGrant.findMany({
    where,
    orderBy: { grantedAt: "desc" },
    take,
    include: {
      student: { include: { user: { select: { name: true, email: true } } } },
      quiz: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          lesson: { select: { id: true, title: true, titleAr: true } },
        },
      },
      grantedBy: { select: { id: true, name: true, email: true } },
      attempts: {
        select: {
          id: true,
          attemptNumber: true,
          status: true,
          percentage: true,
          startedAt: true,
          finishedAt: true,
        },
      },
    },
  });

  return ok({
    grants: grants.map((g) => ({
      id: g.id,
      student: {
        id: g.student.id,
        name: g.student.user.name,
        email: g.student.user.email,
      },
      quiz: {
        id: g.quiz.id,
        title: g.quiz.titleAr || g.quiz.title,
        lessonId: g.quiz.lesson?.id ?? null,
        lessonTitle: g.quiz.lesson ? g.quiz.lesson.titleAr || g.quiz.lesson.title : null,
      },
      grantedBy: { id: g.grantedBy.id, name: g.grantedBy.name, email: g.grantedBy.email },
      grantedAt: g.grantedAt,
      consumedAt: g.consumedAt,
      consumed: g.consumedAt !== null,
      reason: g.reason,
      /** The attempt(s) this grant permitted — the lineage an auditor wants. */
      attempts: g.attempts,
    })),
  });
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const studentId = typeof body.studentId === "string" ? body.studentId.trim() : "";
  const quizId = typeof body.quizId === "string" ? body.quizId.trim() : "";

  if (!studentId || !quizId) {
    return err("studentId and quizId are required", 400);
  }

  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { id: true, schoolType: true, groupId: true, group: { select: { courseId: true } } },
  });
  if (!student) return err("Student not found", 404);

  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      trackScope: true,
      lesson: { select: { id: true, trackScope: true, unitId: true, topicId: true } },
    },
  });
  if (!quiz) return err("Quiz not found", 404);

  // The student must be able to reach this quiz at all: the quiz's course has to
  // be one the student's group teaches, and the quiz's track has to admit them.
  // Without this an Admin could grant a retry on a quiz from another course or
  // another track, which would be an unusable permission and a false audit row.
  const quizCourseId = quiz.lesson
    ? await resolveQuizCourseId(quiz.lesson.id)
    : null;
  const studentCourseId = student.group?.courseId ?? null;
  if (!quizCourseId || quizCourseId !== studentCourseId) {
    return err("Student is not enrolled in this quiz's course", 400);
  }

  // Track containment: reuse the SAME predicate selection and grading use, so a
  // grant can never legitimise a cross-track attempt.
  if (!isQuestionEligible(student.schoolType, quiz.trackScope === "SHARED" ? null : quiz.trackScope)) {
    return err("Quiz is not available for this student's track", 400);
  }

  const result = await issueRetryGrant({
    studentId,
    quizId,
    grantedByUserId: user!.id,
    reason: body.reason,
  });

  if (!result.ok) {
    return ok({
      granted: false,
      code: result.code,
      grantId: result.grantId,
      message: "An unconsumed retry grant already exists for this student and quiz",
    }, { status: 409 });
  }

  const grant = await db.quizRetryGrant.findUnique({
    where: { id: result.grantId },
    select: { id: true, grantedAt: true, consumedAt: true, reason: true },
  });

  return ok(
    {
      granted: true,
      grantId: result.grantId,
      studentId,
      quizId,
      grantedByUserId: user!.id,
      grantedAt: grant?.grantedAt ?? new Date(),
      consumedAt: grant?.consumedAt ?? null,
      reason: grant?.reason ?? null,
      /** Exactly one additional attempt. Not a flag, not an unlimited pass. */
      attemptsGranted: 1,
    },
    { status: 201 }
  );
}

/** The course a quiz's lesson hangs from, canonical chain first. */
async function resolveQuizCourseId(lessonId: string): Promise<string | null> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      unit: { select: { part: { select: { courseId: true } } } },
      topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } },
    },
  });
  return (
    lesson?.unit?.part.courseId ??
    lesson?.topic?.unit.part.courseId ??
    null
  );
}
