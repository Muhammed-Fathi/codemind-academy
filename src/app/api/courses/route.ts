// GET /api/courses
//
// Course visibility is role-dependent and enforced server-side:
//
//   * STUDENT  — receives ONLY the course they are actually enrolled in
//                (resolved from Student.groupId -> Group.courseId). An
//                unenrolled student receives an empty list plus
//                `isEnrolled: false`, so the UI can show an explicit
//                empty state rather than a browsable catalogue.
//   * ADMIN / TEACHER — receive the full catalogue (they legitimately need it
//                to manage groups, batches and mock exams).
//   * PARENT   — receives the courses their linked children are enrolled in.
//
// The enrollment CATALOGUE (a prospective student choosing what to buy) is a
// deliberately separate concern: it is served by `?catalog=1`, which returns
// only public marketing fields and never lesson content. Course *content* is
// gated by /api/courses/[slug], which independently re-checks enrollment.

import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { ok, err, requireUser } from "@/lib/api";
import { db } from "@/lib/db";
import { getEnrollment } from "@/lib/enrollment";
import { normalizeAcademicLevel } from "@/lib/academic-level";

/** Public, non-sensitive fields only — safe for the enrollment picker. */
const PUBLIC_COURSE_FIELDS = {
  id: true,
  slug: true,
  name: true,
  nameAr: true,
  description: true,
  color: true,
  iconUrl: true,
} as const;

/**
 * Phase K2 — the catalogue scope per viewer: staff see every course; a
 * STUDENT sees only courses of their OWN typed academic level, and an
 * unlevelled student sees nothing (`null` ⇒ empty catalogue, fail-closed).
 */
async function catalogScopeFor(user: { id: string; role: string }): Promise<Prisma.CourseWhereInput | null> {
  if (user.role !== "STUDENT") return {};
  const me = await db.student.findUnique({
    where: { userId: user.id },
    select: { academicLevel: true },
  });
  const level = normalizeAcademicLevel(me?.academicLevel);
  return level ? { academicLevel: level } : null;
}

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const url = new URL(req.url);
  const catalog = url.searchParams.get("catalog") === "1";

  // ---- Enrollment catalogue -------------------------------------------------
  // Used by the enroll flow, where a student must be able to pick a course they
  // are not yet enrolled in. Marketing fields only; no parts/units/lessons.
  if (catalog) {
    // Phase K2 — a STUDENT's enrollment catalogue is scoped to courses of
    // their OWN typed academic level (fail-closed: an unlevelled student
    // sees an empty catalogue). Staff keep the full catalogue.
    const where = await catalogScopeFor(user);
    if (!where) return ok({ courses: [], catalog: true });
    const courses = await db.course.findMany({
      where,
      orderBy: { createdAt: "asc" },
      select: PUBLIC_COURSE_FIELDS,
    });
    return ok({ courses, catalog: true });
  }

  // ---- Staff: full catalogue ------------------------------------------------
  if (user.role === "ADMIN" || user.role === "TEACHER") {
    const courses = await db.course.findMany({
      orderBy: { createdAt: "asc" },
      select: PUBLIC_COURSE_FIELDS,
    });
    return ok({ courses });
  }

  // ---- Student: only the enrolled course ------------------------------------
  if (user.role === "STUDENT") {
    const student = await db.student.findUnique({
      where: { userId: user.id },
      select: { id: true },
    });
    if (!student) return ok({ courses: [], isEnrolled: false });

    const enrollment = await getEnrollment(student.id);
    if (!enrollment.isEnrolled || !enrollment.courseId) {
      return ok({ courses: [], isEnrolled: false });
    }

    const course = await db.course.findUnique({
      where: { id: enrollment.courseId },
      select: PUBLIC_COURSE_FIELDS,
    });
    return ok({ courses: course ? [course] : [], isEnrolled: true });
  }

  // ---- Parent: courses of their linked children -----------------------------
  if (user.role === "PARENT") {
    const parent = await db.parent.findUnique({
      where: { userId: user.id },
      select: {
        children: {
          select: { student: { select: { group: { select: { courseId: true } } } } },
        },
      },
    });
    const courseIds = [
      ...new Set(
        (parent?.children || [])
          .map((c) => c.student?.group?.courseId)
          .filter((id): id is string => !!id)
      ),
    ];
    if (courseIds.length === 0) return ok({ courses: [] });

    const courses = await db.course.findMany({
      where: { id: { in: courseIds } },
      orderBy: { createdAt: "asc" },
      select: PUBLIC_COURSE_FIELDS,
    });
    return ok({ courses });
  }

  return ok({ courses: [] });
}
