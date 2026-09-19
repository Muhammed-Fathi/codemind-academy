// CodeMind Academy — Phase F: the Session Link.
//
//   PUT    /api/live-sessions/[id]/link   set/replace the meeting URL
//   DELETE /api/live-sessions/[id]/link   remove it
//
// A MATERIAL change (a different validated URL) is audited
// (`LIVE_SESSION_LINK_CHANGE`) and emits the STRUCTURED SESSION_LINK
// notification to the group's students — idempotent by session revision, so
// saving the same link twice sends nothing twice. The URL never enters the
// notification row; students resolve it through the authorized join endpoint.

import { NextRequest, NextResponse } from "next/server";
import { ok, requireUser } from "@/lib/api";
import {
  ApiFailure,
  adminActor,
  failureResponse,
  readBody,
  requireTeacherActor,
} from "@/lib/live-session-api";
import { loadSessionForTeacher, setSessionLink } from "@/lib/live-sessions";

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readBody(req);

  try {
    const actor =
      user.role === "ADMIN" ? adminActor(user) : user.role === "TEACHER" ? await requireTeacherActor(user) : null;
    if (!actor) throw new ApiFailure(403, "NOT_AUTHORIZED", "Only an admin or a teacher may change the link");
    if (actor.role === "TEACHER") await loadSessionForTeacher(actor.scope!, id);

    const result = await setSessionLink({
      sessionId: id,
      actorUserId: actor.userId,
      meetingUrl: body.meetingUrl,
    });
    return ok({ session: result.session, notifications: result.notifications });
  } catch (error) {
    return failureResponse(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  try {
    const actor =
      user.role === "ADMIN" ? adminActor(user) : user.role === "TEACHER" ? await requireTeacherActor(user) : null;
    if (!actor) throw new ApiFailure(403, "NOT_AUTHORIZED", "Only an admin or a teacher may change the link");
    if (actor.role === "TEACHER") await loadSessionForTeacher(actor.scope!, id);
    const result = await setSessionLink({ sessionId: id, actorUserId: actor.userId, meetingUrl: null });
    return ok({ session: result.session });
  } catch (error) {
    return failureResponse(error);
  }
}
