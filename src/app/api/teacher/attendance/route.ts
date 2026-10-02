// GET  /api/teacher/attendance?groupId=X&sessionId=Y
//   Returns students of the group + their attendance record for the
//   given session (if any).
// POST /api/teacher/attendance
//   body: { sessionId, attendance: [{studentId, status}] }
//   Upserts each Attendance record (relies on @@unique([studentId, sessionId])).
//
// PHASE F — this endpoint is the LEGACY address of the teacher register. Its
// response keys are unchanged (the teacher workspace and
// scripts/verify-phase26d-teacher.mjs §F depend on them) but the WRITES now go
// through the one Phase F authority (`saveAttendance` in src/lib/live-sessions.ts):
//
//   * the roster is derived from `LiveSession.groupId → Group.students`;
//   * the attendance WINDOW and the LOCK are enforced SERVER-SIDE (before the
//     scheduled start, after the window closes, or after finalization the write
//     is refused with a stable code) — an old client cannot bypass the register
//     any more than the new UI can;
//   * every save is audited, and the response now reports the window, the lock
//     and the live counts so the UI never has to recompute them.
//
// The GET additionally reports the session state the Phase F UI needs
// (`session` block below); the pre-existing keys keep their exact meaning.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import type { AttendanceStatus } from "@prisma/client";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import {
  academicLevelParamOf,
  teacherGroupIdsOfLevel,
} from "@/lib/teacher-academic-level";
import { getServerT } from "@/lib/i18n-server";
import {
  loadSessionForTeacher,
  loadTeacherScope,
  loadSessionRoster,
  saveAttendance,
  toLiveSessionPayload,
} from "@/lib/live-sessions";
import { failureResponse, readBody } from "@/lib/live-session-api";
import { decideAttendanceWrite } from "@/lib/live-session-policy";

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);
  const teacherGroupIds = teacher.groups.map((g) => g.id);

  const url = new URL(req.url);
  const groupId = url.searchParams.get("groupId") || "";
  const sessionId = url.searchParams.get("sessionId") || "";

  if (!teacherGroupIds.includes(groupId)) return err(tApi("api.156"), 403);

  // Phase L manual-QA fix #4 — the optional academic-level separator is
  // enforced HERE too, not only in the picker: a request that pairs a group of
  // one level with `?academicLevel=` of the other is refused, so the filter can
  // never be used to reach data outside the level currently being viewed.
  const levelParam = academicLevelParamOf(req);
  if (!levelParam.ok) return err("Unknown academic level", 400);
  if (levelParam.level) {
    const scoped = await teacherGroupIdsOfLevel(teacher, levelParam.level);
    if (!scoped || !scoped.has(groupId)) return err(tApi("api.156"), 403);
  }

  // Sessions for this group (upcoming + past)
  const sessions = await db.liveSession.findMany({
    where: { groupId },
    orderBy: { startAt: "desc" },
    select: {
      id: true,
      title: true,
      titleAr: true,
      startAt: true,
      duration: true,
      status: true,
    },
  });

  const students = await db.student.findMany({
    where: { groupId },
    include: { user: { select: { name: true, email: true, avatarUrl: true } } },
    orderBy: { user: { name: "asc" } },
  });

  // If sessionId is provided, return each student's existing attendance record
  let attendanceRecords: {
    studentId: string;
    status: AttendanceStatus | null;
    note: string | null;
  }[] = [];
  if (sessionId) {
    const rows = (await db.attendance.findMany({
      where: { sessionId },
      select: { studentId: true, status: true, note: true },
    }) as Array<{ studentId: string; status: AttendanceStatus; note: string | null }>);
    const map = new Map<string, { studentId: string; status: AttendanceStatus; note: string | null }>(rows.map((r) => [r.studentId, r]));
    attendanceRecords = students.map((s) => {
      const r = map.get(s.id);
      return { studentId: s.id, status: r?.status ?? null, note: r?.note ?? null };
    });
  }

  // Also compute per-student overall attendance % across this group's sessions
  const allSessionsOfGroup = sessions.map((s) => s.id);
  const allAttendanceRows = allSessionsOfGroup.length
    ? await db.attendance.findMany({
        where: { sessionId: { in: allSessionsOfGroup } },
        select: { studentId: true, status: true },
      })
    : [];
  const perStudent = new Map<
    string,
    { total: number; present: number }
  >();
  for (const r of allAttendanceRows) {
    const entry = perStudent.get(r.studentId) || { total: 0, present: 0 };
    entry.total += 1;
    if (r.status === "PRESENT" || r.status === "LATE") entry.present += 1;
    perStudent.set(r.studentId, entry);
  }

  const studentsPayload = students.map((s: any) => {
    const att = attendanceRecords.find((a) => a.studentId === s.id);
    const stats = perStudent.get(s.id) || { total: 0, present: 0 };
    return {
      id: s.id,
      name: s.user.name,
      email: s.user.email,
      avatarUrl: s.user.avatarUrl,
      grade: s.grade,
      studentCode: s.studentCode ?? null,
      status: att?.status ?? null,
      note: att?.note ?? null,
      attendancePct:
        stats.total > 0 ? Math.round((stats.present / stats.total) * 100) : 0,
      attendanceTotal: stats.total,
    };
  });

  // Phase F — the session block: window, lock, counts and review state.
  let sessionBlock: Record<string, unknown> | null = null;
  if (sessionId) {
    try {
      const scope = await loadTeacherScope(user.id);
      if (scope) {
        const access = await loadSessionForTeacher(scope, sessionId);
        const write = decideAttendanceWrite(access.session, new Date());
        const { counts } = await loadSessionRoster(sessionId);
        sessionBlock = {
          ...toLiveSessionPayload({ session: access.session, now: new Date(), counts }),
          canWrite: write.allowed,
          writeDenialCode: write.allowed ? null : write.code,
          via: access.via,
        };
      }
    } catch {
      // The legacy payload must keep working even if the session vanished.
      sessionBlock = null;
    }
  }

  return ok({
    group: {
      id: groupId,
      name: teacher.groups.find((g) => g.id === groupId)?.name || "",
      schedule: teacher.groups.find((g) => g.id === groupId)?.schedule || "",
    },
    sessions: sessions.map((s) => ({
      id: s.id,
      title: s.titleAr || s.title,
      startAt: s.startAt,
      duration: s.duration,
      status: s.status,
      isPast: s.startAt.getTime() < Date.now(),
    })),
    students: studentsPayload,
    session: sessionBlock,
  });
}

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const body = await readBody(req);
  const sessionId = String((body.sessionId as string) || "");
  const attendance: Array<{
    studentId: string;
    status: AttendanceStatus;
    note?: string;
  }> = Array.isArray(body.attendance) ? (body.attendance as Array<{ studentId: string; status: AttendanceStatus; note?: string }>) : [];

  if (!sessionId) {
    const tApi = await getServerT();
    return err(tApi("api.157"), 400);
  }
  if (attendance.length === 0) {
    const tApi = await getServerT();
    return err(tApi("api.158"), 400);
  }

  try {
    const scope = await loadTeacherScope(user.id);
    if (!scope) return err("Teacher profile not found", 404);
    // Authorizes the session (own group or a session this teacher covers) and
    // yields the same 403/404 rules as the Phase F register route.
    await loadSessionForTeacher(scope, sessionId);

    const result = await saveAttendance({
      sessionId,
      actorUserId: user.id,
      entries: attendance.map((entry) => ({
        studentId: String(entry.studentId),
        status: entry.status,
        note: entry.note ?? null,
      })),
    });

    const { rows } = await loadSessionRoster(sessionId);
    const summary = {
      present: rows.filter((r) => r.status === "PRESENT").length,
      absent: rows.filter((r) => r.status === "ABSENT").length,
      late: rows.filter((r) => r.status === "LATE").length,
      excused: rows.filter((r) => r.status === "EXCUSED").length,
      total: rows.length,
    };

    return ok({
      saved: true,
      summary,
      attendance: rows
        .filter((r) => r.rawStatus !== null)
        .map((r) => ({ studentId: r.studentId, sessionId, status: r.rawStatus, note: r.note })),
      // Phase F additions (additive: the legacy keys above are unchanged).
      counts: result.counts,
      closesAt: result.closesAt,
      unmarked: result.counts.unmarked,
    });
  } catch (error) {
    return failureResponse(error);
  }
}
