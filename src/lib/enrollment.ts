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
  /**
   * Raw Subscription.status, surfaced for the dashboard//me/enrollment UI
   * (renewal banners, "expiring soon" prompts).
   *
   * DELIBERATELY NOT AN ACCESS GATE. Content access is decided solely by
   * `isEnrolled` (an ACTIVE group bound to a course) in `canAccessCourse` /
   * `canAccessLesson`. Turning this into a paywall would revoke content from
   * every currently-enrolled student whose subscription row is missing or
   * lapsed, which is a business decision and not part of this upgrade. If a
   * subscription gate is ever wanted, it belongs in `canAccessCourse` so the
   * server stays the single source of truth — never in the UI.
   */
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
 * The student's canonical school type, read from their own row.
 *
 * THE ONLY sanctioned way to learn a student's track. It is always derived
 * from the database and always normalised, so every track decision in the
 * platform compares canonical values against each other. `null` means
 * "unspecified" and fails CLOSED downstream (SHARED content only).
 *
 * Never accept a school type from a request: not from a query parameter, not
 * from a body field, not from a batch/lesson/quiz id, and not from the UI
 * locale (Arabic interface != Arabic school).
 */
export async function getStudentSchoolType(
  studentId: string
): Promise<SchoolType | null> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { schoolType: true },
  });
  return normalizeSchoolType(student?.schoolType);
}

/**
 * Ensure the student is attached to the batch matching their school type and
 * course. Batches are created lazily by the admin batch API; this only links
 * an existing batch and never invents school types.
 *
 * @deprecated Use `reconcileStudentBatch` (Phase 12), which also CLEARS a
 * stale batch when the school type or course changes. Kept as an alias so
 * existing callers keep working; it now delegates.
 */
export async function syncStudentBatch(studentId: string): Promise<string | null> {
  const result = await reconcileStudentBatch(studentId);
  return result.batchId;
}

/** Why a reconciliation ended the way it did — surfaced for tests/auditing. */
export type BatchReconcileReason =
  /** Already correct: no write. */
  | "OK"
  /** Had no batch, now attached to the right one. */
  | "ASSIGNED"
  /** Was in the wrong batch, moved to the right one. */
  | "REPLACED"
  /** Was in a wrong-track / wrong-course batch and no correct batch exists. */
  | "CLEARED"
  /** No recognised school type — refused to guess, nothing changed. */
  | "NO_SCHOOL_TYPE"
  /** Correct school type known, but no active batch exists for it. */
  | "NO_BATCH";

export type BatchReconciliation = {
  batchId: string | null;
  /** True when a write was performed. False on a no-op (idempotent re-run). */
  changed: boolean;
  reason: BatchReconcileReason;
};

/**
 * Reconcile a student's batch membership. DETERMINISTIC and IDEMPOTENT:
 * running it twice in a row always returns `changed: false` the second time,
 * and the outcome depends only on the student's current row — never on what
 * the client sent, and never on which endpoint happened to be visited first.
 *
 * WHY THIS EXISTS
 * `Student.batchId` used to be written in three ad-hoc places and never
 * re-derived, so it went STICKY: changing a student's school type moved them
 * only if the admin used exactly the right field, and changing their GROUP
 * (i.e. their course) never touched the batch at all — leaving them attached
 * to a batch belonging to a course they are no longer in. Session videos and
 * the question bank are keyed off the batch, so a stale id silently served the
 * wrong segment.
 *
 * THE RULES
 *   1. A student with no RECOGNISED school type is never assigned a batch.
 *      Guessing one would silently decide which track content and which
 *      recordings they receive, so it fails closed instead (NO_SCHOOL_TYPE).
 *   2. Target batch = ACTIVE batch whose `schoolType` equals the student's,
 *      preferring the one bound to the student's CURRENT course, then a
 *      course-less one. A batch belonging to a DIFFERENT course is never
 *      selected — explicitly, not via an ORDER BY side effect.
 *   3. When no correct batch exists, a batch that is wrong (different school
 *      type, or bound to a different course) is CLEARED rather than kept: a
 *      stale wrong-track batch is worse than no batch.
 *
 * CALL SITES (every write path that can change the outcome): registration,
 * admin student create, admin student update (schoolType OR groupId), self
 * enrollment, and batch creation.
 */
export async function reconcileStudentBatch(
  studentId: string
): Promise<BatchReconciliation> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      batchId: true,
      schoolType: true,
      batch: { select: { id: true, schoolType: true, courseId: true } },
      group: { select: { isActive: true, course: { select: { id: true } } } },
    },
  });
  if (!student) return { batchId: null, changed: false, reason: "NO_SCHOOL_TYPE" };

  const schoolType = normalizeSchoolType(student.schoolType);
  // Rule 1 — fail closed, never guess.
  if (!schoolType) {
    return {
      batchId: student.batchId,
      changed: false,
      reason: "NO_SCHOOL_TYPE",
    };
  }

  const courseId =
    student.group?.isActive && student.group.course ? student.group.course.id : null;

  // Rule 2 — course-specific batch first, then a course-less one. Two explicit
  // lookups, so "never another course's batch" is a property of the query
  // rather than of a sort order.
  const target =
    (courseId
      ? await db.batch.findFirst({
          where: { schoolType, courseId, isActive: true },
          orderBy: { createdAt: "asc" },
          select: { id: true },
        })
      : null) ??
    (await db.batch.findFirst({
      where: { schoolType, courseId: null, isActive: true },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    }));

  if (target) {
    if (student.batchId === target.id) {
      return { batchId: target.id, changed: false, reason: "OK" };
    }
    await db.student.update({
      where: { id: studentId },
      data: { batchId: target.id },
    });
    return {
      batchId: target.id,
      changed: true,
      reason: student.batchId ? "REPLACED" : "ASSIGNED",
    };
  }

  // Rule 3 — no correct batch exists. Drop a wrong one, keep a right one.
  const current = student.batch;
  if (!current) return { batchId: null, changed: false, reason: "NO_BATCH" };

  const wrongTrack = current.schoolType !== schoolType;
  const wrongCourse = current.courseId !== null && current.courseId !== courseId;
  if (wrongTrack || wrongCourse) {
    await db.student.update({
      where: { id: studentId },
      data: { batchId: null },
    });
    return { batchId: null, changed: true, reason: "CLEARED" };
  }
  return { batchId: current.id, changed: false, reason: "OK" };
}

/**
 * Attach every still-unattached student of a newly created batch.
 *
 * Called from the batch-creation route so a batch does not only take effect
 * when each student happens to visit an unrelated read endpoint. It only ever
 * ASSIGNS students that currently have NO batch — it never reassigns one, so
 * it cannot pull a student off a correct course-specific batch and it is
 * idempotent by construction.
 */
export async function attachUnassignedStudentsToBatch(
  batchId: string
): Promise<number> {
  const batch = await db.batch.findUnique({
    where: { id: batchId },
    select: { id: true, schoolType: true, courseId: true, isActive: true },
  });
  if (!batch || !batch.isActive) return 0;

  const candidates = await db.student.findMany({
    where: {
      batchId: null,
      schoolType: batch.schoolType,
      ...(batch.courseId ? { group: { courseId: batch.courseId, isActive: true } } : {}),
    },
    select: { id: true },
  });
  if (candidates.length === 0) return 0;

  await db.student.updateMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    data: { batchId: batch.id },
  });
  return candidates.length;
}
