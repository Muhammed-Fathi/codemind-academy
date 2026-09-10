// GET   /api/admin/lessons/[id] — full session detail for the admin workflow
// PATCH /api/admin/lessons/[id] — safe metadata + track scope update
//
// Phase 15. GET returns EVERYTHING the session detail screen renders in one
// response — identity, status, scope, videos, materials, quizzes, homeworks,
// server-computed readiness, publication and history — so the UI makes no
// duplicate fetches and can never show stale readiness next to fresh state.
//
// PATCH edits safe metadata only (`title`, `titleAr`, `description`,
// `summary`, `duration`, `order`, `trackScope`). It has no code path that
// writes `status`, the `isPublished` mirror, `officialCode`,
// `curriculumStatus`, placement or legacy media urls: those are owned by the
// lifecycle ceremony, the reconciler, the archive ceremony and the
// SessionVideo / material APIs respectively. Archived lessons are immutable
// here — restore them first.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { parseUpdateLessonInput } from "@/lib/admin-sessions";
import { getLessonReadiness } from "@/lib/session-lifecycle";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const lesson = await db.lesson.findUnique({
    where: { id },
    select: {
      id: true,
      officialCode: true,
      title: true,
      titleAr: true,
      order: true,
      description: true,
      summary: true,
      duration: true,
      status: true,
      trackScope: true,
      curriculumStatus: true,
      isPublished: true,
      videoUrl: true,
      pdfUrl: true,
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
      quizzes: {
        orderBy: [{ order: "asc" }, { title: "asc" }],
        select: {
          id: true,
          title: true,
          titleAr: true,
          trackScope: true,
          order: true,
          passMark: true,
          timeLimit: true,
          _count: { select: { questions: true } },
        },
      },
      homeworks: {
        orderBy: { deadline: "asc" },
        select: {
          id: true,
          title: true,
          titleAr: true,
          trackScope: true,
          deadline: true,
          maxMarks: true,
          instructions: true,
          _count: { select: { submissions: true } },
        },
      },
      sessionVideos: {
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          titleAr: true,
          requiredPercent: true,
          isPublished: true,
          publishedAt: true,
          createdAt: true,
          batch: {
            select: { id: true, name: true, nameAr: true, schoolType: true },
          },
        },
      },
      materials: {
        orderBy: [{ isActive: "desc" }, { createdAt: "desc" }],
        select: {
          id: true,
          title: true,
          kind: true,
          trackScope: true,
          isActive: true,
          mediaAssetId: true,
          createdAt: true,
          updatedAt: true,
          media: {
            select: {
              mimeType: true,
              sizeBytes: true,
              originalName: true,
            },
          },
        },
      },
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  // THE SAME readiness snapshot the OPEN ceremony judges by — loaded from the
  // live rows at request time, never cached, never derived in the client.
  const readiness = await getLessonReadiness(id);
  if (!readiness) return err("Lesson not found", 404);

  const history = await db.auditLog.findMany({
    where: { entityId: id },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: {
      id: true,
      action: true,
      details: true,
      createdAt: true,
      user: { select: { id: true, name: true, email: true } },
    },
  });

  // Canonical chain first, legacy topic chain as the fallback — the same
  // resolution order the progression engine and the ceremony use.
  const unit = lesson.unit ?? lesson.topic?.unit ?? null;
  const part = unit?.part ?? null;

  return ok({
    id: lesson.id,
    officialCode: lesson.officialCode,
    title: lesson.title,
    titleAr: lesson.titleAr,
    order: lesson.order,
    description: lesson.description,
    summary: lesson.summary,
    duration: lesson.duration,
    status: lesson.status,
    trackScope: lesson.trackScope,
    curriculumStatus: lesson.curriculumStatus,
    isPublishedCompat: lesson.isPublished === true,
    identity: {
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
      topic: lesson.topic
        ? {
            id: lesson.topic.id,
            title: lesson.topic.title,
            titleAr: lesson.topic.titleAr,
            order: lesson.topic.order,
          }
        : null,
    },
    // Legacy compatibility urls: admin-visible, read-only. PATCH refuses them.
    legacy: { videoUrl: lesson.videoUrl, pdfUrl: lesson.pdfUrl },
    quizzes: lesson.quizzes.map((qz) => ({
      id: qz.id,
      title: qz.title,
      titleAr: qz.titleAr,
      trackScope: qz.trackScope,
      order: qz.order,
      passMark: qz.passMark,
      timeLimit: qz.timeLimit,
      questionCount: qz._count.questions,
    })),
    homeworks: lesson.homeworks.map((h) => ({
      id: h.id,
      title: h.title,
      titleAr: h.titleAr,
      trackScope: h.trackScope,
      deadline: h.deadline,
      maxMarks: h.maxMarks,
      instructions: h.instructions,
      hasInstructions:
        typeof h.instructions === "string" && h.instructions.trim().length > 0,
      submissionsCount: h._count.submissions,
    })),
    sessionVideos: lesson.sessionVideos.map((v) => ({
      id: v.id,
      title: v.title,
      titleAr: v.titleAr,
      batch: v.batch,
      requiredPercent: v.requiredPercent,
      isPublished: v.isPublished,
      publishedAt: v.publishedAt,
      createdAt: v.createdAt,
    })),
    // Same projection as GET …/materials: no storageKey anywhere. The key is
    // deliberately absent from the select above, so it cannot leak.
    materials: lesson.materials.map((m) => ({
      id: m.id,
      title: m.title,
      kind: m.kind,
      trackScope: m.trackScope,
      isActive: m.isActive,
      mediaAssetId: m.mediaAssetId,
      downloadUrl: m.isActive && m.mediaAssetId ? `/api/materials/${m.id}` : null,
      mimeType: m.media?.mimeType ?? null,
      sizeBytes: m.media?.sizeBytes ?? null,
      originalName: m.media?.originalName ?? null,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
    })),
    readiness,
    publication: readiness.publication,
    history: history.map((h) => ({
      id: h.id,
      action: h.action,
      details: h.details,
      createdAt: h.createdAt,
      user: h.user,
    })),
  });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const parsed = parseUpdateLessonInput(body);
  if (!parsed.ok) {
    return err(
      parsed.code + ("field" in parsed && parsed.field ? `:${parsed.field}` : ""),
      400
    );
  }

  const lesson = await db.lesson.findUnique({
    where: { id },
    select: { id: true, curriculumStatus: true, status: true },
  });
  if (!lesson) return err("Lesson not found", 404);
  if (String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED") {
    return err("LESSON_ARCHIVED", 409);
  }

  const data: Record<string, unknown> = {};
  if (parsed.value.title !== undefined) data.title = parsed.value.title;
  if (parsed.value.titleAr !== undefined) data.titleAr = parsed.value.titleAr;
  if (parsed.value.description !== undefined) data.description = parsed.value.description;
  if (parsed.value.summary !== undefined) data.summary = parsed.value.summary;
  if (parsed.value.duration !== undefined) data.duration = parsed.value.duration;
  if (parsed.value.order !== undefined) data.order = parsed.value.order;
  if (parsed.value.trackScope !== undefined) data.trackScope = parsed.value.trackScope;
  // NOTE — and this is the whole point of this route: `data` can only ever
  // hold the seven safe keys above. There is no branch that assigns `status`,
  // `isPublished`, `officialCode`, `curriculumStatus`, placement or legacy
  // media urls, because the parser rejects them before we get here.

  const updated = await db.lesson.update({
    where: { id },
    data: data as never,
    select: {
      id: true,
      officialCode: true,
      title: true,
      titleAr: true,
      order: true,
      description: true,
      summary: true,
      duration: true,
      status: true,
      trackScope: true,
      curriculumStatus: true,
    },
  });

  if (user?.id) {
    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: "LESSON_UPDATE",
          entity: "Lesson",
          entityId: id,
          details: JSON.stringify({ touched: parsed.touched }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }

  return ok({ lesson: updated, touched: parsed.touched });
}
