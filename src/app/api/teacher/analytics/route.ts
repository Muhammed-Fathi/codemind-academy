import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Teacher Analytics API
// Returns performance metrics for the teacher's groups and students.
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err(tApi("api.154"), 403);

  const teacher = await db.teacher.findUnique({
    where: { userId: user.id },
    include: {
      groups: {
        include: {
          course: true,
          students: {
            include: {
              user: { select: { name: true, email: true } },
              attendances: { select: { status: true } },
              quizAttempts: {
                select: { percentage: true, passed: true, finishedAt: true },
              },
              homeworkSubmits: {
                select: { status: true, grade: true },
              },
              lessonProgress: {
                select: { isCompleted: true },
              },
            },
          },
        },
      },
    },
  });
  if (!teacher) return err(tApi("api.155"), 404);

  // Compute per-group stats
  const groups = teacher.groups.map((g) => {
    const totalStudents = g.students.length;
    let totalAttendance = 0;
    let presentAttendance = 0;
    let totalQuizAttempts = 0;
    let passedQuizzes = 0;
    let totalQuizPct = 0;
    let totalHomework = 0;
    let gradedHomework = 0;
    let totalLessons = 0;
    let completedLessons = 0;

    const studentStats = g.students.map((s) => {
      const attendanceCount = s.attendances.length;
      const presentCount = s.attendances.filter((a) => a.status === "PRESENT").length;
      const quizCount = s.quizAttempts.length;
      const quizPassed = s.quizAttempts.filter((q) => q.passed).length;
      const avgPct = quizCount > 0
        ? Math.round(s.quizAttempts.reduce((sum, q) => sum + q.percentage, 0) / quizCount)
        : 0;
      const hwTotal = s.homeworkSubmits.length;
      const hwGraded = s.homeworkSubmits.filter((h) => h.status === "GRADED").length;
      const lessonTotal = s.lessonProgress.length;
      const lessonCompleted = s.lessonProgress.filter((l) => l.isCompleted).length;

      totalAttendance += attendanceCount;
      presentAttendance += presentCount;
      totalQuizAttempts += quizCount;
      passedQuizzes += quizPassed;
      totalQuizPct += avgPct;
      totalHomework += hwTotal;
      gradedHomework += hwGraded;
      totalLessons += lessonTotal;
      completedLessons += lessonCompleted;

      return {
        studentId: s.id,
        name: s.user.name,
        email: s.user.email,
        attendancePct: attendanceCount > 0 ? Math.round((presentCount / attendanceCount) * 100) : 0,
        quizAvg: avgPct,
        quizzesTaken: quizCount,
        quizzesPassed: quizPassed,
        homeworkGraded: hwGraded,
        homeworkTotal: hwTotal,
        lessonsCompleted: lessonCompleted,
        performanceScore: Math.round(
          (avgPct * 0.4) +
          (attendanceCount > 0 ? (presentCount / attendanceCount) * 100 * 0.3 : 0) +
          (hwTotal > 0 ? (hwGraded / hwTotal) * 100 * 0.3 : 0)
        ),
      };
    });

    // Sort students by performance score
    studentStats.sort((a, b) => b.performanceScore - a.performanceScore);

    return {
      groupId: g.id,
      groupName: g.name,
      courseName: g.course.nameAr || g.course.name,
      totalStudents,
      avgAttendance: totalAttendance > 0 ? Math.round((presentAttendance / totalAttendance) * 100) : 0,
      avgQuizScore: totalStudents > 0 ? Math.round(totalQuizPct / totalStudents) : 0,
      quizPassRate: totalQuizAttempts > 0 ? Math.round((passedQuizzes / totalQuizAttempts) * 100) : 0,
      homeworkCompletion: totalHomework > 0 ? Math.round((gradedHomework / totalHomework) * 100) : 0,
      avgLessonCompletion: totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0,
      topStudents: studentStats.slice(0, 3),
      strugglingStudents: studentStats.filter(s => s.performanceScore < 50).slice(0, 3),
      students: studentStats,
    };
  });

  // Overall stats
  const allStudents = groups.reduce((sum, g) => sum + g.totalStudents, 0);
  const overallAvgAttendance = groups.length > 0
    ? Math.round(groups.reduce((sum, g) => sum + g.avgAttendance, 0) / groups.length)
    : 0;
  const overallAvgQuiz = groups.length > 0
    ? Math.round(groups.reduce((sum, g) => sum + g.avgQuizScore, 0) / groups.length)
    : 0;
  const overallPassRate = groups.length > 0
    ? Math.round(groups.reduce((sum, g) => sum + g.quizPassRate, 0) / groups.length)
    : 0;

  return ok({
    overview: {
      totalGroups: groups.length,
      totalStudents: allStudents,
      avgAttendance: overallAvgAttendance,
      avgQuizScore: overallAvgQuiz,
      quizPassRate: overallPassRate,
    },
    groups,
  });
}
