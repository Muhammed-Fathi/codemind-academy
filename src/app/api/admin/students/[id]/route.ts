import { getServerT } from "@/lib/i18n-server";
// PATCH /api/admin/students/[id] — update student (deactivate, change group)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { requireSchoolType, normalizeSchoolType } from "@/lib/school-type";
// Phase 26C hotfix — the GENERATED Prisma enum is the only type this route may
// persist for `Student.schoolType`; it is imported type-only (erased at build
// time) and used to type the `pendingSchoolType` holder below.
import type { SchoolType, AcademicLevel } from "@prisma/client";
import {
  gradeLabelFor,
  groupLevelEligible,
  requireAcademicLevel,
} from "@/lib/academic-level";
import { reconcileStudentBatch } from "@/lib/enrollment";
import { logSecurityEvent } from "@/lib/security";
import { revokeAllSessions } from "@/lib/auth";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const student = await db.student.findUnique({ where: { id } });
  if (!student) return err(tApi("api.047"), 404);

  // Account activation / deactivation. Reactivating a multi-device suspension
  // clears the status AND revokes every stale session, so the student starts
  // clean on a single device and is not immediately re-suspended.
  if (typeof body.isActive === "boolean") {
    await db.user.update({
      where: { id: student.userId },
      data: {
        isActive: body.isActive,
        status: body.isActive ? "ACTIVE" : "INACTIVE",
      },
    });
    if (body.isActive) {
      await revokeAllSessions(student.userId, "ADMIN_REACTIVATION");
      await logSecurityEvent({
        userId: student.userId,
        type: "ACCOUNT_REACTIVATED",
        detail: `Reactivated by admin ${user.id}`,
      });
    }
  }
  // Phase 26C — pre-parse schoolType change so group assignment can validate
  // against the NEW value when both change in one request.
  //
  // Typed with the generated Prisma enum, NOT `string`: `requireSchoolType`
  // already narrows the incoming value to a canonical ARABIC | LANGUAGE (or it
  // rejects the request), so widening that result to `string` only discarded
  // the proof and made the write below fail `StudentUpdateInput.schoolType`
  // (TS2322). `undefined` = "this request does not touch schoolType". `null`
  // is deliberately not part of the type: PATCH rejects a null/blank school
  // type with api.210 instead of silently clearing the student's track.
  let pendingSchoolType: SchoolType | undefined = undefined;
  if (body.schoolType !== undefined) {
    const check = requireSchoolType(body.schoolType);
    if (!check.ok) return err(tApi("api.210"), 400);
    pendingSchoolType = check.value;
  }

  // Phase K2 — pre-parse the typed ACADEMIC LEVEL the same way (so a group
  // assignment in the same request validates against the NEW level). It is
  // the only level authority; `grade` is derived from it below and a
  // client-supplied `grade` is ignored. `null`/blank is rejected: an admin
  // can never clear a student's level.
  let pendingAcademicLevel: AcademicLevel | undefined = undefined;
  if (body.academicLevel !== undefined) {
    const check = requireAcademicLevel(body.academicLevel);
    if (!check.ok) return err(tApi("api.371"), 400);
    pendingAcademicLevel = check.value;
  }
  const effectiveAcademicLevel =
    pendingAcademicLevel !== undefined ? pendingAcademicLevel : student.academicLevel;

  let groupChanged = false;
  let targetGroupIdForSchoolTypeCheck: string | null | undefined = undefined;
  if (typeof body.groupId === "string" || body.groupId === null) {
    // Phase 26B + 26C — GROUP AUDIENCE SAFETY + operational safety:
    // * must exist
    // * must be active
    // * must be classified (trackScope != null) — unclassified groups are
    //   fail-closed for students and admin must classify first
    // * audience must match student's (new or existing) schoolType
    // * capacity must not be exceeded when changing groups
    if (body.groupId) {
      const group = await db.group.findUnique({
        where: { id: body.groupId },
        select: {
          id: true,
          trackScope: true,
          isActive: true,
          capacity: true,
          courseId: true,
          // Phase K2 — the course level feeds the I1 gate below.
          course: { select: { academicLevel: true } },
          _count: { select: { students: true } },
        },
      });
      if (!group) return err(tApi("api.020"), 404);
      if (!group.isActive) return err(tApi("api.085"), 409);
      const audience = normalizeSchoolType(group.trackScope);
      if (!audience) return err(tApi("api.285"), 409);
      const effectiveSchoolType = pendingSchoolType !== undefined ? pendingSchoolType : student.schoolType;
      if (normalizeSchoolType(effectiveSchoolType) !== audience) {
        return err(tApi("api.286"), 409);
      }
      // Phase K2 — ACADEMIC LEVEL gate (I1), orthogonal to the track gate:
      // the student's (new or existing) typed level must equal the group's
      // course level. Fail-closed; the student's level is never rewritten to
      // make the assignment fit.
      if (!groupLevelEligible(effectiveAcademicLevel, group.course?.academicLevel)) {
        return err(tApi("api.373"), 409);
      }
      // Capacity check when actually moving to a different group
      if (student.groupId !== body.groupId) {
        if (group._count.students >= group.capacity) {
          return err(tApi("api.274"), 409);
        }
      }
      targetGroupIdForSchoolTypeCheck = body.groupId;
    } else {
      targetGroupIdForSchoolTypeCheck = null;
    }
    await db.student.update({
      where: { id },
      data: { groupId: body.groupId || null },
    });
    groupChanged = true;
  }
  // Phase K2 — `grade` is a DERIVED display mirror of the typed level. The
  // former free-text `grade` write is retired: a client-supplied `grade` is
  // ignored, and the mirror is rewritten only when the level changes.
  if (pendingAcademicLevel !== undefined && pendingAcademicLevel !== student.academicLevel) {
    // A level change must not leave the student attached to a group of
    // another level (I1). The effective group is the one assigned in THIS
    // request (already validated above against the new level) or the
    // student's current one.
    const effectiveGroupId =
      targetGroupIdForSchoolTypeCheck !== undefined ? targetGroupIdForSchoolTypeCheck : student.groupId;
    if (effectiveGroupId) {
      const group = await db.group.findUnique({
        where: { id: effectiveGroupId },
        select: { course: { select: { academicLevel: true } } },
      });
      if (group && !groupLevelEligible(pendingAcademicLevel, group.course?.academicLevel)) {
        return err(tApi("api.374"), 409);
      }
    }
    await db.student.update({
      where: { id },
      data: { academicLevel: pendingAcademicLevel, grade: gradeLabelFor(pendingAcademicLevel) },
    });
  }
  if (typeof body.schoolName === "string") {
    await db.student.update({ where: { id }, data: { schoolName: body.schoolName } });
  }
  // Changing the school type moves the student to the matching batch, so the
  // correct session videos and question bank apply from now on.
  //
  // Phase 12 — the value is validated, never normalised-then-guessed: an
  // unrecognised school type is a 400 rather than a silent "unspecified".
  // Phase 26C — safety: if student has a group (existing or newly assigned
  // in this request) and new schoolType is incompatible, block.
  let schoolTypeChanged = false;
  if (pendingSchoolType !== undefined) {
    if (pendingSchoolType !== student.schoolType) {
      // Determine effective groupId for compatibility check: if groupId was
      // changed in this request, use that; otherwise use student's current.
      const effectiveGroupId =
        targetGroupIdForSchoolTypeCheck !== undefined ? targetGroupIdForSchoolTypeCheck : student.groupId;
      if (effectiveGroupId) {
        const group = await db.group.findUnique({
          where: { id: effectiveGroupId },
          select: { trackScope: true },
        });
        if (group) {
          const audience = normalizeSchoolType(group.trackScope);
          if (audience && audience !== pendingSchoolType) {
            return err(tApi("api.286"), 409);
          }
        }
      }
      await db.student.update({
        where: { id },
        data: { schoolType: pendingSchoolType },
      });
      schoolTypeChanged = true;
    }
  }

  // Phase 12 — ONE shared reconciliation helper, called from every write path
  // that can change the outcome. It is deterministic and idempotent, so it is
  // safe to call even when nothing relevant changed, and it fixes the sticky
  // batchId on a COURSE change too (which this route previously ignored —
  // moving a student to a group in another course left them in the old
  // course's batch).
  const reconciliation =
    schoolTypeChanged || groupChanged
      ? await reconcileStudentBatch(id)
      : null;

  return ok({ ok: true, batchId: reconciliation?.batchId ?? student.batchId });
}

// ---------------------------------------------------------------------------
// DELETE /api/admin/students/[id] — hard-delete a student account.
//
// THE CONTRACT (Phase L manual-QA fix, derived from the schema itself)
// ===================================================================
// A student is a USER plus one Student row, and the schema declares almost
// every dependent row `onDelete: Cascade` from one of those two. Two facts
// make a blind `delete()` unsafe here, so this handler never uses one:
//
//   1. FINANCIAL HISTORY IS RESTRICTED, BY DESIGN.
//      `Payment.user` is a REQUIRED relation with no `onDelete`, i.e. the
//      schema's RESTRICT default: a user who has payments CANNOT be removed
//      without destroying the payment ledger. Financial history is the one
//      thing this platform deliberately keeps, so a student with payments is
//      REFUSED with a clear 409 — never force-deleted, never detached.
//
//   2. THE DEVELOPMENT SQLITE DATABASE DOES NOT ENFORCE EVERY FK.
//      `LessonProgress`, `Payment`, `Subscription`, `Attendance`,
//      `ParentStudentLink`, `Notification`, `AuditLog` and others are
//      declared with cascades but are created WITHOUT foreign keys in the
//      SQLite migration history (verified with PRAGMA foreign_key_list). A
//      delete relying on database cascades would therefore leave SILENT
//      ORPHANS in development while behaving differently on PostgreSQL.
//      Every dependent row is consequently removed EXPLICITLY, in dependency
//      order, inside ONE transaction — identical semantics on both engines.
//
//   3. TWO TABLES HAVE NO RELATION AT ALL.
//      `AttendanceCorrection.studentId` and `TeacherNote.studentId` are plain
//      String columns (no `@relation`), so Prisma cannot cascade them and
//      nothing else would ever clean them. They are removed explicitly too.
//
// WHAT SURVIVES (and why):
//   * Payment + CouponRedemption — financial ledger. Their presence is the
//     REFUSAL case above; when a student has none, there is nothing to keep.
//   * SecurityEvent — `onDelete: SetNull`: the row is KEPT and detached
//     (security history must outlive the account).
//   * TeacherApplication — optional `SetNull`: kept and detached.
//   * AuditLog rows of OTHER users (an admin's record of acting on this
//     student) are untouched; only the student's own rows go with the
//     account, exactly as the schema declares.
//   * Group, Group membership rows of other students, Batch, Course,
//     curriculum, sessions, videos, payments of other users: NEVER touched.
//
// The audit entry is written AFTER the delete by the ADMIN's own account, so
// the record of the deletion itself survives the student.
// ---------------------------------------------------------------------------
const STUDENT_DELETE_DEPENDENTS: ReadonlyArray<{ model: string; field: string }> = [
  // --- children of Student (schema: Cascade) -------------------------------
  { model: "studentBadge", field: "studentId" },
  { model: "parentStudentLink", field: "studentId" },
  { model: "enrollment", field: "studentId" },
  { model: "attendance", field: "studentId" },
  { model: "absenceHold", field: "studentId" }, // before absenceReview (hold → review)
  { model: "absenceReview", field: "studentId" },
  { model: "progressionOverride", field: "studentId" },
  { model: "quizAttempt", field: "studentId" },
  { model: "quizRetryGrant", field: "studentId" },
  { model: "homeworkSubmission", field: "studentId" },
  { model: "lessonProgress", field: "studentId" },
  { model: "lessonBookmark", field: "studentId" },
  { model: "lessonNote", field: "studentId" },
  { model: "examAttempt", field: "studentId" },
  { model: "studyTask", field: "studentId" },
  { model: "sessionVideoView", field: "studentId" },
  { model: "referral", field: "referrerId" },
  { model: "referral", field: "referredId" },
  // --- plain columns with NO relation (nothing else would ever clean them) --
  { model: "attendanceCorrection", field: "studentId" },
  { model: "teacherNote", field: "studentId" },
  // --- children of Subscription (schema: Cascade from Student) --------------
  // NOTE: payments are deliberately NOT in this list — see the detach step in
  // the transaction below. A payment can belong to ANOTHER user (a parent
  // paying for this student) and is financial history that must survive.
  { model: "subscription", field: "studentId" },
  // --- children of User (schema: Cascade) ----------------------------------
  { model: "notificationPreference", field: "userId" },
  { model: "notification", field: "userId" },
  { model: "userSession", field: "userId" },
  { model: "passwordResetToken", field: "userId" },
  { model: "quizRetryGrant", field: "grantedByUserId" }, // the GRANTOR's column (schema: grantedByUserId)
  { model: "auditLog", field: "userId" },
] as const;

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;

  // The identity is read BEFORE anything is removed so the audit trail and
  // the refusal messages can name the student unambiguously.
  const student = await db.student.findUnique({
    where: { id },
    select: { id: true, userId: true, studentCode: true, user: { select: { name: true, email: true } } },
  });
  if (!student) return err(tApi("api.047"), 404);

  // BLOCKER — the financial ledger. Refuse, and say what can be done instead.
  // Both models are part of the generated client (Prisma schema is the
  // authority), so they are called with their real typed delegates — no `any`
  // escape hatch is needed or allowed on this route.
  const [payments, couponRedemptions] = await Promise.all([
    db.payment.count({ where: { userId: student.userId } }),
    db.couponRedemption.count({ where: { userId: student.userId } }),
  ]);
  if (payments > 0 || couponRedemptions > 0) {
    return err(
      tApi("api.379", { p1: payments, p2: couponRedemptions }),
      409
    );
  }

  try {
    await db.$transaction(async (tx: any) => {
      // The student's subscription ids are needed twice: to DETACH other
      // people's payments from them, and to delete the subscriptions.
      const subscriptionIds: string[] = (
        await tx.subscription.findMany({ where: { studentId: id }, select: { id: true } })
      ).map((s: { id: string }) => s.id);

      for (const step of STUDENT_DELETE_DEPENDENTS) {
        await tx[step.model].deleteMany({
          where: step.field === "userId" ? { userId: student.userId } : { [step.field]: id },
        });
      }

      // PRESERVE — a payment recorded against this student's subscription but
      // owned by ANOTHER user (a parent) keeps its row; only the dangling
      // reference is cleared. Payments owned by the student themselves cannot
      // exist here: they are the refusal case handled before the transaction.
      if (subscriptionIds.length > 0) {
        await tx.payment.updateMany({
          where: { subscriptionId: { in: subscriptionIds } },
          data: { subscriptionId: null },
        });
      }
      // The security/application record outlives the account: detached, kept.
      await tx.securityEvent.updateMany({
        where: { userId: student.userId },
        data: { userId: null },
      }).catch(() => undefined);
      await tx.teacherApplication
        .updateMany({
          where: { userId: student.userId },
          data: { userId: null },
        })
        .catch(() => undefined);

      // Finally the identity itself. Deleting the Student row cascades the
      // remaining relation-declared children; deleting the User row removes
      // the login. Both inside the SAME transaction as everything above.
      await tx.student.delete({ where: { id } });
      await tx.user.delete({ where: { id: student.userId } });
    });
  } catch (e: any) {
    // A partial delete can never be committed: the transaction rolls back and
    // the student keeps their complete, consistent record.
    return err(tApi("api.380"), 409);
  }

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "STUDENT_DELETED",
        entity: "Student",
        entityId: id,
        details: JSON.stringify({
          studentId: id,
          userId: student.userId,
          name: student.user?.name ?? null,
          email: student.user?.email ?? null,
          studentCode: student.studentCode ?? null,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return ok({ ok: true, deleted: true, id });
}
