// CodeMind Academy — M4.1: the STUDENT-side current-course universe.
//
// The parent portal has one definition of a child's active curriculum slice
// (`getStudentCurriculumLessonIds` / `getStudentCurriculumHomeworkIds` in
// `parent-access.ts`). M4.1 needs the SAME slice on the student's own
// surfaces — dashboard history, certificate metrics, leaderboard activity —
// so a student who changed course or Academic Level can never be shown the
// PREVIOUS course's rows as if they were the current course's history.
//
// Everything here is composed from the canonical primitives and nothing is
// re-derived:
//   * identity is the relation chain `Student.groupId → Group.courseId`
//     (`Course.academicLevel` travels with it) — never a course name, lesson
//     title, `officialCode` or `grade`;
//   * lifecycle  — `LESSON_STUDENT_STATUS_FILTER` (PUBLISHED);
//   * archive    — `EXCLUDE_ARCHIVED_LESSON`;
//   * track      — `trackScopeWhere` (independent of level, fail-closed);
//   * placement  — `lessonCourseChainOr` (canonical `unitId` chain first, the
//     legacy `topicId` chain as the documented fallback).
//
// The helpers are pure (no DB access) so each route composes them into its own
// query and a test can assert the exact predicate.
//
// LEVEL AUTHORITY (M4.1 owner decision): `Student.academicLevel` and
// `Course.academicLevel` are two DIFFERENT authorities that happen to be kept
// equal by the assignment invariant. This module exposes both, separately and
// under distinct names — it never substitutes one for the other.

import { normalizeAcademicLevel, type AcademicLevel } from "@/lib/academic-level";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { EXCLUDE_ARCHIVED_LESSON, lessonCourseChainOr } from "@/lib/session-progress";
import { STUDENT_HOMEWORK_LIST_FILTER } from "@/lib/student-visibility";
import { trackScopeWhere } from "@/lib/track-scope";

/**
 * The course id used when the student has NO active course. No row can carry
 * it, so every filter composed with it matches nothing — fail closed, the same
 * sentinel convention the student dashboard already uses for `student.groupId`.
 */
export const NO_ACTIVE_COURSE_ID = "_";

export type StudentAcademicContext = {
  studentId: string;
  /** `Student.academicLevel` — the STUDENT-level authority (never `grade`). */
  studentAcademicLevel: AcademicLevel | null;
  /** `Student.groupId → Group.courseId` — the canonical course identity. */
  courseId: string | null;
  /** `Course.academicLevel` of the ACTIVE course — the COURSE-level authority. */
  courseAcademicLevel: AcademicLevel | null;
};

/**
 * Read the two levels from an already-authorized student row. Pure: the caller
 * has loaded the row from the student's own session, so nothing here can widen
 * scope, and an unrecognised stored value normalises to `null` (fail closed)
 * instead of leaking a raw string into a payload.
 */
export function studentAcademicContext(student: {
  id: string;
  academicLevel?: unknown;
  group?:
    | {
        courseId?: string | null;
        course?: { id?: string | null; academicLevel?: unknown } | null;
      }
    | null;
}): StudentAcademicContext {
  const group = student.group ?? null;
  return {
    studentId: student.id,
    studentAcademicLevel: normalizeAcademicLevel(student.academicLevel),
    courseId: group?.course?.id ?? group?.courseId ?? null,
    courseAcademicLevel: normalizeAcademicLevel(group?.course?.academicLevel),
  };
}

/**
 * Lesson-row filter for the student's ACTIVE curriculum: PUBLISHED, not
 * archived, on the student's own track, inside the active course chain.
 */
export function studentLessonUniverse(
  courseId: string | null,
  schoolType: unknown
): Record<string, unknown> {
  return {
    ...LESSON_STUDENT_STATUS_FILTER,
    ...EXCLUDE_ARCHIVED_LESSON,
    ...trackScopeWhere(schoolType as never),
    OR: lessonCourseChainOr(courseId ?? NO_ACTIVE_COURSE_ID),
  };
}

/**
 * Homework-row filter: the assignment's lesson must be in the student's lesson
 * universe AND the assignment itself must be in the student's track and
 * student-visible (the Phase G lifecycle clause — DRAFT is authoring-only).
 */
export function studentHomeworkUniverse(
  courseId: string | null,
  schoolType: unknown
): Record<string, unknown> {
  return {
    ...STUDENT_HOMEWORK_LIST_FILTER,
    ...trackScopeWhere(schoolType as never),
    lesson: studentLessonUniverse(courseId, schoolType),
  };
}

/**
 * Quiz-attempt-row filter: the attempt's quiz must sit on a lesson of the
 * student's active curriculum. An attempt whose quiz/lesson chain is gone
 * (or foreign) cannot match, so it can never be reported as current-course
 * activity.
 */
export function studentQuizAttemptUniverse(
  courseId: string | null,
  schoolType: unknown
): Record<string, unknown> {
  return { quiz: { lesson: studentLessonUniverse(courseId, schoolType) } };
}

/**
 * Attendance-row filter: a session belongs to a group, and a group belongs to
 * one course. This is the canonical course relation — NOT the session's lesson
 * (a session may be lesson-less) and never a label.
 */
export function studentAttendanceUniverse(courseId: string | null): Record<string, unknown> {
  return { session: { group: { courseId: courseId ?? NO_ACTIVE_COURSE_ID } } };
}
