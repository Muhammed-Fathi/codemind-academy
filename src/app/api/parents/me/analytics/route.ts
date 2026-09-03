// CodeMind Academy — Parent Analytics API
// Returns detailed analytics for parent's children with date-range support.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "PARENT") return err("Analytics متاحة لأولياء الأمور فقط", 403);

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
              },
              quizAttempts: {
                include: { quiz: { select: { titleAr: true, title: true } } },
              },
              homeworkSubmits: {
                include: { homework: { select: { titleAr: true, title: true } } },
              },
              lessonProgress: {
                include: { lesson: { select: { titleAr: true, title: true, topic: { select: { titleAr: true } } } } },
              },
            },
          },
        },
      },
    },
  });
  if (!parent) return err("ملف ولي الأمر غير موجود", 404);

  const childrenAnalytics = parent.children.map((link) => {
    const s = link.student;

    // Quiz performance trend (last 10 attempts)
    const quizTrend = s.quizAttempts
      .slice(-10)
      .map((qa) => ({
        title: qa.quiz?.titleAr || qa.quiz?.title || "Quiz",
        percentage: qa.percentage,
        passed: qa.passed,
        date: qa.finishedAt || qa.startedAt,
      }));

    // Attendance by month (last 6 months)
    const now = new Date();
    const attendanceByMonth: { month: string; pct: number; present: number; total: number }[] = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
      const monthAttendances = s.attendances.filter((a) => {
        const attDate = a.session?.startAt || a.createdAt;
        return attDate >= monthStart && attDate <= monthEnd;
      });
      const present = monthAttendances.filter((a) => a.status === "PRESENT").length;
      const total = monthAttendances.length;
      attendanceByMonth.push({
        month: d.toLocaleDateString("ar-EG", { month: "short" }),
        pct: total > 0 ? Math.round((present / total) * 100) : 0,
        present,
        total,
      });
    }

    // Subject strengths/weaknesses by topic
    const topicMap = new Map<string, { title: string; sumPct: number; count: number }>();
    s.quizAttempts.forEach((qa) => {
      const topicTitle = qa.quiz?.titleAr || qa.quiz?.title || "Unknown";
      const existing = topicMap.get(topicTitle) || { title: topicTitle, sumPct: 0, count: 0 };
      existing.sumPct += qa.percentage;
      existing.count += 1;
      topicMap.set(topicTitle, existing);
    });
    const topicStats = Array.from(topicMap.entries()).map(([_, v]) => ({
      title: v.title,
      avgPct: v.count > 0 ? Math.round(v.sumPct / v.count) : 0,
    }));
    topicStats.sort((a, b) => b.avgPct - a.avgPct);
    const strongTopics = topicStats.filter((t) => t.avgPct >= 60).slice(0, 3);
    const weakTopics = topicStats.filter((t) => t.avgPct < 60).slice(0, 3);

    // Lesson completion timeline
    const completedLessons = s.lessonProgress.filter((lp) => lp.isCompleted).length;
    const totalLessons = s.lessonProgress.length;
    const completionPct = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

    // Homework stats
    const hwSubmitted = s.homeworkSubmits.filter((h) => h.status !== "PENDING").length;
    const hwGraded = s.homeworkSubmits.filter((h) => h.status === "GRADED").length;
    const hwAvgGrade = s.homeworkSubmits
      .filter((h) => h.grade !== null)
      .reduce((sum, h, _, arr) => sum + (h.grade || 0) / arr.length, 0);

    return {
      studentId: s.id,
      name: s.user.name,
      email: s.user.email,
      course: s.group?.course?.nameAr || s.group?.course?.name || "",
      groupName: s.group?.name || "",
      quizTrend,
      attendanceByMonth,
      strongTopics,
      weakTopics,
      completionPct,
      completedLessons,
      totalLessons,
      homeworkSubmitted: hwSubmitted,
      homeworkGraded: hwGraded,
      homeworkAvgGrade: Math.round(hwAvgGrade * 10) / 10,
      totalQuizzes: s.quizAttempts.length,
      avgQuizPct: s.quizAttempts.length > 0
        ? Math.round(s.quizAttempts.reduce((sum, q) => sum + q.percentage, 0) / s.quizAttempts.length)
        : 0,
      attendancePct: s.attendances.length > 0
        ? Math.round((s.attendances.filter((a) => a.status === "PRESENT").length / s.attendances.length) * 100)
        : 0,
    };
  });

  return ok({ children: childrenAnalytics });
}
