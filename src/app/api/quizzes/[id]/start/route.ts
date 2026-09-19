// POST /api/quizzes/[id]/start
//
// Opens (or resumes) a QuizAttempt for the current student and returns its id.
// The attempt row must exist BEFORE the quiz begins so that camera evidence
// captured during the attempt has something to attach to.
//
// Phase 26D — ONE ATTEMPT, SERVER-SELECTED, FROZEN
// ================================================
// This route is the ONLY place a Lesson Quiz attempt is created, and creating
// one now means three things at once:
//
//   1. It CONSUMES the student's entitlement. `Quiz.maxAttempts` defaults to 1,
//      so starting the quiz uses it up. A refresh, a navigation away, a logout
//      and a browser restart all RESUME the open attempt instead of making
//      another one (`decideAttemptStart`). Once the attempt is terminal the
//      student cannot start again unless an Admin has issued an unconsumed
//      `QuizRetryGrant`.
//   2. The SERVER selects the questions. `selectAttemptQuestionsForQuiz` runs
//      the quiz's blueprint against the Question Bank pool, honouring the track
//      filter, the requested count and the difficulty plan, and preferring
//      questions this student has not already seen. The client supplies no
//      question id, no attempt number and no retry metadata — there is nothing
//      in the body for it to supply except the camera decision.
//   3. The selected set is FROZEN with a full snapshot (wording, option order,
//      answer key, marks, difficulty, track tag, position) onto the attempt's
//      `QuizAnswer` rows, so a later Question Bank edit cannot rewrite what this
//      student was asked or how they were graded.
//
// If the pool cannot satisfy the blueprint the attempt is NOT created and the
// request fails with 422 `BLUEPRINT_UNSATISFIABLE`. A short quiz served silently
// would be a different assessment from the one the teacher configured.
//
// Phase 18 — server-side time limit (see src/lib/session-quiz.ts):
//   `Quiz.timeLimit` is enforced, not decorative. `startedAt` is written HERE,
//   by the server, and the response carries the server-computed deadline so the
//   client can render a countdown it cannot forge:
//
//     { timeLimitMinutes, startedAt, expiresAt, remainingSeconds, expired }
//
//   PHASE 26D CHANGE: an attempt whose deadline has passed is finalised as
//   EXPIRED and is TERMINAL. Phase 18 used to open a fresh attempt afterwards;
//   that was an unlimited-retake path (an abandoned timed quiz could be
//   restarted forever) and it is now closed. A student in that state needs an
//   Admin retry grant, exactly like one who submitted.
//
// Security notes:
//   * Students only, and only for their own profile — the attempt's studentId
//     comes from the session, never from the request body.
//   * Resuming is idempotent: repeated calls (refresh, remount) return
//     the same open attempt instead of spawning duplicates.
//   * `cameraStatus` is recorded here as the student's up-front decision; the
//     evidence route may later refine it (DENIED, INTERRUPTED, ...).

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, denyProgression } from "@/lib/api";
import { canAccessQuiz } from "@/lib/session-progress";
import {
  decideAttemptStart,
  gradeExpiredAttempt,
  loadAttemptQuestionSet,
  loadStudentSeenQuestionIds,
  seedAttemptQuestions,
  selectAttemptQuestionsForQuiz,
  timeLimitState,
} from "@/lib/session-quiz";
import {
  BlueprintUnsatisfiableError,
  resolveQuizBlueprint,
} from "@/lib/quiz-blueprint";
import { countPendingRetryGrants, consumeRetryGrant } from "@/lib/quiz-retry";
import { acquireQuizDestructiveLock } from "@/lib/db-serialization";
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
    select: {
      id: true,
      passMark: true,
      timeLimit: true,
      // Phase 26D blueprint columns — the selection rule for this attempt.
      quizMode: true,
      questionCount: true,
      difficultyPlan: true,
      shuffleOptions: true,
      maxAttempts: true,
      // Phase G lifecycle gate.
      status: true,
    },
  });
  if (!quiz) return err("Quiz not found", 404);

  // Phase G — a DRAFT quiz cannot be started: identical 404 to a nonexistent
  // id so its existence never leaks. Only a PUBLISHED quiz accepts attempts.
  if (quiz.status !== "PUBLISHED") return err("Quiz not found", 404);

  // Backend authorization: a quiz belonging to a locked session cannot be
  // opened, so no attempt row is ever created for content the student has not
  // reached. Without this a student could pre-open (and later pre-finish) the
  // quiz of every future session.
  const access = await canAccessQuiz(student.id, id);
  if (!access.allowed) return denyProgression(access.reason, "Quiz not found");

  // Phase 12 — the student's own school type decides which questions are
  // eligible. Read from their row, never from the request.
  const schoolType = await getStudentSchoolType(student.id);

  const body = await req.json().catch(() => ({}));
  const requested = String(body.cameraStatus || "NOT_REQUESTED");
  const cameraStatus = ALLOWED_STATUSES.has(requested) ? requested : "NOT_REQUESTED";

  const blueprint = resolveQuizBlueprint(quiz);

  const attempts = await db.quizAttempt.findMany({
    where: { quizId: id, studentId: student.id },
    orderBy: { startedAt: "desc" },
    select: { id: true, startedAt: true, finishedAt: true, attemptNumber: true },
  });

  // Phase 18 — an OPEN attempt past its deadline is closed, not resumed. Its
  // frozen rows are graded as they stand (unanswered → zero), so the record is
  // honest and the progression rule sees a finished attempt. Phase 26D: this is
  // now TERMINAL, so control falls through to the normal entitlement decision
  // rather than to a fresh attempt.
  const open = attempts.find((a) => a.finishedAt === null);
  if (open) {
    const state = timeLimitState(open.startedAt, quiz.timeLimit);
    if (state.expired && state.deadline) {
      const set = await loadAttemptQuestionSet(open.id, schoolType);
      const graded = gradeExpiredAttempt(set, quiz.passMark, schoolType);
      await db.quizAttempt.update({
        where: { id: open.id },
        data: {
          score: graded.score,
          totalMarks: graded.totalMarks,
          percentage: graded.percentage,
          passed: graded.passed,
          finishedAt: state.deadline,
          status: "EXPIRED",
        },
      });
      // Reflect the finalisation in the in-memory list so the decision below
      // counts it as used.
      for (const a of attempts) {
        if (a.id === open.id) a.finishedAt = state.deadline;
      }
    }
  }

  const existing = attempts.find((a) => a.finishedAt === null);
  if (existing) {
    // Upgrade compatibility: an attempt opened BEFORE Phase 5 has no persisted
    // question set yet. Freeze the current quiz questions into it now (exactly
    // what a fresh attempt would do) so the set becomes stable from this point
    // on. Attempts created after Phase 5 already have rows and keep them.
    const set = await loadAttemptQuestionSet(existing.id, schoolType);
    if (set.length > 0 && set.every((q) => q.answerId === null)) {
      // Same protocol as the create path below: this also writes `QuizAnswer`
      // rows, so it takes the same per-quiz lock and freezes inside the
      // transaction. Without it a concurrent question delete could cascade
      // these rows away just the same.
      await db.$transaction(async (tx) => {
        await acquireQuizDestructiveLock(tx, id);
        await seedAttemptQuestions(existing.id, id, schoolType, { blueprint, tx });
      });
    }
    await db.quizAttempt.update({
      where: { id: existing.id },
      data: { cameraStatus },
    });
    const resumedState = timeLimitState(existing.startedAt, quiz.timeLimit);
    return ok({
      attemptId: existing.id,
      attemptNumber: existing.attemptNumber ?? 1,
      resumed: true,
      timeLimitMinutes: resumedState.limited ? Number(quiz.timeLimit) : null,
      startedAt: existing.startedAt,
      expiresAt: resumedState.deadline,
      remainingSeconds: resumedState.remainingSeconds,
      expired: false,
    });
  }

  // ---- Entitlement decision ---------------------------------------------
  const pendingGrants = await countPendingRetryGrants(student.id, id);
  const decision = decideAttemptStart({
    attempts,
    maxAttempts: blueprint.maxAttempts,
    pendingGrants,
  });

  if (decision.kind === "denied") {
    // Truthful, and deliberately not a 404: the student is allowed to know they
    // have used their attempt on a quiz they are entitled to see.
    return NextResponse.json(
      {
        error: "Attempt limit reached",
        code: decision.code,
        attemptsUsed: decision.attemptsUsed,
        maxAttempts: decision.maxAttempts,
        /** A further attempt requires an Admin-issued retry grant. */
        retryRequiresAdmin: true,
      },
      { status: 409 }
    );
  }

  if (decision.kind === "resume") {
    // Unreachable in practice — the open-attempt branch above resumes and
    // returns before we get here. Kept so the decision is handled exhaustively
    // and the compiler can narrow the rest of this function to "create".
    return ok({ attemptId: decision.attemptId, resumed: true });
  }

  // ---- Server-side selection, BEFORE the attempt row exists --------------
  // Variation input: every question this student has already seen on this quiz,
  // across all their attempts, so a granted retry prefers fresh questions.
  const seen = await loadStudentSeenQuestionIds(id, student.id);

  let selection;
  try {
    selection = await selectAttemptQuestionsForQuiz(id, schoolType, blueprint, seen);
  } catch (e) {
    if (e instanceof BlueprintUnsatisfiableError) {
      // No attempt is created: the student keeps their entitlement rather than
      // burning it on a quiz that cannot be assembled.
      return NextResponse.json(
        {
          error: "Quiz cannot be assembled from its question pool",
          code: e.code,
          detail: e.detail,
        },
        { status: 422 }
      );
    }
    throw e;
  }

  const now = new Date();
  const attempt = await db.$transaction(async (tx) => {
    // Phase 26D — FIRST statement of this transaction, on purpose.
    //
    // `QuizAnswer.question` is `onDelete: Cascade`, and a teacher may delete a
    // question or the whole quiz. Under PostgreSQL READ COMMITTED the delete
    // path's reference check is a bare SELECT that takes no lock conflicting
    // with THIS transaction's `QuizAnswer` insert, so without a shared lock the
    // two could interleave as: delete checks (0 refs) -> we insert and commit ->
    // delete cascades our just-frozen rows away. The attempt would then exist
    // with its history destroyed.
    //
    // Both sides therefore take the same per-quiz advisory lock before doing
    // anything else, which orders them totally. See src/lib/db-serialization.ts.
    await acquireQuizDestructiveLock(tx, id);

    const created = await tx.quizAttempt.create({
      data: {
        quizId: id,
        studentId: student.id,
        score: 0,
        totalMarks: 0,
        percentage: 0,
        passed: false,
        cameraStatus,
        // Server-computed sequence; never taken from the request.
        attemptNumber: decision.attemptNumber,
        status: "OPEN",
        // finishedAt stays null: the attempt is in progress. `startedAt` is the
        // server's clock — the ONLY writer of the clock this phase enforces
        // against.
        startedAt: now,
      },
      select: { id: true, startedAt: true, attemptNumber: true },
    });

    // Spend the grant that permitted this attempt, if any — inside the same
    // transaction, so two concurrent starts cannot both spend it.
    const grantId =
      decision.attemptNumber > 1
        ? await consumeRetryGrant(tx, {
            studentId: student.id,
            quizId: id,
            attemptId: created.id,
            now,
          })
        : null;

    if (grantId) {
      await tx.quizAttempt.update({
        where: { id: created.id },
        data: { retryGrantId: grantId },
      });
    }

    // Freeze this attempt's question set WITH a full snapshot — INSIDE this
    // transaction, while the advisory lock above is still held. Freezing after
    // COMMIT would release the lock first and reopen the delete race the lock
    // exists to close. The set is immutable from here on and needs no further
    // read of the live bank.
    await seedAttemptQuestions(created.id, id, schoolType, {
      blueprint,
      preselected: selection.questions,
      tx,
    });

    return created;
  });

  const state = timeLimitState(attempt.startedAt, quiz.timeLimit);
  return ok({
    attemptId: attempt.id,
    attemptNumber: attempt.attemptNumber,
    resumed: false,
    /** How many attempts this student has now used, ceiling included. */
    attemptsUsed: decision.attemptNumber,
    maxAttempts: blueprint.maxAttempts,
    /** True when an Admin grant permitted this attempt. */
    usedRetryGrant: decision.attemptNumber > 1,
    timeLimitMinutes: state.limited ? Number(quiz.timeLimit) : null,
    startedAt: attempt.startedAt,
    expiresAt: state.deadline,
    remainingSeconds: state.remainingSeconds,
    expired: false,
  });
}
