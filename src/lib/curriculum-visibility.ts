// CodeMind Academy — Student curriculum visibility (Phase 16).
//
// THE CONTRACT
// ============
// A lesson is part of a student's VISIBLE curriculum — i.e. its title may be
// named anywhere (course tree, bookmarks, notes, dashboard) — exactly when:
//
//   PUBLISHED (Phase 13 `status`) AND NOT ARCHIVED (Phase 11
//   `curriculumStatus`) AND ON THE STUDENT'S TRACK (Phase 12 `trackScope`)
//   AND IN THE STUDENT'S ENROLLED COURSE (group → course, active group)
//
// Visibility is NOT access. A PUBLISHED + LOCKED session is visible (its
// skeleton: title, chapter/unit, session identity, presence badges) but its
// content stays redacted until Phase 4 progression unlocks it. Conversely,
// DRAFT / READY / ARCHIVED / wrong-track / wrong-course lessons are INVISIBLE:
// they must not surface through URL guessing, prev/next, search, dashboard,
// notifications, bookmarks, notes, or cached frontend state.
//
// THE RULES THIS MODULE OWNS
// ==========================
//  1. THIS IS NOT A SECOND CURRICULUM SOURCE. Every clause below is imported
//     from the module that owns it (`LESSON_STUDENT_STATUS_FILTER` from the
//     lifecycle, `EXCLUDE_ARCHIVED_LESSON` + `resolveLessonCourseId` from
//     progression, `trackScopeWhere` / `canAccessTrackScope` from track scope)
//     and only ANDed here. If any of those change, visibility follows them.
//  2. VISIBILITY ≠ UNLOCK. This module never reads video progress, quiz
//     attempts, or homework submissions. Only `canAccessLesson`
//     (`src/lib/session-progress.ts`) decides UNLOCKED, and only routes that
//     serve protected content call it. List/title surfaces call THIS module.
//  3. FAIL CLOSED ON EVERY SIDE. Unknown status, unknown track scope, no
//     course link, no enrollment, an inactive group, a missing row: each
//     yields "invisible", never a permissive default.
//  4. TWO SHAPES, ONE PREDICATE. `studentLessonVisibilityWhere` is the Prisma
//     `where` fragment for list queries; `isLessonVisibleToViewer` is the
//     runtime predicate over an already-loaded row; `canStudentSeeLesson` is
//     the full check (visibility + enrollment + course) for single-id gates.
//     All three encode the same rule — a lesson visible to one is visible to
//     all.

import { db } from "@/lib/db";
import {
  EXCLUDE_ARCHIVED_LESSON,
  LESSON_CHAIN_SELECT,
  resolveLessonCourseId,
  type LessonChain,
} from "@/lib/session-progress";
import {
  LESSON_STUDENT_STATUS_FILTER,
  isStudentVisibleStatus,
} from "@/lib/session-lifecycle";
import { canAccessTrackScope, trackScopeWhere } from "@/lib/track-scope";
import type { SchoolType } from "@/lib/school-type";

/**
 * Prisma `where` fragment for the student's visible lesson universe.
 * Lifecycle + archive + track, ANDed — the course/enrollment half is supplied
 * by the caller (each list route already knows its own course scope).
 */
export function studentLessonVisibilityWhere(
  schoolType: SchoolType | string | null | undefined
) {
  return {
    ...LESSON_STUDENT_STATUS_FILTER,
    ...EXCLUDE_ARCHIVED_LESSON,
    ...trackScopeWhere(schoolType),
  };
}

/**
 * Chain + lifecycle + track fields needed to judge one loaded lesson row.
 * The same shape `canAccessLesson` reads, so visibility and gating can never
 * disagree about which lesson they are looking at.
 */
export const LESSON_VISIBILITY_SELECT = {
  ...LESSON_CHAIN_SELECT,
  status: true,
  curriculumStatus: true,
  trackScope: true,
} as const;

export type LessonVisibilityViewer = {
  schoolType: SchoolType | string | null | undefined;
  /** The student's enrolled course, or null when not (actively) enrolled. */
  courseId: string | null;
};

/**
 * Runtime visibility predicate over an already-loaded lesson row.
 * Pure: no I/O, so the suite can exhaust the matrix without a database.
 */
export function isLessonVisibleToViewer(
  lesson:
    | (LessonChain & {
        status: unknown;
        curriculumStatus: unknown;
        trackScope: unknown;
      })
    | null
    | undefined,
  viewer: LessonVisibilityViewer
): boolean {
  if (!lesson) return false;
  // Lifecycle: PUBLISHED only. DRAFT / READY / unknown are invisible.
  if (!isStudentVisibleStatus(lesson.status)) return false;
  // Archive: history, never curriculum — whatever the status says.
  if (String(lesson.curriculumStatus ?? "").toUpperCase() === "ARCHIVED") {
    return false;
  }
  // Track: the lesson's own scope must admit the student's school type.
  if (!canAccessTrackScope(viewer.schoolType, lesson.trackScope)) return false;
  // Course: the lesson must belong to the student's enrolled course through
  // the canonical-first dual chain — the same resolution progression uses.
  if (!viewer.courseId) return false;
  return resolveLessonCourseId(lesson) === viewer.courseId;
}

/**
 * Full single-id visibility check: the lesson row plus the student's own
 * enrollment, both read server-side. For gates that only receive an id
 * (bookmark/note creation), where answering "invisible" must be
 * indistinguishable from "nonexistent" — callers map `false` to 404.
 */
export async function canStudentSeeLesson(
  studentId: string,
  lessonId: string
): Promise<boolean> {
  if (!studentId || !lessonId) return false;
  const [lesson, student] = await Promise.all([
    db.lesson.findUnique({
      where: { id: lessonId },
      select: LESSON_VISIBILITY_SELECT,
    }),
    db.student.findUnique({
      where: { id: studentId },
      select: {
        schoolType: true,
        group: { select: { courseId: true, isActive: true } },
      },
    }),
  ]);
  if (!lesson || !student) return false;
  const courseId =
    student.group && student.group.isActive ? student.group.courseId : null;
  return isLessonVisibleToViewer(
    lesson as LessonChain & {
      status: unknown;
      curriculumStatus: unknown;
      trackScope: unknown;
    },
    { schoolType: student.schoolType, courseId }
  );
}
