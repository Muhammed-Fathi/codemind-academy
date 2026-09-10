// GET  /api/admin/lessons — paginated admin session list (ADMIN only)
// POST /api/admin/lessons — safe DRAFT-only session creation (ADMIN only)
//
// Phase 15. The list is the data behind the admin publishing workflow: every
// row carries its lifecycle status, track scope, curriculum standing and
// resource counts, and — when `includeReadiness=1` — the SAME server-side
// readiness computation (`computeLessonReadiness` over live rows) that the
// OPEN ceremony enforces. The UI never derives readiness itself.
//
// Creation is deliberately narrow: a DRAFT LEGACY row on the canonical chain
// (`unitId`, never `topicId`), with the lifecycle initial state taken from
// `LESSON_NEW_LIFECYCLE`. There is no path in this file that mints an
// `officialCode`, writes a `status`, or places a row on the legacy chain.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import {
  parseCreateLessonInput,
  parseLessonListQuery,
} from "@/lib/admin-sessions";
import {
  LESSON_NEW_LIFECYCLE,
  READINESS_LESSON_INCLUDE,
  computeLessonReadiness,
} from "@/lib/session-lifecycle";

const IDENTITY_SELECT = {
  unit: {
    select: {
      id: true,
      title: true,
      titleAr: true,
      order: true,
      part: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          order: true,
          course: {
            select: { id: true, slug: true, name: true, nameAr: true },
          },
        },
      },
    },
  },
  topic: {
    select: {
      id: true,
      title: true,
      titleAr: true,
      order: true,
      unit: {
        select: {
          id: true,
          title: true,
          titleAr: true,
          order: true,
          part: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              order: true,
              course: {
                select: { id: true, slug: true, name: true, nameAr: true },
              },
            },
          },
        },
      },
    },
  },
} as const;

type IdentityRow = {
  unit: {
    id: string;
    title: string;
    titleAr: string;
    order: number;
    part: {
      id: string;
      title: string;
      titleAr: string;
      order: number;
      course: { id: string; slug: string; name: string; nameAr: string };
    };
  } | null;
  topic: {
    id: string;
    title: string;
    titleAr: string;
    order: number;
    unit: IdentityRow["unit"];
  } | null;
};

function identityOf(row: IdentityRow) {
  // Canonical chain first, legacy topic chain as the fallback — the same
  // resolution order the progression engine and the lifecycle ceremony use.
  const unit = row.unit ?? row.topic?.unit ?? null;
  const part = unit?.part ?? null;
  return {
    course: part?.course
      ? {
          id: part.course.id,
          slug: part.course.slug,
          name: part.course.name,
          nameAr: part.course.nameAr,
        }
      : null,
    part: part
      ? { id: part.id, title: part.title, titleAr: part.titleAr, order: part.order }
      : null,
    unit: unit
      ? { id: unit.id, title: unit.title, titleAr: unit.titleAr, order: unit.order }
      : null,
    topic: row.topic
      ? {
          id: row.topic.id,
          title: row.topic.title,
          titleAr: row.topic.titleAr,
          order: row.topic.order,
        }
      : null,
  };
}

const PLACEHOLDER_MARKERS = new Set(["", "#", "##", "./#", "null", "none", "-"]);

function usableLegacyUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const v = value.trim();
  return v.length > 0 && !PLACEHOLDER_MARKERS.has(v.toLowerCase());
}

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const parsed = parseLessonListQuery(new URL(req.url).searchParams);
  if (!parsed.ok) {
    return err(parsed.code + (parsed.field ? `:${parsed.field}` : ""), 400);
  }
  const q = parsed.value;

  const where: Record<string, unknown> = {};
  if (q.status) where.status = q.status;
  if (q.trackScope) where.trackScope = q.trackScope;
  if (q.curriculumStatus) where.curriculumStatus = q.curriculumStatus;
  if (q.courseId) {
    where.OR = [
      { unit: { part: { courseId: q.courseId } } },
      { topic: { unit: { part: { courseId: q.courseId } } } },
    ];
  }
  if (q.q) {
    where.AND = [
      {
        OR: [
          { title: { contains: q.q } },
          { titleAr: { contains: q.q } },
          { officialCode: { contains: q.q } },
        ],
      },
    ];
  }

  const [total, rows] = await Promise.all([
    db.lesson.count({ where: where as never }),
    db.lesson.findMany({
      where: where as never,
      orderBy: [
        { unit: { part: { order: "asc" } } },
        { unit: { order: "asc" } },
        { topic: { unit: { part: { order: "asc" } } } },
        { topic: { unit: { order: "asc" } } },
        { topic: { order: "asc" } },
        { order: "asc" },
        { id: "asc" },
      ],
      skip: (q.page - 1) * q.pageSize,
      take: q.pageSize,
      select: {
        id: true,
        officialCode: true,
        title: true,
        titleAr: true,
        order: true,
        status: true,
        trackScope: true,
        curriculumStatus: true,
        duration: true,
        videoUrl: true,
        pdfUrl: true,
        isPublished: true,
        ...IDENTITY_SELECT,
        publication: {
          select: { id: true, segment: true, publishedAt: true },
        },
        _count: { select: { quizzes: true, homeworks: true } },
        // The readiness loader shape is spread in ONLY when the caller asked
        // for it, so the default list stays light.
        ...(q.includeReadiness ? READINESS_LESSON_INCLUDE : {}),
      },
    }),
  ]);

  const ids = rows.map((r) => r.id);
  const [activeMaterials, publishedVideos, allVideos] = ids.length
    ? await Promise.all([
        db.material.groupBy({
          by: ["lessonId"],
          where: { lessonId: { in: ids }, isActive: true },
          _count: { _all: true },
        }),
        db.sessionVideo.groupBy({
          by: ["lessonId"],
          where: { lessonId: { in: ids }, isPublished: true },
          _count: { _all: true },
        }),
        db.sessionVideo.groupBy({
          by: ["lessonId"],
          where: { lessonId: { in: ids } },
          _count: { _all: true },
        }),
      ])
    : [[], [], []];
  const materialsByLesson = new Map(
    activeMaterials.map((g) => [g.lessonId, g._count._all])
  );
  const publishedVideosByLesson = new Map(
    publishedVideos.map((g) => [g.lessonId, g._count._all])
  );
  const videosByLesson = new Map(
    allVideos.map((g) => [g.lessonId, g._count._all])
  );

  const lessons = rows.map((r) => {
    // THE SAME readiness computation the OPEN ceremony enforces — evaluated
    // here, over these live rows, never in the client.
    const readiness = q.includeReadiness
      ? (() => {
          const computed = computeLessonReadiness(r as never);
          return {
            ...computed,
            isPublished: (r as { isPublished?: unknown }).isPublished === true,
            publication: r.publication
              ? {
                  id: r.publication.id,
                  segment: String(r.publication.segment),
                  publishedAt: r.publication.publishedAt,
                }
              : null,
          };
        })()
      : null;
    return {
      id: r.id,
      officialCode: r.officialCode,
      title: r.title,
      titleAr: r.titleAr,
      order: r.order,
      status: r.status,
      trackScope: r.trackScope,
      curriculumStatus: r.curriculumStatus,
      duration: r.duration,
      identity: identityOf(r as unknown as IdentityRow),
      counts: {
        quizzes: r._count.quizzes,
        homeworks: r._count.homeworks,
        materials: materialsByLesson.get(r.id) ?? 0,
        sessionVideos: videosByLesson.get(r.id) ?? 0,
        sessionVideosPublished: publishedVideosByLesson.get(r.id) ?? 0,
      },
      legacy: {
        hasVideoUrl: usableLegacyUrl(r.videoUrl),
        hasPdfUrl: usableLegacyUrl(r.pdfUrl),
      },
      publication: r.publication
        ? {
            id: r.publication.id,
            segment: String(r.publication.segment),
            publishedAt: r.publication.publishedAt,
          }
        : null,
      isPublishedCompat: r.isPublished === true,
      readiness,
    };
  });

  return ok({
    lessons,
    pagination: {
      page: q.page,
      pageSize: q.pageSize,
      total,
      totalPages: Math.ceil(total / q.pageSize),
      hasMore: q.page * q.pageSize < total,
    },
  });
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const body = await req.json().catch(() => null);
  const parsed = parseCreateLessonInput(body);
  if (!parsed.ok) {
    return err(
      parsed.code + ("field" in parsed && parsed.field ? `:${parsed.field}` : ""),
      400
    );
  }
  const input = parsed.value;

  const unit = await db.unit.findUnique({
    where: { id: input.unitId },
    select: { id: true, part: { select: { id: true, courseId: true } } },
  });
  if (!unit) return err("UNIT_NOT_FOUND", 404);

  let order = input.order;
  if (order === null) {
    const agg = await db.lesson.aggregate({
      where: { unitId: input.unitId },
      _max: { order: true },
    });
    order = (agg._max.order ?? 0) + 1;
  }

  const lesson = await db.lesson.create({
    data: {
      title: input.title,
      titleAr: input.titleAr,
      unitId: input.unitId,
      // Canonical chain only: a created row is never topic-linked.
      topicId: null,
      // Created by hand, so it is NOT official curriculum: no officialCode,
      // LEGACY standing. The reconciler remains the only writer of OFFICIAL.
      officialCode: null,
      curriculumStatus: "LEGACY",
      trackScope: input.trackScope,
      description: input.description,
      summary: input.summary,
      duration: input.duration ?? 90,
      order,
      // THE lifecycle initial state — DRAFT with a synchronised mirror. There
      // is deliberately no other spelling of this in the repository.
      status: LESSON_NEW_LIFECYCLE.status,
      isPublished: LESSON_NEW_LIFECYCLE.isPublished,
      // `isLocked` stays at its inert default; it is never written on purpose.
    },
    select: {
      id: true,
      officialCode: true,
      title: true,
      titleAr: true,
      order: true,
      status: true,
      trackScope: true,
      curriculumStatus: true,
      duration: true,
      unitId: true,
    },
  });

  if (user?.id) {
    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: "LESSON_CREATE",
          entity: "Lesson",
          entityId: lesson.id,
          details: JSON.stringify({
            unitId: input.unitId,
            courseId: unit.part.courseId,
            trackScope: input.trackScope,
            status: lesson.status,
          }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }

  return ok({ lesson }, { status: 201 });
}
