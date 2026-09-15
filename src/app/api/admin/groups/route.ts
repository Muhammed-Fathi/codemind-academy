import { getServerT } from "@/lib/i18n-server";
// GET /api/admin/groups — list groups with stats
// POST /api/admin/groups — create group
//
// Phase 26B (owner-approved): every teaching group carries an EXPLICIT
// student audience — `Group.trackScope` ARABIC | LANGUAGE. Create REQUIRES
// the field (no default, no inference from the name, SHARED refused — see
// `parseGroupTrackScope` in src/lib/track-scope.ts). Existing rows predate
// the field and read `trackScope: null` (UNCLASSIFIED): the list surfaces
// that state so the operator classifies them; an unclassified group is
// invisible to students and unenrollable until classified.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { parseGroupTrackScope } from "@/lib/track-scope";

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
      // Phase 26B — the group's audience (null = UNCLASSIFIED legacy row).
      trackScope: g.trackScope ?? null,
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

  // Phase 26B — REQUIRED, explicit audience. Absent / SHARED / unrecognised
  // values are rejected (never defaulted, never inferred from the name).
  const trackScope = parseGroupTrackScope(body.trackScope);
  if (!trackScope) return err(tApi("api.285"), 400);

  const course = await db.course.findUnique({ where: { id: courseId } });
  if (!course) return err(tApi("api.022"), 404);

  const group = await db.group.create({
    data: {
      name,
      courseId,
      teacherId: teacherId || null,
      capacity,
      schedule,
      trackScope,
    },
  });

  return ok({ group });
}
