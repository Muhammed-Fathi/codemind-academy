import { getServerT } from "@/lib/i18n-server";
// PATCH /api/admin/groups/[id] — update group (assign teacher, capacity, add/remove students)
//
// Phase 26B — GROUP AUDIENCE SAFETY (owner-approved):
//   * `trackScope` may be set/changed ONLY to an explicit ARABIC | LANGUAGE
//     (absent / SHARED / unrecognised → 400). No inference, no silent default.
//   * Changing a POPULATED group to a track its students don't match is
//     REFUSED (api.287) — the server must never silently strand or misassign
//     students. Compatible = ZERO assigned students, or every assigned
//     student's `schoolType` equals the new audience. A NULL-schoolType
//     student counts as incompatible (no evidence of eligibility).
//   * `addStudentIds` enforces the SAME rule at assignment time: a student
//     whose schoolType differs from the group's audience is refused
//     (api.286) — group assignment can only ever happen compatibly.
//   * Removing students and every other field keep their previous behavior.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { normalizeSchoolType } from "@/lib/school-type";
import { parseGroupTrackScope } from "@/lib/track-scope";
import { groupLevelEligible, normalizeAcademicLevel } from "@/lib/academic-level";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const body = await req.json().catch(() => ({}));

  const group = await db.group.findUnique({ where: { id } });
  if (!group) return err(tApi("api.020"), 404);

  const data: any = {};
  if (typeof body.name === "string") data.name = body.name;
  if (typeof body.schedule === "string") data.schedule = body.schedule;
  if (typeof body.capacity === "number") data.capacity = body.capacity;
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;
  if (body.teacherId !== undefined) data.teacherId = body.teacherId || null;
  // Phase K2 — RE-TARGETING a group to another course changes the level of
  // every member's active assignment (Student.groupId → Group.courseId →
  // Course.academicLevel). Same 26B precedent as an audience change: the
  // target course must be levelled, and a POPULATED group can only be moved
  // to a course of the level its students already hold (I1). No silent
  // unassignment, no student rewrite.
  let nextCourseLevel: string | null | undefined = undefined;
  if (typeof body.courseId === "string" && body.courseId !== group.courseId) {
    const target = await db.course.findUnique({
      where: { id: body.courseId },
      select: { id: true, academicLevel: true },
    });
    if (!target) return err(tApi("api.022"), 404);
    const level = normalizeAcademicLevel(target.academicLevel);
    if (!level) return err(tApi("api.375"), 409);
    // Phase K3: Student.academicLevel is NOT NULL at the database, so a
    // NOT-equals is exhaustive (there is no unlevelled member to skip).
    const incompatible = await db.student.count({
      where: { groupId: id, NOT: { academicLevel: level } },
    });
    if (incompatible > 0) return err(tApi("api.377"), 409);
    nextCourseLevel = level;
    data.courseId = body.courseId;
  } else if (typeof body.courseId === "string") {
    data.courseId = body.courseId;
  }

  // ---- Phase 26B: explicit audience set/change, with the compatibility gate.
  let nextTrackScope: "ARABIC" | "LANGUAGE" | null = null;
  if (body.trackScope !== undefined) {
    const parsed = parseGroupTrackScope(body.trackScope);
    if (!parsed) return err(tApi("api.285"), 400);
    if (parsed !== group.trackScope) {
      // Only students whose school type does NOT match the new audience make
      // the change unsafe. Unclassified (null) groups classify freely when
      // empty; populated ones require every member to match.
      const incompatible = await db.student.count({
        where: { groupId: id, NOT: { schoolType: parsed } },
      });
      if (incompatible > 0) return err(tApi("api.287"), 409);
      nextTrackScope = parsed;
      data.trackScope = parsed;
    }
  }

  if (Object.keys(data).length > 0) {
    await db.group.update({ where: { id }, data });
  }

  // The audience the assignment rules below must respect: the group's value
  // AFTER the (validated) update above.
  // Phase 26C — UNCLASSIFIED groups are now fail-closed for admin assignment
  // too: an unclassified group must be classified before it can receive
  // students (except its existing members remain until classified). This
  // prevents silently seating students into invisible groups.
  const effectiveTrackScope =
    nextTrackScope ?? normalizeSchoolType(group.trackScope);
  // Phase K2 — the academic level assignments must respect: the course's
  // level AFTER the (validated) re-target above.
  const effectiveCourseLevel =
    nextCourseLevel !== undefined
      ? nextCourseLevel
      : normalizeAcademicLevel(
          (
            await db.course.findUnique({
              where: { id: group.courseId },
              select: { academicLevel: true },
            })
          )?.academicLevel
        );

  // Phase 26C — if trying to add students to an unclassified group, reject.
  if (Array.isArray(body.addStudentIds) && body.addStudentIds.length > 0) {
    if (!effectiveTrackScope) {
      return err(tApi("api.285"), 409);
    }
    // Also enforce active + capacity for group assignments
    const freshGroup = await db.group.findUnique({
      where: { id },
      select: { isActive: true, capacity: true, _count: { select: { students: true } } },
    });
    if (freshGroup && !freshGroup.isActive) {
      return err(tApi("api.085"), 409);
    }
    if (freshGroup) {
      const needed = body.addStudentIds.length;
      const current = freshGroup._count.students;
      // Simple capacity check: if adding would exceed, reject (advisory, but safe)
      if (current + needed > freshGroup.capacity) {
        return err(tApi("api.274"), 409);
      }
    }
  }

  // Manage students (optional arrays)
  if (Array.isArray(body.addStudentIds)) {
    for (const sid of body.addStudentIds) {
      const s = await db.student.findUnique({
        where: { id: sid },
        select: { schoolType: true, groupId: true, academicLevel: true },
      });
      if (!s || normalizeSchoolType(s.schoolType) !== effectiveTrackScope) {
        // Phase 26B — assignment is only ever compatible (api.286).
        return err(tApi("api.286"), 409);
      }
      // Phase K2 — the orthogonal level gate (I1): fail-closed, no rewrite.
      if (!groupLevelEligible(s.academicLevel, effectiveCourseLevel)) {
        return err(tApi("api.373"), 409);
      }
      // Capacity re-check per student when student is moving from different group
      if (s.groupId !== id) {
        const count = await db.student.count({ where: { groupId: id } });
        const cap = (await db.group.findUnique({ where: { id }, select: { capacity: true } }))?.capacity ?? 20;
        if (count >= cap) {
          return err(tApi("api.274"), 409);
        }
      }
      await db.student.update({ where: { id: sid }, data: { groupId: id } });
    }
  }
  if (Array.isArray(body.removeStudentIds)) {
    for (const sid of body.removeStudentIds) {
      const s = await db.student.findUnique({ where: { id: sid } });
      if (s && s.groupId === id) {
        await db.student.update({ where: { id: sid }, data: { groupId: null } });
      }
    }
  }

  return ok({ ok: true });
}

// DELETE /api/admin/groups/[id] — remove an UNUSED group (post-launch audit).
//
// SAFE-LIFECYCLE RULE (docs/POST_LAUNCH_AUDIT report §6):
//   A group may be hard-deleted ONLY while nothing references it:
//     * zero assigned students  — Student.groupId has NO cascade/set-null in
//       the delete direction we can rely on silently; stranding a student
//       would hide their enrollment, so a populated group is REFUSED (409)
//       and the admin must move/remove the students first, or deactivate;
//     * zero scheduled sessions — LiveSession.groupId is onDelete: Cascade,
//       so deleting a group with sessions would silently destroy session +
//       attendance history. REFUSED (409) whenever any session exists.
//   A group that fails either guard should be DEACTIVATED instead
//   (PATCH { isActive: false }) — that keeps history and blocks new
//   enrollment/assignment (every write path already refuses inactive groups,
//   api.085). Admin-only, audited, and never cascades into unrelated data.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const group = await db.group.findUnique({
    where: { id },
    include: { _count: { select: { students: true, sessions: true } } },
  });
  if (!group) return err(tApi("api.020"), 404);

  if (group._count.students > 0) {
    return err(
      tApi("api.294", { p1: group._count.students }),
      409
    );
  }
  if (group._count.sessions > 0) {
    return err(
      tApi("api.295", { p1: group._count.sessions }),
      409
    );
  }
  // Phase L manual-QA fix — a third dependent class the original guard could
  // not see: `AbsenceReview.groupId` is `onDelete: Cascade`, so deleting the
  // group would silently destroy formal absence cases (and their holds) even
  // when every affected student has since left the group. Academic history is
  // never deleted as a side effect — refuse and send the admin to
  // deactivation, exactly like the other two guards.
  //
  // `Payment.requestedGroupId` is deliberately NOT a guard: it is a plain
  // String (not a foreign key) recording what a student once REQUESTED, and
  // the payment reader already degrades a missing group to `null`. Payments
  // themselves are never touched by this route.
  const absenceReviews = await db.absenceReview.count({ where: { groupId: id } });
  if (absenceReviews > 0) {
    return err(tApi("api.381", { p1: absenceReviews }), 409);
  }

  await db.group.delete({ where: { id } });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "GROUP_DELETED",
        entity: "Group",
        entityId: id,
        details: JSON.stringify({
          groupId: id,
          name: group.name,
          students: group._count.students,
          sessions: group._count.sessions,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return ok({ ok: true, deleted: true, id });
}
