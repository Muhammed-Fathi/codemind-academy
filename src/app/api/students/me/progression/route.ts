// GET /api/students/me/progression?courseId=<id>
//
// The canonical progression evaluation for the current student (Phase H).
// Same authority the course tree, the lesson page, the dashboard and every
// access gate derive from — states, Arabic reasons, structured unmet
// requirements, completion evidence, the active hold (if any), the active
// Admin override (if any), and the effective progression boundary.
//
// `courseId` defaults to the student's enrolled course. A `courseId` the
// student is not enrolled in is refused (403 NOT_ENROLLED) — this endpoint
// never describes another course's curriculum.

import { NextRequest } from "next/server";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { loadCourseProgression } from "@/lib/progression";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  const enrolledCourseId =
    student.group && student.group.isActive ? student.group.courseId : null;
  const requested = req.nextUrl.searchParams.get("courseId");
  const courseId = requested || enrolledCourseId;
  if (!courseId || courseId !== enrolledCourseId) {
    const tApi = await getServerT();
    return err(tApi("api.208"), 403);
  }

  const progression = await loadCourseProgression(student.id, courseId);
  return ok({
    courseId: progression.courseId,
    currentLessonId: progression.currentLessonId,
    lessons: progression.lessons.map((l) => ({
      lessonId: l.lessonId,
      order: l.order,
      state: l.state,
      completed: l.completed,
      unlocked: l.unlocked,
      video: l.video,
      quiz: l.quiz,
      assignment: l.assignment,
      unmet: l.unmet,
      reason: l.reason,
      reasonCode: l.reasonCode,
      evidence: l.evidence,
      hold: l.hold,
      override: l.override,
    })),
    holds: progression.holds,
    overrides: progression.overrides,
    boundary: progression.boundary,
    evaluatedAt: progression.evaluatedAt.toISOString(),
  });
}
