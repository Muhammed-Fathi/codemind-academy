// CodeMind Academy — Phase H: the canonical progression UNIVERSE.
//
// WHAT LIVES HERE (and why it moved out of session-progress.ts)
// =============================================================
// Phase H consolidated every progression READER onto one authority. The
// authority needs the same lesson universe every previous phase already
// pinned, so instead of re-deriving it the universe was EXTRACTED verbatim
// from `src/lib/session-progress.ts` (Phases 4 / 11 / 12 / 13 rules and all):
//
//   * the dual curriculum chain   — canonical `Lesson.unitId` FIRST, the legacy
//                                   `Lesson.topicId` chain as a fallback
//                                   (never a second opinion);
//   * the lifecycle slice         — `LESSON_STUDENT_STATUS_FILTER` (PUBLISHED);
//   * the archived-history slice  — `EXCLUDE_ARCHIVED_LESSON` (Phase 11);
//   * the track slice             — `trackScopeWhere(schoolType)` (Phase 12);
//   * the deterministic order     — Part → Unit → (Topic) → Lesson → id.
//
// `session-progress.ts` re-exports all of it, so every existing import keeps
// working and no reader can grow a private universe of its own.
//
// WHAT DOES NOT LIVE HERE
// =======================
// No completion rules (progression-requirements.ts), no absence state
// (progression-holds.ts), no admin exceptions (progression-overrides.ts) and
// no access verdicts (progression-engine.ts). This file answers exactly one
// question: WHICH lessons, in WHICH order, does this student's curriculum
// consist of?

import { db } from "@/lib/db";
import {
  LESSON_STUDENT_STATUS_FILTER,
  isStudentVisibleStatus,
} from "@/lib/session-lifecycle";
import { trackScopeWhere, trackScopeInWhere, type TrackScope } from "@/lib/track-scope";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";

// ---------------------------------------------------------------------------
// Archived history (Phase 11)
// ---------------------------------------------------------------------------
// Archived lessons are history, not curriculum: their rows survive (so
// progress, attempts and submissions stay intact) but they are excluded from
// every ACTIVE-curriculum read — the progression universe, the course tree,
// lesson navigation, dashboards, certificates and parent reports.

/** Spread into any lesson `where` to exclude archived lessons. */
export const EXCLUDE_ARCHIVED_LESSON = {
  curriculumStatus: { not: "ARCHIVED" },
} as const;

// ---------------------------------------------------------------------------
// The dual curriculum chain
// ---------------------------------------------------------------------------

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
 * lesson attached to neither — such a lesson is not part of any course and
 * therefore not part of any progression.
 */
export function resolveLessonCourseId(lesson: LessonChain): string | null {
  return (
    lesson.unit?.part.courseId ??
    lesson.topic?.unit.part.courseId ??
    null
  );
}

/**
 * Sortable position of a lesson inside `courseId`. `null` when neither chain
 * of this lesson resolves to `courseId` (defensive: the query should not
 * return such a row, and silently inventing a position would be worse than
 * dropping it).
 *
 * Deterministic TOTAL order: Part.order → Unit.order → Topic.order →
 * Lesson.order → id. Unit-linked lessons have no Topic, so they sort by
 * `topicOrder = TOPIC_ORDER_NONE` and therefore come before the legacy topics
 * of the same Unit; the trailing id tie-break keeps the order total even when
 * two rows share every declared `order`.
 */
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
// The universe query
// ---------------------------------------------------------------------------

export type UniverseQuizRow = { id: string; passMark: number };
export type UniverseHomeworkRow = { id: string };

export type UniverseLesson = LessonChain & {
  quizzes: UniverseQuizRow[];
  homeworks: UniverseHomeworkRow[];
};

/**
 * Load ONE student's curriculum universe for a course, ordered.
 *
 * Phase H additions on top of the extracted query — both are VISIBILITY
 * filters, never new progression semantics:
 *
 *   * quizzes/homeworks are now filtered by the student's TRACK as well as by
 *     lifecycle. Without the track slice a LANGUAGE quiz hosted on a SHARED
 *     lesson was a progression REQUIREMENT for an ARABIC student who can never
 *     even open it — a requirement that can never be satisfied (a deadlock).
 *     The other track's rows were always invisible (`canAccessQuiz` refuses
 *     them), so this only removes impossible obligations.
 *   * the quiz `passMark` needed for "you scored 40%, pass mark 60%" is read
 *     here rather than in a second query.
 */
export async function loadCourseLessonUniverse(params: {
  courseId: string;
  schoolType: SchoolType | string | null | undefined;
}): Promise<UniverseLesson[]> {
  const schoolType = normalizeSchoolType(params.schoolType);
  const found = await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      ...EXCLUDE_ARCHIVED_LESSON,
      ...trackScopeWhere(schoolType),
      OR: [
        { unit: { part: { courseId: params.courseId } } },
        { topic: { unit: { part: { courseId: params.courseId } } } },
      ],
    },
    select: {
      ...LESSON_CHAIN_SELECT,
      // Phase G — DRAFT assessments are authoring-only: they are NOT session
      // requirements (a student can never complete something they cannot see,
      // so counting one would deadlock the sequence). CLOSED homework stays a
      // requirement on purpose: closing stops NEW submissions, it does not
      // erase the obligation of students who have not submitted yet.
      // Phase H — the track slice is applied to the children too (above).
      quizzes: {
        where: { status: { not: "DRAFT" }, ...trackScopeWhere(schoolType) },
        select: { id: true, passMark: true },
      },
      homeworks: {
        where: { status: { not: "DRAFT" }, ...trackScopeWhere(schoolType) },
        select: { id: true },
      },
    },
  });

  return orderCourseLessons(
    found as unknown as UniverseLesson[],
    params.courseId
  );
}

/**
 * The lessons of SEVERAL courses that carry a video, with their course id.
 *
 * Phase H deduplication: `src/lib/progress.ts` used to carry a PRIVATE copy of
 * this predicate (lifecycle + archived history + "has a video" + dual chain),
 * with a comment blaming a progress ↔ session-progress import cycle. The
 * universe now lives here and imports nothing from either module, so the copy
 * is gone and the denominator of every dashboard, report and certificate is
 * provably the same lesson set the progression engine gates.
 */
export async function loadVideoLessonsForCourses(params: {
  courseIds: readonly string[];
  /**
   * When OMITTED no track slice is applied in SQL: batch callers
   * (`src/lib/progress.ts`) slice per student in JS with
   * `canAccessTrackScope`, which is the only way to measure several students
   * of different school types with ONE query. When supplied, the row set is
   * narrowed in SQL to that student's own track.
   */
  schoolType?: SchoolType | string | null;
}): Promise<{ id: string; trackScope: string; courseId: string }[]> {
  const courseIds = [...new Set(params.courseIds.filter(Boolean))];
  if (!courseIds.length) return [];
  const schoolType =
    params.schoolType === undefined ? undefined : normalizeSchoolType(params.schoolType);
  // The row shape is asserted explicitly (rather than inferred) so the helper
  // has ONE stable return type whatever the generated client happens to infer:
  // `src/lib/progress.ts` slices these rows per student, and an `unknown`
  // inference there would break the shared-video-universe contract.
  const rows = (await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      ...EXCLUDE_ARCHIVED_LESSON,
      ...(schoolType === undefined ? {} : trackScopeWhere(schoolType)),
      videoUrl: { not: null },
      OR: lessonCoursesChainOr(courseIds),
    },
    select: {
      id: true,
      trackScope: true,
      unit: { select: { part: { select: { courseId: true } } } },
      topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } },
    },
  })) as unknown as Array<{
    id: string;
    trackScope: unknown;
    unit: { part: { courseId: string } } | null;
    topic: { unit: { part: { courseId: string } } } | null;
  }>;
  const out: { id: string; trackScope: string; courseId: string }[] = [];
  for (const row of rows) {
    const courseId =
      row.unit?.part.courseId ?? row.topic?.unit.part.courseId ?? null;
    if (!courseId) continue;
    out.push({ id: row.id, trackScope: String(row.trackScope ?? "SHARED"), courseId });
  }
  return out;
}

/** `where` fragment narrowing children (quiz/homework) to one track slice. */
export function childTrackScopeWhere(scopes: readonly TrackScope[]) {
  return trackScopeInWhere(scopes);
}

/** Re-used by the direct-lesson gate: is this lesson in the student universe? */
export function isLessonStudentVisible(lesson: {
  status?: unknown;
  curriculumStatus?: unknown;
}): boolean {
  return (
    isStudentVisibleStatus(lesson.status) &&
    String(lesson.curriculumStatus ?? "").toUpperCase() !== "ARCHIVED"
  );
}
