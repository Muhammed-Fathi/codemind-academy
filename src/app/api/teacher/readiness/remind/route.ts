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
import {
  buildReadinessPendingBits,
  buildReminderText,
  resolveReminderAudience,
  sendReadinessReminderToStudent,
  type StudentReminderResult,
} from "@/lib/readiness-reminders";

/**
 * POST /api/teacher/readiness/remind — body { studentId, lessonId, audience? }.
 *
 * Reminds ONE not-ready student about their pending lesson requirements. The
 * request carries ONLY a controlled audience mode (STUDENT / PARENT / BOTH —
 * defaulting to the historical parent-only send when absent); every
 * recipient is server-derived, so there is still no free-form text, no
 * client-supplied destination, and no generic teacher-messaging API:
 *   * PARENT — the reminder IS a teacher note (templated text listing exactly
 *     what is pending), sent through the EXISTING teacher→parent fan-out;
 *   * STUDENT — one system notification through the EXISTING idempotent
 *     notification primitive (same pending list, server-minted lesson deep
 *     link, preferences + quiet hours honoured, one per student per lesson
 *     per day).
 *
 * Guards (all server-side, evaluated LIVE at send time):
 *   * TEACHER role + teacher profile (else 401/403/404);
 *   * the SAME "notification" rate bucket as manual notes (same fan-out
 *     amplification — charged ONCE per request, whatever the audience);
 *   * the student must be inside one of the teacher's own groups AND the
 *     lesson must be in a course the teacher teaches (else 404 — the
 *     refusal confirms nothing);
 *   * the student must be NOT READY right now (recomputed — a student who
 *     finished since the teacher loaded the view is refused with api.366,
 *     never spammed). Overrides count as ready (waived, nothing to remind).
 *
 * The response reports EVERY audience explicitly (per-audience status +
 * counts) — a partial send (one leg delivered, the other duplicate/skipped/
 * unavailable) is a 201 with an honest body, never a silent success; a valid
 * request that wrote nothing new (all duplicate/skipped) is a 200.
 */
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  // Same fan-out amplification as a manual note → same bucket, charged once
  // per teacher action regardless of how many legs the audience has.
  const rl = await applyRateLimit("notification", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => ({}));
  const studentId = String(body.studentId || "").trim();
  const lessonId = String(body.lessonId || "").trim();
  if (!studentId || !lessonId) return err(tApi("api.300"), 400);
  const audience = resolveReminderAudience(body.audience);
  if (!audience) return err(tApi("api.367"), 400);

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

  // Templated pending list: the lesson + exactly what is pending, shared by
  // the parent note and the student message so the two legs can never
  // disagree. Fixed structure (pinned by the suite); content, not UI copy —
  // Arabic like manual notes.
  const pendingBits = buildReadinessPendingBits(row);
  const lessonTitle = readiness.lesson.titleAr || readiness.lesson.title;

  // PARENT leg — the historical path, untouched: a teacher note fanned out
  // to the linked parents through the shared notes helper.
  let note: { id: string; createdAt: Date } | null = null;
  let notifiedParents = 0;
  if (audience !== "STUDENT") {
    const sent = await createTeacherNoteWithFanout(db, {
      teacherId: teacher.id,
      actorUserId: user.id,
      studentId,
      note: buildReminderText(lessonTitle, pendingBits).slice(0, 2000),
      teacherName: teacher.user.name,
      studentName: inScopeStudent.user.name,
      tApi,
    });
    note = { id: sent.noteId, createdAt: sent.createdAt };
    notifiedParents = sent.notifiedParents;
  }

  // STUDENT leg — one system notification to the student's own user row.
  let student: StudentReminderResult | { status: "not_requested"; notified: 0 } = {
    status: "not_requested",
    notified: 0,
  };
  if (audience !== "PARENT") {
    student = await sendReadinessReminderToStudent({
      studentId,
      studentUser: inScopeStudent.user ?? null,
      lessonId,
      lessonTitle,
      pendingBits,
    });
  }

  const wroteSomething = note !== null || student.notified === 1;
  return ok(
    {
      audience,
      // Legacy top-level shape (parent-only callers): the note + the parent
      // delivery count, exactly as before.
      note,
      notifiedParents,
      parent: {
        status: audience === "STUDENT" ? "not_requested" : "sent",
        notified: notifiedParents,
        note,
      },
      student,
    },
    { status: wroteSomething ? 201 : 200 }
  );
}
