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
            select: { percentage: true, passed: true },
          },
        },
      })
    : [];

  const quizzesPayload = quizzes.map((q) => {
    const totalMarks = q.questions.reduce((s, x) => s + (x.marks || 0), 0);
    const avg =
      q.attempts.length > 0
        ? Math.round(
            q.attempts.reduce((s, a) => s + a.percentage, 0) /
              q.attempts.length
          )
        : 0;
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
      attemptsCount: q.attempts.length,
      avgScore: avg,
      passedCount: q.attempts.filter((a) => a.passed).length,
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
  }> = Array.isArray(body.questions) ? body.questions : [];

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
      questions: {
        create: questions.map((q) => {
          const type: QuestionType = q.type === "TRUE_FALSE" ? "TRUE_FALSE" : "MCQ";
          const options =
            type === "TRUE_FALSE"
              ? ["True", "False"]
              : q.options || [];
          return {
            type,
            prompt: q.prompt || "",
            promptAr: q.promptAr || null,
            options: JSON.stringify(options),
            answer: String(q.answer ?? "0"),
            explanation: q.explanation || null,
            difficulty: (q.difficulty as Difficulty) || "MEDIUM",
            marks: Number(q.marks ?? 1),
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
      })),
    },
  });
}
