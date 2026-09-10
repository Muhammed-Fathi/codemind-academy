import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Parent Analytics API
// Returns detailed analytics for parent's children with date-range support.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { EXCLUDE_ARCHIVED_LESSON, lessonCoursesChainOr } from "@/lib/session-progress";
import { trackScopeInWhere } from "@/lib/track-scope";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { getParentTrackScopes } from "@/lib/parent-access";

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "PARENT") return err(tApi("api.098"), 403);

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
              // Finished only (Phase 6 rule), newest first — the trend below
              // takes the last 10 and re-orders them chronologically.
              quizAttempts: {
                where: { finishedAt: { not: null } },
                orderBy: { finishedAt: "desc" },
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
  if (!parent) return err(tApi("api.099"), 404);

  // Course lesson totals, one batched query for every linked child's course
  // (same universe as the parent dashboard: published lessons, both chains,
  // archived history excluded).
  // The `as string[]` is belt-and-braces: the type predicate above already
  // narrows to string[], but an un-generated Prisma client leaves the whole
  // chain untyped and would otherwise fail the helper's signature.
  const analyticsCourseIds = [
    ...new Set(
      parent.children
        .map((l) => l.student.group?.courseId)
        .filter((id): id is string => !!id)
    ),
  ] as string[];
  const analyticsLessonRows =
    analyticsCourseIds.length > 0
      ? await db.lesson.findMany({
          where: {
            // Phase 13: the report denominator is the child's curriculum, so
            // it requires PUBLISHED exactly like the student universe does —
            // a staged session must neither be counted nor named. Replaces the
            // legacy `isPublished` flag, which no longer gates anything.
            ...LESSON_STUDENT_STATUS_FILTER,
            ...EXCLUDE_ARCHIVED_LESSON,
            // Phase 12: a parent's analytics span their linked children, so the
            // universe is the UNION of those children's tracks (always plus
            // SHARED) — never a track none of their children belongs to.
            ...trackScopeInWhere(await getParentTrackScopes(user.id)),
            OR: lessonCoursesChainOr(analyticsCourseIds),
          },
          select: {
            id: true,
            unit: { select: { part: { select: { courseId: true } } } },
            topic: {
              select: { unit: { select: { part: { select: { courseId: true } } } } },
            },
          },
        })
      : [];
  const analyticsLessonTotalByCourse = new Map<string, number>();
  const analyticsLessonIdsByCourse = new Map<string, Set<string>>();
  for (const row of analyticsLessonRows) {
    const cid = row.unit?.part.courseId ?? row.topic?.unit.part.courseId;
    if (!cid) continue;
    analyticsLessonTotalByCourse.set(
      cid,
      (analyticsLessonTotalByCourse.get(cid) || 0) + 1
    );
    if (!analyticsLessonIdsByCourse.has(cid)) {
      analyticsLessonIdsByCourse.set(cid, new Set());
    }
    analyticsLessonIdsByCourse.get(cid)!.add(row.id);
  }

  const attended = (status: string) =>
    status === "PRESENT" || status === "LATE";

  const childrenAnalytics = parent.children.map((link) => {
    const s = link.student;

    // Quiz performance trend (last 10 FINISHED attempts, chronological).
    const quizTrend = s.quizAttempts
      .slice(0, 10)
      .reverse()
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
      const present = monthAttendances.filter((a) => attended(a.status)).length;
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

    // Lesson completion against the child's COURSE (a student who opened one
    // lesson and finished it is not "100% complete" — the denominator is the
    // course, exactly as on the parent dashboard). Both sides are restricted
    // to the active universe so archived history cannot inflate the fraction.
    const analyticsUniverseIds =
      (s.group?.courseId && analyticsLessonIdsByCourse.get(s.group.courseId)) ||
      new Set<string>();
    const completedLessons = s.lessonProgress.filter(
      (lp) => lp.isCompleted && analyticsUniverseIds.has(lp.lessonId)
    ).length;
    const totalLessons = s.group?.courseId
      ? analyticsLessonTotalByCourse.get(s.group.courseId) || 0
      : 0;
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
        ? Math.round((s.attendances.filter((a) => attended(a.status)).length / s.attendances.length) * 100)
        : 0,
    };
  });

  return ok({ children: childrenAnalytics });
}
