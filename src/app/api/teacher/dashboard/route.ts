import { getServerT } from "@/lib/i18n-server";
// GET /api/teacher/dashboard
// Returns teacher's groups (with students + per-group stats),
// upcoming sessions (next 7 days), recent activity (last 5 graded
// homework + last 5 quiz attempts), and pending homework count.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getVideoProgressForStudents } from "@/lib/progress";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { lessonCourseChainOr } from "@/lib/session-progress";
import {
  academicLevelParamOf,
  academicLevelScope,
  scopedTeacherGroups,
} from "@/lib/teacher-academic-level";

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  // Phase L manual-QA fix #4 — OPTIONAL academic-level separator, enforced as
  // an extra `where` on the teacher's OWN groups (Teacher → Group → Course.
  // academicLevel), so EVERY number on this page — group cards, students,
  // per-group stats, upcoming sessions and recent activity — follows the
  // chosen level. It can only narrow the teacher's scope, never widen it, and
  // an unrecognised value is refused rather than treated as "all".
  const levelParam = academicLevelParamOf(req);
  if (!levelParam.ok) return err("Unknown academic level", 400);
  const scopedGroups = await scopedTeacherGroups(teacher, levelParam.level);

  // ---- Scoped read plan -------------------------------------------------
  // Resolve each group's content ids first. Once that dependency is ready,
  // independent per-group KPIs, activity history and upcoming sessions run
  // concurrently under the already-selected owned-group scope.

  // Resolve every selected group's canonical lesson/content ids once. Both
  // the per-group KPIs and the recent-activity feed use this same Group →
  // Course → (Unit or legacy Topic) relationship, rather than a student's
  // lifetime history or a union of unrelated courses.
  const groupContentPromise = Promise.all(
    scopedGroups.map(async (g) => {
      const courseLessons = await db.lesson.findMany({
        where: { OR: lessonCourseChainOr(g.courseId) },
        select: { id: true },
      });
      const lessonIds = courseLessons.map((lesson) => lesson.id);
      const [homeworks, quizzes] = lessonIds.length
        ? await Promise.all([
            db.homework.findMany({
              where: { lessonId: { in: lessonIds } },
              select: { id: true },
            }),
            db.quiz.findMany({
              where: { lessonId: { in: lessonIds } },
              select: { id: true },
            }),
          ])
        : [[], []];

      return {
        studentIds: g.students.map((s) => s.id),
        homeworkIds: homeworks.map((homework) => homework.id),
        quizIds: quizzes.map((quiz) => quiz.id),
      };
    })
  );

  // ---- Per-group enrichment -------------------------------------------
  const groupsPromise = (async () => {
    const groupContent = await groupContentPromise;
    return Promise.all(
      scopedGroups.map(async (g, index) => {
        const content = groupContent[index];
        const studentIds = content.studentIds;

        // Video progress and the group's own sessions are independent reads.
        const [groupVideoProgress, sessions] = await Promise.all([
          getVideoProgressForStudents(studentIds),
          db.liveSession.findMany({
            where: { groupId: g.id },
            select: {
              id: true,
              startAt: true,
              status: true,
              title: true,
              titleAr: true,
            },
          }),
        ]);

        const nowMs = Date.now();
        const nextSession =
          sessions
            .filter((s) => s.startAt.getTime() >= nowMs)
            .sort((a, b) => a.startAt.getTime() - b.startAt.getTime())[0] ||
          null;

        // KPIs are intersected across the current roster, this group's own
        // sessions/content, and (for quiz outcomes) finished attempts only.
        const sessionIds = sessions.map((s) => s.id);
        const [attendanceRows, quizAttempts, pendingSubmissions] =
          await Promise.all([
            studentIds.length && sessionIds.length
              ? db.attendance.findMany({
                  where: {
                    studentId: { in: studentIds },
                    sessionId: { in: sessionIds },
                  },
                })
              : Promise.resolve([]),
            studentIds.length && content.quizIds.length
              ? db.quizAttempt.findMany({
                  where: {
                    studentId: { in: studentIds },
                    quizId: { in: content.quizIds },
                    finishedAt: { not: null },
                  },
                  select: { percentage: true },
                })
              : Promise.resolve([] as { percentage: number }[]),
            studentIds.length && content.homeworkIds.length
              ? db.homeworkSubmission.count({
                  where: {
                    studentId: { in: studentIds },
                    homeworkId: { in: content.homeworkIds },
                    status: { in: ["PENDING", "SUBMITTED"] },
                  },
                })
              : Promise.resolve(0),
          ]);

        const presentCount = attendanceRows.filter(
          (a) => a.status === "PRESENT" || a.status === "LATE"
        ).length;
        const attendancePct =
          attendanceRows.length > 0
            ? Math.round((presentCount / attendanceRows.length) * 100)
            : 0;
        const avgQuizScore =
          quizAttempts.length > 0
            ? Math.round(
                quizAttempts.reduce((sum, attempt) => sum + attempt.percentage, 0) /
                  quizAttempts.length
              )
            : 0;

        return {
          id: g.id,
          name: g.name,
          schedule: g.schedule,
          capacity: g.capacity,
          courseId: g.courseId,
          course: g.course
            ? {
                id: g.course.id,
                slug: g.course.slug,
                name: g.course.name,
                nameAr: g.course.nameAr,
                color: g.course.color,
                // Level is canonical on the group's Course, never on Teacher.
                academicLevel: g.course.academicLevel ?? null,
              }
            : null,
          studentsCount: g.students.length,
          students: g.students.map((s: any) => ({
            id: s.id,
            name: s.user.name,
            email: s.user.email,
            avatarUrl: s.user.avatarUrl,
            grade: s.grade,
            studentCode: s.studentCode ?? null,
            schoolType: s.schoolType ?? null,
            videoProgress: groupVideoProgress.get(s.id) || null,
          })),
          stats: {
            attendancePct,
            avgQuizScore,
            pendingHomework: pendingSubmissions,
            totalSessions: sessions.length,
          },
          nextSession: nextSession
            ? {
                id: nextSession.id,
                startAt: nextSession.startAt,
                title: nextSession.titleAr || nextSession.title,
              }
            : null,
        };
      })
    );
  })();

  // ---- Upcoming sessions (next 7 days across all teacher groups) ----
  const teacherGroupIds = scopedGroups.map((g) => g.id);
  const weekAhead = new Date();
  weekAhead.setDate(weekAhead.getDate() + 7);
  const upcomingPromise = teacherGroupIds.length
    ? db.liveSession.findMany({
        where: {
          groupId: { in: teacherGroupIds },
          startAt: { gte: new Date(), lte: weekAhead },
          status: { in: ["SCHEDULED", "LIVE"] },
        },
        orderBy: { startAt: "asc" },
        include: {
          group: { select: { id: true, name: true } },
          lesson: { select: { id: true, title: true, titleAr: true } },
        },
        take: 20,
      })
    : Promise.resolve([]);

  // ---- Recent activity: selected group/course history only --------------
  const activityPromise = (async () => {
    const groupContent = await groupContentPromise;
    const perGroupActivity = await Promise.all(
      scopedGroups.map(async (g, index) => {
        const content = groupContent[index];
        const studentIds = content.studentIds;
        const [submissions, attempts] = await Promise.all([
          studentIds.length && content.homeworkIds.length
            ? db.homeworkSubmission.findMany({
                where: {
                  studentId: { in: studentIds },
                  homeworkId: { in: content.homeworkIds },
                  status: "GRADED",
                },
                orderBy: { id: "desc" },
                take: 5,
                include: {
                  student: { include: { user: { select: { name: true } } } },
                  homework: { select: { id: true, title: true, titleAr: true } },
                },
              })
            : Promise.resolve([]),
          studentIds.length && content.quizIds.length
            ? db.quizAttempt.findMany({
                where: {
                  studentId: { in: studentIds },
                  quizId: { in: content.quizIds },
                  finishedAt: { not: null },
                },
                orderBy: { startedAt: "desc" },
                take: 5,
                include: {
                  student: { include: { user: { select: { name: true } } } },
                  quiz: { select: { id: true, title: true, titleAr: true } },
                },
              })
            : Promise.resolve([]),
        ]);
        const activityContext = {
          group: { id: g.id, name: g.name },
          course: {
            id: g.courseId,
            name: g.course?.name ?? "",
            nameAr: g.course?.nameAr ?? "",
            academicLevel: g.course?.academicLevel ?? null,
          },
        };
        return {
          submissions: submissions.map((submission: any) => ({
            ...submission,
            ...activityContext,
          })),
          attempts: attempts.map((attempt: any) => ({
            ...attempt,
            ...activityContext,
          })),
        };
      })
    );

    // Preserve the feed's existing per-type caps after merging the scoped
    // group histories; a student in one group cannot pull another course's
    // record into that group's activity context.
    const recentSubs = perGroupActivity
      .flatMap((entry) => entry.submissions)
      .sort((a, b) => String(b.id).localeCompare(String(a.id)))
      .slice(0, 5);
    const recentAttempts = perGroupActivity
      .flatMap((entry) => entry.attempts)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, 5);
    return { recentSubs, recentAttempts };
  })();

  const [groups, upcomingSessions, activity] = await Promise.all([
    groupsPromise,
    upcomingPromise,
    activityPromise,
  ]);
  const { recentSubs, recentAttempts } = activity;
  const totalPendingHomework = groups.reduce(
    (sum, group) => sum + group.stats.pendingHomework,
    0
  );

  const upcomingSessionsPayload = upcomingSessions.map((s) => ({
    id: s.id,
    title: s.titleAr || s.title,
    startAt: s.startAt,
    duration: s.duration,
    status: s.status,
    meetingUrl: s.meetingUrl,
    group: { id: s.group.id, name: s.group.name },
    lesson: s.lesson
      ? { id: s.lesson.id, title: s.lesson.titleAr || s.lesson.title }
      : null,
  }));

  type Activity = {
    type: "homework-graded" | "quiz-attempt";
    title: string;
    description: string;
    studentName: string;
    time: Date;
    kind: "good" | "neutral" | "warn";
    group: { id: string; name: string };
    course: {
      id: string;
      name: string;
      nameAr: string;
      academicLevel: string | null;
    };
    attemptId?: string;
    quizId?: string;
  };
  const activities: Activity[] = [];
  for (const s of recentSubs) {
    activities.push({
      type: "homework-graded",
      title: `Homework: ${s.homework.titleAr || s.homework.title}`,
      description: tApi("api.164", { p1: s.grade ?? 0 }),
      studentName: s.student?.user?.name || tApi("api.165"),
      time: s.submittedAt || new Date(),
      kind: "good",
      group: s.group,
      course: s.course,
    });
  }
  for (const a of recentAttempts) {
    activities.push({
      type: "quiz-attempt",
      title: `Quiz: ${a.quiz.titleAr || a.quiz.title}`,
      description: `${a.percentage}% — ${a.passed ? tApi("api.166") : tApi("api.167")}`,
      studentName: a.student?.user?.name || tApi("api.165"),
      time: a.finishedAt || a.startedAt,
      kind: a.passed ? "good" : "warn",
      attemptId: a.id,
      quizId: a.quiz.id,
      group: a.group,
      course: a.course,
    });
  }
  activities.sort((a, b) => b.time.getTime() - a.time.getTime());
  const recentActivity = activities.slice(0, 8).map((a) => ({
    ...a,
    time: a.time,
  }));

  // Presentation metadata: the teacher's FULL level scope (never filtered),
  // so the client knows whether a level separator is even meaningful here.
  return ok({
    scope: academicLevelScope(teacher.groups),
    teacher: {
      id: teacher.id,
      name: teacher.user.name,
      email: teacher.user.email,
      avatarUrl: teacher.user.avatarUrl,
      bio: teacher.bio,
      specialty: teacher.specialty,
    },
    groups,
    upcomingSessions: upcomingSessionsPayload,
    recentActivity,
    pendingHomeworkCount: totalPendingHomework,
  });
}
