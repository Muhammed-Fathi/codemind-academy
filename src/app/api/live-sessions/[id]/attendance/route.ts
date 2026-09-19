// CodeMind Academy — Phase F: the attendance register for ONE session.
//
//   GET    /api/live-sessions/[id]/attendance
//            The SERVER-DERIVED roster (LiveSession.groupId → Group.students),
//            each student's mark for THIS session (UNMARKED when there is no
//            row), the live counts, the window bounds and whether the register
//            is locked. Teachers see their own/substituted sessions; admins may
//            read any (read-only — their write path is the audited correction).
//
//   POST   /api/live-sessions/[id]/attendance   { attendance: [{studentId,status,note?}] }
//            Save marks. TEACHERS (owner or substitute) only, and only inside
//            the open window: before the scheduled start the write is refused
//            (NOT_STARTED) and after the window closes, or after finalization,
//            it is refused (WINDOW_CLOSED / ALREADY_FINALIZED). Enforced here,
//            server-side — hiding the buttons is not the control.
//
//   DELETE /api/live-sessions/[id]/attendance?studentId=…
//            Clear a student's mark back to UNMARKED (open window only).
//            UNMARKED is the absence of a row; it is NEVER an ABSENT write.

import { NextRequest, NextResponse } from "next/server";
import { ok, requireUser } from "@/lib/api";
import {
  ApiFailure,
  failureResponse,
  readBody,
  requireTeacherActor,
} from "@/lib/live-session-api";
import {
  clearAttendanceMark,
  getSessionWorkspace,
  loadSessionForTeacher,
  saveAttendance,
  type AttendanceEntry,
} from "@/lib/live-sessions";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) throw new ApiFailure(401, "UNAUTHORIZED", "Unauthorized");
  const { id } = await params;

  try {
    if (user.role === "TEACHER") {
      const actor = await requireTeacherActor(user);
      const access = await loadSessionForTeacher(actor.scope!, id);
      const workspace = await getSessionWorkspace({ sessionId: id });
      return ok({ ...workspace, via: access.via });
    }
    if (user.role === "ADMIN") {
      const workspace = await getSessionWorkspace({ sessionId: id });
      return ok({ ...workspace, readOnly: true });
    }
    throw new ApiFailure(403, "NOT_AUTHORIZED", "Students and parents cannot read the attendance register");
  } catch (error) {
    return failureResponse(error);
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readBody(req);

  try {
    if (user.role !== "TEACHER") {
      throw new ApiFailure(
        403,
        "NOT_AUTHORIZED",
        "Only the session's teacher may mark attendance; admins correct a locked register"
      );
    }
    const actor = await requireTeacherActor(user);
    await loadSessionForTeacher(actor.scope!, id);

    const raw = Array.isArray(body.attendance) ? body.attendance : [];
    const entries: AttendanceEntry[] = raw
      .filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object")
      .map((row) => ({
        studentId: String(row.studentId ?? ""),
        status: String(row.status ?? "") as AttendanceEntry["status"],
        note: typeof row.note === "string" ? row.note : null,
      }));

    const result = await saveAttendance({ sessionId: id, actorUserId: actor.userId, entries });
    return ok(result);
  } catch (error) {
    return failureResponse(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const url = new URL(req.url);
  const studentId = url.searchParams.get("studentId") || "";

  try {
    if (user.role !== "TEACHER") throw new ApiFailure(403, "NOT_AUTHORIZED", "Only a teacher may clear a mark");
    if (!studentId) throw new ApiFailure(400, "STUDENT_NOT_IN_ROSTER", "studentId is required");
    const actor = await requireTeacherActor(user);
    await loadSessionForTeacher(actor.scope!, id);
    const result = await clearAttendanceMark({ sessionId: id, actorUserId: actor.userId, studentId });
    return ok(result);
  } catch (error) {
    return failureResponse(error);
  }
}
