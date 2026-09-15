// CodeMind Academy — Session Quiz core (Phase 5).
//
// The single place that decides the two things the Session Quiz flow must
// never let the client influence:
//
//   1. WHICH questions an attempt covers — the attempt's question set is
//      PERSISTED (as `QuizAnswer` rows) the moment the attempt is created and
//      never re-derived from the live Question Bank afterwards. Refresh,
//      navigation, reconnect and logout/login all return the same set, and a
//      question added to the quiz mid-attempt cannot join an open attempt.
//   2. HOW an attempt is graded — server-side only, from the authoritative
//      answer stored on the question row. Score, percentage, correctness and
//      marks are computed here; client-provided values are never read.
//
// Relation to the other assessment surfaces (deliberate boundaries):
//   * Mock exams (`/api/exams/mock`, `ExamAttempt`) are a SEPARATE flow that
//     samples the shared Question Bank at attempt time and snapshots answers
//     as JSON. They do not share state with Session Quiz attempts.
//   * Phase 4 progression (`src/lib/session-progress.ts`) stays the single
//     source of truth for "is the quiz requirement satisfied" (a finished
//     QuizAttempt exists). Nothing here re-implements unlocking.
//
// Selection policy (Phase 26D — SUPERSEDED):
//   The comment above this block used to say that a Session Quiz has no
//   per-student randomisation and that every student sees the quiz's whole
//   question list. That was true, and Phase 26D retired it: a Lesson Quiz now
//   carries a BLUEPRINT (src/lib/quiz-blueprint.ts) and the server selects a
//   per-attempt set from the Question Bank pool, honouring the blueprint's
//   count and difficulty rules and preferring questions the student has not
//   already seen. `quizMode = "FIXED"` (every quiz that predates this phase)
//   keeps the old behaviour exactly, so nothing about a legacy quiz changes.
//
// Snapshot policy (Phase 26D — NEW):
//   Phase 5 froze WHICH questions an attempt covers but not WHAT they said:
//   prompt, options, answer key, marks and difficulty were all read from the
//   LIVE `Question` row at serve time and at grading time. A Question Bank edit
//   therefore rewrote a submitted result — the stored score could disagree with
//   the key the student was later shown. `seedAttemptQuestions` now writes those
//   fields onto the `QuizAnswer` row at freeze time, and
//   `loadAttemptQuestionSet` reads them back, so a historical attempt is
//   self-describing. Rows written before this phase have no snapshot and fall
//   back to the live question — i.e. exactly the behaviour they always had.

import { db } from "@/lib/db";
import type { Question } from "@prisma/client";
import {
  eligibleQuestionFilter,
  isQuestionEligible,
} from "@/lib/track-scope";
import type { SchoolType } from "@/lib/school-type";
import {
  resolveQuizBlueprint,
  selectAttemptQuestions,
  shuffled,
  type PoolQuestion,
  type QuizBlueprint,
  type SelectionDiagnostics,
} from "@/lib/quiz-blueprint";

// ---------------------------------------------------------------------------
// Track eligibility (Phase 12)
// ---------------------------------------------------------------------------
//
// `Question.schoolType` already existed and the MOCK-EXAM flow already
// honoured it. The SESSION QUIZ flow did not: it froze every question of the
// quiz into the attempt regardless of the student's school type, and graded
// all of them. Phase 12 closes that.
//
// The rule, applied at BOTH ends so selection and grading cannot drift apart:
//
//   schoolType = null   → SHARED question, eligible for every student
//   schoolType = ARABIC → eligible for ARABIC students only
//   schoolType = LANGUAGE → eligible for LANGUAGE students only
//
//   * SELECTION: `seedAttemptQuestions` only freezes eligible questions, so a
//     new attempt's immutable set never contains a question the student must
//     not see.
//   * SERVING: `loadAttemptQuestionSet` re-applies the same predicate to the
//     frozen set. That covers attempts opened BEFORE this hardening (whose
//     rows may hold an ineligible question) and the pre-Phase-5 upgrade path
//     that adopts the live quiz questions.
//   * GRADING: `gradeAttemptQuestionSet` re-applies it a third time and drops
//     the question from the set entirely — it contributes neither marks nor
//     score, so an ineligible question can never receive credit, even if a
//     stale answer row exists for it.
//
// The attempt's frozen set REMAINS authoritative: this narrows it, it never
// re-derives it from the live bank.


// ---------------------------------------------------------------------------
// Question-set selection & persistence
// ---------------------------------------------------------------------------

/**
 * A question covered by an attempt, plus the answer row that pins it to that
 * attempt. `answerId === null` marks a question that is part of the set but
 * not yet persisted — only possible for attempts opened BEFORE Phase 5 (see
 * `loadAttemptQuestionSet`).
 *
 * `question` is the ATTEMPT'S OWN view of the question: the Phase 26D snapshot
 * when the row has one, otherwise the live `Question` row (pre-26D attempts).
 * Callers therefore cannot tell the two apart and cannot accidentally grade
 * against the live bank — which is the point.
 */
export type AttemptQuestion = {
  answerId: string | null;
  questionId: string;
  selected: string;
  /** The stored verdict for this row (meaningful once the attempt is graded). */
  isCorrect: boolean;
  /** True when this row carries a Phase 26D snapshot of the question. */
  snapshotted: boolean;
  question: Pick<
    Question,
    | "id"
    | "type"
    | "prompt"
    | "promptAr"
    | "options"
    | "answer"
    | "explanation"
    | "difficulty"
    | "marks"
    | "schoolType"
  >;
};

/** Deterministic question order of a quiz (creation order, id tie-break). */
const QUIZ_QUESTION_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const;

/**
 * The question pool a Lesson Quiz selects from: the quiz's own Question Bank
 * rows, read live, UNFILTERED by track.
 *
 * Track filtering happens inside `selectAttemptQuestions`, not here, so that
 * the diagnostics can report both the raw pool size and the eligible size — a
 * quiz whose pool is entirely wrong-track must fail as "0 eligible", not as
 * "0 questions".
 */
export async function loadQuizQuestionPool(quizId: string): Promise<PoolQuestion[]> {
  return db.question.findMany({
    where: { quizId },
    orderBy: [...QUIZ_QUESTION_ORDER],
  });
}

/**
 * Run the blueprint selection for a new attempt of `quizId` — the ONLY caller
 * path that decides an attempt's question set.
 *
 * Pure with respect to the database: it reads the pool and returns the
 * selection, so a start route can compute the set (and its diagnostics) BEFORE
 * the attempt row exists, and so a preview surface can call it without writing.
 *
 * @throws BlueprintUnsatisfiableError when the pool cannot honour the blueprint.
 */
export async function selectAttemptQuestionsForQuiz(
  quizId: string,
  schoolType: SchoolType | null,
  blueprint: QuizBlueprint,
  previouslyUsedIds: readonly string[] = [],
  random: () => number = Math.random
): Promise<{ questions: PoolQuestion[]; diagnostics: SelectionDiagnostics }> {
  const pool = await loadQuizQuestionPool(quizId);
  const { questions, diagnostics } = selectAttemptQuestions({
    pool,
    blueprint,
    schoolType,
    previouslyUsedIds,
    random,
  });
  return { questions, diagnostics };
}

/**
 * Freeze one question's OPTION ORDER for an attempt.
 *
 * When the blueprint asks for shuffled choices the order must be frozen too:
 * `selected` and `answer` are indexes into the option array, so a display-time
 * shuffle would silently invalidate every stored answer on refresh. Returns the
 * shuffled array together with the RE-MAPPED correct index.
 *
 * A question whose stored answer is not a valid index is returned untouched —
 * shuffling something we cannot re-map would corrupt the key.
 */
export function freezeOptionOrder(
  q: Pick<PoolQuestion, "type" | "options" | "answer">,
  random: () => number
): { options: string[]; answer: string } {
  const options = safeParseOptions(q.options);
  if (q.type !== "MCQ" || options.length < 2) {
    return { options, answer: q.answer };
  }
  const idx = Number(q.answer);
  if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
    return { options, answer: q.answer };
  }
  const correctText = options[idx];
  const reordered = shuffled(options, random);
  const newIdx = reordered.indexOf(correctText);
  if (newIdx < 0) return { options, answer: q.answer };
  return { options: reordered, answer: String(newIdx) };
}

export type AttemptSeedOptions = {
  /**
   * An already-computed selection (from `selectAttemptQuestionsForQuiz`). When
   * absent the set is selected here with the quiz's own blueprint — the path a
   * caller with no diagnostics need takes.
   */
  preselected?: readonly PoolQuestion[];
  blueprint?: QuizBlueprint;
  previouslyUsedIds?: readonly string[];
  random?: () => number;
  /**
   * Transaction client to write the frozen rows through.
   *
   * Phase 26D: a caller holding the per-quiz destructive lock MUST pass its
   * transaction here. `QuizAnswer.question` is `onDelete: Cascade`, so if these
   * rows were written after the transaction committed, the lock would already be
   * released and a concurrent question delete could cascade them away — the
   * exact history destruction the lock exists to prevent. Writing inside the
   * transaction keeps the freeze atomic with the lock that authorised it.
   */
  tx?: Pick<typeof db, "quizAnswer">;
};

/**
 * Persist an attempt's frozen question set: one unanswered `QuizAnswer` row per
 * selected question, carrying a full snapshot of that question. Called exactly
 * once, at attempt creation.
 *
 * Phase 12: only questions ELIGIBLE for `schoolType` can be frozen in — the
 * selector applies that filter before anything is written, so a wrong-track
 * question cannot enter an attempt even momentarily.
 *
 * Phase 26D: each row also stores the question's wording, option order, correct
 * answer, marks, difficulty, track tag and position AT THIS MOMENT. From here on
 * the attempt is self-describing: serving it, grading it and reviewing it never
 * consult the live Question Bank again.
 */
export async function seedAttemptQuestions(
  attemptId: string,
  quizId: string,
  schoolType: SchoolType | null,
  opts: AttemptSeedOptions = {}
): Promise<void> {
  // No blueprint supplied → the LEGACY rule (FIXED: every eligible question,
  // creation order, no shuffle). That is deliberately NOT a quiz lookup: a
  // caller that has not resolved the quiz's blueprint gets the pre-26D
  // behaviour deterministically, and the start route — the only path that
  // creates attempts — always passes the real blueprint.
  const blueprint = opts.blueprint ?? resolveQuizBlueprint({});
  const random = opts.random ?? Math.random;

  const questions: readonly PoolQuestion[] = opts.preselected
    ? opts.preselected
    : (
        await selectAttemptQuestionsForQuiz(
          quizId,
          schoolType,
          blueprint,
          opts.previouslyUsedIds ?? [],
          random
        )
      ).questions;

  if (questions.length === 0) return;

  const shuffle = blueprint.shuffleOptions === true;

  // Write through the caller's transaction when one was supplied (see `tx` in
  // AttemptSeedOptions); otherwise the module client, as before.
  const writer = opts.tx ?? db;

  await writer.quizAnswer.createMany({
    data: questions.map((q, index) => {
      const frozen = shuffle ? freezeOptionOrder(q, random) : null;
      return {
        attemptId,
        questionId: q.id,
        selected: "",
        isCorrect: false,
        // Phase 26D snapshot — see the model comment in prisma/schema.prisma.
        orderIndex: index,
        questionType: q.type,
        promptSnapshot: q.prompt,
        promptArSnapshot: q.promptAr,
        optionsSnapshot: JSON.stringify(frozen ? frozen.options : safeParseOptions(q.options)),
        answerSnapshot: frozen ? frozen.answer : q.answer,
        explanationSnapshot: q.explanation,
        difficultySnapshot: q.difficulty,
        marksSnapshot: q.marks,
        schoolTypeSnapshot: q.schoolType,
      };
    }),
  });
}

/**
 * Rebuild a question from its Phase 26D snapshot.
 *
 * Returns `null` when the row carries no snapshot (a pre-26D attempt), in which
 * case the caller uses the live `Question` row instead — preserving, exactly,
 * the behaviour those attempts always had.
 *
 * The returned object has the same shape as a `Question` row precisely so that
 * serving and grading cannot tell a snapshot from a live row and therefore
 * cannot accidentally prefer the live one.
 */
function questionFromSnapshot(row: {
  questionId: string;
  promptSnapshot: string | null;
  promptArSnapshot: string | null;
  optionsSnapshot: string | null;
  answerSnapshot: string | null;
  explanationSnapshot: string | null;
  difficultySnapshot: string | null;
  marksSnapshot: number | null;
  schoolTypeSnapshot: string | null;
  questionType: string | null;
  question: Question | null;
}) {
  // `== null` ON PURPOSE: it covers both a stored NULL (a pre-26D row) and an
  // absent column (a caller or test fixture that does not model the snapshot
  // fields at all). Either way the row carries no snapshot and the live question
  // is authoritative — treating "absent" as "snapshot of nulls" would hand a
  // SHARED tag to a question that was never shared, which is a track leak.
  if (row.promptSnapshot == null || row.answerSnapshot == null) return null;
  const live = row.question;
  return {
    id: row.questionId,
    type: (row.questionType ?? live?.type ?? "MCQ") as Question["type"],
    prompt: row.promptSnapshot,
    promptAr: row.promptArSnapshot,
    // A snapshot always stores the option array (possibly "[]"), so a NULL here
    // can only mean legacy data — fall back rather than serve no options.
    options: row.optionsSnapshot ?? live?.options ?? "[]",
    answer: row.answerSnapshot,
    explanation: row.explanationSnapshot,
    difficulty: (row.difficultySnapshot ?? live?.difficulty ?? "MEDIUM") as Question["difficulty"],
    marks: row.marksSnapshot ?? live?.marks ?? 1,
    // The frozen track tag decides eligibility for a HISTORICAL attempt: if the
    // live question was later retagged into another track, the attempt that
    // already served it must not change meaning.
    schoolType: (row.schoolTypeSnapshot ?? null) as Question["schoolType"],
    createdAt: live?.createdAt ?? new Date(0),
  };
}

/**
 * The authoritative question set of an attempt.
 *
 *  * attempt with persisted rows → exactly those rows (frozen set);
 *  * attempt with NO rows → the attempt predates Phase 5 (opened before this
 *    hardening deployed). Its set is read from the live quiz questions —
 *    identical to the pre-Phase-5 behaviour — until submit persists the
 *    graded rows. This is a one-way upgrade path, never a fallback a NEW
 *    attempt can reach.
 *
 * Phase 26D: a row that carries a snapshot is served and graded from that
 * snapshot, so a later Question Bank edit cannot rewrite history. A row without
 * one (pre-26D attempt) still reads the live question — unchanged behaviour for
 * unchanged data.
 *
 * Questions deleted from the bank after attempt creation disappear from the set
 * together with their (cascade-deleted) answer rows; new questions never join an
 * existing attempt.
 */
export async function loadAttemptQuestionSet(
  attemptId: string,
  schoolType: SchoolType | null
): Promise<AttemptQuestion[]> {
  const rows = await db.quizAnswer.findMany({
    where: { attemptId },
    include: { question: true },
  });
  if (rows.length > 0) {
    const mapped = rows.map((r) => {
      const snapshot = questionFromSnapshot(r);
      return {
        answerId: r.id as string | null,
        questionId: r.questionId,
        selected: r.selected,
        isCorrect: r.isCorrect === true,
        snapshotted: snapshot !== null,
        question: snapshot ?? r.question,
        // Frozen presentation order when the attempt has one.
        orderIndex: typeof r.orderIndex === "number" ? r.orderIndex : null,
      };
    });

    // Phase 12 track gate: an attempt opened before this hardening may hold an
    // answer row for a question this student must not see. Dropping it here
    // means it is neither served nor graded — the frozen set stays
    // authoritative, it is only ever narrowed.
    const eligible = mapped.filter((e) =>
      isQuestionEligible(schoolType, e.question.schoolType)
    );

    // Phase 26D: an attempt frozen by the selector has an explicit order
    // (`orderIndex`); honour it, because that is the order the student saw and
    // the order a reviewer must see. Legacy attempts have no orderIndex and
    // keep the historical creation-order sort.
    if (eligible.every((e) => e.orderIndex !== null)) {
      eligible.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
    } else {
      eligible.sort(
        (a, b) =>
          a.question.createdAt.getTime() - b.question.createdAt.getTime() ||
          (a.question.id < b.question.id ? -1 : a.question.id > b.question.id ? 1 : 0)
      );
    }

    return eligible.map(({ orderIndex: _drop, ...entry }) => entry);
  }

  // Pre-Phase-5 in-flight attempt: adopt the live quiz questions (read-only).
  const quiz = await db.quizAttempt.findUnique({
    where: { id: attemptId },
    select: {
      quiz: { select: { questions: { orderBy: [...QUIZ_QUESTION_ORDER] } } },
    },
  });
  return (quiz?.quiz.questions ?? [])
    .filter((q) => isQuestionEligible(schoolType, q.schoolType))
    .map((q) => ({
      answerId: null,
      questionId: q.id,
      selected: "",
      isCorrect: false,
      snapshotted: false,
      question: q,
    }));
}

/**
 * The track-eligible questions of a quiz, read live from the bank.
 *
 * Phase 26D NOTE — this is no longer on any student write path. It used to back
 * the "submit with no open attempt creates a fresh one" retake route, and that
 * route is gone: an attempt now has to be STARTED (which freezes a snapshot and
 * consumes the entitlement) before it can be submitted. Kept because it is a
 * useful read for staff/preview surfaces and because the Phase 12 track suite
 * asserts its filtering directly. It applies exactly the same predicate
 * `selectAttemptQuestions` uses.
 */
export async function loadQuizQuestionSet(
  quizId: string,
  schoolType: SchoolType | null
): Promise<AttemptQuestion[]> {
  const questions = await db.question.findMany({
    where: { quizId, ...eligibleQuestionFilter(schoolType) },
    orderBy: [...QUIZ_QUESTION_ORDER],
  });
  return questions.map((q) => ({
    answerId: null,
    questionId: q.id,
    selected: "",
    isCorrect: false,
    snapshotted: false,
    question: q,
  }));
}

// ---------------------------------------------------------------------------
// Attempt state machine (Phase 26D)
// ---------------------------------------------------------------------------
//
// THE RULE, in one sentence: a student gets ONE attempt per Lesson Quiz unless
// an Admin has issued them an unconsumed retry grant.
//
// Why it is enforced here and not in the route: the start route, the submit
// route and any future preview surface must all agree on what "may this student
// start another attempt" means. Before this phase the answer was implicit —
// "is there an attempt with finishedAt = null?" — and the submit route simply
// CREATED a new attempt when there wasn't, which is what made unlimited retakes
// possible through a single POST with no start at all.
//
// STATES
//   OPEN      finishedAt IS NULL. Resumable. Exactly one per (quiz, student).
//   SUBMITTED finishedAt set by a normal submit. Terminal.
//   EXPIRED   finishedAt set by the Phase 18 timeout path. Terminal.
//
// `finishedAt` remains the historical source of truth; `status` is the
// queryable projection the migration backfilled from it.

export type AttemptStatus = "OPEN" | "SUBMITTED" | "EXPIRED";

/**
 * Decide what a START request may do. Pure given its inputs, so the whole
 * entitlement rule is testable without a database.
 *
 * @param attempts      every attempt this student holds on this quiz
 * @param maxAttempts   the quiz's ceiling (blueprint), >= 1
 * @param pendingGrants unconsumed Admin retry grants for this student+quiz
 */
export function decideAttemptStart(opts: {
  attempts: ReadonlyArray<{ id: string; finishedAt: Date | null }>;
  maxAttempts: number;
  pendingGrants: number;
}):
  | { kind: "resume"; attemptId: string }
  | { kind: "create"; attemptNumber: number }
  | { kind: "denied"; code: "ATTEMPT_LIMIT_REACHED"; attemptsUsed: number; maxAttempts: number } {
  const { attempts, pendingGrants } = opts;
  const maxAttempts = Math.max(1, Math.trunc(opts.maxAttempts) || 1);

  // 1. An OPEN attempt is always resumed — refresh, remount, reconnect,
  //    logout/login and browser restart all land here, never on a new row.
  const open = attempts.find((a) => a.finishedAt === null);
  if (open) return { kind: "resume", attemptId: open.id };

  const attemptsUsed = attempts.length;

  // 2. No attempt yet → the first one is always allowed.
  if (attemptsUsed === 0) return { kind: "create", attemptNumber: 1 };

  // 3. Already at the ceiling → only an Admin grant opens another attempt.
  if (attemptsUsed >= maxAttempts) {
    if (pendingGrants > 0) {
      return { kind: "create", attemptNumber: attemptsUsed + 1 };
    }
    return { kind: "denied", code: "ATTEMPT_LIMIT_REACHED", attemptsUsed, maxAttempts };
  }

  // 4. Below the ceiling (a quiz configured with maxAttempts > 1) → allowed.
  return { kind: "create", attemptNumber: attemptsUsed + 1 };
}

/**
 * The question ids this student has already seen on this quiz.
 *
 * Fed to the selector so a retry prefers fresh questions. Reads every attempt's
 * frozen rows — including OPEN ones, so an abandoned attempt still counts as
 * "seen" and cannot be farmed for an easier draw.
 */
export async function loadStudentSeenQuestionIds(
  quizId: string,
  studentId: string
): Promise<string[]> {
  const attempts = await db.quizAttempt.findMany({
    where: { quizId, studentId },
    select: { id: true },
  });
  if (attempts.length === 0) return [];
  const rows = await db.quizAnswer.findMany({
    where: { attemptId: { in: attempts.map((a) => a.id) } },
    select: { questionId: true },
  });
  return [...new Set(rows.map((r) => r.questionId))];
}

// ---------------------------------------------------------------------------
// Server-side time limit (Phase 18)
// ---------------------------------------------------------------------------
//
// THE VERDICT ON `Quiz.timeLimit`
// ===============================
// Phase 18 was asked to resolve a field that existed, was shown in the admin
// and teacher UI, was accepted by the create API — and gated nothing. It is
// now ENFORCED SERVER-SIDE. The alternative (removing it from the contract)
// was rejected because the column is already stored on real rows, displayed in
// two admin surfaces, and a time limit is a genuine assessment control.
//
// THE PRECISE SEMANTICS
// ---------------------
//   * START TIME is `QuizAttempt.startedAt`, written by the SERVER at attempt
//     creation (`/api/quizzes/[id]/start`). It is never taken from the client,
//     never refreshed on resume, and never rewritten — so reconnecting,
//     refreshing or resuming cannot extend an attempt.
//   * DEADLINE = `startedAt + timeLimit minutes + TIME_LIMIT_GRACE_SECONDS`.
//     The grace window is a fixed, documented allowance for the submit request
//     travelling over the network; without it a student who presses Submit at
//     0:01 remaining would be marked late by latency alone. The client NEVER
//     computes the deadline — it renders the server's number.
//   * TIMEOUT is evaluated from the SERVER's clock at the moment the request is
//     handled. A client clock, a frozen timer, a replayed tab or a crafted
//     `expiresAt` field cannot move it.
//   * `timeLimit = null` (every quiz that existed before this phase) means NO
//     LIMIT: nothing about those attempts changes.
//   * A late submit is REFUSED (409 `TIME_LIMIT_EXCEEDED`) and the expired
//     attempt is finalised at the deadline with the answers the server already
//     holds — which, because the frozen set is seeded unanswered and only
//     written on submit, is the empty set. That is what "the time ran out"
//     means; it is not a silently accepted late answer. The attempt is
//     finished, so the Phase 4 progression rule ("a finished attempt exists")
//     is satisfied exactly as an immediate empty submit would satisfy it —
//     no new unlock path is created, and no student is wedged with an attempt
//     that can never be submitted.
//   * RESUME of an already-expired attempt finalises it too and opens a FRESH
//     attempt (a new clock). Time is therefore never silently banked, and the
//     answers of the abandoned attempt are not carried over.

/** Fixed grace window granted to a submit request past the deadline (seconds). */
export const TIME_LIMIT_GRACE_SECONDS = 30;

export type TimeLimitState = {
  /** False when the quiz has no usable limit (`null`, 0 or non-finite). */
  limited: boolean;
  /** Server-computed deadline (startedAt + limit + grace), or null. */
  deadline: Date | null;
  /** True when `now` is at or past `deadline`. */
  expired: boolean;
  /** Whole seconds left, floored at 0. `null` when unlimited. */
  remainingSeconds: number | null;
};

/** Normalise a stored `Quiz.timeLimit` (minutes) into a usable limit or null. */
export function normalizeTimeLimitMinutes(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const minutes = Math.trunc(n);
  if (minutes <= 0) return null; // 0 / negative = "no limit", never "instant"
  return minutes;
}

/**
 * The server-side state of a timed attempt. Pure and clock-injectable, so the
 * enforcement path is unit-testable without waiting a minute.
 */
export function timeLimitState(
  startedAt: Date | string | null | undefined,
  timeLimitMinutes: unknown,
  now: Date = new Date()
): TimeLimitState {
  const minutes = normalizeTimeLimitMinutes(timeLimitMinutes);
  if (minutes === null || !startedAt) {
    return { limited: false, deadline: null, expired: false, remainingSeconds: null };
  }
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const startMs = start.getTime();
  if (!Number.isFinite(startMs)) {
    return { limited: false, deadline: null, expired: false, remainingSeconds: null };
  }
  const deadlineMs = startMs + minutes * 60_000 + TIME_LIMIT_GRACE_SECONDS * 1000;
  const deadline = new Date(deadlineMs);
  const nowMs = now.getTime();
  return {
    limited: true,
    deadline,
    expired: nowMs >= deadlineMs,
    remainingSeconds: Math.max(0, Math.floor((deadlineMs - nowMs) / 1000)),
  };
}

/**
 * Truthy when the attempt must be treated as timed out. Kept separate so a
 * route can call it without destructuring, and so the negative case (no limit)
 * reads as an explicit decision rather than a missing branch.
 */
export function isAttemptExpired(
  startedAt: Date | string | null | undefined,
  timeLimitMinutes: unknown,
  now: Date = new Date()
): boolean {
  return timeLimitState(startedAt, timeLimitMinutes, now).expired === true;
}

/**
 * Grade the frozen rows an expired attempt already holds.
 *
 * Used ONLY by the timeout path: the frozen set is seeded with empty
 * selections, so an attempt that timed out before submitting grades to zero —
 * deterministically, from persisted rows, with no client value involved.
 * Questions ineligible for the student's track are dropped by
 * `gradeAttemptQuestionSet`, so the denominator matches a normal submit.
 */
export function gradeExpiredAttempt(
  set: AttemptQuestion[],
  passMark: number,
  schoolType: SchoolType | null
) {
  return gradeAttemptQuestionSet(
    set,
    set.map((q) => ({ questionId: q.questionId, selected: q.selected })),
    passMark,
    schoolType
  );
}

// ---------------------------------------------------------------------------
// Server-side grading
// ---------------------------------------------------------------------------

/** A submitted answer as accepted from the client (values are NOT trusted). */
export type SubmittedAnswer = { questionId: string; selected: unknown };

/**
 * Normalise a submitted answer for storage/grading. Option answers are option
 * INDEXES ("0".."n"), so anything longer than a few characters is garbage —
 * bound it so a crafted payload cannot store an unbounded blob.
 */
export function sanitizeSelectedInput(raw: unknown): string {
  if (typeof raw === "number" && Number.isInteger(raw)) return String(raw);
  if (typeof raw !== "string") return "";
  return raw.length > 16 ? "" : raw;
}

/** One graded question of an attempt (result/review payload after submit). */
export type GradedAttemptQuestion = {
  questionId: string;
  selected: string;
  isCorrect: boolean;
  correctAnswer: string;
  marks: number;
  prompt: string;
  promptAr: string | null;
  options: string[];
  explanation: string | null;
};

export type GradedAttempt = {
  graded: GradedAttemptQuestion[];
  score: number;
  totalMarks: number;
  percentage: number;
  passed: boolean;
};

/**
 * Grade an attempt's question set against submitted answers.
 *
 * Server-authoritative: iterates the ATTEMPT's questions (never the client's
 * list), loads the correct answer from the question row, compares the
 * sanitised selected value, and sums marks. Submitted answers for questions
 * outside the attempt are ignored; a question submitted twice keeps the FIRST
 * occurrence (the pre-Phase-5 semantics). No score/percentage/correctness
 * value from the client is ever read.
 */
export function gradeAttemptQuestionSet(
  set: AttemptQuestion[],
  submittedAnswers: SubmittedAnswer[],
  passMark: number,
  schoolType: SchoolType | null = null
): GradedAttempt {
  // First occurrence per questionId wins, mirroring the historical
  // `answersRaw.find(...)` semantics.
  const selectedByQuestion = new Map<string, string>();
  for (const a of submittedAnswers) {
    if (typeof a?.questionId !== "string") continue;
    if (!selectedByQuestion.has(a.questionId)) {
      selectedByQuestion.set(a.questionId, sanitizeSelectedInput(a.selected));
    }
  }

  // Phase 12 — GRADING enforces the track rule independently of selection.
  // An ineligible question is removed from the set BEFORE any arithmetic, so
  // it contributes neither to `totalMarks` nor to `score`: it can never
  // receive credit, and it can never inflate or deflate the denominator.
  // `schoolType` defaults to null (SHARED-only) on purpose — a caller that
  // forgets to pass it grades the narrowest set, never the widest.
  // Questions with no school type are SHARED and always eligible.
  const eligibleSet = set.filter((entry) =>
    isQuestionEligible(schoolType, entry.question.schoolType)
  );

  let score = 0;
  let totalMarks = 0;
  const graded: GradedAttemptQuestion[] = eligibleSet.map((entry) => {
    const q = entry.question;
    totalMarks += q.marks;
    const selected = selectedByQuestion.get(q.id) ?? "";
    const isCorrect = selected === q.answer;
    if (isCorrect) score += q.marks;
    return {
      questionId: q.id,
      selected,
      isCorrect,
      correctAnswer: q.answer,
      marks: q.marks,
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: safeParseOptions(q.options),
      explanation: q.explanation,
    };
  });

  const percentage =
    totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;
  return { graded, score, totalMarks, percentage, passed: percentage >= passMark };
}

/** Parse a question's JSON options, never throwing on malformed legacy data. */
export function safeParseOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((o) => String(o)) : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Attempt inspection (Phase 26D)
// ---------------------------------------------------------------------------
//
// One payload builder for every inspection surface — Admin, Teacher and the
// student's own history — so the three cannot drift apart on what an attempt
// record means, and so the answer-key rule is decided in exactly one place.
//
// ANSWER-KEY RULE
//   `correctAnswer` is included ONLY for a TERMINAL attempt. An OPEN attempt is
//   a running assessment: exposing its key to any surface would let a student
//   who can reach an inspection endpoint finish the paper from the answer side.
//   Staff surfaces therefore see the key for finished attempts (which is what
//   review is for) and never for a live one.

export type AttemptInspection = {
  id: string;
  quizId: string;
  studentId: string;
  attemptNumber: number;
  status: string;
  startedAt: Date;
  finishedAt: Date | null;
  score: number;
  totalMarks: number;
  percentage: number;
  passed: boolean;
  /** Admin grant that permitted this attempt, with its lineage. */
  retryGrant: {
    id: string;
    grantedAt: Date;
    grantedByUserId: string;
    grantedByName: string | null;
    consumedAt: Date | null;
    reason: string | null;
  } | null;
  /** True when the answer key is present. False for an OPEN attempt. */
  answerKeyRevealed: boolean;
  questions: Array<{
    questionId: string;
    prompt: string;
    promptAr: string | null;
    options: string[];
    selected: string;
    isCorrect: boolean;
    marks: number;
    difficulty: string;
    /** Present only for a terminal attempt. */
    correctAnswer: string | undefined;
    explanation: string | null;
    /** True when this row carries the Phase 26D frozen snapshot. */
    snapshotted: boolean;
  }>;
};

/**
 * Build the full inspection record of one attempt.
 *
 * Reads the attempt's FROZEN set, so what an inspector sees is what the student
 * was actually asked — including for attempts whose questions were later edited
 * in the bank.
 *
 * @param revealAnswerKey caller's decision, but forced OFF for an OPEN attempt.
 */
export async function buildAttemptInspection(
  attempt: {
    id: string;
    quizId: string;
    studentId: string;
    attemptNumber: number;
    status: string;
    startedAt: Date;
    finishedAt: Date | null;
    score: number;
    totalMarks: number;
    percentage: number;
    passed: boolean;
    retryGrantId: string | null;
  },
  opts: { schoolType?: SchoolType | null; revealAnswerKey?: boolean } = {}
): Promise<AttemptInspection> {
  const schoolType = opts.schoolType ?? null;
  const set = await loadAttemptQuestionSet(attempt.id, schoolType);

  // An OPEN attempt never carries its key, whatever the caller asked for.
  const terminal = attempt.finishedAt !== null;
  const reveal = terminal && opts.revealAnswerKey !== false;

  let retryGrant: AttemptInspection["retryGrant"] = null;
  if (attempt.retryGrantId) {
    const grant = await db.quizRetryGrant.findUnique({
      where: { id: attempt.retryGrantId },
      select: {
        id: true,
        grantedAt: true,
        grantedByUserId: true,
        consumedAt: true,
        reason: true,
        grantedBy: { select: { name: true } },
      },
    });
    if (grant) {
      retryGrant = {
        id: grant.id,
        grantedAt: grant.grantedAt,
        grantedByUserId: grant.grantedByUserId,
        grantedByName: grant.grantedBy?.name ?? null,
        consumedAt: grant.consumedAt,
        reason: grant.reason,
      };
    }
  }

  return {
    id: attempt.id,
    quizId: attempt.quizId,
    studentId: attempt.studentId,
    attemptNumber: attempt.attemptNumber,
    status: attempt.status,
    startedAt: attempt.startedAt,
    finishedAt: attempt.finishedAt,
    score: attempt.score,
    totalMarks: attempt.totalMarks,
    percentage: attempt.percentage,
    passed: attempt.passed,
    retryGrant,
    answerKeyRevealed: reveal,
    questions: set.map((entry) => ({
      questionId: entry.questionId,
      prompt: entry.question.prompt,
      promptAr: entry.question.promptAr,
      options: safeParseOptions(entry.question.options),
      selected: entry.selected,
      isCorrect: entry.isCorrect ?? false,
      marks: entry.question.marks,
      difficulty: entry.question.difficulty,
      correctAnswer: reveal ? entry.question.answer : undefined,
      explanation: reveal ? entry.question.explanation : null,
      snapshotted: entry.snapshotted,
    })),
  };
}
