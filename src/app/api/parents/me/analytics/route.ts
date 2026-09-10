import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Parent Analytics API
// Returns detailed analytics for parent's children with date-range support.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { EXCLUDE_ARCHIVED_LESSON, lessonCourseChainOr } from "@/lib/session-progress";
import { trackScopeWhere } from "@/lib/track-scope";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";

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
                include: {
                  quiz: {
                    select: {
                      titleAr: true,
                      title: true,
                      // Phase 19: strong/weak grouping reads the canonical
                      // curriculum container (topic for legacy, unit for
                      // official) instead of the quiz title.
                      lesson: {
                        select: {
                          topic: { select: { titleAr: true, title: true } },
                          unit: { select: { titleAr: true, title: true } },
                        },
                      },
                    },
                  },
                },
              },
              homeworkSubmits: {
                include: { homework: { select: { titleAr: true, title: true } } },
              },
              lessonProgress: {
                include: {
                  lesson: {
                    select: {
                      titleAr: true,
                      title: true,
                      // Phase 19: canonical chain first — official lessons are
                      // unit-linked, so the unit title must ride along or the
                      // analytics of an official lesson render empty.
                      topic: { select: { titleAr: true, title: true } },
                      unit: { select: { titleAr: true, title: true } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!parent) return err(tApi("api.099"), 404);

  // Per-child curriculum universes.
  //
  // Phase 19: each child is measured against THEIR OWN course × schoolType —
  // never against the UNION of every linked child's track. The old batched
  // query keyed by courseId only and filtered by
  // `trackScopeInWhere(getParentTrackScopes(...))`, so a parent with one
  // ARABIC and one LANGUAGE child saw both children measured against
  // SHARED+ARABIC+LANGUAGE — each kid's denominator silently counted sessions
  // of a track that kid can never open. The universe is now resolved per
  // child with the SAME predicate pair the child-scoped dashboards use
  // (`trackScopeWhere` on the child's own schoolType + the dual curriculum
  // chain) — the "independently scoped by child id → course → track"
  // contract, applied to every derived number below.
  const analyticsUniverseByStudent = new Map<string, Set<string>>();
  for (const link of parent.children) {
    const s = link.student;
    const courseId = s.group?.courseId;
    if (!courseId) {
      analyticsUniverseByStudent.set(s.id, new Set());
      continue;
    }
    // Phase 13: the report denominator is the child's curriculum, so it
    // requires PUBLISHED exactly like the student universe does — a staged
    // session must neither be counted nor named. Replaces the legacy
    // `isPublished` flag, which no longer gates anything.
    const rows = await db.lesson.findMany({
      where: {
        ...LESSON_STUDENT_STATUS_FILTER,
        ...EXCLUDE_ARCHIVED_LESSON,
        ...trackScopeWhere(s.schoolType),
        OR: lessonCourseChainOr(courseId),
      },
      select: { id: true },
    });
    analyticsUniverseByStudent.set(s.id, new Set(rows.map((r) => r.id)));
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

    // Subject strengths/weaknesses — Phase 19: grouped by the quiz's
    // CURRICULUM CONTAINER, canonical chain first (topic for legacy rows,
    // unit for official unit-linked lessons). The old code grouped by the
    // quiz TITLE, so a child with two quizzes on the same unit appeared to
    // have two unrelated "topics", and the result could never line up with
    // the curriculum the rest of the report measures.
    const topicMap = new Map<string, { title: string; sumPct: number; count: number }>();
    s.quizAttempts.forEach((qa) => {
      const container = qa.quiz?.lesson?.topic ?? qa.quiz?.lesson?.unit;
      const topicTitle =
        container?.titleAr || container?.title || qa.quiz?.titleAr || qa.quiz?.title || "Unknown";
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

    // Lesson completion against the child's OWN course × track universe (a
    // student who opened one lesson and finished it is not "100% complete" —
    // the denominator is the child's curriculum, exactly as on the parent
    // dashboard). Both sides are restricted to that active universe so
    // archived history or a sibling's track cannot inflate the fraction.
    const analyticsUniverseIds =
      analyticsUniverseByStudent.get(s.id) || new Set<string>();
    const completedLessons = s.lessonProgress.filter(
      (lp) => lp.isCompleted && analyticsUniverseIds.has(lp.lessonId)
    ).length;
    const totalLessons = analyticsUniverseIds.size;
    const completionPct =
      totalLessons > 0
        ? Math.min(100, Math.round((completedLessons / totalLessons) * 100))
        : 0;

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
