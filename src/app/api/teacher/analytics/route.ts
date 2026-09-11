import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Teacher Analytics API
// Returns performance metrics for the teacher's groups and students.
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import {
  TRACK_BUCKETS,
  attemptInQuizScope,
  summarizeFinishedAttemptsByTrack,
} from "@/lib/quiz-analytics";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import {
  EXCLUDE_ARCHIVED_LESSON,
  lessonCoursesChainOr,
} from "@/lib/session-progress";
import { canAccessTrackScope } from "@/lib/track-scope";

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
              // Phase 6: quiz analytics must reflect FINISHED attempts only —
              // an open attempt is ungraded (its stored percentage is still
              // the pre-submit default) and would deflate averages.
              quizAttempts: {
                where: { finishedAt: { not: null } },
                select: {
                  percentage: true,
                  passed: true,
                  finishedAt: true,
                  quizId: true,
                  // Phase 18 — read so the track split can reuse the Phase 6
                  // summary verbatim (it reports avgScore and participantCount,
                  // which need these). No existing number changes: these fields
                  // were previously projected away, never aggregated.
                  studentId: true,
                  score: true,
                  totalMarks: true,
                },
              },
              homeworkSubmits: {
                select: { status: true, grade: true },
              },
              lessonProgress: {
                // Phase 19: lessonId travels so completion can be measured
                // against the student's official curriculum universe instead
                // of raw history rows.
                select: { isCompleted: true, lessonId: true },
              },
            },
          },
        },
      },
    },
  });
  if (!teacher) return err(tApi("api.155"), 404);

  // Phase 6 authorization scope: a teacher may only ever see quiz attempts
  // that belong to quizzes on courses they actually teach. A student in the
  // teacher's group may carry historical attempts from a course taught by a
  // DIFFERENT teacher (e.g. after a group/course change); those must not leak
  // into this teacher's analytics. Resolve the quizzes of the teacher's
  // courses through BOTH curriculum chains (canonical unitId + legacy
  // topicId), the same universe rule the rest of the app uses.
  const courseIds = teacher.groups.map((g) => g.courseId);
  const authorizedQuizRows = await db.quiz.findMany({
    where: {
      lesson: {
        OR: [
          { unit: { part: { courseId: { in: courseIds } } } },
          { topic: { unit: { part: { courseId: { in: courseIds } } } } },
        ],
      },
    },
    // Phase 18 — the quiz's OWN trackScope travels with its id, so the same
    // authorized finished attempts can be SLICED by track without a second
    // authorization decision and without a second query.
    select: { id: true, trackScope: true },
  });
  const authorizedQuizIds = new Set<string>(authorizedQuizRows.map((q: { id: string }) => q.id));
  const quizTrackById = new Map(
    authorizedQuizRows.map((q) => [q.id, String(q.trackScope)])
  );
  // Every authorized, finished attempt the teacher may see, collected once so
  // the track split is computed over exactly the rows the rest of this handler
  // aggregates — no second filter, no chance of the split disagreeing.
  const allAuthorizedAttempts: Array<{
    quizId: string;
    studentId: string;
    score: number;
    totalMarks: number;
    percentage: number;
    passed: boolean;
    finishedAt: Date | null;
  }> = [];

  // Phase 19 — the lesson-completion universe. "Lessons completed" and the
  // group average used to run over each student's RAW LessonProgress rows:
  // every archived legacy lesson and every out-of-track lesson the student
  // ever touched moved the number, while official unit-linked lessons simply
  // never had a row and were invisible. The teacher now measures exactly the
  // student's own curriculum — PUBLISHED, non-archived lessons of the GROUP's
  // course (dual chain), sliced to the STUDENT's track — the same universe
  // rule the student dashboard, the certificate and the parent reports apply.
  const universeLessonRows = courseIds.length
    ? await db.lesson.findMany({
        where: {
          ...LESSON_STUDENT_STATUS_FILTER,
          ...EXCLUDE_ARCHIVED_LESSON,
          OR: lessonCoursesChainOr(courseIds),
        },
        select: {
          id: true,
          trackScope: true,
          unit: { select: { part: { select: { courseId: true } } } },
          topic: {
            select: {
              unit: { select: { part: { select: { courseId: true } } } },
            },
          },
        },
      })
    : [];
  const universeLessonsByCourse = new Map<
    string,
    { id: string; trackScope: unknown }[]
  >();
  for (const row of universeLessonRows) {
    const cid = row.unit?.part.courseId ?? row.topic?.unit.part.courseId;
    if (!cid) continue;
    const arr = universeLessonsByCourse.get(cid) || [];
    arr.push({ id: row.id, trackScope: row.trackScope });
    universeLessonsByCourse.set(cid, arr);
  }

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
      for (const a of s.quizAttempts) {
        if (attemptInQuizScope(a, authorizedQuizIds)) allAuthorizedAttempts.push(a);
      }
      const attendanceCount = s.attendances.length;
      const presentCount = s.attendances.filter((a) => a.status === "PRESENT").length;
      // Quiz rows are finished (SQL filter above); restrict further to the
      // teacher's own courses so cross-course history cannot be aggregated in.
      const quizAttempts = s.quizAttempts.filter((q) =>
        attemptInQuizScope(q, authorizedQuizIds)
      );
      const quizCount = quizAttempts.length;
      const quizPassed = quizAttempts.filter((q) => q.passed).length;
      const avgPct = quizCount > 0
        ? Math.round(quizAttempts.reduce((sum, q) => sum + q.percentage, 0) / quizCount)
        : 0;
      const hwTotal = s.homeworkSubmits.length;
      const hwGraded = s.homeworkSubmits.filter((h) => h.status === "GRADED").length;
      // Phase 19: completion runs over the student's OWN curriculum universe
      // (their group's course, their track), never over raw progress rows —
      // archived legacy and out-of-track history can no longer move the
      // teacher's numbers.
      const studentUniverseIds = new Set<string>(
        (universeLessonsByCourse.get(g.courseId) || [])
          .filter((l) => canAccessTrackScope(s.schoolType, l.trackScope))
          .map((l: { id: string }) => l.id)
      );
      const lessonTotal = studentUniverseIds.size;
      const lessonCompleted = s.lessonProgress.filter(
        (l) => l.isCompleted && studentUniverseIds.has(l.lessonId)
      ).length;

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

    // Phase 18 — minimal track-aware reporting: the SAME finished-only,
    // attempt-weighted Phase 6 summary, cut by the track of the quiz each
    // attempt belongs to. Buckets keep their deterministic SHARED → ARABIC →
    // LANGUAGE order and always exist, so the shape never changes shape.
    const groupAttempts = g.students.flatMap((s) =>
      s.quizAttempts.filter((a) => attemptInQuizScope(a, authorizedQuizIds))
    );
    const trackSummary = summarizeFinishedAttemptsByTrack(
      groupAttempts,
      (a) => quizTrackById.get(a.quizId)
    );
    const trackSplit = Object.fromEntries(
      TRACK_BUCKETS.map((bucket) => [bucket, trackSummary[bucket]])
    );

    return {
      groupId: g.id,
      groupName: g.name,
      courseName: g.course.nameAr || g.course.name,
      trackSplit,
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

  // Phase 18 — the same track split over EVERY authorized finished attempt,
  // preserved. Ordering is the module's `TRACK_BUCKETS` (SHARED, ARABIC,
  // LANGUAGE), and each bucket is the unmodified Phase 6 shape.
  const overallTrackSummary = summarizeFinishedAttemptsByTrack(
    allAuthorizedAttempts,
    (a) => quizTrackById.get(a.quizId)
  );
  const overallTrackSplit = Object.fromEntries(
    TRACK_BUCKETS.map((bucket) => [bucket, overallTrackSummary[bucket]])
  );

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
      /** Phase 18 — track cut of the same finished-attempt population. */
      trackSplit: overallTrackSplit,
    },
    groups,
  });
}
