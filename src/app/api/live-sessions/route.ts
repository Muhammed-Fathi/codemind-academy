// CodeMind Academy — Phase F: THE live-session collection endpoint.
//
// GET  /api/live-sessions
//   The ONE upcoming/live-session authority per role. Every role reads the
//   SAME payload (src/lib/live-sessions.ts) and the audience is decided by the
//   actor's own rows, never by a query parameter:
//     ADMIN   → every session, with filters (group/teacher/status/date/search)
//     TEACHER → own groups + sessions they substitute, with filters + counts
//     STUDENT → own group's upcoming sessions (title/date/teacher/status/Join)
//     PARENT  → the same for each linked child (childId narrows to one)
//
// POST /api/live-sessions
//   Schedule a LiveSession (Admin anywhere; Teacher ONLY inside an assigned
//   group). `groupId`/`lessonId`/`startAt`/`duration`/`meetingUrl` are
//   re-validated against the database; a client-supplied `teacherId` is
//   ignored for teachers and verified for admins.

import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, requireUser } from "@/lib/api";
import {
  ApiFailure,
  adminActor,
  failureResponse,
  dateParam,
  intParam,
  readBody,
  requireTeacherActor,
} from "@/lib/live-session-api";
import {
  buildSessionDraft,
  createLiveSession,
  listSessionsForAdmin,
  listSessionsForTeacher,
  recentSessionsForStudent,
  upcomingForStudent,
} from "@/lib/live-sessions";
import { parentChildIds } from "@/lib/absence-review";
import type { TeacherScope } from "@/lib/live-sessions";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) throw new ApiFailure(401, "UNAUTHORIZED", "Unauthorized");
  const url = new URL(req.url);
  const now = new Date();
  const from = dateParam(url.searchParams.get("from"));
  const to = dateParam(url.searchParams.get("to"));
  const limit = intParam(url.searchParams.get("limit"), 30, 1, 200);
  const history = url.searchParams.get("history") === "1";

  try {
    if (user.role === "ADMIN") {
      const sessions = await listSessionsForAdmin({
        from,
        to,
        groupId: url.searchParams.get("groupId"),
        teacherId: url.searchParams.get("teacherId"),
        status: url.searchParams.get("status"),
        q: url.searchParams.get("q"),
        limit,
        now,
      });
      return ok({ sessions, scope: "admin" });
    }

    if (user.role === "TEACHER") {
      const actor = await requireTeacherActor(user);
      const sessions = await listSessionsForTeacher(actor.scope!, {
        from,
        to,
        groupId: url.searchParams.get("groupId"),
        limit,
        now,
      });
      return ok({
        sessions,
        scope: "teacher",
        // The teacher's own groups with labels — the schedule form never
        // offers a group that is not in the server-side scope.
        groups: actor.scope!.groups,
      });
    }

    if (user.role === "STUDENT") {
      const student = await db.student.findUnique({
        where: { userId: user.id },
        select: { id: true },
      });
      if (!student) throw new ApiFailure(404, "STUDENT_NOT_FOUND", "Student profile not found");
      return ok({
        sessions: history
          ? await recentSessionsForStudent(student.id, { limit, now })
          : await upcomingForStudent(student.id, { limit, now }),
        scope: "student",
      });
    }

    if (user.role === "PARENT") {
      const children = await parentChildIds(user.id);
      const childId = url.searchParams.get("childId");
      const target = childId && children.includes(childId) ? [childId] : children;
      if (target.length === 0) return ok({ sessions: [], children: [], scope: "parent" });
      const grouped = await Promise.all(
        target.map(async (id) => ({
          studentId: id,
          sessions: history
            ? await recentSessionsForStudent(id, { limit, now })
            : await upcomingForStudent(id, { limit, now }),
        }))
      );
      const links = await db.parentStudentLink.findMany({
        where: { parentId: user.id },
        select: { studentId: true, student: { select: { user: { select: { name: true } } } } },
      });
      return ok({
        children: links.map((l) => ({ id: l.studentId, name: l.student?.user?.name ?? "" })),
        groups: grouped,
        scope: "parent",
      });
    }

    throw new ApiFailure(403, "FORBIDDEN", "Forbidden");
  } catch (error) {
    return failureResponse(error);
  }
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await readBody(req);

  try {
    let actor: { role: "ADMIN" | "TEACHER"; userId: string; scope?: TeacherScope | null } | null = null;
    if (user.role === "ADMIN") actor = { userId: user.id, role: "ADMIN" };
    else if (user.role === "TEACHER") {
      const scoped = await requireTeacherActor(user);
      actor = { userId: scoped.userId, role: "TEACHER", scope: scoped.scope };
    }
    if (!actor) throw new ApiFailure(403, "NOT_AUTHORIZED", "Only an admin or a teacher may schedule a session");

    const draft = await buildSessionDraft({ body, actor });
    const result = await createLiveSession({
      draft,
      actor,
      teacherId: typeof body.teacherId === "string" ? body.teacherId : null,
    });
    return ok({ session: result.session, notifications: result.notifications }, { status: 201 });
  } catch (error) {
    return failureResponse(error);
  }
}
