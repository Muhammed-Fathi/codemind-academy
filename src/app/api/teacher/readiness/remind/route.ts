import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  ok,
  err,
  requireUser,
  getTeacherProfile,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { loadLessonReadiness } from "@/lib/lesson-readiness";
import { createTeacherNoteWithFanout } from "@/lib/teacher-notes";

/**
 * POST /api/teacher/readiness/remind — body { studentId, lessonId }.
 *
 * Reminds ONE not-ready student about their pending lesson requirements. The
 * reminder IS a teacher note (templated text listing exactly what is
 * pending), so it sends through the EXISTING teacher→parent fan-out — no new
 * notification type, no new subsystem, no policy change: teachers still
 * cannot message students directly or broadcast.
 *
 * Guards (all server-side, evaluated LIVE at send time):
 *   * TEACHER role + teacher profile (else 401/403/404);
 *   * the SAME "notification" rate bucket as manual notes (same fan-out
 *     amplification);
 *   * the student must be inside one of the teacher's own groups AND the
 *     lesson must be in a course the teacher teaches (else 404 — the
 *     refusal confirms nothing);
 *   * the student must be NOT READY right now (recomputed — a student who
 *     finished since the teacher loaded the view is refused with api.366,
 *     never spammed). Overrides count as ready (waived, nothing to remind).
 */
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  // Same fan-out amplification as a manual note → same bucket.
  const rl = await applyRateLimit("notification", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => ({}));
  const studentId = String(body.studentId || "").trim();
  const lessonId = String(body.lessonId || "").trim();
  if (!studentId || !lessonId) return err(tApi("api.300"), 400);

  // Scope — same 404 for "no such student/lesson" and "not in your scope".
  const inScopeStudent = (teacher.groups ?? [])
    .flatMap((g) => g.students)
    .find((s) => s.id === studentId);
  if (!inScopeStudent) return err(tApi("api.299"), 404);

  const readiness = await loadLessonReadiness(db, teacher.groups ?? [], lessonId);
  if (!readiness.ok) return err(tApi("api.299"), 404);
  const row = readiness.students.find((s) => s.studentId === studentId);
  if (!row) return err(tApi("api.299"), 404);
  if (row.ready) return err(tApi("api.366"), 409);

  // Templated note text: the lesson + exactly what is pending, so the
  // parent sees an actionable list, not a bare nudge. Fixed structure
  // (pinned by the suite); content, not UI copy — Arabic like manual notes.
  const pendingBits: string[] = [];
  if (row.video.required && !row.video.done) {
    const pendingVideos = row.video.items.filter((v) => !v.completed);
    if (pendingVideos.length > 0) {
      const first = pendingVideos[0];
      pendingBits.push(
        pendingVideos.length === 1
          ? `الفيديو: ${first.currentPercent}% من ${first.requiredPercent}%`
          : `الفيديو: ${pendingVideos.length} فيديوهات غير مكتملة`
      );
    } else {
      pendingBits.push("الفيديو: غير مكتمل");
    }
  }
  if (row.quiz.required && !row.quiz.done) {
    pendingBits.push(
      row.quiz.pending.length > 0
        ? `الاختبار: ${row.quiz.pending.map((q) => q.titleAr || q.title).join("، ")}`
        : "الاختبار: لم يُجتز"
    );
  }
  if (row.homework.required && !row.homework.done) {
    pendingBits.push(
      row.homework.pending.length > 0
        ? `الواجب: ${row.homework.pending.map((h) => h.titleAr || h.title).join("، ")}`
        : "الواجب: لم يُسلَّم"
    );
  }
  const lessonTitle = readiness.lesson.titleAr || readiness.lesson.title;
  const note =
    `تذكير بمتطلبات درس «${lessonTitle}»: ` +
    (pendingBits.length > 0 ? pendingBits.join("؛ ") + "." : "غير جاهز.");

  const sent = await createTeacherNoteWithFanout(db, {
    teacherId: teacher.id,
    actorUserId: user.id,
    studentId,
    note: note.slice(0, 2000),
    teacherName: teacher.user.name,
    studentName: inScopeStudent.user.name,
    tApi,
  });

  return ok(
    { note: { id: sent.noteId, createdAt: sent.createdAt }, notifiedParents: sent.notifiedParents },
    { status: 201 }
  );
}
