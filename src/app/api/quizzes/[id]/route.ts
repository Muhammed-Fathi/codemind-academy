import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser } from "@/lib/api";

// GET /api/quizzes/[id]
// Returns quiz + questions. For MVP, returns answers + explanations too —
// the runner hides them until submission.
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const quiz = await db.quiz.findUnique({
    where: { id },
    include: {
      lesson: {
        include: {
          topic: { include: { unit: { include: { part: { include: { course: true } } } } } },
        },
      },
      questions: { orderBy: { createdAt: "asc" } },
    },
  });
  if (!quiz) return err("Quiz not found", 404);

  // Pull the student's previous attempts (if student)
  let bestAttempt: {
    id: string;
    score: number;
    totalMarks: number;
    percentage: number;
    passed: boolean;
    finishedAt: Date | null;
  } | null = null;
  if (user.role === "STUDENT") {
    const attempts = await db.quizAttempt.findMany({
      where: { quizId: id, student: { userId: user.id } },
      orderBy: { percentage: "desc" },
    });
    if (attempts.length > 0) {
      const a = attempts[0];
      bestAttempt = {
        id: a.id,
        score: a.score,
        totalMarks: a.totalMarks,
        percentage: a.percentage,
        passed: a.passed,
        finishedAt: a.finishedAt,
      };
    }
  }

  return ok({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      titleAr: quiz.titleAr,
      description: quiz.description,
      passMark: quiz.passMark,
      timeLimit: quiz.timeLimit,
    },
    lesson: quiz.lesson
      ? {
          id: quiz.lesson.id,
          title: quiz.lesson.title,
          titleAr: quiz.lesson.titleAr,
          courseSlug: quiz.lesson.topic.unit.part.course.slug,
        }
      : null,
    questions: quiz.questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: JSON.parse(q.options),
      answer: q.answer,
      explanation: q.explanation,
      difficulty: q.difficulty,
      marks: q.marks,
    })),
    bestAttempt,
  });
}
