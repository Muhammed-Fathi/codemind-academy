// PATCH /api/admin/students/[id] — update student (deactivate, change group)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const student = await db.student.findUnique({ where: { id } });
  if (!student) return err("الطالب غير موجود", 404);

  if (typeof body.isActive === "boolean") {
    await db.user.update({
      where: { id: student.userId },
      data: { isActive: body.isActive },
    });
  }
  if (typeof body.groupId === "string" || body.groupId === null) {
    await db.student.update({
      where: { id },
      data: { groupId: body.groupId || null },
    });
  }
  if (typeof body.grade === "string") {
    await db.student.update({ where: { id }, data: { grade: body.grade } });
  }
  if (typeof body.schoolName === "string") {
    await db.student.update({ where: { id }, data: { schoolName: body.schoolName } });
  }

  return ok({ ok: true });
}
