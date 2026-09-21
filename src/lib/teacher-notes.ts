// CodeMind Academy — teacher→parent notes (the EXISTING teacher-send path).
//
// Teachers cannot broadcast general notifications (admin-only by policy —
// Phase 20/26D); what they CAN do is write an observation about a student,
// which fans out to the student's LINKED PARENTS as an ANNOUNCEMENT through
// the shared `createNotificationIfAllowed` helper (preferences + quiet hours
// honoured — no second notification subsystem, no policy weakening).
//
// This module owns the WRITE side (TeacherNote row + audit + parent fan-out)
// so every teacher-initiated send — manual notes AND readiness reminders —
// shares ONE implementation. Scope checks + rate limiting stay in the routes
// (they differ per surface); this helper assumes the caller authorized.

import { createNotificationIfAllowed } from "@/lib/notify";

export type TeacherNoteDb = {
  teacherNote: {
    create(args: {
      data: { teacherId: string; studentId: string; note: string };
    }): Promise<{ id: string; createdAt: Date }>;
  };
  auditLog: {
    create(args: {
      data: { userId: string; action: string; entity: string; entityId: string; details: string };
    }): Promise<unknown>;
  };
  parentStudentLink: {
    findMany(args: {
      where: { studentId: string };
      include: { parent: { include: { user: { select: { id: boolean; name: boolean } } } } };
    }): Promise<
      Array<{ parent?: { user?: { id?: string | null } | null } | null }>
    >;
  };
};

export async function createTeacherNoteWithFanout(
  db: TeacherNoteDb,
  input: {
    /** The teacher profile id (TeacherNote.teacherId). */
    teacherId: string;
    /** The user id performing the write (audit actor). */
    actorUserId: string;
    studentId: string;
    /** Validated note text (length-checked by the caller). */
    note: string;
    /** Display names for the parent notification copy. */
    teacherName: string;
    studentName: string;
    tApi: (key: string, params?: Record<string, unknown>) => string;
  }
): Promise<{ noteId: string; createdAt: Date; notifiedParents: number }> {
  const created = await db.teacherNote.create({
    data: {
      teacherId: input.teacherId,
      studentId: input.studentId,
      note: input.note,
    },
  });

  // ADMIN OVERSIGHT — who wrote what, when. Failure-tolerant: the note is
  // committed; an audit hiccup must not erase the teacher's work.
  await db.auditLog
    .create({
      data: {
        userId: input.actorUserId,
        action: "TEACHER_NOTE_CREATE",
        entity: "TeacherNote",
        entityId: created.id,
        details: JSON.stringify({
          studentId: input.studentId,
          length: input.note.length,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  // PARENT FAN-OUT — every parent LINKED to this student gets one
  // ANNOUNCEMENT notification (preferences + quiet hours honoured by the
  // shared helper). Link stays NULL on purpose: the deep-link scheme only
  // knows lesson/video/quiz/homework, and a parent notification to a
  // student-owned view would be a scope breach. The parent dashboard
  // already renders the note (TeacherNotesCard).
  const links = await db.parentStudentLink.findMany({
    where: { studentId: input.studentId },
    include: { parent: { include: { user: { select: { id: true, name: true } } } } },
  });
  let notifiedParents = 0;
  for (const link of links) {
    const parentId = link.parent?.user?.id;
    if (!parentId) continue;
    const delivered = await createNotificationIfAllowed({
      userId: parentId,
      type: "ANNOUNCEMENT",
      title: input.tApi("api.301"),
      message: input.tApi("api.302", {
        p1: input.teacherName,
        p2: input.studentName,
      }),
      link: null,
    });
    if (delivered) notifiedParents++;
  }

  return { noteId: created.id, createdAt: created.createdAt, notifiedParents };
}
