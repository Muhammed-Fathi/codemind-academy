import { getServerT } from "@/lib/i18n-server";
// /api/admin/courses — list + create courses; reconcile the official curriculum.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import {
  LEVEL_CURRICULUM_SPECS,
  reconcileAllOfficialCurricula,
  specForLevel,
  type LevelCurriculumSpec,
} from "@/lib/official-curriculum";
import { requireAcademicLevel } from "@/lib/academic-level";

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
  // knowledge models (docs/curriculum/<level>/knowledge-model.json), archiving
  // legacy rows instead of deleting them so user history is preserved.
  //
  // Phase L — LEVEL AWARENESS. Two official curricula now exist (First and
  // Second Secondary) and they legitimately share 18 lesson codes, so the
  // level is resolved from authoritative caller context, never guessed from a
  // code. A caller may target ONE level (needed for scoped re-runs and QA);
  // with no level supplied, every registered level is reconciled in registry
  // order. Each run is independently scoped, so reconciling one level can
  // never touch the other.
  if (body.action === "reconcile-official") {
    try {
      let specs: readonly LevelCurriculumSpec[] = LEVEL_CURRICULUM_SPECS;
      if (body.academicLevel !== undefined && body.academicLevel !== null && body.academicLevel !== "") {
        const levelCheck = requireAcademicLevel(body.academicLevel);
        if (!levelCheck.ok) return err(tApi("api.375"), 400);
        const spec = specForLevel(levelCheck.value);
        if (!spec) return err(tApi("api.375"), 400);
        specs = [spec];
      }
      const report = await reconcileAllOfficialCurricula(db, specs);
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
  // Phase K2 — `Course.academicLevel` is the curriculum authority and is
  // REQUIRED for every new operational course (the DB column stays nullable
  // until K3). Never defaulted, never inferred from the name.
  const levelCheck = requireAcademicLevel(body.academicLevel);
  if (!levelCheck.ok) return err(tApi("api.375"), 400);
  const academicLevel = levelCheck.value;

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
    data: { slug, name, nameAr, description, color, academicLevel },
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

  // Phase L manual-QA fix — the card counters must be TRUE in BOTH modes.
  //
  // The DTO below derives its counters from the canonical relations
  // (Course → Part → Unit → Lesson, plus the legacy Topic chain). The list
  // request does NOT ask for the tree, so `parts` used to be hydrating as
  // `[]` and every card rendered `Parts = 0 / Lessons = 0` while the database
  // actually held 1/13/62 and 2/7/23 — a silent lie, not a missing feature.
  //
  // The list response therefore hydrates the chain's IDENTITY + LIFECYCLE
  // columns (ids + `curriculumStatus`) through a count-only projection, while
  // `tree=1` keeps hydrating the full rows the admin tree renders. Both
  // branches feed the SAME counting loop, so there is exactly ONE definition
  // of what "Parts"/"Lessons" mean. Counts remain RELATION-derived and
  // per-course: never by `officialCode` prefix, never by an aggregate over
  // `academicLevel`, never hard-coded, so one course can never receive
  // another course's numbers. The heavy tree payload is still `tree=1`-only.
  const COUNT_ONLY_PARTS = {
    select: {
      id: true,
      units: {
        select: {
          id: true,
          lessons: { select: { id: true, curriculumStatus: true } },
          // Legacy chain — preserved: legacy Topic-linked lessons count too.
          topics: {
            select: {
              id: true,
              lessons: { select: { id: true, curriculumStatus: true } },
            },
          },
        },
      },
    },
  };
  const FULL_PARTS = {
    orderBy: { order: "asc" },
    include: {
      units: {
        orderBy: { order: "asc" },
        include: {
          // Canonical chain plus the legacy topic chain (full catalogue incl.
          // archived rows — admin management scope).
          lessons: { orderBy: { order: "asc" } },
          topics: {
            orderBy: { order: "asc" },
            include: { lessons: { orderBy: { order: "asc" } } },
          },
        },
      },
    },
  };

  const courses = await db.course.findMany({
    include: {
      parts: (withTree ? FULL_PARTS : COUNT_ONLY_PARTS) as any,
      _count: { select: { groups: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  return ok({
    courses: courses.map((c) => {
      const parts = (c as any).parts || [];
      // The ONE counting rule for every mode (list and tree), unchanged from
      // Phase 11 and still relation-derived:
      //   Parts   = this course's Part rows.
      //   Lessons = DISTINCT lessons reachable from this course through BOTH
      //             chains (canonical Unit lessons + legacy Topic lessons); a
      //             dual-linked lesson is one lesson.
      //   `lessonsCount` is the full catalogue; `activeLessonsCount` is what
      //   students actually see (ARCHIVED history excluded). Both are scoped
      //   to THIS course's chain, so one course can never inherit another's.
      // A course with zero Parts — or a Part with no Units, or a Unit with no
      // Lessons — therefore reports 0 without special-casing.
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
        academicLevel: c.academicLevel ?? null,
        partsCount: parts.length,
        lessonsCount,
        activeLessonsCount,
        groupsCount: (c as any)._count?.groups || 0,
        parts: withTree ? parts : undefined,
      };
    }),
  });
}
