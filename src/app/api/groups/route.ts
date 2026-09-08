import { NextRequest } from "next/server";
import { ok } from "@/lib/api";
import { db } from "@/lib/db";

// Public group picker used by the enrolment flow (src/components/auth/enroll-view.tsx).
//
// SECURITY: this endpoint is intentionally unauthenticated, so it must expose
// ONLY the fields the picker renders. It previously included the teacher's
// full User relation, which serialised the teacher's whole User row (scrypt
// password hash, phone, e-mail, status) to anonymous callers. Keep this an
// explicit field selection — never a bare relation include.
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const courseId = url.searchParams.get("courseId");
  const where: { isActive: boolean; courseId?: string } = { isActive: true };
  if (courseId) where.courseId = courseId;
  const groups = await db.group.findMany({
    where,
    select: {
      id: true,
      name: true,
      courseId: true,
      capacity: true,
      schedule: true,
      course: { select: { id: true, slug: true, name: true, nameAr: true, color: true } },
      teacher: { select: { id: true, user: { select: { name: true } } } },
      _count: { select: { students: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return ok({ groups });
}
