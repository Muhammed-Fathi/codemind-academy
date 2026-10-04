// CodeMind Academy — Parent → course authorization helper (Phase 7).
//
// A parent's scope always originates from server-side linkage: the parent may
// only ever see content/analytics for courses in which at least one LINKED
// child is enrolled. Enrollment uses the exact same rule as the student
// surface (`getEnrollment`: membership of an ACTIVE group bound to the
// course), so a parent can never open a course their child cannot open.
//
// Used by the content routes a parent is allowed to preview
// (`/api/courses/[slug]`, `/api/lessons/[id]`, `/api/quizzes/[id]`). The
// dedicated parent APIs (`/api/parents/me/*`) need no course check at all:
// they derive every row from `Parent.children` links and accept no
// student/course ids from the client, so there is no scope to expand.

import { db } from "@/lib/db";
import { getEnrollment } from "@/lib/enrollment";
import {
  LESSON_STUDENT_STATUS_FILTER,
  isStudentVisibleStatus,
} from "@/lib/session-lifecycle";
import {
  EXCLUDE_ARCHIVED_LESSON,
  lessonCourseChainOr,
} from "@/lib/session-progress";
import {
  normalizeTrackScope,
  trackScopeWhere,
  type TrackScope,
} from "@/lib/track-scope";
import { STUDENT_HOMEWORK_LIST_FILTER } from "@/lib/student-visibility";

/** Student ids explicitly linked to the parent identified by `parentUserId`. */
export async function getLinkedStudentIds(
  parentUserId: string
): Promise<string[]> {
  const parent = await db.parent.findUnique({
    where: { userId: parentUserId },
    select: { children: { select: { studentId: true } } },
  });
  return (parent?.children || []).map((c) => c.studentId);
}

/**
 * Course ids in which at least one linked child is currently enrolled.
 * A child without a group (or in an inactive group) contributes no course.
 */
export async function getParentCourseIds(
  parentUserId: string
): Promise<Set<string>> {
  const studentIds = await getLinkedStudentIds(parentUserId);
  const out = new Set<string>();
  for (const studentId of studentIds) {
    const enrollment = await getEnrollment(studentId);
    if (enrollment.isEnrolled && enrollment.courseId) {
      out.add(enrollment.courseId);
    }
  }
  return out;
}

/**
 * True when the parent (by user id) has at least one linked child enrolled
 * in `courseId`. This is the single definition of "may this parent preview
 * this course's content".
 */
export async function isParentAuthorizedForCourse(
  parentUserId: string,
  courseId: string | null | undefined
): Promise<boolean> {
  if (!courseId) return false;
  const courseIds = await getParentCourseIds(parentUserId);
  return courseIds.has(courseId);
}

// ---------------------------------------------------------------------------
// Track scope (Phase 12)
// ---------------------------------------------------------------------------
//
// A parent previews content ON BEHALF OF A CHILD, so the track decision is the
// CHILD's, not the parent's: never the parent's locale, never the parent's own
// account attributes, never a request parameter.
//
// A parent may of course have more than one child, in different school types,
// so the parent's eligible set is the UNION of their children's tracks. It is
// built from exactly the same population as `getParentCourseIds` — LINKED
// children who are actually ENROLLED — on purpose: a child who is not
// enrolled contributes no course and must not contribute a track either,
// otherwise a parent with one enrolled ARABIC child and one unenrolled
// LANGUAGE child could preview LANGUAGE content that neither child can open.
//
// SHARED content is always in scope for a parent; the course check above is
// what keeps an unauthorised parent out, so these helpers only ever answer the
// narrower question "is this the right track".

/** Track scopes a parent may preview: SHARED plus every enrolled child's track. */
export async function getParentTrackScopes(
  parentUserId: string
): Promise<Set<TrackScope>> {
  const studentIds = await getLinkedStudentIds(parentUserId);
  const scopes = new Set<TrackScope>(["SHARED"]);
  for (const studentId of studentIds) {
    const enrollment = await getEnrollment(studentId);
    if (enrollment.isEnrolled && enrollment.courseId && enrollment.schoolType) {
      scopes.add(enrollment.schoolType);
    }
  }
  return scopes;
}

/**
 * May this parent preview content with `trackScope`?
 * Fails closed: an unrecognised scope is refused rather than treated as
 * SHARED.
 */
export async function isParentAllowedTrackScope(
  parentUserId: string,
  trackScope: unknown
): Promise<boolean> {
  const scope = normalizeTrackScope(trackScope);
  if (!scope) return false;
  if (scope === "SHARED") return true;
  const scopes = await getParentTrackScopes(parentUserId);
  return scopes.has(scope);
}

// ---------------------------------------------------------------------------
// Lifecycle (Phase 13)
// ---------------------------------------------------------------------------
//
// A parent previews a CHILD's curriculum, and a child's curriculum is the
// PUBLISHED slice. So the parent surface must apply the SAME lifecycle clause
// the student surface does — "an in-scope parent" is not a reason to hand over
// a session an admin has staged but never opened. This is the gap Phase 12
// measured and left to Phase 13 (PHASE_12_FINAL_REPORT, Finding 2).
//
// The three clauses live in this one function on purpose: a preview that
// checks the course but forgets the lifecycle is the bug class being closed.

/**
 * The complete parent preview predicate for a lesson (or for the lesson a
 * quiz/homework belongs to): child's course + child's track + PUBLISHED +
 * not archived.
 *
 * Fails closed on every missing/unknown field, and — importantly — takes the
 * lesson fields as DATA rather than an id, so a caller that has already loaded
 * the row cannot be tricked into a second, looser lookup.
 */
export async function isParentLessonPreviewAllowed(
  parentUserId: string,
  lesson:
    | {
        status?: unknown;
        curriculumStatus?: unknown;
        trackScope?: unknown;
      }
    | null
    | undefined,
  courseId: string | null | undefined
): Promise<boolean> {
  if (!lesson) return false;
  // 1. Lifecycle: only an OPENED session exists for the child at all.
  if (!isStudentVisibleStatus(lesson.status)) return false;
  // 2. Phase 11: archived history is not curriculum, whatever its status says.
  if (String(lesson.curriculumStatus ?? "").toUpperCase() === "ARCHIVED") {
    return false;
  }
  // 3. Phase 12: the child's track, never the parent's locale.
  if (!(await isParentAllowedTrackScope(parentUserId, lesson.trackScope))) {
    return false;
  }
  // 4. Phase 7: the course must be one a linked, enrolled child is in.
  return isParentAuthorizedForCourse(parentUserId, courseId);
}

// ---------------------------------------------------------------------------
// Reporting universe (Phase 26E)
// ---------------------------------------------------------------------------
//
// The parent REPORTING surfaces (dashboard, analytics, weekly report) show a
// child's activity, and every one of them must measure that activity against
// ONE universe: the child's own PUBLISHED, non-archived, in-course,
// in-track curriculum — the exact slice the child's own dashboard and every
// student reader apply.
//
// Phases 12/13/19 landed that rule for LESSONS, VIDEO and HOMEWORK. Phase 26E
// closes the last two readers that still walked the whole table:
//
//   * quiz attempts were aggregated from EVERY finished attempt of the child,
//     whatever lesson the quiz belonged to — so an attempt left on an ARCHIVED
//     session, on a session an admin had staged but never opened, on the other
//     school type, or in a course the child has left, all moved the parent's
//     "quiz average", appeared in the "strong/weak topics" lists and named the
//     container in the payload;
//   * analytics counted homework submissions the dashboard had already
//     excluded, so the two screens disagreed about the same child.
//
// Both helpers below are the single definition of that slice. A caller that
// re-implements the predicate is the drift this module exists to prevent.

/**
 * Lesson ids of a child's ACTIVE curriculum: PUBLISHED, not ARCHIVED, in the
 * course the child's group is bound to, and on the child's own track.
 *
 * Fails closed everywhere: an unknown school type keeps SHARED only, a child
 * with no group has an empty universe, and the result is a plain id Set — a
 * caller can only ever INTERSECT with it, never widen it.
 */
export async function getStudentCurriculumLessonIds(
  studentId: string
): Promise<Set<string>> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { schoolType: true, group: { select: { courseId: true } } },
  });
  const courseId = student?.group?.courseId ?? null;
  if (!student || !courseId) return new Set();
  const rows = await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      ...EXCLUDE_ARCHIVED_LESSON,
      ...trackScopeWhere(student.schoolType),
      OR: lessonCourseChainOr(courseId),
    },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Homework ids in the SAME universe as `getStudentCurriculumLessonIds`.
 *
 * Homework carries its own `trackScope`, so it is filtered on both sides: its
 * lesson must be in the child's lesson universe AND the homework itself must
 * be in the child's track. This is the identical conjunction the parent
 * dashboard issues inline, expressed once so the analytics surface cannot
 * count a different set (e.g. a LANGUAGE assignment submitted by an ARABIC
 * child, or history from an archived session).
 */
export async function getStudentCurriculumHomeworkIds(
  studentId: string
): Promise<Set<string>> {
  const [student, lessonIds] = await Promise.all([
    db.student.findUnique({
      where: { id: studentId },
      select: { schoolType: true },
    }),
    getStudentCurriculumLessonIds(studentId),
  ]);
  if (!student || lessonIds.size === 0) return new Set();
  const rows = await db.homework.findMany({
    where: {
      ...trackScopeWhere(student.schoolType),
      // Phase I — the Phase G lifecycle clause (PUBLISHED | CLOSED). Without
      // it, a teacher's DRAFT assignment was counted in the analytics and
      // weekly-report denominators: unpublished content the child cannot open
      // was reported as the child's outstanding work. The constant is the ONE
      // definition the student homework list uses.
      ...STUDENT_HOMEWORK_LIST_FILTER,
      lessonId: { in: [...lessonIds] },
    },
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/**
 * Keep only the quiz attempts whose quiz belongs to the child's curriculum
 * universe. An attempt with no resolvable quiz/lesson is dropped (fail closed),
 * so a half-deleted relation can never be reported as current progress.
 *
 * Pure and side-effect free: the caller has already loaded the rows WITH
 * `quiz.lessonId`, and passes the Set from `getStudentCurriculumLessonIds`.
 */
export function attemptsInCurriculumUniverse<
  T extends { quiz?: { lessonId?: string | null } | null },
>(attempts: readonly T[], universeLessonIds: ReadonlySet<string>): T[] {
  return attempts.filter(
    (a) => !!a.quiz?.lessonId && universeLessonIds.has(a.quiz.lessonId)
  );
}

// ---------------------------------------------------------------------------
// M4.4 — the CURRENT-COURSE metric scope (ONE rule for every Parent number)
// ---------------------------------------------------------------------------
//
// Phase 26E cut quizzes and homework to the child's own curriculum universe
// (`getStudentCurriculumLessonIds` / `attemptsInCurriculumUniverse`). Attendance
// and mock exams were still filtered by `studentId` alone, so a child who
// changed course — including an Academic Level change — kept the PREVIOUS
// course's rows inside the numbers a screen presents as the CURRENT course
// (M4-F2). These helpers close that gap with the canonical relations only:
//
//   * course identity : `Student.groupId → Group.courseId` (a course ID is the
//     boundary — never a course/group NAME, a lesson `officialCode`, a lesson
//     title or the Academic Level alone);
//   * attendance      : `Attendance → LiveSession → Group → Course` (the
//     session's group is what binds a session to a course; the attached lesson
//     is optional and is deliberately NOT used);
//   * mock exams      : `ExamAttempt → MockExam → Course` (`MockExam.courseId`
//     is the authority; an attempt with no linked exam has no course at all and
//     therefore fails closed);
//   * curriculum unit : `Lesson.topic ?? Lesson.unit` — the same Phase 19
//     container chain the parent screens group by, now keyed by the container's
//     canonical ID instead of its title.
//
// Every helper fails closed: a child with no active course (no group) has an
// empty metric set, never a lifetime fallback and never an invented course.

/**
 * The canonical CURRENT course id of a child: `Student.groupId → Group.courseId`.
 * Pure — the caller passes the already-authorized student row. `null` means the
 * child has no active course, which every predicate below turns into "matches
 * nothing".
 */
export function currentCourseIdOf(
  student: { group?: { courseId?: string | null } | null } | null | undefined
): string | null {
  return student?.group?.courseId ?? null;
}

/**
 * SQL row filter for the attendance of ONE course:
 * `Attendance → LiveSession → Group → Course`. The empty-string sentinel is the
 * established parent-side convention for "no active course" (`lessonCourseChainOr`
 * uses it too): no row carries it, so the filter matches nothing.
 */
export function currentCourseAttendanceWhere(
  courseId: string | null
): Record<string, unknown> {
  return { session: { group: { courseId: courseId ?? "" } } };
}

/**
 * The course an attendance row belongs to (`Attendance → LiveSession → Group →
 * Course`), or `null` when the chain does not resolve. In-memory twin of
 * `currentCourseAttendanceWhere`, for callers whose rows arrive through an
 * `include` that cannot be narrowed per child.
 */
export function attendanceCourseIdOf(row: {
  session?: { group?: { courseId?: string | null } | null } | null;
}): string | null {
  return row.session?.group?.courseId ?? null;
}

/**
 * The in-memory twin of `currentCourseAttendanceWhere`: TRUE only when the row's
 * session really belongs to the child's CURRENT course. A child without an
 * active course never matches (fail closed), and neither does a row whose
 * session/group chain is gone.
 */
export function isCurrentCourseAttendance(
  row: { session?: { group?: { courseId?: string | null } | null } | null },
  courseId: string | null
): boolean {
  return !!courseId && attendanceCourseIdOf(row) === courseId;
}

/**
 * SQL row filter for the mock-exam attempts of ONE course:
 * `ExamAttempt → MockExam → Course`. `MockExam.courseId` is the identity
 * boundary (Phase K3 made it NOT NULL), so an attempt whose exam row is gone
 * (`mockExamId = null`, `onDelete: SetNull`) or which was never linked to an
 * exam (free practice / an API client) cannot match — exactly the rows the
 * student's own mock-exam list already refuses to count.
 */
export function currentCourseMockExamWhere(
  courseId: string | null
): Record<string, unknown> {
  return { mockExam: { courseId: courseId ?? "" } };
}

/** The canonical curriculum container of a lesson: `topic` first (legacy), then `unit`. */
export type CurriculumContainer = {
  id: string;
  title: string;
  titleAr: string;
};

/**
 * Resolve the canonical curriculum container a lesson belongs to.
 *
 * Phase 19 established the chain (an OFFICIAL lesson is unit-linked and has no
 * `topicId`, so `unit` must be the fallback rather than the other way round);
 * M4.4 adds the missing IDENTITY rule: the caller GROUPS BY `id`, never by the
 * title. The two live curricula reuse container titles, so two units with the
 * same title are two different rows and must never merge.
 *
 * Pure: the caller has already loaded `lesson.topic` / `lesson.unit` (id +
 * titles) inside its own universe-scoped query, so nothing here can widen scope.
 */
export function curriculumContainerOf(
  lesson:
    | {
        topic?: { id?: string | null; title?: string | null; titleAr?: string | null } | null;
        unit?: { id?: string | null; title?: string | null; titleAr?: string | null } | null;
      }
    | null
    | undefined
): CurriculumContainer | null {
  const container = lesson?.topic ?? lesson?.unit ?? null;
  if (!container?.id) return null;
  return {
    id: container.id,
    title: container.title ?? "",
    titleAr: container.titleAr ?? container.title ?? "",
  };
}
