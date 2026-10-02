import { getServerT } from "@/lib/i18n-server";
// PATCH /api/admin/students/[id] — update student (deactivate, change group)
import { NextRequest, NextResponse } from "next/server";
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
// THE CONTRACT (Phase L manual-QA fix #4, REVISED — conservative by design)
// ========================================================================
// Hard delete is allowed ONLY for a genuinely clean identity. Having no
// Payment row does NOT make a student disposable: academic history is just as
// durable as financial history, and the platform never erases it as a side
// effect of removing a login.
//
//   1. EVERY protected class is counted BEFORE anything is touched. If ANY
//      protected row exists the request FAILS CLOSED with 409 and NOTHING —
//      not the Student, not the User, not one dependent row — is removed. The
//      response names the rule and returns a per-category breakdown so the
//      admin can see exactly what would have been destroyed, and points at the
//      existing deactivate flow as the supported alternative.
//
//   2. WHEN the identity is clean, only SAFE scaffolding is removed (current
//      parent linkage, session tokens, reset tokens, notification settings)
//      plus the Student and User rows themselves — in ONE transaction, so a
//      failure anywhere rolls everything back. Nothing here is classified
//      "safe" merely because the FK cascades; each entry is justified by what
//      the row IS.
//
//   3. TWO TABLES ARE PRESERVED AND DETACHED (`userId: null`), because that is
//      what the schema itself declares (`onDelete: SetNull`): SecurityEvent
//      and TeacherApplication. Detaching loses no history, so neither is a
//      blocker.
//
//   4. WHY NOT RELY ON DATABASE CASCADES AT ALL: the SQLite migration history
//      declares several tables without the foreign keys the Prisma schema
//      describes (verified with PRAGMA foreign_key_list), so a cascade-driven
//      delete would leave SILENT ORPHANS in development while behaving
//      differently on PostgreSQL. Every row this handler removes is named
//      explicitly, so both engines behave identically.
//
// NO archive table, NO soft-delete column, NO schema change, NO migration.
//
// The audit entry is written AFTER the delete by the ADMIN's own account, so
// the record of the deletion itself survives the student.
// ---------------------------------------------------------------------------

/** The report categories the refusal message is grouped into. */
type ProtectedCategory =
  | "financial"
  | "subscription"
  | "attendance"
  | "assessments"
  | "progress"
  | "notes"
  | "achievements"
  | "account";

/** Which identity a column points at — never inferred from the field name. */
type IdentityScopeKey = "STUDENT" | "USER";

/**
 * The `where` clause a step is counted/deleted with. The scope is EXPLICIT on
 * every entry (`by`), because a name-based guess is exactly how a
 * `grantedByUserId` row can look like a `studentId` row and slip past the
 * guard: `QuizRetryGrant.grantedByUserId` points at a USER (the student's
 * account), while the row's `studentId` points at the profile.
 */
function scopeWhere(step: { field: string; by: IdentityScopeKey }, id: string, userId: string) {
  return { [step.field]: step.by === "USER" ? userId : id };
}

/** Rows that must NEVER be erased as a side effect of deleting an identity. */
const PROTECTED_HISTORY: ReadonlyArray<{
  model: string;
  field: string;
  by: IdentityScopeKey;
  category: ProtectedCategory;
}> = [
  // --- money ---------------------------------------------------------------
  { model: "payment", field: "userId", by: "USER", category: "financial" },
  { model: "couponRedemption", field: "userId", by: "USER", category: "financial" },
  // --- enrolment / plan history -------------------------------------------
  { model: "subscription", field: "studentId", by: "STUDENT", category: "subscription" },
  { model: "enrollment", field: "studentId", by: "STUDENT", category: "subscription" },
  // --- attendance + absence ------------------------------------------------
  { model: "attendance", field: "studentId", by: "STUDENT", category: "attendance" },
  { model: "attendanceCorrection", field: "studentId", by: "STUDENT", category: "attendance" },
  { model: "absenceReview", field: "studentId", by: "STUDENT", category: "attendance" },
  { model: "absenceHold", field: "studentId", by: "STUDENT", category: "attendance" },
  // --- graded work ---------------------------------------------------------
  { model: "quizAttempt", field: "studentId", by: "STUDENT", category: "assessments" },
  { model: "quizRetryGrant", field: "studentId", by: "STUDENT", category: "assessments" },
  // A grant this student ISSUED to another student is academic history too.
  { model: "quizRetryGrant", field: "grantedByUserId", by: "USER", category: "assessments" },
  { model: "homeworkSubmission", field: "studentId", by: "STUDENT", category: "assessments" },
  { model: "examAttempt", field: "studentId", by: "STUDENT", category: "assessments" },
  // --- progression ---------------------------------------------------------
  { model: "lessonProgress", field: "studentId", by: "STUDENT", category: "progress" },
  { model: "progressionOverride", field: "studentId", by: "STUDENT", category: "progress" },
  { model: "sessionVideoView", field: "studentId", by: "STUDENT", category: "progress" },
  // --- notes / study artefacts --------------------------------------------
  { model: "teacherNote", field: "studentId", by: "STUDENT", category: "notes" },
  { model: "lessonNote", field: "studentId", by: "STUDENT", category: "notes" },
  { model: "lessonBookmark", field: "studentId", by: "STUDENT", category: "notes" },
  { model: "studyTask", field: "studentId", by: "STUDENT", category: "notes" },
  // --- achievements / referral programme -----------------------------------
  { model: "studentBadge", field: "studentId", by: "STUDENT", category: "achievements" },
  { model: "referral", field: "referrerId", by: "STUDENT", category: "achievements" },
  { model: "referral", field: "referredId", by: "STUDENT", category: "achievements" },
  // --- account history -----------------------------------------------------
  { model: "notification", field: "userId", by: "USER", category: "account" },
  { model: "auditLog", field: "userId", by: "USER", category: "account" },
] as const;

/**
 * Account scaffolding removed WITH a clean identity: current linkage, session
 * tokens, notification preferences. Each entry is justified by WHAT IT IS
 * (a pointer or a credential), never by "the FK happens to cascade".
 */
const SAFE_IDENTITY_DELETE: ReadonlyArray<{
  model: string;
  field: string;
  by: IdentityScopeKey;
}> = [
  { model: "parentStudentLink", field: "studentId", by: "STUDENT" }, // current parent↔student pointer
  { model: "notificationPreference", field: "userId", by: "USER" }, // settings, not history
  { model: "userSession", field: "userId", by: "USER" }, // live session tokens (credentials)
  { model: "passwordResetToken", field: "userId", by: "USER" }, // one-shot credentials
] as const;

/** Rows that are DETACHED (never deleted) because the schema says SetNull. */
const PRESERVED_DETACH: ReadonlyArray<{
  model: string;
  field: string;
  by: IdentityScopeKey;
}> = [
  { model: "securityEvent", field: "userId", by: "USER" },
  { model: "teacherApplication", field: "userId", by: "USER" },
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

  // -------------------------------------------------------------------------
  // 1. CLASSIFY — count every PROTECTED class, in parallel, before touching
  //    anything. A single non-empty class is enough to refuse the delete.
  // -------------------------------------------------------------------------
  const counts = await Promise.all(
    PROTECTED_HISTORY.map((step) =>
      (db as never as Record<string, { count: (a: unknown) => Promise<number> }>)[step.model]
        .count({ where: scopeWhere(step, id, student.userId) })
        .then((n: number) => ({ ...step, count: n }))
    )
  );

  // The two "account shape" conflicts: this identity also exists as a PARENT
  // profile (its links would cascade to OTHER students' rows) or as a TEACHER
  // profile (a staff account is never a deletable student). Both fail closed.
  const [parentProfiles, teacherProfiles] = await Promise.all([
    db.parent.count({ where: { userId: student.userId } }),
    db.teacher.count({ where: { userId: student.userId } }),
  ]);

  const blockedByCategory = new Map<ProtectedCategory, number>();
  for (const row of counts) {
    if (row.count > 0) {
      blockedByCategory.set(row.category, (blockedByCategory.get(row.category) ?? 0) + row.count);
    }
  }
  if (parentProfiles > 0 || teacherProfiles > 0) {
    blockedByCategory.set(
      "account",
      (blockedByCategory.get("account") ?? 0) + parentProfiles + teacherProfiles
    );
  }

  if (blockedByCategory.size > 0) {
    const blocked = Object.fromEntries(
      Array.from(blockedByCategory.entries()).sort(([a], [b]) => a.localeCompare(b))
    ) as Record<ProtectedCategory, number>;
    const total = Object.values(blocked).reduce((a, b) => a + b, 0);
    // The refusal names the RULE first, then the specific guidance when money
    // is involved (the financial ledger always wins over a deletion), and the
    // body carries the per-category breakdown so the admin can see exactly
    // what would have been destroyed.
    const message =
      blocked.financial > 0
        ? `${tApi("api.382", { p1: total })} ${tApi("api.379", {
            p1: counts.find((c) => c.model === "payment")?.count ?? 0,
            p2: counts.find((c) => c.model === "couponRedemption")?.count ?? 0,
          })}`
        : tApi("api.382", { p1: total });
    return NextResponse.json(
      { ok: false, error: message, code: "STUDENT_HAS_PROTECTED_HISTORY", blocked, blockedTotal: total },
      { status: 409 }
    );
  }

  // -------------------------------------------------------------------------
  // 2. CLEAN IDENTITY — no protected history exists. Remove only the account
  //    scaffolding, detach the preserved records, then the Student and the
  //    User, ALL inside ONE transaction: a failure anywhere rolls back every
  //    step, so a half-deleted person can never be committed.
  // -------------------------------------------------------------------------
  try {
    await db.$transaction(async (tx) => {
      for (const step of SAFE_IDENTITY_DELETE) {
        await (tx as never as Record<string, { deleteMany: (a: unknown) => Promise<unknown> }>)[
          step.model
        ].deleteMany({ where: scopeWhere(step, id, student.userId) });
      }

      // PRESERVED — detached, never deleted (the schema's own SetNull contract).
      for (const step of PRESERVED_DETACH) {
        await (tx as never as Record<string, { updateMany: (a: unknown) => Promise<unknown> }>)[
          step.model
        ]
          .updateMany({
            where: scopeWhere(step, id, student.userId),
            data: { userId: null },
          })
          .catch(() => undefined);
      }

      // Finally the identity itself. Relation-declared children were counted
      // above, so nothing here can cascade a protected row away: if any
      // protected row appeared between the count and this line (a concurrent
      // write), the transaction fails and rolls back — it never deletes it.
      await tx.student.delete({ where: { id } });
      await tx.user.delete({ where: { id: student.userId } });
    });
  } catch {
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
          contract: "CLEAN_IDENTITY_ONLY",
          protectedHistory: "NONE",
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return ok({ ok: true, deleted: true, id });
}
