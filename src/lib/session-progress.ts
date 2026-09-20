// CodeMind Academy — Session (lesson) progression & access control.
// Phase H: this module is now a thin compatibility layer over the canonical
// progression engine (src/lib/progression-engine.ts). All rule evaluation
// lives in the canonical engine; this file preserves the historical exports
// and pure helpers (chain resolution, ordering) that many readers import.

import { db } from "@/lib/db";
import {
  LESSON_STUDENT_STATUS_FILTER,
  isStudentVisibleStatus,
} from "@/lib/session-lifecycle";
import {
  canAccessTrackScope,
  trackScopeWhere,
} from "@/lib/track-scope";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";
import { getStudentSchoolType } from "@/lib/enrollment";
import { evaluateAccessDecision } from "@/lib/subscription-entitlement";
import {
  getCourseProgression,
  canAccessLessonCanonical,
  canAccessQuizCanonical,
  canAccessHomeworkCanonical,
  getUnlockedLessonIdsCanonical,
  VIDEO_COMPLETION_THRESHOLD as CANONICAL_VIDEO_THRESHOLD,
} from "@/lib/progression-engine";

// ---------------------------------------------------------------------------
// Re-exported constants / pure helpers (unchanged, reused by many modules)
// ---------------------------------------------------------------------------

export const VIDEO_COMPLETION_THRESHOLD = CANONICAL_VIDEO_THRESHOLD;

export const EXCLUDE_ARCHIVED_LESSON = {
  curriculumStatus: { not: "ARCHIVED" },
} as const;

export function lessonCourseChainOr(courseId: string) {
  return [
    { unit: { part: { courseId } } },
    { topic: { unit: { part: { courseId } } } },
  ];
}

export function lessonCoursesChainOr(courseIds: string[]) {
  return [
    { unit: { part: { courseId: { in: courseIds } } } },
    { topic: { unit: { part: { courseId: { in: courseIds } } } } },
  ];
}

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
// Legacy types (preserved for backward compat, mapped from canonical)
// ---------------------------------------------------------------------------

export type SessionRequirement = {
  required: boolean;
  done: boolean;
  value: number;
};

export type SessionStatusRow = {
  lessonId: string;
  order: number;
  completed: boolean;
  unlocked: boolean;
  video: SessionRequirement;
  quiz: SessionRequirement;
  assignment: SessionRequirement;
  // Phase H extras (optional for backward compat)
  state?: "LOCKED" | "UNLOCKED" | "COMPLETED";
  reason?: string | null;
  unmet?: any[];
  evidence?: any;
  activeHold?: any;
  activeOverride?: any;
  blockedByHold?: boolean;
  unlockedByOverride?: boolean;
};

export type CourseSessionProgress = {
  courseId: string;
  sessions: SessionStatusRow[];
  byLessonId: Map<string, SessionStatusRow>;
  currentLessonId: string | null;
  // Phase H extras
  activeHold?: any;
  boundaryLessonId?: string | null;
};

// ---------------------------------------------------------------------------
// Canonical delegation — getCourseSessionProgress
// ---------------------------------------------------------------------------

export async function getCourseSessionProgress(
  studentId: string,
  courseId: string,
  schoolType?: SchoolType | string | null
): Promise<CourseSessionProgress> {
  const canonical = await getCourseProgression(studentId, courseId, schoolType);

  const sessions: SessionStatusRow[] = canonical.lessons.map((l) => ({
    lessonId: l.lessonId,
    order: l.order,
    completed: l.completed,
    unlocked: l.unlocked,
    video: {
      required: l.evidence.video.required,
      done: l.evidence.video.done,
      value: l.evidence.video.percent,
    },
    quiz: {
      required: l.evidence.quiz.required,
      done: l.evidence.quiz.done,
      value: l.evidence.quiz.done ? 100 : 0,
    },
    assignment: {
      required: l.evidence.homework.required,
      done: l.evidence.homework.done,
      value: l.evidence.homework.done ? 100 : 0,
    },
    state: l.state,
    reason: l.reason,
    unmet: l.unmet,
    evidence: l.evidence,
    activeHold: l.activeHold,
    activeOverride: l.activeOverride,
    blockedByHold: l.blockedByHold,
    unlockedByOverride: l.unlockedByOverride,
  }));

  return {
    courseId,
    sessions,
    byLessonId: new Map(sessions.map((s) => [s.lessonId, s])),
    currentLessonId: canonical.currentLessonId,
    activeHold: canonical.activeHold,
    boundaryLessonId: canonical.boundaryLessonId,
  };
}

// ---------------------------------------------------------------------------
// Access types
// ---------------------------------------------------------------------------

export type AccessReason =
  | null
  | "NOT_ENROLLED"
  | "LESSON_NOT_FOUND"
  | "PREVIOUS_SESSION_INCOMPLETE"
  | "HOLD_ACTIVE";

export type LessonAccess = {
  allowed: boolean;
  reason: AccessReason;
  status: SessionStatusRow | null;
};

export type ResourceAccess = {
  allowed: boolean;
  reason: AccessReason;
};

// ---------------------------------------------------------------------------
// Canonical delegation — canAccessLesson / Quiz / Homework / UnlockedIds
// ---------------------------------------------------------------------------

function mapCanonicalReason(
  r: string | null
): AccessReason {
  if (r === "HOLD_ACTIVE") return "HOLD_ACTIVE";
  if (r === "NOT_ENROLLED") return "NOT_ENROLLED";
  if (r === "LESSON_NOT_FOUND") return "LESSON_NOT_FOUND";
  if (r === "PREVIOUS_SESSION_INCOMPLETE") return "PREVIOUS_SESSION_INCOMPLETE";
  return r as AccessReason;
}

export async function canAccessLesson(
  studentId: string,
  lessonId: string
): Promise<LessonAccess> {
  const res = await canAccessLessonCanonical(studentId, lessonId);
  if (!res.allowed) {
    const mapped = mapCanonicalReason(res.reason);
    const status = res.progression
      ? {
          lessonId: res.progression.lessonId,
          order: res.progression.order,
          completed: res.progression.completed,
          unlocked: res.progression.unlocked,
          video: {
            required: res.progression.evidence.video.required,
            done: res.progression.evidence.video.done,
            value: res.progression.evidence.video.percent,
          },
          quiz: {
            required: res.progression.evidence.quiz.required,
            done: res.progression.evidence.quiz.done,
            value: res.progression.evidence.quiz.done ? 100 : 0,
          },
          assignment: {
            required: res.progression.evidence.homework.required,
            done: res.progression.evidence.homework.done,
            value: res.progression.evidence.homework.done ? 100 : 0,
          },
          state: res.progression.state,
          reason: res.progression.reason,
          unmet: res.progression.unmet,
          evidence: res.progression.evidence,
          activeHold: res.progression.activeHold,
          activeOverride: res.progression.activeOverride,
          blockedByHold: res.progression.blockedByHold,
          unlockedByOverride: res.progression.unlockedByOverride,
        }
      : null;
    return { allowed: false, reason: mapped, status };
  }

  const s = res.progression!;
  return {
    allowed: true,
    reason: null,
    status: {
      lessonId: s.lessonId,
      order: s.order,
      completed: s.completed,
      unlocked: s.unlocked,
      video: {
        required: s.evidence.video.required,
        done: s.evidence.video.done,
        value: s.evidence.video.percent,
      },
      quiz: {
        required: s.evidence.quiz.required,
        done: s.evidence.quiz.done,
        value: s.evidence.quiz.done ? 100 : 0,
      },
      assignment: {
        required: s.evidence.homework.required,
        done: s.evidence.homework.done,
        value: s.evidence.homework.done ? 100 : 0,
      },
      state: s.state,
      reason: s.reason,
      unmet: s.unmet,
      evidence: s.evidence,
      activeHold: s.activeHold,
      activeOverride: s.activeOverride,
      blockedByHold: s.blockedByHold,
      unlockedByOverride: s.unlockedByOverride,
    },
  };
}

async function gateTrackedResource(
  studentId: string,
  lessonId: string | null,
  trackScope: unknown
): Promise<ResourceAccess> {
  if (!lessonId) return { allowed: false, reason: "LESSON_NOT_FOUND" };
  const access = await canAccessLesson(studentId, lessonId);
  if (!access.allowed) return { allowed: false, reason: access.reason };
  const schoolType = await getStudentSchoolType(studentId);
  if (!canAccessTrackScope(schoolType, trackScope)) {
    return { allowed: false, reason: "LESSON_NOT_FOUND" };
  }
  return { allowed: true, reason: null };
}

export async function canAccessQuiz(
  studentId: string,
  quizId: string
): Promise<ResourceAccess> {
  const res = await canAccessQuizCanonical(studentId, quizId);
  return { allowed: res.allowed, reason: mapCanonicalReason(res.reason) };
}

export async function canAccessHomework(
  studentId: string,
  homeworkId: string
): Promise<ResourceAccess> {
  const res = await canAccessHomeworkCanonical(studentId, homeworkId);
  return { allowed: res.allowed, reason: mapCanonicalReason(res.reason) };
}

export async function getUnlockedLessonIds(
  studentId: string,
  courseId: string
): Promise<Set<string>> {
  return getUnlockedLessonIdsCanonical(studentId, courseId);
}
