// GET /api/teacher/sessions/[id] — Phase E teacher Session WORKSPACE.
//
// ONE aggregate read for one owned lesson:
//
//   overview (title · officialCode · Course · Part · Unit · trackScope ·
//             lifecycle flags — READ-ONLY, lifecycle is the admin ceremony's)
//   video    (READ-ONLY status: counts + per-track audience coverage from the
//             same rows readiness consumed; no video ids, no media ids)
//   materials(all rows of the lesson + the Phase E `own` management flag and
//             a safe authorized downloadUrl; no storage keys, no asset ids)
//   quizzes  (id · title · passMark · timeLimit · trackScope · question and
//             attempt counts — the workspace's manage surface)
//   homework (id · title · instructions · deadline · maxMarks · trackScope ·
//             submission counts)
//   readiness(the full Phase D snapshot via `getLessonReadiness` — the SAME
//             computation the admin ceremony and the admin readiness route
//             consume; never a second implementation)
//
// AUTHORIZATION: authenticated → TEACHER role → the lesson resolves through
// one of the teacher's own courses (`Group.courseId`) — `loadOwnedLesson`,
// canonical chain first. Unknown lesson → 404; another teacher's lesson →
// 403; a chain-less lesson → 404. Client-supplied teacherId/courseId/
// groupId are never consulted.

import { NextRequest } from "next/server";
import { getServerT } from "@/lib/i18n-server";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { teacherCourseIds } from "@/lib/teacher-content";
import { loadTeacherSessionWorkspace } from "@/lib/teacher-sessions";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const result = await loadTeacherSessionWorkspace({
    lessonId: id,
    userId: user.id,
    courseIds: teacherCourseIds(teacher),
  });
  if (!result.ok) {
    return err(
      result.status === 403 ? tApi("api.180") : tApi("api.179"),
      result.status
    );
  }

  return ok(result.workspace);
}
