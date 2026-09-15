// CodeMind Academy — Lesson Quiz BLUEPRINT + question selection (Phase 26D).
//
// THE ONE PLACE that decides which questions an attempt covers.
//
// Before Phase 26D a Lesson Quiz *was* its question list: `seedAttemptQuestions`
// froze every track-eligible question of the quiz into every attempt, in
// creation order, for every student, forever. There was no count, no difficulty
// rule, and no variation between students or between a student's attempts.
//
// This module replaces that with an explicit SELECTION RULE ("blueprint") stored
// on the `Quiz` row, and a single selection function that every caller — the
// student start route, an Admin-granted retry, a teacher preview, an admin
// preview — must go through. Duplicating selection across those surfaces is how
// a platform ends up serving one set to students and grading another.
//
// HARD INVARIANTS
//   * The client NEVER chooses question ids. Nothing here reads a request body;
//     the inputs are the quiz row, the student's own school type, the ids that
//     student already saw, and a random source.
//   * Selection is TRACK-SAFE: the pool is filtered through the same
//     `isQuestionEligible` predicate that serving and grading use, so a
//     wrong-track question cannot enter an attempt (Phase 12 contract, now
//     enforced at the earliest possible moment).
//   * Selection FAILS LOUDLY. If the pool cannot satisfy the blueprint the
//     caller gets a typed `BlueprintUnsatisfiableError` and the attempt is never
//     created — a silently short quiz would quietly change the assessment.
//   * Randomness is INJECTABLE (`random`), so tests can pin an exact selection
//     while production uses `Math.random`. No seed is ever persisted or returned
//     to a client.

import { isQuestionEligible } from "@/lib/track-scope";
import type { SchoolType } from "@/lib/school-type";

// ---------------------------------------------------------------------------
// Blueprint shape
// ---------------------------------------------------------------------------

/** `FIXED` = the pre-26D behaviour. `BLUEPRINT` = server-selected per attempt. */
export type QuizMode = "FIXED" | "BLUEPRINT";

export type DifficultyKey = "EASY" | "MEDIUM" | "HARD";

export const DIFFICULTY_KEYS: readonly DifficultyKey[] = [
  "EASY",
  "MEDIUM",
  "HARD",
] as const;

/** Per-difficulty quota. A missing key means "no quota for that difficulty". */
export type DifficultyPlan = Partial<Record<DifficultyKey, number>>;

/**
 * The normalised selection rule of a quiz. Produced ONLY by
 * `resolveQuizBlueprint`, so no caller can hand-roll a divergent reading of the
 * five stored columns.
 */
export type QuizBlueprint = {
  mode: QuizMode;
  /** Requested question count. `null` = every eligible question. */
  questionCount: number | null;
  /** Per-difficulty quota, or `null` when unconstrained. */
  difficultyPlan: DifficultyPlan | null;
  /** Shuffle answer choices at freeze time (snapshot keeps the order stable). */
  shuffleOptions: boolean;
  /** Attempt ceiling for one student. Admin grants raise it case by case. */
  maxAttempts: number;
};

/** The stored columns `resolveQuizBlueprint` reads. */
export type BlueprintSource = {
  quizMode?: unknown;
  questionCount?: unknown;
  difficultyPlan?: unknown;
  shuffleOptions?: unknown;
  maxAttempts?: unknown;
};

/** Bounds shared by the authoring API and the tests. */
export const BLUEPRINT_LIMITS = {
  QUESTION_COUNT_MIN: 1,
  QUESTION_COUNT_MAX: 100,
  MAX_ATTEMPTS_MIN: 1,
  MAX_ATTEMPTS_MAX: 10,
  PLAN_VALUE_MAX: 100,
} as const;

function toPositiveIntOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const i = Math.trunc(n);
  return i > 0 ? i : null;
}

/** Parse a stored/JSON difficulty plan into a quota map, or null. */
export function parseDifficultyPlan(raw: unknown): DifficultyPlan | null {
  if (raw === null || raw === undefined || raw === "") return null;
  let obj: unknown = raw;
  if (typeof raw === "string") {
    try {
      obj = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return null;
  const plan: DifficultyPlan = {};
  let any = false;
  for (const key of DIFFICULTY_KEYS) {
    const v = (obj as Record<string, unknown>)[key];
    if (v === undefined || v === null) continue;
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    const i = Math.max(0, Math.trunc(n));
    if (i > 0) {
      plan[key] = i;
      any = true;
    }
  }
  return any ? plan : null;
}

/** Total questions a difficulty plan demands. */
export function difficultyPlanTotal(plan: DifficultyPlan | null): number {
  if (!plan) return 0;
  return DIFFICULTY_KEYS.reduce((sum, k) => sum + (plan[k] ?? 0), 0);
}

/**
 * The single authoritative reading of a quiz's blueprint columns.
 *
 * A pre-26D row (`FIXED` / null / 1 / false / null) resolves to "take every
 * eligible question, one attempt" — which is the behaviour that row always had,
 * with the attempt ceiling now enforced. Unknown/legacy values degrade to FIXED
 * rather than throwing, so a stray value can never take a quiz offline.
 */
export function resolveQuizBlueprint(source: BlueprintSource): QuizBlueprint {
  const mode: QuizMode = source.quizMode === "BLUEPRINT" ? "BLUEPRINT" : "FIXED";
  const questionCount = toPositiveIntOrNull(source.questionCount);
  const maxAttemptsRaw = toPositiveIntOrNull(source.maxAttempts);
  const maxAttempts =
    maxAttemptsRaw === null
      ? 1
      : Math.min(maxAttemptsRaw, BLUEPRINT_LIMITS.MAX_ATTEMPTS_MAX);
  return {
    mode,
    // A count only means something in BLUEPRINT mode; FIXED keeps serving the
    // whole eligible set, exactly as it did before this phase.
    questionCount: mode === "BLUEPRINT" ? questionCount : null,
    difficultyPlan: mode === "BLUEPRINT" ? parseDifficultyPlan(source.difficultyPlan) : null,
    shuffleOptions: source.shuffleOptions === true,
    maxAttempts,
  };
}

// ---------------------------------------------------------------------------
// Authoring validation
// ---------------------------------------------------------------------------

export type BlueprintValidationReason =
  | "MODE"
  | "QUESTION_COUNT_RANGE"
  | "MAX_ATTEMPTS_RANGE"
  | "PLAN_SHAPE"
  | "PLAN_EXCEEDS_COUNT";

export type BlueprintValidation =
  | { ok: true; blueprint: QuizBlueprint }
  | { ok: false; reason: BlueprintValidationReason };

/**
 * Validate an author-supplied blueprint patch.
 *
 * `current` is the quiz's existing blueprint, so a PATCH that supplies only one
 * field keeps the others. Deliberately validates SHAPE, not whether today's pool
 * can satisfy the plan — a teacher must be able to write the rule before the
 * last question exists. Satisfiability is enforced at SELECTION time, where it
 * can be decided honestly against the real pool.
 */
export function validateBlueprintInput(
  raw: Record<string, unknown>,
  current: QuizBlueprint
): BlueprintValidation {
  const next: QuizBlueprint = { ...current };

  if (raw.quizMode !== undefined) {
    if (raw.quizMode !== "FIXED" && raw.quizMode !== "BLUEPRINT") {
      return { ok: false, reason: "MODE" };
    }
    next.mode = raw.quizMode;
  }

  if (raw.questionCount !== undefined) {
    if (raw.questionCount === null || raw.questionCount === "") {
      next.questionCount = null;
    } else {
      const n = Number(raw.questionCount);
      if (
        !Number.isFinite(n) ||
        !Number.isInteger(n) ||
        n < BLUEPRINT_LIMITS.QUESTION_COUNT_MIN ||
        n > BLUEPRINT_LIMITS.QUESTION_COUNT_MAX
      ) {
        return { ok: false, reason: "QUESTION_COUNT_RANGE" };
      }
      next.questionCount = n;
    }
  }

  if (raw.maxAttempts !== undefined) {
    const n = Number(raw.maxAttempts);
    if (
      !Number.isFinite(n) ||
      !Number.isInteger(n) ||
      n < BLUEPRINT_LIMITS.MAX_ATTEMPTS_MIN ||
      n > BLUEPRINT_LIMITS.MAX_ATTEMPTS_MAX
    ) {
      return { ok: false, reason: "MAX_ATTEMPTS_RANGE" };
    }
    next.maxAttempts = n;
  }

  if (raw.shuffleOptions !== undefined) {
    next.shuffleOptions = raw.shuffleOptions === true;
  }

  if (raw.difficultyPlan !== undefined) {
    if (raw.difficultyPlan === null || raw.difficultyPlan === "") {
      next.difficultyPlan = null;
    } else {
      let obj: unknown = raw.difficultyPlan;
      if (typeof obj === "string") {
        try {
          obj = JSON.parse(obj);
        } catch {
          return { ok: false, reason: "PLAN_SHAPE" };
        }
      }
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
        return { ok: false, reason: "PLAN_SHAPE" };
      }
      const plan: DifficultyPlan = {};
      for (const key of DIFFICULTY_KEYS) {
        const v = (obj as Record<string, unknown>)[key];
        if (v === undefined || v === null) continue;
        const n = Number(v);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
          return { ok: false, reason: "PLAN_SHAPE" };
        }
        if (n > BLUEPRINT_LIMITS.PLAN_VALUE_MAX) {
          return { ok: false, reason: "PLAN_SHAPE" };
        }
        if (n > 0) plan[key] = n;
      }
      // Unknown keys are rejected rather than silently dropped: a plan spelling
      // "Hard" instead of "HARD" must not become an unconstrained quiz.
      for (const key of Object.keys(obj as Record<string, unknown>)) {
        if (!(DIFFICULTY_KEYS as readonly string[]).includes(key)) {
          return { ok: false, reason: "PLAN_SHAPE" };
        }
      }
      next.difficultyPlan = Object.keys(plan).length ? plan : null;
    }
  }

  // Cross-field: a plan can never demand more questions than the quiz asks for.
  const total = difficultyPlanTotal(next.difficultyPlan);
  if (next.questionCount !== null && total > next.questionCount) {
    return { ok: false, reason: "PLAN_EXCEEDS_COUNT" };
  }

  return { ok: true, blueprint: next };
}

/** Serialise a blueprint for storage in the quiz's five columns. */
export function blueprintToStorage(blueprint: QuizBlueprint): {
  quizMode: string;
  questionCount: number | null;
  difficultyPlan: string | null;
  shuffleOptions: boolean;
  maxAttempts: number;
} {
  return {
    quizMode: blueprint.mode,
    questionCount: blueprint.mode === "BLUEPRINT" ? blueprint.questionCount : null,
    difficultyPlan:
      blueprint.mode === "BLUEPRINT" && blueprint.difficultyPlan
        ? JSON.stringify(blueprint.difficultyPlan)
        : null,
    shuffleOptions: blueprint.shuffleOptions,
    maxAttempts: blueprint.maxAttempts,
  };
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/** The question fields selection needs — a subset of the `Question` row. */
export type PoolQuestion = {
  id: string;
  type: string;
  prompt: string;
  promptAr: string | null;
  options: string;
  answer: string;
  explanation: string | null;
  difficulty: string;
  marks: number;
  schoolType: string | null;
  createdAt?: Date | string | null;
};

/** Thrown when the pool cannot honour the blueprint. Never swallowed. */
export class BlueprintUnsatisfiableError extends Error {
  readonly code = "BLUEPRINT_UNSATISFIABLE" as const;
  constructor(
    readonly detail: {
      reason: "POOL_TOO_SMALL" | "DIFFICULTY_SHORT";
      requested: number;
      available: number;
      difficulty?: DifficultyKey;
      needed?: number;
    }
  ) {
    super(
      detail.reason === "DIFFICULTY_SHORT"
        ? `Question pool cannot satisfy the difficulty plan: needed ${detail.needed} ${detail.difficulty}, have ${detail.available}`
        : `Question pool too small: requested ${detail.requested}, have ${detail.available}`
    );
    this.name = "BlueprintUnsatisfiableError";
  }
}

/** What the selection actually did — surfaced to staff surfaces, never scored. */
export type SelectionDiagnostics = {
  mode: QuizMode;
  /** Questions attached to the quiz before the track filter. */
  poolSize: number;
  /** Track-eligible questions actually selectable. */
  eligibleSize: number;
  /** Questions the blueprint asked for. */
  requested: number;
  /** How many were handed out. */
  selected: number;
  /** Distinct question ids this student had already seen on this quiz. */
  previousUsed: number;
  /** Selected questions that this student had already seen. */
  overlap: number;
  /** True when every unused eligible question was preferred over a used one. */
  minimizedOverlap: boolean;
  difficultyPlan: DifficultyPlan | null;
};

export type SelectionResult = {
  /** The frozen set, already in the order this attempt will present it. */
  questions: PoolQuestion[];
  diagnostics: SelectionDiagnostics;
};

/** Fisher–Yates with an injectable source; returns a NEW array. */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

/** Deterministic creation order (id tie-break) — the legacy FIXED order. */
function byCreation(a: PoolQuestion, b: PoolQuestion): number {
  const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
  const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function normalizeDifficulty(value: unknown): DifficultyKey {
  return value === "EASY" || value === "HARD" ? value : "MEDIUM";
}

/**
 * Take up to `need` questions, UNUSED ones first.
 *
 * This is the whole variation strategy: a student's new attempt is built from
 * questions they have not seen before, and only reaches into the already-seen
 * set when the pool is too small to avoid it. Order inside each tier is random,
 * so two students with identical histories still get different papers.
 */
function pickPreferringUnused(
  candidates: readonly PoolQuestion[],
  need: number,
  used: ReadonlySet<string>,
  random: () => number
): PoolQuestion[] {
  if (need <= 0) return [];
  const pool = shuffled(candidates, random);
  const fresh: PoolQuestion[] = [];
  const seen: PoolQuestion[] = [];
  for (const q of pool) {
    (used.has(q.id) ? seen : fresh).push(q);
  }
  return fresh.slice(0, need).concat(seen.slice(0, Math.max(0, need - fresh.length)));
}

/**
 * THE selection service. Every attempt-start path calls this and nothing else.
 *
 * @param pool              the quiz's questions, read live from the bank
 * @param blueprint         `resolveQuizBlueprint(quiz)`
 * @param schoolType        the STUDENT's own school type (never from a request)
 * @param previouslyUsedIds question ids this student already saw on this quiz
 * @param random            injectable RNG; defaults to `Math.random`
 *
 * @throws BlueprintUnsatisfiableError when the eligible pool cannot honour the
 *         requested count or a difficulty quota.
 */
export function selectAttemptQuestions(opts: {
  pool: readonly PoolQuestion[];
  blueprint: QuizBlueprint;
  schoolType: SchoolType | null;
  previouslyUsedIds?: readonly string[];
  random?: () => number;
}): SelectionResult {
  const { pool, blueprint, schoolType } = opts;
  const random = opts.random ?? Math.random;
  const used = new Set(opts.previouslyUsedIds ?? []);

  // Track gate FIRST: an ineligible question must not be counted as available,
  // or a blueprint would "succeed" by promising questions the student may not
  // see and then short-change them.
  const eligible = pool.filter((q) => isQuestionEligible(schoolType, q.schoolType));

  const baseDiagnostics = {
    mode: blueprint.mode,
    poolSize: pool.length,
    eligibleSize: eligible.length,
    previousUsed: used.size,
    difficultyPlan: blueprint.difficultyPlan,
  };

  // ---- FIXED: the legacy contract, unchanged -----------------------------
  if (blueprint.mode === "FIXED") {
    const ordered = eligible.slice().sort(byCreation);
    const overlap = ordered.filter((q) => used.has(q.id)).length;
    return {
      questions: ordered,
      diagnostics: {
        ...baseDiagnostics,
        requested: ordered.length,
        selected: ordered.length,
        overlap,
        minimizedOverlap: true,
      },
    };
  }

  // ---- BLUEPRINT: count + difficulty plan, unused-first ------------------
  const requested = blueprint.questionCount ?? eligible.length;
  if (requested <= 0) {
    throw new BlueprintUnsatisfiableError({
      reason: "POOL_TOO_SMALL",
      requested: 1,
      available: eligible.length,
    });
  }

  const chosen: PoolQuestion[] = [];
  const chosenIds = new Set<string>();

  // 1. Difficulty quotas, hardest constraint first.
  const plan = blueprint.difficultyPlan;
  if (plan) {
    for (const key of DIFFICULTY_KEYS) {
      const need = plan[key] ?? 0;
      if (need <= 0) continue;
      const candidates = eligible.filter(
        (q) => normalizeDifficulty(q.difficulty) === key && !chosenIds.has(q.id)
      );
      if (candidates.length < need) {
        throw new BlueprintUnsatisfiableError({
          reason: "DIFFICULTY_SHORT",
          requested,
          available: eligible.length,
          difficulty: key,
          needed: need,
        });
      }
      for (const q of pickPreferringUnused(candidates, need, used, random)) {
        if (chosenIds.has(q.id)) continue;
        chosenIds.add(q.id);
        chosen.push(q);
      }
    }
  }

  // 2. Fill the remainder from any difficulty, still unused-first.
  if (chosen.length < requested) {
    const rest = eligible.filter((q) => !chosenIds.has(q.id));
    for (const q of pickPreferringUnused(rest, requested - chosen.length, used, random)) {
      if (chosen.length >= requested) break;
      if (chosenIds.has(q.id)) continue;
      chosenIds.add(q.id);
      chosen.push(q);
    }
  }

  if (chosen.length < requested) {
    throw new BlueprintUnsatisfiableError({
      reason: "POOL_TOO_SMALL",
      requested,
      available: eligible.length,
    });
  }

  // 3. Freeze the presentation order. Randomised so two attempts differ in
  //    ORDER as well as content even when the pool forces the same questions.
  const ordered = shuffled(chosen.slice(0, requested), random);
  const overlap = ordered.filter((q) => used.has(q.id)).length;
  const freshAvailable = eligible.filter((q) => !used.has(q.id)).length;

  return {
    questions: ordered,
    diagnostics: {
      ...baseDiagnostics,
      requested,
      selected: ordered.length,
      overlap,
      // Overlap is "minimized" when every question the student had not seen was
      // used before any repeat — i.e. the remaining overlap was forced by pool
      // size, not by the selector.
      minimizedOverlap: overlap <= Math.max(0, requested - freshAvailable),
    },
  };
}
