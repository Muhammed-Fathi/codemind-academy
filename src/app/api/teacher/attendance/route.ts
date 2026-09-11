import { getServerT } from "@/lib/i18n-server";
// GET  /api/teacher/attendance?groupId=X&sessionId=Y
//   Returns students of the group + their attendance record for the
//   given session (if any).
// POST /api/teacher/attendance
//   body: { sessionId, attendance: [{studentId, status}] }
//   Upserts each Attendance record (relies on @@unique([studentId, sessionId])).
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import type { AttendanceStatus } from "@prisma/client";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";

const ALLOWED: AttendanceStatus[] = ["PRESENT", "ABSENT", "LATE", "EXCUSED"];

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

  if (!teacherGroupIds.includes(groupId))
    return err(tApi("api.156"), 403);

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
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const body = (await req.json().catch(() => ({} as Record<string, unknown>))) as Record<string, unknown>;
  const sessionId = String((body.sessionId as string) || "");
  const attendance: Array<{
    studentId: string;
    status: AttendanceStatus;
    note?: string;
  }> = Array.isArray(body.attendance) ? (body.attendance as Array<{ studentId: string; status: AttendanceStatus; note?: string }>) : [];

  if (!sessionId) return err(tApi("api.157"), 400);
  if (attendance.length === 0) return err(tApi("api.158"), 400);

  // Verify the session belongs to one of the teacher's groups
  const session = await db.liveSession.findUnique({
    where: { id: sessionId },
    select: { id: true, groupId: true },
  });
  if (!session) return err(tApi("api.159"), 404);
  const belongsToTeacher = teacher.groups.some(
    (g) => g.id === session.groupId
  );
  if (!belongsToTeacher) return err(tApi("api.160"), 403);

  // Validate each entry + verify student belongs to that group
  const validStudents = await db.student.findMany({
    where: { groupId: session.groupId },
    select: { id: true },
  });
  const validStudentIds = new Set(validStudents.map((s) => s.id));

  for (const entry of attendance) {
    if (!entry.studentId || !entry.status) {
      return err(tApi("api.161"), 400);
    }
    if (!ALLOWED.includes(entry.status)) {
      return err(tApi("api.162", { p1: entry.status }), 400);
    }
    if (!validStudentIds.has(entry.studentId)) {
      return err(tApi("api.163"), 403);
    }
  }

  // Upsert each record. Prisma's upsert can't use composite unique on SQLite
  // for find queries directly with where — use the @@unique constraint name.
  const results: Array<{
    studentId: string;
    sessionId: string;
    status: AttendanceStatus;
    note: string | null;
  }> = [];
  for (const entry of attendance) {
    const r = await db.attendance.upsert({
      where: {
        studentId_sessionId: {
          studentId: entry.studentId,
          sessionId,
        },
      },
      update: {
        status: entry.status,
        note: entry.note ?? null,
      },
      create: {
        studentId: entry.studentId,
        sessionId,
        status: entry.status,
        note: entry.note ?? null,
      },
    });
    results.push({
      studentId: r.studentId,
      sessionId: r.sessionId,
      status: r.status,
      note: r.note,
    });
  }

  // Summary
  const summary = {
    present: results.filter((r) => r.status === "PRESENT").length,
    absent: results.filter((r) => r.status === "ABSENT").length,
    late: results.filter((r) => r.status === "LATE").length,
    excused: results.filter((r) => r.status === "EXCUSED").length,
    total: results.length,
  };

  return ok({ saved: true, summary, attendance: results });
}
