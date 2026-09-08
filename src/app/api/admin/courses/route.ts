import { getServerT } from "@/lib/i18n-server";
// /api/admin/courses — list + create courses; reconcile the official curriculum.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { reconcileOfficialCurriculum } from "@/lib/official-curriculum";

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const body = await req.json().catch(() => ({}));

  // Retired action (Phase 11): the legacy synthetic seed re-created the R1
  // curriculum and must never run against live data again. 410 Gone (not
  // 404) so old callers learn the endpoint is intentionally retired.
  if (body.action === "seed") {
    return err(tApi("api.226"), 410);
  }

  // Reconcile action: idempotently align the DB curriculum with the official
  // knowledge model (docs/curriculum/knowledge-model.json), archiving legacy
  // rows instead of deleting them so user history is preserved.
  if (body.action === "reconcile-official") {
    try {
      const report = await reconcileOfficialCurriculum(db);
      return ok({ ok: true, report });
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
                // Canonical chain (unit-linked official lessons) plus the
                // legacy topic chain. Admins manage the FULL catalogue, so
                // archived rows are included, not filtered.
                lessons: { orderBy: { order: "asc" } },
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
                  // Canonical chain plus the legacy topic chain (full
                  // catalogue incl. archived rows — admin management scope).
                  lessons: { orderBy: { order: "asc" } },
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
      // Distinct lessons across BOTH chains (a dual-linked lesson is one
      // lesson). `lessonsCount` is the full catalogue; `activeLessonsCount`
      // is what students actually see (archived history excluded).
      const seenLessonIds = new Set<string>();
      let activeLessonsCount = 0;
      for (const p of parts as any[]) {
        for (const u of (p.units || []) as any[]) {
          const chainLessons = [
            ...((u.lessons || []) as any[]),
            ...((u.topics || []) as any[]).flatMap((t: any) => t.lessons || []),
          ];
          for (const l of chainLessons) {
            if (seenLessonIds.has(l.id)) continue;
            seenLessonIds.add(l.id);
            if (l.curriculumStatus !== "ARCHIVED") activeLessonsCount++;
          }
        }
      }
      const lessonsCount = seenLessonIds.size;
      return {
        id: c.id,
        slug: c.slug,
        name: c.name,
        nameAr: c.nameAr,
        description: c.description,
        color: c.color,
        partsCount: parts.length,
        lessonsCount,
        activeLessonsCount,
        groupsCount: (c as any)._count?.groups || 0,
        parts: withTree ? parts : undefined,
      };
    }),
  });
}
