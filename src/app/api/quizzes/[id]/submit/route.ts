import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";
import {
  gradeAttemptQuestionSet,
  loadAttemptQuestionSet,
  type SubmittedAnswer,
} from "@/lib/session-quiz";

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

  const quiz = await db.quiz.findUnique({
    where: { id },
    select: { id: true, passMark: true },
  });
  if (!quiz) return err("Quiz not found", 404);

  const access = await canAccessQuiz(s.id, id);
  if (!access.allowed) return denyProgression(access.reason, "Quiz not found");

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
    select: { id: true },
  });

  // The attempt's own frozen question set (persisted rows), never the live
  // quiz questions. A pre-Phase-5 in-flight attempt with no rows adopts the
  // current quiz questions here (one-time upgrade path).
  const set = open
    ? await loadAttemptQuestionSet(open.id)
    : await db.question.findMany({
        where: { quizId: id },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }).then((qs) =>
        qs.map((q) => ({
          answerId: null,
          questionId: q.id,
          selected: "",
          question: q,
        }))
      );

  // Server-side grading — no client value can influence the result.
  const { graded, score, totalMarks, percentage, passed } =
    gradeAttemptQuestionSet(set, answersRaw, quiz.passMark);

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

  return ok({
    attemptId: attempt.id,
    score,
    totalMarks,
    percentage,
    passed,
    passMark: quiz.passMark,
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
