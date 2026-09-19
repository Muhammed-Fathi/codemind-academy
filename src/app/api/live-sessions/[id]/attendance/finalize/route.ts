// CodeMind Academy — Phase F: finalize the register ("تأكيد الحضور").
//
//   POST /api/live-sessions/[id]/attendance/finalize  { acknowledgeUnmarked?: boolean }
//
// Finalization is THE LOCK and the ONLY entry point of the absence workflow:
//   * it stamps `attendanceFinalizedAt`, after which every teacher write is
//     refused server-side (read-only history for the teacher);
//   * every finalized ABSENT row opens exactly one AbsenceReview case
//     (PENDING_REASON) and notifies the student + linked parents;
//   * UNMARKED students are NOT converted to ABSENT. If any remain, the
//     request is refused unless the teacher explicitly acknowledges them, and
//     an acknowledged finalize flags the session ATTENDANCE_INCOMPLETE for
//     admin review instead of inventing absences.
//   * the response always carries the counter the UI shows
//     ("28 / 30 students marked").

import { NextRequest, NextResponse } from "next/server";
import { ok, requireUser } from "@/lib/api";
import { ApiFailure, failureResponse, readBody, requireTeacherActor } from "@/lib/live-session-api";
import { finalizeAttendance, loadSessionForTeacher } from "@/lib/live-sessions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readBody(req);

  try {
    if (user.role !== "TEACHER") {
      throw new ApiFailure(403, "NOT_AUTHORIZED", "Only the session's teacher may finalize attendance");
    }
    const actor = await requireTeacherActor(user);
    await loadSessionForTeacher(actor.scope!, id);

    const result = await finalizeAttendance({
      sessionId: id,
      actorUserId: actor.userId,
      acknowledgeUnmarked: body.acknowledgeUnmarked === true,
    });

    return ok({
      session: result.session,
      counts: result.counts,
      finalizedAt: result.finalizedAt,
      acknowledgedUnmarked: result.acknowledgedUnmarked,
      absenceCases: result.absenceCases,
      // The exact string the confirmation dialog shows before/after.
      summary: `${result.counts.marked} / ${result.counts.total}`,
    });
  } catch (error) {
    return failureResponse(error);
  }
}
