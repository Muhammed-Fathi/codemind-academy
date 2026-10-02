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
import { normalizeAcademicLevel } from "@/lib/academic-level";
import { parseAcademicLevelParam } from "@/lib/academic-level-query";
import { normalizeSchoolType } from "@/lib/school-type";

export async function GET(req?: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = req ? new URL(req.url) : new URL("http://localhost/api/admin/groups");
  const level = parseAcademicLevelParam(url.searchParams);
  if (!level.ok) return err("INVALID_ACADEMIC_LEVEL:academicLevel", 400);
  const search = url.searchParams.get("search")?.trim() || "";
  const trackParam = url.searchParams.get("trackScope")?.trim() || "";
  const track = trackParam ? normalizeSchoolType(trackParam) : null;
  if (trackParam && !track) return err("INVALID_TRACK_SCOPE", 400);
  const activeParam = url.searchParams.get("active");
  const page = Math.max(1, Number.parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get("pageSize") || "100", 10) || 100));
  const where: any = {};
  if (level.level) where.course = { academicLevel: level.level };
  if (track) where.trackScope = track;
  if (activeParam === "true") where.isActive = true;
  if (activeParam === "false") where.isActive = false;
  if (search) {
    where.OR = [
      { name: { contains: search } },
      { course: { name: { contains: search } } },
      { course: { nameAr: { contains: search } } },
    ];
  }

  const [total, groups] = await Promise.all([
    db.group.count({ where }),
    db.group.findMany({
      where,
      include: {
        course: { select: { id: true, name: true, nameAr: true, color: true, academicLevel: true } },
        teacher: { select: { id: true, user: { select: { name: true } } } },
        _count: { select: { students: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  return ok({
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      courseId: g.courseId,
      courseName: g.course?.nameAr,
      courseNameEn: g.course?.name,
      courseColor: g.course?.color,
      // Phase K2 — derived from the course (never stored on the group).
      academicLevel: g.course?.academicLevel ?? null,
      teacherId: g.teacherId,
      teacherName: g.teacher?.user?.name,
      capacity: g.capacity,
      schedule: g.schedule,
      isActive: g.isActive,
      // Phase 26B — the group's audience (null = UNCLASSIFIED legacy row).
      trackScope: g.trackScope ?? null,
      studentsCount: g._count.students,
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    },
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
  // Phase K2 — a group's academic level is DERIVED from its course (no
  // Group.academicLevel column). An operational group therefore requires a
  // LEVELLED course; a legacy unlevelled course must be classified first.
  if (!normalizeAcademicLevel(course.academicLevel)) return err(tApi("api.375"), 409);

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
