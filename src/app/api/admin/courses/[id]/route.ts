// /api/admin/courses/[id] — post-launch admin lifecycle for courses.
//
//   PATCH  — safe METADATA edit only (name, nameAr, description, color).
//            The slug is NOT editable here: public links and the reconciler
//            key off it. Curriculum structure (parts/units/lessons) is owned
//            by the official-curriculum reconciler and the admin publishing
//            workflow — never by a generic course PATCH.
//   DELETE — refused (409, api.298) while ANYTHING references the course
//            (groups, curriculum parts, enrollments, mock exams, batches):
//            deleting a course would CASCADE through Parts → Units → Topics
//            → Lessons and silently destroy quizzes, progress and history.
//            Only a completely unused (empty) course can be removed; content
//            that is in use is ARCHIVED through the lesson lifecycle instead.
//
// AUTHORIZATION: ADMIN only, server-side (requireRole) — never UI-gated.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const course = await db.course.findUnique({ where: { id } });
  if (!course) return err(tApi("api.019"), 404);

  const body = await req.json().catch(() => ({}));
  const data: { name?: string; nameAr?: string; description?: string; color?: string } = {};

  if (body.name !== undefined) {
    const name = String(body.name || "").trim();
    if (!name || name.length > 140) return err(tApi("api.018"), 400);
    data.name = name;
  }
  if (body.nameAr !== undefined) {
    const nameAr = String(body.nameAr || "").trim();
    if (!nameAr || nameAr.length > 140) return err(tApi("api.018"), 400);
    data.nameAr = nameAr;
  }
  if (body.description !== undefined) {
    data.description = String(body.description || "").trim().slice(0, 1000);
  }
  if (body.color !== undefined) {
    const color = String(body.color || "").trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) return err(tApi("api.018"), 400);
    data.color = color;
  }
  if (Object.keys(data).length === 0) return err(tApi("api.018"), 400);

  const updated = await db.course.update({ where: { id }, data });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "COURSE_UPDATED",
        entity: "Course",
        entityId: id,
        details: JSON.stringify({ courseId: id, fields: Object.keys(data) }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return ok({ ok: true, course: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const course = await db.course.findUnique({
    where: { id },
    include: {
      _count: {
        select: { groups: true, parts: true, enrollments: true, mockExams: true, batches: true },
      },
    },
  });
  if (!course) return err(tApi("api.019"), 404);

  const c = course._count;
  if (c.groups > 0 || c.parts > 0 || c.enrollments > 0 || c.mockExams > 0 || c.batches > 0) {
    return err(tApi("api.298", { p1: c.groups, p2: c.parts, p3: c.mockExams }), 409);
  }

  await db.course.delete({ where: { id } });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "COURSE_DELETED",
        entity: "Course",
        entityId: id,
        details: JSON.stringify({ courseId: id, name: course.name }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return ok({ ok: true, deleted: true, id });
}
