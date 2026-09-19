// CodeMind Academy — Phase F: cancel a LiveSession.
//
//   POST /api/live-sessions/[id]/cancel  { reason? }
//
// A cancelled session is TERMINAL and NEUTRAL: the register refuses every
// write afterwards (so a cancellation can never manufacture ABSENT records),
// no absence case can be born from it, and students + linked parents receive
// the explicit SESSION_CANCELLED notification.

import { NextRequest, NextResponse } from "next/server";
import { ok, requireUser } from "@/lib/api";
import {
  ApiFailure,
  adminActor,
  failureResponse,
  readBody,
  requireTeacherActor,
} from "@/lib/live-session-api";
import { cancelLiveSession, loadSessionForTeacher } from "@/lib/live-sessions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readBody(req);

  try {
    const actor =
      user.role === "ADMIN" ? adminActor(user) : user.role === "TEACHER" ? await requireTeacherActor(user) : null;
    if (!actor) throw new ApiFailure(403, "NOT_AUTHORIZED", "Only an admin or a teacher may cancel a session");
    if (actor.role === "TEACHER") await loadSessionForTeacher(actor.scope!, id);

    const result = await cancelLiveSession({
      sessionId: id,
      actorUserId: actor.userId,
      reason: typeof body.reason === "string" ? body.reason : null,
    });
    return ok({ session: result.session, notifications: result.notifications });
  } catch (error) {
    return failureResponse(error);
  }
}
