// CodeMind Academy — Quiz Results & Teacher Analytics core (Phase 6).
//
// Pure, deterministic aggregation helpers for the teacher analytics surface.
// Every function here is FREE OF SIDE EFFECTS and DB access: it reduces arrays
// of already-loaded, authoritative records (finished `QuizAttempt`s and the
// persisted `QuizAnswer` rows of those attempts) to the summary numbers the
// teacher dashboards display. Keeping the arithmetic pure and DB-free makes it
// (a) unit-testable offline in the same style as `tests/session-quiz.test.js`,
// and (b) impossible to make a reporting route accidentally mutate assessment
// state — these helpers only read.
//
// The phase-6 aggregation rules are explicit and documented:
//
//   * ONLY FINISHED attempts are counted. An open/in-flight attempt
//     (`finishedAt = null`) has not been graded and must never pull an
//     average or a pass rate down. Unfinished attempts are excluded upstream
//     by the caller (a `finishedAt: { not: null }` filter) and these helpers
//     also defensively ignore any row that slips through.
//   * AVERAGES AND PASS RATES ARE OVER FINISHED ATTEMPTS, not over students.
//     Every finished attempt is one data point, so a student who retakes a
//     quiz three times contributes three points. This is the deterministic,
//     transparent rule the analytics document records; it is not "one best
//     score per student".
//   * The percentage and passed booleans used are the values SERVER-GRADED at
//     submit time and stored on the `QuizAttempt` row (the authoritative
//     result, Phase 5). A quiz with a different `passMark` therefore already
//     reflects its own pass boundary in the stored `passed` flag — no client
//     value, no client re-derivation, no per-quiz passMark guesswork here.
//   * Difficulty and question analytics are derived from the persisted
//     `QuizAnswer` rows of finished attempts, keyed to the question actually
//     answered. Difficulty comes from the question's CURRENT metadata row
//     (there is no per-answer snapshot of difficulty). If a question was
//     deleted after the attempt, its `QuizAnswer` rows were cascade-deleted,
//     so it no longer appears in difficulty/question analytics — the same
//     semantics the Phase 5 attempt-set uses. If it was EDITED, historical
//     answers keep their correctness and are aggregated under the current
//     difficulty.
//   * Aggregation never writes. `QuizAttempt`, `QuizAnswer`, `Question` and
//     `LessonProgress` are only read here.
//
// These helpers deliberately know nothing about curriculum chains, course
// ownership or authorization. The CALLER is responsible for feeding them only
// attempts that are (a) within the teacher's authorized scope and (b) finished.
// That keeps "who may see what" (authorization) separate from "what do the
// numbers mean" (arithmetic).

// ---------------------------------------------------------------------------
// Finished-attempt filtering
// ---------------------------------------------------------------------------

/** The slice of a QuizAttempt the aggregation needs. Structural subset of the
 * Prisma row so callers can pass a full row or a projection. */
export type AttemptDatum = {
  quizId: string;
  studentId: string;
  score: number;
  totalMarks: number;
  percentage: number;
  passed: boolean;
  finishedAt: Date | null;
};

export function isFinishedAttempt(a: AttemptDatum): boolean {
  return a.finishedAt !== null;
}

/** Keep only graded (finished) attempts. Defensive even though callers filter
 * in SQL — a stray open attempt must never corrupt an aggregate. */
export function finishedAttempts(a: AttemptDatum[]): AttemptDatum[] {
  return a.filter(isFinishedAttempt);
}

// ---------------------------------------------------------------------------
// Quiz / session / course level summary (over finished attempts)
// ---------------------------------------------------------------------------

export type AttemptSummary = {
  /** Finished attempts that passed the attempt-filter above. */
  attemptCount: number;
  /** Finished attempts whose stored `passed` is true. */
  passCount: number;
  /** passCount / attemptCount, 0-100, rounded. 0 when there are no attempts. */
  passRate: number;
  /** Mean stored percentage over finished attempts, rounded. 0 when none. */
  avgPercentage: number;
  /** Mean stored score over finished attempts, rounded. 0 when none. */
  avgScore: number;
  /** Distinct students among the finished attempts. */
  participantCount: number;
  /** Highest stored percentage of a finished attempt. 0 when none. */
  bestPercentage: number;
  /** Stored percentage of the most recently finished attempt. 0 when none. */
  latestPercentage: number;
};

function round(n: number): number {
  return Math.round(n);
}

/**
 * Summarise a set of finished attempts. See module header for the aggregation
 * rules. Unfinished rows are ignored defensively.
 */
export function summarizeFinishedAttempts(
  raw: AttemptDatum[]
): AttemptSummary {
  const attempts = finishedAttempts(raw);
  const n = attempts.length;
  if (n === 0) {
    return {
      attemptCount: 0,
      passCount: 0,
      passRate: 0,
      avgPercentage: 0,
      avgScore: 0,
      participantCount: 0,
      bestPercentage: 0,
      latestPercentage: 0,
    };
  }

  let percentageSum = 0;
  let scoreSum = 0;
  let passCount = 0;
  let best = Number.NEGATIVE_INFINITY;
  let latestPercentage = 0;
  let latestFinishedAt: number = Number.NEGATIVE_INFINITY;
  const students = new Set<string>();
  for (const a of attempts) {
    percentageSum += a.percentage;
    scoreSum += a.score;
    if (a.passed) passCount += 1;
    if (a.percentage > best) best = a.percentage;
    students.add(a.studentId);
    const t = a.finishedAt ? new Date(a.finishedAt).getTime() : Number.NEGATIVE_INFINITY;
    if (t >= latestFinishedAt) {
      latestFinishedAt = t;
      latestPercentage = a.percentage;
    }
  }

  return {
    attemptCount: n,
    passCount,
    passRate: round((passCount / n) * 100),
    avgPercentage: round(percentageSum / n),
    avgScore: round(scoreSum / n),
    participantCount: students.size,
    bestPercentage: best === Number.NEGATIVE_INFINITY ? 0 : best,
    latestPercentage,
  };
}

// ---------------------------------------------------------------------------
// Difficulty analytics
// ---------------------------------------------------------------------------

export type Difficulty = "EASY" | "MEDIUM" | "HARD";

/** One persisted answer of a finished attempt, flattened with the difficulty
 * of the question it references. */
export type AnswerDatum = {
  questionId: string;
  isCorrect: boolean;
  difficulty: Difficulty;
};

export const DIFFICULTIES: Difficulty[] = ["EASY", "MEDIUM", "HARD"];

export type DifficultySlice = {
  difficulty: Difficulty;
  attempts: number;
  correct: number;
  incorrect: number;
  /** correct / attempts, 0-100 rounded. 0 when the slice has no attempts. */
  correctPercent: number;
};

/**
 * Group persisted answers of finished attempts by the difficulty of the
 * question answered. Every difficulty key is always present (stable shape),
 * with zeroed counts when there are no answers of that difficulty.
 */
export function difficultyBreakdown(
  answers: AnswerDatum[]
): Record<Difficulty, DifficultySlice> {
  const acc: Record<Difficulty, DifficultySlice> = {
    EASY: { difficulty: "EASY", attempts: 0, correct: 0, incorrect: 0, correctPercent: 0 },
    MEDIUM: { difficulty: "MEDIUM", attempts: 0, correct: 0, incorrect: 0, correctPercent: 0 },
    HARD: { difficulty: "HARD", attempts: 0, correct: 0, incorrect: 0, correctPercent: 0 },
  };
  for (const a of answers) {
    const slice = acc[a.difficulty];
    if (!slice) continue; // defensive: unknown difficulty ignored
    slice.attempts += 1;
    if (a.isCorrect) slice.correct += 1;
    else slice.incorrect += 1;
  }
  for (const d of DIFFICULTIES) {
    const s = acc[d];
    s.correctPercent =
      s.attempts > 0 ? round((s.correct / s.attempts) * 100) : 0;
  }
  return acc;
}

/** Ordered difficulty list (EASY → MEDIUM → HARD) for stable rendering. */
export function difficultyBreakdownList(
  answers: AnswerDatum[]
): DifficultySlice[] {
  const map = difficultyBreakdown(answers);
  return DIFFICULTIES.map((d) => map[d]);
}

// ---------------------------------------------------------------------------
// Question-level analytics (weak questions)
// ---------------------------------------------------------------------------

export type QuestionSlice = {
  questionId: string;
  difficulty: Difficulty;
  attempts: number;
  correct: number;
  incorrect: number;
  /** correct / attempts, 0-100 rounded. 0 when no answers. */
  correctPercent: number;
};

/**
 * Group persisted answers of finished attempts by question. Aggregated across
 * every finished attempt that included the question (a question retaken in a
 * later attempt contributes one point per finished attempt).
 */
export function questionPerformance(answers: AnswerDatum[]): QuestionSlice[] {
  const byQuestion = new Map<string, QuestionSlice>();
  for (const a of answers) {
    let row = byQuestion.get(a.questionId);
    if (!row) {
      row = {
        questionId: a.questionId,
        difficulty: a.difficulty,
        attempts: 0,
        correct: 0,
        incorrect: 0,
        correctPercent: 0,
      };
      byQuestion.set(a.questionId, row);
    }
    row.attempts += 1;
    if (a.isCorrect) row.correct += 1;
    else row.incorrect += 1;
  }
  for (const row of byQuestion.values()) {
    row.correctPercent =
      row.attempts > 0 ? round((row.correct / row.attempts) * 100) : 0;
  }
  return Array.from(byQuestion.values());
}

/**
 * Weak-question ranking: LOWEST correctness first, ties broken by most
 * attempts first (a frequently-missed question is more actionable), then by
 * question id for a deterministic total order. Only questions with at least
 * `minAttempts` are considered, so a single unlucky answer on an otherwise
 * un-attempted question does not top the list.
 */
export function weakestQuestions(
  performance: QuestionSlice[],
  minAttempts = 1,
  limit?: number
): QuestionSlice[] {
  const candidates = performance.filter((p) => p.attempts >= minAttempts);
  candidates.sort((a, b) => {
    if (a.correctPercent !== b.correctPercent)
      return a.correctPercent - b.correctPercent;
    if (a.attempts !== b.attempts) return b.attempts - a.attempts;
    return a.questionId < b.questionId ? -1 : a.questionId > b.questionId ? 1 : 0;
  });
  return limit !== undefined ? candidates.slice(0, limit) : candidates;
}

// ---------------------------------------------------------------------------
// Authorized-scope helper
// ---------------------------------------------------------------------------

/**
 * True when an attempt belongs to one of the `quizIds` a caller has already
 * resolved as authorized for a teacher. Callers must NOT pass an unbounded set
 * they do not own — see the module header. Pure so it is unit-testable.
 */
export function attemptInQuizScope(
  a: Pick<AttemptDatum, "quizId">,
  authorizedQuizIds: Set<string>
): boolean {
  return authorizedQuizIds.has(a.quizId);
}

// ---------------------------------------------------------------------------
// Track-safe reporting primitives (Phase 12)
// ---------------------------------------------------------------------------
//
// MINIMAL BY DESIGN. Phase 12 must not redesign the analytics UI, so nothing
// above changes: attempt-weighting, the finished-only rule and the
// question-performance ordering are all exactly as Phase 6 defined them. These
// helpers only make it possible to CUT an existing aggregate by track, and
// they do it by RE-USING `summarizeFinishedAttempts` rather than by adding a
// second arithmetic path — so a track-split number can never disagree with the
// overall number it was split from.
//
// Like the rest of this module they are pure and DB-free: the caller decides
// which rows are in scope, these functions only group and reduce them.

import {
  TRACK_SCOPES,
  normalizeTrackScope,
  type TrackScope,
} from "@/lib/track-scope";

/** The three buckets a track-aware report can have, in display order. */
export const TRACK_BUCKETS: readonly TrackScope[] = TRACK_SCOPES;

/**
 * The track bucket a row belongs to.
 *
 * `null`/`undefined` is SHARED: that is the stored representation of a shared
 * question (a convention that predates Phase 12 and is relied on by the
 * mock-exam bank isolation). An UNRECOGNISED non-null value is also reported
 * as SHARED here — deliberately different from authorization, which fails
 * closed. A report must never silently drop a row, and bucketing is not an
 * access decision; the row is still visible, just labelled.
 */
export function trackBucketOf(value: unknown): TrackScope {
  return normalizeTrackScope(value) ?? "SHARED";
}

/** Group any rows into the three track buckets. Always returns all three keys. */
export function partitionByTrack<T>(
  items: readonly T[],
  getTrack: (item: T) => unknown
): Record<TrackScope, T[]> {
  const out: Record<TrackScope, T[]> = { SHARED: [], ARABIC: [], LANGUAGE: [] };
  for (const item of items) out[trackBucketOf(getTrack(item))].push(item);
  return out;
}

/**
 * The Phase 6 attempt summary, split by track.
 *
 * The same `summarizeFinishedAttempts` is applied to each bucket, so the
 * finished-only rule and the per-attempt weighting hold inside every bucket.
 * Buckets are not additive by student (a student has exactly one track, but an
 * attempt set may span quizzes of different scopes) — that is why the split is
 * returned per bucket rather than being summed back here.
 */
export function summarizeFinishedAttemptsByTrack<T extends AttemptDatum>(
  attempts: readonly T[],
  getTrack: (attempt: T) => unknown
): Record<TrackScope, AttemptSummary> {
  const buckets = partitionByTrack(attempts, getTrack);
  return {
    SHARED: summarizeFinishedAttempts(buckets.SHARED),
    ARABIC: summarizeFinishedAttempts(buckets.ARABIC),
    LANGUAGE: summarizeFinishedAttempts(buckets.LANGUAGE),
  };
}
