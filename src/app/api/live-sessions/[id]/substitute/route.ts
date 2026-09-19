// CodeMind Academy — Phase F: substitute teacher for ONE session (ADMIN only).
//
//   POST   /api/live-sessions/[id]/substitute  { substituteTeacherId }
//   DELETE /api/live-sessions/[id]/substitute
//
// A substitution is SESSION-SCOPED: `LiveSession.teacherId` is never rewritten,
// `Group.teacherId`/`Course` are never touched, and the substitute gains
// exactly three powers for this session — view, join, take attendance inside
// the window. Every assignment/removal is audited.

import { NextRequest, NextResponse } from "next/server";
import { ok, requireUser } from "@/lib/api";
import { ApiFailure, failureResponse, readBody } from "@/lib/live-session-api";
import { assignSubstituteTeacher } from "@/lib/live-sessions";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") return NextResponse.json({ error: "Forbidden", code: "NOT_AUTHORIZED" }, { status: 403 });
  const { id } = await params;
  const body = await readBody(req);

  try {
    const substituteTeacherId =
      typeof body.substituteTeacherId === "string" && body.substituteTeacherId.trim()
        ? body.substituteTeacherId.trim()
        : null;
    const result = await assignSubstituteTeacher({
      sessionId: id,
      actorUserId: user.id,
      substituteTeacherId,
    });
    return ok({ session: result.session, notifications: result.notifications });
  } catch (error) {
    return failureResponse(error);
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (user.role !== "ADMIN") {
    throw new ApiFailure(403, "NOT_AUTHORIZED", "Only an admin may change a substitution");
  }
  const { id } = await params;
  try {
    const result = await assignSubstituteTeacher({
      sessionId: id,
      actorUserId: user.id,
      substituteTeacherId: null,
    });
    return ok({ session: result.session });
  } catch (error) {
    return failureResponse(error);
  }
}
