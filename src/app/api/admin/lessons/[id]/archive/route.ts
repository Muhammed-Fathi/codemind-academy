// POST /api/admin/lessons/[id]/archive — archive or restore a session (ADMIN only)
//
// Phase 15. Body: `{ "action": "ARCHIVE" | "RESTORE" }` (default ARCHIVE).
//
// Archiving retires a session to curriculum history; restoring returns it to
// OFFICIAL (when it carries an `officialCode`) or LEGACY. The ceremony is
// deliberately narrow:
//
//   • it never touches `status`: a PUBLISHED lesson must be unpublished first
//     through the lifecycle ceremony (409 ARCHIVE_REQUIRES_UNPUBLISH), so no
//     lifecycle transition is ever smuggled through this route;
//   • it never mints or clears `officialCode`: restore re-derives standing
//     from the code the reconciler wrote;
//   • both directions are idempotent (NO_OP codes, `changed: false`).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import {
  canArchiveFromStatus,
  parseArchiveAction,
} from "@/lib/admin-sessions";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const body = await req.json().catch(() => null);
  const action = parseArchiveAction(body);
  if (!action) return err("INVALID_ARCHIVE_ACTION", 400);

  const lesson = await db.lesson.findUnique({
    where: { id },
    select: {
      id: true,
      status: true,
      curriculumStatus: true,
      officialCode: true,
    },
  });
  if (!lesson) return err("Lesson not found", 404);

  const archived =
    String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED";

  if (action === "ARCHIVE") {
    if (archived) {
      return ok({
        ok: true,
        code: "NO_OP_ALREADY_ARCHIVED",
        changed: false,
        lessonId: id,
        curriculumStatus: lesson.curriculumStatus,
        status: lesson.status,
      });
    }
    if (!canArchiveFromStatus(lesson.status)) {
      return err("ARCHIVE_REQUIRES_UNPUBLISH", 409);
    }
    const updated = await db.lesson.update({
      where: { id },
      data: { curriculumStatus: "ARCHIVED" },
      select: { id: true, status: true, curriculumStatus: true },
    });
    if (user?.id) {
      await db.auditLog
        .create({
          data: {
            userId: user.id,
            action: "LESSON_ARCHIVE",
            entity: "Lesson",
            entityId: id,
            details: JSON.stringify({
              from: lesson.curriculumStatus,
              status: lesson.status,
            }).slice(0, 1000),
          },
        })
        .catch(() => undefined);
    }
    return ok({
      ok: true,
      code: "OK",
      changed: true,
      lessonId: id,
      curriculumStatus: updated.curriculumStatus,
      status: updated.status,
    });
  }

  // RESTORE
  if (!archived) {
    return ok({
      ok: true,
      code: "NO_OP_NOT_ARCHIVED",
      changed: false,
      lessonId: id,
      curriculumStatus: lesson.curriculumStatus,
      status: lesson.status,
    });
  }
  // Standing is re-derived, never invented: an official code means the
  // reconciler once claimed this row; anything else is by-hand (LEGACY).
  const restored = lesson.officialCode ? "OFFICIAL" : "LEGACY";
  const updated = await db.lesson.update({
    where: { id },
    data: { curriculumStatus: restored },
    select: { id: true, status: true, curriculumStatus: true },
  });
  if (user?.id) {
    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: "LESSON_RESTORE",
          entity: "Lesson",
          entityId: id,
          details: JSON.stringify({ to: restored }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }
  return ok({
    ok: true,
    code: "OK",
    changed: true,
    lessonId: id,
    curriculumStatus: updated.curriculumStatus,
    status: updated.status,
  });
}
