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
import { requireAcademicLevel } from "@/lib/academic-level";
import type { AcademicLevel } from "@prisma/client";

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
  // Phase K2 — the curriculum level is handled apart from the metadata
  // fields (see the gate below); it is never part of the free metadata edit.
  let nextAcademicLevel: AcademicLevel | undefined = undefined;

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
  // Phase K2 — the curriculum level may be SET on a legacy unlevelled course
  // or corrected, but never cleared, and never while it would break I1/I2:
  // a course with grouped students or attributed lessons carries their
  // level (students' typed level, lessons' derived level), so re-levelling
  // it is refused until it is empty. No student/lesson is rewritten.
  if (body.academicLevel !== undefined) {
    const check = requireAcademicLevel(body.academicLevel);
    if (!check.ok) return err(tApi("api.375"), 400);
    if (check.value !== course.academicLevel) {
      // Manual-QA pass — the guard also counts ENROLLMENTS (an enrolled
      // student's typed level is authority too). Empty groups do not block:
      // they carry no level state of their own (Group has no academicLevel).
      const [members, lessons, enrollments] = await Promise.all([
        db.student.count({ where: { group: { courseId: id } } }),
        db.lesson.count({
          where: {
            OR: [
              { unit: { part: { courseId: id } } },
              { topic: { unit: { part: { courseId: id } } } },
            ],
          },
        }),
        db.enrollment.count({ where: { courseId: id } }),
      ]);
      // api.378 names the COURSE re-level refusal precisely (api.377 is the
      // group re-target wording); both are 409 fail-closed, nothing is
      // rewritten on Student/Lesson.
      if (members > 0 || lessons > 0 || enrollments > 0) return err(tApi("api.378"), 409);
      nextAcademicLevel = check.value;
    }
  }
  if (Object.keys(data).length === 0 && nextAcademicLevel === undefined)
    return err(tApi("api.018"), 400);

  const updated = await db.course.update({
    where: { id },
    data: nextAcademicLevel ? { ...data, academicLevel: nextAcademicLevel } : data,
  });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "COURSE_UPDATED",
        entity: "Course",
        entityId: id,
        details: JSON.stringify({
          courseId: id,
          fields: [...Object.keys(data), ...(nextAcademicLevel ? ["academicLevel"] : [])],
        }).slice(0, 1000),
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
