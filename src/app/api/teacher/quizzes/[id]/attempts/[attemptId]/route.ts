// GET /api/teacher/quizzes/[id]/attempts/[attemptId] — Teacher review of ONE
// selected attempt. The nested quiz ID is reauthorized on every request, and
// the attempt query binds that exact attempt ID to that exact quiz ID.
//
// Read-only by design: this route exposes no retry/grant mutation. The shared
// inspection builder keeps answer keys hidden while an attempt is OPEN and
// returns the same frozen question/score/pass detail as the existing review
// contract once an attempt is terminal.

import { NextRequest } from "next/server";
import { getServerT } from "@/lib/i18n-server";
import { db } from "@/lib/db";
import { err, getTeacherProfile, ok, requireUser } from "@/lib/api";
import { buildAttemptInspection } from "@/lib/session-quiz";
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string; attemptId: string }> }
) {
  const tApi = await getServerT();
  const { id: quizId, attemptId } = await params;

  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err(tApi("api.154"), 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
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
  if (!quiz) return err(tApi("api.248"), 404);

  const lesson = (quiz.lesson ?? null) as ChainLesson | null;
  const placement = lessonPlacement(lesson);
  if (!placement) return err(tApi("api.248"), 404);
  if (!teacherCourseIds(teacher).includes(placement.courseId)) {
    return err(tApi("api.180"), 403);
  }

  // The composite predicate is the attempt-to-quiz authorization check. A real
  // attempt ID paired with a different quiz ID is indistinguishable from an
  // unknown attempt here and can never return that attempt's student or answers.
  const attempt = await db.quizAttempt.findFirst({
    where: { id: attemptId, quizId },
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
  if (!attempt) return err(tApi("api.248"), 404);

  const inspection = await buildAttemptInspection(attempt, {
    // The common builder forcibly disables this for an OPEN attempt.
    revealAnswerKey: true,
  });

  return ok({
    quiz: {
      id: quiz.id,
      title: quiz.title,
      titleAr: quiz.titleAr,
      passMark: quiz.passMark,
      quizMode: quiz.quizMode,
      questionCount: quiz.questionCount,
      maxAttempts: quiz.maxAttempts,
      course: {
        id: placement.courseId,
        name: placement.courseName,
        nameAr: placement.courseNameAr,
        academicLevel: placement.courseAcademicLevel,
      },
      lesson: lesson
        ? {
            id: lesson.id,
            officialCode: lesson.officialCode,
            title: lesson.title ?? "",
            titleAr: lesson.titleAr ?? null,
            courseId: placement.courseId,
          }
        : null,
    },
    attempt: {
      ...inspection,
      student: {
        id: attempt.student.id,
        name: attempt.student.user.name,
        email: attempt.student.user.email,
      },
    },
    canGrantRetry: false,
  });
}
