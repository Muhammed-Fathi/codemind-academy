import { getServerT } from "@/lib/i18n-server";
// PATCH /api/admin/groups/[id] — update group (assign teacher, capacity, add/remove students)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

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

  const group = await db.group.findUnique({ where: { id } });
  if (!group) return err(tApi("api.020"), 404);

  const data: any = {};
  if (typeof body.name === "string") data.name = body.name;
  if (typeof body.schedule === "string") data.schedule = body.schedule;
  if (typeof body.capacity === "number") data.capacity = body.capacity;
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;
  if (body.teacherId !== undefined) data.teacherId = body.teacherId || null;
  if (typeof body.courseId === "string") data.courseId = body.courseId;

  if (Object.keys(data).length > 0) {
    await db.group.update({ where: { id }, data });
  }

  // Manage students (optional arrays)
  if (Array.isArray(body.addStudentIds)) {
    for (const sid of body.addStudentIds) {
      await db.student.update({ where: { id: sid }, data: { groupId: id } });
    }
  }
  if (Array.isArray(body.removeStudentIds)) {
    for (const sid of body.removeStudentIds) {
      const s = await db.student.findUnique({ where: { id: sid } });
      if (s && s.groupId === id) {
        await db.student.update({ where: { id: sid }, data: { groupId: null } });
      }
    }
  }

  return ok({ ok: true });
}
