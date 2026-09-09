import { getServerT } from "@/lib/i18n-server";
// GET  /api/teacher/quizzes — returns quizzes (filter by teacher's groups' course lessons)
//   For MVP: returns all quizzes for the teacher's courses with question count,
//   attempt count + average score.
// POST /api/teacher/quizzes — body: { lessonId, title, titleAr, description, passMark?, questions: [...] }
//   Creates a Quiz + its Questions. Returns the created quiz with questions.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import type { QuestionType, Difficulty } from "@prisma/client";
import {
  summarizeFinishedAttempts,
  difficultyBreakdownList,
  questionPerformance,
  weakestQuestions,
} from "@/lib/quiz-analytics";
import {
  normalizeTrackScope,
  parseQuestionSchoolTypeInput,
  resolveQuestionSchoolType,
} from "@/lib/track-scope";

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
        orderBy: [{ order: "asc" }, { title: "asc" }],
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              unit: {
                select: {
                  part: {
                    select: {
                      course: { select: { id: true, name: true, nameAr: true } },
                    },
                  },
                },
              },
              topic: {
                select: {
                  unit: {
                    select: {
                      part: {
                        select: {
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
    return {
      id: q.id,
      title: q.titleAr || q.title,
      titleRaw: q.title,
      titleAr: q.titleAr,
      description: q.description,
      passMark: q.passMark,
      timeLimit: q.timeLimit,
      lesson: q.lesson
        ? {
            id: q.lesson.id,
            title: q.lesson.titleAr || q.lesson.title,
            // Canonical chain first, legacy topic chain as fallback.
            course: (q.lesson.unit?.part.course ?? q.lesson.topic?.unit.part.course)
              ? {
                  id: (q.lesson.unit?.part.course ?? q.lesson.topic!.unit.part.course)
                    .id,
                  name:
                    (q.lesson.unit?.part.course ?? q.lesson.topic!.unit.part.course)
                      .nameAr ||
                    (q.lesson.unit?.part.course ?? q.lesson.topic!.unit.part.course)
                      .name,
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
  const title = String(body.title || "").trim();
  const titleAr = String(body.titleAr || "").trim() || title;
  const description = body.description ? String(body.description) : null;
  const passMark = Number(body.passMark ?? 60);
  const timeLimit = body.timeLimit ? Number(body.timeLimit) : null;
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

  // Phase 12 — the quiz's own track scope. REQUIRED to be valid when given;
  // absent means SHARED. A track-specific quiz on a SHARED lesson is the
  // intended way to serve different question banks to the two school types.
  const quizTrackScope =
    body.trackScope === undefined
      ? "SHARED"
      : normalizeTrackScope(body.trackScope);
  if (!quizTrackScope) return err(tApi("api.228"), 400);

  if (!lessonId) return err(tApi("api.176"), 400);
  if (!title) return err(tApi("api.177"), 400);
  if (questions.length === 0)
    return err(tApi("api.178"), 400);

  // Verify the lesson belongs to one of the teacher's courses — through the
  // canonical unit chain OR the legacy topic chain (canonical first), so a
  // quiz can be created on any lesson of the teacher's course regardless of
  // which chain attaches it.
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    include: {
      unit: { select: { part: { select: { courseId: true } } } },
      topic: {
        select: { unit: { select: { part: { select: { courseId: true } } } } },
      },
    },
  });
  if (!lesson) return err(tApi("api.179"), 404);
  const teacherCourseIds = teacher.groups.map((g) => g.courseId);
  const lessonCourseId =
    lesson.unit?.part.courseId ?? lesson.topic?.unit.part.courseId ?? null;
  if (!lessonCourseId || !teacherCourseIds.includes(lessonCourseId)) {
    return err(tApi("api.180"), 403);
  }

  // Validate each question
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    // Phase 12 — a supplied school type must be meaningful. Rejecting beats
    // silently storing SHARED, which would hand the question to BOTH tracks.
    if (!parseQuestionSchoolTypeInput(q.schoolType).ok) {
      return err(tApi("api.229"), 400);
    }
    if (!q.prompt || !q.prompt.trim()) {
      return err(tApi("api.181", { p1: i + 1 }), 400);
    }
    if (q.type === "TRUE_FALSE") {
      // OK — we set options to ["True","False"] automatically
    } else if (q.type === "MCQ" || !q.type) {
      if (!Array.isArray(q.options) || q.options.length < 2) {
        return err(tApi("api.182", { p1: i + 1 }), 400);
      }
      if (q.answer === undefined || q.answer === "") {
        return err(tApi("api.183", { p1: i + 1 }), 400);
      }
    } else {
      return err(tApi("api.184", { p1: q.type }), 400);
    }
  }

  const createdQuiz = await db.quiz.create({
    data: {
      lessonId,
      title,
      titleAr,
      description,
      passMark,
      timeLimit: timeLimit ?? null,
      order: 0,
      trackScope: quizTrackScope,
      questions: {
        create: questions.map((q) => {
          const type: QuestionType = q.type === "TRUE_FALSE" ? "TRUE_FALSE" : "MCQ";
          const options =
            type === "TRUE_FALSE"
              ? ["True", "False"]
              : q.options || [];
          // Phase 12 — EVERY created question gets an explicit school type.
          // Precedence (documented in src/lib/track-scope.ts):
          //   1. the author's explicit value (including explicit SHARED = null)
          //   2. the OWNING QUIZ's scope when it is track-specific
          //   3. SHARED (null)
          // Inheriting from the quiz rather than the lesson is deliberate: a
          // SHARED lesson may host both an ARABIC and a LANGUAGE quiz, and
          // inheriting the lesson would collapse that distinction.
          const parsed = parseQuestionSchoolTypeInput(q.schoolType);
          const questionSchoolType =
            parsed.ok && parsed.specified
              ? parsed.value
              : resolveQuestionSchoolType(undefined, quizTrackScope);
          return {
            type,
            prompt: q.prompt || "",
            promptAr: q.promptAr || null,
            options: JSON.stringify(options),
            answer: String(q.answer ?? "0"),
            explanation: q.explanation || null,
            difficulty: (q.difficulty as Difficulty) || "MEDIUM",
            marks: Number(q.marks ?? 1),
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
