import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Parent Weekly Report API
// Returns a weekly summary of the child's activity (last 7 days).
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getVideoProgressForStudents, getVideoProgressInRange } from "@/lib/progress";

export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "PARENT") return err(tApi("api.118"), 403);

  const parent = await db.parent.findUnique({
    where: { userId: user.id },
    include: {
      children: {
        include: {
          student: {
            include: {
              user: { select: { name: true, email: true } },
              group: { include: { course: true } },
              attendances: {
                include: { session: { select: { startAt: true, titleAr: true } } },
                orderBy: { createdAt: "desc" },
              },
              quizAttempts: {
                include: { quiz: { select: { titleAr: true, title: true } } },
                orderBy: { finishedAt: "desc" },
              },
              homeworkSubmits: {
                include: { homework: { select: { titleAr: true, title: true, lesson: { select: { titleAr: true } } } } },
                orderBy: { submittedAt: "desc" },
              },
              lessonProgress: {
                include: { lesson: { select: { titleAr: true, title: true } } },
                orderBy: { lastViewedAt: "desc" },
              },
            },
          },
        },
      },
    },
  });
  if (!parent) return err(tApi("api.119"), 404);

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Batched, from the SHARED progress service (same numbers as the dashboards).
  const childIds = parent.children.map((l) => l.student.id);
  const overallVideoProgress = await getVideoProgressForStudents(childIds);
  const weeklyVideoByStudent = new Map(
    await Promise.all(
      childIds.map(
        async (sid) =>
          [sid, await getVideoProgressInRange(sid, weekAgo, now)] as const
      )
    )
  );

  const weeklyReports = parent.children.map((link) => {
    const s = link.student;

    // Filter activity from last 7 days
    const weeklyQuizAttempts = s.quizAttempts.filter(
      (qa) => qa.finishedAt && qa.finishedAt >= weekAgo
    );
    const weeklyHomework = s.homeworkSubmits.filter(
      (hw) => hw.submittedAt && hw.submittedAt >= weekAgo
    );
    const weeklyLessons = s.lessonProgress.filter(
      (lp) => lp.lastViewedAt && lp.lastViewedAt >= weekAgo
    );
    const weeklyAttendance = s.attendances.filter(
      (a) => a.createdAt >= weekAgo
    );

    // Daily activity breakdown (last 7 days)
    const dailyActivity: { day: string; date: string; lessons: number; quizzes: number; homework: number; attendance: string | null }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
      const dayEnd = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

      const dayLessons = weeklyLessons.filter(
        (lp) => lp.lastViewedAt && lp.lastViewedAt >= dayStart && lp.lastViewedAt <= dayEnd
      ).length;
      const dayQuizzes = weeklyQuizAttempts.filter(
        (qa) => qa.finishedAt && qa.finishedAt >= dayStart && qa.finishedAt <= dayEnd
      ).length;
      const dayHomework = weeklyHomework.filter(
        (hw) => hw.submittedAt && hw.submittedAt >= dayStart && hw.submittedAt <= dayEnd
      ).length;
      const dayAttendance = s.attendances.find(
        (a) => {
          const attDate = a.session?.startAt || a.createdAt;
          return attDate >= dayStart && attDate <= dayEnd;
        }
      );

      dailyActivity.push({
        day: d.toLocaleDateString("ar-EG", { weekday: "short" }),
        date: d.toLocaleDateString("ar-EG", { day: "numeric", month: "numeric" }),
        lessons: dayLessons,
        quizzes: dayQuizzes,
        homework: dayHomework,
        attendance: dayAttendance?.status || null,
      });
    }

    // Weekly summary stats
    const totalLessons = weeklyLessons.length;
    const totalQuizzes = weeklyQuizAttempts.length;
    const totalHomework = weeklyHomework.length;
    const totalAttendance = weeklyAttendance.length;
    const presentAttendance = weeklyAttendance.filter((a) => a.status === "PRESENT").length;

    // Best quiz score this week
    const bestQuiz = weeklyQuizAttempts.length > 0
      ? Math.max(...weeklyQuizAttempts.map((q) => q.percentage))
      : 0;

    // Average quiz score this week
    const avgQuiz = weeklyQuizAttempts.length > 0
      ? Math.round(weeklyQuizAttempts.reduce((sum, q) => sum + q.percentage, 0) / weeklyQuizAttempts.length)
      : 0;

    // Overall progress
    const completedLessons = s.lessonProgress.filter((lp) => lp.isCompleted).length;
    const totalCourseLessons = s.lessonProgress.length;
    const completionPct = totalCourseLessons > 0 ? Math.round((completedLessons / totalCourseLessons) * 100) : 0;

    // Active days (days with any activity)
    const activeDays = dailyActivity.filter((d) => d.lessons > 0 || d.quizzes > 0 || d.homework > 0).length;

    return {
      studentId: s.id,
      name: s.user.name,
      course: s.group?.course?.nameAr || s.group?.course?.name || "",
      groupName: s.group?.name || "",
      weekRange: {
        from: weekAgo.toLocaleDateString("ar-EG", { day: "numeric", month: "long" }),
        to: now.toLocaleDateString("ar-EG", { day: "numeric", month: "long" }),
      },
      summary: {
        lessonsViewed: totalLessons,
        quizzesTaken: totalQuizzes,
        homeworkSubmitted: totalHomework,
        attendanceSessions: totalAttendance,
        attendancePct: totalAttendance > 0 ? Math.round((presentAttendance / totalAttendance) * 100) : 0,
        bestQuizScore: bestQuiz,
        avgQuizScore: avgQuiz,
        activeDays,
        completionPct,
      },
      // --- Video progress (weekly window + overall) ---
      videoProgress: {
        week: weeklyVideoByStudent.get(s.id) || {
          videosWatched: 0,
          videosCompleted: 0,
          watchedMinutes: 0,
        },
        overall: overallVideoProgress.get(s.id) || null,
      },
      dailyActivity,
      recentQuizzes: weeklyQuizAttempts.slice(0, 5).map((qa) => ({
        title: qa.quiz?.titleAr || qa.quiz?.title || "Quiz",
        percentage: qa.percentage,
        passed: qa.passed,
        date: qa.finishedAt?.toLocaleDateString("ar-EG") || "",
      })),
      recentHomework: weeklyHomework.slice(0, 5).map((hw) => ({
        title: hw.homework?.titleAr || hw.homework?.title || "Homework",
        status: hw.status,
        grade: hw.grade,
        date: hw.submittedAt?.toLocaleDateString("ar-EG") || "",
      })),
    };
  });

  return ok({ reports: weeklyReports });
}
