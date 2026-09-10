// /api/teacher/quizzes/[id] — Phase 18
//
//   GET    — one quiz with its questions, lesson placement, track scope and
//            the per-question reference counts (frozen answers / FIXED pins)
//            the management UI needs before offering an edit or a delete.
//   DELETE — remove the quiz, REFUSED once any attempt exists. A quiz delete
//            cascades into `Question` → `QuizAnswer`, which would destroy the
//            frozen set of every attempt taken on it; and a question pinned to
//            a FIXED mock exam must never be destroyed by a quiz delete. Both
//            are hard refusals, not warnings.
//
// AUTHORIZATION: TEACHER role → quiz → lesson → course, canonical chain first,
// course must be one of the teacher's own.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import {
  LESSON_PLACEMENT_SELECT,
  loadQuestionReferences,
  lessonPlacement,
  questionPayload,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";

async function loadOwnedQuiz(
  quizId: string,
  courseIds: readonly string[]
): Promise<
  | {
      ok: true;
      quiz: {
        id: string;
        title: string;
        titleAr: string;
        description: string | null;
        passMark: number;
        timeLimit: number | null;
        trackScope: unknown;
        order: number;
        lessonId: string;
      };
      lesson: ChainLesson | null;
      courseId: string;
    }
  | { ok: false; status: 403 | 404 }
> {
  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
    select: {
      id: true,
      title: true,
      titleAr: true,
      description: true,
      passMark: true,
      timeLimit: true,
      trackScope: true,
      order: true,
      lessonId: true,
      lesson: { select: LESSON_PLACEMENT_SELECT },
    },
  });
  if (!quiz) return { ok: false, status: 404 };
  const lesson = (quiz.lesson ?? null) as ChainLesson | null;
  const placement = lessonPlacement(lesson);
  if (!placement) return { ok: false, status: 404 };
  if (!courseIds.includes(placement.courseId)) return { ok: false, status: 403 };
  const { lesson: _omit, ...rest } = quiz;
  return { ok: true, quiz: rest, lesson, courseId: placement.courseId };
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const owned = await loadOwnedQuiz(id, teacherCourseIds(teacher));
  if (!owned.ok) {
    return err(
      owned.status === 404 ? tApi("api.248") : tApi("api.180"),
      owned.status
    );
  }

  // Deterministic question order — the same order the attempt freezes in
  // (creation order, id tie-break), so the management view and the frozen set
  // cannot disagree about which question is "question 3".
  const questions = await db.question.findMany({
    where: { quizId: id },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });

  // Reference counts per question, so the UI can disable Delete and the answer
  // key editor instead of discovering the guard from a 409. One pair of
  // queries per question, but the number of questions is bounded
  // (QUESTIONS_PER_QUIZ_MAX), and this is a management view, not a hot path.
  const withRefs = await Promise.all(
    questions.map(async (q) => {
      const { references, pins } = await loadQuestionReferences(q.id);
      return {
        ...questionPayload(q),
        references,
        mockExamPins: pins.filter((p) => p.selectionMode === "FIXED").length,
        canDelete: references.answers === 0 && references.fixedExamPins === 0,
        canEditAnswerKey:
          references.openAttempts === 0 && references.gradedAttempts === 0,
      };
    })
  );

  const attempts = await db.quizAttempt.findMany({
    where: { quizId: id },
    select: { id: true, finishedAt: true },
  });

  return ok({
    quiz: {
      ...owned.quiz,
      trackScope: owned.quiz.trackScope,
      lessonId: owned.quiz.lessonId,
    },
    courseId: owned.courseId,
    lesson: owned.lesson
      ? {
          id: owned.lesson.id,
          officialCode: owned.lesson.officialCode,
          trackScope: owned.lesson.trackScope,
          status: owned.lesson.status,
          curriculumStatus: owned.lesson.curriculumStatus,
        }
      : null,
    questions: withRefs,
    attempts: {
      total: attempts.length,
      open: attempts.filter((a) => a.finishedAt === null).length,
      finished: attempts.filter((a) => a.finishedAt !== null).length,
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const owned = await loadOwnedQuiz(id, teacherCourseIds(teacher));
  if (!owned.ok) {
    return err(
      owned.status === 404 ? tApi("api.248") : tApi("api.180"),
      owned.status
    );
  }

  // Two independent reasons a quiz may not be destroyed, checked before any
  // write so a refusal can never leave a half-deleted assessment behind.
  const attempts = await db.quizAttempt.findMany({
    where: { quizId: id },
    select: { id: true },
  });
  if (attempts.length > 0) return err(tApi("api.249"), 409);

  const questions = await db.question.findMany({
    where: { quizId: id },
    select: { id: true },
  });
  for (const q of questions) {
    const { references } = await loadQuestionReferences(q.id);
    if (references.fixedExamPins > 0) return err(tApi("api.246"), 409);
  }

  await db.quiz.delete({ where: { id } });
  return ok({ deleted: true, id, questions: questions.length });
}
