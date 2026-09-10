import { getServerT } from "@/lib/i18n-server";
// /api/teacher/quizzes
//
//   GET  — the quizzes of the teacher's own courses, with Phase 6 analytics
//          (FINISHED attempts only, attempt-weighted, deterministic order) and
//          the Phase 18 track split.
//   POST — create a Quiz + its Questions on one of the teacher's own lessons.
//
// AUTHORIZATION (both paths): authenticated → TEACHER role → own courses from
// `Group.courseId` → the lesson's course through the CANONICAL
// `Course → Part → Unit → Lesson` chain, legacy Topic chain as fallback.
//
// PHASE 18 CHANGES
//   * input limits on every author-supplied field (title, description, pass
//     mark, time limit, question count) — see TEACHER_LIMITS;
//   * track scope resolved through `resolveContentTrackScope`, so an absent
//     scope INHERITS the lesson's instead of defaulting to SHARED (which would
//     widen a track-specific lesson's new content by omission) and an
//     out-of-lesson scope is refused rather than stored;
//   * ARCHIVED lessons take no new quizzes;
//   * questions are validated by the SHARED validator
//     (`validateQuestionDraft`) that the append-question route also uses, so a
//     question cannot be legal in one write path and illegal in the other;
//   * GET exposes the lesson's canonical placement (officialCode / part /
//     unit / trackScope / lifecycle) and a per-quiz track split of the same
//     finished-attempt data — no new aggregation path, no UI redesign.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import type { QuestionType, Difficulty } from "@prisma/client";
import {
  summarizeFinishedAttempts,
  summarizeFinishedAttemptsByTrack,
  difficultyBreakdownList,
  questionPerformance,
  weakestQuestions,
} from "@/lib/quiz-analytics";
import {
  normalizeTrackScope,
  parseQuestionSchoolTypeInput,
  resolveContentTrackScope,
  resolveQuestionSchoolType,
} from "@/lib/track-scope";
import {
  LESSON_PLACEMENT_SELECT,
  TEACHER_LIMITS,
  boundedText,
  isArchivedLesson,
  lessonPlacement,
  lessonTrackScope,
  questionValidationMessage,
  teacherCourseIds,
  validateQuestionDraft,
  type ChainLesson,
  type ValidatedQuestion,
  lessonStamp,
} from "@/lib/teacher-content";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const url = new URL(req.url);
  const groupId = url.searchParams.get("groupId") || "";
  const courseIds = teacher.groups
    .filter((g) => !groupId || g.id === groupId)
    .map((g) => g.courseId);

  if (courseIds.length === 0) return ok({ quizzes: [] });

  // BOTH curriculum chains — canonical (unit-linked) lessons carry their
  // course through `Lesson.unitId`, legacy lessons through `Lesson.topicId`.
  // A topic-only query would hide every canonical lesson's quizzes from the
  // teacher, and those quizzes would be unmanageable.
  const lessons = await db.lesson.findMany({
    where: {
      OR: [
        { unit: { part: { courseId: { in: courseIds } } } },
        { topic: { unit: { part: { courseId: { in: courseIds } } } } },
      ],
    },
    select: { id: true },
  });
  const lessonIds = lessons.map((l) => l.id);

  const quizzes = lessonIds.length
    ? await db.quiz.findMany({
        where: { lessonId: { in: lessonIds } },
        orderBy: [{ order: "asc" }, { title: "asc" }, { id: "asc" }],
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              unitId: true,
              topicId: true,
              officialCode: true,
              trackScope: true,
              status: true,
              curriculumStatus: true,
              unit: {
                select: {
                  id: true,
                  title: true,
                  titleAr: true,
                  part: {
                    select: {
                      id: true,
                      title: true,
                      titleAr: true,
                      course: { select: { id: true, name: true, nameAr: true } },
                    },
                  },
                },
              },
              topic: {
                select: {
                  unit: {
                    select: {
                      id: true,
                      title: true,
                      titleAr: true,
                      part: {
                        select: {
                          id: true,
                          title: true,
                          titleAr: true,
                          course: { select: { id: true, name: true, nameAr: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          questions: { select: { id: true, marks: true } },
          attempts: {
            // Phase 6: teacher analytics must reflect FINISHED attempts only.
            // An open attempt is ungraded (its stored percentage is still the
            // pre-submit default) and would drag the average and pass rate
            // down. Difficulty / question analytics are derived from the
            // persisted QuizAnswer rows of these finished attempts.
            where: { finishedAt: { not: null } },
            select: {
              quizId: true,
              percentage: true,
              passed: true,
              studentId: true,
              score: true,
              totalMarks: true,
              finishedAt: true,
              // Phase 18 — the STUDENT's own track, used only to SLICE the
              // existing finished-only aggregate. Nothing about which attempts
              // count changes: this is a grouping key, not a filter.
              student: { select: { schoolType: true } },
              answers: {
                select: {
                  isCorrect: true,
                  question: { select: { id: true, difficulty: true } },
                },
              },
            },
          },
        },
      })
    : [];

  const quizzesPayload = quizzes.map((q) => {
    const totalMarks = q.questions.reduce((s, x) => s + (x.marks || 0), 0);
    // Phase 6: deterministic analytics over FINISHED attempts only (see
    // src/lib/quiz-analytics.ts for the documented aggregation rules).
    const summary = summarizeFinishedAttempts(q.attempts);
    const answerData = q.attempts.flatMap((a) =>
      (a.answers || []).map((ans) => ({
        questionId: ans.question.id,
        isCorrect: ans.isCorrect,
        difficulty: ans.question.difficulty,
      }))
    );
    const difficulty = difficultyBreakdownList(answerData);
    const questionsAnalytics = questionPerformance(answerData);
    const weakQuestions = weakestQuestions(questionsAnalytics, 1, 5);
    // Phase 18 — the SAME finished-only, attempt-weighted summary, cut by the
    // answering student's track. `summarizeFinishedAttemptsByTrack` re-uses
    // `summarizeFinishedAttempts` per bucket, so a bucket can never disagree
    // with the overall number it was split from.
    const trackSummary = summarizeFinishedAttemptsByTrack(
      q.attempts,
      (a) => a.student?.schoolType
    );
    // Canonical chain first, legacy topic chain as fallback.
    const lessonUnit = q.lesson?.unit ?? q.lesson?.topic?.unit ?? null;
    const lessonPart = lessonUnit?.part ?? null;
    const lessonCourse = lessonPart?.course ?? null;
    return {
      id: q.id,
      title: q.titleAr || q.title,
      titleRaw: q.title,
      titleAr: q.titleAr,
      description: q.description,
      passMark: q.passMark,
      timeLimit: q.timeLimit,
      // Phase 12/18 — the quiz's own eligibility, surfaced so the teacher sees
      // what they configured instead of inferring it from the lesson.
      trackScope: normalizeTrackScope(q.trackScope) ?? "SHARED",
      // The lesson stamp is SHARED with the picker (teacher-content.ts), so the
      // list the teacher picks from and the list they manage can never disagree
      // about officialCode / trackScope / lifecycle.
      lesson: q.lesson
        ? {
            ...lessonStamp(q.lesson),
            chain: q.lesson.unit ? "CANONICAL" : q.lesson.topic ? "LEGACY" : null,
            part: lessonPart
              ? { id: lessonPart.id, title: lessonPart.titleAr || lessonPart.title }
              : null,
            unit: lessonUnit
              ? { id: lessonUnit.id, title: lessonUnit.titleAr || lessonUnit.title }
              : null,
            course: lessonCourse
              ? {
                  id: lessonCourse.id,
                  name: lessonCourse.nameAr || lessonCourse.name,
                }
              : null,
          }
        : null,
      questionCount: q.questions.length,
      totalMarks,
      attemptsCount: summary.attemptCount,
      // Kept under the pre-existing name for UI compatibility: it is the
      // rounded mean percentage over FINISHED attempts (previously it averaged
      // every attempt, open ones included, which deflated the number).
      avgScore: summary.avgPercentage,
      passedCount: summary.passCount,
      passRate: summary.passRate,
      difficulty: difficulty.map((d) => ({
        difficulty: d.difficulty,
        attempts: d.attempts,
        correctPercent: d.correctPercent,
      })),
      weakQuestions: weakQuestions.map((w) => ({
        questionId: w.questionId,
        difficulty: w.difficulty,
        attempts: w.attempts,
        correctPercent: w.correctPercent,
      })),
      /**
       * Track split of the SAME finished attempts. Always all three buckets,
       * in SHARED → ARABIC → LANGUAGE order (deterministic rendering), each
       * carrying the Phase 6 summary shape.
       */
      trackSummary: {
        SHARED: trackSummary.SHARED,
        ARABIC: trackSummary.ARABIC,
        LANGUAGE: trackSummary.LANGUAGE,
      },
    };
  });

  return ok({ quizzes: quizzesPayload });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const body = await req.json().catch(() => ({}));
  const lessonId = String(body.lessonId || "");
  const titleIn = boundedText(body.title, TEACHER_LIMITS.TITLE_MAX, {
    required: true,
  });
  if (!titleIn.ok || !titleIn.value) return err(tApi("api.177"), 400);
  const title = titleIn.value;
  const titleArIn = boundedText(body.titleAr, TEACHER_LIMITS.TITLE_AR_MAX);
  if (!titleArIn.ok) return err(tApi("api.177"), 400);
  const titleAr = titleArIn.value || title;
  const descriptionIn = boundedText(body.description, TEACHER_LIMITS.DESCRIPTION_MAX);
  if (!descriptionIn.ok) return err(tApi("api.177"), 400);
  const description = descriptionIn.value;

  // Pass mark and time limit are validated, never clamped silently: a value
  // outside the contract is a client bug, and guessing it would hide the bug
  // behind a quiz that behaves differently from what was requested.
  const passMarkRaw = body.passMark === undefined ? 60 : Number(body.passMark);
  if (
    !Number.isInteger(passMarkRaw) ||
    passMarkRaw < TEACHER_LIMITS.PASS_MARK_MIN ||
    passMarkRaw > TEACHER_LIMITS.PASS_MARK_MAX
  ) {
    return err(
      tApi("api.257", {
        p1: TEACHER_LIMITS.PASS_MARK_MIN,
        p2: TEACHER_LIMITS.PASS_MARK_MAX,
      }),
      400
    );
  }
  const timeLimitRaw =
    body.timeLimit === undefined || body.timeLimit === null || body.timeLimit === ""
      ? null
      : Number(body.timeLimit);
  if (
    timeLimitRaw !== null &&
    (!Number.isInteger(timeLimitRaw) ||
      timeLimitRaw < TEACHER_LIMITS.TIME_LIMIT_MIN ||
      timeLimitRaw > TEACHER_LIMITS.TIME_LIMIT_MAX)
  ) {
    return err(
      tApi("api.233", {
        p1: TEACHER_LIMITS.TIME_LIMIT_MIN,
        p2: TEACHER_LIMITS.TIME_LIMIT_MAX,
      }),
      400
    );
  }
  const timeLimit = timeLimitRaw;

  const questions: Array<{
    type?: QuestionType;
    prompt?: string;
    promptAr?: string;
    options?: string[];
    answer?: string;
    explanation?: string;
    difficulty?: Difficulty;
    marks?: number;
    /** Phase 12: explicit per-question school type. Absent = inherit. */
    schoolType?: string | null;
  }> = Array.isArray(body.questions) ? body.questions : [];

  if (!lessonId) return err(tApi("api.176"), 400);
  if (questions.length === 0) return err(tApi("api.178"), 400);
  if (questions.length > TEACHER_LIMITS.QUESTIONS_PER_QUIZ_MAX) {
    return err(tApi("api.250", { p1: TEACHER_LIMITS.QUESTIONS_PER_QUIZ_MAX }), 400);
  }

  // Verify the lesson belongs to one of the teacher's courses — through the
  // canonical unit chain OR the legacy topic chain (canonical first), so a
  // quiz can be created on any lesson of the teacher's course regardless of
  // which chain attaches it. ONE query returns both chains plus the lifecycle
  // and track metadata the rest of the handler needs.
  const lessonRow = await db.lesson.findUnique({
    where: { id: lessonId },
    select: LESSON_PLACEMENT_SELECT,
  });
  if (!lessonRow) return err(tApi("api.179"), 404);
  const lesson = lessonRow as ChainLesson;
  // Canonical chain first, legacy Topic chain as the fallback. Written out
  // rather than hidden inside a helper because THIS is the ownership check the
  // Phase 11/12 suites pin, and because "which course does this lesson belong
  // to" must be readable in the route that trusts it. The shared helpers in
  // src/lib/teacher-content.ts (used by the Phase 18 write routes) apply the
  // identical rule.
  const lessonCourseId =
    lesson.unit?.part.courseId ?? lesson.topic?.unit.part.courseId ?? null;
  const teacherCourseIdsResolved = teacherCourseIds(teacher);
  if (!lessonCourseId || !teacherCourseIdsResolved.includes(lessonCourseId)) {
    return err(tApi("api.180"), 403);
  }

  // Phase 18 — no NEW assessment content on an ARCHIVED lesson (Phase 11's
  // rule for AI-generated questions, applied consistently). Editing or
  // deleting what already exists stays possible.
  if (isArchivedLesson(lesson)) {
    return err(tApi("api.242"), 409);
  }
  const placement = lessonPlacement(lesson);

  // Phase 12 — the quiz's own track scope. Phase 18 resolves it through the
  // shared containment rule: an explicit value must be contained by the
  // lesson's scope, and an ABSENT one inherits the lesson's scope instead of
  // defaulting to SHARED. A track-specific quiz on a SHARED lesson remains the
  // intended way to serve different question banks to the two school types.
  const scope = resolveContentTrackScope(
    body.trackScope,
    lessonTrackScope(lesson)
  );
  if (!scope.ok) {
    return err(
      scope.reason === "OUT_OF_LESSON_SCOPE" ? tApi("api.243") : tApi("api.228"),
      400
    );
  }
  const quizTrackScope = scope.scope;

  // Validate each question with the SHARED validator, so the create path and
  // the append path cannot disagree about legality.
  const validatedQuestions: ValidatedQuestion[] = [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    // Phase 12 — a supplied school type must be meaningful. Rejecting beats
    // silently storing SHARED, which would hand the question to BOTH tracks.
    // (The shared validator below re-checks it; this parse is kept as the
    // explicit Phase 12 contract at the top of the loop.)
    if (!parseQuestionSchoolTypeInput(q.schoolType).ok) {
      return err(tApi("api.229"), 400);
    }
    const validated = validateQuestionDraft(q, quizTrackScope);
    if (!validated.ok) {
      return err(
        questionValidationMessage(tApi, validated.reason, i + 1),
        400
      );
    }
    validatedQuestions.push(validated.question);
  }

  const createdQuiz = await db.quiz.create({
    data: {
      lessonId,
      title,
      titleAr,
      description,
      passMark: passMarkRaw,
      timeLimit: timeLimit ?? null,
      order: 0,
      trackScope: quizTrackScope,
      questions: {
        create: validatedQuestions.map((q) => {
          // Phase 12 — EVERY created question gets an explicit school type.
          // Precedence (documented in src/lib/track-scope.ts):
          //   1. the author's explicit value (including explicit SHARED = null)
          //   2. the OWNING QUIZ's scope when it is track-specific
          //   3. SHARED (null)
          // Inheriting from the quiz rather than the lesson is deliberate: a
          // SHARED lesson may host both an ARABIC and a LANGUAGE quiz, and
          // inheriting the lesson would collapse that distinction.
          const questionSchoolType = q.schoolTypeInherited
            ? resolveQuestionSchoolType(undefined, quizTrackScope)
            : q.schoolType;
          return {
            type: q.type,
            prompt: q.prompt,
            promptAr: q.promptAr,
            options: JSON.stringify(q.options),
            answer: q.answer,
            explanation: q.explanation,
            difficulty: q.difficulty,
            marks: q.marks,
            schoolType: questionSchoolType,
          };
        }),
      },
    },
    include: { questions: true },
  });

  return ok({
    quiz: {
      id: createdQuiz.id,
      lessonId: createdQuiz.lessonId,
      title: createdQuiz.title,
      titleAr: createdQuiz.titleAr,
      description: createdQuiz.description,
      passMark: createdQuiz.passMark,
      timeLimit: createdQuiz.timeLimit,
      trackScope: createdQuiz.trackScope,
      /** True when the scope came from the request, false when inherited. */
      trackScopeExplicit: !scope.inherited,
      lesson: placement
        ? {
            id: lesson.id,
            officialCode: lesson.officialCode,
            title: placement.unitTitle,
            part: placement.partTitle,
            unit: placement.unitTitle,
            course: placement.courseName,
            chain: placement.chain,
            trackScope: lessonTrackScope(lesson),
            status: lesson.status,
            curriculumStatus: lesson.curriculumStatus,
          }
        : null,
      questions: createdQuiz.questions.map((q) => ({
        id: q.id,
        type: q.type,
        prompt: q.prompt,
        promptAr: q.promptAr,
        options: JSON.parse(q.options),
        answer: q.answer,
        explanation: q.explanation,
        difficulty: q.difficulty,
        marks: q.marks,
        schoolType: q.schoolType,
      })),
    },
  });
}
