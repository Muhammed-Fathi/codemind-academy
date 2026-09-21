// CodeMind Academy — Phase H: THE canonical progression + access engine.
//
// ONE authority for Lesson LOCKED / UNLOCKED / COMPLETED. Every progression
// reader consumes it or delegates to it:
//
//   * student dashboard, course tree, Lesson page, Lesson navigation
//   * direct Lesson access, media/material access
//   * Quiz + Homework access where progression applies
//   * parent / Teacher / Admin progression readers
//
// WHAT THIS MODULE OWNS
//   The per-student, per-course evaluation: which lessons are in the academic
//   universe, what each lesson requires, whether each requirement is satisfied
//   from SERVER-TRACKED facts, how the sequential chain unlocks, where an
//   active Phase F absence hold draws the progression boundary, and whether a
//   valid Admin override grants an exception. Plus the Arabic-first,
//   human-readable reason for every non-accessible state.
//
// WHAT THIS MODULE DOES NOT OWN (deliberate boundaries — no second systems)
//   * Lesson / LiveSession models, lifecycles, scheduling — Phase 13 / Phase F.
//   * Quiz attempts, grading, retries, publication — Phase 26D / Phase G.
//     This engine READS `QuizAttempt.passed` (the canonical pass fact); it
//     never grades, never retries, never publishes.
//   * Homework grading, files, lifecycle — Phase G. This engine READS
//     submissions; grading latency never gates progression.
//   * Attendance facts and absence CASES — Phase F. This engine READS active
//     `AbsenceHold` rows (the Phase F output) and resolves catch-up THROUGH
//     the Phase F authority (`resolveHoldForCatchup`); it never mutates a
//     review, never reinterprets absence state.
//   * Track eligibility — Phase 12 (`canAccessTrackScope` / `trackScopeWhere`).
//     Composed with, never overridden.
//   * Enrollment + paid entitlement — `getEnrollment` / `evaluateAccessDecision`.
//   * Video watch verification — the heartbeat routes. This engine READS the
//     server-credited `LessonProgress` rows; it never accepts a client claim
//     of completion. (`SessionVideoView` rows are telemetry + display only —
//     Phase B M2: recordings are never progression inputs.)
//
// THE RULE MATRIX (exact, in evaluation order)
//   UNIVERSE     PUBLISHED + non-archived + track-eligible + attached to the
//                course (canonical `unitId` chain first, legacy `topicId`
//                fallback), in deterministic curriculum order. Identical to the
//                Phase 4 universe — the helpers below MOVED here unchanged.
//   VIDEO        Required iff the Lesson carries the authoritative required
//                video: the legacy `Lesson.videoUrl` (Phase B M2 — the
//                pre-H authority, restored). A published batch SessionVideo /
//                recording NEVER creates a requirement merely by existing:
//                publishing after progression cannot retroactively break a
//                lesson, and adding another recording changes nothing.
//                Satisfied iff server-tracked watch reaches 95%.
//   QUIZ         Required iff a PUBLISHED, track-eligible Quiz exists on the
//                Lesson — pool state is NOT a filter (a misconfigured quiz
//                fails LOUD through the quiz path; it is never silently
//                dropped from progression). Satisfied iff EVERY such Quiz has
//                a PASSED, finished attempt. Attempted-but-failed is NOT
//                sufficient.
//   HOMEWORK     Required iff a PUBLISHED-or-CLOSED, track-eligible Homework
//                exists on the Lesson. Satisfied iff EVERY such Homework has a
//                student submission (`submittedAt` set, any verdict).
//                Teacher grading is NOT required for unlock.
//   ATTENDANCE   Never completes a Lesson. It affects progression ONLY through
//                an ACTIVE AbsenceHold (Phase F output).
//   HOLD         An ACTIVE hold whose missed Lesson is in this universe blocks
//                every Lesson AFTER the missed one (forward progression only)
//                until resolved. It never blocks the missed Lesson itself, its
//                recovery materials, its recording, its Quiz/Homework,
//                historical COMPLETED lessons, or session information.
//   OVERRIDE     A currently-valid Admin override unlocks its NAMED Lesson
//                only (sequential gate + hold boundary bypassed for that
//                Lesson). Track, lifecycle and enrollment are NEVER bypassed,
//                and no academic fact is rewritten.
//   SEQUENCE     Lesson[i] unlocks iff every Lesson[0..i-1] is COMPLETED
//                (derived), minus the hold boundary, plus overrides.
//                A Lesson with no requirements is COMPLETED (vacuous truth).
//
// BACKWARD COMPATIBILITY (explicit)
//   * Derived completion is MONOTONIC: video watch is monotonic, a pass sticks,
//     a submission sticks, so a COMPLETED Lesson stays COMPLETED.
//   * Legacy `LessonProgress.isCompleted` rows are PRESERVED and still feed
//     historical aggregates (certificate, gamification, reports, exports).
//     They never gate access, and progression DISPLAY now derives from this
//     engine instead of the client-touchable flag.
//   * The attempted→PASSED rule change is INTENTIONAL (product decision): a
//     student whose only attempts failed must genuinely pass (or receive an
//     Admin retry grant / progression override). This is stricter by design.
//   * Cross-track Quiz/Homework rows on a SHARED Lesson are EXCLUDED from
//     requirements (Phase 4 counted every row — a latent deadlock for any
//     content that used per-track assessments). This only ever unblocks.
//   * Recordings stay NON-INPUTS (Phase B M2, preserved exactly as Phase 4
//     had it): publishing or watching a batch SessionVideo can neither
//     create nor satisfy a requirement.
//
// DETERMINISM: evaluation is a pure function of stored rows + `now` (the
// latter only for override expiry). Same rows + same `now` = same verdict,
// every reader, every time. Repeated evaluation is idempotent (read-only).

import { db } from "@/lib/db";
import {
  LESSON_STUDENT_STATUS_FILTER,
  isStudentVisibleStatus,
} from "@/lib/session-lifecycle";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { canAccessTrackScope, trackScopeWhere, videoTrackFilter } from "@/lib/track-scope";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";
import { isManagedPrivateStorage } from "@/lib/media";
import { evaluateAccessDecision } from "@/lib/subscription-entitlement";

// ---------------------------------------------------------------------------
// The progression UNIVERSE — moved here (Phase H) from session-progress.ts.
// ---------------------------------------------------------------------------
// These helpers are byte-for-byte the Phase 4/11/12/13 universe contract:
// dual-chain course attachment, archived-history exclusion, track slicing and
// the deterministic curriculum order. They MOVED — they were not rewritten —
// so there is exactly one definition. session-progress.ts re-exports them.

/** Spread into any lesson `where` to exclude archived lessons. */
export const EXCLUDE_ARCHIVED_LESSON = {
  curriculumStatus: { not: "ARCHIVED" },
} as const;

/** Dual-chain course filter: canonical `unitId` chain OR legacy `topicId` chain. */
export function lessonCourseChainOr(courseId: string) {
  return [
    { unit: { part: { courseId } } },
    { topic: { unit: { part: { courseId } } } },
  ];
}

/** Dual-chain filter for a set of courses. */
export function lessonCoursesChainOr(courseIds: string[]) {
  return [
    { unit: { part: { courseId: { in: courseIds } } } },
    { topic: { unit: { part: { courseId: { in: courseIds } } } } },
  ];
}

/** Chain fields needed to place a lesson in its course. Shared by every query. */
export const LESSON_CHAIN_SELECT = {
  id: true,
  order: true,
  videoUrl: true,
  unitId: true,
  topicId: true,
  unit: {
    select: {
      id: true,
      order: true,
      part: { select: { id: true, order: true, courseId: true } },
    },
  },
  topic: {
    select: {
      order: true,
      unit: {
        select: {
          id: true,
          order: true,
          part: { select: { id: true, order: true, courseId: true } },
        },
      },
    },
  },
} as const;

export type LessonChain = {
  id: string;
  order: number;
  videoUrl: string | null;
  unitId: string | null;
  topicId: string | null;
  unit: {
    id: string;
    order: number;
    part: { id: string; order: number; courseId: string };
  } | null;
  topic: {
    order: number;
    unit: {
      id: string;
      order: number;
      part: { id: string; order: number; courseId: string };
    };
  } | null;
};

/**
 * The course a lesson belongs to, canonical chain first. Returns null for a
 * lesson that is attached to neither — such a lesson is not part of any course
 * and therefore not part of any progression.
 */
export function resolveLessonCourseId(lesson: LessonChain): string | null {
  return (
    lesson.unit?.part.courseId ??
    lesson.topic?.unit.part.courseId ??
    null
  );
}

const TOPIC_ORDER_NONE = -1;

type ChainPosition = {
  partOrder: number;
  unitOrder: number;
  topicOrder: number;
};

function chainPositionOf(
  lesson: LessonChain,
  courseId: string
): ChainPosition | null {
  if (lesson.unit && lesson.unit.part.courseId === courseId) {
    return {
      partOrder: lesson.unit.part.order,
      unitOrder: lesson.unit.order,
      topicOrder: TOPIC_ORDER_NONE,
    };
  }
  const legacy = lesson.topic;
  if (legacy && legacy.unit.part.courseId === courseId) {
    return {
      partOrder: legacy.unit.part.order,
      unitOrder: legacy.unit.order,
      topicOrder: legacy.order,
    };
  }
  return null;
}

function comparePosition(
  a: ChainPosition & { order: number; id: string },
  b: ChainPosition & { order: number; id: string }
): number {
  return (
    a.partOrder - b.partOrder ||
    a.unitOrder - b.unitOrder ||
    a.topicOrder - b.topicOrder ||
    a.order - b.order ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Order the lessons of `courseId` deterministically, dropping any row that
 * cannot be attributed to this course.
 */
export function orderCourseLessons<T extends LessonChain>(
  lessons: T[],
  courseId: string
): T[] {
  return lessons
    .map((lesson) => ({ lesson, pos: chainPositionOf(lesson, courseId) }))
    .filter((x): x is { lesson: T; pos: ChainPosition } => x.pos !== null)
    .sort((x, y) =>
      comparePosition(
        { ...x.pos, order: x.lesson.order, id: x.lesson.id },
        { ...y.pos, order: y.lesson.order, id: y.lesson.id }
      )
    )
    .map((x) => x.lesson);
}

// ---------------------------------------------------------------------------
// Canonical vocabulary
// ---------------------------------------------------------------------------

/** The one progression state model: LOCKED / UNLOCKED / COMPLETED. */
export type ProgressionState = "LOCKED" | "UNLOCKED" | "COMPLETED";

/**
 * Stable internal unmet-requirement codes. Student-visible strings stay
 * Arabic-readable (`PROGRESSION_REASON_AR`); these codes are what UIs branch
 * on and what tests assert — never raw DB enums, never internal ids.
 */
export type ProgressionUnmetCode =
  | "VIDEO_INCOMPLETE"
  | "QUIZ_NOT_PASSED"
  | "HOMEWORK_NOT_SUBMITTED"
  | "PREVIOUS_INCOMPLETE"
  | "ABSENCE_HOLD"
  | "NO_COMPLETION_REQUIREMENTS";

/** Arabic-first human-readable reason per code (RTL, no tech jargon). */
export const PROGRESSION_REASON_AR: Record<ProgressionUnmetCode, string> = {
  VIDEO_INCOMPLETE: "أكمل الفيديو الأول",
  QUIZ_NOT_PASSED: "لازم تنجح في الـQuiz",
  HOMEWORK_NOT_SUBMITTED: "سلّم الـHomework الأول",
  PREVIOUS_INCOMPLETE: "خلّص الدرس اللي قبله الأول",
  ABSENCE_HOLD: "عندك غياب محتاج تعويض",
  NO_COMPLETION_REQUIREMENTS: "لا توجد متطلبات إكمال لهذا الدرس",
};

/**
 * Serialized unmet entry: the stable machine code PLUS its Arabic label, from
 * the single `PROGRESSION_REASON_AR` source. The pure core and every internal
 * type keep bare `ProgressionUnmetCode[]`; only the API boundary (status rows,
 * denial details, catch-up views) widens codes into entries, so UIs render
 * verbatim and never maintain a second Arabic mapping.
 */
export type ProgressionUnmetEntry = {
  kind: ProgressionUnmetCode;
  label: string;
};

export function toUnmetEntries(
  codes: readonly ProgressionUnmetCode[]
): ProgressionUnmetEntry[] {
  return codes.map((kind) => ({
    kind,
    label: PROGRESSION_REASON_AR[kind] ?? kind,
  }));
}

/**
 * One REQUIRED video inside a lesson's video requirement (the requirement
 * decomposition). Identity + threshold + trackability ride along as evidence
 * passthrough — the loader populates them from the rows it already read;
 * the core appends the LIVE completion verdict per video.
 */
export type ProgressionVideoItem = {
  id: string;
  title: string;
  titleAr: string;
  /** THIS video's own threshold (50–100, default 95). */
  requiredPercent: number;
  /** Managed storage (measurable) vs external (fail-closed, unsatisfiable). */
  trackable: boolean;
  /** Live server percent (SessionVideoView.percent); 0 when unwatched. */
  currentPercent: number;
  completed: boolean;
};

export type ProgressionRequirement = {
  /** Whether this lesson actually has the component in the student's audience. */
  required: boolean;
  done: boolean;
  /** 0-100 where meaningful (video), else 0/100. */
  value: number;
  /** Video only: how many REQUIRED videos gate this lesson. */
  requiredCount?: number;
  /** Video only: how many of them currently satisfy their own threshold. */
  completedCount?: number;
  /** Video only: the per-video decomposition (REQUIRED videos only). */
  items?: ProgressionVideoItem[];
};

export type ProgressionEvidence = {
  video: { percent: number; completedAt: string | null } | null;
  quiz: { attemptId: string; percentage: number; passedAt: string | null }[] | null;
  homework: { submittedAt: string | null; status: string | null }[] | null;
};

export type ActiveHoldRef = {
  holdId: string;
  reviewId: string;
  sessionId: string;
  /** The missed lesson, when it is identifiable. */
  lessonId: string | null;
};

export type ActiveOverrideRef = {
  overrideId: string;
  reason: string;
  grantedAt: string;
  expiresAt: string | null;
};

export type LessonEvaluation = {
  lessonId: string;
  order: number;
  state: ProgressionState;
  /**
   * True when the lesson has ≥1 requirement AND every required condition is
   * satisfied. A zero-requirement lesson is NEVER completed (boundary).
   */
  completed: boolean;
  /** True when the student is allowed to open this lesson. */
  unlocked: boolean;
  video: ProgressionRequirement;
  quiz: ProgressionRequirement;
  assignment: ProgressionRequirement;
  /** Structured unmet requirements (stable codes, priority-ordered). */
  unmet: ProgressionUnmetCode[];
  /** Arabic-first human-readable reason (null when nothing blocks). */
  reason: string | null;
  /** The primary code behind `reason` (null when nothing blocks). */
  reasonCode: ProgressionUnmetCode | null;
  /** Completion evidence (server facts only, never client claims). */
  evidence: ProgressionEvidence;
  /** The hold drawing the boundary at/after this lesson, if relevant. */
  hold: ActiveHoldRef | null;
  /** The override granting this lesson, if relevant. */
  override: ActiveOverrideRef | null;
};

export type CourseProgression = {
  courseId: string;
  studentId: string;
  /** Ordered lessons with their canonical gating status. */
  lessons: LessonEvaluation[];
  byLessonId: Map<string, LessonEvaluation>;
  /** First lesson the student should work on. */
  currentLessonId: string | null;
  /** ACTIVE holds intersecting this course universe. */
  holds: ActiveHoldRef[];
  /** Currently-valid overrides intersecting this course universe. */
  overrides: ActiveOverrideRef[];
  /** The effective progression boundary. */
  boundary: {
    /** Last lesson of the initial contiguous accessible run (null if none). */
    contiguousLessonId: string | null;
    /** First lesson blocked by an absence hold (null when no hold boundary). */
    holdBlockedFromLessonId: string | null;
    /** Lessons accessible by override exception (never facts rewritten). */
    overriddenLessonIds: string[];
  };
  evaluatedAt: Date;
};

// ---------------------------------------------------------------------------
// Pure core — deterministic, no I/O.
// ---------------------------------------------------------------------------
// Everything the engine needs is passed in; nothing is read. The loader below
// is the ONLY thing that talks to the database, so the whole rule matrix is
// unit-testable without a database, a server, or the clock (except `now`,
// which callers inject for override expiry).

export type ProgressionCoreLesson = {
  id: string;
  order: number;
  hasLegacyVideo: boolean;
  /**
   * REQUIRED SessionVideos gating THIS lesson for THIS student (published,
   * own batch, track-eligible — sliced by the loader through the SAME
   * predicates the student list applies). Absent = none (legacy-only).
   */
  requiredVideos?: Omit<ProgressionVideoItem, "currentPercent" | "completed">[];
  /** Quizzes that are requirements for THIS student (published, track-eligible). */
  quizIds: string[];
  /** Homework that are requirements for THIS student (published/closed, eligible). */
  homeworkIds: string[];
};

export type ProgressionCoreFacts = {
  legacyVideoByLesson: Map<string, { percent: number; completed: boolean; completedAt: string | null }>;
  passedQuizIds: Set<string>;
  /** Best passed attempt per quiz, for evidence. */
  passedAttemptByQuiz: Map<string, { attemptId: string; percentage: number; passedAt: string | null }>;
  submittedHomeworkIds: Set<string>;
  submissionByHomework: Map<string, { submittedAt: string | null; status: string | null }>;
  /**
   * LIVE server watch percent per REQUIRED SessionVideo (THIS student's
   * SessionVideoView rows). The engine compares live percent against each
   * video's OWN threshold — the sticky isCompleted flag is history, never an
   * input, so a retroactive threshold raise bites without rewriting rows.
   */
  videoWatchPercent?: Map<string, number>;
};

export type ProgressionCoreHold = ActiveHoldRef;
export type ProgressionCoreOverride = ActiveOverrideRef & { lessonId: string };

function reasonTextFor(unmet: readonly ProgressionUnmetCode[]): string | null {
  if (unmet.length === 0) return null;
  // The PRIMARY reason is the first code (priority-ordered by the caller);
  // secondary unmet dimensions are joined so the student sees every action.
  return unmet.map((c) => PROGRESSION_REASON_AR[c]).join("، ");
}

/**
 * Evaluate an ORDERED lesson list against student facts, holds and overrides.
 * Pure: no I/O, no clock reads (expiry is pre-evaluated by the caller), no
 * mutation of the inputs. Same inputs = same outputs, always.
 */
export function evaluateProgressionCore(input: {
  lessons: readonly ProgressionCoreLesson[];
  facts: ProgressionCoreFacts;
  holds: readonly ProgressionCoreHold[];
  overrides: readonly ProgressionCoreOverride[];
}): { lessons: LessonEvaluation[]; currentLessonId: string | null } {
  const { lessons, facts, holds, overrides } = input;
  const overrideByLesson = new Map(overrides.map((o) => [o.lessonId, o]));
  const indexByLesson = new Map(lessons.map((l, i) => [l.id, i] as const));

  // The hold boundary: the EARLIEST missed lesson in this universe. Every
  // lesson AFTER it is hold-blocked (forward progression only). A hold whose
  // missed lesson is null or outside this universe draws no boundary here —
  // there is no identifiable recovery content to protect, and inventing a
  // boundary would trap the student with no actionable path.
  let holdBoundaryIndex: number | null = null;
  const holdByAffectedLesson = new Map<string, ProgressionCoreHold>();
  for (const hold of holds) {
    if (!hold.lessonId) continue;
    const idx = indexByLesson.get(hold.lessonId);
    if (idx === undefined) continue;
    if (!holdByAffectedLesson.has(hold.lessonId)) {
      holdByAffectedLesson.set(hold.lessonId, hold);
    }
    holdBoundaryIndex =
      holdBoundaryIndex === null ? idx : Math.min(holdBoundaryIndex, idx);
  }
  const holdAtBoundary =
    holdBoundaryIndex !== null
      ? (holdByAffectedLesson.get(lessons[holdBoundaryIndex].id) ?? null)
      : null;

  const out: LessonEvaluation[] = [];
  let previousCompleted = true; // the very first lesson is chain-unlocked

  lessons.forEach((lesson, i) => {
    const legacy = facts.legacyVideoByLesson.get(lesson.id);
    const legacyDone = !!legacy?.completed || (legacy?.percent ?? 0) >= VIDEO_COMPLETION_THRESHOLD;
    // Session-video requirements (the Phase B M2 revision): OPTIONAL
    // recordings stay content + telemetry (never inputs), but a REQUIRED
    // recording that is published + track/batch-eligible joins the lesson's
    // video requirement with its OWN threshold. BOTH sources feed ONE
    // canonical video verdict — conjunction, no precedence games:
    //   videoRequired = legacy present OR >=1 required recording;
    //   videoDone     = every required source satisfied.
    // Satisfaction is LIVE percent >= threshold per TRACKABLE source — the
    // sticky completion flags are history, never inputs (a retroactive
    // threshold change reflects without rewriting a single row). A required-
    // but-untrackable row (unreachable via the app — every write path
    // refuses it) fails CLOSED here even with a frozen legacy percent on
    // record: unmeasurable, never satisfied, loudly unmet.
    const requiredVideos = lesson.requiredVideos ?? [];
    const watchPercent = facts.videoWatchPercent;
    const modernDone = requiredVideos.every(
      (v) => v.trackable && (watchPercent?.get(v.id) ?? 0) >= v.requiredPercent
    );
    const videoRequired = lesson.hasLegacyVideo || requiredVideos.length > 0;
    const videoDone = !videoRequired || ((!lesson.hasLegacyVideo || legacyDone) && modernDone);
    const modernPercents = requiredVideos.map((v) => watchPercent?.get(v.id) ?? 0);
    // The bottleneck across the required sources (legacy-only lessons keep
    // their exact historical value: the legacy percent, untouched).
    const videoValue = !videoRequired
      ? 100
      : Math.min(...(lesson.hasLegacyVideo ? [legacy?.percent ?? 0] : []), ...modernPercents);
    const videoItems: ProgressionVideoItem[] = requiredVideos.map((v) => {
      const currentPercent = watchPercent?.get(v.id) ?? 0;
      return {
        id: v.id,
        title: v.title,
        titleAr: v.titleAr,
        requiredPercent: v.requiredPercent,
        trackable: v.trackable,
        currentPercent,
        completed: v.trackable && currentPercent >= v.requiredPercent,
      };
    });

    const quizRequired = lesson.quizIds.length > 0;
    const quizDone =
      !quizRequired || lesson.quizIds.every((q) => facts.passedQuizIds.has(q));

    const homeworkRequired = lesson.homeworkIds.length > 0;
    const homeworkDone =
      !homeworkRequired ||
      lesson.homeworkIds.every((h) => facts.submittedHomeworkIds.has(h));

    // Empty lessons (no video, quiz, or homework requirement) are chain
    // BOUNDARIES, never auto-completed: completion needs ≥1 requirement.
    const hasAnyRequirement = videoRequired || quizRequired || homeworkRequired;
    const completed =
      hasAnyRequirement && videoDone && quizDone && homeworkDone;
    const chainUnlocked = previousCompleted;
    const holdBlocked =
      holdBoundaryIndex !== null && i > holdBoundaryIndex;
    const override = overrideByLesson.get(lesson.id) ?? null;
    // The chain gates everything (sequentiality holds regardless of later
    // lessons' own facts); past an OPEN chain, historical COMPLETED lessons
    // stay accessible past a hold boundary while incomplete ones lock; an
    // override grants its named lesson as an exception to both.
    const unlocked =
      override !== null || (chainUnlocked && (completed || !holdBlocked));

    // Structured unmet, priority-ordered: the chain reason first (it is the
    // immediate action while predecessors are incomplete), then the hold
    // boundary, then this lesson's own unmet dimensions (only actionable
    // while the lesson itself is open).
    const unmet: ProgressionUnmetCode[] = [];
    if (!unlocked) {
      if (!chainUnlocked) unmet.push("PREVIOUS_INCOMPLETE");
      if (holdBlocked) unmet.push("ABSENCE_HOLD");
    } else if (!completed) {
      if (!hasAnyRequirement) {
        unmet.push("NO_COMPLETION_REQUIREMENTS");
      } else {
        if (!videoDone) unmet.push("VIDEO_INCOMPLETE");
        if (!quizDone) unmet.push("QUIZ_NOT_PASSED");
        if (!homeworkDone) unmet.push("HOMEWORK_NOT_SUBMITTED");
      }
    }

    // EFFECTIVE state: access first. `completed` stays the historical fact
    // (own requirements satisfied); `state` answers "what is this lesson to
    // the student right now" — a factually complete but blocked lesson is
    // LOCKED, with `reason`/`unmet` explaining the block. COMPLETED with
    // unlocked=false must never be emitted.
    const state: ProgressionState = !unlocked
      ? "LOCKED"
      : completed
        ? "COMPLETED"
        : "UNLOCKED";

    out.push({
      lessonId: lesson.id,
      order: lesson.order,
      state,
      completed,
      unlocked,
      video: {
        required: videoRequired,
        done: videoDone,
        value: videoValue,
        // The decomposition rides only when required recordings exist —
        // legacy-only lessons keep their exact historical payload shape.
        ...(requiredVideos.length > 0
          ? {
              requiredCount: requiredVideos.length,
              completedCount: videoItems.filter((it) => it.completed).length,
              items: videoItems,
            }
          : {}),
      },
      quiz: {
        required: quizRequired,
        done: quizDone,
        value: !quizRequired || quizDone ? 100 : 0,
      },
      assignment: {
        required: homeworkRequired,
        done: homeworkDone,
        value: !homeworkRequired || homeworkDone ? 100 : 0,
      },
      unmet,
      reason: reasonTextFor(unmet),
      reasonCode: unmet[0] ?? null,
      evidence: {
        video:
          videoRequired && videoDone
            ? {
                percent: videoValue,
                completedAt: legacy?.completedAt ?? null,
              }
            : null,
        quiz:
          quizRequired && quizDone
            ? lesson.quizIds.map((q) => {
                const best = facts.passedAttemptByQuiz.get(q);
                return {
                  attemptId: best?.attemptId ?? "",
                  percentage: best?.percentage ?? 0,
                  passedAt: best?.passedAt ?? null,
                };
              })
            : null,
        homework:
          homeworkRequired && homeworkDone
            ? lesson.homeworkIds.map((h) => {
                const sub = facts.submissionByHomework.get(h);
                return {
                  submittedAt: sub?.submittedAt ?? null,
                  status: sub?.status ?? null,
                };
              })
            : null,
      },
      hold: holdBlocked || (holdBoundaryIndex === i && holdAtBoundary && holdByAffectedLesson.get(lesson.id))
        ? (holdByAffectedLesson.get(lesson.id) ?? holdAtBoundary)
        : null,
      override: override
        ? {
            overrideId: override.overrideId,
            reason: override.reason,
            grantedAt: override.grantedAt,
            expiresAt: override.expiresAt,
          }
        : null,
    });
    previousCompleted = previousCompleted && completed;
  });

  const current = out.find((l) => l.unlocked && !l.completed) ?? null;
  return { lessons: out, currentLessonId: current?.lessonId ?? null };
}

// ---------------------------------------------------------------------------
// Loader — the ONLY database reader of the engine.
// ---------------------------------------------------------------------------
// A fixed, small number of batched queries regardless of lesson count. Track
// slicing of the UNIVERSE stays in Prisma (the Phase 12 predicate); the
// per-row requirement slicing (quiz/homework eligibility, non-empty pools)
// happens in JS through the SAME predicates, so selection and enforcement
// cannot drift apart.

export type LoadCourseProgressionOptions = {
  /** Override the student's stored school type (callers that already read it). */
  schoolType?: SchoolType | string | null;
  /** Clock injection for override expiry (default: now). */
  now?: Date;
};

export async function loadCourseProgression(
  studentId: string,
  courseId: string,
  opts: LoadCourseProgressionOptions = {}
): Promise<CourseProgression> {
  const now = opts.now ?? new Date();

  // NOTE: the engine reads the student's batchId (audience scoping for
  // REQUIRED recordings — the Phase B M2 revision) but NEVER reconciles it:
  // no lazy batch attach (a potential write) belongs on this path. The
  // engine stays read-only; a student with no batch simply resolves no
  // recording audience (and the heartbeat refuses their beats too, so no
  // video fact could exist for them anyway).
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { schoolType: true, batchId: true },
  });
  const schoolType = normalizeSchoolType(
    opts.schoolType !== undefined ? opts.schoolType : (student?.schoolType ?? null)
  );

  const found = (await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      ...EXCLUDE_ARCHIVED_LESSON,
      ...trackScopeWhere(schoolType),
      OR: lessonCourseChainOr(courseId),
    },
    select: {
      ...LESSON_CHAIN_SELECT,
      // Requirement CANDIDATES. Lifecycle first (DRAFT assessments are
      // authoring-only and can never be requirements); the track + non-empty
      // slicing happens in JS below through the canonical predicates.
      quizzes: {
        where: { status: "PUBLISHED" },
        select: { id: true, trackScope: true },
      },
      homeworks: {
        where: { status: { in: ["PUBLISHED", "CLOSED"] } },
        select: { id: true, trackScope: true },
      },
    },
  })) as unknown as Array<
    LessonChain & {
      quizzes: { id: string; trackScope: unknown }[];
      homeworks: { id: string; trackScope: unknown }[];
    }
  >;
  const lessons = orderCourseLessons(found, courseId);
  const lessonIds = lessons.map((l) => l.id);

  // A PUBLISHED quiz is a requirement for THIS student when it is
  // track-eligible. Pool state is deliberately NOT a filter: a misconfigured
  // (empty/unassemblable) quiz must fail LOUD through the quiz path (422, no
  // attempt, progression stays blocked) — never silently drop out of
  // progression against the teacher's intent.
  const requiredQuizByLesson = new Map<string, string[]>();
  const requiredHomeworkByLesson = new Map<string, string[]>();
  for (const lesson of lessons) {
    requiredQuizByLesson.set(
      lesson.id,
      lesson.quizzes
        .filter((q) => canAccessTrackScope(schoolType, q.trackScope))
        .map((q) => q.id)
    );
    requiredHomeworkByLesson.set(
      lesson.id,
      lesson.homeworks
        .filter((h) => canAccessTrackScope(schoolType, h.trackScope))
        .map((h) => h.id)
    );
  }
  const requiredQuizIds = [...new Set([...requiredQuizByLesson.values()].flat())];
  const requiredHomeworkIds = [...new Set([...requiredHomeworkByLesson.values()].flat())];

  // Required recordings — the SAME eligibility the student list applies (own
  // batch + published + track via videoTrackFilter), PLUS the explicit
  // REQUIRED flag, PLUS the universe's lesson scoping (lessonId ∈ course
  // lessons — lifecycle + course + archive slicing inherited by
  // construction). ONE batched query regardless of lesson count; a student
  // with no batch resolves no audience and reads none.
  const studentBatchId = student?.batchId ?? null;
  const requiredVideoRows =
    studentBatchId && lessonIds.length > 0
      ? await db.sessionVideo.findMany({
          where: {
            batchId: studentBatchId,
            isPublished: true,
            isRequiredForProgression: true,
            lessonId: { in: lessonIds },
            ...videoTrackFilter(schoolType),
          },
          select: {
            id: true,
            lessonId: true,
            title: true,
            titleAr: true,
            requiredPercent: true,
            media: { select: { storage: true } },
          },
        })
      : [];
  const requiredVideoIds = [...new Set(requiredVideoRows.map((v) => v.id))];

  const [progressRows, attemptRows, submissionRows, holdRows, overrideRows, videoViewRows] =
    await Promise.all([
      lessonIds.length > 0
        ? db.lessonProgress.findMany({
            where: { studentId, lessonId: { in: lessonIds } },
            select: {
              lessonId: true,
              videoPercent: true,
              videoCompleted: true,
              videoCompletedAt: true,
            },
          })
        : Promise.resolve([] as { lessonId: string; videoPercent: number; videoCompleted: boolean; videoCompletedAt: Date | null }[]),
      // The canonical pass fact: a finished attempt the grader marked passed.
      // Submitted-but-failed attempts satisfy nothing.
      requiredQuizIds.length > 0
        ? db.quizAttempt.findMany({
            where: {
              studentId,
              quizId: { in: requiredQuizIds },
              finishedAt: { not: null },
              passed: true,
            },
            select: { id: true, quizId: true, percentage: true, finishedAt: true },
          })
        : Promise.resolve([] as { id: string; quizId: string; percentage: number; finishedAt: Date | null }[]),
      requiredHomeworkIds.length > 0
        ? db.homeworkSubmission.findMany({
            where: {
              studentId,
              homeworkId: { in: requiredHomeworkIds },
              submittedAt: { not: null },
            },
            select: { homeworkId: true, submittedAt: true, status: true },
          })
        : Promise.resolve([] as { homeworkId: string; submittedAt: Date | null; status: unknown }[]),
      // Phase F output, read verbatim: only ACTIVE holds draw a boundary.
      // An EXCUSED case carries a RESOLVED hold (or none) and never blocks.
      db.absenceHold.findMany({
        where: { studentId, status: "ACTIVE" },
        select: {
          id: true,
          absenceReviewId: true,
          sessionId: true,
          absenceReview: { select: { lessonId: true } },
        },
      }),
      db.progressionOverride.findMany({
        where: { studentId },
        select: {
          id: true,
          lessonId: true,
          reason: true,
          createdAt: true,
          expiresAt: true,
          revokedAt: true,
        },
      }),
      // Live watch percent per required recording (percent ONLY — the sticky
      // isCompleted flag is history and is deliberately never selected).
      requiredVideoIds.length > 0
        ? db.sessionVideoView.findMany({
            where: { studentId, sessionVideoId: { in: requiredVideoIds } },
            select: { sessionVideoId: true, percent: true },
          })
        : Promise.resolve([] as { sessionVideoId: string; percent: number }[]),
    ]);

  const requiredVideosByLesson = new Map<
    string,
    { id: string; title: string; titleAr: string; requiredPercent: number; trackable: boolean }[]
  >();
  for (const v of requiredVideoRows) {
    if (!v.lessonId) continue;
    const list = requiredVideosByLesson.get(v.lessonId) ?? [];
    list.push({
      id: v.id,
      title: v.title,
      titleAr: v.titleAr,
      requiredPercent: v.requiredPercent ?? VIDEO_COMPLETION_THRESHOLD,
      trackable: isManagedPrivateStorage(
        (v.media as { storage: unknown } | null)?.storage
      ),
    });
    requiredVideosByLesson.set(v.lessonId, list);
  }
  // Deterministic item order regardless of storage order.
  for (const list of requiredVideosByLesson.values()) {
    list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  const coreLessons: ProgressionCoreLesson[] = lessons.map((l) => ({
    id: l.id,
    order: l.order,
    hasLegacyVideo: !!l.videoUrl,
    requiredVideos: requiredVideosByLesson.get(l.id) ?? [],
    quizIds: requiredQuizByLesson.get(l.id) ?? [],
    homeworkIds: requiredHomeworkByLesson.get(l.id) ?? [],
  }));

  const legacyVideoByLesson = new Map<string, { percent: number; completed: boolean; completedAt: string | null }>(
    progressRows.map((p) => [
      p.lessonId,
      {
        percent: p.videoPercent ?? 0,
        completed: !!p.videoCompleted,
        completedAt: p.videoCompletedAt ? new Date(p.videoCompletedAt).toISOString() : null,
      },
    ])
  );
  const passedQuizIds = new Set<string>(attemptRows.map((a) => a.quizId));
  const passedAttemptByQuiz = new Map<string, { attemptId: string; percentage: number; passedAt: string | null }>(
    attemptRows.map((a) => [
      a.quizId,
      {
        attemptId: a.id,
        percentage: a.percentage ?? 0,
        passedAt: a.finishedAt ? new Date(a.finishedAt).toISOString() : null,
      },
    ])
  );
  const videoWatchPercent = new Map<string, number>(
    videoViewRows.map((w) => [w.sessionVideoId, w.percent ?? 0])
  );
  const submittedHomeworkIds = new Set<string>(submissionRows.map((s) => s.homeworkId));
  const submissionByHomework = new Map<string, { submittedAt: string | null; status: string | null }>(
    submissionRows.map((s) => [
      s.homeworkId,
      {
        submittedAt: s.submittedAt ? new Date(s.submittedAt).toISOString() : null,
        status: s.status !== null && s.status !== undefined ? String(s.status) : null,
      },
    ])
  );

  const holds: ProgressionCoreHold[] = (
    holdRows as {
      id: string;
      absenceReviewId: string;
      sessionId: string;
      absenceReview: { lessonId: string | null } | null;
    }[]
  ).map((h) => ({
    holdId: h.id,
    reviewId: h.absenceReviewId,
    sessionId: h.sessionId,
    lessonId: h.absenceReview?.lessonId ?? null,
  }));

  const overrides: ProgressionCoreOverride[] = (
    overrideRows as {
      id: string;
      lessonId: string;
      reason: string;
      createdAt: Date;
      expiresAt: Date | null;
      revokedAt: Date | null;
    }[]
  )
    .filter((o) => isOverrideRowActive(o, now))
    .map((o) => ({
      overrideId: o.id,
      lessonId: o.lessonId,
      reason: o.reason,
      grantedAt: new Date(o.createdAt).toISOString(),
      expiresAt: o.expiresAt ? new Date(o.expiresAt).toISOString() : null,
    }));

  const { lessons: evaluated, currentLessonId } = evaluateProgressionCore({
    lessons: coreLessons,
    facts: {
      legacyVideoByLesson,
      videoWatchPercent,
      passedQuizIds,
      passedAttemptByQuiz,
      submittedHomeworkIds,
      submissionByHomework,
    },
    holds,
    overrides,
  });

  // Boundary: the initial contiguous accessible run, the first hold-blocked
  // lesson, and every override island.
  let contiguousLessonId: string | null = null;
  for (const e of evaluated) {
    if (!e.unlocked) break;
    contiguousLessonId = e.lessonId;
  }
  const holdBlockedFromLessonId =
    evaluated.find((e) => !e.unlocked && e.reasonCode === "ABSENCE_HOLD")
      ?.lessonId ?? null;
  const overriddenLessonIds = evaluated
    .filter((e) => e.override !== null)
    .map((e) => e.lessonId);

  return {
    courseId,
    studentId,
    lessons: evaluated,
    byLessonId: new Map(evaluated.map((e) => [e.lessonId, e])),
    currentLessonId,
    holds: holds.map((h) => ({ ...h })),
    overrides: overrides.map((o) => ({
      overrideId: o.overrideId,
      reason: o.reason,
      grantedAt: o.grantedAt,
      expiresAt: o.expiresAt,
    })),
    boundary: { contiguousLessonId, holdBlockedFromLessonId, overriddenLessonIds },
    evaluatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Single-lesson access — the verdict every protected read delegates to.
// ---------------------------------------------------------------------------

export type CanonicalAccessReason =
  | null
  | "NOT_ENROLLED"
  | "LESSON_NOT_FOUND"
  | "PREVIOUS_SESSION_INCOMPLETE"
  | "ABSENCE_HOLD";

export type CanonicalLessonAccess = {
  allowed: boolean;
  reason: CanonicalAccessReason;
  evaluation: LessonEvaluation | null;
  courseId: string | null;
};

/**
 * Server-side authorization for opening a single lesson. Structural gates
 * first (existence, lifecycle, archive, course, enrollment + entitlement,
 * track — each fail-closed with a non-oracle verdict), then the canonical
 * evaluation. An override grants its named lesson; nothing else bypasses.
 */
export async function evaluateLessonAccess(
  studentId: string,
  lessonId: string,
  opts: { now?: Date } = {}
): Promise<CanonicalLessonAccess> {
  const now = opts.now ?? new Date();
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      ...LESSON_CHAIN_SELECT,
      trackScope: true,
      status: true,
      curriculumStatus: true,
    },
  });
  if (!lesson) return { allowed: false, reason: "LESSON_NOT_FOUND", evaluation: null, courseId: null };

  // Lifecycle + archive: a staged or historical lesson does not exist for
  // students. Indistinguishable from a nonexistent id (no oracle).
  if (
    !isStudentVisibleStatus(lesson.status) ||
    String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED"
  ) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", evaluation: null, courseId: null };
  }

  const courseId = resolveLessonCourseId(lesson);
  if (!courseId) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", evaluation: null, courseId: null };
  }

  // Enrollment + paid entitlement: the shared decision, read-only. An override
  // never bypasses this — it is a progression exception, not an enrollment one.
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      schoolType: true,
      group: { select: { courseId: true, isActive: true } },
      subscription: { select: { status: true, endDate: true } },
    },
  });
  if (!student) return { allowed: false, reason: "NOT_ENROLLED", evaluation: null, courseId };
  const entitled = evaluateAccessDecision({
    groupActive:
      !!student.group &&
      student.group.isActive &&
      student.group.courseId === courseId,
    subscription: student.subscription,
  });
  if (!entitled.allowed) {
    return { allowed: false, reason: "NOT_ENROLLED", evaluation: null, courseId };
  }

  // Track: the other school type's lesson is a 404, never a 403 (no oracle).
  const schoolType = normalizeSchoolType(student.schoolType);
  if (!canAccessTrackScope(schoolType, lesson.trackScope)) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", evaluation: null, courseId };
  }

  const progression = await loadCourseProgression(studentId, courseId, {
    schoolType,
    now,
  });
  const evaluation = progression.byLessonId.get(lessonId) ?? null;
  if (!evaluation) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", evaluation: null, courseId };
  }
  if (!evaluation.unlocked) {
    return {
      allowed: false,
      reason:
        evaluation.reasonCode === "ABSENCE_HOLD"
          ? "ABSENCE_HOLD"
          : "PREVIOUS_SESSION_INCOMPLETE",
      evaluation,
      courseId,
    };
  }
  return { allowed: true, reason: null, evaluation, courseId };
}

// ---------------------------------------------------------------------------
// Admin progression override — the audited exception.
// ---------------------------------------------------------------------------

export const OVERRIDE_REASON_MIN_LENGTH = 3;
export const OVERRIDE_REASON_MAX_LENGTH = 500;

export type OverrideReasonValidation =
  | { ok: true; reason: string }
  | { ok: false; code: "OVERRIDE_REASON_REQUIRED" | "OVERRIDE_REASON_TOO_LONG" };

export function normalizeOverrideReason(raw: unknown): OverrideReasonValidation {
  if (typeof raw !== "string") return { ok: false, code: "OVERRIDE_REASON_REQUIRED" };
  const reason = raw.replace(/\s+/g, " ").trim();
  if (reason.length < OVERRIDE_REASON_MIN_LENGTH) {
    return { ok: false, code: "OVERRIDE_REASON_REQUIRED" };
  }
  if (reason.length > OVERRIDE_REASON_MAX_LENGTH) {
    return { ok: false, code: "OVERRIDE_REASON_TOO_LONG" };
  }
  return { ok: true, reason };
}

/** Read-time activity: revoked rows and expired rows never grant access. */
export function isOverrideRowActive(
  row: { revokedAt: Date | string | null; expiresAt: Date | string | null },
  now: Date = new Date()
): boolean {
  if (row.revokedAt !== null && row.revokedAt !== undefined) return false;
  if (row.expiresAt === null || row.expiresAt === undefined) return true;
  return new Date(row.expiresAt).getTime() > now.getTime();
}

export type GrantOverrideResult =
  | { ok: true; overrideId: string; replay: boolean }
  | { ok: false; code: string; message: string };

/**
 * Grant a student access to a lesson as an audited exception. ADMIN-only at
 * the route layer; this service re-validates everything from live rows:
 *
 *   * the student and the lesson both exist;
 *   * the lesson is PUBLISHED and non-archived (an override is not a
 *     publication bypass);
 *   * the lesson is in the student's enrolled course (active group);
 *   * the lesson is track-eligible for the student (an override NEVER
 *     crosses the Phase 12 track boundary);
 *   * the reason is explicit (3..500 chars);
 *   * the expiry, when given, is in the future.
 *
 * Idempotent: re-granting an already-active (student, lesson) override
 * replays the existing row — no duplicate, no second audit row.
 *
 * It NEVER writes an academic fact: no quiz pass, no submission, no video
 * row, no attendance row, no hold mutation, no COMPLETED rewrite.
 */
export async function grantProgressionOverride(input: {
  studentId: string;
  lessonId: string;
  reason: unknown;
  expiresAt?: unknown;
  actorUserId: string;
  now?: Date;
}): Promise<GrantOverrideResult> {
  const now = input.now ?? new Date();
  const validated = normalizeOverrideReason(input.reason);
  if (!validated.ok) {
    return {
      ok: false,
      code: validated.code,
      message:
        validated.code === "OVERRIDE_REASON_REQUIRED"
          ? "A reason is required"
          : "The reason is too long",
    };
  }

  let expiresAt: Date | null = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null && String(input.expiresAt).trim() !== "") {
    const parsed = new Date(String(input.expiresAt));
    if (!Number.isFinite(parsed.getTime())) {
      return { ok: false, code: "OVERRIDE_EXPIRY_INVALID", message: "The expiry is not a valid date" };
    }
    if (parsed.getTime() <= now.getTime()) {
      return { ok: false, code: "OVERRIDE_EXPIRY_PAST", message: "The expiry must be in the future" };
    }
    expiresAt = parsed;
  }

  const [student, lesson] = await Promise.all([
    db.student.findUnique({
      where: { id: input.studentId },
      select: {
        id: true,
        schoolType: true,
        group: { select: { courseId: true, isActive: true } },
      },
    }),
    db.lesson.findUnique({
      where: { id: input.lessonId },
      select: {
        ...LESSON_CHAIN_SELECT,
        trackScope: true,
        status: true,
        curriculumStatus: true,
      },
    }),
  ]);
  if (!student) return { ok: false, code: "STUDENT_NOT_FOUND", message: "Student not found" };
  if (!lesson) return { ok: false, code: "LESSON_NOT_FOUND", message: "Lesson not found" };
  if (
    !isStudentVisibleStatus(lesson.status) ||
    String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED"
  ) {
    return { ok: false, code: "LESSON_NOT_GRANTABLE", message: "Only published, non-archived lessons can be granted" };
  }
  const courseId = resolveLessonCourseId(lesson);
  if (
    !courseId ||
    !student.group ||
    !student.group.isActive ||
    student.group.courseId !== courseId
  ) {
    return { ok: false, code: "LESSON_NOT_IN_COURSE", message: "The lesson is not in the student's enrolled course" };
  }
  if (!canAccessTrackScope(normalizeSchoolType(student.schoolType), lesson.trackScope)) {
    return { ok: false, code: "TRACK_DENIED", message: "The lesson is not in the student's track" };
  }

  const existing = await db.progressionOverride.findMany({
    where: { studentId: input.studentId, lessonId: input.lessonId },
    select: { id: true, revokedAt: true, expiresAt: true },
  });
  const active = existing.find((o) => isOverrideRowActive(o, now));
  if (active) return { ok: true, overrideId: active.id, replay: true };

  const created = await db.progressionOverride.create({
    data: {
      studentId: input.studentId,
      lessonId: input.lessonId,
      reason: validated.reason,
      createdByUserId: input.actorUserId,
      expiresAt,
    },
    select: { id: true },
  });

  await db.auditLog
    .create({
      data: {
        userId: input.actorUserId,
        action: "PROGRESSION_OVERRIDE_GRANTED",
        entity: "ProgressionOverride",
        entityId: created.id,
        details: JSON.stringify({
          studentId: input.studentId,
          lessonId: input.lessonId,
          courseId,
          expiresAt: expiresAt ? expiresAt.toISOString() : null,
          reasonLength: validated.reason.length,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return { ok: true, overrideId: created.id, replay: false };
}

export type RevokeOverrideResult =
  | { ok: true; replay: boolean }
  | { ok: false; code: string; message: string };

/**
 * Revoke an override (append-only: the row survives with `revokedAt` set, so
 * the audit trail stays complete). Idempotent: revoking twice replays.
 */
export async function revokeProgressionOverride(input: {
  overrideId: string;
  actorUserId: string;
  reason?: unknown;
  now?: Date;
}): Promise<RevokeOverrideResult> {
  const now = input.now ?? new Date();
  const row = await db.progressionOverride.findUnique({
    where: { id: input.overrideId },
    select: { id: true, studentId: true, lessonId: true, revokedAt: true },
  });
  if (!row) return { ok: false, code: "OVERRIDE_NOT_FOUND", message: "Override not found" };
  if (row.revokedAt) return { ok: true, replay: true };

  const revokeReason =
    typeof input.reason === "string" && input.reason.replace(/\s+/g, " ").trim()
      ? input.reason.replace(/\s+/g, " ").trim().slice(0, OVERRIDE_REASON_MAX_LENGTH)
      : null;

  await db.progressionOverride.update({
    where: { id: row.id },
    data: { revokedAt: now, revokedByUserId: input.actorUserId, revokeReason },
  });

  await db.auditLog
    .create({
      data: {
        userId: input.actorUserId,
        action: "PROGRESSION_OVERRIDE_REVOKED",
        entity: "ProgressionOverride",
        entityId: row.id,
        details: JSON.stringify({
          studentId: row.studentId,
          lessonId: row.lessonId,
          hasReason: revokeReason !== null,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return { ok: true, replay: false };
}

export type OverrideListItem = {
  id: string;
  studentId: string;
  lessonId: string;
  reason: string;
  createdByUserId: string;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokedByUserId: string | null;
  revokeReason: string | null;
  active: boolean;
  /** Lesson identity for the audit UI (null when the lesson row is gone). */
  lesson: {
    id: string;
    title: string;
    titleAr: string;
    officialCode: string | null;
  } | null;
  /** Granting Admin (audit identity; id always present, name best-effort). */
  grantedBy: { id: string; name: string | null } | null;
  /** Revoking Admin, when revoked. */
  revokedBy: { id: string; name: string | null } | null;
};

export async function listProgressionOverrides(input: {
  studentId?: string | null;
  lessonId?: string | null;
  limit?: number;
  now?: Date;
}): Promise<OverrideListItem[]> {
  const now = input.now ?? new Date();
  const where: Record<string, unknown> = {};
  if (input.studentId) where.studentId = input.studentId;
  if (input.lessonId) where.lessonId = input.lessonId;
  const rows = await db.progressionOverride.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: Math.min(Math.max(input.limit ?? 100, 1), 200),
    select: {
      id: true,
      studentId: true,
      lessonId: true,
      reason: true,
      createdByUserId: true,
      createdAt: true,
      expiresAt: true,
      revokedAt: true,
      revokedByUserId: true,
      revokeReason: true,
    },
  });
  // Audit identities: lesson titles + Admin names, batched (two queries for
  // the whole page, never N+1).
  const lessonIds = [...new Set(rows.map((r) => String(r.lessonId)))];
  const userIds = [
    ...new Set(
      rows
        .flatMap((r) => [r.createdByUserId, r.revokedByUserId])
        .filter((v): v is string => typeof v === "string" && v.length > 0)
    ),
  ];
  // Sequential + explicitly typed: the generated client is `any` in this
  // repo's toolchain, so tuple inference through Promise.all collapses.
  const lessons: { id: string; title: string; titleAr: string; officialCode: string | null }[] =
    lessonIds.length > 0
      ? await db.lesson.findMany({
          where: { id: { in: lessonIds } },
          select: { id: true, title: true, titleAr: true, officialCode: true },
        })
      : [];
  const users: { id: string; name: string | null }[] =
    userIds.length > 0
      ? await db.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
  const lessonById = new Map<string, { id: string; title: string; titleAr: string; officialCode: string | null }>(
    lessons.map((l) => [l.id, l])
  );
  const userById = new Map<string, { id: string; name: string | null }>(users.map((u) => [u.id, u]));
  return rows.map((r) => {
    const lesson = lessonById.get(String(r.lessonId)) ?? null;
    const granter = userById.get(String(r.createdByUserId)) ?? null;
    const revoker =
      (r.revokedByUserId && userById.get(String(r.revokedByUserId))) || null;
    return {
      id: r.id,
      studentId: r.studentId,
      lessonId: r.lessonId,
      reason: r.reason,
      createdByUserId: r.createdByUserId,
      createdAt: new Date(r.createdAt).toISOString(),
      expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
      revokedAt: r.revokedAt ? new Date(r.revokedAt).toISOString() : null,
      revokedByUserId: r.revokedByUserId ?? null,
      revokeReason: r.revokeReason ?? null,
      active: isOverrideRowActive(r, now),
      lesson: lesson
        ? {
            id: lesson.id,
            title: lesson.title,
            titleAr: lesson.titleAr,
            officialCode: lesson.officialCode ?? null,
          }
        : null,
      grantedBy: granter
        ? { id: granter.id, name: granter.name ?? null }
        : { id: String(r.createdByUserId), name: null },
      revokedBy: revoker
        ? { id: revoker.id, name: revoker.name ?? null }
        : r.revokedByUserId
          ? { id: String(r.revokedByUserId), name: null }
          : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Catch-up — deterministic eligibility, Phase F resolution.
// ---------------------------------------------------------------------------

export type CatchupHold = {
  holdId: string;
  reviewId: string;
  sessionId: string;
  lessonId: string | null;
  lessonTitle: string | null;
  courseId: string | null;
  /** False when the missed lesson is gone from every curriculum (vacuous). */
  inUniverse: boolean;
  /** The missed lesson's own requirements (empty when vacuous). */
  requirements: {
    video: ProgressionRequirement;
    quiz: ProgressionRequirement;
    assignment: ProgressionRequirement;
  } | null;
  unmet: ProgressionUnmetCode[];
  reason: string | null;
  eligible: boolean;
};

/**
 * Public catch-up hold view: `CatchupHold` minus internal Phase F ids, with
 * `unmet` widened into labeled entries. The ONLY shape catch-up holds take
 * across the API (student catch-up route, student dashboard) — both serialize
 * through `toCatchupHoldView`, so the two surfaces can never disagree.
 */
export type CatchupHoldView = {
  holdId: string;
  lessonId: string | null;
  lessonTitle: string | null;
  courseId: string | null;
  inUniverse: boolean;
  requirements: CatchupHold["requirements"];
  unmet: ProgressionUnmetEntry[];
  reason: string | null;
  eligible: boolean;
};

export function toCatchupHoldView(hold: CatchupHold): CatchupHoldView {
  return {
    holdId: hold.holdId,
    lessonId: hold.lessonId,
    lessonTitle: hold.lessonTitle,
    courseId: hold.courseId,
    inUniverse: hold.inUniverse,
    requirements: hold.requirements,
    unmet: toUnmetEntries(hold.unmet),
    reason: hold.reason,
    eligible: hold.eligible,
  };
}

/**
 * Evaluate every ACTIVE hold of a student for catch-up resolution. Deterministic
 * and read-only: the same rows always produce the same eligibility.
 *
 * A hold is eligible iff its missed lesson's OWN academic requirements are
 * satisfied (video ≥ threshold, every required quiz PASSED, every required
 * homework SUBMITTED) — or iff the missed lesson is unidentifiable / outside
 * every curriculum, in which case there is nothing to catch up on. Eligibility
 * never depends on neighbouring lessons, on attendance, or on grading.
 */
export async function evaluateStudentCatchup(
  studentId: string,
  opts: { now?: Date } = {}
): Promise<{ holds: CatchupHold[] }> {
  const now = opts.now ?? new Date();
  const holds = await db.absenceHold.findMany({
    where: { studentId, status: "ACTIVE" },
    select: {
      id: true,
      absenceReviewId: true,
      sessionId: true,
      absenceReview: { select: { lessonId: true, groupId: true } },
    },
  });
  if (holds.length === 0) return { holds: [] };

  // The missed lessons' courses (canonical-first chain; the group course the
  // case was opened under is the fallback for chain-less rows).
  const lessonIds = [
    ...new Set(
      holds
        .map((h) => (h.absenceReview?.lessonId ?? null) as string | null)
        .filter((id): id is string => !!id)
    ),
  ];
  const lessonRows =
    lessonIds.length > 0
      ? await db.lesson.findMany({
          where: { id: { in: lessonIds } },
          select: { ...LESSON_CHAIN_SELECT, title: true, titleAr: true },
        })
      : [];
  const lessonById = new Map<string, any>(lessonRows.map((l) => [l.id, l]));
  const groupIds = [
    ...new Set(
      holds
        .map((h) => (h.absenceReview?.groupId ?? null) as string | null)
        .filter((id): id is string => !!id)
    ),
  ];
  const groupRows =
    groupIds.length > 0
      ? await db.group.findMany({
          where: { id: { in: groupIds } },
          select: { id: true, courseId: true },
        })
      : [];
  const courseByGroup = new Map<string, string>(groupRows.map((g) => [g.id, g.courseId]));

  // One evaluation per distinct course (a student rarely holds cases across
  // courses, but the shape stays correct when they do).
  const courseByHold = new Map<string, string | null>();
  for (const hold of holds) {
    const lessonId = (hold.absenceReview?.lessonId ?? null) as string | null;
    const lesson = lessonId ? lessonById.get(lessonId) : undefined;
    const viaLesson = lesson ? resolveLessonCourseId(lesson as LessonChain) : null;
    const viaGroup = hold.absenceReview?.groupId
      ? (courseByGroup.get(hold.absenceReview.groupId as string) ?? null)
      : null;
    courseByHold.set(hold.id, viaLesson ?? viaGroup ?? null);
  }
  const courseIds = [...new Set([...courseByHold.values()].filter((c): c is string => !!c))];
  const progressByCourse = new Map<string, CourseProgression>();
  for (const courseId of courseIds) {
    progressByCourse.set(courseId, await loadCourseProgression(studentId, courseId, { now }));
  }

  const out: CatchupHold[] = holds.map((hold) => {
    const lessonId = (hold.absenceReview?.lessonId ?? null) as string | null;
    const courseId = courseByHold.get(hold.id) ?? null;
    const lesson = lessonId ? lessonById.get(lessonId) : undefined;
    const evaluation =
      lessonId && courseId
        ? (progressByCourse.get(courseId)?.byLessonId.get(lessonId) ?? null)
        : null;
    if (!lessonId || !courseId || !evaluation) {
      // Nothing identifiable to catch up on: immediately eligible, so the
      // student is never trapped by a hold that names no curriculum.
      return {
        holdId: hold.id,
        reviewId: hold.absenceReviewId,
        sessionId: hold.sessionId,
        lessonId,
        lessonTitle: lesson ? String((lesson.titleAr ?? lesson.title) || "") || null : null,
        courseId,
        inUniverse: false,
        requirements: null,
        unmet: [],
        reason: null,
        eligible: true,
      };
    }
    // Catch-up uses only requirements that ACTUALLY exist. Eligibility is
    // "nothing pending" (vacuous for an empty missed lesson: no recovery
    // work exists to do, so the hold resolves while the empty lesson itself
    // stays a chain boundary) — deliberately NOT `evaluation.completed`,
    // which is false for empty lessons by the progression contract above.
    const unmet: ProgressionUnmetCode[] = [];
    if (evaluation.video.required && !evaluation.video.done) unmet.push("VIDEO_INCOMPLETE");
    if (evaluation.quiz.required && !evaluation.quiz.done) unmet.push("QUIZ_NOT_PASSED");
    if (evaluation.assignment.required && !evaluation.assignment.done) {
      unmet.push("HOMEWORK_NOT_SUBMITTED");
    }
    return {
      holdId: hold.id,
      reviewId: hold.absenceReviewId,
      sessionId: hold.sessionId,
      lessonId,
      lessonTitle: lesson ? String((lesson.titleAr ?? lesson.title) || "") || null : null,
      courseId,
      inUniverse: true,
      requirements: {
        video: evaluation.video,
        quiz: evaluation.quiz,
        assignment: evaluation.assignment,
      },
      unmet,
      reason: reasonTextFor(unmet.length > 0 ? unmet : (["ABSENCE_HOLD"] as const)),
      eligible: unmet.length === 0,
    };
  });

  return { holds: out };
}

// Catch-up RESOLUTION lives in `@/lib/catchup` (see that module's header for
// why): it is the only place that pairs the read-only eligibility above with
// the Phase F `resolveHoldForCatchup` authority, so the engine's compile
// graph stays free of the notification modules.

// ---------------------------------------------------------------------------
// Derived-completion sync — keeps the legacy marker converged, honestly.
// ---------------------------------------------------------------------------
// `LessonProgress.isCompleted` is the historical aggregate marker (certificate,
// gamification, reports, exports). It used to be CLIENT-claimable (POST
// { completed: true } with only a video guard). Phase H closes that: the ONLY
// writer that may SET it is this sync, which derives it from the canonical
// engine — and the ONLY other writer is the progress route's explicit
// unmark ({ completed: false }). Legacy rows are never rewritten to false.

export type SyncDerivedCompletionResult = {
  /** The canonical completion verdict for this lesson. */
  completed: boolean;
  /** True when a write brought the legacy marker up to date. */
  synced: boolean;
};

/**
 * Bring `LessonProgress.isCompleted` up to the canonical verdict for one
 * lesson. Monotonic: it only ever flips false → true, never true → false,
 * and it never creates academic facts — it mirrors the derivation.
 * NEVER throws (same contract as `maybeResolveCatchup`).
 */
export async function syncDerivedCompletion(
  studentId: string,
  lessonId: string
): Promise<SyncDerivedCompletionResult> {
  try {
    const lesson = await db.lesson.findUnique({
      where: { id: lessonId },
      select: LESSON_CHAIN_SELECT,
    });
    if (!lesson) return { completed: false, synced: false };
    const courseId = resolveLessonCourseId(lesson as LessonChain);
    if (!courseId) return { completed: false, synced: false };
    const progression = await loadCourseProgression(studentId, courseId);
    // Sync mirrors the derivation: empty (zero-requirement) lessons evaluate
    // to `completed: false`, so the guard below exits before any write.
    const evaluation = progression.byLessonId.get(lessonId) ?? null;
    if (!evaluation?.completed) return { completed: false, synced: false };
    const existing = await db.lessonProgress.findUnique({
      where: { studentId_lessonId: { studentId, lessonId } },
      select: { isCompleted: true },
    });
    if (existing?.isCompleted) return { completed: true, synced: false };
    await db.lessonProgress.upsert({
      where: { studentId_lessonId: { studentId, lessonId } },
      create: {
        studentId,
        lessonId,
        progress: 100,
        isCompleted: true,
        lastViewedAt: new Date(),
      },
      update: { isCompleted: true },
    });
    return { completed: true, synced: true };
  } catch {
    return { completed: false, synced: false };
  }
}
