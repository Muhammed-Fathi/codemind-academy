import { getServerT } from "@/lib/i18n-server";
// GET /api/teacher/dashboard
// Returns teacher's groups (with students + per-group stats),
// upcoming sessions (next 7 days), recent activity (last 5 graded
// homework + last 5 quiz attempts), and pending homework count.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getVideoProgressForStudents } from "@/lib/progress";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { lessonCourseChainOr, lessonCoursesChainOr } from "@/lib/session-progress";

export async function GET(_req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  // ---- Concurrent read plan --------------------------------------------
  // Every read below depends only on `teacher` (already loaded), so all
  // chains run concurrently. On remote Postgres (Neon) each query is a
  // network round-trip: total latency becomes the slowest chain instead of
  // the sum of ~25 sequential queries. Query semantics are unchanged.

  // ---- Per-group enrichment -------------------------------------------
  const groupsPromise = Promise.all(
    teacher.groups.map(async (g) => {
      const studentIds = g.students.map((s) => s.id);

      // Wave 1: independent per-group reads. Video progress is one batched
      // service call for the whole group — no per-student N+1 lookups.
      const [groupVideoProgress, sessions, quizAttempts, courseLessons] =
        await Promise.all([
          getVideoProgressForStudents(studentIds),
          db.liveSession.findMany({
            where: { groupId: g.id },
            select: {
              id: true,
              startAt: true,
              status: true,
              title: true,
              titleAr: true,
            },
          }),
          studentIds.length
            ? db.quizAttempt.findMany({
                where: { studentId: { in: studentIds } },
                select: { percentage: true },
              })
            : Promise.resolve([] as { percentage: number }[]),
          db.lesson.findMany({
            where: { OR: lessonCourseChainOr(g.courseId) },
            select: { id: true },
          }),
        ]);

      // Next session date for this group — derived in JS from `sessions`
      // (same filter/order the previous findFirst used; saves one query
      // per group).
      const nowMs = Date.now();
      const nextSession =
        sessions
          .filter((s) => s.startAt.getTime() >= nowMs)
          .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0] ||
        null;

      // Wave 2: reads that depend on wave-1 ids.
      const sessionIds = sessions.map((s) => s.id);
      const lessonIds = courseLessons.map((l) => l.id);
      const [attendanceRows, homeworks] = await Promise.all([
        studentIds.length
          ? db.attendance.findMany({
              where: { sessionId: { in: sessionIds } },
            })
          : Promise.resolve([]),
        lessonIds.length
          ? db.homework.findMany({
              where: { lessonId: { in: lessonIds } },
              select: { id: true },
            })
          : Promise.resolve([] as { id: string }[]),
      ]);

      // Attendance % across the group's students in this group's sessions
      const presentCount = attendanceRows.filter(
        (a) => a.status === "PRESENT" || a.status === "LATE"
      ).length;
      const attendancePct =
        attendanceRows.length > 0
          ? Math.round((presentCount / attendanceRows.length) * 100)
          : 0;

      // Avg quiz score across this group's students
      const avgQuizScore =
        quizAttempts.length > 0
          ? Math.round(
              quizAttempts.reduce((s, a) => s + a.percentage, 0) /
                quizAttempts.length
            )
          : 0;

      // Pending homework count: homeworks in this course's lessons that
      // have submissions still in PENDING or SUBMITTED status. Both chains
      // (official lessons are unit-linked); no archived exclusion — a pending
      // legacy submission still needs grading.
      const homeworkIds = homeworks.map((h) => h.id);
      const pendingSubmissions = homeworkIds.length
        ? await db.homeworkSubmission.count({
            where: {
              homeworkId: { in: homeworkIds },
              status: { in: ["PENDING", "SUBMITTED"] },
            },
          })
        : 0;

      return {
        id: g.id,
        name: g.name,
        schedule: g.schedule,
        capacity: g.capacity,
        courseId: g.courseId,
        course: g.course
          ? {
              id: g.course.id,
              slug: g.course.slug,
              name: g.course.name,
              nameAr: g.course.nameAr,
              color: g.course.color,
            }
          : null,
        studentsCount: g.students.length,
        students: g.students.map((s: any) => ({
          id: s.id,
          name: s.user.name,
          email: s.user.email,
          avatarUrl: s.user.avatarUrl,
          grade: s.grade,
          studentCode: s.studentCode ?? null,
          schoolType: s.schoolType ?? null,
          // Same shared progress service used by Admin & Parent dashboards.
          videoProgress: groupVideoProgress.get(s.id) || null,
        })),
        stats: {
          attendancePct,
          avgQuizScore,
          pendingHomework: pendingSubmissions,
          totalSessions: sessions.length,
        },
        nextSession: nextSession
          ? {
              id: nextSession.id,
              startAt: nextSession.startAt,
              title: nextSession.titleAr || nextSession.title,
            }
          : null,
      };
    })
  );

  // ---- Upcoming sessions (next 7 days across all teacher groups) ----
  const teacherGroupIds = teacher.groups.map((g) => g.id);
  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);
  const upcomingPromise = teacherGroupIds.length
    ? db.liveSession.findMany({
        where: {
          groupId: { in: teacherGroupIds },
          startAt: { gte: new Date(), lte: weekAhead },
          status: { in: ["SCHEDULED", "LIVE"] },
        },
        orderBy: { startAt: "asc" },
        include: {
          group: { select: { id: true, name: true } },
          lesson: { select: { id: true, title: true, titleAr: true } },
        },
        take: 20,
      })
    : Promise.resolve([]);

  // ---- Recent activity: last 5 graded homework + last 5 quiz attempts ----
  const allStudentIds = teacher.groups.flatMap((g) =>
    g.students.map((s) => s.id)
  );
  const recentSubsPromise = allStudentIds.length
    ? db.homeworkSubmission.findMany({
        where: {
          studentId: { in: allStudentIds },
          status: "GRADED",
        },
        orderBy: { id: "desc" },
        take: 5,
        include: {
          student: { include: { user: { select: { name: true } } } },
          homework: { select: { id: true, title: true, titleAr: true } },
        },
      })
    : Promise.resolve([]);

  const recentAttemptsPromise = allStudentIds.length
    ? db.quizAttempt.findMany({
        where: { studentId: { in: allStudentIds } },
        orderBy: { startedAt: "desc" },
        take: 5,
        include: {
          student: { include: { user: { select: { name: true } } } },
          quiz: { select: { id: true, title: true, titleAr: true } },
        },
      })
    : Promise.resolve([]);

  // ---- Pending homework count across all groups ----
  const allCourseIds = teacher.groups.map((g) => g.courseId);
  const totalPendingPromise = (async () => {
    const allLessonsForTeacher = allCourseIds.length
      ? await db.lesson.findMany({
          where: { OR: lessonCoursesChainOr(allCourseIds) },
          select: { id: true },
        })
      : [];
    const allLessonIds = allLessonsForTeacher.map((l) => l.id);
    const allHomeworksForTeacher = allLessonIds.length
      ? await db.homework.findMany({
          where: { lessonId: { in: allLessonIds } },
          select: { id: true },
        })
      : [];
    const allHwIds = allHomeworksForTeacher.map((h) => h.id);
    return allHwIds.length
      ? db.homeworkSubmission.count({
          where: {
            homeworkId: { in: allHwIds },
            status: { in: ["PENDING", "SUBMITTED"] },
          },
        })
      : 0;
  })();

  const [groups, upcomingSessions, recentSubs, recentAttempts, totalPendingHomework] =
    await Promise.all([
      groupsPromise,
      upcomingPromise,
      recentSubsPromise,
      recentAttemptsPromise,
      totalPendingPromise,
    ]);

  const upcomingSessionsPayload = upcomingSessions.map((s) => ({
    id: s.id,
    title: s.titleAr || s.title,
    startAt: s.startAt,
    duration: s.duration,
    status: s.status,
    meetingUrl: s.meetingUrl,
    group: { id: s.group.id, name: s.group.name },
    lesson: s.lesson
      ? { id: s.lesson.id, title: s.lesson.titleAr || s.lesson.title }
      : null,
  }));

  type Activity = {
    type: "homework-graded" | "quiz-attempt";
    title: string;
    description: string;
    studentName: string;
    time: Date;
    kind: "good" | "neutral" | "warn";
  };
  const activities: Activity[] = [];
  for (const s of recentSubs) {
    activities.push({
      type: "homework-graded",
      title: `Homework: ${s.homework.titleAr || s.homework.title}`,
      description: tApi("api.164", { p1: s.grade ?? 0 }),
      studentName: s.student?.user?.name || tApi("api.165"),
      time: s.submittedAt || new Date(),
      kind: "good",
    });
  }
  for (const a of recentAttempts) {
    activities.push({
      type: "quiz-attempt",
      title: `Quiz: ${a.quiz.titleAr || a.quiz.title}`,
      description: `${a.percentage}% — ${a.passed ? tApi("api.166") : tApi("api.167")}`,
      studentName: a.student?.user?.name || tApi("api.165"),
      time: a.finishedAt || a.startedAt,
      kind: a.passed ? "good" : "warn",
    });
  }
  activities.sort((a, b) => b.time.getTime() - a.time.getTime());
  const recentActivity = activities.slice(0, 8).map((a) => ({
    ...a,
    time: a.time,
  }));

  return ok({
    teacher: {
      id: teacher.id,
      name: teacher.user.name,
      email: teacher.user.email,
      avatarUrl: teacher.user.avatarUrl,
      bio: teacher.bio,
      specialty: teacher.specialty,
    },
    groups,
    upcomingSessions: upcomingSessionsPayload,
    recentActivity,
    pendingHomeworkCount: totalPendingHomework,
  });
}
