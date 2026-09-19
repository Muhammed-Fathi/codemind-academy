// CodeMind Academy — Phase G: Quiz lifecycle authority.
//
// THE ONE PLACE that answers, for the Phase G operational workflow:
//
//   * which lifecycle states a quiz has (`DRAFT` | `PUBLISHED`),
//   * whether a stored quiz is structurally valid ENOUGH TO PUBLISH,
//   * whether the question blueprint is LOCKED (first attempt exists).
//
// Everything here REUSES the Phase 26D authority — the same question
// validator, blueprint resolver and selection service the live attempt path
// uses — so a publish verdict can never disagree with what a student would
// actually receive.

import { db } from "@/lib/db";
import {
  BlueprintUnsatisfiableError,
  resolveQuizBlueprint,
  selectAttemptQuestions,
  type QuizBlueprint,
} from "@/lib/quiz-blueprint";
import {
  validateQuestionDraft,
  questionValidationMessage,
  type QuestionValidationReason,
} from "@/lib/teacher-content";
import { isQuestionEligible } from "@/lib/track-scope";
import type { SchoolType } from "@/lib/school-type";

/** Quiz lifecycle states — stored as TEXT on `Quiz.status`. */
export const QUIZ_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export type QuizStatus = (typeof QUIZ_STATUSES)[number];

export function isQuizStatus(value: unknown): value is QuizStatus {
  return typeof value === "string" && (QUIZ_STATUSES as readonly string[]).includes(value);
}

/** The tracks a quiz serves — SHARED serves both school types. */
export function quizServedTracks(trackScope: unknown): SchoolType[] {
  return String(trackScope ?? "SHARED").toUpperCase() === "ARABIC"
    ? ["ARABIC"]
    : String(trackScope ?? "SHARED").toUpperCase() === "LANGUAGE"
      ? ["LANGUAGE"]
      : ["ARABIC", "LANGUAGE"];
}

/** A structural problem that blocks publishing (machine code + position). */
export type QuizPublishProblem = {
  code:
    | "NO_QUESTIONS"
    | "INVALID_QUESTION"
    | "INVALID_BLUEPRINT"
    | "TRACK_EMPTY"
    | "BLUEPRINT_UNSATISFIABLE";
  /** 1-based question index for INVALID_QUESTION, else null. */
  questionIndex: number | null;
  /** The validation reason code (for localization by the caller). */
  reason?: QuestionValidationReason | string;
  /** Track affected for TRACK_EMPTY / BLUEPRINT_UNSATISFIABLE. */
  track?: SchoolType;
};

export type QuizPublishValidation =
  | { ok: true }
  | { ok: false; problems: QuizPublishProblem[] };

/** The minimal quiz row the validator needs. */
export type PublishableQuizRow = {
  quizMode?: unknown;
  questionCount?: unknown;
  difficultyPlan?: unknown;
  shuffleOptions?: unknown;
  maxAttempts?: unknown;
  trackScope?: unknown;
};

/** A stored question row the validator re-checks. */
export type StoredQuestionForPublish = {
  type: unknown;
  prompt: unknown;
  promptAr?: unknown;
  options: unknown;
  answer: unknown;
  explanation?: unknown;
  difficulty?: unknown;
  marks?: unknown;
  schoolType?: unknown;
};

function safeOptions(raw: unknown): string[] {
  try {
    const parsed = JSON.parse(String(raw ?? "[]"));
    return Array.isArray(parsed) ? parsed.map((o) => String(o)) : [];
  } catch {
    return [];
  }
}

/**
 * May this quiz become PUBLISHED?
 *
 * The SAME authority the write routes and the attempt path use:
 *   1. every stored question must pass `validateQuestionDraft` against its own
 *      stored values (a broken legacy row can never be published);
 *   2. the stored blueprint must resolve to a valid selection rule;
 *   3. for EVERY track the quiz serves, the eligible pool must be able to
 *      honour the blueprint — a DRY RUN of `selectAttemptQuestions` with an
 *      injectable RNG (BLUEPRINT mode), or a non-empty eligible set (FIXED).
 *
 * Pure: reads nothing, writes nothing. Publish routes call it with rows they
 * loaded inside their authorization scope.
 */
export function validateQuizForPublish(opts: {
  quiz: PublishableQuizRow;
  questions: readonly StoredQuestionForPublish[];
}): QuizPublishValidation {
  const problems: QuizPublishProblem[] = [];

  if (opts.questions.length === 0) {
    problems.push({ code: "NO_QUESTIONS", questionIndex: null });
    return { ok: false, problems };
  }

  // 1. Structural re-validation of every stored question.
  const blueprint = resolveQuizBlueprint(opts.quiz);
  opts.questions.forEach((q, i) => {
    const draft = validateQuestionDraft(
      {
        type: q.type,
        prompt: q.prompt,
        promptAr: q.promptAr,
        options: safeOptions(q.options),
        answer: q.answer,
        explanation: q.explanation,
        difficulty: q.difficulty,
        marks: q.marks,
        // Re-validate the stored tag verbatim — containment is re-checked
        // below against the quiz scope, exactly like the write routes.
        schoolType: q.schoolType === null ? null : q.schoolType,
      },
      opts.quiz.trackScope
    );
    if (!draft.ok) {
      problems.push({
        code: "INVALID_QUESTION",
        questionIndex: i + 1,
        reason: draft.reason,
      });
    }
  });

  // 2. Blueprint sanity — the resolver degrades gracefully, so the stored
  //    columns are re-validated through the authoring contract instead.
  if (
    Number.isFinite(Number(opts.quiz.maxAttempts)) &&
    (Number(opts.quiz.maxAttempts) < 1 || Number(opts.quiz.maxAttempts) > 10)
  ) {
    problems.push({ code: "INVALID_BLUEPRINT", questionIndex: null, reason: "MAX_ATTEMPTS_RANGE" });
  }

  // 3. Per-track satisfiability — a dry run of the live selection service.
  if (problems.length === 0) {
    const pool = opts.questions.map((q, i) => ({
      // Unique synthetic ids: selection deduplicates by id; the real ids are
      // irrelevant to a structural dry run.
      id: `publish-check-${i}`,
      type: String(q.type ?? "MCQ"),
      prompt: String(q.prompt ?? ""),
      promptAr: typeof q.promptAr === "string" ? q.promptAr : null,
      options: typeof q.options === "string" ? q.options : "[]",
      answer: String(q.answer ?? "0"),
      explanation: typeof q.explanation === "string" ? q.explanation : null,
      difficulty: String(q.difficulty ?? "MEDIUM"),
      marks: Number(q.marks ?? 1),
      schoolType: (q.schoolType ?? null) as string | null,
    }));

    for (const track of quizServedTracks(opts.quiz.trackScope)) {
      const eligible = pool.filter((q) => isQuestionEligible(track, q.schoolType));
      if (eligible.length === 0) {
        problems.push({ code: "TRACK_EMPTY", questionIndex: null, track });
        continue;
      }
      if (blueprint.mode === "BLUEPRINT") {
        try {
          selectAttemptQuestions({
            pool,
            blueprint,
            schoolType: track,
            random: mulberry32(1), // deterministic dry run — never persisted
          });
        } catch (e) {
          if (e instanceof BlueprintUnsatisfiableError) {
            problems.push({
              code: "BLUEPRINT_UNSATISFIABLE",
              questionIndex: null,
              reason: e.detail.reason,
              track,
            });
          } else {
            throw e;
          }
        }
      }
    }
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

/** Localized text for one publish problem (server-side messages). */
export function publishProblemMessage(
  t: (key: string, params?: Record<string, unknown>) => string,
  problem: QuizPublishProblem
): string {
  switch (problem.code) {
    case "NO_QUESTIONS":
      return t("api.341");
    case "INVALID_QUESTION":
      return questionValidationMessage(
        t,
        (problem.reason ?? "PROMPT_REQUIRED") as QuestionValidationReason,
        problem.questionIndex ?? 1
      );
    case "INVALID_BLUEPRINT":
      return t("api.288");
    case "TRACK_EMPTY":
      return t("api.342", { p1: problem.track === "ARABIC" ? t("api.343") : t("api.344") });
    case "BLUEPRINT_UNSATISFIABLE":
      return t("api.342", { p1: problem.track === "ARABIC" ? t("api.343") : t("api.344") });
  }
}

/** Deterministic RNG for dry-run selection (never persisted, never returned). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Blueprint lock — "once the first attempt exists, the blueprint is immutable"
// ---------------------------------------------------------------------------

/**
 * Does the quiz have ANY attempt? The Phase G lock predicate.
 *
 * `client` may be a transaction handle: the lock is RACE-SAFE only when the
 * caller acquires `acquireQuizDestructiveLock` FIRST inside the same
 * transaction (the identical lock `POST /api/quizzes/[id]/start` takes before
 * freezing an attempt), then calls this. See the question mutation routes.
 */
export async function quizHasAttempts(
  quizId: string,
  client: Pick<typeof db, "quizAttempt"> = db
): Promise<boolean> {
  const attempts = await client.quizAttempt.findMany({
    where: { quizId },
    select: { id: true },
    take: 1,
  });
  return attempts.length > 0;
}
