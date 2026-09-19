// CodeMind Academy — Phase F: THE authorized join endpoint.
//
//   GET/POST /api/live-sessions/[id]/join
//
// This endpoint is the ONLY way a client ever obtains a meeting URL. It exists
// so that hiding the button is never the security control:
//
//   * the actor's scope is resolved from the database (group membership for a
//     student, a linked child in that group for a parent, group ownership or a
//     session substitution for a teacher);
//   * `decideJoin` (src/lib/live-session-policy.ts) enforces the join window —
//     the same arithmetic the UI renders — and refuses with a stable CODE so
//     the client can show the right Arabic message instead of a raw URL;
//   * the stored URL is RE-VALIDATED on every read, so a legacy row holding an
//     unsafe scheme (`javascript:` …) is treated as "no link" instead of being
//     echoed back to a browser;
//   * for staff (admin / owning teacher / substitute) the window is not a
//     barrier — they need the room to teach — but cancellation and a missing
//     or unsafe link still refuse, and the teacher/student/parent rules are
//     unchanged by this exemption.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, requireUser } from "@/lib/api";
import { ApiFailure, adminActor, failureResponse, requireTeacherActor } from "@/lib/live-session-api";
import {
  decideJoin,
  liveSessionWindows,
  meetingProviderLabelKey,
  validateMeetingUrl,
} from "@/lib/live-session-policy";
import { loadSessionForParent, loadSessionForStudent, loadSessionForTeacher } from "@/lib/live-sessions";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return resolveJoin(req, params);
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  return resolveJoin(req, params);
}

async function resolveJoin(_req: NextRequest, params: Promise<{ id: string }>) {
  const user = await requireUser();
  if (!user) throw new ApiFailure(401, "UNAUTHORIZED", "Unauthorized");
  const { id } = await params;
  const now = new Date();

  try {
    let session: any = null;
    let staff = false;

    if (user.role === "ADMIN") {
      adminActor(user);
      session = await db.liveSession.findUnique({ where: { id } });
      staff = true;
    } else if (user.role === "TEACHER") {
      const actor = await requireTeacherActor(user);
      const access = await loadSessionForTeacher(actor.scope!, id);
      session = access.session;
      staff = true;
    } else if (user.role === "STUDENT") {
      const student = await db.student.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!student) throw new ApiFailure(404, "STUDENT_NOT_FOUND", "Student profile not found");
      session = await loadSessionForStudent(student.id, id);
    } else if (user.role === "PARENT") {
      const parent = await db.parent.findUnique({ where: { userId: user.id }, select: { id: true } });
      if (!parent) throw new ApiFailure(404, "PARENT_NOT_FOUND", "Parent profile not found");
      session = (await loadSessionForParent(parent.id, id)).session;
    } else {
      throw new ApiFailure(403, "NOT_AUTHORIZED", "Forbidden");
    }

    if (!session) throw new ApiFailure(404, "SESSION_NOT_FOUND", "Session not found");

    const validated = validateMeetingUrl(session.meetingUrl);
    const cancellationRefusal =
      String(session.status ?? "").toUpperCase() === "CANCELLED" ? "SESSION_CANCELLED" : null;

    if (cancellationRefusal) {
      return NextResponse.json({ error: "Session cancelled", code: cancellationRefusal }, { status: 409 });
    }
    if (!validated.ok || !staff) {
      const decision = decideJoin(session, now);
      if (!decision.allowed) {
        return NextResponse.json(
          {
            error: "Join is not available",
            code: decision.code,
            opensAt: liveSessionWindows(session).joinOpensAt,
          },
          { status: decision.code === "LINK_NOT_SET" ? 404 : 409 }
        );
      }
    }
    if (!validated.ok) {
      // Staff bypass the window, never the link validation.
      return NextResponse.json({ error: "No usable link", code: "LINK_NOT_SET" }, { status: 404 });
    }

    return ok({
      url: validated.url,
      provider: validated.provider,
      providerLabelKey: meetingProviderLabelKey(validated.provider),
      sessionId: session.id,
      // Metadata only — the URL itself is never logged nor stored elsewhere.
      status: String(session.status),
    });
  } catch (error) {
    return failureResponse(error);
  }
}
