import { getServerT } from "@/lib/i18n-server";
// /api/admin/courses — list + create courses; seed curriculum from file.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { seedCurriculumFromFile } from "@/lib/curriculum-seed";

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const body = await req.json().catch(() => ({}));

  // Seed action: restore curriculum.ts data into the DB.
  if (body.action === "seed") {
    try {
      const result = await seedCurriculumFromFile();
      return ok({ ok: true, ...result });
    } catch (e: any) {
      return err(e?.message || tApi("api.017"), 500);
    }
  }

  const name = String(body.name || "").trim();
  const nameAr = String(body.nameAr || "").trim();
  const description = String(body.description || "").trim();
  const color = String(body.color || "#10b981").trim();
  if (!name || !nameAr) return err(tApi("api.018"), 400);

  const slugBase = (body.slug ? String(body.slug) : name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `course-${Date.now()}`;
  let slug = slugBase;
  for (let i = 2; i < 10; i++) {
    const taken = await db.course.findUnique({ where: { slug } }).catch(() => null);
    if (!taken) break;
    slug = `${slugBase}-${i}`;
  }

  const course = await db.course.create({
    data: { slug, name, nameAr, description, color },
  });
  return ok({ ok: true, course });
}

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const withTree = url.searchParams.get("tree") === "1";
  const courseId = url.searchParams.get("id");

  if (courseId) {
    const course = await db.course.findUnique({
      where: { id: courseId },
      include: {
        parts: {
          orderBy: { order: "asc" },
          include: {
            units: {
              orderBy: { order: "asc" },
              include: {
                topics: {
                  orderBy: { order: "asc" },
                  include: {
                    lessons: { orderBy: { order: "asc" } },
                  },
                },
              },
            },
          },
        },
        groups: { select: { id: true, name: true } },
      },
    });
    if (!course) return err(tApi("api.019"), 404);
    return ok({ course });
  }

  const courses = await db.course.findMany({
    include: withTree
      ? {
          parts: {
            orderBy: { order: "asc" },
            include: {
              units: {
                orderBy: { order: "asc" },
                include: {
                  topics: {
                    orderBy: { order: "asc" },
                    include: { lessons: { orderBy: { order: "asc" } } },
                  },
                },
              },
            },
          },
          _count: { select: { groups: true } },
        }
      : { _count: { select: { groups: true } } },
    orderBy: { createdAt: "asc" },
  });

  return ok({
    courses: courses.map((c) => {
      const parts = (c as any).parts || [];
      const lessonsCount = parts.reduce(
        (acc: number, p: any) =>
          acc +
          p.units.reduce(
            (a: number, u: any) =>
              a + u.topics.reduce((b: number, t: any) => b + t.lessons.length, 0),
            0
          ),
        0
      );
      return {
        id: c.id,
        slug: c.slug,
        name: c.name,
        nameAr: c.nameAr,
        description: c.description,
        color: c.color,
        partsCount: parts.length,
        lessonsCount,
        groupsCount: (c as any)._count?.groups || 0,
        parts: withTree ? parts : undefined,
      };
    }),
  });
}
