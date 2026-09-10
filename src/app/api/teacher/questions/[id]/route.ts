// /api/teacher/questions/[id] — Phase 18 question management.
//
//   GET    — the question, its owning quiz/lesson/course and its REFERENCE
//            COUNTS (frozen answers, open attempts, graded attempts, FIXED
//            mock-exam pins) so the UI can disable a destructive action
//            instead of discovering the refusal from a 409.
//   PATCH  — safe edit (see the lock table in src/lib/teacher-content.ts).
//   DELETE — refused while the question is referenced (frozen attempt history
//            or a FIXED mock-exam pin).
//
// FROZEN-ATTEMPT SAFETY (the reason this route is so strict)
//   The attempt's question set is frozen as `QuizAnswer` rows at attempt
//   creation (Phase 5) — but the frozen rows pin the question's ID and its
//   `selected`/`isCorrect` verdicts, NOT its text or answer key. Serving and
//   grading read the LIVE `Question` row. Therefore:
//     * editing `answer`/`options`/`type`/`marks` while an attempt is open
//       changes a running assessment, and after a finish it makes the stored
//       score disagree with the key the student is shown → refused;
//     * editing `schoolType` changes which frozen answers the attempt loader
//       keeps → refused while any answer row exists;
//     * deleting the row CASCADES into `QuizAnswer` (onDelete: Cascade), which
//       would silently rewrite every attempt that ever included it → refused
//       while referenced.
//   Prompt/explanation/difficulty stay editable: they cannot change what was
//   graded (difficulty re-labelling historical analytics is documented Phase 6
//   behaviour).
//
// AUTHORIZATION: TEACHER role → the question's quiz → quiz's lesson → lesson's
// course (CANONICAL chain first) must be one of the teacher's own courses.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import type { Question } from "@prisma/client";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import {
  LESSON_PLACEMENT_SELECT,
  canDeleteQuestion,
  isArchivedLesson,
  lessonPlacement,
  loadQuestionReferences,
  questionEditGuards,
  questionPayload,
  questionValidationMessage,
  teacherCourseIds,
  validateQuestionDraft,
  type ChainLesson,
} from "@/lib/teacher-content";

type QuizOwnership = {
  quiz: { id: string; title: string; titleAr: string; trackScope: string };
  lesson: ChainLesson | null;
  courseId: string | null;
};

/**
 * Resolve the question's owning quiz AND prove the teacher owns the course it
 * hangs from — through the canonical chain first. Returns `null` when the
 * question does not exist (so every refusal below is a 404/403, never a leak
 * of another teacher's content).
 */
async function loadOwnedQuestion(
  questionId: string,
  courseIds: readonly string[]
): Promise<
  | { ok: true; question: Question; owner: QuizOwnership }
  | { ok: false; status: 403 | 404; reason: "NOT_FOUND" | "NOT_OWNED" | "NO_CHAIN" }
> {
  const question = await db.question.findUnique({ where: { id: questionId } });
  if (!question) return { ok: false, status: 404, reason: "NOT_FOUND" };
  // A question with no quiz is a bank row, not session content: it is not a
  // teacher-managed resource (the admin bank owns those) and it has no course
  // to authorize against.
  if (!question.quizId) return { ok: false, status: 403, reason: "NO_CHAIN" };

  const quiz = await db.quiz.findUnique({
    where: { id: question.quizId },
    select: {
      id: true,
      title: true,
      titleAr: true,
      trackScope: true,
      lesson: { select: LESSON_PLACEMENT_SELECT },
    },
  });
  if (!quiz) return { ok: false, status: 404, reason: "NOT_FOUND" };

  const lesson = (quiz.lesson ?? null) as ChainLesson | null;
  const placement = lessonPlacement(lesson);
  if (!placement) return { ok: false, status: 404, reason: "NO_CHAIN" };
  if (!courseIds.includes(placement.courseId)) {
    return { ok: false, status: 403, reason: "NOT_OWNED" };
  }

  return {
    ok: true,
    question,
    owner: {
      quiz: {
        id: quiz.id,
        title: quiz.title,
        titleAr: quiz.titleAr,
        trackScope: String(quiz.trackScope),
      },
      lesson,
      courseId: placement.courseId,
    },
  };
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

  const owned = await loadOwnedQuestion(id, teacherCourseIds(teacher));
  if (!owned.ok) {
    return err(owned.status === 404 ? tApi("api.244") : tApi("api.180"), owned.status);
  }

  const { references, pins } = await loadQuestionReferences(id);
  const guards = canDeleteQuestion(references);

  return ok({
    question: questionPayload(owned.question),
    quiz: owned.owner.quiz,
    lesson: owned.owner.lesson
      ? {
          id: owned.owner.lesson.id,
          officialCode: owned.owner.lesson.officialCode,
          trackScope: owned.owner.lesson.trackScope,
          status: owned.owner.lesson.status,
          curriculumStatus: owned.owner.lesson.curriculumStatus,
        }
      : null,
    /** Deletion + edit guards, computed server-side (never in the client). */
    references,
    mockExamPins: pins,
    canDelete: guards.allowed,
    deleteBlockers: guards.blockers,
    canEditAnswerKey: references.openAttempts === 0 && references.gradedAttempts === 0,
  });
}

export async function PATCH(
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

  const owned = await loadOwnedQuestion(id, teacherCourseIds(teacher));
  if (!owned.ok) {
    return err(owned.status === 404 ? tApi("api.244") : tApi("api.180"), owned.status);
  }

  const body = await req.json().catch(() => ({}));

  // Which fields did the caller actually touch? `undefined` means "leave it";
  // an explicit value (including null) means "set it". Only touched fields are
  // subject to the frozen-attempt locks.
  const patch: Record<string, unknown> = {};
  for (const key of [
    "type",
    "prompt",
    "promptAr",
    "options",
    "answer",
    "explanation",
    "difficulty",
    "marks",
    "schoolType",
  ] as const) {
    if (body[key] !== undefined) patch[key] = body[key];
  }
  if (Object.keys(patch).length === 0) return err(tApi("api.244"), 400);

  const { references } = await loadQuestionReferences(id);
  const guard = questionEditGuards(references, patch);
  if (!guard.allowed) {
    return err(tApi("api.245"), 409);
  }

  // Validate the MERGED draft: a prompt-only edit must not have to restate the
  // options, but a changed option list must still answer to the same rules.
  const current = owned.question;
  const merged = {
    type: patch.type ?? current.type,
    prompt: patch.prompt ?? current.prompt,
    promptAr: patch.promptAr !== undefined ? patch.promptAr : current.promptAr,
    options:
      patch.options !== undefined ? patch.options : safeOptions(current.options),
    answer: patch.answer !== undefined ? patch.answer : current.answer,
    explanation:
      patch.explanation !== undefined ? patch.explanation : current.explanation,
    difficulty: patch.difficulty ?? current.difficulty,
    marks: patch.marks ?? current.marks,
    schoolType: patch.schoolType !== undefined ? patch.schoolType : undefined,
  };

  const validated = validateQuestionDraft(
    merged,
    owned.owner.quiz.trackScope
  );
  if (!validated.ok) {
    return err(questionValidationMessage(tApi, validated.reason), 400);
  }
  const v = validated.question;

  const data: Record<string, unknown> = {
    type: v.type,
    prompt: v.prompt,
    promptAr: v.promptAr,
    options: JSON.stringify(v.options),
    answer: v.answer,
    explanation: v.explanation,
    difficulty: v.difficulty,
    marks: v.marks,
  };
  // `schoolType` is only rewritten when the caller supplied one: an omitted
  // field must never silently re-tag an existing question (that is exactly the
  // "no silent inference" rule of the phase).
  if (patch.schoolType !== undefined) data.schoolType = v.schoolType;

  const updated = await db.question.update({ where: { id }, data });

  return ok({
    question: questionPayload(updated),
    references,
    /** Fields that were refused by the frozen-attempt lock, if any. */
    lockedFields: [] as string[],
    lesson: owned.owner.lesson
      ? {
          id: owned.owner.lesson.id,
          officialCode: owned.owner.lesson.officialCode,
          curriculumStatus: owned.owner.lesson.curriculumStatus,
          archived: isArchivedLesson(owned.owner.lesson),
        }
      : null,
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

  const owned = await loadOwnedQuestion(id, teacherCourseIds(teacher));
  if (!owned.ok) {
    return err(owned.status === 404 ? tApi("api.244") : tApi("api.180"), owned.status);
  }

  const { references } = await loadQuestionReferences(id);
  const guard = canDeleteQuestion(references);
  if (!guard.allowed) {
    // Two distinct messages: a FIXED-exam pin is an admin decision (the exam
    // definition must not shrink), while frozen attempts are assessment
    // history. The response carries the counters so the caller can explain
    // both, deterministically.
    const fixPin = guard.blockers.includes("FIXED_EXAM_PIN");
    return err(
      fixPin ? tApi("api.246") : tApi("api.247"),
      409
    );
  }

  await db.question.delete({ where: { id } });
  return ok({ deleted: true, id, references });
}

/** Parse a stored options blob defensively (legacy rows may be malformed). */
function safeOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((o) => String(o)) : [];
  } catch {
    return [];
  }
}
