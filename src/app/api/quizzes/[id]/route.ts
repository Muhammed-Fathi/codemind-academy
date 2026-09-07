import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import { canAccessLesson } from "@/lib/session-progress";

// GET /api/quizzes/[id]
//
// SECURITY: the correct answer and the explanation are NEVER included in this
// payload for a student. Previously both were serialized here and merely
// hidden by the runner, so `fetch('/api/quizzes/<id>').then(r=>r.json())` in
// the browser console handed the student a full answer key before submitting.
// Answers/explanations are now only returned by the /submit route, after the
// attempt has been graded and persisted.
//
// SECURITY: a quiz belongs to a lesson (session). Opening a quiz is therefore
// gated by exactly the same rule as opening the lesson itself — otherwise a
// student could read the questions of a locked future session by calling this
// route directly with a guessed/leaked quiz id.
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

  const isStudent = user.role === "STUDENT";

  if (isStudent) {
    const s = await getStudentProfile(user.id);
    if (!s) return err("Student profile not found", 404);
    const access = await canAccessLesson(s.id, quiz.lessonId);
    if (!access.allowed) {
      // Deliberately vague: do not confirm which of "not enrolled" vs
      // "locked" applies beyond the machine-readable code already used by
      // the lesson route, and never echo any question data.
      return err("Forbidden", 403);
    }
  }

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
      difficulty: q.difficulty,
      marks: q.marks,
      // `answer` and `explanation` are intentionally omitted for students.
      // Staff (teacher/admin) authoring views get them so the existing
      // review tooling keeps working.
      ...(isStudent ? {} : { answer: q.answer, explanation: q.explanation }),
    })),
    bestAttempt,
  });
}
