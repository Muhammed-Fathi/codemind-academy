import { getServerT } from "@/lib/i18n-server";
// PATCH /api/admin/students/[id] — update student (deactivate, change group)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { requireSchoolType } from "@/lib/school-type";
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
  let groupChanged = false;
  if (typeof body.groupId === "string" || body.groupId === null) {
    await db.student.update({
      where: { id },
      data: { groupId: body.groupId || null },
    });
    groupChanged = true;
  }
  if (typeof body.grade === "string") {
    await db.student.update({ where: { id }, data: { grade: body.grade } });
  }
  if (typeof body.schoolName === "string") {
    await db.student.update({ where: { id }, data: { schoolName: body.schoolName } });
  }
  // Changing the school type moves the student to the matching batch, so the
  // correct session videos and question bank apply from now on.
  //
  // Phase 12 — the value is validated, never normalised-then-guessed: an
  // unrecognised school type is a 400 rather than a silent "unspecified".
  let schoolTypeChanged = false;
  if (body.schoolType !== undefined) {
    const check = requireSchoolType(body.schoolType);
    if (!check.ok) return err(tApi("api.210"), 400);
    if (check.value !== student.schoolType) {
      await db.student.update({
        where: { id },
        data: { schoolType: check.value },
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
