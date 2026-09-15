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
  if (typeof body.courseId === "string") data.courseId = body.courseId;

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
  // AFTER the (validated) update above. NULL (unclassified legacy group)
  // imposes no constraint on assignment — classification is the operator's
  // explicit step, and today's admin workflow may still seat legacy students
  // there; the student-facing surfaces stay fail-closed regardless.
  const effectiveTrackScope =
    nextTrackScope ?? normalizeSchoolType(group.trackScope);

  // Manage students (optional arrays)
  if (Array.isArray(body.addStudentIds)) {
    for (const sid of body.addStudentIds) {
      if (effectiveTrackScope) {
        const s = await db.student.findUnique({
          where: { id: sid },
          select: { schoolType: true },
        });
        if (!s || normalizeSchoolType(s.schoolType) !== effectiveTrackScope) {
          // Phase 26B — assignment is only ever compatible (api.286).
          return err(tApi("api.286"), 409);
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
