// CodeMind Academy — Phase H: THE CANONICAL PROGRESSION & ACCESS ENGINE.
//
// ONE AUTHORITY, MANY READERS
// ===========================
// This module is the single place that decides, for a student and a lesson:
//
//   * LOCKED / UNLOCKED / COMPLETED (the preserved Phase 4 state model)
//   * WHY — an Arabic-first, human-readable reason plus structured unmet
//     requirements (never a raw DB enum, never an internal id)
//   * what the completion EVIDENCE is (video %, quiz pass, homework submitted)
//   * whether the NEXT lesson may unlock
//   * which AbsenceHold (Phase F) applies and whether it blocks
//   * which Admin override (Phase H) is currently in force
//   * where the effective progression BOUNDARY is
//
// Every reader — student dashboard, course tree, lesson page, lesson
// navigation, direct lesson access, quiz/homework/media gates, parent
// progression readers, teacher/admin readers — consumes THIS module (or the
// `session-progress.ts` facade that delegates to it). No route or component
// re-implements the rule matrix.
//
// WHAT IT DELEGATES (and therefore never duplicates)
// ==================================================
//   curriculum universe + order  progression-universe.ts (Phases 4/11/12/13)
//   the requirement matrix       progression-requirements.ts (pure)
//   absence holds                progression-holds.ts  → Phase F rows
//   admin exceptions             progression-overrides.ts
//   enrollment + entitlement     enrollment.ts / subscription-entitlement.ts
//   track eligibility            track-scope.ts
//   lesson lifecycle             session-lifecycle.ts
//   quiz attempts/grading        the Phase 26D / Phase G quiz authorities
//   homework submissions         the Phase G homework authority
//
// SERVER AUTHORITY
// ================
// Nothing here trusts a client claim. Video completion is read from
// server-tracked watch rows; a quiz requirement is satisfied only by a stored
// PASS; a homework requirement only by a stored SUBMISSION; attendance never
// marks a lesson complete; and an Admin override is accepted only from a
// server-side ADMIN role check.
//
// DETERMINISM & IDEMPOTENCE
// =========================
// `evaluateCourseProgression` is a pure function of the rows it reads plus the
// `now` it is given: no writes, no counters, no lazily-expired mutations. Two
// evaluations of the same state (concurrent or repeated) agree byte for byte.

import { db } from "@/lib/db";
import {
  EXCLUDE_ARCHIVED_LESSON,
  LESSON_CHAIN_SELECT,
  loadCourseLessonUniverse,
  orderCourseLessons,
  resolveLessonCourseId,
  lessonCourseChainOr,
  type LessonChain,
  type UniverseLesson,
} from "@/lib/progression-universe";
import {
  UNMET_ACTION_KEYS,
  UNMET_LABEL_KEYS,
  UNMET_SHORT_KEYS,
  VIDEO_COMPLETION_THRESHOLD,
  emptyFacts,
  evaluateRequirements,
  legacyFlags,
  orderUnmet,
  primaryUnmet,
  stateFor,
  type HomeworkRequirementFacts,
  type ProgressionState,
  type QuizRequirementFacts,
  type RequirementFacts,
  type UnmetCode,
  type VideoRequirementFacts,
} from "@/lib/progression-requirements";
import {
  additiveDelegate,
  blockingBoundary,
  buildHoldBoundaries,
  loadStudentHolds,
  visibleHold,
  type HoldBoundary,
} from "@/lib/progression-holds";
import {
  findValidOverride,
  loadStudentOverrides,
  toOverrideView,
  type ProgressionOverrideRow,
  type ProgressionOverrideView,
} from "@/lib/progression-overrides";
import { LESSON_STUDENT_STATUS_FILTER, isStudentVisibleStatus } from "@/lib/session-lifecycle";
import { canAccessTrackScope } from "@/lib/track-scope";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";
import { evaluateAccessDecision } from "@/lib/subscription-entitlement";
import { getStudentSchoolType } from "@/lib/enrollment";

type Client = typeof db;

// ---------------------------------------------------------------------------
// Public shapes
// ---------------------------------------------------------------------------

export type RequirementCode = "VIDEO" | "QUIZ" | "HOMEWORK";

export type RequirementView = {
  required: boolean;
  done: boolean;
  /** 0-100 where meaningful (video), else 0/100. */
  value: number;
  /** The bar for this requirement (video threshold / quiz pass mark / 100). */
  threshold: number;
  /** Extra human context (e.g. how many of N quizzes were passed). */
  detail: { passed?: number; required?: number; submitted?: number; graded?: number } | null;
};

/**
 * One lesson's canonical verdict.
 *
 * `reason` / `unmet` carry i18n KEYS, never prose: the server translates them
 * with the request locale through `localizeProgression`, and Arabic is the
 * product default (a missing key never leaks `student.198` into the UI).
 */
export type LessonProgression = {
  lessonId: string;
  order: number;
  state: ProgressionState;
  completed: boolean;
  unlocked: boolean;
  /** Human-readable "why" — null when there is nothing to explain. */
  reason: { code: UnmetCode | "ADMIN_OVERRIDE"; labelKey: string } | null;
  /** Structured, stable, ordered: what has to happen next. */
  unmet: { code: UnmetCode; labelKey: string; shortKey: string; actionKey: string }[];
  requirements: {
    video: RequirementView;
    quiz: RequirementView;
    homework: RequirementView;
  };
  /** True when this lesson's own completion opens the NEXT lesson. */
  mayUnlockNext: boolean;
  /** The Admin exception currently in force for this lesson's boundary. */
  override: ProgressionOverrideView | null;
};

export type CatchUpView = {
  lessonId: string | null;
  satisfied: boolean;
  unmet: { code: UnmetCode; labelKey: string; shortKey: string; actionKey: string }[];
};

export type HoldView = {
  holdId: string;
  status: string;
  active: boolean;
  blocks: boolean;
  lessonId: string | null;
  sessionId: string;
  reviewStatus: string | null;
  catchUp: CatchUpView | null;
};

export type CourseProgression = {
  courseId: string;
  studentId: string;
  lessons: LessonProgression[];
  byLessonId: Map<string, LessonProgression>;
  /** The first lesson the student should work on. */
  currentLessonId: string | null;
  /** Where forward progression currently stops (null = nothing stops it). */
  boundary: {
    lessonId: string;
    reason: { code: UnmetCode | "ADMIN_OVERRIDE"; labelKey: string };
  } | null;
  /** The hold that decides the boundary, when there is one. */
  hold: HoldView | null;
  /** The hold worth showing to a human even when it is not the boundary. */
  activeHold: HoldView | null;
  /** Every override of this student that touches this course (history incl.). */
  overrides: ProgressionOverrideView[];
  catchUp: CatchUpView | null;
};

// ---------------------------------------------------------------------------
// Access verdicts (the vocabulary every gate already speaks)
// ---------------------------------------------------------------------------

export type AccessReason =
  | null
  | "NOT_ENROLLED"
  | "LESSON_NOT_FOUND"
  | "PREVIOUS_SESSION_INCOMPLETE";

export type LessonAccess = {
  allowed: boolean;
  reason: AccessReason;
  /** The canonical verdict — kept for the OWNER of the session only. */
  status: LessonProgression | null;
};

/**
 * Gating result for a resource hanging off a lesson (quiz, homework, media).
 * `status` is deliberately absent: it would tell a probing client which
 * components a locked session hides.
 */
export type ResourceAccess = {
  allowed: boolean;
  reason: AccessReason;
};

// ---------------------------------------------------------------------------
// Fact loading
// ---------------------------------------------------------------------------

type AttemptRow = { quizId: string; percentage: number; passed: boolean; finishedAt: Date | null };
type SubmissionRow = { homeworkId: string; submittedAt: Date | null; grade: number | null };

type LoadedFacts = {
  schoolType: ReturnType<typeof normalizeSchoolType>;
  progress: Map<string, { videoPercent: number; videoCompleted: boolean; isCompleted: boolean }>;
  attempts: Map<string, AttemptRow[]>;
  submissions: Map<string, SubmissionRow[]>;
};

/**
 * Load every fact the matrix needs for one course, in a FIXED number of
 * queries (no N+1), all scoped to the student.
 */
async function loadFacts(params: {
  studentId: string;
  lessons: readonly UniverseLesson[];
  schoolType: ReturnType<typeof normalizeSchoolType>;
  client: Client;
}): Promise<LoadedFacts> {
  const { client } = params;
  const lessonIds = params.lessons.map((l) => l.id);
  const quizIds = params.lessons.flatMap((l) => l.quizzes.map((q) => q.id));
  const homeworkIds = params.lessons.flatMap((l) => l.homeworks.map((h) => h.id));

  const [progressRows, attempts, submissions] = await Promise.all([
    lessonIds.length
      ? (client as any).lessonProgress.findMany({
          where: { studentId: params.studentId, lessonId: { in: lessonIds } },
          select: {
            lessonId: true,
            videoPercent: true,
            videoCompleted: true,
            isCompleted: true,
          },
        })
      : Promise.resolve([] as any[]),
    quizIds.length
      ? (client as any).quizAttempt.findMany({
          where: { studentId: params.studentId, quizId: { in: quizIds } },
          select: { quizId: true, percentage: true, passed: true, finishedAt: true },
        })
      : Promise.resolve([] as any[]),
    homeworkIds.length
      ? (client as any).homeworkSubmission.findMany({
          where: { studentId: params.studentId, homeworkId: { in: homeworkIds } },
          select: { homeworkId: true, submittedAt: true, grade: true },
        })
      : Promise.resolve([] as any[]),
  ]);

  const group = <T>(rows: T[], key: (row: T) => string): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      const k = key(row);
      const arr = map.get(k) ?? [];
      arr.push(row);
      map.set(k, arr);
    }
    return map;
  };

  return {
    schoolType: params.schoolType,
    progress: new Map(
      (progressRows ?? []).map((p: any) => [
        p.lessonId as string,
        {
          videoPercent: Number(p.videoPercent ?? 0),
          videoCompleted: Boolean(p.videoCompleted),
          isCompleted: Boolean(p.isCompleted),
        },
      ])
    ),
    attempts: group((attempts ?? []) as AttemptRow[], (a) => a.quizId),
    submissions: group((submissions ?? []) as SubmissionRow[], (s) => s.homeworkId),
  };
}

// ---------------------------------------------------------------------------
// Requirement builders (facts → the pure matrix's input)
// ---------------------------------------------------------------------------

/**
 * The lesson's REQUIRED video and how far the student has got.
 *
 * DISCOVERY RESULT (Phase H audit): the platform's authoritative
 * representation of "this lesson carries a video the student must watch" is
 * `Lesson.videoUrl` together with the SERVER-side heartbeat in
 * `LessonProgress` (`videoPercent` / `videoCompleted`). That pair is what every
 * pre-Phase-H reader — the engine, the dashboards, the certificate — already
 * meant, so no new "required video" model was introduced.
 *
 * Modern batch recordings (`SessionVideo` + `SessionVideoView`) were
 * deliberately NOT turned into a NEW progression requirement:
 *
 *   * a recording is PUBLISHED AFTER the session happened, so making it a
 *     requirement would RETROACTIVELY lock students who legitimately
 *     progressed before the upload — the exact regression Phase H is forbidden
 *     to introduce ("do not accidentally lock existing legitimate users");
 *   * recordings are BATCH-scoped, so the same lesson would impose different
 *     obligations on different batches for reasons unrelated to the
 *     curriculum;
 *   * `SessionVideo.requiredPercent` tracks the recording's own completion for
 *     the surfaces that show it — it is a media contract, not a curriculum one.
 *
 * Recordings stay first-class academic CONTENT (watch-tracked, surfaced by the
 * Phase C Lesson Content Summary, and gated by the SAME `canAccessLesson`
 * verdict through the media + heartbeat routes). The decision is recorded here
 * so a later phase can extend it deliberately and atomically.
 *
 * A lesson with no video has NO video requirement: a missing component is not
 * a requirement, so a lesson can never lock a student on content it has not got.
 */
function videoFactsFor(lesson: UniverseLesson, facts: LoadedFacts): VideoRequirementFacts {
  if (!lesson.videoUrl) {
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
  const row = facts.progress.get(lesson.id);
  const percent = Math.min(100, Math.max(0, Number(row?.videoPercent ?? 0)));
  // The percentage is evaluated FIRST: it is the server-tracked truth. The
  // persisted `videoCompleted` flag is written by the same heartbeat route, so
  // it is accepted as an OR, never as the only evidence.
  const done = percent >= VIDEO_COMPLETION_THRESHOLD || Boolean(row?.videoCompleted);
  return {
    required: true,
    done,
    percent,
    threshold: VIDEO_COMPLETION_THRESHOLD,
    source: "LEGACY",
    count: 1,
    completedCount: done ? 1 : 0,
  };
}

/**
 * A published quiz is satisfied by a PASS — never by starting or submitting an
 * attempt. The attempt rows, their grading and their retry entitlements stay
 * owned by the Phase 26D / Phase G authorities; this only READS their verdict
 * (`QuizAttempt.passed` on a FINISHED attempt), so a student who merely
 * submitted a failing attempt still has to pass.
 */
function quizFactsFor(lesson: UniverseLesson, facts: LoadedFacts): QuizRequirementFacts {
  const quizzes = lesson.quizzes ?? [];
  if (!quizzes.length) {
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
  let passedCount = 0;
  let attemptedCount = 0;
  let bestPercent: number | null = null;
  let passMark: number | null = null;
  for (const quiz of quizzes) {
    const rows = (facts.attempts.get(quiz.id) ?? []).filter((a) => Boolean(a.finishedAt));
    if (rows.length) attemptedCount += 1;
    if (rows.some((a) => a.passed === true)) passedCount += 1;
    for (const row of rows) {
      const pct = Number(row.percentage ?? 0);
      if (bestPercent === null || pct > bestPercent) bestPercent = pct;
    }
    const mark = Number(quiz.passMark ?? NaN);
    if (Number.isFinite(mark)) passMark = passMark === null ? mark : Math.max(passMark, mark);
  }
  return {
    required: true,
    done: passedCount >= quizzes.length,
    requiredCount: quizzes.length,
    passedCount,
    attemptedCount,
    bestPercent,
    passMark,
  };
}

/**
 * A published homework is satisfied by a SUBMISSION. Grading is deliberately
 * irrelevant to progression (approved decision #3): marks, feedback and the
 * grading state stay assessment data for Teacher/Parent/analytics and are
 * reported, never required — progression must not wait on grading latency.
 */
function homeworkFactsFor(lesson: UniverseLesson, facts: LoadedFacts): HomeworkRequirementFacts {
  const homeworks = lesson.homeworks ?? [];
  if (!homeworks.length) {
    return { required: false, done: true, requiredCount: 0, submittedCount: 0, gradedCount: 0 };
  }
  let submittedCount = 0;
  let gradedCount = 0;
  for (const homework of homeworks) {
    const rows = facts.submissions.get(homework.id) ?? [];
    if (rows.some((s) => Boolean(s.submittedAt))) submittedCount += 1;
    if (rows.some((s) => s.grade !== null && s.grade !== undefined)) gradedCount += 1;
  }
  return {
    required: true,
    done: submittedCount >= homeworks.length,
    requiredCount: homeworks.length,
    submittedCount,
    gradedCount,
  };
}

function factsFor(lesson: UniverseLesson, loaded: LoadedFacts): RequirementFacts {
  return {
    video: videoFactsFor(lesson, loaded),
    quiz: quizFactsFor(lesson, loaded),
    homework: homeworkFactsFor(lesson, loaded),
  };
}

// ---------------------------------------------------------------------------
// View helpers (facts → the API/UI shape)
// ---------------------------------------------------------------------------

function videoView(video: VideoRequirementFacts): RequirementView {
  return {
    required: video.required,
    done: video.required ? video.done : true,
    value: video.required ? video.percent : 100,
    threshold: video.threshold,
    detail:
      video.count > 1 ? { passed: video.completedCount, required: video.count } : null,
  };
}

function quizView(quiz: QuizRequirementFacts): RequirementView {
  return {
    required: quiz.required,
    done: quiz.required ? quiz.done : true,
    value: quiz.required ? (quiz.done ? 100 : 0) : 100,
    threshold: quiz.passMark ?? 0,
    detail: quiz.required
      ? { passed: quiz.passedCount, required: quiz.requiredCount }
      : null,
  };
}

function homeworkView(homework: HomeworkRequirementFacts): RequirementView {
  return {
    required: homework.required,
    done: homework.required ? homework.done : true,
    value: homework.required ? (homework.done ? 100 : 0) : 100,
    threshold: 100,
    detail: homework.required
      ? {
          submitted: homework.submittedCount,
          required: homework.requiredCount,
          graded: homework.gradedCount,
        }
      : null,
  };
}

function unmetView(codes: readonly UnmetCode[]) {
  return orderUnmet(codes).map((code) => ({
    code,
    labelKey: UNMET_LABEL_KEYS[code],
    shortKey: UNMET_SHORT_KEYS[code],
    actionKey: UNMET_ACTION_KEYS[code],
  }));
}

function holdView(boundary: HoldBoundary): HoldView {
  return {
    holdId: boundary.holdId,
    status: boundary.status,
    active: boundary.active,
    blocks: boundary.blocks,
    lessonId: boundary.lessonId,
    sessionId: boundary.sessionId,
    reviewStatus: boundary.reviewStatus,
    catchUp: boundary.catchUp
      ? {
          lessonId: boundary.lessonId,
          satisfied: boundary.catchUp.satisfied,
          unmet: unmetView(boundary.catchUp.unmet),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// THE evaluation
// ---------------------------------------------------------------------------

/**
 * Evaluate the whole course for one student.
 *
 * Read-only, deterministic, idempotent: the same rows and the same `now`
 * always produce the same verdict (Phase H cases 32/33).
 */
export async function evaluateCourseProgression(params: {
  studentId: string;
  courseId: string;
  schoolType?: SchoolType | string | null;
  now?: Date;
  client?: Client;
}): Promise<CourseProgression> {
  const client = (params.client ?? db) as Client;
  const now = params.now ?? new Date();

  const student = await (client as any).student.findUnique({
    where: { id: params.studentId },
    select: {
      schoolType: true,
      group: { select: { courseId: true, isActive: true } },
      subscription: { select: { status: true, endDate: true } },
    },
  });

  // NOTE (Phase H): the ENTITLEMENT gate (an active group bound to this course
  // plus the Phase 25 subscription decision) is deliberately NOT applied here.
  // Academic progression and paid entitlement are different authorities that
  // COMPOSE: `canAccessLesson` / `getUnlockedLessonIds` still refuse a
  // non-entitled student, while a pure progression READER (the course tree's
  // session sequence, the parent progression reader, the historical
  // `getCourseSessionProgress`) keeps describing the student's curriculum
  // exactly as it did before Phase H. Applying the entitlement gate here would
  // silently blank dashboards for a child whose renewal is pending — a lock
  // Phase H must never introduce.
  const schoolType = normalizeSchoolType(
    params.schoolType !== undefined
      ? params.schoolType
      : student?.schoolType ?? null
  );

  const lessons = await loadCourseLessonUniverse({
    courseId: params.courseId,
    schoolType,
  });

  const loaded = await loadFacts({
    studentId: params.studentId,
    lessons,
    schoolType,
    client,
  });

  const factsByLesson = new Map<string, RequirementFacts>();
  for (const lesson of lessons) factsByLesson.set(lesson.id, factsFor(lesson, loaded));

  const [holds, overrides] = await Promise.all([
    loadStudentHolds(params.studentId, client),
    loadStudentOverrides(params.studentId, client),
  ]);

  const boundaries = buildHoldBoundaries({
    holds,
    universe: lessons.map((l) => l.id),
    factsByLesson,
  });

  return composeProgression({
    studentId: params.studentId,
    courseId: params.courseId,
    lessons,
    factsByLesson,
    boundaries,
    overrides,
    now,
  });
}

/**
 * Compose the verdicts from loaded facts. PURE — this is the one place the
 * boundary rule lives, and it is exercised directly by the Phase H suite.
 */
export function composeProgression(input: {
  studentId: string;
  courseId: string;
  lessons: readonly UniverseLesson[];
  factsByLesson: ReadonlyMap<string, RequirementFacts>;
  boundaries: readonly HoldBoundary[];
  overrides: readonly ProgressionOverrideRow[];
  now: Date;
}): CourseProgression {
  const lessons = [...input.lessons];
  const rows: LessonProgression[] = [];
  let previousCompleted = true; // the very first lesson is always reachable
  let boundary: CourseProgression["boundary"] = null;

  for (let i = 0; i < lessons.length; i += 1) {
    const lesson = lessons[i];
    const facts = input.factsByLesson.get(lesson.id) ?? emptyFacts();
    const evaluation = evaluateRequirements(facts);

    // ---- the BOUNDARY: what must be true to be allowed into this lesson ----
    // 1. the previous lesson in the sequence must be COMPLETE;
    // 2. no ACTIVE AbsenceHold may sit AT OR BEFORE the previous lesson
    //    (a hold blocks everything AFTER the session it was opened for —
    //    never the affected lesson itself, its recording, its quiz or its
    //    homework: the content needed to resolve the hold stays open).
    const blocking = input.boundaries.filter(
      (b) => b.blocks && b.boundaryIndex !== null && i > (b.boundaryIndex as number)
    );
    const holdBlocked = blocking.length > 0;
    const boundaryCodes: UnmetCode[] = holdBlocked
      ? ["ABSENCE_HOLD"]
      : previousCompleted
        ? []
        : ["PREVIOUS_LESSON"];

    const override = findValidOverride(input.overrides, lesson.id, input.now);
    const boundaryAllowed = boundaryCodes.length === 0 || Boolean(override);

    const state = stateFor({ completed: evaluation.completed, boundaryAllowed });
    const codes = boundaryAllowed ? evaluation.unmet : orderUnmet([...boundaryCodes, ...evaluation.unmet]);
    const primary = primaryUnmet(codes);

    rows.push({
      lessonId: lesson.id,
      order: lesson.order,
      state,
      // Phase-4 booleans, preserved bit-for-bit (see `legacyFlags`):
      // `completed` is academic, `unlocked` is the boundary.
      ...legacyFlags({ completed: evaluation.completed, boundaryAllowed }),
      reason:
        primary === null
          ? override && boundaryCodes.length > 0
            ? { code: "ADMIN_OVERRIDE", labelKey: "progression.reason.override" }
            : null
          : { code: primary, labelKey: UNMET_LABEL_KEYS[primary] },
      unmet: unmetView(codes),
      requirements: {
        video: videoView(facts.video),
        quiz: quizView(facts.quiz),
        homework: homeworkView(facts.homework),
      },
      mayUnlockNext: evaluation.completed,
      override: override ? toOverrideView(override, input.now) : null,
    });

    // The BOUNDARY is where forward progression actually STOPS: the first
    // lesson the student may not enter. A lesson that is merely unfinished
    // (UNLOCKED with outstanding components) is not a boundary — it is the
    // CURRENT lesson, which `currentLessonId` already names. A lesson opened
    // by an Admin override is not a boundary either: the stop has been
    // lifted, and the payload reports the override separately.
    if (!boundary && state === "LOCKED" && primary) {
      boundary = {
        lessonId: lesson.id,
        reason: {
          code: primary as UnmetCode,
          labelKey: UNMET_LABEL_KEYS[primary as UnmetCode],
        },
      };
    }

    previousCompleted = evaluation.completed;
  }

  const current =
    rows.find((r) => r.unlocked && !r.completed) ??
    rows.find((r) => r.unlocked) ??
    null;

  const blockingHold = blockingBoundary(input.boundaries);
  const shownHold = visibleHold(input.boundaries);
  const overrideViews = input.overrides.map((o) => toOverrideView(o, input.now));

  return {
    courseId: input.courseId,
    studentId: input.studentId,
    lessons: rows,
    byLessonId: new Map(rows.map((r) => [r.lessonId, r])),
    currentLessonId: current?.lessonId ?? null,
    boundary,
    hold: blockingHold ? holdView(blockingHold) : null,
    activeHold: shownHold ? holdView(shownHold) : null,
    overrides: overrideViews,
    catchUp: shownHold ? (shownHold.catchUp ? {
      lessonId: shownHold.lessonId,
      satisfied: shownHold.catchUp.satisfied,
      unmet: unmetView(shownHold.catchUp.unmet),
    } : null) : null,
  };
}

function emptyCourseProgression(studentId: string, courseId: string): CourseProgression {
  return {
    courseId,
    studentId,
    lessons: [],
    byLessonId: new Map(),
    currentLessonId: null,
    boundary: null,
    hold: null,
    activeHold: null,
    overrides: [],
    catchUp: null,
  };
}

// ---------------------------------------------------------------------------
// Direct lesson / resource access
// ---------------------------------------------------------------------------

/**
 * Server-side authorization for opening ONE lesson.
 *
 * Every structural gate runs BEFORE progression is computed and answers
 * LESSON_NOT_FOUND (a 404), so probing ids can never enumerate staged content
 * or another track's curriculum:
 *   lifecycle (Phase 13) → archived history (Phase 11) → course membership →
 *   entitlement (Phase 25 PR2a) → track (Phase 12) → progression boundary.
 */
export async function canAccessLesson(
  studentId: string,
  lessonId: string,
  options: { now?: Date; client?: Client } = {}
): Promise<LessonAccess> {
  const result = await canAccessLessonWithCourse(studentId, lessonId, options);
  return {
    allowed: result.allowed,
    reason: result.reason,
    status: result.status,
  };
}

/**
 * The same gate, plus the whole course verdict it was computed from.
 *
 * The lesson page needs both (the lesson's own state AND the boundary / hold /
 * catch-up context) and computing them separately would mean two evaluations
 * of the same sequence — a second evaluation is not wrong, but it is exactly
 * the kind of duplicated read that lets two surfaces disagree.
 */
export async function canAccessLessonWithCourse(
  studentId: string,
  lessonId: string,
  options: { now?: Date; client?: Client } = {}
): Promise<LessonAccess & { course: CourseProgression | null }> {
  const client = (options.client ?? db) as Client;
  const now = options.now ?? new Date();

  const lesson = await (client as any).lesson.findUnique({
    where: { id: lessonId },
    select: {
      ...LESSON_CHAIN_SELECT,
      trackScope: true,
      status: true,
      curriculumStatus: true,
    },
  });
  const denied = (reason: AccessReason): LessonAccess & { course: CourseProgression | null } => ({
    allowed: false,
    reason,
    status: null,
    course: null,
  });
  if (!lesson) return denied("LESSON_NOT_FOUND");

  if (
    !isStudentVisibleStatus(lesson.status) ||
    String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED"
  ) {
    return denied("LESSON_NOT_FOUND");
  }

  const courseId = resolveLessonCourseId(lesson);
  if (!courseId) return denied("LESSON_NOT_FOUND");

  const student = await (client as any).student.findUnique({
    where: { id: studentId },
    select: {
      schoolType: true,
      group: { select: { courseId: true, isActive: true } },
      subscription: { select: { status: true, endDate: true } },
    },
  });
  if (!student) return denied("NOT_ENROLLED");

  const entitled = evaluateAccessDecision({
    groupActive:
      !!student?.group &&
      student.group.isActive &&
      student.group.courseId === courseId,
    subscription: student?.subscription,
  });
  if (!entitled.allowed) return denied("NOT_ENROLLED");

  const schoolType = normalizeSchoolType(student.schoolType);
  if (!canAccessTrackScope(schoolType, lesson.trackScope)) {
    return denied("LESSON_NOT_FOUND");
  }

  const progression = await evaluateCourseProgression({
    studentId,
    courseId,
    schoolType,
    now,
    client,
  });
  const status = progression.byLessonId.get(lessonId) || null;
  if (!status) return denied("LESSON_NOT_FOUND");
  if (!status.unlocked) {
    return {
      allowed: false,
      reason: "PREVIOUS_SESSION_INCOMPLETE",
      status,
      course: progression,
    };
  }
  return { allowed: true, reason: null, status, course: progression };
}

/**
 * Gate a resource that belongs to a lesson AND carries its own trackScope.
 *
 * Two independent conditions, both fail-closed:
 *   1. the owning lesson must be open to this student (`canAccessLesson`,
 *      which already enforces enrollment, entitlement, lifecycle, archived
 *      history, the lesson's trackScope and the progression boundary);
 *   2. the resource's OWN trackScope must be eligible (a SHARED lesson may
 *      legitimately host an ARABIC quiz and a LANGUAGE quiz).
 */
export async function gateTrackedResource(
  studentId: string,
  lessonId: string | null,
  trackScope: unknown,
  options: { now?: Date; client?: Client } = {}
): Promise<ResourceAccess> {
  if (!lessonId) return { allowed: false, reason: "LESSON_NOT_FOUND" };
  const access = await canAccessLesson(studentId, lessonId, options);
  if (!access.allowed) return { allowed: false, reason: access.reason };

  const schoolType = await getStudentSchoolType(studentId);
  if (!canAccessTrackScope(schoolType, trackScope)) {
    return { allowed: false, reason: "LESSON_NOT_FOUND" };
  }
  return { allowed: true, reason: null };
}

/**
 * Batch gate a set of lessons at once (list endpoints: course tree, homework
 * list, dashboard). One progression computation for the whole course, so a
 * single request can never describe protected content piecemeal, and the
 * entitlement gate is applied here too (not only in `canAccessLesson`).
 */
export async function getUnlockedLessonIds(
  studentId: string,
  courseId: string,
  options: { now?: Date; client?: Client } = {}
): Promise<Set<string>> {
  const client = (options.client ?? db) as Client;
  const student = await (client as any).student.findUnique({
    where: { id: studentId },
    select: {
      group: { select: { isActive: true, courseId: true } },
      subscription: { select: { status: true, endDate: true } },
    },
  });
  const entitled = evaluateAccessDecision({
    groupActive:
      !!student?.group && student.group.isActive && student.group.courseId === courseId,
    subscription: student?.subscription,
  });
  if (!entitled.allowed) return new Set<string>();

  const progression = await evaluateCourseProgression({
    studentId,
    courseId,
    now: options.now,
    client,
  });
  return new Set(
    progression.lessons.filter((l) => l.unlocked).map((l) => l.lessonId)
  );
}

/**
 * Evaluate ONE lesson by id (used by the lesson page and the navigation
 * chain). Returns null when the lesson is not part of the student's
 * curriculum — "absent" is never "locked", exactly as before.
 */
export async function evaluateLessonProgression(params: {
  studentId: string;
  lessonId: string;
  now?: Date;
  client?: Client;
}): Promise<LessonProgression | null> {
  const client = (params.client ?? db) as Client;
  const access = await canAccessLesson(params.studentId, params.lessonId, {
    now: params.now,
    client,
  });
  return access.status;
}

/**
 * The catch-up state of a student: what the held lesson still needs.
 *
 * Only requirements that ACTUALLY EXIST are listed (a lesson with no quiz
 * never asks for a quiz pass), and attendance is never one of them — the
 * student resolves an absence by completing the missed lesson's academics.
 */
export async function evaluateCatchUp(params: {
  studentId: string;
  courseId?: string | null;
  now?: Date;
  client?: Client;
}): Promise<CatchUpView | null> {
  const client = (params.client ?? db) as Client;
  const now = params.now ?? new Date();
  const courseId =
    params.courseId ??
    ((
      await (client as any).student.findUnique({
        where: { id: params.studentId },
        select: { group: { select: { courseId: true } } },
      })
    )?.group?.courseId as string | undefined) ??
    null;
  if (!courseId) return null;

  const progression = await evaluateCourseProgression({
    studentId: params.studentId,
    courseId,
    now,
    client,
  });
  return progression.activeHold?.catchUp ?? progression.catchUp ?? null;
}

// ---------------------------------------------------------------------------
// Localization (keys in, sentences out — never a raw code in the UI)
// ---------------------------------------------------------------------------

export type ProgressionText = {
  state: ProgressionState;
  stateLabel: string;
  reason: string | null;
  unmet: { code: UnmetCode; text: string; action: string }[];
  nextAction: string | null;
  hold: string | null;
  override: string | null;
};

// ---------------------------------------------------------------------------
// API payloads (the shape every reader serialises — one definition, no drift)
// ---------------------------------------------------------------------------

export type LessonProgressionPayload = {
  lessonId: string;
  order: number;
  state: ProgressionState;
  stateLabel: string;
  completed: boolean;
  unlocked: boolean;
  /** Arabic-first headline. Null when there is nothing to explain. */
  reason: { code: string; text: string } | null;
  /** What still has to happen, in the order the student should act. */
  unmet: { code: UnmetCode; text: string; action: string }[];
  nextAction: string | null;
  requirements: {
    video: RequirementView;
    quiz: RequirementView;
    homework: RequirementView;
  };
  mayUnlockNext: boolean;
  override: { id: string; reason: string; expiresAt: string | null; valid: boolean } | null;
};

export type CourseProgressionPayload = {
  currentLessonId: string | null;
  boundary: {
    lessonId: string;
    reason: { code: string; text: string };
  } | null;
  hold: (Omit<HoldView, "catchUp"> & {
    catchUp: (Omit<CatchUpView, "unmet"> & {
      unmet: { code: UnmetCode; text: string; action: string }[];
    }) | null;
  }) | null;
  catchUp: (Omit<CatchUpView, "unmet"> & {
    unmet: { code: UnmetCode; text: string; action: string }[];
  }) | null;
  lessons: LessonProgressionPayload[];
};

/** Serialise ONE lesson verdict into its API/UI shape. */
export function toLessonProgressionPayload(
  row: LessonProgression,
  t: (key: string, params?: Record<string, unknown>) => string
): LessonProgressionPayload {
  const text = localizeProgression(row, t);
  return {
    lessonId: row.lessonId,
    order: row.order,
    state: row.state,
    stateLabel: text.stateLabel,
    completed: row.completed,
    unlocked: row.unlocked,
    reason: row.reason ? { code: row.reason.code, text: t(row.reason.labelKey) } : null,
    unmet: text.unmet,
    nextAction: text.nextAction,
    requirements: row.requirements,
    mayUnlockNext: row.mayUnlockNext,
    override: row.override
      ? {
          id: row.override.id,
          reason: row.override.reason,
          expiresAt: row.override.expiresAt,
          valid: row.override.valid,
        }
      : null,
  };
}

function localizeCatchUp(
  catchUp: CatchUpView | null,
  t: (key: string, params?: Record<string, unknown>) => string
) {
  if (!catchUp) return null;
  return {
    lessonId: catchUp.lessonId,
    satisfied: catchUp.satisfied,
    unmet: catchUp.unmet.map((u) => ({
      code: u.code,
      text: t(u.labelKey),
      action: t(u.actionKey),
    })),
  };
}

/** Serialise a whole course verdict (used by the lesson page + the tree). */
export function toCourseProgressionPayload(
  progression: CourseProgression,
  t: (key: string, params?: Record<string, unknown>) => string
): CourseProgressionPayload {
  return {
    currentLessonId: progression.currentLessonId,
    boundary: progression.boundary
      ? {
          lessonId: progression.boundary.lessonId,
          reason: {
            code: progression.boundary.reason.code,
            text: t(progression.boundary.reason.labelKey),
          },
        }
      : null,
    hold: progression.hold
      ? {
          holdId: progression.hold.holdId,
          status: progression.hold.status,
          active: progression.hold.active,
          blocks: progression.hold.blocks,
          lessonId: progression.hold.lessonId,
          sessionId: progression.hold.sessionId,
          reviewStatus: progression.hold.reviewStatus,
          catchUp: localizeCatchUp(progression.hold.catchUp, t),
        }
      : null,
    catchUp: localizeCatchUp(progression.catchUp ?? progression.activeHold?.catchUp ?? null, t),
    lessons: progression.lessons.map((row) => toLessonProgressionPayload(row, t)),
  };
}

/**
 * Turn a canonical verdict into Arabic-first sentences.
 *
 * The translator is INJECTED (`getServerT()` on the server, `useT()` on the
 * client) so this module never imports the dictionary and never binds itself
 * to one locale. A missing key yields "" from `translate`, never the raw key.
 */
export function localizeProgression(
  row: LessonProgression,
  t: (key: string, params?: Record<string, unknown>) => string
): ProgressionText {
  const stateKey =
    row.state === "COMPLETED"
      ? "progression.state.completed"
      : row.state === "UNLOCKED"
        ? "progression.state.unlocked"
        : "progression.state.locked";
  const primary = row.unmet[0]?.code ?? null;
  return {
    state: row.state,
    stateLabel: t(stateKey),
    reason: row.reason ? t(row.reason.labelKey) : null,
    unmet: row.unmet.map((u) => ({
      code: u.code,
      text: t(u.labelKey),
      action: t(u.actionKey),
    })),
    nextAction: primary ? t(UNMET_ACTION_KEYS[primary]) : null,
    hold: primary === "ABSENCE_HOLD" ? t("progression.reason.hold") : null,
    override: row.override ? t("progression.reason.override") : null,
  };
}

// ---------------------------------------------------------------------------
// Re-exports for readers (one import site, no duplicated predicates)
// ---------------------------------------------------------------------------

export {
  EXCLUDE_ARCHIVED_LESSON,
  LESSON_CHAIN_SELECT,
  LESSON_STUDENT_STATUS_FILTER,
  orderCourseLessons,
  resolveLessonCourseId,
  lessonCourseChainOr,
};
export type { LessonChain, UniverseLesson };
export { VIDEO_COMPLETION_THRESHOLD };
