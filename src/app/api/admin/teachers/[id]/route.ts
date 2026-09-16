// PATCH /api/admin/teachers/[id] — deactivate/reactivate teacher account
// Phase 26C — teacher lifecycle operational completeness
// Post-launch audit — also the teacher PROFILE edit endpoint (name, email,
// phone, bio, specialty). Deactivation stays exactly as designed: it revokes
// sessions and is audited. Profile edits are audited too and never touch
// role/status/isActive (those remain their own explicit operations).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { logSecurityEvent } from "@/lib/security";
import { revokeAllSessions } from "@/lib/auth";
import { isValidEmail, isValidEgyptianPhone, normalizePhone } from "@/lib/registration";

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
    select: { id: true, userId: true, bio: true, specialty: true, user: { select: { name: true, email: true, phone: true } } },
  });
  if (!teacher) return err(tApi("api.047"), 404);

  const body = await req.json().catch(() => ({}));

  // ---- Profile edit (post-launch audit): safe contact/identity fields only.
  const userData: { name?: string; email?: string; phone?: string | null } = {};
  const teacherData: { bio?: string | null; specialty?: string | null } = {};

  if (body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name || name.length > 120) return err(tApi("api.297"), 400);
    userData.name = name;
  }
  if (body.email !== undefined) {
    const email = String(body.email || "").toLowerCase().trim();
    if (!isValidEmail(email)) return err(tApi("api.060"), 400);
    if (email !== teacher.user.email) {
      const clash = await db.user.findUnique({ where: { email } });
      if (clash) return err(tApi("api.053"), 409);
      userData.email = email;
    }
  }
  if (body.phone !== undefined) {
    const raw = body.phone === null ? "" : String(body.phone || "").trim();
    if (!raw) {
      userData.phone = null;
    } else {
      if (!isValidEgyptianPhone(raw)) return err(tApi("api.064"), 400);
      userData.phone = normalizePhone(raw);
    }
  }
  if (body.bio !== undefined) {
    teacherData.bio = body.bio === null ? null : String(body.bio).trim().slice(0, 1000) || null;
  }
  if (body.specialty !== undefined) {
    teacherData.specialty =
      body.specialty === null ? null : String(body.specialty).trim().slice(0, 200) || null;
  }

  const profileChanged = Object.keys(userData).length > 0 || Object.keys(teacherData).length > 0;
  if (profileChanged) {
    if (Object.keys(userData).length > 0) {
      await db.user.update({ where: { id: teacher.userId }, data: userData });
    }
    if (Object.keys(teacherData).length > 0) {
      await db.teacher.update({ where: { id }, data: teacherData });
    }
    // An email change is a credential-identity change: end every live session
    // so the teacher re-authenticates with the updated identity.
    if (userData.email) {
      await revokeAllSessions(teacher.userId, "ADMIN_TEACHER_EMAIL_CHANGED");
    }
    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: "TEACHER_PROFILE_UPDATED",
          entity: "Teacher",
          entityId: id,
          details: JSON.stringify({ teacherId: id, fields: [...Object.keys(userData), ...Object.keys(teacherData)] }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }

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

// DELETE /api/admin/teachers/[id] — remove an UNUSED teacher account
// (post-launch audit).
//
// SAFE-LIFECYCLE RULE:
//   A teacher who ever touched platform data is DEACTIVATED, never deleted:
//   assigned groups, live sessions (with attendance) or teacher notes are
//   historical/relational data, and this route REFUSES (409, api.296) while
//   any of them exist — the admin must reassign the groups or deactivate the
//   account (PATCH { isActive: false }) instead.
//   Hard delete is only possible for a mistake-with-no-history account (zero
//   groups, zero sessions, zero notes). The user row is then removed with its
//   OWN dependent rows (login sessions, reset tokens, notifications); a
//   linked TeacherApplication is unlinked (userId set to null) so the
//   application history itself survives, and every step is audited under the
//   acting admin.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const teacher = await db.teacher.findUnique({
    where: { id },
    select: {
      id: true,
      userId: true,
      user: { select: { email: true, name: true } },
      _count: {
        select: { groups: true, sessions: true, teacherNotes: true },
      },
    },
  });
  if (!teacher) return err(tApi("api.047"), 404);

  const { groups, sessions, teacherNotes } = teacher._count;
  if (groups > 0 || sessions > 0 || teacherNotes > 0) {
    return err(
      tApi("api.296", { p1: groups, p2: sessions, p3: teacherNotes }),
      409
    );
  }

  // Keep the application row (history) but unlink the doomed user id — it is
  // a plain column, so leaving it would dangle after the delete.
  await db.teacherApplication
    .updateMany({ where: { userId: teacher.userId }, data: { userId: null } })
    .catch(() => undefined);

  await db.user.delete({ where: { id: teacher.userId } });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "TEACHER_DELETED",
        entity: "Teacher",
        entityId: id,
        details: JSON.stringify({
          teacherId: id,
          email: teacher.user.email,
          name: teacher.user.name,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);
  await logSecurityEvent({
    userId: user.id,
    type: "ACCOUNT_DELETED",
    detail: `Unused teacher account ${teacher.user.email} deleted by admin ${user.id}`,
  });

  return ok({ ok: true, deleted: true, id });
}
