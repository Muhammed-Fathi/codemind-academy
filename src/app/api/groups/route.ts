import { NextRequest } from "next/server";
import type { Prisma } from "@prisma/client";
import { ok, err, requireUser } from "@/lib/api";
import { db } from "@/lib/db";
import { getStudentSchoolType } from "@/lib/enrollment";

// Student group picker used by the enrolment flow (src/components/auth/enroll-view.tsx).
//
// Phase 26B (owner-approved): GROUP AUDIENCE ELIGIBILITY.
//   Groups carry an explicit audience (`Group.trackScope` = ARABIC |
//   LANGUAGE; NULL = UNCLASSIFIED legacy row). The picker derives the
//   viewer's eligibility from the AUTHENTICATED student's OWN persisted
//   `schoolType` row — never from a client-supplied parameter, the locale or
//   the UI language — and serves EXACT-match groups only:
//
//     ARABIC student   → ARABIC groups only
//     LANGUAGE student → LANGUAGE groups only
//     NULL/unknown     → NOTHING (fail-closed: a student whose school type
//                        is unknown has no audience to be eligible for)
//
//   Unclassified (null) groups are NEVER listed — an admin must classify
//   them (api.285 contract) before they can be sold again. Eligibility is
//   the exact-match predicate (`groupTrackScopeEligible`), deliberately NOT
//   the wider content predicate — SHARED is a content-only concept.
//
// SECURITY: this endpoint now requires an authenticated STUDENT session
// (eligibility is a per-student fact). It previously served anonymous
// callers and must keep exposing ONLY the fields the picker renders — no
// teacher User relation, no internal fields (the Phase 25 field-selection
// rule below stands; `trackScope` itself is deliberately not added to the
// payload because the picker never renders it).
export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!student) return err("Student profile not found", 404);

  // The single eligibility input: the student's OWN row, normalised +
  // fail-closed (null when missing/unrecognised → empty listing).
  const schoolType = await getStudentSchoolType(student.id);
  if (!schoolType) return ok({ groups: [] });

  const url = new URL(req.url);
  const courseId = url.searchParams.get("courseId");
  // The filter is typed as the GENERATED Prisma filter — never a hand-rolled
  // shape: `Group.trackScope` is `TrackScope?`, so a plain `string` is not
  // assignable to its where input. `schoolType` is the canonical SchoolType
  // ("ARABIC" | "LANGUAGE") derived above from the student's own persisted
  // row (fail-closed), which is a subtype of the generated TrackScope union —
  // the exact-match eligibility predicate, unchanged.
  const where: Prisma.GroupWhereInput = {
    isActive: true,
    trackScope: schoolType,
  };
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
