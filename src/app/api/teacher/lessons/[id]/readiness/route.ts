import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { loadLessonReadiness } from "@/lib/lesson-readiness";

/**
 * GET /api/teacher/lessons/[id]/readiness
 *
 * Per-student progression readiness for ONE lesson, computed LIVE from the
 * canonical engine (same verdicts the student card shows). The teacher must
 * teach the lesson's course, and only students of their own groups in that
 * course are returned. Out-of-scope lessons answer 404 (the same scope rule
 * as teacher-notes: the refusal confirms nothing). Rows carry requirement
 * STATES only — never lesson content.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const { id } = await params;
  const readiness = await loadLessonReadiness(db, teacher.groups ?? [], id);
  if (!readiness.ok) return err(tApi("api.299"), 404);
  return ok(readiness);
}
