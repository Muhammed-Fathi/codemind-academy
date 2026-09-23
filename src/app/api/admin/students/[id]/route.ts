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
