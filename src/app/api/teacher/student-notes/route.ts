// /api/teacher/student-notes — Teacher → Student comment/note (post-launch).
//
// BUSINESS RULE (owner-approved)
// ==============================
// A teacher may write an appropriate observation about a STUDENT —
// academic / homework / attendance / progress — and the PARENTS LINKED to
// that student see it in their dashboard (the parent surface already
// renders `TeacherNote` rows, src/components/parent/parent-dashboard.tsx
// → TeacherNotesCard, fed by /api/parents/me/dashboard). This route is the
// missing WRITE side of that existing architecture — it reuses the existing
// `TeacherNote` model, never a parallel system.
//
// AUTHORIZATION (every path — fail closed)
//   * authenticated → TEACHER role → teacher profile;
//   * the student must belong to one of the TEACHER'S OWN groups
//     (`Group.teacherId`, resolved server-side — the request names only a
//     studentId; a student in nobody's group, another teacher's group, or a
//     deleted row all get the SAME 404, so a prober learns nothing about
//     which ids exist);
//   * notes are immutable history: there is NO PATCH and NO DELETE route.
//     Deleting would orphan the parent's attribution ("who said this?"), and
//     a teacher's reassignment must not erase what they wrote — the model
//     is append-only by design (the admin teacher-deletion guard already
//     counts TeacherNote rows the same way, api.296).
//
// SIDE EFFECTS (failure-tolerant, post-commit style like the payment
// routes):
//   * EVERY parent linked to the student gets ONE ANNOUNCEMENT notification
//     (honours the parent's notification preferences + quiet hours through
//     the shared `createNotificationIfAllowed`);
//   * an auditLog row (TEACHER_NOTE_CREATE) for admin oversight.
//   Both effects run AFTER the note is committed and can never roll the
//   write back: a parent without a preference row still gets the note in
//   their dashboard — the notification is the convenience, the dashboard
//   row is the source of truth.
//
// RATE LIMIT: reuses the existing `notification` bucket (30/min, 5-min
// block) — each note fans out parent notifications, the same amplification
// concern the admin broadcast route guards.

import { getServerT } from "@/lib/i18n-server";
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
import { boundedText } from "@/lib/teacher-content";
import { createTeacherNoteWithFanout } from "@/lib/teacher-notes";

/** Note length contract (shared with the UI hint + the suite). */
export const TEACHER_NOTE_MIN = 3;
export const TEACHER_NOTE_MAX = 2000;
/** How many recent notes the read surface returns per student. */
export const TEACHER_NOTE_LIST_LIMIT = 20;

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  // Scope: the notes of the students in the teacher's own groups. A
  // groupId narrows it to one group; a studentId narrows it further to one
  // student (both scope-checked against the teacher's groups).
  const url = new URL(req.url);
  const groupId = url.searchParams.get("groupId") || "";
  const studentFilter = url.searchParams.get("studentId") || "";
  const groups = groupId
    ? teacher.groups.filter((g) => g.id === groupId)
    : teacher.groups;
  if (groups.length === 0) return ok({ notes: [] });

  let studentIds = groups.flatMap((g) => g.students.map((s) => s.id));
  if (studentFilter) studentIds = studentIds.filter((id) => id === studentFilter);
  if (studentIds.length === 0) return ok({ notes: [] });

  const studentNames = new Map<string, string>();
  for (const g of groups) {
    for (const s of g.students) studentNames.set(s.id, s.user.name);
  }

  const notes = await db.teacherNote.findMany({
    where: {
      teacherId: teacher.id,
      studentId: { in: studentIds },
    },
    orderBy: { createdAt: "desc" },
    take: TEACHER_NOTE_LIST_LIMIT,
  });

  return ok({
    notes: notes.map((n) => ({
      id: n.id,
      studentId: n.studentId,
      studentName: studentNames.get(n.studentId) || "—",
      note: n.note,
      createdAt: n.createdAt,
    })),
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  // Each note fans out parent notifications — the same amplification
  // concern the admin broadcast route guards, so the SAME bucket applies.
  const rl = await applyRateLimit("notification", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const body = await req.json().catch(() => ({}));
  const studentId = String(body.studentId || "").trim();
  const note = boundedText(body.note, TEACHER_NOTE_MAX, { required: true });
  if (!studentId || !note.ok || note.value === null ||
      note.value.length < TEACHER_NOTE_MIN) {
    return err(tApi("api.300"), 400);
  }

  // SCOPE — the student must be inside one of the teacher's own groups.
  // Same 404 for "no such student" and "student not in your groups": the
  // refusal must not confirm which ids exist.
  const inScopeStudent = teacher.groups
    .flatMap((g) => g.students)
    .find((s) => s.id === studentId);
  if (!inScopeStudent) return err(tApi("api.299"), 404);

  // The SHARED teacher-send write side (note row + audit + parent fan-out)
  // — manual notes and readiness reminders run ONE implementation.
  const sent = await createTeacherNoteWithFanout(db, {
    teacherId: teacher.id,
    actorUserId: user.id,
    studentId,
    note: note.value,
    teacherName: teacher.user.name,
    studentName: inScopeStudent.user.name,
    tApi,
  });

  return ok({ note: { id: sent.noteId, createdAt: sent.createdAt }, notifiedParents: sent.notifiedParents }, { status: 201 });
}
