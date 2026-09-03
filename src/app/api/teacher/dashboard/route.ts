// GET /api/teacher/dashboard
// Returns teacher's groups (with students + per-group stats),
// upcoming sessions (next 7 days), recent activity (last 5 graded
// homework + last 5 quiz attempts), and pending homework count.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";

export async function GET(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  // ---- Per-group enrichment -------------------------------------------
  const groups = await Promise.all(
    teacher.groups.map(async (g) => {
      const studentIds = g.students.map((s) => s.id);

      // Attendance % across the group's students in this group's sessions
      const sessions = await db.liveSession.findMany({
        where: { groupId: g.id },
        select: { id: true, startAt: true, status: true },
      });
      const sessionIds = sessions.map((s) => s.id);
      const attendanceRows = studentIds.length
        ? await db.attendance.findMany({
            where: { sessionId: { in: sessionIds } },
          })
        : [];
      const presentCount = attendanceRows.filter(
        (a) => a.status === "PRESENT" || a.status === "LATE"
      ).length;
      const attendancePct =
        attendanceRows.length > 0
          ? Math.round((presentCount / attendanceRows.length) * 100)
          : 0;

      // Avg quiz score across this group's students
      const quizAttempts = studentIds.length
        ? await db.quizAttempt.findMany({
            where: { studentId: { in: studentIds } },
            select: { percentage: true },
          })
        : [];
      const avgQuizScore =
        quizAttempts.length > 0
          ? Math.round(
              quizAttempts.reduce((s, a) => s + a.percentage, 0) /
                quizAttempts.length
            )
          : 0;

      // Pending homework count: homeworks in this course's lessons that
      // have submissions still in PENDING or SUBMITTED status
      const courseLessons = await db.lesson.findMany({
        where: { topic: { unit: { part: { courseId: g.courseId } } } },
        select: { id: true },
      });
      const lessonIds = courseLessons.map((l) => l.id);
      const homeworks = lessonIds.length
        ? await db.homework.findMany({
            where: { lessonId: { in: lessonIds } },
            select: { id: true },
          })
        : [];
      const homeworkIds = homeworks.map((h) => h.id);
      const pendingSubmissions = homeworkIds.length
        ? await db.homeworkSubmission.count({
            where: {
              homeworkId: { in: homeworkIds },
              status: { in: ["PENDING", "SUBMITTED"] },
            },
          })
        : 0;

      // Next session date for this group
      const nextSession = await db.liveSession.findFirst({
        where: { groupId: g.id, startAt: { gte: new Date() } },
        orderBy: { startAt: "asc" },
        select: { id: true, startAt: true, titleAr: true, title: true },
      });

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
        students: g.students.map((s) => ({
          id: s.id,
          name: s.user.name,
          email: s.user.email,
          avatarUrl: s.user.avatarUrl,
          grade: s.grade,
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
  const upcomingSessions = teacherGroupIds.length
    ? await db.liveSession.findMany({
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
    : [];
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

  // ---- Recent activity: last 5 graded homework + last 5 quiz attempts ----
  const allStudentIds = teacher.groups.flatMap((g) =>
    g.students.map((s) => s.id)
  );
  const recentSubs = allStudentIds.length
    ? await db.homeworkSubmission.findMany({
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
    : [];

  const recentAttempts = allStudentIds.length
    ? await db.quizAttempt.findMany({
        where: { studentId: { in: allStudentIds } },
        orderBy: { startedAt: "desc" },
        take: 5,
        include: {
          student: { include: { user: { select: { name: true } } } },
          quiz: { select: { id: true, title: true, titleAr: true } },
        },
      })
    : [];

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
      description: `اتصحح — الدرجة ${s.grade ?? 0}/10`,
      studentName: s.student?.user?.name || "طالب",
      time: s.submittedAt || new Date(),
      kind: "good",
    });
  }
  for (const a of recentAttempts) {
    activities.push({
      type: "quiz-attempt",
      title: `Quiz: ${a.quiz.titleAr || a.quiz.title}`,
      description: `${a.percentage}% — ${a.passed ? "نجح" : "محتاج مراجعة"}`,
      studentName: a.student?.user?.name || "طالب",
      time: a.finishedAt || a.startedAt,
      kind: a.passed ? "good" : "warn",
    });
  }
  activities.sort((a, b) => b.time.getTime() - a.time.getTime());
  const recentActivity = activities.slice(0, 8).map((a) => ({
    ...a,
    time: a.time,
  }));

  // ---- Pending homework count across all groups ----
  const allCourseIds = teacher.groups.map((g) => g.courseId);
  const allLessonsForTeacher = allCourseIds.length
    ? await db.lesson.findMany({
        where: { topic: { unit: { part: { courseId: { in: allCourseIds } } } } },
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
  const totalPendingHomework = allHwIds.length
    ? await db.homeworkSubmission.count({
        where: {
          homeworkId: { in: allHwIds },
          status: { in: ["PENDING", "SUBMITTED"] },
        },
      })
    : 0;

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
