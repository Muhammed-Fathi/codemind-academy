import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";

// POST /api/quizzes/[id]/submit
// Body: { answers: { questionId, selected }[] }
// Creates a QuizAttempt, computes score, returns the result.
//
// AUTHORIZATION: the quiz must belong to a session the student has unlocked.
// Otherwise a single POST would satisfy the quiz requirement of a session the
// student never opened (and hand back every correct answer + explanation).
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
    include: { questions: true },
  });
  if (!quiz) return err("Quiz not found", 404);

  const access = await canAccessQuiz(s.id, id);
  if (!access.allowed) return denyProgression(access.reason, "Quiz not found");

  const body = await req.json().catch(() => ({}));
  const answersRaw: { questionId: string; selected: string }[] = Array.isArray(body.answers)
    ? body.answers
    : [];

  // Score computation
  let score = 0;
  let totalMarks = 0;
  const gradedAnswers: {
    questionId: string;
    selected: string;
    isCorrect: boolean;
    correctAnswer: string;
    marks: number;
    prompt: string;
    promptAr: string | null;
    options: string[];
    explanation: string | null;
  }[] = [];

  for (const q of quiz.questions) {
    totalMarks += q.marks;
    const a = answersRaw.find((x) => x.questionId === q.id);
    const selected = a?.selected ?? "";
    const isCorrect = selected === q.answer;
    if (isCorrect) score += q.marks;
    gradedAnswers.push({
      questionId: q.id,
      selected,
      isCorrect,
      correctAnswer: q.answer,
      marks: q.marks,
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: JSON.parse(q.options),
      explanation: q.explanation,
    });
  }

  const percentage =
    totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;
  const passed = percentage >= quiz.passMark;

  // If /start already opened an attempt (it does whenever the quiz UI runs the
  // camera monitor), finalise THAT row so any evidence captured during the
  // attempt stays attached to the graded result. Otherwise create a fresh one.
  const open = await db.quizAttempt.findFirst({
    where: { quizId: id, studentId: s.id, finishedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  const attemptData = {
    score,
    totalMarks,
    percentage,
    passed,
    finishedAt: new Date(),
  };

  const attempt = open
    ? await db.quizAttempt.update({
        where: { id: open.id },
        data: {
          ...attemptData,
          // Replace any partial answers from an interrupted run.
          answers: {
            deleteMany: {},
            create: gradedAnswers.map((a) => ({
              questionId: a.questionId,
              selected: a.selected,
              isCorrect: a.isCorrect,
            })),
          },
        },
        include: { answers: true },
      })
    : await db.quizAttempt.create({
        data: {
          quizId: id,
          studentId: s.id,
          ...attemptData,
          answers: {
            create: gradedAnswers.map((a) => ({
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
    answers: gradedAnswers.map((a) => ({
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
