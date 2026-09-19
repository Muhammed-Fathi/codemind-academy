// CodeMind Academy — Phase F: ONE LiveSession.
//
// GET   /api/live-sessions/[id]        role-scoped detail (+ roster for staff)
// PATCH /api/live-sessions/[id]        metadata edits and the lifecycle flips
//                                      (`action: "start" | "end"`)
//
// SCOPE IS SERVER-SIDE ONLY:
//   ADMIN   any session
//   TEACHER own group's session, or a session they substitute for
//   STUDENT only a session of their OWN group
//   PARENT  only through a linked child who is in that group
// Anything else answers 404 — a session id is never an existence oracle.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, requireUser } from "@/lib/api";
import {
  ApiFailure,
  adminActor,
  failureResponse,
  readBody,
  requireTeacherActor,
} from "@/lib/live-session-api";
import {
  endLiveSession,
  getSessionWorkspace,
  loadSessionForParent,
  loadSessionForStudent,
  loadSessionForTeacher,
  startLiveSession,
  toLiveSessionPayload,
  updateLiveSessionMeta,
} from "@/lib/live-sessions";
import { listAbsencesForStudent } from "@/lib/absence-review";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) throw new ApiFailure(401, "UNAUTHORIZED", "Unauthorized");
  const { id } = await params;
  const now = new Date();

  try {
    if (user.role === "ADMIN") {
      const workspace = await getSessionWorkspace({ sessionId: id, now });
      return ok({ ...workspace, scope: "admin" });
    }
    if (user.role === "TEACHER") {
      const actor = await requireTeacherActor(user);
      const access = await loadSessionForTeacher(actor.scope!, id);
      const workspace = await getSessionWorkspace({ sessionId: id, now });
      // A teacher never receives another teacher's correction trail; the
      // workspace payload is already teacher-safe (no admin fields).
      return ok({ ...workspace, scope: "teacher", via: access.via });
    }
    if (user.role === "STUDENT") {
      const student = await db.student.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!student) throw new ApiFailure(404, "STUDENT_NOT_FOUND", "Student profile not found");
      const session = await loadSessionForStudent(student.id, id);
      const payload = toLiveSessionPayload({
        session: {
          ...session,
          group: session.group,
          lesson: session.lesson ? { id: session.lesson.id, title: session.lesson.title, titleAr: session.lesson.titleAr } : null,
        },
        now,
      });
      const absences = await listAbsencesForStudent(student.id, { now, limit: 20 });
      const mine = absences.find((a) => a.session.id === id) ?? null;
      return ok({ session: payload, absence: mine, scope: "student" });
    }
    if (user.role === "PARENT") {
      const parent = await db.parent.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!parent) throw new ApiFailure(404, "PARENT_NOT_FOUND", "Parent profile not found");
      const { session, studentId } = await loadSessionForParent(parent.id, id);
      const absences = await listAbsencesForStudent(studentId, { now, limit: 50 });
      return ok({
        session: toLiveSessionPayload({ session, now }),
        childId: studentId,
        absence: absences.find((a) => a.session.id === id) ?? null,
        scope: "parent",
      });
    }
    throw new ApiFailure(403, "FORBIDDEN", "Forbidden");
  } catch (error) {
    return failureResponse(error);
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const { id } = await params;
  const body = await readBody(req);

  try {
    const actor =
      user.role === "ADMIN" ? adminActor(user) : user.role === "TEACHER" ? await requireTeacherActor(user) : null;
    if (!actor) throw new ApiFailure(403, "NOT_AUTHORIZED", "Only an admin or a teacher may edit a session");

    // Loading through the role's own scope refuses a foreign session here too:
    // the metadata/start/end paths can never bypass authorization.
    if (actor.role === "TEACHER") await loadSessionForTeacher(actor.scope!, id);

    const action = typeof body.action === "string" ? body.action : "";
    if (action === "start") {
      const session = await startLiveSession({ sessionId: id, actorUserId: actor.userId });
      return ok({ session });
    }
    if (action === "end") {
      const session = await endLiveSession({ sessionId: id, actorUserId: actor.userId });
      return ok({ session });
    }

    const session = await updateLiveSessionMeta({
      sessionId: id,
      actorUserId: actor.userId,
      patch: {
        ...(body.title !== undefined ? { title: body.title as string } : {}),
        ...(body.titleAr !== undefined ? { titleAr: body.titleAr as string } : {}),
        ...(body.description !== undefined ? { description: (body.description as string) ?? null } : {}),
      },
    });
    return ok({ session });
  } catch (error) {
    return failureResponse(error);
  }
}
