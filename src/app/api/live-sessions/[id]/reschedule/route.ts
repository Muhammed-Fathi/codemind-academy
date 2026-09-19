// CodeMind Academy — Phase F: reschedule a LiveSession.
//
//   POST /api/live-sessions/[id]/reschedule  { startAt, duration?, reason? }
//
// HISTORY IS PRESERVED: the first scheduled instant stays in
// `originalStartAt` forever, `rescheduleCount` counts the ceremonies, the
// change is audited (`LIVE_SESSION_RESCHEDULE` with from/to), and students AND
// their linked parents are notified (idempotent by session revision).
//
// Reschedule authority equals scheduling authority: Admin anywhere, Teacher
// only inside their own group (or a session they substitute for).

import { NextRequest, NextResponse } from "next/server";
import { ok, requireUser } from "@/lib/api";
import {
  ApiFailure,
  adminActor,
  failureResponse,
  readBody,
  requireTeacherActor,
} from "@/lib/live-session-api";
import { loadSessionForTeacher, rescheduleLiveSession } from "@/lib/live-sessions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readBody(req);

  try {
    const actor =
      user.role === "ADMIN" ? adminActor(user) : user.role === "TEACHER" ? await requireTeacherActor(user) : null;
    if (!actor) throw new ApiFailure(403, "NOT_AUTHORIZED", "Only an admin or a teacher may reschedule a session");
    if (actor.role === "TEACHER") await loadSessionForTeacher(actor.scope!, id);

    const result = await rescheduleLiveSession({
      sessionId: id,
      actorUserId: actor.userId,
      startAt: body.startAt,
      duration: body.duration,
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    return ok({ session: result.session, notifications: result.notifications });
  } catch (error) {
    return failureResponse(error);
  }
}
