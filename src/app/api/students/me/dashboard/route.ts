import { getServerT, serverPick, serverLocale } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import { trackScopeWhere } from "@/lib/track-scope";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { getStudentSchoolType, syncStudentBatch } from "@/lib/enrollment";
// Phase C — the ONE Lesson Content Summary authority: the Continue Learning
// card describes its lesson's content through the same aggregation as the
// course tree and the lesson page.
import {
  buildLessonContentSummaries,
  toLessonContentPayload,
} from "@/lib/lesson-content";
import {
  EXCLUDE_ARCHIVED_LESSON,
  getCourseSessionProgress,
  getUnlockedLessonIds,
  orderCourseLessons,
} from "@/lib/session-progress";
import { evaluateStudentCatchup, toCatchupHoldView } from "@/lib/progression";
import { fetchStudentPayments } from "@/lib/payment-submission";
import { resolveStudentEntitlement } from "@/lib/subscription-entitlement";

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

  // Phase 12: every curriculum count and every content list on this dashboard
  // is sliced to the student's own track. `getStudentSchoolType` re-reads the
  // row rather than trusting whatever the profile helper happened to select,
  // so an unrecognised or missing value fails closed to SHARED-only.
  const viewerTrack = trackScopeWhere(await getStudentSchoolType(student.id));

  // ----- Course progress + last viewed lesson -----
  // Course progress runs over the ACTIVE curriculum universe (both chains,
  // archived history excluded): official lessons are unit-linked, legacy
  // history rows stay readable but no longer count toward the percentage.
  const groupMatch = { course: { groups: { some: { id: student.groupId || "_" } } } };
  // Phase 13: the lifecycle clause joins the archived one, so every count on
  // this dashboard is computed over the sessions that actually exist for the
  // student. A staged lesson is not a lesson "not yet done" — it is not in
  // their curriculum, and counting it would deflate the percentage and name a
  // session in `continueLesson` that no student can open.
  const fetchedLessons = await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      ...EXCLUDE_ARCHIVED_LESSON,
      ...viewerTrack,
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
  });

  // Phase 19: the display order is the ENGINE's deterministic curriculum
  // order (Course → Part → Unit → (Topic) → Lesson, canonical `unitId` chain
  // first when a lesson carries both links — the one rule every progression
  // surface applies). The previous Prisma `orderBy` walked the LEGACY topic
  // chain first, so a dual-linked official lesson could be offered out of
  // sequence relative to the engine the gating actually uses. Sorting in JS
  // through `orderCourseLessons` makes "what the dashboard offers next" and
  // "what the engine unlocks next" the same sequence by construction.
  const orderingCourseId = student.group?.course?.id ?? null;
  const lessons = orderingCourseId
    ? orderCourseLessons(fetchedLessons, orderingCourseId)
    : fetchedLessons;

  const totalLessons = lessons.length;

  // ----- Canonical completion (Phase H) -----
  // Dashboard counts agree with the course tree and the lesson page by
  // construction: the SAME engine evaluation, not the legacy
  // client-touchable `isCompleted` flag (which stays preserved for
  // historical aggregates — certificate, gamification, reports, exports).
  const engineCompleted = new Set<string>();
  const engineReasonByLesson = new Map<string, { reason: string | null; reasonCode: string | null; unmet: { kind: string; label?: string | null }[]; state: string }>();
  {
    const engineCourseId = student.group?.course?.id ?? null;
    if (engineCourseId && student.group?.isActive) {
      const sessionProgress = await getCourseSessionProgress(student.id, engineCourseId);
      for (const row of sessionProgress.sessions) {
        // EFFECTIVE completion: `completed` is the historical fact, `state`
        // the access truth — a factually complete but locked lesson is not
        // currently done and counts nowhere as complete.
        if (row.completed && row.unlocked) engineCompleted.add(row.lessonId);
        engineReasonByLesson.set(row.lessonId, {
          reason: row.reason ?? null,
          reasonCode: row.reasonCode ?? null,
          unmet: row.unmet ?? [],
          state: row.state ?? (row.completed ? "COMPLETED" : row.unlocked ? "UNLOCKED" : "LOCKED"),
        });
      }
    }
  }
  const completedLessons = lessons.filter((l) =>
    engineCompleted.has(l.id)
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
  // (Phase H: canonical completion, same engine as the tree).
  const firstIncomplete = lessons.find(
    (l) => isOpen(l.id) && !engineCompleted.has(l.id)
  );

  const continueLesson =
    lastViewed?.lesson ||
    firstIncomplete ||
    lessons.find((l) => isOpen(l.id)) ||
    null;

  // ----- Phase C: Continue Learning content summary (the shared authority) -----
  // continueLesson is always an UNLOCKED session (the guard above), so the
  // lesson gate is already satisfied; the summary itself aggregates in the
  // student's own audience (school type + batch — the same lazy-reconcile
  // rule the session-video list uses) from ONE targeted load of the lesson's
  // content rows. Same authority, same numbers, as the course tree badges
  // and the lesson workspace. The legacy `videoUrl` field below stays a
  // documented compatibility surface (its behavioral pins predate Phase C).
  let continueLessonContent: Awaited<
    ReturnType<typeof toLessonContentPayload>
  > = null;
  if (continueLesson) {
    const contentRows = await db.lesson.findUnique({
      where: { id: continueLesson.id },
      select: {
        id: true,
        videoUrl: true,
        pdfUrl: true,
        quizzes: { select: { id: true, trackScope: true, status: true } },
        homeworks: { select: { id: true, trackScope: true, status: true } },
        materials: {
          where: { isActive: true },
          select: {
            id: true,
            title: true,
            kind: true,
            trackScope: true,
            isActive: true,
            mediaAssetId: true,
            media: { select: { mimeType: true, sizeBytes: true } },
          },
        },
      },
    });
    if (contentRows) {
      const summaries = await buildLessonContentSummaries({
        lessons: [contentRows],
        viewer: {
          role: "STUDENT",
          schoolType: await getStudentSchoolType(student.id),
          batchId: student.batchId || (await syncStudentBatch(student.id)),
        },
      });
      continueLessonContent = toLessonContentPayload(
        summaries.get(continueLesson.id) ?? null
      );
    }
  }

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
      // Phase G — DRAFT assignments are authoring-only: never listed, never
      // counted as pending. CLOSED stays listed (the student still sees the
      // closed assignment and its grade; only NEW submissions stop).
      status: { in: ["PUBLISHED", "CLOSED"] },
      // Phase 12: an assignment belonging to the other school type must not be
      // listed here — this endpoint returns the row and its lesson title, so
      // leaving it unfiltered was an outright cross-track content leak.
      ...viewerTrack,
      lesson: {
        // Phase 13: the lifecycle clause mirrors the unlocked-set post-filter
        // below (`isOpen`), so the SQL and the engine state can never
        // disagree about which assignments exist for this student.
        ...LESSON_STUDENT_STATUS_FILTER,
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

  // ----- Subscription status (Phase 25 PR2a: TRUTHFUL entitlement) -----
  // THE REGRESSION THIS BLOCK PREVENTS: the pre-25 fallback labeled ANY
  // unrecognized state (a fresh PENDING request, a CANCELLED row) as
  // "ACTIVE" — presenting a payment request as a paid entitlement. The label
  // now comes from the single entitlement policy:
  //   PENDING row        -> "PENDING"  (a request under review, never "Active")
  //   ACTIVE, endDate past -> "EXPIRED" (lazy expiry; nothing is written)
  //   CANCELLED / none   -> "NONE"     (no live paid entitlement)
  //   grouped + no row   -> "NONE" here, while `grandfathered: true` and the
  //                        central access gate keep their legacy content
  //                        access — the dashboard never claims a PAID state
  //                        that does not exist.
  // The pending/rejected REQUESTS are surfaced separately from the
  // entitlement so PR3 can render "under review" without ever conflating the
  // two. (Data contract only — the visual redesign is PR3's scope.)
  const [entitlement, paymentRequests] = await Promise.all([
    resolveStudentEntitlement(student.id),
    fetchStudentPayments(db, user.id),
  ]);
  const rawState = entitlement?.state ?? "NONE";
  const subscriptionStatus: "ACTIVE" | "EXPIRING" | "PENDING" | "EXPIRED" | "NONE" =
    rawState === "ACTIVE" || rawState === "EXPIRING" || rawState === "PENDING" || rawState === "EXPIRED"
      ? rawState
      : "NONE";
  const subscriptionEnd: Date | null = entitlement?.endDate ?? null;
  const daysToExpiry = entitlement?.daysToExpiry ?? 0;
  const compactRequest = (p: Awaited<ReturnType<typeof fetchStudentPayments>>["latestPending"]) =>
    p
      ? {
          id: p.id,
          amount: p.amount,
          method: p.method,
          reference: p.reference,
          senderPhone: p.senderPhone,
          requestedPlan: p.requestedPlan,
          requestedGroup: p.requestedGroup,
          createdAt: p.createdAt,
          duplicateReference: p.duplicateReference,
        }
      : null;

  // Canonical chain first (official lessons are unit-linked); legacy
  // topic chain as fallback. Either may be null for chain-less rows.
  const continuePart =
    continueLesson?.unit?.part ?? continueLesson?.topic?.unit.part ?? null;
  const continueUnit =
    continueLesson?.unit ?? continueLesson?.topic?.unit ?? null;

  // ----- Absence catch-up plan (Phase H) -----
  // Deterministic, read-only: every ACTIVE hold with its missed lesson, its
  // own unmet requirements (Arabic reason + structured codes) and whether it
  // is eligible for resolution. The dashboard banner + the recovery CTA
  // render from this; resolution itself is POST /api/students/me/catchup.
  const { holds: rawCatchupHolds } = await evaluateStudentCatchup(student.id);
  // The public view only (labeled unmet, no internal Phase F ids) — the same
  // serializer the catch-up route uses, so dashboard and plan agree.
  const catchupHolds = rawCatchupHolds.map(toCatchupHoldView);

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
    // Phase H — absence catch-up plan (empty when no ACTIVE hold exists).
    catchup: {
      holds: catchupHolds,
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
          // Phase H: canonical completion + the Arabic reason/unmet so the
          // Continue card names the exact next action.
          isCompleted: engineCompleted.has(continueLesson.id),
          progression: engineReasonByLesson.get(continueLesson.id) ?? null,
          // continueLesson is always an unlocked session now; the guard is
          // belt-and-braces so a future refactor cannot re-leak a media URL.
          videoUrl: isOpen(continueLesson.id) ? continueLesson.videoUrl : null,
          // Phase C — content summary from the shared authority (audience-
          // isolated states + counts). Aligned with the course tree and the
          // lesson workspace; replaces no progression data.
          content: continueLessonContent,
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
      planName: entitlement?.plan?.nameAr || entitlement?.plan?.name || null,
      // Phase 25 PR2a server-truth additions (PR3 owns the visual UX):
      /** Raw stored Subscription.status (never relabeled), null if no row. */
      rawStatus: entitlement?.subscriptionStatus ?? null,
      /** Whether the paid-content gate CURRENTLY opens for this student. */
      accessAllowed: entitlement?.accessAllowed ?? false,
      /** Legacy access without a Subscription row (paid-state stays NONE). */
      grandfathered: entitlement?.grandfathered ?? false,
      hasSubscription: entitlement?.hasSubscription ?? false,
    },
    /** The REQUEST side of the model, kept separate from the entitlement. */
    paymentRequests: {
      pending: compactRequest(paymentRequests.latestPending),
      rejected: paymentRequests.latestRejected
        ? {
            id: paymentRequests.latestRejected.id,
            amount: paymentRequests.latestRejected.amount,
            method: paymentRequests.latestRejected.method,
            reference: paymentRequests.latestRejected.reference,
            rejectionReason: paymentRequests.latestRejected.rejectionReason,
            reviewedAt: paymentRequests.latestRejected.reviewedAt,
            createdAt: paymentRequests.latestRejected.createdAt,
            requestedPlan: paymentRequests.latestRejected.requestedPlan,
            requestedGroup: paymentRequests.latestRejected.requestedGroup,
          }
        : null,
    },
    recentActivity,
  });
}
