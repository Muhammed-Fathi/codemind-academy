import { NextRequest, NextResponse } from "next/server";
import { getServerT } from "@/lib/i18n-server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";
import {
  gradeAttemptQuestionSet,
  gradeExpiredAttempt,
  loadAttemptQuestionSet,
  loadQuizQuestionSet,
  timeLimitState,
  type SubmittedAnswer,
} from "@/lib/session-quiz";
import { getStudentSchoolType } from "@/lib/enrollment";

// POST /api/quizzes/[id]/submit
// Body: { answers: { questionId, selected }[] }
//
// Grades the student's OPEN attempt (or creates one when none is open — the
// documented retake path) and returns the result.
//
// AUTHORIZATION: the quiz must belong to a session the student has unlocked.
// Otherwise a single POST would satisfy the quiz requirement of a session the
// student never opened (and hand back every correct answer + explanation).
//
// Phase 5 — grading is server-side over the ATTEMPT'S OWN QUESTION SET:
//   * The set was frozen into QuizAnswer rows when the attempt was created
//     (/start). Submit grades exactly those rows — questions added to the
//     quiz after the attempt started cannot be graded into it, and answers
//     for questions outside the attempt are ignored.
//   * Score, percentage, correctness and marks are computed from the
//     authoritative answer stored on each question row. Client-provided
//     score/percentage/isCorrect/marks values are never read.
//   * A FINISHED attempt is immutable: submit only ever writes to the open
//     attempt (or a brand-new one). Repeated submission therefore creates a
//     fresh retake attempt, never modifies a submitted one.
//
// Phase 18 — server-side TIME LIMIT (see src/lib/session-quiz.ts):
//   When the quiz carries a `timeLimit`, the open attempt's deadline is
//   `startedAt + timeLimit + TIME_LIMIT_GRACE_SECONDS`, evaluated against the
//   SERVER's clock — the client never supplies an expiry, and a frozen browser
//   timer cannot extend it. A submit that arrives after the deadline is
//   REFUSED with 409 + `code: "TIME_LIMIT_EXCEEDED"`, and the expired attempt
//   is finalised at its deadline from the answers the server already holds
//   (the frozen set is seeded unanswered, so a timed-out attempt grades to
//   zero). Late answers are never graded into it: accepting them would make
//   the limit decorative, which is exactly the state Phase 18 was told to
//   resolve. `timeLimit = null` keeps the previous behaviour unchanged.
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
    select: { id: true, passMark: true, timeLimit: true },
  });
  if (!quiz) return err("Quiz not found", 404);

  const access = await canAccessQuiz(s.id, id);
  if (!access.allowed) return denyProgression(access.reason, "Quiz not found");

  // Phase 12 — grading uses the SAME track rule as selection, so a question
  // the student was never served can never be graded into their score.
  const schoolType = await getStudentSchoolType(s.id);

  const body = await req.json().catch(() => ({}));
  const answersRaw: SubmittedAnswer[] = Array.isArray(body.answers)
    ? body.answers
    : [];

  // If /start already opened an attempt (it does whenever the quiz UI runs the
  // camera monitor), finalise THAT row so any evidence captured during the
  // attempt stays attached to the graded result. Otherwise create a fresh one
  // (direct submit / retake).
  const open = await db.quizAttempt.findFirst({
    where: { quizId: id, studentId: s.id, finishedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true },
  });

  // Phase 18 — the time limit is checked BEFORE any grading, and it is the
  // server's clock that decides. Only the OPEN attempt is subject to it: a
  // direct submit with no open attempt (the documented retake path) starts and
  // finishes in the same request, so there is no window to exceed.
  if (open) {
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
        },
        select: { id: true },
      });
      return NextResponse.json(
        {
          error: tApi("api.256"),
          code: "TIME_LIMIT_EXCEEDED",
          attemptId: finalized.id,
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
  }

  // The attempt's own frozen question set (persisted rows), never the live
  // quiz questions. A pre-Phase-5 in-flight attempt with no rows adopts the
  // current quiz questions here (one-time upgrade path).
  const set = open
    ? await loadAttemptQuestionSet(open.id, schoolType)
    : await loadQuizQuestionSet(id, schoolType);

  // Server-side grading — no client value can influence the result. The
  // student's school type is passed so grading independently refuses any
  // ineligible question that might still have an answer row.
  const { graded, score, totalMarks, percentage, passed } =
    gradeAttemptQuestionSet(set, answersRaw, quiz.passMark, schoolType);

  const finishedAt = new Date();
  const attemptData = {
    score,
    totalMarks,
    percentage,
    passed,
    finishedAt,
  };

  const attempt = open
    ? await db.$transaction(async (tx) => {
        // Persist the graded answers onto their existing rows (creating them
        // only for the pre-Phase-5 adopted set). One row per question is
        // guaranteed by @@unique([attemptId, questionId]).
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
              },
            });
          }
        }
        return tx.quizAttempt.update({
          where: { id: open.id },
          data: attemptData,
          include: { answers: true },
        });
      })
    : await db.quizAttempt.create({
        data: {
          quizId: id,
          studentId: s.id,
          ...attemptData,
          answers: {
            create: graded.map((a) => ({
              questionId: a.questionId,
              selected: a.selected,
              isCorrect: a.isCorrect,
            })),
          },
        },
        include: { answers: true },
      });

  const submittedLimit = timeLimitState(
    open?.startedAt ?? finishedAt,
    quiz.timeLimit
  );

  return ok({
    attemptId: attempt.id,
    score,
    totalMarks,
    percentage,
    passed,
    passMark: quiz.passMark,
    /** Server-computed window of the attempt that was just graded. */
    timeLimitMinutes: submittedLimit.limited ? Number(quiz.timeLimit) : null,
    startedAt: open?.startedAt ?? null,
    finishedAt,
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
