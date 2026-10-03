import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Teacher Analytics API
// Returns performance metrics for the teacher's groups and students.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import {
  academicLevelParamOf,
  academicLevelScope,
  scopedTeacherGroups,
} from "@/lib/teacher-academic-level";
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

export async function GET(req: NextRequest) {
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
            },
          },
        },
      },
    },
  });
  if (!teacher) return err(tApi("api.155"), 404);

  // Phase L manual-QA fix #4 — OPTIONAL academic-level separator: an extra
  // `where` on the teacher's OWN groups (Teacher → Group → Course.academicLevel)
  // so the per-group rows AND every headline number below describe ONE level.
  // It narrows only; it can never widen the teacher's authorization.
  const levelParam = academicLevelParamOf(req);
  if (!levelParam.ok) return err("Unknown academic level", 400);
  const scopedGroups = await scopedTeacherGroups(teacher, levelParam.level);

  // Resolve selected teacher-owned groups to their own course content and
  // sessions. Each group's KPIs intersect its current roster with its own
  // Group → Course → (Unit or legacy Topic) lesson ids and group sessions;
  // student lifetime history is not a substitute for that context.
  const courseIds: string[] = Array.from(
    new Set<string>(scopedGroups.map((g) => g.courseId as string))
  );
  const groupIds: string[] = scopedGroups.map((g) => g.id as string);
  const [courseLessonRows, groupSessionRows] = await Promise.all([
    courseIds.length
      ? db.lesson.findMany({
          where: { OR: lessonCoursesChainOr(courseIds) },
          select: {
            id: true,
            unit: { select: { part: { select: { courseId: true } } } },
            topic: {
              select: {
                unit: { select: { part: { select: { courseId: true } } } },
              },
            },
          },
        })
      : Promise.resolve([]),
    groupIds.length
      ? db.liveSession.findMany({
          where: { groupId: { in: groupIds } },
          select: { id: true, groupId: true },
        })
      : Promise.resolve([]),
  ]);

  const lessonCourseById = new Map<string, string>();
  for (const lesson of courseLessonRows) {
    const courseId = lesson.unit?.part.courseId ?? lesson.topic?.unit.part.courseId;
    if (courseId) lessonCourseById.set(lesson.id, courseId);
  }

  const selectedLessonIds = Array.from(lessonCourseById.keys());
  const [authorizedQuizRows, authorizedHomeworkRows] = selectedLessonIds.length
    ? await Promise.all([
        db.quiz.findMany({
          where: { lessonId: { in: selectedLessonIds } },
          // The quiz's own Track scope travels with its id; track aggregation
          // below remains the same, over the authorized finished population.
          select: { id: true, trackScope: true, lessonId: true },
        }),
        db.homework.findMany({
          where: { lessonId: { in: selectedLessonIds } },
          select: { id: true, lessonId: true },
        }),
      ])
    : [[], []];

  const quizIdsByCourse = new Map<string, Set<string>>();
  const homeworkIdsByCourse = new Map<string, Set<string>>();
  const quizTrackById = new Map<string, string>();
  for (const quiz of authorizedQuizRows) {
    const courseId = lessonCourseById.get(quiz.lessonId);
    if (!courseId) continue;
    const ids = quizIdsByCourse.get(courseId) || new Set<string>();
    ids.add(quiz.id);
    quizIdsByCourse.set(courseId, ids);
    quizTrackById.set(quiz.id, String(quiz.trackScope));
  }
  for (const homework of authorizedHomeworkRows) {
    const courseId = lessonCourseById.get(homework.lessonId);
    if (!courseId) continue;
    const ids = homeworkIdsByCourse.get(courseId) || new Set<string>();
    ids.add(homework.id);
    homeworkIdsByCourse.set(courseId, ids);
  }

  const sessionIdsByGroup = new Map<string, Set<string>>();
  for (const session of groupSessionRows) {
    const ids = sessionIdsByGroup.get(session.groupId) || new Set<string>();
    ids.add(session.id);
    sessionIdsByGroup.set(session.groupId, ids);
  }

  // Every scoped, finished attempt is collected once so the Track split is
  // computed over exactly the rows the per-group KPI aggregation admits.
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

  // Load history only after its teacher-owned group/course/session boundary is
  // known. This prevents the analytics route from even aggregating a student's
  // lifetime relations and keeps unrelated records out of the returned data.
  const groupHistory = await Promise.all(
    scopedGroups.map(async (g) => {
      const studentIds = g.students.map((student) => student.id);
      const sessionIds = Array.from(sessionIdsByGroup.get(g.id) || []);
      const quizIds = Array.from(quizIdsByCourse.get(g.courseId) || []);
      const homeworkIds = Array.from(homeworkIdsByCourse.get(g.courseId) || []);
      const lessonIds = (universeLessonsByCourse.get(g.courseId) || []).map(
        (lesson) => lesson.id
      );

      const [attendanceRows, quizAttempts, homeworkSubmits, lessonProgressRows] =
        await Promise.all([
          studentIds.length && sessionIds.length
            ? db.attendance.findMany({
                where: {
                  studentId: { in: studentIds },
                  sessionId: { in: sessionIds },
                },
                select: { studentId: true, status: true },
              })
            : Promise.resolve([]),
          studentIds.length && quizIds.length
            ? db.quizAttempt.findMany({
                where: {
                  studentId: { in: studentIds },
                  quizId: { in: quizIds },
                  finishedAt: { not: null },
                },
                select: {
                  percentage: true,
                  passed: true,
                  finishedAt: true,
                  quizId: true,
                  studentId: true,
                  score: true,
                  totalMarks: true,
                },
              })
            : Promise.resolve([]),
          studentIds.length && homeworkIds.length
            ? db.homeworkSubmission.findMany({
                where: {
                  studentId: { in: studentIds },
                  homeworkId: { in: homeworkIds },
                },
                select: {
                  studentId: true,
                  homeworkId: true,
                  status: true,
                  grade: true,
                },
              })
            : Promise.resolve([]),
          studentIds.length && lessonIds.length
            ? db.lessonProgress.findMany({
                where: {
                  studentId: { in: studentIds },
                  lessonId: { in: lessonIds },
                },
                select: { studentId: true, isCompleted: true, lessonId: true },
              })
            : Promise.resolve([]),
        ]);

      const byStudent = <T extends { studentId: string }>(rows: T[]) => {
        const grouped = new Map<string, T[]>();
        for (const row of rows) {
          const list = grouped.get(row.studentId) || [];
          list.push(row);
          grouped.set(row.studentId, list);
        }
        return grouped;
      };

      return {
        attendanceByStudent: byStudent(attendanceRows),
        quizAttemptsByStudent: byStudent(quizAttempts),
        homeworkByStudent: byStudent(homeworkSubmits),
        lessonProgressByStudent: byStudent(lessonProgressRows),
      };
    })
  );

  // Compute per-group stats
  const groups = scopedGroups.map((g, groupIndex) => {
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

    const groupQuizIds = quizIdsByCourse.get(g.courseId) || new Set<string>();
    const groupHomeworkIds = homeworkIdsByCourse.get(g.courseId) || new Set<string>();
    const history = groupHistory[groupIndex];

    const studentStats = g.students.map((s) => {
      const studentAttempts = history.quizAttemptsByStudent.get(s.id) || [];
      for (const a of studentAttempts) {
        if (attemptInQuizScope(a, groupQuizIds)) allAuthorizedAttempts.push(a);
      }
      const groupAttendance = history.attendanceByStudent.get(s.id) || [];
      const attendanceCount = groupAttendance.length;
      const presentCount = groupAttendance.filter((a) => a.status === "PRESENT").length;
      // Finished attempts from this group's own course only. Same-level or
      // other teacher-owned course history is still a different KPI context.
      const quizAttempts = studentAttempts.filter((q) =>
        attemptInQuizScope(q, groupQuizIds)
      );
      const quizCount = quizAttempts.length;
      const quizPassed = quizAttempts.filter((q) => q.passed).length;
      const avgPct = quizCount > 0
        ? Math.round(quizAttempts.reduce((sum, q) => sum + q.percentage, 0) / quizCount)
        : 0;
      const homeworkSubmits = (history.homeworkByStudent.get(s.id) || []).filter(
        (submission) => groupHomeworkIds.has(submission.homeworkId)
      );
      const hwTotal = homeworkSubmits.length;
      const hwGraded = homeworkSubmits.filter((h) => h.status === "GRADED").length;
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
      const lessonCompleted = (history.lessonProgressByStudent.get(s.id) || []).filter(
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
      (history.quizAttemptsByStudent.get(s.id) || []).filter((a) =>
        attemptInQuizScope(a, groupQuizIds)
      )
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
      // Phase L manual-QA fix — the level is derived through Group → Course;
      // both official courses share one display name, so a teacher analytics
      // row would otherwise be ambiguous across levels.
      academicLevel: g.course.academicLevel ?? null,
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

  // Presentation metadata: the teacher's FULL level scope (never filtered),
  // so the client knows whether a level separator is even meaningful here.
  return ok({
    scope: academicLevelScope(teacher.groups),
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
