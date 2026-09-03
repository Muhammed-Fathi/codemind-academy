// GET /api/admin/courses — list courses with curriculum stats
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

export async function GET(req: NextRequest) {
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
    if (!course) return err("الكورس غير موجود", 404);
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
