import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";
import { loadAttemptQuestionSet, safeParseOptions } from "@/lib/session-quiz";
import { isParentAuthorizedForCourse } from "@/lib/parent-access";

// GET /api/quizzes/[id]
// Returns quiz + questions. Answers and explanations are withheld from
// students until they have submitted at least one attempt —
// the runner hides them until submission.
//
// AUTHORIZATION: a student may only read a quiz that belongs to a session they
// have unlocked. Without this the questions, options and (after any attempt)
// the answers of every future session are readable straight off the API.
//
// Phase 5 — deterministic question set: when the student has an OPEN attempt,
// the questions returned are that attempt's PERSISTED set (frozen when the
// attempt was created), not the live quiz questions. A refresh, a navigation
// away and back, or a logout/login therefore always returns the exact same
// set, even if the quiz was edited in between. Without an open attempt the
// live quiz questions are served (they will be frozen when the next attempt
// starts).
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
      // BOTH curriculum chains: the canonical Lesson.unitId chain and the
      // legacy Lesson.topicId chain. The canonical link wins when a lesson
      // carries both (the same rule the Phase 4 progression engine uses);
      // legacy-only lessons resolve through their topic.
      lesson: {
        include: {
          unit: { include: { part: { include: { course: true } } } },
          topic: { include: { unit: { include: { part: { include: { course: true } } } } } },
        },
      },
      questions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!quiz) return err("Quiz not found", 404);

  // Phase 7: a parent may open ONLY quizzes of courses in which a linked
  // child is enrolled. Quiz ids are unguessable, so an out-of-scope quiz
  // looks exactly like a nonexistent one (404). Teacher/admin preview and
  // the student session gate below are unchanged.
  if (user.role === "PARENT") {
    const quizCourseId =
      quiz.lesson?.unit?.part.courseId ??
      quiz.lesson?.topic?.unit.part.courseId ??
      null;
    const allowed = await isParentAuthorizedForCourse(user.id, quizCourseId);
    if (!allowed) return err("Quiz not found", 404);
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
  let studentHasAttempted = false;
  let attemptQuestionIds: string[] | null = null;
  if (user.role === "STUDENT") {
    const s = await getStudentProfile(user.id);
    if (!s) return err("Student profile not found", 404);

    const access = await canAccessQuiz(s.id, id);
    if (!access.allowed) return denyProgression(access.reason, "Quiz not found");

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
      studentHasAttempted = attempts.some((x) => x.finishedAt !== null);
    }

    // Deterministic set: an open attempt pins the exact question list.
    const open = attempts.find((x) => x.finishedAt === null);
    if (open) {
      const set = await loadAttemptQuestionSet(open.id);
      attemptQuestionIds = set.map((q) => q.questionId);
    }
  }

  // Teachers and admins always see answers (needed for review/creation).
  // Students see answers only after submitting at least one attempt.
  // (Staff answer visibility is the documented Phase 1 audit decision.)
  const revealAnswers =
    user.role === "ADMIN" || user.role === "TEACHER" || user.role === "PARENT" || studentHasAttempted;

  // Canonical chain first, legacy topic chain as fallback.
  const courseSlug =
    quiz.lesson?.unit?.part.course.slug ??
    quiz.lesson?.topic?.unit.part.course.slug ??
    null;

  const questions = attemptQuestionIds
    ? quiz.questions.filter((q) => attemptQuestionIds!.includes(q.id))
    : quiz.questions;

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
          courseSlug,
        }
      : null,
    questions: questions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: safeParseOptions(q.options),
      answer: revealAnswers ? q.answer : undefined,
      explanation: revealAnswers ? q.explanation : undefined,
      difficulty: q.difficulty,
      marks: q.marks,
    })),
    bestAttempt,
  });
}
