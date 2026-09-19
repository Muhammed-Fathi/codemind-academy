// POST /api/teacher/quizzes/[id]/duplicate — Phase G
//
// The "Duplicate / Create New Version" workflow: once the first attempt
// exists the original quiz's question blueprint is immutable, so the SAFE way
// to change the assessment is to copy it and edit the copy.
//
// WHAT IS COPIED — authoring only:
//   metadata (title/titleAr/description/passMark/timeLimit/trackScope),
//   the Phase 26D blueprint columns (mode/count/plan/shuffle/maxAttempts),
//   every question (prompt/options/answer/marks/difficulty/track tag), with
//   NEW ids, creation order preserved.
//
// WHAT IS NEVER COPIED — history stays with the original:
//   QuizAttempts, frozen QuizAnswers, QuizRetryGrants, scores/results. The
//   duplicate starts as an editable DRAFT with zero attempts; the original is
//   untouched (attempts, results and auditability all preserved).
//
// The title gets a "(نسخة)" / "(Copy)" suffix so the two quizzes are never
// confused in lists; renaming is the teacher's next edit.
//
// AUTHORIZATION: TEACHER role → quiz → lesson → course, canonical chain
// first, course must be one of the teacher's own. Audited `QUIZ_DUPLICATED`.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import {
  LESSON_PLACEMENT_SELECT,
  TEACHER_LIMITS,
  lessonPlacement,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";

/** Bounded "(Copy)" suffix that can never push a title past its limit. */
function copyTitle(title: string, suffix: string): string {
  const max = TEACHER_LIMITS.TITLE_MAX;
  const base = title.length + suffix.length > max
    ? title.slice(0, max - suffix.length)
    : title;
  return `${base}${suffix}`;
}

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
    include: {
      lesson: { select: LESSON_PLACEMENT_SELECT },
      questions: { orderBy: [{ createdAt: "asc" }, { id: "asc" }] },
    },
  });
  if (!quiz) return err(tApi("api.248"), 404);
  const placement = lessonPlacement((quiz.lesson ?? null) as ChainLesson | null);
  if (!placement || !teacherCourseIds(teacher).includes(placement.courseId)) {
    return err(tApi("api.180"), 403);
  }

  const suffixAr = tApi("api.347");
  const suffixEn = tApi("api.348");

  // ONE nested create: quiz + its copied questions. Attempts, answers and
  // retry grants are relations of the ORIGINAL quiz row and simply are not
  // part of this data — there is nothing to filter out, and therefore no way
  // for history to leak into the copy.
  const copy = await db.quiz.create({
    data: {
      lessonId: quiz.lessonId,
      trackScope: quiz.trackScope,
      title: copyTitle(quiz.title, suffixEn),
      titleAr: copyTitle(quiz.titleAr || quiz.title, suffixAr),
      description: quiz.description,
      passMark: quiz.passMark,
      timeLimit: quiz.timeLimit,
      order: quiz.order,
      // Blueprint copied verbatim — the point of duplication is an editable
      // new version of the SAME selection rule.
      quizMode: quiz.quizMode,
      questionCount: quiz.questionCount,
      maxAttempts: quiz.maxAttempts,
      shuffleOptions: quiz.shuffleOptions,
      difficultyPlan: quiz.difficultyPlan,
      // Phase G — the copy starts as an editable DRAFT.
      status: "DRAFT",
      questions: {
        create: quiz.questions.map((q) => ({
          type: q.type,
          prompt: q.prompt,
          promptAr: q.promptAr,
          options: q.options,
          answer: q.answer,
          explanation: q.explanation,
          difficulty: q.difficulty,
          marks: q.marks,
          schoolType: q.schoolType,
        })),
      },
    },
    include: { questions: { select: { id: true } } },
  });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "QUIZ_DUPLICATED",
        entity: "Quiz",
        entityId: copy.id,
        details: JSON.stringify({
          sourceQuizId: quiz.id,
          questionCount: quiz.questions.length,
        }),
      },
    })
    .catch(() => {});

  return ok({
    quiz: {
      id: copy.id,
      sourceQuizId: quiz.id,
      title: copy.title,
      titleAr: copy.titleAr,
      status: copy.status,
      questionCount: copy.questions.length,
      // Explicit zero-state: the copy has NO history of any kind.
      attemptsCount: 0,
      retryGrantsCount: 0,
    },
  });
}
