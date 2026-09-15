// PATCH /api/admin/teachers/[id] — deactivate/reactivate teacher account
// Phase 26C — teacher lifecycle operational completeness

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
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
  const teacher = await db.teacher.findUnique({
    where: { id },
    select: { id: true, userId: true },
  });
  if (!teacher) return err(tApi("api.047"), 404);

  const body = await req.json().catch(() => ({}));

  if (typeof body.isActive === "boolean") {
    await db.user.update({
      where: { id: teacher.userId },
      data: {
        isActive: body.isActive,
        status: body.isActive ? "ACTIVE" : "INACTIVE",
      },
    });
    if (body.isActive) {
      await revokeAllSessions(teacher.userId, "ADMIN_REACTIVATION_TEACHER");
      await logSecurityEvent({
        userId: teacher.userId,
        type: "ACCOUNT_REACTIVATED",
        detail: `Teacher reactivated by admin ${user.id}`,
      });
    } else {
      await db.userSession.updateMany({
        where: { userId: teacher.userId, revokedAt: null },
        data: { revokedAt: new Date(), revokedReason: "ADMIN_DEACTIVATED_TEACHER" },
      });
      await logSecurityEvent({
        userId: teacher.userId,
        type: "ACCOUNT_DEACTIVATED",
        detail: `Teacher deactivated by admin ${user.id}`,
      });
    }

    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: body.isActive ? "TEACHER_REACTIVATED" : "TEACHER_DEACTIVATED",
          entity: "Teacher",
          entityId: id,
          details: JSON.stringify({ teacherId: id, isActive: body.isActive }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }

  return ok({ ok: true });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const teacher = await db.teacher.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, isActive: true, status: true } },
      groups: { select: { id: true, name: true, course: { select: { nameAr: true } } } },
      sessions: { select: { id: true, title: true, titleAr: true, startAt: true, status: true }, orderBy: { startAt: "desc" }, take: 20 },
    },
  });
  if (!teacher) return err("Teacher not found", 404);

  return ok({ teacher });
}
