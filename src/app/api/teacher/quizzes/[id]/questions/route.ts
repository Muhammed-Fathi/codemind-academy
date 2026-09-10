// POST /api/teacher/quizzes/[id]/questions — Phase 18
//
// Append ONE question to an existing quiz of the teacher's own course.
//
// Why it exists: quiz creation already accepts a question array, but a quiz
// could only ever be authored in a single shot — a teacher who spotted a gap
// after the fact had to recreate the quiz, which is impossible once students
// hold attempts (a new quiz id invalidates their frozen sets and the
// progression rule keyed to the old one). Appending is the additive write, and
// it is safe by construction:
//
//   * the NEW question joins FUTURE attempts only — an existing attempt's
//     frozen set is the `QuizAnswer` rows seeded at its creation, so nothing
//     already running changes (Phase 5, unchanged);
//   * the quiz's own track scope is the ceiling for the question's tag
//     (`isQuestionScopeWithinQuiz`), so an unreachable tag is refused;
//   * an ARCHIVED lesson takes no NEW content (api.242) — management of what
//     exists stays possible through PATCH/DELETE on the question itself.
//
// AUTHORIZATION: TEACHER role → quiz → lesson → course, CANONICAL chain first,
// course must be one of the teacher's own (never a body-supplied id).

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import { resolveQuestionSchoolType } from "@/lib/track-scope";
import {
  LESSON_PLACEMENT_SELECT,
  TEACHER_LIMITS,
  isArchivedLesson,
  lessonPlacement,
  questionPayload,
  questionValidationMessage,
  teacherCourseIds,
  validateQuestionDraft,
  type ChainLesson,
} from "@/lib/teacher-content";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const quiz = await db.quiz.findUnique({
    where: { id },
    select: {
      id: true,
      trackScope: true,
      lesson: { select: LESSON_PLACEMENT_SELECT },
    },
  });
  if (!quiz) return err(tApi("api.248"), 404);

  const lesson = (quiz.lesson ?? null) as ChainLesson | null;
  const placement = lessonPlacement(lesson);
  if (!placement || !teacherCourseIds(teacher).includes(placement.courseId)) {
    return err(tApi("api.180"), 403);
  }
  if (lesson && isArchivedLesson(lesson)) return err(tApi("api.242"), 409);

  const existing = await db.question.count({ where: { quizId: id } });
  if (existing >= TEACHER_LIMITS.QUESTIONS_PER_QUIZ_MAX) {
    return err(tApi("api.250", { p1: TEACHER_LIMITS.QUESTIONS_PER_QUIZ_MAX }), 409);
  }

  const body = await req.json().catch(() => ({}));
  const validated = validateQuestionDraft(body, quiz.trackScope);
  if (!validated.ok) {
    return err(questionValidationMessage(tApi, validated.reason), 400);
  }
  const v = validated.question;

  // Phase 12 precedence, preserved verbatim: an explicit tag wins; otherwise
  // the question inherits the OWNING QUIZ's track when that quiz is
  // track-specific; otherwise SHARED. The containment check above has already
  // refused a tag the quiz cannot reach.
  const schoolType = v.schoolTypeInherited
    ? resolveQuestionSchoolType(undefined, quiz.trackScope)
    : v.schoolType;

  const created = await db.question.create({
    data: {
      quizId: id,
      type: v.type,
      prompt: v.prompt,
      promptAr: v.promptAr,
      options: JSON.stringify(v.options),
      answer: v.answer,
      explanation: v.explanation,
      difficulty: v.difficulty,
      marks: v.marks,
      schoolType,
    },
  });

  return ok({
    question: questionPayload(created),
    quizId: id,
    lesson: lesson
      ? {
          id: lesson.id,
          officialCode: lesson.officialCode,
          trackScope: lesson.trackScope,
          status: lesson.status,
          curriculumStatus: lesson.curriculumStatus,
        }
      : null,
    /** Total questions now in the quiz (bounded by QUESTIONS_PER_QUIZ_MAX). */
    questionCount: existing + 1,
  });
}
