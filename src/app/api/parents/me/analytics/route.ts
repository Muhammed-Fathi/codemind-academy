import { getServerT, serverLocale } from "@/lib/i18n-server";
import { fmtDate } from "@/lib/i18n-core";
// CodeMind Academy — Parent Analytics API
// Returns detailed analytics for parent's children with date-range support.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import {
  attemptsInCurriculumUniverse,
  currentCourseAttendanceWhere,
  currentCourseIdOf,
  curriculumContainerOf,
  getStudentCurriculumHomeworkIds,
  getStudentCurriculumLessonIds,
} from "@/lib/parent-access";
// Phase I — the verified `?studentId=` contract (see the dashboard route):
// the id is read from the QUERY STRING only and re-checked against this
// parent's own ParentStudentLink rows on every request.
import {
  childAcademicLevel,
  loadCanonicalCourseProgress,
  readStudentIdParam,
} from "@/lib/parent-academics";

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  // Phase M4.5 — one locale-aware formatter for the month labels below.
  const loc = await serverLocale();
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
              // Phase M4.4 — `attendances` is deliberately NOT included here:
              // an `include` cannot be narrowed per child (its `where` cannot
              // read `student.group.courseId`), and this route must count the
              // sessions of the child's CURRENT course only. Each child's rows
              // are read in the per-child block below with the SHARED
              // `currentCourseAttendanceWhere` predicate — the exact rule the
              // dashboard uses, so the two screens cannot disagree (M4-F2).
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
                      // curriculum container instead of the quiz title; the
                      // Unit is primary and the legacy Topic is the fallback
                      // (M4.4 — see `curriculumContainerOf`).
                      // Phase M4.4 — the container's ID travels with its
                      // titles: strong/weak rows are keyed by canonical
                      // curriculum identity, never by the display title (the
                      // two curricula reuse unit titles) — M4-F9.
                      lesson: {
                        select: {
                          topic: {
                            select: { id: true, titleAr: true, title: true },
                          },
                          unit: {
                            select: { id: true, titleAr: true, title: true },
                          },
                        },
                      },
                    },
                  },
                },
              },
              homeworkSubmits: {
                include: { homework: { select: { titleAr: true, title: true } } },
              },
              // Phase I: `lessonProgress` is deliberately NO LONGER included.
              // It existed only to recount completion from the legacy
              // `LessonProgress.isCompleted` sticky flag — a second completion
              // truth the Parent authority must not hold. Completion now comes
              // from the canonical Phase H engine alone (see below), so the
              // rows are not fetched at all: what is not fetched cannot be
              // silently reinstated as a fallback.
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

    // Phase M4.4 — the child's canonical current course and the attendance of
    // THAT course only (`Attendance → LiveSession → Group → Course`). Read with
    // the same shared predicate the dashboard uses; a child with no active
    // course matches nothing, so nothing is carried over from a previous one.
    const currentCourseId = currentCourseIdOf(s);
    const attendances = await db.attendance.findMany({
      where: { studentId: s.id, ...currentCourseAttendanceWhere(currentCourseId) },
      include: { session: { select: { startAt: true, titleAr: true } } },
      orderBy: { createdAt: "desc" },
    });

    // Quiz performance trend (last 10 FINISHED attempts, chronological).
    const quizTrend = quizAttempts
      .slice(0, 10)
      .reverse()
      .map((qa) => ({
        title:
          qa.quiz?.titleAr || qa.quiz?.title || tApi("api.quizFallback"),
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
      const monthAttendances = attendances.filter((a) => {
        const attDate = a.session?.startAt || a.createdAt;
        return attDate >= monthStart && attDate <= monthEnd;
      });
      const present = monthAttendances.filter((a) => attended(a.status)).length;
      const total = monthAttendances.length;
      attendanceByMonth.push({
        // Phase M4.5 — the SAME locale-aware formatter as the dashboard route
        // (one implementation, `fmtDate` in `i18n-core`), so the two parent
        // screens can no longer disagree about a month name in either language.
        month: fmtDate(d, loc, { month: "short" }),
        pct: total > 0 ? Math.round((present / total) * 100) : 0,
        present,
        total,
      });
    }

    // Subject strengths/weaknesses — Phase 19: grouped by the quiz's
    // CURRICULUM CONTAINER. The old code grouped by the quiz TITLE, so a child
    // with two quizzes on the same unit appeared to have two unrelated
    // "topics", and the result could never line up with the curriculum the rest
    // of the report measures.
    // Phase M4.4 — grouped by the container's CANONICAL ID through the shared
    // resolver (`curriculumContainerOf`: canonical `Unit` first, legacy `Topic`
    // only when no Unit exists), exactly like the dashboard. The old code keyed
    // this map by the display TITLE and dropped
    // the id from the payload, so two containers with the same title collapsed
    // into one row — and a container that had no title fell back to the QUIZ
    // title, inventing a third identity (M4-F9). Aggregation math is unchanged:
    // every finished in-universe attempt is still one data point.
    const topicMap = new Map<
      string,
      { title: string; titleAr: string; sumPct: number; count: number }
    >();
    quizAttempts.forEach((qa) => {
      const container = curriculumContainerOf(qa.quiz?.lesson);
      if (!container) return;
      const existing = topicMap.get(container.id) || {
        title: container.title,
        titleAr: container.titleAr,
        sumPct: 0,
        count: 0,
      };
      existing.sumPct += qa.percentage;
      existing.count += 1;
      topicMap.set(container.id, existing);
    });
    const topicStats = Array.from(topicMap.entries()).map(([id, v]) => ({
      // The canonical container id is the identity of the row; the level
      // context is the course the containers were measured in — this child's
      // current one, because the attempt set above is already course-scoped.
      id,
      title: v.titleAr || v.title,
      avgPct: v.count > 0 ? Math.round(v.sumPct / v.count) : 0,
      academicLevel: childAcademicLevel(s),
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
    // There is NO legacy fallback: a child with no valid active Enrollment /
    // course academic context reports the explicit `NO_ACTIVE_COURSE` state
    // over an empty universe, never a `LessonProgress.isCompleted` recount and
    // never a fabricated canonical number.
    const canonical = await loadCanonicalCourseProgress(s.id, s.group?.courseId);
    const hasAcademicContext = canonical.state === "OK";
    const completedLessons = hasAcademicContext ? canonical.completed : 0;
    const totalLessons = hasAcademicContext ? canonical.total : 0;
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
      /**
       * Phase I — explicit academic-context state. `NO_ACTIVE_COURSE` means the
       * child has no valid active Enrollment / course: the numbers below
       * describe an EMPTY universe and are never legacy-derived.
       */
      academicContext: canonical.state,
      hasAcademicContext,
      /**
       * Phase M4.3 — the child's canonical Academic Level (course chain first,
       * then the assignment). The child TAB is labelled with it so two children
       * in the two levels stay distinguishable even when their course display
       * name is identical. `s.id` above remains the identity.
       */
      academicLevel: childAcademicLevel(s),
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
      // Phase M4.4 — the SAME current-course attendance rows the dashboard
      // reports for this child (one shared predicate, one shared definition of
      // "attended": PRESENT + LATE).
      attendancePct: attendances.length > 0
        ? Math.round((attendances.filter((a) => attended(a.status)).length / attendances.length) * 100)
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
