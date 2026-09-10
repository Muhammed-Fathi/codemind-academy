// POST /api/quizzes/[id]/start
//
// Opens (or resumes) an unfinished QuizAttempt for the current student and
// returns its id. The attempt row must exist BEFORE the quiz begins so that
// camera evidence captured during the attempt has something to attach to.
//
// Phase 5 — attempt question-set persistence:
//   When a NEW attempt is created, the quiz's current questions are frozen
//   into that attempt as unanswered QuizAnswer rows. From that moment the
//   attempt serves and grades exactly that set — refreshing, navigating away
//   and back, reconnecting, or logging out and in again can never
//   re-derive a different set from the live Question Bank, and questions
//   added to the quiz afterwards only affect FUTURE attempts.
//
// Phase 18 — server-side time limit (see src/lib/session-quiz.ts):
//   `Quiz.timeLimit` is enforced, not decorative. `startedAt` is written HERE,
//   by the server, and the response carries the server-computed deadline so
//   the client can render a countdown it cannot forge:
//
//     { timeLimitMinutes, startedAt, expiresAt, remainingSeconds, expired }
//
//   Resuming an attempt whose deadline has passed does NOT hand the student
//   more time on the same attempt: the expired attempt is FINALISED at its
//   deadline from the answers the server already holds (the frozen set, seeded
//   unanswered, so an abandoned attempt grades to zero) and a FRESH attempt is
//   created with a new clock. Time is never banked, and the attempt is never
//   left open forever — which also means the Phase 4 progression rule ("a
//   finished attempt exists") is satisfied exactly as an immediate empty
//   submit would satisfy it, with no new unlock path.
//
// Security notes:
//   * Students only, and only for their own profile — the attempt's studentId
//     comes from the session, never from the request body.
//   * Resuming is idempotent: repeated calls (refresh, remount) return
//     the same open attempt instead of spawning duplicates.
//   * `cameraStatus` is recorded here as the student's up-front decision; the
//     evidence route may later refine it (DENIED, INTERRUPTED, ...).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";
import {
  gradeExpiredAttempt,
  loadAttemptQuestionSet,
  seedAttemptQuestions,
  timeLimitState,
} from "@/lib/session-quiz";
import { getStudentSchoolType } from "@/lib/enrollment";

const ALLOWED_STATUSES = new Set([
  "NOT_REQUESTED",
  "GRANTED",
  "DENIED",
  "UNAVAILABLE",
  "INTERRUPTED",
  "DECLINED",
]);

export async function POST(
  req: NextRequest,
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
    select: { id: true, passMark: true, timeLimit: true },
  });
  if (!quiz) return err("Quiz not found", 404);

  // Backend authorization: a quiz belonging to a locked session cannot be
  // opened, so no attempt row is ever created for content the student has not
  // reached. Without this a student could pre-open (and later pre-finish) the
  // quiz of every future session.
  const access = await canAccessQuiz(student.id, id);
  if (!access.allowed) return denyProgression(access.reason, "Quiz not found");

  // Phase 12 — the student's own school type decides which questions are
  // frozen into the attempt. Read from their row, never from the request.
  const schoolType = await getStudentSchoolType(student.id);

  const body = await req.json().catch(() => ({}));
  const requested = String(body.cameraStatus || "NOT_REQUESTED");
  const cameraStatus = ALLOWED_STATUSES.has(requested) ? requested : "NOT_REQUESTED";

  // Resume an already-open attempt rather than creating a second one.
  const existing = await db.quizAttempt.findFirst({
    where: { quizId: id, studentId: student.id, finishedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true },
  });

  if (existing) {
    // Phase 18 — an attempt past its deadline is closed, not resumed. Its
    // frozen rows are graded as they stand (unanswered → zero), so the record
    // is honest and the progression rule sees a finished attempt.
    const state = timeLimitState(existing.startedAt, quiz.timeLimit);
    if (state.expired && state.deadline) {
      const set = await loadAttemptQuestionSet(existing.id, schoolType);
      const graded = gradeExpiredAttempt(set, quiz.passMark, schoolType);
      await db.quizAttempt.update({
        where: { id: existing.id },
        data: {
          score: graded.score,
          totalMarks: graded.totalMarks,
          percentage: graded.percentage,
          passed: graded.passed,
          finishedAt: state.deadline,
        },
      });
      // Fall through to creating a fresh attempt with a fresh clock.
    } else {
      // Upgrade compatibility: an attempt opened BEFORE Phase 5 has no
      // persisted question set yet. Freeze the current quiz questions into it
      // now (exactly what a fresh attempt would do) so the set becomes stable
      // from this point on. Attempts created after Phase 5 already have rows
      // and keep them untouched.
      const set = await loadAttemptQuestionSet(existing.id, schoolType);
      if (set.length > 0 && set.every((q) => q.answerId === null)) {
        await seedAttemptQuestions(existing.id, id, schoolType);
      }
      await db.quizAttempt.update({
        where: { id: existing.id },
        data: { cameraStatus },
      });
      const resumedState = timeLimitState(existing.startedAt, quiz.timeLimit);
      return ok({
        attemptId: existing.id,
        resumed: true,
        timeLimitMinutes: resumedState.limited ? Number(quiz.timeLimit) : null,
        startedAt: existing.startedAt,
        expiresAt: resumedState.deadline,
        remainingSeconds: resumedState.remainingSeconds,
        expired: false,
      });
    }
  }

  const attempt = await db.quizAttempt.create({
    data: {
      quizId: id,
      studentId: student.id,
      score: 0,
      totalMarks: 0,
      percentage: 0,
      passed: false,
      cameraStatus,
      // finishedAt stays null: the attempt is in progress. `startedAt` is the
      // server's `now` default — the ONLY writer of the clock this phase
      // enforces against.
    },
    select: { id: true, startedAt: true },
  });

  // Freeze this attempt's question set: one unanswered answer row per
  // ELIGIBLE current quiz question. The set is immutable from here on.
  await seedAttemptQuestions(attempt.id, id, schoolType);

  const state = timeLimitState(attempt.startedAt, quiz.timeLimit);
  return ok({
    attemptId: attempt.id,
    resumed: false,
    timeLimitMinutes: state.limited ? Number(quiz.timeLimit) : null,
    startedAt: attempt.startedAt,
    expiresAt: state.deadline,
    remainingSeconds: state.remainingSeconds,
    expired: false,
  });
}
