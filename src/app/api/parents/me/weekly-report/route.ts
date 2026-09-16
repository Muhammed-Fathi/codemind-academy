import { getServerT, serverLocale } from "@/lib/i18n-server";
// CodeMind Academy — Parent Weekly Report API
// Returns a weekly summary of each LINKED child's activity (last 7 days).
// Scope is the server-side Parent → Student links; this route accepts no ids.
//
// Phase 7 rules: quiz stats count finished attempts only, attendance counts
// PRESENT + LATE as attended (the student definition), lesson completion is
// measured against the child's course, and the handler is read-only.
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getVideoProgressForStudents, getVideoProgressInRange } from "@/lib/progress";
import {
  attemptsInCurriculumUniverse,
  getStudentCurriculumHomeworkIds,
  getStudentCurriculumLessonIds,
} from "@/lib/parent-access";
import { fmtDate } from "@/lib/i18n-core";

/** When an attendance record happened: its session, else its creation. */
function attendanceAt(a: { createdAt: Date; session?: { startAt: Date | null } | null }): Date {
  return a.session?.startAt || a.createdAt;
}

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
                // `lessonId` rides along so the attempt set can be cut to the
                // child's own curriculum universe (Phase 26E).
                include: {
                  quiz: { select: { lessonId: true, titleAr: true, title: true } },
                },
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
  // Phase 26E: the predicate now lives in ONE place
  // (`getStudentCurriculumLessonIds`, shared with the dashboard and the
  // analytics route). Phase 13's PUBLISHED clause and Phase 11's archived
  // exclusion are inside the helper — a staged session must neither be
  // counted nor named.
  const weeklyUniverseByStudent = new Map<string, Set<string>>();
  const weeklyHomeworkUniverseByStudent = new Map<string, Set<string>>();
  for (const link of parent.children) {
    weeklyUniverseByStudent.set(
      link.student.id,
      await getStudentCurriculumLessonIds(link.student.id)
    );
    weeklyHomeworkUniverseByStudent.set(
      link.student.id,
      await getStudentCurriculumHomeworkIds(link.student.id)
    );
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

    // Phase 26E: quiz activity is reported only for the child's own active
    // curriculum (PUBLISHED, non-archived, child's course, child's track) —
    // the same universe the completion denominator uses, so "best quiz this
    // week" can never be an attempt on an archived, staged or out-of-track
    // lesson. Retry history is preserved: every finished in-universe attempt
    // in the window is one data point (Phase 26D).
    const childUniverse = weeklyUniverseByStudent.get(s.id) || new Set<string>();
    const inUniverseQuizAttempts = attemptsInCurriculumUniverse(
      s.quizAttempts,
      childUniverse
    );

    // Filter activity from last 7 days
    const weeklyQuizAttempts = inUniverseQuizAttempts.filter(
      (qa) => qa.finishedAt && qa.finishedAt >= weekAgo
    );
    // Phase 26E: the WEEK's activity is cut to the child's own universe on the
    // same terms as the week's denominator. `completionPct` below was already
    // universe-restricted, but the activity counters and the daily breakdown
    // were not — a progress row left on an archived, staged or other-track
    // lesson (or a submission on such an assignment) was reported as "this
    // week's" work and named curriculum the child cannot open, while the
    // percentage silently excluded it. One universe, every number.
    const childHomeworkUniverse =
      weeklyHomeworkUniverseByStudent.get(s.id) || new Set<string>();
    const weeklyHomework = s.homeworkSubmits.filter(
      (hw) =>
        hw.submittedAt &&
        hw.submittedAt >= weekAgo &&
        childHomeworkUniverse.has(hw.homeworkId)
    );
    const weeklyLessons = s.lessonProgress.filter(
      (lp) =>
        lp.lastViewedAt &&
        lp.lastViewedAt >= weekAgo &&
        childUniverse.has(lp.lessonId)
    );
    // The window is judged on WHEN THE CLASS HAPPENED (`session.startAt`, the
    // same basis the dashboard's monthly buckets, the analytics route and the
    // daily breakdown below use) — never on the row's insertion time, which
    // can predate or postdate the session and would make the weekly total
    // disagree with the daily activity it summarises.
    const weeklyAttendance = s.attendances.filter(
      (a) => attendanceAt(a) >= weekAgo
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
          const attDate = attendanceAt(a);
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
    const weeklyUniverseIds = childUniverse;
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
