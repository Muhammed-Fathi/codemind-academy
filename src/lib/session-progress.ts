// CodeMind Academy — Session (lesson) progression & access control.
//
// Phase H: this module is now a THIN COMPATIBILITY ADAPTER over the canonical
// engine (`src/lib/progression.ts`). It keeps its historical export surface —
// every route, component and lib that imported from here keeps working
// unchanged — but every verdict is computed by the canonical authority.
//
//   getCourseSessionProgress → loadCourseProgression (same rows, same order)
//   canAccessLesson          → evaluateLessonAccess
//   canAccessQuiz/Homework   → unchanged delegation (lifecycle + own-track +
//                              the canonical lesson verdict)
//   getUnlockedLessonIds     → the canonical accessible set
//
// The universe helpers (dual-chain attachment, archived exclusion, track
// slicing, deterministic order) MOVED to the canonical engine and are
// re-exported here, so existing importers never notice the move.
//
// Two INTENTIONAL behaviour changes land with the delegation (both are Phase H
// product decisions, not regressions):
//   1. QUIZ = PASSED, not attempted. A finished-but-failed attempt no longer
//      satisfies a lesson's quiz requirement; the student must genuinely pass
//      (or receive an Admin retry grant / progression override).
//   2. ACTIVE absence holds draw a forward progression boundary (new
//      `ABSENCE_HOLD` denial reason): lessons after the missed lesson stay
//      locked until catch-up resolution, while the missed lesson itself, its
//      recovery content, its recording, and historical COMPLETED lessons stay
//      accessible.
// Plus one latent-deadlock FIX that only ever unblocks: cross-track
// quiz/homework rows on a SHARED lesson are excluded from requirements.
// (Recordings stay NON-INPUTS per Phase B M2: publishing or watching a batch
// SessionVideo can neither create nor satisfy a requirement.)

import { db } from "@/lib/db";
import {
  canAccessTrackScope,
} from "@/lib/track-scope";
import type { SchoolType } from "@/lib/school-type";
import { getStudentSchoolType } from "@/lib/enrollment";
import { evaluateAccessDecision } from "@/lib/subscription-entitlement";
import {
  evaluateLessonAccess,
  loadCourseProgression,
  toUnmetEntries,
  type CanonicalAccessReason,
  type LessonEvaluation,
  type ProgressionUnmetEntry,
} from "@/lib/progression";

// The universe contract lives in the canonical engine; re-exported so every
// existing importer (`@/lib/session-progress`) keeps resolving.
export {
  EXCLUDE_ARCHIVED_LESSON,
  lessonCourseChainOr,
  lessonCoursesChainOr,
  LESSON_CHAIN_SELECT,
  resolveLessonCourseId,
  orderCourseLessons,
  type LessonChain,
} from "@/lib/progression";

export type SessionRequirement = {
  /** Whether this lesson actually has the component at all. */
  required: boolean;
  done: boolean;
  /** 0-100 where meaningful (video), else 0/100. */
  value: number;
};

export type SessionStatusRow = {
  lessonId: string;
  order: number;
  /** true when the lesson has ≥1 requirement AND all are satisfied. */
  completed: boolean;
  /** true when the student is allowed to open this lesson. */
  unlocked: boolean;
  video: SessionRequirement;
  quiz: SessionRequirement;
  assignment: SessionRequirement;
  // --- Phase H canonical extensions (additive; historical readers ignore them) ---
  /** LOCKED / UNLOCKED / COMPLETED. */
  state?: string;
  /** Structured unmet requirements (stable codes + Arabic labels, priority-ordered). */
  unmet?: ProgressionUnmetEntry[];
  /** Arabic-first human-readable reason (null when nothing blocks). */
  reason?: string | null;
  /** The primary code behind `reason` (null when nothing blocks). */
  reasonCode?: string | null;
};

export type CourseSessionProgress = {
  courseId: string;
  /** Ordered lessons with their gating status. */
  sessions: SessionStatusRow[];
  byLessonId: Map<string, SessionStatusRow>;
  /** First lesson the student should work on. */
  currentLessonId: string | null;
};

function toSessionStatusRow(evaluation: LessonEvaluation): SessionStatusRow {
  return {
    lessonId: evaluation.lessonId,
    order: evaluation.order,
    completed: evaluation.completed,
    unlocked: evaluation.unlocked,
    video: { ...evaluation.video },
    quiz: { ...evaluation.quiz },
    assignment: { ...evaluation.assignment },
    state: evaluation.state,
    unmet: toUnmetEntries(evaluation.unmet),
    reason: evaluation.reason,
    reasonCode: evaluation.reasonCode,
  };
}

/**
 * Compute the gating state of every lesson of `courseId` for `studentId`.
 * Delegates to the canonical engine; same rows, same order, same shape —
 * with the Phase H rule matrix (PASS-based quiz, hold boundary, overrides).
 */
export async function getCourseSessionProgress(
  studentId: string,
  courseId: string,
  schoolType?: SchoolType | string | null
): Promise<CourseSessionProgress> {
  const progression = await loadCourseProgression(studentId, courseId, {
    ...(schoolType === undefined ? {} : { schoolType }),
  });
  const sessions = progression.lessons.map(toSessionStatusRow);
  return {
    courseId,
    sessions,
    byLessonId: new Map(sessions.map((s) => [s.lessonId, s])),
    currentLessonId: progression.currentLessonId,
  };
}

export type AccessReason = CanonicalAccessReason;

export type LessonAccess = {
  allowed: boolean;
  reason: AccessReason;
  status: SessionStatusRow | null;
};

/**
 * Gating result for a resource that hangs off a lesson (quiz, homework).
 * `evaluation` carries the canonical lesson verdict (safe subset) so denied
 * responses can explain themselves in Arabic without leaking protected
 * content; it is absent when the lesson itself is not visible.
 */
export type ResourceAccess = {
  allowed: boolean;
  reason: AccessReason;
  evaluation?: SessionStatusRow | null;
};

/**
 * Server-side authorization for opening a single lesson. Delegates to the
 * canonical engine — the single definition of "may this student open this
 * session". Must be called by every route that returns lesson content.
 */
export async function canAccessLesson(
  studentId: string,
  lessonId: string
): Promise<LessonAccess> {
  const access = await evaluateLessonAccess(studentId, lessonId);
  return {
    allowed: access.allowed,
    reason: access.reason,
    status: access.evaluation ? toSessionStatusRow(access.evaluation) : null,
  };
}

// ---------------------------------------------------------------------------
// Resource-level gating (quiz, homework)
// ---------------------------------------------------------------------------
//
// A quiz or an assignment is only ever reachable through the session it
// belongs to. Both helpers resolve to the OWNING LESSON and then re-use the
// canonical lesson verdict, so there is exactly one definition of "may this
// student open this session".

/**
 * Gate a resource that belongs to a lesson AND carries its own trackScope.
 *
 * Two independent conditions, both fail-closed:
 *   1. the owning lesson must be open to this student (the canonical lesson
 *      verdict, which already enforces enrollment, the lesson's own
 *      trackScope, lifecycle, the sequential gate, the hold boundary and
 *      overrides);
 *   2. the resource's OWN trackScope must be eligible for the student.
 *
 * Condition 2 is not redundant: a SHARED lesson may legitimately host an
 * ARABIC quiz and a LANGUAGE quiz, so the resource scope can be narrower than
 * the lesson scope.
 */
async function gateTrackedResource(
  studentId: string,
  lessonId: string | null,
  trackScope: unknown
): Promise<ResourceAccess> {
  if (!lessonId) return { allowed: false, reason: "LESSON_NOT_FOUND" };

  const access = await canAccessLesson(studentId, lessonId);
  if (!access.allowed) {
    return { allowed: false, reason: access.reason, evaluation: access.status };
  }

  const schoolType = await getStudentSchoolType(studentId);
  if (!canAccessTrackScope(schoolType, trackScope)) {
    // Same non-oracle answer as "this resource does not exist": a student
    // probing the other track's quiz/homework ids learns nothing.
    return { allowed: false, reason: "LESSON_NOT_FOUND" };
  }
  return { allowed: true, reason: null, evaluation: access.status };
}

/**
 * Server-side authorization for a quiz. Callers must treat
 * `LESSON_NOT_FOUND` as 404 and the other reasons as 403.
 */
export async function canAccessQuiz(
  studentId: string,
  quizId: string
): Promise<ResourceAccess> {
  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
    select: { lessonId: true, trackScope: true, status: true },
  });
  // Phase G — a DRAFT quiz does not exist for students: the same non-oracle
  // answer as a nonexistent id, so probing reveals nothing.
  if (!quiz || quiz.status !== "PUBLISHED") {
    return { allowed: false, reason: "LESSON_NOT_FOUND" };
  }
  return gateTrackedResource(studentId, quiz.lessonId, quiz.trackScope);
}

/** Server-side authorization for a homework/assignment. */
export async function canAccessHomework(
  studentId: string,
  homeworkId: string
): Promise<ResourceAccess> {
  const homework = await db.homework.findUnique({
    where: { id: homeworkId },
    select: { lessonId: true, trackScope: true, status: true },
  });
  // Phase G — DRAFT homework is invisible to students (see canAccessQuiz).
  // CLOSED stays ACCESSIBLE: students must still see a closed assignment,
  // their submission and its grade — closing only stops NEW submissions.
  if (!homework || homework.status === "DRAFT") {
    return { allowed: false, reason: "LESSON_NOT_FOUND" };
  }
  return gateTrackedResource(studentId, homework.lessonId, homework.trackScope);
}

/**
 * Batch gate a set of lessons at once and report which ones are open.
 *
 * Used by list endpoints (course tree, homework list, dashboard) so a single
 * request cannot describe the protected content of sessions the student has
 * not unlocked. One canonical evaluation for the whole course — no N+1.
 *
 * The set is the ACCESSIBLE set: chain-unlocked lessons, historical COMPLETED
 * lessons (which stay accessible past a hold boundary), and override-granted
 * lessons. The entitlement gate from Phase 25 PR2a still applies first:
 * denied ⇒ the EMPTY set, which every existing caller already handles as
 * "nothing open".
 */
export async function getUnlockedLessonIds(
  studentId: string,
  courseId: string
): Promise<Set<string>> {
  const student = await db.student.findUnique({
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

  const progress = await getCourseSessionProgress(studentId, courseId);
  return new Set(
    progress.sessions.filter((s) => s.unlocked).map((s) => s.lessonId)
  );
}
