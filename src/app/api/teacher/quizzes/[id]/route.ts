// /api/teacher/quizzes/[id] — Phase 18 (+ Phase E metadata PATCH)
//
//   GET    — one quiz with its questions, lesson placement, track scope and
//            the per-question reference counts (frozen answers / FIXED pins)
//            the management UI needs before offering an edit or a delete.
//   PATCH  — Phase E: edit quiz METADATA (title, titleAr, description,
//            passMark, timeLimit, trackScope). Frozen attempts are never
//            recomputed; a trackScope move is refused once attempts exist and
//            must stay inside the lesson's scope and cover its questions.
//            Blueprint/randomization/retry architecture is NOT touched.
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
import { resolveContentTrackScope } from "@/lib/track-scope";
import {
  LESSON_PLACEMENT_SELECT,
  TEACHER_LIMITS,
  boundedText,
  isQuestionScopeWithinQuiz,
  loadQuestionReferences,
  lessonPlacement,
  lessonTrackScope,
  questionPayload,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";
import { acquireQuizDestructiveLock } from "@/lib/db-serialization";

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
        /** Phase G lifecycle — مسودة / منشور (+ publishedAt). */
        status: string;
        publishedAt: Date | null;
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
      status: true,
      publishedAt: true,
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

// PATCH /api/teacher/quizzes/[id] — Phase E: quiz METADATA edit.
//
// Editable: title · titleAr · description · passMark · timeLimit · trackScope.
// Deliberately NOT editable here: the blueprint (Phase 26D architecture),
// the lesson the quiz hangs off, the questions (they have their own owner
// routes with frozen-attempt locks).
//
// HISTORY SAFETY
//   * `passMark` / `timeLimit` apply to FUTURE attempts only — a finished
//     attempt's stored `score`/`percentage`/`passed` were frozen at submit
//     (server-side grading, Phase 5/26D) and are never recomputed here.
//   * `trackScope` moves the audience, so it is refused once ANY attempt
//     exists (api.321); before the first attempt it must still be contained
//     by the LESSON's scope (the Phase 12 rule) AND cover every existing
//     question (a narrower quiz must not orphan a wider question — api.322).
//
// AUTHORIZATION: same as GET/DELETE — TEACHER role, quiz → lesson → course
// (canonical chain first), course must be one of the teacher's own.
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

  const owned = await loadOwnedQuiz(id, teacherCourseIds(teacher));
  if (!owned.ok) {
    return err(
      owned.status === 404 ? tApi("api.248") : tApi("api.180"),
      owned.status
    );
  }

  const body = await req.json().catch(() => ({}));
  const data: Record<string, unknown> = {};

  if (body.title !== undefined) {
    const title = boundedText(body.title, TEACHER_LIMITS.TITLE_MAX, { required: true });
    if (!title.ok || !title.value) return err(tApi("api.177"), 400);
    data.title = title.value;
  }
  if (body.titleAr !== undefined) {
    const titleAr = boundedText(body.titleAr, TEACHER_LIMITS.TITLE_AR_MAX);
    if (!titleAr.ok) return err(tApi("api.177"), 400);
    data.titleAr = titleAr.value ?? (typeof data.title === "string" ? data.title : owned.quiz.title);
  }
  if (body.description !== undefined) {
    const description = boundedText(body.description, TEACHER_LIMITS.DESCRIPTION_MAX);
    if (!description.ok) return err(tApi("api.177"), 400);
    data.description = description.value;
  }
  if (body.passMark !== undefined) {
    const passMark = Number(body.passMark);
    if (
      !Number.isInteger(passMark) ||
      passMark < TEACHER_LIMITS.PASS_MARK_MIN ||
      passMark > TEACHER_LIMITS.PASS_MARK_MAX
    ) {
      return err(
        tApi("api.257", {
          p1: TEACHER_LIMITS.PASS_MARK_MIN,
          p2: TEACHER_LIMITS.PASS_MARK_MAX,
        }),
        400
      );
    }
    data.passMark = passMark;
  }
  if (body.timeLimit !== undefined) {
    const timeLimit =
      body.timeLimit === null || body.timeLimit === "" ? null : Number(body.timeLimit);
    if (
      timeLimit !== null &&
      (!Number.isInteger(timeLimit) ||
        timeLimit < TEACHER_LIMITS.TIME_LIMIT_MIN ||
        timeLimit > TEACHER_LIMITS.TIME_LIMIT_MAX)
    ) {
      return err(
        tApi("api.233", {
          p1: TEACHER_LIMITS.TIME_LIMIT_MIN,
          p2: TEACHER_LIMITS.TIME_LIMIT_MAX,
        }),
        400
      );
    }
    data.timeLimit = timeLimit;
  }
  if (body.trackScope !== undefined) {
    // loadOwnedQuiz may expose a null lesson typing-wise; a missing lesson
    // scope fails closed (INVALID_SCOPE → api.228) rather than guessing.
    const lessonScope = owned.lesson ? lessonTrackScope(owned.lesson) : null;
    const scope = resolveContentTrackScope(body.trackScope, lessonScope);
    if (!scope.ok) {
      return err(
        scope.reason === "OUT_OF_LESSON_SCOPE" ? tApi("api.243") : tApi("api.228"),
        400
      );
    }
    if (scope.scope !== owned.quiz.trackScope) {
      // Frozen-audience guard: an attempt was taken under the quiz's current
      // audience; moving that audience afterwards would tell a different
      // story about who could take the assessment those rows describe.
      const attempts = await db.quizAttempt.findMany({
        where: { quizId: id },
        select: { id: true },
        take: 1,
      });
      if (attempts.length > 0) return err(tApi("api.321"), 409);

      // Question-containment guard: every question already on the quiz must
      // fit inside the new scope (an ARABIC question cannot survive a
      // LANGUAGE quiz, and a track-tagged question cannot survive a narrow
      // scope in the opposite direction either).
      const questions = await db.question.findMany({
        where: { quizId: id },
        select: { schoolType: true },
      });
      const orphan = questions.some(
        (q) => !isQuestionScopeWithinQuiz(q.schoolType, scope.scope)
      );
      if (orphan) return err(tApi("api.322"), 409);
      data.trackScope = scope.scope;
    }
  }

  if (Object.keys(data).length === 0) return err(tApi("api.320"), 400);

  const updated = await db.quiz.update({
    where: { id },
    data,
    select: {
      id: true,
      lessonId: true,
      title: true,
      titleAr: true,
      description: true,
      passMark: true,
      timeLimit: true,
      trackScope: true,
      order: true,
    },
  });

  return ok({ quiz: updated });
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
  //
  // Phase 26D FIX (two parts) — one transaction, and a database-level lock as
  // its FIRST statement.
  //
  // This path is the more dangerous of the two: `Quiz -> Question -> QuizAnswer`
  // cascades TWO levels, so one delete can erase the frozen history of every
  // attempt ever taken on the quiz.
  //
  // A transaction alone did not close the race. Under PostgreSQL READ COMMITTED
  // the attempt count below is a bare SELECT, which takes no lock conflicting
  // with an INSERT into `QuizAnswer`; a concurrent `POST /start` could commit a
  // new attempt (and its frozen rows) after the count read zero, and this delete
  // would then cascade them away.
  //
  // Locking ONLY the Quiz row is also not sufficient, and is deliberately not
  // relied on: `QuizAnswer.questionId` references `Question`, not `Quiz`, so a
  // lock on the Quiz row does not conflict with the `QuizAnswer` insert at all.
  // Instead this route takes the SAME per-quiz advisory lock that
  // `POST /api/quizzes/[id]/start` takes before freezing an attempt, which
  // orders the two totally. See src/lib/db-serialization.ts.
  let questionCount: number;
  try {
    questionCount = await db.$transaction(async (tx) => {
      // MUST be first: acquiring it after the reads reopens the window.
      await acquireQuizDestructiveLock(tx, id);
      const attempts = await tx.quizAttempt.findMany({
        where: { quizId: id },
        select: { id: true },
      });
      if (attempts.length > 0) throw new QuizDeleteBlockedError("HAS_ATTEMPTS");

      const questions = await tx.question.findMany({
        where: { quizId: id },
        select: { id: true },
      });
      for (const q of questions) {
        const { references } = await loadQuestionReferences(q.id, tx);
        if (references.fixedExamPins > 0) throw new QuizDeleteBlockedError("FIXED_EXAM_PIN");
      }

      await tx.quiz.delete({ where: { id } });
      return questions.length;
    });
  } catch (e) {
    if (e instanceof QuizDeleteBlockedError) {
      return err(
        e.reason === "FIXED_EXAM_PIN" ? tApi("api.246") : tApi("api.249"),
        409
      );
    }
    throw e;
  }

  return ok({ deleted: true, id, questions: questionCount });
}

/** Carries the refusal reason out of the delete transaction. */
class QuizDeleteBlockedError extends Error {
  readonly reason: "HAS_ATTEMPTS" | "FIXED_EXAM_PIN";
  constructor(reason: "HAS_ATTEMPTS" | "FIXED_EXAM_PIN") {
    super(`quiz deletion blocked: ${reason}`);
    this.name = "QuizDeleteBlockedError";
    this.reason = reason;
  }
}
