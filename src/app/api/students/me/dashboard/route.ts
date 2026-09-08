import { getServerT, serverPick, serverLocale } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import {
  EXCLUDE_ARCHIVED_LESSON,
  getUnlockedLessonIds,
} from "@/lib/session-progress";

// GET /api/students/me/dashboard
// Aggregated student dashboard data.
export async function GET(_req: NextRequest) {
  const tApi = await getServerT();
  const __loc = await serverLocale();
  const sp = (ar: string | null | undefined, en: string | null | undefined) => serverPick(__loc, ar, en);
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  // ----- Course progress + last viewed lesson -----
  // Course progress runs over the ACTIVE curriculum universe (both chains,
  // archived history excluded): official lessons are unit-linked, legacy
  // history rows stay readable but no longer count toward the percentage.
  const groupMatch = { course: { groups: { some: { id: student.groupId || "_" } } } };
  const lessons = await db.lesson.findMany({
    where: {
      ...EXCLUDE_ARCHIVED_LESSON,
      OR: [
        { unit: { part: groupMatch } },
        { topic: { unit: { part: groupMatch } } },
      ],
    },
    include: {
      unit: { include: { part: { include: { course: true } } } },
      topic: { include: { unit: { include: { part: { include: { course: true } } } } } },
      progress: { where: { studentId: student.id } },
    },
    orderBy: [
      { topic: { unit: { part: { order: "asc" } } } },
      { unit: { part: { order: "asc" } } },
      { unit: { order: "asc" } },
      { order: "asc" },
      { id: "asc" },
    ],
  });

  const totalLessons = lessons.length;
  const completedLessons = lessons.filter((l) =>
    l.progress.some((p) => p.isCompleted)
  ).length;
  const overallPct =
    totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;

  // ----- Session gating (shared with every other progression path) -----
  // The dashboard must never name or link a session the student has not
  // unlocked. `continueLesson` used to fall back to the FIRST not-completed
  // lesson, which is a LOCKED session as soon as the previous one is watched
  // but not finished — and it carried that session's videoUrl with it.
  const courseId = student.group?.course?.id ?? null;
  const unlockedLessonIds =
    courseId && student.group?.isActive
      ? await getUnlockedLessonIds(student.id, courseId)
      : new Set<string>();
  const isOpen = (lessonId: string) => unlockedLessonIds.has(lessonId);

  // last viewed lesson — only when the student may still open it
  const lastViewed = lessons
    .map((l) => ({
      lesson: l,
      progress: l.progress[0],
    }))
    .filter((x) => x.progress?.lastViewedAt && isOpen(x.lesson.id))
    .sort(
      (a, b) =>
        (b.progress!.lastViewedAt!.getTime() || 0) -
        (a.progress!.lastViewedAt!.getTime() || 0)
    )[0];

  // first not-completed lesson the student may actually open
  const firstIncomplete = lessons.find(
    (l) => isOpen(l.id) && !l.progress.some((p) => p.isCompleted)
  );

  const continueLesson =
    lastViewed?.lesson ||
    firstIncomplete ||
    lessons.find((l) => isOpen(l.id)) ||
    null;

  // ----- Next live session -----
  const nextSession = student.groupId
    ? await db.liveSession.findFirst({
        where: {
          groupId: student.groupId,
          startAt: { gt: new Date() },
          status: { in: ["SCHEDULED", "LIVE"] },
        },
        include: {
          teacher: { include: { user: true } },
          group: true,
          lesson: true,
        },
        orderBy: { startAt: "asc" },
      })
    : null;

  // ----- Attendance -----
  const attendances = await db.attendance.findMany({
    where: { studentId: student.id },
    include: { session: true },
  });
  const attendanceTotal = attendances.length;
  const attendancePresent = attendances.filter(
    (a) => a.status === "PRESENT" || a.status === "LATE"
  ).length;
  const attendancePct =
    attendanceTotal > 0
      ? Math.round((attendancePresent / attendanceTotal) * 100)
      : 0;

  // ----- Latest quiz result -----
  const latestAttempt = await db.quizAttempt.findFirst({
    where: { studentId: student.id },
    include: { quiz: { include: { lesson: true } } },
    orderBy: { finishedAt: "desc" },
  });

  // ----- Pending homework count -----
  // Pending = homework that has no submission yet OR submission status is PENDING
  // and the deadline is in the future
  // Only assignments from the ACTIVE curriculum universe (both chains,
  // archived history excluded): archived lessons' homework is history, not a
  // pending to-do, and official unit-linked lessons must be counted.
  const groupCourseMatch = {
    course: { groups: { some: { id: student.groupId || "_" } } },
  };
  const homeworks = await db.homework.findMany({
    where: {
      lesson: {
        ...EXCLUDE_ARCHIVED_LESSON,
        OR: [
          { unit: { part: groupCourseMatch } },
          { topic: { unit: { part: groupCourseMatch } } },
        ],
      },
    },
    include: {
      submissions: { where: { studentId: student.id } },
      lesson: { select: { titleAr: true, title: true } },
    },
  });
  // Only assignments belonging to sessions the student has unlocked: a locked
  // session's assignment is protected content, not a "pending" to-do.
  const pendingHomeworks = homeworks.filter((h) => {
    if (!isOpen(h.lessonId)) return false;
    if (!h.submissions.length) return true;
    const s = h.submissions[0];
    return s.status === "PENDING";
  });

  // ----- Recent activity timeline -----
  const recentLessonProgress = await db.lessonProgress.findMany({
    where: { studentId: student.id, lastViewedAt: { not: null } },
    include: { lesson: { include: { topic: { include: { unit: { include: { part: true } } } } } } },
    orderBy: { lastViewedAt: "desc" },
    take: 5,
  });
  const recentQuizAttempts = await db.quizAttempt.findMany({
    where: { studentId: student.id },
    include: { quiz: { include: { lesson: true } } },
    orderBy: { finishedAt: "desc" },
    take: 5,
  });
  const recentHomeworkSubs = await db.homeworkSubmission.findMany({
    where: { studentId: student.id },
    include: { homework: { include: { lesson: true } } },
    orderBy: { submittedAt: "desc" },
    take: 5,
  });

  type ActivityItem = {
    type: "lesson" | "quiz" | "homework";
    title: string;
    detail: string;
    date: Date;
    meta?: Record<string, unknown>;
  };
  const activity: ActivityItem[] = [];
  for (const lp of recentLessonProgress) {
    if (!lp.lastViewedAt) continue;
    activity.push({
      type: "lesson",
      title: sp(lp.lesson.titleAr, lp.lesson.title),
      detail: `Lesson — ${lp.isCompleted ? tApi("api.125") : tApi("api.126")}`,
      date: lp.lastViewedAt,
      meta: { lessonId: lp.lessonId, progress: lp.progress, completed: lp.isCompleted },
    });
  }
  for (const qa of recentQuizAttempts) {
    activity.push({
      type: "quiz",
      title: sp(qa.quiz.titleAr, qa.quiz.title),
      detail: `Quiz — ${qa.percentage}% ${qa.passed ? tApi("api.127") : tApi("api.128")}`,
      date: qa.finishedAt || qa.startedAt,
      meta: { quizId: qa.quizId, percentage: qa.percentage, passed: qa.passed },
    });
  }
  for (const hs of recentHomeworkSubs) {
    activity.push({
      type: "homework",
      title: sp(hs.homework.titleAr, hs.homework.title),
      detail: `Homework — ${
        hs.status === "GRADED"
          ? tApi("api.129", { p1: hs.grade, p2: hs.homework.maxMarks })
          : hs.status === "SUBMITTED"
          ? tApi("api.130")
          : tApi("api.131")
      }`,
      date: hs.submittedAt || hs.homework.deadline,
      meta: { homeworkId: hs.homeworkId, status: hs.status, grade: hs.grade },
    });
  }
  activity.sort((a, b) => b.date.getTime() - a.date.getTime());
  const recentActivity = activity.slice(0, 5);

  // ----- Subscription status -----
  let subscriptionStatus: "ACTIVE" | "EXPIRING" | "EXPIRED" | "NONE" = "NONE";
  let subscriptionEnd: Date | null = null;
  let daysToExpiry = 0;
  if (student.subscription) {
    const sub = student.subscription;
    subscriptionEnd = sub.endDate;
    if (sub.status === "ACTIVE" && sub.endDate) {
      daysToExpiry = Math.ceil(
        (sub.endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
      );
      subscriptionStatus = daysToExpiry <= 7 ? "EXPIRING" : "ACTIVE";
    } else if (sub.status === "EXPIRED" || (sub.endDate && sub.endDate < new Date())) {
      subscriptionStatus = "EXPIRED";
    } else {
      subscriptionStatus = "ACTIVE";
    }
  }

  // Canonical chain first (official lessons are unit-linked); legacy
  // topic chain as fallback. Either may be null for chain-less rows.
  const continuePart =
    continueLesson?.unit?.part ?? continueLesson?.topic?.unit.part ?? null;
  const continueUnit =
    continueLesson?.unit ?? continueLesson?.topic?.unit ?? null;

  return ok({
    student: {
      id: student.id,
      name: student.user.name,
      firstName: student.user.name.split(" ")[0],
      email: student.user.email,
      grade: student.grade,
      schoolName: (student as any).schoolName ?? null,
      schoolType: (student as any).schoolType ?? null,
      nationalId: (student as any).nationalId ?? null,
      parentPhone: (student as any).parentPhone ?? null,
      studentCode: (student as any).studentCode ?? null,
    },
    group: student.group
      ? {
          id: student.group.id,
          name: student.group.name,
          schedule: student.group.schedule,
          course: {
            id: student.group.course.id,
            slug: student.group.course.slug,
            name: student.group.course.name,
            nameAr: student.group.course.nameAr,
            color: student.group.course.color,
          },
          teacher: student.group.teacher
            ? {
                name: student.group.teacher.user.name,
                specialty: student.group.teacher.specialty,
              }
            : null,
        }
      : null,
    courseProgress: {
      totalLessons,
      completedLessons,
      percentage: overallPct,
    },
    continueLesson: continueLesson
      ? {
          id: continueLesson.id,
          title: sp(continueLesson.titleAr, continueLesson.title),
          part: continuePart ? sp(continuePart.titleAr, continuePart.title) : null,
          unit: continueUnit ? sp(continueUnit.titleAr, continueUnit.title) : null,
          topic: continueLesson.topic
            ? sp(continueLesson.topic.titleAr, continueLesson.topic.title)
            : null,
          progress: continueLesson.progress[0]?.progress || 0,
          isCompleted: continueLesson.progress[0]?.isCompleted || false,
          // continueLesson is always an unlocked session now; the guard is
          // belt-and-braces so a future refactor cannot re-leak a media URL.
          videoUrl: isOpen(continueLesson.id) ? continueLesson.videoUrl : null,
          courseSlug: continuePart?.course?.slug ?? null,
        }
      : null,
    nextSession: nextSession
      ? {
          id: nextSession.id,
          title: sp(nextSession.titleAr, nextSession.title),
          startAt: nextSession.startAt,
          duration: nextSession.duration,
          meetingUrl: nextSession.meetingUrl,
          groupName: nextSession.group.name,
          teacherName: nextSession.teacher?.user.name || "—",
        }
      : null,
    attendance: {
      total: attendanceTotal,
      present: attendancePresent,
      percentage: attendancePct,
    },
    latestQuizResult: latestAttempt
      ? {
          attemptId: latestAttempt.id,
          quizId: latestAttempt.quizId,
          quizTitle: sp(latestAttempt.quiz.titleAr, latestAttempt.quiz.title),
          lessonTitle:
            sp(latestAttempt.quiz.lesson?.titleAr, latestAttempt.quiz.lesson?.title) || "",
          score: latestAttempt.score,
          totalMarks: latestAttempt.totalMarks,
          percentage: latestAttempt.percentage,
          passed: latestAttempt.passed,
        }
      : null,
    pendingHomework: {
      count: pendingHomeworks.length,
      items: pendingHomeworks.slice(0, 5).map((h) => ({
        id: h.id,
        title: h.titleAr || h.title,
        deadline: h.deadline,
        lessonTitle: h.lesson.titleAr || h.lesson.title,
        maxMarks: h.maxMarks,
      })),
    },
    subscription: {
      status: subscriptionStatus,
      endDate: subscriptionEnd,
      daysToExpiry,
      planName: student.subscription?.plan?.nameAr || student.subscription?.plan?.name || null,
    },
    recentActivity,
  });
}
