// GET /api/teacher/sessions — the teacher's session roster.
//
// Everything shown comes from the authenticated teacher's Group rows
// (Group.teacherId → Group.courseId): the client may narrow the listing with
// ?courseId but never widen it past the server-derived course set.
// Readiness is the lesson row state + counts (the ONE Live readiness
// authority computation is on /api/teacher/sessions/[id]); the row ALSO
// carries last-live (public signals only) and the raw audit timestamps, so
// "▶ Live" can be shown only where Live support was actually enabled.

import { NextRequest } from "next/server";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { listTeacherSessions } from "@/lib/teacher-sessions";

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err(tApi("api.179"), 401);
  if (String(user.role) !== "TEACHER") return err(tApi("api.180"), 403);
  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err(tApi("api.180"), 403);
  const url = new URL(req.url);
  const sessions = await listTeacherSessions({
    teacher,
    filterCourseId: url.searchParams.get("courseId"),
  });
  return ok({ sessions });
}
