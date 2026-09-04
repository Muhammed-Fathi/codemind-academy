import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Mock Exam API
// Generates randomized practice exams from Question Bank.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// GET /api/exams/mock?count=10&difficulty=EASY|MEDIUM|HARD|mixed&examType=MOCK|UNIT|MONTHLY|FINAL
export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.094"), 403);

  const url = new URL(req.url);
  const count = parseInt(url.searchParams.get("count") || "10", 10);
  const difficulty = url.searchParams.get("difficulty") || "mixed";
  const examType = url.searchParams.get("examType") || "MOCK";

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.095"), 404);

  // Pull all quiz questions + exam questions available to this student
  // (via their group's course lessons + exam questions)
  const courseId = await getStudentCourseId(student.id);
  if (!courseId) return err(tApi("api.096"), 400);

  // Get quiz questions from lessons in the course
  const lessons = await db.lesson.findMany({
    where: { topic: { unit: { part: { courseId } } } },
    select: { id: true },
  });
  const lessonIds = lessons.map((l) => l.id);

  const quizQuestions = await db.question.findMany({
    where: { quiz: { lessonId: { in: lessonIds } } },
    include: { quiz: { select: { lesson: { select: { titleAr: true, title: true } } } } },
  });

  // Get exam questions
  const examQuestions = await db.examQuestion.findMany({
    where: { lessonId: { in: lessonIds } },
    include: { lesson: { select: { titleAr: true, title: true } } },
  });

  // Combine all questions
  type Q = {
    id: string;
    type: string;
    prompt: string;
    promptAr: string | null;
    options: string;
    answer: string;
    explanation: string | null;
    difficulty: string;
    marks: number;
    source: string;
    lessonTitle: string;
  };
  const allQs: Q[] = [
    ...quizQuestions.map((q) => ({
      id: q.id,
      type: q.type,
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      difficulty: q.difficulty,
      marks: q.marks,
      source: "quiz",
      lessonTitle: q.quiz?.lesson?.titleAr || q.quiz?.lesson?.title || "",
    })),
    ...examQuestions.map((q) => ({
      id: q.id,
      type: "MCQ",
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: q.options,
      answer: q.answer,
      explanation: q.explanation,
      difficulty: q.difficulty,
      marks: q.marks,
      source: "exam",
      lessonTitle: q.lesson?.titleAr || q.lesson?.title || "",
    })),
  ];

  if (allQs.length === 0) {
    return ok({
      exam: null,
      message: tApi("api.097"),
    });
  }

  // Filter by difficulty if specified
  let pool = allQs;
  if (difficulty !== "mixed") {
    pool = allQs.filter((q) => q.difficulty === difficulty);
    if (pool.length === 0) pool = allQs; // fallback
  }

  // Shuffle + pick N
  const selected = shuffle(pool).slice(0, Math.min(count, pool.length));

  // Shuffle options within each question (MCQ only)
  const questions = selected.map((q) => {
    const opts: string[] = JSON.parse(q.options);
    let optsAr = opts;
    let answerIdx = parseInt(q.answer, 10);
    if (q.type === "MCQ" && !isNaN(answerIdx)) {
      const indexed = opts.map((opt, i) => ({ opt, correct: i === answerIdx }));
      const shuffled = shuffle(indexed);
      optsAr = shuffled.map((s) => s.opt);
      answerIdx = shuffled.findIndex((s) => s.correct);
    }
    return {
      id: q.id,
      type: q.type,
      prompt: q.promptAr || q.prompt,
      options: optsAr,
      correctIndex: answerIdx,
      explanation: q.explanation,
      difficulty: q.difficulty,
      marks: q.marks,
      source: q.source,
      lessonTitle: q.lessonTitle,
    };
  });

  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);
  const durationMin = Math.max(10, Math.ceil(questions.length * 1.5));

  return ok({
    exam: {
      examType,
      questionCount: questions.length,
      durationMin,
      totalMarks,
      questions,
    },
  });
}

// POST /api/exams/mock — submit exam answers, save attempt
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.094"), 403);

  const body = await req.json().catch(() => ({}));
  const { examType, durationMin, answers } = body as {
    examType?: string;
    durationMin?: number;
    answers: { questionId: string; selected: string; isCorrect: boolean; marks: number }[];
  };
  if (!answers || !Array.isArray(answers)) return err("Answers required", 400);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.095"), 404);

  const totalMarks = answers.reduce((s, a) => s + (a.marks || 0), 0);
  const score = answers.filter((a) => a.isCorrect).reduce((s, a) => s + (a.marks || 0), 0);
  const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;
  const passed = percentage >= 60;

  const attempt = await db.examAttempt.create({
    data: {
      studentId: student.id,
      examType: examType || "MOCK",
      questionCount: answers.length,
      durationMin: durationMin || 0,
      score,
      totalMarks,
      percentage,
      passed,
      answers: JSON.stringify(answers),
      finishedAt: new Date(),
    },
  });

  return ok({ attempt: { ...attempt, percentage, passed, score, totalMarks } });
}

async function getStudentCourseId(studentId: string): Promise<string | null> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    include: { group: { select: { courseId: true } } },
  });
  return student?.group?.courseId || null;
}
