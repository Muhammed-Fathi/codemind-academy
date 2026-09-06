// CodeMind Academy — Enrollment resolution (server-side source of truth).
//
// The platform expresses enrollment as: Student.groupId -> Group.courseId,
// with Subscription carrying the paid state. There is no separate Enrollment
// table and none is introduced.

import { db } from "@/lib/db";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";

export type Enrollment = {
  isEnrolled: boolean;
  courseId: string | null;
  courseSlug: string | null;
  groupId: string | null;
  batchId: string | null;
  schoolType: SchoolType | null;
  /** ACTIVE subscription is required for full content access. */
  subscriptionStatus: string | null;
};

/**
 * Resolve the enrollment of a student. A student is considered enrolled when
 * they belong to an active group bound to a course.
 */
export async function getEnrollment(studentId: string): Promise<Enrollment> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      groupId: true,
      batchId: true,
      schoolType: true,
      group: { select: { id: true, isActive: true, course: { select: { id: true, slug: true } } } },
      subscription: { select: { status: true } },
    },
  });

  const schoolType = normalizeSchoolType(student?.schoolType);

  if (!student?.group?.isActive || !student.group.course) {
    return {
      isEnrolled: false,
      courseId: null,
      courseSlug: null,
      groupId: student?.groupId ?? null,
      batchId: student?.batchId ?? null,
      schoolType,
      subscriptionStatus: student?.subscription?.status ?? null,
    };
  }

  return {
    isEnrolled: true,
    courseId: student.group.course.id,
    courseSlug: student.group.course.slug,
    groupId: student.group.id,
    batchId: student.batchId,
    schoolType,
    subscriptionStatus: student.subscription?.status ?? null,
  };
}

/** Server-side check: may this student access this course? */
export async function canAccessCourse(
  studentId: string,
  courseId: string
): Promise<boolean> {
  const enrollment = await getEnrollment(studentId);
  return enrollment.isEnrolled && enrollment.courseId === courseId;
}

/**
 * Ensure the student is attached to the batch matching their school type and
 * course. Batches are created lazily by the admin batch API; this only links
 * an existing batch and never invents school types.
 */
export async function syncStudentBatch(studentId: string): Promise<string | null> {
  const enrollment = await getEnrollment(studentId);
  if (!enrollment.schoolType) return null;

  const batch = await db.batch.findFirst({
    where: {
      schoolType: enrollment.schoolType,
      isActive: true,
      OR: [{ courseId: enrollment.courseId }, { courseId: null }],
    },
    orderBy: { courseId: "desc" }, // prefer the course-specific batch
    select: { id: true },
  });
  if (!batch || batch.id === enrollment.batchId) return batch?.id ?? null;

  await db.student.update({ where: { id: studentId }, data: { batchId: batch.id } });
  return batch.id;
}
