// CodeMind Academy — Phase H: the CANONICAL progression REQUIREMENT matrix.
//
// WHY THIS FILE EXISTS AND WHAT IT IS NOT
// =======================================
// Phase H's audit found the academic rule matrix (what makes a Lesson
// COMPLETE) spread across readers: `session-progress.ts` computed
// video/quiz/homework satisfaction inline, `progress.ts` recomputed a video
// percentage for dashboards, the lesson page and the course tree rendered
// their own "requirements" shapes, and the parent dashboard counted
// completed/unlocked sessions from the engine but named no reason at all.
//
// This module is the ONE place that turns FACTS into a VERDICT. It is PURE:
// no database, no request, no clock (a `now` is only ever passed in by the
// caller), no i18n side effects. That is what makes the 38 Phase H cases
// testable offline and what makes every reader provably agree.
//
// It is deliberately NOT a progression engine: it does not know what a
// course, a track, an enrollment or a lesson order is. It answers one
// question — given the facts of a Lesson for a student, is that Lesson
// COMPLETED, and if not, WHY (in a stable, translatable vocabulary)?
//
// THE RULES (approved product decisions, Phase H)
// ===============================================
//   1. VIDEO      — a required video is satisfied at >= 95% of SERVER-tracked
//                   watch progress. A client claiming "95%" is never trusted:
//                   the only writers of that number are the heartbeat routes,
//                   which credit real elapsed wall-clock time.
//   2. QUIZ       — a published required quiz is satisfied by a PASS
//                   (`QuizAttempt.passed`), never by merely starting or
//                   submitting it. Attempts, retries, freezing and grading stay
//                   owned by the Phase 26D / Phase G authorities — this module
//                   only READS their verdict.
//   3. HOMEWORK   — a published homework is satisfied by a SUBMISSION
//                   (`HomeworkSubmission.submittedAt`). Grading is irrelevant
//                   to progression (marks/feedback stay assessment data).
//   4. ATTENDANCE — is never a completion signal. It reaches progression only
//                   through the Phase F AbsenceHold, which is a BOUNDARY
//                   (forward-progression) fact, never a lesson requirement.
//   5. A component that does not exist is NOT a requirement: a Lesson with no
//                   quiz can never be blocked by a quiz.
//
// THE VOCABULARY
// ==============
// Student surfaces must never see a raw DB enum, an internal id or the word
// "LOCKED" alone. Every verdict therefore carries:
//   * `state`     — LOCKED | UNLOCKED | COMPLETED (the preserved Phase 4 model)
//   * `unmet`     — stable machine codes, ordered by what to do FIRST
//   * `labelKey`  — the Arabic-first i18n key for the human sentence
// Nothing here returns English technical prose to a student.

/** Minimum watched share of a REQUIRED video before it counts as complete. */
export const VIDEO_COMPLETION_THRESHOLD = 95;

// ---------------------------------------------------------------------------
// States (preserved from Phase 4 — no parallel state machine)
// ---------------------------------------------------------------------------

export const PROGRESSION_STATES = ["LOCKED", "UNLOCKED", "COMPLETED"] as const;
export type ProgressionState = (typeof PROGRESSION_STATES)[number];

export function isProgressionState(value: unknown): value is ProgressionState {
  return (
    typeof value === "string" &&
    (PROGRESSION_STATES as readonly string[]).includes(value)
  );
}

// ---------------------------------------------------------------------------
// Unmet-requirement codes
// ---------------------------------------------------------------------------

/**
 * The stable internal vocabulary of "why is this not open / not complete".
 *
 *   ABSENCE_HOLD     a Phase F hold blocks FORWARD progression (never the
 *                    Lesson itself — see `progression-holds.ts`)
 *   PREVIOUS_LESSON  the previous Lesson in the sequence is not COMPLETE
 *   VIDEO            a required video is below the threshold
 *   QUIZ             a required quiz has not been PASSED
 *   HOMEWORK         a required homework has not been SUBMITTED
 */
export const UNMET_CODES = [
  "ABSENCE_HOLD",
  "PREVIOUS_LESSON",
  "VIDEO",
  "QUIZ",
  "HOMEWORK",
] as const;
export type UnmetCode = (typeof UNMET_CODES)[number];

export function isUnmetCode(value: unknown): value is UnmetCode {
  return typeof value === "string" && (UNMET_CODES as readonly string[]).includes(value);
}

/**
 * What to do FIRST. A hold outranks everything (its catch-up path is the only
 * way forward), then the previous session, then the lesson's own components in
 * the order the workspace renders them.
 */
export const UNMET_PRIORITY: readonly UnmetCode[] = [
  "ABSENCE_HOLD",
  "PREVIOUS_LESSON",
  "VIDEO",
  "QUIZ",
  "HOMEWORK",
];

/** The Arabic-first dictionary key of each code's student-facing sentence. */
export const UNMET_LABEL_KEYS: Readonly<Record<UnmetCode, string>> = {
  ABSENCE_HOLD: "progression.reason.hold",
  PREVIOUS_LESSON: "progression.reason.previous",
  VIDEO: "progression.reason.video",
  QUIZ: "progression.reason.quiz",
  HOMEWORK: "progression.reason.homework",
};

/** The short chip label (one or two words) shown inside a checklist row. */
export const UNMET_SHORT_KEYS: Readonly<Record<UnmetCode, string>> = {
  ABSENCE_HOLD: "progression.unmet.hold",
  PREVIOUS_LESSON: "progression.unmet.previous",
  VIDEO: "progression.unmet.video",
  QUIZ: "progression.unmet.quiz",
  HOMEWORK: "progression.unmet.homework",
};

/** "What exact action resolves this?" — the sentence under a blocked card. */
export const UNMET_ACTION_KEYS: Readonly<Record<UnmetCode, string>> = {
  ABSENCE_HOLD: "progression.action.hold",
  PREVIOUS_LESSON: "progression.action.previous",
  VIDEO: "progression.action.video",
  QUIZ: "progression.action.quiz",
  HOMEWORK: "progression.action.homework",
};

/** Sort unmet codes into the order a student must act on them. */
export function orderUnmet(codes: readonly UnmetCode[]): UnmetCode[] {
  const set = new Set(codes.filter(isUnmetCode));
  return UNMET_PRIORITY.filter((c) => set.has(c));
}

/** The single most important unmet code (null when nothing is outstanding). */
export function primaryUnmet(codes: readonly UnmetCode[]): UnmetCode | null {
  return orderUnmet(codes)[0] ?? null;
}

// ---------------------------------------------------------------------------
// Facts (everything the engine loaded; nothing here touches the database)
// ---------------------------------------------------------------------------

/** Where a lesson's required video comes from (see `progression-engine.ts`). */
export type VideoRequirementSource = "NONE" | "LEGACY" | "MODERN";

export type VideoRequirementFacts = {
  /** True only when the lesson actually carries a video this student must watch. */
  required: boolean;
  done: boolean;
  /** 0-100, server-tracked. 0 when nothing has been watched. */
  percent: number;
  /** The row's own threshold (`SessionVideo.requiredPercent`, default 95). */
  threshold: number;
  source: VideoRequirementSource;
  /** How many distinct videos this requirement covers (0 when not required). */
  count: number;
  /** How many of them are already satisfied (0..count). */
  completedCount: number;
};

export type QuizRequirementFacts = {
  required: boolean;
  done: boolean;
  /** PUBLISHED, track-eligible quizzes of this lesson. */
  requiredCount: number;
  /** Of those, how many the student has PASSED. */
  passedCount: number;
  /** How many the student merely attempted (submitted) — never enough alone. */
  attemptedCount: number;
  /** Best percentage across attempts, for "you scored 40%, pass mark 60%". */
  bestPercent: number | null;
  /** The strictest pass mark among the required quizzes (null when none). */
  passMark: number | null;
};

export type HomeworkRequirementFacts = {
  required: boolean;
  done: boolean;
  /** PUBLISHED/CLOSED, track-eligible homework of this lesson. */
  requiredCount: number;
  submittedCount: number;
  /** Graded count — reported to humans, NEVER required for progression. */
  gradedCount: number;
};

export type RequirementFacts = {
  video: VideoRequirementFacts;
  quiz: QuizRequirementFacts;
  homework: HomeworkRequirementFacts;
};

export function emptyVideoFacts(): VideoRequirementFacts {
  return {
    required: false,
    done: true,
    percent: 0,
    threshold: VIDEO_COMPLETION_THRESHOLD,
    source: "NONE",
    count: 0,
    completedCount: 0,
  };
}

export function emptyQuizFacts(): QuizRequirementFacts {
  return {
    required: false,
    done: true,
    requiredCount: 0,
    passedCount: 0,
    attemptedCount: 0,
    bestPercent: null,
    passMark: null,
  };
}

export function emptyHomeworkFacts(): HomeworkRequirementFacts {
  return { required: false, done: true, requiredCount: 0, submittedCount: 0, gradedCount: 0 };
}

export function emptyFacts(): RequirementFacts {
  return { video: emptyVideoFacts(), quiz: emptyQuizFacts(), homework: emptyHomeworkFacts() };
}

// ---------------------------------------------------------------------------
// The matrix
// ---------------------------------------------------------------------------

/**
 * Is a required video satisfied?
 *
 * `>= threshold`, never `> threshold`: 95 is the documented bar and a student
 * who reached exactly 95% has watched the video. `done` (the persisted
 * `videoCompleted` flag) is accepted as well, because it is written by the
 * same server-side heartbeat that owns the percentage — but the percentage is
 * always evaluated FIRST so a stale/absent flag can never hide real progress.
 */
export function isVideoSatisfied(video: VideoRequirementFacts): boolean {
  if (!video.required) return true;
  if (video.percent >= video.threshold) return true;
  return video.done === true;
}

/** A required quiz is satisfied only by a PASS (never by an attempt). */
export function isQuizSatisfied(quiz: QuizRequirementFacts): boolean {
  if (!quiz.required) return true;
  return quiz.passedCount >= quiz.requiredCount;
}

/** A required homework is satisfied by a SUBMISSION (grading is irrelevant). */
export function isHomeworkSatisfied(homework: HomeworkRequirementFacts): boolean {
  if (!homework.required) return true;
  return homework.submittedCount >= homework.requiredCount;
}

export type RequirementEvaluation = {
  /** Every REQUIRED component is satisfied — the Lesson is academically done. */
  completed: boolean;
  /** Stable codes, ordered by priority. Empty when completed. */
  unmet: UnmetCode[];
  /** Per-component verdict, so the UI can render a checklist without a second rule. */
  done: { video: boolean; quiz: boolean; homework: boolean };
};

/**
 * THE rule matrix. Pure, total and deterministic: the same facts always
 * produce the same verdict, which is what makes repeated/concurrent
 * evaluation idempotent (Phase H cases 32/33).
 */
export function evaluateRequirements(facts: RequirementFacts): RequirementEvaluation {
  const videoDone = isVideoSatisfied(facts.video);
  const quizDone = isQuizSatisfied(facts.quiz);
  const homeworkDone = isHomeworkSatisfied(facts.homework);

  const unmet: UnmetCode[] = [];
  if (facts.video.required && !videoDone) unmet.push("VIDEO");
  if (facts.quiz.required && !quizDone) unmet.push("QUIZ");
  if (facts.homework.required && !homeworkDone) unmet.push("HOMEWORK");

  return {
    completed: unmet.length === 0,
    unmet: orderUnmet(unmet),
    done: { video: videoDone, quiz: quizDone, homework: homeworkDone },
  };
}

/**
 * The state of a Lesson.
 *
 *   COMPLETED — every requirement that exists is satisfied (a Lesson with no
 *               requirements is COMPLETE the moment it is reachable, so an
 *               empty session can never lock a student forever).
 *   LOCKED    — the progression BOUNDARY refuses this Lesson: the previous one
 *               is incomplete, or an active AbsenceHold blocks forward
 *               progression, and no valid Admin override covers it.
 *   UNLOCKED  — reachable and not finished.
 *
 * `boundaryAllowed` is computed by the engine (previous-lesson completion +
 * hold boundary + admin override); this function only names the result.
 */
export function stateFor(input: {
  completed: boolean;
  boundaryAllowed: boolean;
}): ProgressionState {
  if (!input.boundaryAllowed) return "LOCKED";
  return input.completed ? "COMPLETED" : "UNLOCKED";
}

/**
 * The two Phase-4 booleans every pre-Phase-H reader already consumed.
 *
 * They are NOT a projection of `state`, and the difference is deliberate:
 *
 *   `completed` is ACADEMIC — "every requirement that exists is satisfied".
 *                 It does not ask whether the lesson is reachable, because
 *                 Phase 4 never did: `getCourseSessionProgress` computed
 *                 `videoDone && quizDone && assignmentDone` and set
 *                 `unlocked` from the PREVIOUS row independently. A locked
 *                 lesson that has nothing left to do therefore stays
 *                 `completed: true`, exactly as it always was, so no
 *                 dashboard, parent report or certificate sees its
 *                 completion numbers move because of Phase H.
 *
 *   `unlocked`   is the BOUNDARY — "may the student open this lesson".
 *
 * The three-state `state` is the richer Phase H view that renders the lock
 * reason; a completed lesson behind a boundary reports `LOCKED` there while
 * keeping `completed: true` here.
 */
export function legacyFlags(input: {
  completed: boolean;
  boundaryAllowed: boolean;
}): {
  completed: boolean;
  unlocked: boolean;
} {
  return { completed: input.completed, unlocked: input.boundaryAllowed };
}

// ---------------------------------------------------------------------------
// Catch-up (the absence-hold recovery vocabulary)
// ---------------------------------------------------------------------------

/**
 * The catch-up requirements of a held Lesson.
 *
 * Deliberately derived from the SAME matrix as normal progression: only
 * requirements that ACTUALLY EXIST are listed (a lesson with no quiz never
 * asks the student to pass a quiz). Attendance is not in here — the student
 * resolves an absence by completing the missed Lesson's academic content.
 */
export function catchUpRequirements(facts: RequirementFacts): UnmetCode[] {
  return evaluateRequirements(facts).unmet;
}

export function isCatchUpSatisfied(facts: RequirementFacts): boolean {
  return evaluateRequirements(facts).completed;
}
