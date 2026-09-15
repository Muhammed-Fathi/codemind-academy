// GET /api/teacher/quizzes/[id]/attempts — Phase 26D attempt inspection (TEACHER).
//
// A teacher may inspect the attempts of a quiz that belongs to a course they
// teach, and nothing else. Scope is resolved from the teacher's OWN
// `Group.courseId` rows and the quiz's canonical lesson chain — never from a
// request parameter — so there is no foreign-quiz IDOR to attempt.
//
// WHAT A TEACHER DELIBERATELY DOES NOT GET
//   * No retry authority. There is no POST here and no teacher route anywhere
//     that creates a `QuizRetryGrant`; granting an extra attempt is Admin-only
//     by design (see /api/admin/quiz-retries). A teacher can SEE that an attempt
//     was permitted by a grant, and cannot issue one.
//   * No answer key for an OPEN attempt — the same rule the Admin detail route
//     follows, enforced in the one shared builder.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { buildAttemptInspection } from "@/lib/session-quiz";
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id } = await params;

  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err(tApi("api.154"), 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const quiz = await db.quiz.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      titleAr: true,
      passMark: true,
      quizMode: true,
      questionCount: true,
      maxAttempts: true,
      lesson: { select: LESSON_PLACEMENT_SELECT },
    },
  });
  // Unknown quiz → 404. A real quiz outside this teacher's courses → 403.
  // Same key pair the other teacher quiz routes use (api.248 / api.180), so the
  // two statuses are distinguishable without leaking another course's content.
  if (!quiz) return err(tApi("api.248"), 404);

  const placement = lessonPlacement(quiz.lesson as ChainLesson | null);
  if (!placement) return err(tApi("api.248"), 404);
  const courseIds = teacherCourseIds(teacher);
  if (!courseIds.includes(placement.courseId)) return err(tApi("api.180"), 403);

  const attempts = await db.quizAttempt.findMany({
    where: { quizId: id },
    orderBy: [{ studentId: "asc" }, { attemptNumber: "asc" }],
    select: {
      id: true,
      quizId: true,
      studentId: true,
      attemptNumber: true,
      status: true,
      startedAt: true,
      finishedAt: true,
      score: true,
      totalMarks: true,
      percentage: true,
      passed: true,
      retryGrantId: true,
      student: { select: { id: true, user: { select: { name: true, email: true } } } },
    },
  });

  const detailed = await Promise.all(
    attempts.map((a) =>
      buildAttemptInspection(a, { revealAnswerKey: true })
    )
  );

  return ok({
    quiz: {
      id: quiz.id,
      title: quiz.titleAr || quiz.title,
      passMark: quiz.passMark,
      quizMode: quiz.quizMode,
      questionCount: quiz.questionCount,
      maxAttempts: quiz.maxAttempts,
      course: {
        id: placement.courseId,
        name: placement.courseNameAr || placement.courseName,
      },
    },
    /**
     * Truthful attempt accounting: every attempt is reported, including the ones
     * an Admin permitted. Nothing is collapsed to "best attempt" here — the
     * aggregation policy lives in the analytics service, not in an inspector.
     */
    attempts: detailed.map((inspection, i) => ({
      ...inspection,
      student: {
        id: attempts[i].student.id,
        name: attempts[i].student.user.name,
        email: attempts[i].student.user.email,
      },
    })),
    /** Explicit reminder that this surface is read-only for retries. */
    canGrantRetry: false,
  });
}
