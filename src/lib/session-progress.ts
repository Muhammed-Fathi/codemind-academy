// CodeMind Academy — Session (lesson) progression & access control.
//
// PHASE H: THIS MODULE IS NOW A FACADE OVER THE CANONICAL ENGINE.
// ===============================================================
// Before Phase H this file BOTH owned the curriculum universe AND computed the
// rule matrix inline, while the dashboards, the course tree, the lesson page
// and the parent readers each re-derived pieces of it. Phase H split the
// authority so there is exactly ONE implementation of each rule:
//
//   src/lib/progression-universe.ts       WHICH lessons, in WHICH order
//   src/lib/progression-requirements.ts   WHAT makes a lesson COMPLETE (pure)
//   src/lib/progression-holds.ts          the Phase F AbsenceHold boundary
//   src/lib/progression-overrides.ts      the Admin exception + its audit
//   src/lib/progression-engine.ts         THE canonical verdict + access gates
//   src/lib/progression-catchup.ts        the catch-up resolution write path
//
// Everything below DELEGATES to `progression-engine.ts`. Nothing here
// re-decides a rule: keeping the historical export names means every existing
// caller (course tree, dashboards, quiz/homework/material gates, parent
// readers, tests) keeps compiling while reading the canonical authority.
//
// New code should import from `@/lib/progression-engine` directly: it returns
// the richer canonical verdict (state + Arabic-first reason + structured unmet
// requirements + hold + override + boundary). The shapes kept here exist for
// backwards compatibility only.
//
// The Phase 4 / 11 / 12 / 13 documentation that used to live in this file
// (dual curriculum chain, archived history, lifecycle slice, track slice,
// deterministic ordering) moved with the code into
// `src/lib/progression-universe.ts` — read it there.

import { db } from "@/lib/db";
import {
  EXCLUDE_ARCHIVED_LESSON,
  LESSON_CHAIN_SELECT,
  lessonCourseChainOr,
  lessonCoursesChainOr,
  orderCourseLessons,
  resolveLessonCourseId,
  type LessonChain,
} from "@/lib/progression-universe";
import {
  VIDEO_COMPLETION_THRESHOLD,
  type ProgressionState,
} from "@/lib/progression-requirements";
import {
  canAccessLesson as engineCanAccessLesson,
  evaluateCourseProgression,
  gateTrackedResource as engineGateTrackedResource,
  getUnlockedLessonIds as engineUnlockedLessonIds,
  type AccessReason,
  type LessonAccess,
  type LessonProgression,
  type ResourceAccess,
} from "@/lib/progression-engine";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";

// ---------------------------------------------------------------------------
// Re-exports — one import site for every reader (no private universes)
// ---------------------------------------------------------------------------

export {
  EXCLUDE_ARCHIVED_LESSON,
  LESSON_CHAIN_SELECT,
  lessonCourseChainOr,
  lessonCoursesChainOr,
  orderCourseLessons,
  resolveLessonCourseId,
};
export type { LessonChain };
export { VIDEO_COMPLETION_THRESHOLD };

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
  /** true when every REQUIRED condition of this lesson is satisfied. */
  completed: boolean;
  /** true when the student is allowed to open this lesson. */
  unlocked: boolean;
  video: SessionRequirement;
  quiz: SessionRequirement;
  assignment: SessionRequirement;
};

export type CourseSessionProgress = {
  courseId: string;
  /** Ordered lessons with their gating status. */
  sessions: SessionStatusRow[];
  byLessonId: Map<string, SessionStatusRow>;
  /** First lesson the student should work on. */
  currentLessonId: string | null;
};

export type { AccessReason, LessonAccess, ResourceAccess, ProgressionState, LessonProgression };

// ---------------------------------------------------------------------------
// Compatibility reader: the canonical verdict in the historical shape
// ---------------------------------------------------------------------------

function toSessionStatusRow(row: LessonProgression): SessionStatusRow {
  return {
    lessonId: row.lessonId,
    order: row.order,
    completed: row.completed,
    unlocked: row.unlocked,
    video: {
      required: row.requirements.video.required,
      done: row.requirements.video.done,
      value: row.requirements.video.value,
    },
    quiz: {
      required: row.requirements.quiz.required,
      done: row.requirements.quiz.done,
      value: row.requirements.quiz.value,
    },
    assignment: {
      required: row.requirements.homework.required,
      done: row.requirements.homework.done,
      value: row.requirements.homework.value,
    },
  };
}

/**
 * The gating state of every lesson of `courseId` for `studentId`, in the
 * historical shape. Derived from the CANONICAL engine — never computed here.
 */
export async function getCourseSessionProgress(
  studentId: string,
  courseId: string,
  schoolType?: SchoolType | string | null
): Promise<CourseSessionProgress> {
  const progression = await evaluateCourseProgression({
    studentId,
    courseId,
    schoolType: schoolType === undefined ? undefined : normalizeSchoolType(schoolType),
  });
  const sessions = progression.lessons.map(toSessionStatusRow);
  return {
    courseId,
    sessions,
    byLessonId: new Map(sessions.map((s) => [s.lessonId, s])),
    currentLessonId: progression.currentLessonId,
  };
}

/**
 * Server-side authorization for opening a single lesson — the canonical
 * engine's verdict. Must be called by every route that returns lesson
 * content; hiding it in the UI is not enough.
 */
export async function canAccessLesson(
  studentId: string,
  lessonId: string
): Promise<LessonAccess> {
  return engineCanAccessLesson(studentId, lessonId);
}

/**
 * Batch gate a set of lessons at once (list endpoints: course tree, homework
 * list, dashboard). Delegates to the engine, which applies the entitlement
 * gate here too — a list surface must not describe sessions the student may
 * no longer open.
 */
export async function getUnlockedLessonIds(
  studentId: string,
  courseId: string
): Promise<Set<string>> {
  return engineUnlockedLessonIds(studentId, courseId);
}

// ---------------------------------------------------------------------------
// Resource-level gating (quiz, homework)
// ---------------------------------------------------------------------------
//
// A quiz or an assignment is only ever reachable through the session it
// belongs to. Without this, a student who knows (or guesses) an id could POST
// straight to `/api/quizzes/<id>/submit` for a session they have not unlocked
// and pre-satisfy that session's quiz requirement.
//
// Both helpers resolve to the OWNING LESSON and then re-use the canonical
// `canAccessLesson`, so there is exactly one definition of "may this student
// open this session".

/**
 * Gate a resource that belongs to a lesson AND carries its own trackScope.
 *
 * Two independent conditions, both fail-closed:
 *   1. the owning lesson must be open to this student;
 *   2. the resource's OWN trackScope must be eligible for the student
 *      (a SHARED lesson may legitimately host an ARABIC quiz and a LANGUAGE
 *      quiz, so the resource scope can be narrower than the lesson scope).
 */
export async function gateTrackedResource(
  studentId: string,
  lessonId: string | null,
  trackScope: unknown
): Promise<ResourceAccess> {
  return engineGateTrackedResource(studentId, lessonId, trackScope);
}

/**
 * Server-side authorization for a quiz. Callers must treat
 * `LESSON_NOT_FOUND` as 404 and the other reasons as 403.
 *
 * Phase G: a quiz that is not PUBLISHED does not exist for students — the
 * same non-oracle answer as a nonexistent id, so probing reveals nothing.
 */
export async function canAccessQuiz(
  studentId: string,
  quizId: string
): Promise<ResourceAccess> {
  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
    select: { lessonId: true, trackScope: true, status: true },
  });
  if (!quiz || quiz.status !== "PUBLISHED") {
    return { allowed: false, reason: "LESSON_NOT_FOUND" };
  }
  return engineGateTrackedResource(studentId, quiz.lessonId, quiz.trackScope);
}

/**
 * Server-side authorization for a homework/assignment.
 *
 * Phase G: DRAFT homework is invisible to students (see canAccessQuiz).
 * CLOSED stays ACCESSIBLE: students must still see a closed assignment, their
 * submission and its grade — closing only stops NEW submissions.
 */
export async function canAccessHomework(
  studentId: string,
  homeworkId: string
): Promise<ResourceAccess> {
  const homework = await db.homework.findUnique({
    where: { id: homeworkId },
    select: { lessonId: true, trackScope: true, status: true },
  });
  if (!homework || homework.status === "DRAFT") {
    return { allowed: false, reason: "LESSON_NOT_FOUND" };
  }
  return engineGateTrackedResource(studentId, homework.lessonId, homework.trackScope);
}
