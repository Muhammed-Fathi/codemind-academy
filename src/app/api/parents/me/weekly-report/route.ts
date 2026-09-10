import { getServerT, serverLocale } from "@/lib/i18n-server";
// CodeMind Academy — Parent Weekly Report API
// Returns a weekly summary of each LINKED child's activity (last 7 days).
// Scope is the server-side Parent → Student links; this route accepts no ids.
//
// Phase 7 rules: quiz stats count finished attempts only, attendance counts
// PRESENT + LATE as attended (the student definition), lesson completion is
// measured against the child's course, and the handler is read-only.
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getVideoProgressForStudents, getVideoProgressInRange } from "@/lib/progress";
import { EXCLUDE_ARCHIVED_LESSON, lessonCourseChainOr } from "@/lib/session-progress";
import { trackScopeWhere } from "@/lib/track-scope";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { fmtDate } from "@/lib/i18n-core";

export async function GET() {
  const tApi = await getServerT();
  const loc = await serverLocale();
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

  // Per-child curriculum universes.
  //
  // Phase 19: a child is measured against THEIR OWN course × schoolType —
  // never against the union of their siblings' tracks. The previous batched
  // query was keyed by courseId only and filtered by
  // `trackScopeInWhere(getParentTrackScopes(...))` — the UNION of every
  // linked child's track — so a parent with one ARABIC and one LANGUAGE
  // child saw BOTH children measured against SHARED+ARABIC+LANGUAGE lessons:
  // each kid's denominator silently counted sessions of a track that kid can
  // never open. The universe is now resolved per child with the SAME
  // predicate pair the child-scoped dashboards use (`trackScopeWhere` on the
  // child's own schoolType + the dual curriculum chain), completing the
  // "independently scoped by child id → course → track" contract.
  const weeklyUniverseByStudent = new Map<string, Set<string>>();
  for (const link of parent.children) {
    const s = link.student;
    const courseId = s.group?.courseId;
    if (!courseId) {
      weeklyUniverseByStudent.set(s.id, new Set());
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
    weeklyUniverseByStudent.set(s.id, new Set(rows.map((r) => r.id)));
  }

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
        day: fmtDate(d, loc, { weekday: "short" }),
        date: fmtDate(d, loc, { day: "numeric", month: "numeric" }),
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
    const presentAttendance = weeklyAttendance.filter(
      (a) => a.status === "PRESENT" || a.status === "LATE"
    ).length;

    // Best quiz score this week
    const bestQuiz = weeklyQuizAttempts.length > 0
      ? Math.max(...weeklyQuizAttempts.map((q) => q.percentage))
      : 0;

    // Average quiz score this week
    const avgQuiz = weeklyQuizAttempts.length > 0
      ? Math.round(weeklyQuizAttempts.reduce((sum, q) => sum + q.percentage, 0) / weeklyQuizAttempts.length)
      : 0;

    // Overall progress, measured against the child's OWN course × track
    // universe (same denominator the parent dashboard computes for this
    // child, not the count of progress rows that exist). Both sides are
    // restricted to that active universe so archived history or a sibling's
    // track cannot inflate the fraction.
    const weeklyUniverseIds =
      weeklyUniverseByStudent.get(s.id) || new Set<string>();
    const completedLessons = s.lessonProgress.filter(
      (lp) => lp.isCompleted && weeklyUniverseIds.has(lp.lessonId)
    ).length;
    const totalCourseLessons = weeklyUniverseIds.size;
    const completionPct =
      totalCourseLessons > 0
        ? Math.min(100, Math.round((completedLessons / totalCourseLessons) * 100))
        : 0;

    // Active days (days with any activity)
    const activeDays = dailyActivity.filter((d) => d.lessons > 0 || d.quizzes > 0 || d.homework > 0).length;

    return {
      studentId: s.id,
      name: s.user.name,
      course: s.group?.course?.nameAr || s.group?.course?.name || "",
      groupName: s.group?.name || "",
      weekRange: {
        from: fmtDate(weekAgo, loc, { day: "numeric", month: "long" }),
        to: fmtDate(now, loc, { day: "numeric", month: "long" }),
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
        date: qa.finishedAt ? fmtDate(qa.finishedAt, loc) : "",
      })),
      recentHomework: weeklyHomework.slice(0, 5).map((hw) => ({
        title: hw.homework?.titleAr || hw.homework?.title || "Homework",
        status: hw.status,
        grade: hw.grade,
        date: hw.submittedAt ? fmtDate(hw.submittedAt, loc) : "",
      })),
    };
  });

  return ok({ reports: weeklyReports });
}
