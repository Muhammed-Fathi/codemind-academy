import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Parent Analytics API
// Returns detailed analytics for parent's children with date-range support.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import {
  attemptsInCurriculumUniverse,
  getStudentCurriculumHomeworkIds,
  getStudentCurriculumLessonIds,
} from "@/lib/parent-access";
// Phase I — the verified `?studentId=` contract (see the dashboard route):
// the id is read from the QUERY STRING only and re-checked against this
// parent's own ParentStudentLink rows on every request.
import {
  loadCanonicalCourseProgress,
  readStudentIdParam,
} from "@/lib/parent-academics";

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
                      // Phase 26E: the owning lesson id is what the child's
                      // curriculum cut is applied to (an attempt whose quiz
                      // lives outside the universe is not current progress).
                      lessonId: true,
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

  // ---- Phase I: `?studentId=` is verified, never trusted -------------------
  // An id that is not one of THIS parent's linked children is refused with 404
  // (never 403 — a 403 would confirm the child exists). Absent means "every
  // linked child", which stays server-derived.
  const requestedStudentId = readStudentIdParam(req);
  if (
    requestedStudentId &&
    !parent.children.some((link) => link.student.id === requestedStudentId)
  ) {
    return err(tApi("api.368"), 404);
  }

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
  // Phase 26E: the predicate now lives in ONE place
  // (`getStudentCurriculumLessonIds`), shared with the weekly report and the
  // dashboard, together with the homework universe the dashboard already
  // computes inline. Phase 13's PUBLISHED clause and Phase 11's archived
  // exclusion are inside the helper — a staged session must neither be counted
  // nor named.
  const analyticsUniverseByStudent = new Map<string, Set<string>>();
  const analyticsHomeworkUniverseByStudent = new Map<string, Set<string>>();
  for (const link of parent.children) {
    const s = link.student;
    analyticsUniverseByStudent.set(
      s.id,
      await getStudentCurriculumLessonIds(s.id)
    );
    analyticsHomeworkUniverseByStudent.set(
      s.id,
      await getStudentCurriculumHomeworkIds(s.id)
    );
  }

  const attended = (status: string) =>
    status === "PRESENT" || status === "LATE";

  // Phase I: the callback is async because it reads the canonical Phase H
  // completion count (one engine load per child, batched by Promise.all).
  const childrenAnalytics = await Promise.all(parent.children.map(async (link) => {
    const s = link.student;

    // Phase 26E: every quiz number below is computed over the child's OWN
    // universe. `quizTrend`, `totalQuizzes`, `avgQuizPct` and the strong/weak
    // containers used to walk the whole attempt table, so an attempt on an
    // archived session, a staged session, the other school type or a course
    // the child has left moved the parent's numbers and named curriculum the
    // child cannot open. Phase 26D semantics are preserved: this only removes
    // out-of-universe ROWS; every finished in-universe attempt (retries
    // included, each with its own `attemptNumber`) is still one data point.
    const childUniverse =
      analyticsUniverseByStudent.get(s.id) || new Set<string>();
    const quizAttempts = attemptsInCurriculumUniverse(
      s.quizAttempts,
      childUniverse
    );
    const homeworkSubmits = s.homeworkSubmits.filter((h) =>
      (analyticsHomeworkUniverseByStudent.get(s.id) || new Set<string>()).has(
        h.homeworkId
      )
    );

    // Quiz performance trend (last 10 FINISHED attempts, chronological).
    const quizTrend = quizAttempts
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
    quizAttempts.forEach((qa) => {
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
    const analyticsUniverseIds = childUniverse;
    // Phase I — the SAME canonical authority the dashboard and the academic
    // follow-up card read, so the parent screens can never disagree about the
    // same child. This used to be a third independent recount of the legacy
    // `LessonProgress.isCompleted` sticky flag, which the Phase H engine does
    // not trust (it ignores sequentiality, absence holds and overrides). The
    // count falls back to the legacy rows only when the engine cannot resolve
    // a course for this child (not enrolled / lapsed entitlement), in which
    // case the child has no universe and both agree on zero anyway.
    const canonical = await loadCanonicalCourseProgress(s.id, s.group?.courseId);
    const completedLessons =
      canonical?.completed ??
      s.lessonProgress.filter(
        (lp) => lp.isCompleted && analyticsUniverseIds.has(lp.lessonId)
      ).length;
    const totalLessons = canonical?.total ?? analyticsUniverseIds.size;
    const completionPct =
      totalLessons > 0
        ? Math.min(100, Math.round((completedLessons / totalLessons) * 100))
        : 0;

    // Homework stats — the SAME in-universe set the dashboard's `homework`
    // block reports, so the two parent screens can never disagree about the
    // same child (Phase 26E).
    const hwSubmitted = homeworkSubmits.filter((h) => h.status !== "PENDING").length;
    const hwGraded = homeworkSubmits.filter((h) => h.status === "GRADED").length;
    const hwAvgGrade = homeworkSubmits
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
      totalQuizzes: quizAttempts.length,
      avgQuizPct: quizAttempts.length > 0
        ? Math.round(quizAttempts.reduce((sum, q) => sum + q.percentage, 0) / quizAttempts.length)
        : 0,
      attendancePct: s.attendances.length > 0
        ? Math.round((s.attendances.filter((a) => attended(a.status)).length / s.attendances.length) * 100)
        : 0,
    };
  }));

  // A pinned child narrows the payload to that child alone.
  const scoped =
    requestedStudentId && childrenAnalytics.length > 0
      ? childrenAnalytics.filter((c) => c.studentId === requestedStudentId)
      : childrenAnalytics;

  return ok({ children: scoped, selectedStudentId: requestedStudentId ?? null });
}
