import { NextRequest } from "next/server";
import { getServerT, serverPick, serverLocale } from "@/lib/i18n-server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getParentProfile } from "@/lib/api";
import type { ParentSubscriptionPayload } from "@/lib/parent-subscription";

// GET /api/parents/me/dashboard
// Returns aggregated analytics for the current parent's children.
export async function GET(_req: NextRequest) {
  const tApi = await getServerT();
  const __loc = await serverLocale();
  const sp = (ar: string | null | undefined, en: string | null | undefined) => serverPick(__loc, ar, en);
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "PARENT") return err("Forbidden", 403);

  const parent = await getParentProfile(user.id);
  if (!parent) return err("Parent profile not found", 404);

  // Build a per-child aggregate payload.
  const children = await Promise.all(
    parent.children.map(async (link) => {
      const student = link.student;

      // --- Course progress: avg of LessonProgress.progress across all lessons in the
      // course (or 0 if no progress). Also count completed lessons.
      const lessonsInCourse = await db.lesson.count({
        where: { topic: { unit: { part: { courseId: student.group?.courseId || "" } } } },
      });

      const lessonProgressRows = await db.lessonProgress.findMany({
        where: { studentId: student.id },
        select: { progress: true, isCompleted: true, lessonId: true },
      });

      const completedLessons = lessonProgressRows.filter((p) => p.isCompleted).length;
      const avgProgress =
        lessonsInCourse > 0
          ? Math.round(
              (lessonProgressRows.reduce((s, p) => s + (p.progress || 0), 0) /
                lessonsInCourse) as number
            )
          : 0;

      // --- Attendance: percentage + monthly breakdown (last 6 months)
      const attendances = await db.attendance.findMany({
        where: { studentId: student.id },
        include: { session: { select: { startAt: true, titleAr: true, title: true } } },
      });
      const presentCount = attendances.filter(
        (a) => a.status === "PRESENT" || a.status === "LATE"
      ).length;
      const attendancePct =
        attendances.length > 0
          ? Math.round((presentCount / attendances.length) * 100)
          : 0;

      // Group by month (last 6 months)
      const now = new Date();
      const monthBuckets: { key: string; label: string; total: number; present: number }[] = [];
      for (let i = 5; i >= 0; i--) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const label = d.toLocaleString("en-US", { month: "short" });
        monthBuckets.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label, total: 0, present: 0 });
      }
      for (const a of attendances) {
        const d = a.session?.startAt || a.createdAt;
        const key = `${d.getFullYear()}-${d.getMonth()}`;
        const bucket = monthBuckets.find((b) => b.key === key);
        if (bucket) {
          bucket.total += 1;
          if (a.status === "PRESENT" || a.status === "LATE") bucket.present += 1;
        }
      }
      const attendanceByMonth = monthBuckets.map((b) => ({
        month: b.label,
        pct: b.total > 0 ? Math.round((b.present / b.total) * 100) : 0,
        present: b.present,
        total: b.total,
      }));

      // --- Quiz average + recent attempts
      const quizAttempts = await db.quizAttempt.findMany({
        where: { studentId: student.id },
        orderBy: { startedAt: "desc" },
        take: 20,
        include: { quiz: { select: { id: true, title: true, titleAr: true } } },
      });
      const quizAveragePct =
        quizAttempts.length > 0
          ? Math.round(
              quizAttempts.reduce((s, a) => s + a.percentage, 0) / quizAttempts.length
            )
          : 0;
      const passedCount = quizAttempts.filter((a) => a.passed).length;
      const recentQuizAttempts = quizAttempts.slice(0, 6).map((a) => ({
        id: a.id,
        quizId: a.quizId,
        quizTitle: sp(a.quiz?.titleAr, a.quiz?.title) || "Quiz",
        score: a.score,
        totalMarks: a.totalMarks,
        percentage: a.percentage,
        passed: a.passed,
        finishedAt: a.finishedAt || a.startedAt,
      }));

      // Performance trend (oldest -> newest of last 6 attempts)
      const performanceTrend = [...recentQuizAttempts].reverse().map((a, i) => ({
        label: `Q${i + 1}`,
        title: a.quizTitle,
        pct: a.percentage,
        date: a.finishedAt,
      }));

      // --- Homework completion
      const allHomeworks = await db.homework.findMany({
        where: { lesson: { topic: { unit: { part: { courseId: student.group?.courseId || "" } } } } },
        select: { id: true, title: true, titleAr: true, deadline: true },
      });
      const submissions = await db.homeworkSubmission.findMany({
        where: { studentId: student.id },
        include: { homework: { select: { id: true, title: true, titleAr: true } } },
      });
      const submittedCount = submissions.filter(
        (s) => s.status === "SUBMITTED" || s.status === "GRADED" || s.status === "LATE"
      ).length;
      const homeworkCompletionPct =
        allHomeworks.length > 0
          ? Math.round((submittedCount / allHomeworks.length) * 100)
          : 0;
      const recentHomework = allHomeworks.slice(0, 6).map((hw) => {
        const sub = submissions.find((s) => s.homeworkId === hw.id);
        return {
          id: hw.id,
          title: hw.titleAr || hw.title,
          status: sub?.status || "PENDING",
          grade: sub?.grade ?? null,
          maxGrade: 10,
          deadline: hw.deadline,
          submittedAt: sub?.submittedAt || null,
          feedback: sub?.feedback || null,
        };
      });

      // --- Teacher notes (latest 5)
      const teacherNotes = await db.teacherNote.findMany({
        where: { studentId: student.id },
        orderBy: { createdAt: "desc" },
        take: 5,
        include: { teacher: { include: { user: { select: { name: true } } } } },
      });
      const teacherNotesPayload = teacherNotes.map((n) => ({
        id: n.id,
        note: n.note,
        teacherName: n.teacher?.user?.name || "Teacher",
        createdAt: n.createdAt,
      }));

      // --- Next live session
      const nextSession = await db.liveSession.findFirst({
        where: {
          group: { students: { some: { id: student.id } } },
          startAt: { gte: new Date() },
          status: { in: ["SCHEDULED", "LIVE"] },
        },
        orderBy: { startAt: "asc" },
        include: {
          teacher: { include: { user: { select: { name: true } } } },
          lesson: { select: { title: true, titleAr: true } },
        },
      });
      const nextSessionPayload = nextSession
        ? {
            id: nextSession.id,
            title: sp(nextSession.titleAr, nextSession.title),
            startAt: nextSession.startAt,
            duration: nextSession.duration,
            meetingUrl: nextSession.meetingUrl,
            teacherName: nextSession.teacher?.user?.name || "Teacher",
            lessonTitle: nextSession.lesson?.titleAr || nextSession.lesson?.title || null,
          }
        : null;

      // --- Subscription status
      // A Subscription row only exists after the student enrolls
      // (POST /api/enroll). A freshly registered student has none, so
      // `null` is a valid, expected value here — consumers must handle it.
      const subscription = await db.subscription.findUnique({
        where: { studentId: student.id },
        include: { plan: true },
      });
      let subscriptionPayload: ParentSubscriptionPayload | null = null;
      if (subscription) {
        const daysLeft = subscription.endDate
          ? Math.ceil((subscription.endDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24))
          : null;
        subscriptionPayload = {
          status: subscription.status,
          planName: subscription.plan?.nameAr || subscription.plan?.name || "—",
          startDate: subscription.startDate,
          endDate: subscription.endDate,
          daysLeft,
          price: subscription.plan?.price ?? 0,
          durationMonths: subscription.plan?.durationMonths ?? 0,
        };
      }

      // --- Strong / weak topics (based on quiz attempts grouped by topic)
      const attemptsWithTopic = await db.quizAttempt.findMany({
        where: { studentId: student.id },
        include: {
          quiz: {
            select: {
              lesson: {
                select: {
                  topic: { select: { id: true, title: true, titleAr: true } },
                },
              },
            },
          },
        },
        take: 50,
        orderBy: { startedAt: "desc" },
      });
      const topicMap = new Map<
        string,
        { title: string; titleAr: string; sumPct: number; count: number }
      >();
      for (const a of attemptsWithTopic) {
        const topic = a.quiz?.lesson?.topic;
        if (!topic) continue;
        const key = topic.id;
        const existing = topicMap.get(key) || {
          title: topic.title,
          titleAr: topic.titleAr,
          sumPct: 0,
          count: 0,
        };
        existing.sumPct += a.percentage;
        existing.count += 1;
        topicMap.set(key, existing);
      }
      const topicStats = Array.from(topicMap.entries()).map(([id, v]) => ({
        id,
        title: v.titleAr || v.title,
        avgPct: v.count > 0 ? Math.round(v.sumPct / v.count) : 0,
      }));
      // Strong = highest avg% (top 3). Weak = lowest avg% (bottom 3).
      // When the list is small the same topic could legitimately appear in both
      // lists (e.g. only 1 topic) — but that's confusing. De-duplicate so a
      // topic only ever appears in one list: prefer strong if avg >= 60%,
      // otherwise prefer weak.
      const sortedDesc = [...topicStats].sort((a, b) => b.avgPct - a.avgPct);
      const sortedAsc = [...topicStats].sort((a, b) => a.avgPct - b.avgPct);
      const strongTopics: typeof topicStats = [];
      const weakTopics: typeof topicStats = [];
      for (const t of sortedDesc) {
        if (t.avgPct >= 60 && strongTopics.length < 3) {
          strongTopics.push(t);
        } else if (t.avgPct < 60 && weakTopics.length < 3) {
          weakTopics.push(t);
        }
      }
      // Backfill if a list is empty (so user always sees something)
      if (strongTopics.length === 0 && sortedDesc.length > 0) {
        strongTopics.push(...sortedDesc.slice(0, 3));
      }
      if (weakTopics.length === 0 && sortedAsc.length > 0) {
        // pick the lowest ones not already in strong
        const used = new Set(strongTopics.map((s) => s.id));
        for (const t of sortedAsc) {
          if (!used.has(t.id) && weakTopics.length < 3) weakTopics.push(t);
        }
      }

      // --- Recent activity timeline (mix of quiz attempts, homework submissions, attendance)
      type Activity = {
        type: "quiz" | "homework" | "attendance" | "lesson";
        title: string;
        description: string;
        time: Date;
        kind: "good" | "neutral" | "warn";
      };
      const activities: Activity[] = [];
      for (const a of quizAttempts.slice(0, 5)) {
        activities.push({
          type: "quiz",
          title: `Quiz: ${a.quiz?.titleAr || a.quiz?.title || "Quiz"}`,
          description: `${a.percentage}% — ${a.passed ? tApi("api.100") : tApi("api.101")}`,
          time: a.finishedAt || a.startedAt,
          kind: a.passed ? "good" : "warn",
        });
      }
      for (const s of submissions.slice(0, 5)) {
        activities.push({
          type: "homework",
          title: `Homework: ${s.homework?.titleAr || s.homework?.title || ""}`,
          description:
            s.status === "GRADED"
              ? tApi("api.102", { p1: s.grade ?? 0 })
              : s.status === "SUBMITTED"
              ? tApi("api.103")
              : s.status === "LATE"
              ? tApi("api.104")
              : tApi("api.105"),
          time: s.submittedAt || s.homework?.deadline || new Date(),
          kind: s.status === "GRADED" ? "good" : s.status === "PENDING" ? "warn" : "neutral",
        });
      }
      for (const a of attendances.slice(0, 5)) {
        const label =
          a.status === "PRESENT"
            ? tApi("api.106")
            : a.status === "LATE"
            ? tApi("api.107")
            : a.status === "EXCUSED"
            ? tApi("api.108")
            : tApi("api.109");
        activities.push({
          type: "attendance",
          title: `Live Session: ${a.session?.titleAr || a.session?.title || ""}`,
          description: label,
          time: a.session?.startAt || a.createdAt,
          kind: a.status === "PRESENT" ? "good" : a.status === "LATE" ? "warn" : "warn",
        });
      }
      activities.sort((a, b) => b.time.getTime() - a.time.getTime());
      const recentActivity = activities.slice(0, 8).map((a) => ({
        ...a,
        time: a.time,
      }));

      return {
        id: student.id,
        linkId: link.id,
        relation: link.relation,
        name: student.user.name,
        email: student.user.email,
        avatarUrl: student.user.avatarUrl,
        grade: student.grade,
        schoolName: (student as any).schoolName ?? null,
        schoolType: (student as any).schoolType ?? null,
        nationalId: (student as any).nationalId ?? null,
        parentPhone: (student as any).parentPhone ?? null,
        studentCode: (student as any).studentCode ?? null,
        enrolledAt: student.enrolledAt,
        group: student.group
          ? {
              id: student.group.id,
              name: student.group.name,
              schedule: student.group.schedule,
              course: student.group.course
                ? {
                    id: student.group.course.id,
                    slug: student.group.course.slug,
                    name: student.group.course.name,
                    nameAr: student.group.course.nameAr,
                    color: student.group.course.color,
                    iconUrl: student.group.course.iconUrl,
                  }
                : null,
            }
          : null,
        courseProgress: {
          completed: completedLessons,
          total: lessonsInCourse,
          pct: avgProgress,
        },
        attendance: {
          pct: attendancePct,
          present: presentCount,
          total: attendances.length,
          byMonth: attendanceByMonth,
        },
        quizzes: {
          average: quizAveragePct,
          attempts: quizAttempts.length,
          passed: passedCount,
          failed: quizAttempts.length - passedCount,
          recent: recentQuizAttempts,
        },
        performanceTrend,
        homework: {
          total: allHomeworks.length,
          submitted: submittedCount,
          pending: allHomeworks.length - submittedCount,
          completionPct: homeworkCompletionPct,
          recent: recentHomework,
        },
        teacherNotes: teacherNotesPayload,
        nextSession: nextSessionPayload,
        subscription: subscriptionPayload,
        strongTopics,
        weakTopics,
        recentActivity,
      };
    })
  );

  return ok({
    parent: {
      id: parent.id,
      name: parent.user.name,
      email: parent.user.email,
      phone: parent.user.phone,
      avatarUrl: parent.user.avatarUrl,
    },
    children,
  });
}
