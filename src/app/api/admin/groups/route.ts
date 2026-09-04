import { getServerT } from "@/lib/i18n-server";
// GET /api/admin/groups — list groups with stats
// POST /api/admin/groups — create group
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const groups = await db.group.findMany({
    include: {
      course: { select: { id: true, nameAr: true, color: true } },
      teacher: { select: { id: true, user: { select: { name: true } } } },
      _count: { select: { students: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return ok({
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      courseId: g.courseId,
      courseName: g.course?.nameAr,
      courseColor: g.course?.color,
      teacherId: g.teacherId,
      teacherName: g.teacher?.user?.name,
      capacity: g.capacity,
      schedule: g.schedule,
      isActive: g.isActive,
      studentsCount: g._count.students,
    })),
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const courseId = String(body.courseId || "").trim();
  const teacherId = body.teacherId ? String(body.teacherId) : null;
  const capacity = Number(body.capacity || 20);
  const schedule = body.schedule ? String(body.schedule) : "Sat & Tue, 6:00 PM";

  if (!name || !courseId) return err(tApi("api.021"), 400);

  const course = await db.course.findUnique({ where: { id: courseId } });
  if (!course) return err(tApi("api.022"), 404);

  const group = await db.group.create({
    data: {
      name,
      courseId,
      teacherId: teacherId || null,
      capacity,
      schedule,
    },
  });

  return ok({ group });
}
