// GET /api/quizzes/[id]/attempts — Phase 26D, the student's OWN attempt history.
//
// A student may read the attempts they hold on a quiz they are entitled to see,
// and no one else's. The student id is taken from the session; there is no
// studentId parameter to forge.
//
// This is the surface that makes "one attempt" visible and honest: the student
// can see that attempt #1 is terminal, how many attempts the quiz allows, and
// whether an Admin has granted them another. Without it a refused start looks
// like a bug.
//
// ANSWER KEY: only for terminal attempts, and only because the existing product
// contract already reveals answers to a student after their first submission
// (see `revealAnswers` in GET /api/quizzes/[id]). This route preserves that
// contract exactly — it does not widen it, and an OPEN attempt never carries a
// key.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";
import { getStudentSchoolType } from "@/lib/enrollment";
import { buildAttemptInspection } from "@/lib/session-quiz";
import { resolveQuizBlueprint } from "@/lib/quiz-blueprint";
import { countPendingRetryGrants } from "@/lib/quiz-retry";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  const quiz = await db.quiz.findUnique({
    where: { id },
    select: {
      id: true,
      passMark: true,
      quizMode: true,
      questionCount: true,
      difficultyPlan: true,
      shuffleOptions: true,
      maxAttempts: true,
    },
  });
  if (!quiz) return err("Quiz not found", 404);

  const access = await canAccessQuiz(student.id, id);
  if (!access.allowed) return denyProgression(access.reason, "Quiz not found");

  const schoolType = await getStudentSchoolType(student.id);
  const blueprint = resolveQuizBlueprint(quiz);

  // Scoped to THIS student by the session's own profile id — never a parameter.
  const attempts = await db.quizAttempt.findMany({
    where: { quizId: id, studentId: student.id },
    orderBy: { attemptNumber: "asc" },
    select: {
      id: true,
      quizId: true,
      studentId: true,
      attemptNumber: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      score: true,
      totalMarks: true,
      percentage: true,
      passed: true,
      retryGrantId: true,
    },
  });

  const detailed = await Promise.all(
    attempts.map((a) => buildAttemptInspection(a, { schoolType, revealAnswerKey: true }))
  );

  const pendingRetryGrants = await countPendingRetryGrants(student.id, id);
  const attemptsUsed = attempts.length;
  const hasOpenAttempt = attempts.some((a) => a.finishedAt === null);

  return ok({
    quiz: {
      id: quiz.id,
      passMark: quiz.passMark,
      quizMode: blueprint.mode,
      maxAttempts: blueprint.maxAttempts,
    },
    attempts: detailed.map((inspection) => ({
      id: inspection.id,
      attemptNumber: inspection.attemptNumber,
      status: inspection.status,
      startedAt: inspection.startedAt,
      finishedAt: inspection.finishedAt,
      score: inspection.score,
      totalMarks: inspection.totalMarks,
      percentage: inspection.percentage,
      passed: inspection.passed,
      answerKeyRevealed: inspection.answerKeyRevealed,
      questions: inspection.questions,
      // The student does not need to see WHO granted a retry, only that one was
      // granted — actor details belong to the Admin surface.
      retryGrant: inspection.retryGrant ? { granted: true } : null,
    })),
    entitlement: {
      attemptsUsed,
      maxAttempts: blueprint.maxAttempts,
      hasOpenAttempt,
      pendingRetryGrants,
      /** True when POST /start would be allowed right now. */
      canStart: hasOpenAttempt || attemptsUsed < blueprint.maxAttempts || pendingRetryGrants > 0,
      /** A further attempt beyond the allowance requires an Admin grant. */
      retryRequiresAdmin: !hasOpenAttempt && attemptsUsed >= blueprint.maxAttempts && pendingRetryGrants === 0,
    },
  });
}
