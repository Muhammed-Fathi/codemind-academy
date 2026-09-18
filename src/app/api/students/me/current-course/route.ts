import { NextRequest } from "next/server";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";

// GET /api/students/me/current-course
//
// The student's CURRENT COURSE — the platform's existing current-course rule,
// read from authorized student data:
//
//   A student belongs to at most ONE group (`Student.groupId` is singular),
//   and the group's course is that student's course. The dashboard already
//   serialises exactly this as `group.course`, and its "كل الكورس" button
//   navigates the Course view with `group.course.slug`.
//
// This endpoint is a NAVIGATION READER ONLY:
//   * it resolves the course IDENTITY (id + slug + display fields the course
//     header renders) from the caller's own row — nothing is taken from the
//     request, so no slug guessing, no cross-student reads;
//   * it performs NO progression logic and serves NO course CONTENT — the
//     content boundary remains GET /api/courses/[slug], which enforces
//     enrollment (403 NOT_ENROLLED), track and lifecycle server-side exactly
//     as before;
//   * zero courses (no group) answers `course: null` — the client then shows
//     its existing empty state, never a guess.
//
// Multiple simultaneous courses are not representable in the current schema
// (one group, one course), so the resolution is deterministic: zero or one.

export async function GET(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  return ok({
    course: student.group
      ? {
          id: student.group.course.id,
          slug: student.group.course.slug,
          name: student.group.course.name,
          nameAr: student.group.course.nameAr,
          color: student.group.course.color,
        }
      : null,
  });
}
