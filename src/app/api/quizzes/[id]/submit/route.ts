import { NextRequest, NextResponse } from "next/server";
import { getServerT } from "@/lib/i18n-server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";
import {
  gradeAttemptQuestionSet,
  gradeExpiredAttempt,
  loadAttemptQuestionSet,
  timeLimitState,
  type SubmittedAnswer,
} from "@/lib/session-quiz";
import { getStudentSchoolType } from "@/lib/enrollment";
import { createNotificationIfAllowed } from "@/lib/notify";
import { syncDerivedCompletion } from "@/lib/progression";
import { maybeResolveCatchup } from "@/lib/catchup";

// POST /api/quizzes/[id]/submit
// Body: { answers: { questionId, selected }[] }
//
// Grades the student's OPEN attempt and returns the result.
//
// AUTHORIZATION: the quiz must belong to a session the student has unlocked.
// Otherwise a single POST would satisfy the quiz requirement of a session the
// student never opened (and hand back every correct answer + explanation).
//
// Phase 5 — grading is server-side over the ATTEMPT'S OWN QUESTION SET:
//   * The set was frozen into QuizAnswer rows when the attempt was created
//     (/start). Submit grades exactly those rows — questions added to the quiz
//     after the attempt started cannot be graded into it, and answers for
//     questions outside the attempt are IGNORED, never added.
//   * Score, percentage, correctness and marks are computed from the frozen
//     answer basis. Client-provided score/percentage/isCorrect/marks values are
//     never read.
//
// Phase 26D — SUBMIT IS A TERMINAL TRANSITION:
//   * An attempt must be OPEN to be submitted. This route NEVER creates an
//     attempt. The old "submit with no open attempt creates a fresh one" path
//     was an unlimited-retake hole — a student could loop POST /submit and
//     accumulate attempts without ever calling /start — and it is gone.
//   * The attempt moves OPEN → SUBMITTED exactly once. A replay of the same
//     submit (double click, retried request, flaky network) finds no open
//     attempt and returns the ALREADY-GRADED result instead of grading again,
//     so a resubmission can neither improve a score nor create a second attempt.
//   * `finishedAt` is written by the server and is never cleared by any code
//     path. Reopening an attempt is not representable.
//
// Phase 18 — server-side TIME LIMIT (see src/lib/session-quiz.ts):
//   When the quiz carries a `timeLimit`, the open attempt's deadline is
//   `startedAt + timeLimit + TIME_LIMIT_GRACE_SECONDS`, evaluated against the
//   SERVER's clock — the client never supplies an expiry, and a frozen browser
//   timer cannot extend it. A submit that arrives after the deadline is REFUSED
//   with 409 + `code: "TIME_LIMIT_EXCEEDED"`, and the expired attempt is
//   finalised at its deadline from the answers the server already holds (the
//   frozen set is seeded unanswered, so a timed-out attempt grades to zero).
//   Late answers are never graded into it. `timeLimit = null` keeps the previous
//   behaviour unchanged.
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const s = await getStudentProfile(user.id);
  if (!s) return err("Student profile not found", 404);

  const tApi = await getServerT();
  const quiz = await db.quiz.findUnique({
    where: { id },
    select: { id: true, lessonId: true, title: true, titleAr: true, passMark: true, timeLimit: true },
  });
  if (!quiz) return err("Quiz not found", 404);

  const access = await canAccessQuiz(s.id, id);
  if (!access.allowed) return denyProgression(access.reason, "Quiz not found", {
      state: access.evaluation?.state ?? null,
      reason: access.evaluation?.reason ?? null,
      reasonCode: access.evaluation?.reasonCode ?? null,
      unmet: access.evaluation?.unmet ?? [],
      holdBlocked: access.reason === "ABSENCE_HOLD",
    });

  // Phase 12 — grading uses the SAME track rule as selection, so a question
  // the student was never served can never be graded into their score.
  const schoolType = await getStudentSchoolType(s.id);

  const body = await req.json().catch(() => ({}));
  const answersRaw: SubmittedAnswer[] = Array.isArray(body.answers)
    ? body.answers
    : [];

  // The attempt being submitted is ALWAYS the student's own open one. Its id is
  // never taken from the body, so a forged `attemptId` cannot target someone
  // else's attempt or resurrect a finished one.
  const open = await db.quizAttempt.findFirst({
    where: { quizId: id, studentId: s.id, finishedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, attemptNumber: true },
  });

  // ---- Phase 26D: no open attempt → nothing to grade ---------------------
  // Replay-safe: return the already-recorded result of the student's latest
  // terminal attempt rather than grading again or creating anything. This is
  // what makes a double submit harmless.
  if (!open) {
    const latest = await db.quizAttempt.findFirst({
      where: { quizId: id, studentId: s.id },
      orderBy: { startedAt: "desc" },
      select: {
        id: true,
        score: true,
        totalMarks: true,
        percentage: true,
        passed: true,
        startedAt: true,
        finishedAt: true,
        attemptNumber: true,
        status: true,
      },
    });

    if (!latest) {
      // Never started. Telling the student to start is truthful and leaks
      // nothing: they are already authorised for this quiz.
      return NextResponse.json(
        { error: "No attempt in progress", code: "ATTEMPT_NOT_STARTED" },
        { status: 409 }
      );
    }

    const submittedLimit = timeLimitState(latest.startedAt, quiz.timeLimit);
    return NextResponse.json(
      {
        error: "Attempt already submitted",
        code: "ATTEMPT_ALREADY_SUBMITTED",
        alreadySubmitted: true,
        attemptId: latest.id,
        attemptNumber: latest.attemptNumber,
        status: latest.status,
        score: latest.score,
        totalMarks: latest.totalMarks,
        percentage: latest.percentage,
        passed: latest.passed,
        passMark: quiz.passMark,
        timeLimitMinutes: submittedLimit.limited ? Number(quiz.timeLimit) : null,
        startedAt: latest.startedAt,
        finishedAt: latest.finishedAt,
      },
      { status: 409 }
    );
  }

  // Phase 18 — the time limit is checked BEFORE any grading, and it is the
  // server's clock that decides.
  const limit = timeLimitState(open.startedAt, quiz.timeLimit);
  if (limit.expired && limit.deadline) {
    const expiredSet = await loadAttemptQuestionSet(open.id, schoolType);
    const expired = gradeExpiredAttempt(expiredSet, quiz.passMark, schoolType);
    const finalized = await db.quizAttempt.update({
      where: { id: open.id },
      data: {
        score: expired.score,
        totalMarks: expired.totalMarks,
        percentage: expired.percentage,
        passed: expired.passed,
        finishedAt: limit.deadline,
        status: "EXPIRED",
      },
      select: { id: true },
    });
    return NextResponse.json(
      {
        error: tApi("api.256"),
        code: "TIME_LIMIT_EXCEEDED",
        attemptId: finalized.id,
        attemptNumber: open.attemptNumber,
        score: expired.score,
        totalMarks: expired.totalMarks,
        percentage: expired.percentage,
        passed: expired.passed,
        passMark: quiz.passMark,
        finishedAt: limit.deadline,
        timeLimitMinutes: Number(quiz.timeLimit),
        answers: expired.graded.map((a) => ({
          questionId: a.questionId,
          prompt: a.prompt,
          promptAr: a.promptAr,
          selected: a.selected,
          correctAnswer: a.correctAnswer,
          isCorrect: a.isCorrect,
          marks: a.marks,
          options: a.options,
          explanation: a.explanation,
        })),
      },
      { status: 409 }
    );
  }

  // The attempt's own frozen question set — served and graded from the Phase 26D
  // snapshot, so a Question Bank edit made while the student was working cannot
  // change what they are graded against. A pre-Phase-5 in-flight attempt with no
  // rows adopts the current quiz questions here (one-time upgrade path).
  const set = await loadAttemptQuestionSet(open.id, schoolType);

  // Server-side grading — no client value can influence the result. The
  // student's school type is passed so grading independently refuses any
  // ineligible question that might still have an answer row.
  const { graded, score, totalMarks, percentage, passed } =
    gradeAttemptQuestionSet(set, answersRaw, quiz.passMark, schoolType);

  const finishedAt = new Date();

  const attempt = await db.$transaction(async (tx) => {
    // Persist the graded answers onto their existing frozen rows (creating them
    // only for the pre-Phase-5 adopted set). One row per question is guaranteed
    // by @@unique([attemptId, questionId]), and only questions IN the frozen set
    // are ever touched — a submitted questionId outside the set is dropped by
    // the grader and can never insert a row.
    for (const g of graded) {
      const entry = set.find((q) => q.questionId === g.questionId)!;
      if (entry.answerId) {
        await tx.quizAnswer.update({
          where: { id: entry.answerId },
          data: { selected: g.selected, isCorrect: g.isCorrect },
        });
      } else {
        await tx.quizAnswer.create({
          data: {
            attemptId: open.id,
            questionId: g.questionId,
            selected: g.selected,
            isCorrect: g.isCorrect,
            // No snapshot for the legacy adopted set: those rows keep reading
            // the live question, exactly as they did before this phase.
          },
        });
      }
    }
    // One terminal transition. `finishedAt` is written here and never cleared.
    return tx.quizAttempt.update({
      where: { id: open.id },
      data: {
        score,
        totalMarks,
        percentage,
        passed,
        finishedAt,
        status: "SUBMITTED",
      },
      include: { answers: true },
    });
  });

  const submittedLimit = timeLimitState(open.startedAt, quiz.timeLimit);

  // One terminal notification emission point. The dedupe key is the immutable
  // attempt id, so retries/replays cannot create a second result notification.
  const studentUser = await db.student.findUnique({ where: { id: s.id }, select: { userId: true } });
  if (studentUser) {
    await createNotificationIfAllowed({
      userId: studentUser.userId,
      type: "QUIZ_RESULT",
      title: `نتيجة الاختبار: ${quiz.titleAr || quiz.title}`,
      message: `${percentage}% — ${passed ? "ناجح" : "لم ينجح"} (${score}/${totalMarks})`,
      link: `quiz:${id}`,
      dedupeKey: `quiz-result:${attempt.id}`,
    }).catch(() => {});

    // Teacher recipients are derived exclusively from the quiz lesson's
    // Course -> Group -> Teacher ownership chain. No client teacher id is
    // accepted, and the attempt id makes replay delivery idempotent.
    const lesson = await db.lesson.findUnique({
      where: { id: quiz.lessonId },
      select: {
        unit: { select: { part: { select: { courseId: true } } } },
        topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } },
      },
    });
    const courseId = lesson?.unit?.part?.courseId ?? lesson?.topic?.unit?.part?.courseId;
    if (courseId) {
      const teachers = await db.teacher.findMany({
        where: { groups: { some: { courseId, teacherId: { not: null }, isActive: true } } },
        select: { userId: true },
      });
      const studentName = (await db.user.findUnique({ where: { id: studentUser.userId }, select: { name: true } }))?.name || "طالب";
      await Promise.all(teachers.map((teacher) => createNotificationIfAllowed({
        userId: teacher.userId,
        type: "QUIZ_RESULT",
        title: "إكمال اختبار",
        message: `${studentName} أنهى اختبار ${quiz.titleAr || quiz.title} وحصل على ${percentage}% (${passed ? "ناجح" : "لم ينجح"}).`,
        link: `quiz:${id}`,
        dedupeKey: `quiz-completed:${attempt.id}:teacher:${teacher.userId}`,
      }).catch(() => {})));
    }
  }

  // Phase H — a submitted quiz may complete its lesson (pass) or complete a
  // catch-up (hold resolution). Both syncs are best-effort and never throw:
  // grading already committed, and a sync failure must not fail the submit.
  // The legacy `isCompleted` marker converges to the canonical derivation,
  // and eligible holds resolve through the Phase F authority.
  await syncDerivedCompletion(s.id, quiz.lessonId);
  await maybeResolveCatchup(s.id, user.id);

  return ok({
    attemptId: attempt.id,
    attemptNumber: open.attemptNumber,
    status: "SUBMITTED",
    score,
    totalMarks,
    percentage,
    passed,
    passMark: quiz.passMark,
    /** Server-computed window of the attempt that was just graded. */
    timeLimitMinutes: submittedLimit.limited ? Number(quiz.timeLimit) : null,
    startedAt: open.startedAt,
    finishedAt,
    /** Whether this student may start again without an Admin retry grant. */
    canRetry: false,
    answers: graded.map((a) => ({
      questionId: a.questionId,
      prompt: a.prompt,
      promptAr: a.promptAr,
      selected: a.selected,
      correctAnswer: a.correctAnswer,
      isCorrect: a.isCorrect,
      marks: a.marks,
      options: a.options,
      explanation: a.explanation,
    })),
  });
}
