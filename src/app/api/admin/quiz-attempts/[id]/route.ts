// GET /api/admin/quiz-attempts/[id] — Phase 26D attempt detail (ADMIN).
//
// The full record of one attempt: student, quiz, sequence number, state, clock,
// score, the exact questions that were frozen into it, the answers submitted,
// and — when the attempt only existed because an Admin allowed it — the grant
// that permitted it, who issued it and when.
//
// ANSWER KEY: present only for a TERMINAL attempt (`finishedAt` set). An OPEN
// attempt is a running assessment and its key is never exposed here; see
// `buildAttemptInspection` for the single place that rule lives.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { buildAttemptInspection } from "@/lib/session-quiz";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;

  const attempt = await db.quizAttempt.findUnique({
    where: { id },
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
      cameraStatus: true,
      student: { select: { id: true, user: { select: { name: true, email: true } } } },
      quiz: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          passMark: true,
          quizMode: true,
          questionCount: true,
          maxAttempts: true,
          lesson: { select: { id: true, title: true, titleAr: true } },
        },
      },
    },
  });
  if (!attempt) return err("Attempt not found", 404);

  const inspection = await buildAttemptInspection(attempt, {
    // Admin review: the key is shown for finished attempts.
    revealAnswerKey: true,
  });

  // Every attempt this student holds on this quiz, so the inspector sees the
  // sequence in context rather than one row floating on its own.
  const history = await db.quizAttempt.findMany({
    where: { quizId: attempt.quizId, studentId: attempt.studentId },
    orderBy: { attemptNumber: "asc" },
    select: {
      id: true,
      attemptNumber: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      percentage: true,
      passed: true,
      retryGrantId: true,
    },
  });

  return ok({
    attempt: {
      ...inspection,
      cameraStatus: attempt.cameraStatus,
      student: {
        id: attempt.student.id,
        name: attempt.student.user.name,
        email: attempt.student.user.email,
      },
      quiz: {
        id: attempt.quiz.id,
        title: attempt.quiz.titleAr || attempt.quiz.title,
        passMark: attempt.quiz.passMark,
        quizMode: attempt.quiz.quizMode,
        questionCount: attempt.quiz.questionCount,
        maxAttempts: attempt.quiz.maxAttempts,
        lessonId: attempt.quiz.lesson?.id ?? null,
        lessonTitle: attempt.quiz.lesson
          ? attempt.quiz.lesson.titleAr || attempt.quiz.lesson.title
          : null,
      },
    },
    /** All attempts of this student on this quiz, in sequence order. */
    history,
  });
}
