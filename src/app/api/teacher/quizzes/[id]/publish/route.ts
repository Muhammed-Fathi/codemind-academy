// POST /api/teacher/quizzes/[id]/publish — Phase G
//
// The ONLY path by which a quiz becomes student-visible:
//   DRAFT → PUBLISHED, and ONLY when structurally valid.
// PUBLISHED → PUBLISHED is an idempotent no-op (double publish is safe).
//
// Publish validation REUSES the Phase 26D authority (it does not re-invent
// it): every stored question is re-run through the shared question validator,
// the blueprint through `validateBlueprintInput`-equivalent resolution, and
// the selection rule is DRY-RUN against the live pool for EVERY track the
// quiz serves (`selectAttemptQuestions`). A quiz that could not produce a
// real paper for some served track cannot be published.
//
// On success: status=PUBLISHED, publishedAt stamped, `QUIZ_PUBLISHED`
// audited, and eligible students get the preference-aware NEW_QUIZ
// notification (deduped by UNIQUE(userId, dedupeKey)).
//
// AUTHORIZATION: TEACHER role → quiz → lesson → course, canonical chain
// first, course must be one of the teacher's own.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";
import {
  publishProblemMessage,
  validateQuizForPublish,
} from "@/lib/quiz-lifecycle";
import { notifyAssessmentPublished } from "@/lib/assessment-notifications";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const quiz = await db.quiz.findUnique({
    where: { id },
    include: { lesson: { select: LESSON_PLACEMENT_SELECT } },
  });
  if (!quiz) return err(tApi("api.248"), 404);
  const placement = lessonPlacement((quiz.lesson ?? null) as ChainLesson | null);
  if (!placement || !teacherCourseIds(teacher).includes(placement.courseId)) {
    return err(tApi("api.180"), 403);
  }

  // Idempotent replay — a second click never errors and never re-notifies.
  if (quiz.status === "PUBLISHED") {
    return ok({
      quiz: { id: quiz.id, status: quiz.status, publishedAt: quiz.publishedAt },
      alreadyPublished: true,
    });
  }

  const questions = await db.question.findMany({
    where: { quizId: id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  const check = validateQuizForPublish({
    quiz: {
      quizMode: quiz.quizMode,
      questionCount: quiz.questionCount,
      difficultyPlan: quiz.difficultyPlan,
      shuffleOptions: quiz.shuffleOptions,
      maxAttempts: quiz.maxAttempts,
      trackScope: quiz.trackScope,
    },
    questions,
  });
  if (!check.ok) {
    // 409 — the quiz EXISTS but is not publishable; the problems list tells
    // the teacher exactly what to fix (rendered localized, never raw codes).
    return NextResponse.json(
      {
        error: tApi("api.340"),
        problems: check.problems.map((p) => ({
          code: p.code,
          questionIndex: p.questionIndex,
          track: p.track ?? null,
          message: publishProblemMessage(tApi, p),
        })),
      },
      { status: 409 }
    );
  }

  const now = new Date();
  const updated = await db.quiz.update({
    where: { id },
    data: { status: "PUBLISHED", publishedAt: now },
  });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "QUIZ_PUBLISHED",
        entity: "Quiz",
        entityId: id,
        details: JSON.stringify({
          questionCount: questions.length,
          quizMode: quiz.quizMode,
        }),
      },
    })
    .catch(() => {});

  const notified = await notifyAssessmentPublished({
    kind: "QUIZ",
    id,
    title: tApi("api.345", { p1: updated.titleAr || updated.title }),
    message: tApi("api.346"),
    courseId: placement.courseId,
    trackScope: updated.trackScope,
  });

  return ok({
    quiz: {
      id: updated.id,
      status: updated.status,
      publishedAt: updated.publishedAt,
    },
    notified,
  });
}
