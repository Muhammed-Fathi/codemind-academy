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
