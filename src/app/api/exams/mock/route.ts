import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Mock Exam API
// Generates randomized practice exams from Question Bank.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { normalizeSchoolType, questionBankFilter } from "@/lib/school-type";
import { getEnrollment } from "@/lib/enrollment";

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
  let count = parseInt(url.searchParams.get("count") || "10", 10);
  let difficulty = url.searchParams.get("difficulty") || "mixed";
  const examType = url.searchParams.get("examType") || "MOCK";
  const mockExamId = url.searchParams.get("mockExamId");

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.095"), 404);

  // Enrollment is enforced server-side: an unenrolled student gets no exam.
  const enrollment = await getEnrollment(student.id);
  if (!enrollment.isEnrolled || !enrollment.courseId)
    return err(tApi("api.096"), 400);
  const courseId = enrollment.courseId;

  // The student's school type decides WHICH question bank is used. It comes
  // from the database (Student.schoolType), never from the client.
  const studentSchoolType = normalizeSchoolType(student.schoolType);
  if (!studentSchoolType) return err(tApi("api.210"), 400);

  // Optional: a specific admin-defined exam. It must match the student's type.
  let mockExam = null as Awaited<ReturnType<typeof db.mockExam.findUnique>> | null;
  if (mockExamId) {
    mockExam = await db.mockExam.findUnique({ where: { id: mockExamId } });
    if (!mockExam || !mockExam.isPublished) return err(tApi("api.211"), 404);
    if (mockExam.schoolType !== studentSchoolType)
      return err(tApi("api.212"), 403);
    count = mockExam.questionCount;
    difficulty = mockExam.difficulty === "MIXED" ? "mixed" : mockExam.difficulty;
  }

  // Bank isolation: only questions tagged with the student's school type, or
  // explicitly shared (schoolType = null), can ever be selected.
  const bankFilter = questionBankFilter(studentSchoolType);

  // Get quiz questions from lessons in the course
  const lessons = await db.lesson.findMany({
    where: { topic: { unit: { part: { courseId } } } },
    select: { id: true },
  });
  const lessonIds = lessons.map((l) => l.id);

  // FIXED exams use their pinned set; RANDOM exams sample the matching bank.
  const pinnedIds =
    mockExam && mockExam.selectionMode === "FIXED"
      ? (
          await db.mockExamQuestion.findMany({
            where: { mockExamId: mockExam.id },
            orderBy: { order: "asc" },
            select: { questionId: true, examQuestionId: true },
          })
        )
      : null;

  const quizQuestions = await db.question.findMany({
    where: pinnedIds
      ? {
          id: { in: pinnedIds.map((p) => p.questionId).filter(Boolean) as string[] },
          ...bankFilter,
        }
      : { quiz: { lessonId: { in: lessonIds } }, ...bankFilter },
    include: { quiz: { select: { lesson: { select: { titleAr: true, title: true } } } } },
  });

  // Get exam questions (same bank isolation applies)
  const examQuestions = await db.examQuestion.findMany({
    where: pinnedIds
      ? {
          id: {
            in: pinnedIds.map((p) => p.examQuestionId).filter(Boolean) as string[],
          },
          ...bankFilter,
        }
      : { lessonId: { in: lessonIds }, ...bankFilter },
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
  const durationMin =
    mockExam?.durationMin ?? Math.max(10, Math.ceil(questions.length * 1.5));

  return ok({
    exam: {
      mockExamId: mockExam?.id ?? null,
      title: mockExam ? mockExam.title : null,
      titleAr: mockExam ? mockExam.titleAr : null,
      schoolType: studentSchoolType,
      examType,
      questionCount: questions.length,
      durationMin,
      passMark: mockExam?.passMark ?? 60,
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
  const { examType, durationMin, answers, mockExamId } = body as {
    examType?: string;
    durationMin?: number;
    mockExamId?: string | null;
    answers: { questionId: string; selected: string; isCorrect: boolean; marks: number }[];
  };
  if (!answers || !Array.isArray(answers)) return err("Answers required", 400);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.095"), 404);
  const studentSchoolType = normalizeSchoolType(student.schoolType);

  // Re-grade on the server from the stored answer keys: the client-sent
  // `isCorrect` / `marks` values are never trusted for scoring.
  const questionIds = answers.map((a) => a.questionId).filter(Boolean);

  // Bank isolation applies to GRADING as well as to selection. Without this,
  // a crafted submission could reference questions from the other school's
  // bank and have them graded into the attempt, polluting school-type
  // reporting. Out-of-bank ids simply fail the keyById lookup below and score
  // 0, exactly like an unknown id.
  // A student with no school type recorded has NO bank of their own. Falling
  // back to `{}` here would have disabled isolation entirely for exactly the
  // accounts we know least about, so those submissions are graded against the
  // SHARED questions only (`schoolType: null`). GET already refuses to serve an
  // exam to such a student (400, api.210), so this path is unreachable in the
  // normal flow and only ever narrows what a crafted submission can reach.
  const gradingBankFilter = studentSchoolType
    ? questionBankFilter(studentSchoolType)
    : { schoolType: null };
  const [bankQuestions, bankExamQuestions] = await Promise.all([
    db.question.findMany({
      where: { id: { in: questionIds }, ...gradingBankFilter },
      select: { id: true, answer: true, marks: true, options: true },
    }),
    db.examQuestion.findMany({
      where: { id: { in: questionIds }, ...gradingBankFilter },
      select: { id: true, answer: true, marks: true, options: true },
    }),
  ]);
  const keyById = new Map<string, { answer: string; marks: number; options: string }>();
  for (const q of [...bankQuestions, ...bankExamQuestions]) {
    keyById.set(q.id, { answer: q.answer, marks: q.marks, options: q.options });
  }

  const graded = answers.map((a) => {
    const key = keyById.get(a.questionId);
    if (!key) {
      // Unknown question id — score it as 0 rather than trusting the client.
      return { ...a, isCorrect: false, marks: 0 };
    }
    // The client shuffles option order, so it reports the SELECTED TEXT.
    let isCorrect = false;
    try {
      const opts: string[] = JSON.parse(key.options);
      const correctText = opts[parseInt(key.answer, 10)];
      isCorrect =
        String(a.selected) === String(key.answer) ||
        (correctText !== undefined && String(a.selected) === correctText);
    } catch {
      isCorrect = String(a.selected) === String(key.answer);
    }
    return { ...a, isCorrect, marks: key.marks };
  });

  // A mock exam may only be attributed to an exam of the student's own type.
  let linkedExamId: string | null = null;
  if (mockExamId) {
    const exam = await db.mockExam.findUnique({ where: { id: mockExamId } });
    if (exam && exam.schoolType === studentSchoolType) linkedExamId = exam.id;
  }
  const passMark = linkedExamId
    ? (await db.mockExam.findUnique({ where: { id: linkedExamId }, select: { passMark: true } }))
        ?.passMark ?? 60
    : 60;

  const totalMarks = graded.reduce((s, a) => s + (a.marks || 0), 0);
  const score = graded.filter((a) => a.isCorrect).reduce((s, a) => s + (a.marks || 0), 0);
  const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;
  const passed = percentage >= passMark;

  const attempt = await db.examAttempt.create({
    data: {
      studentId: student.id,
      mockExamId: linkedExamId,
      schoolType: studentSchoolType,
      examType: examType || "MOCK",
      questionCount: graded.length,
      durationMin: durationMin || 0,
      score,
      totalMarks,
      percentage,
      passed,
      // Immutable snapshot: results survive later question edits/deletions.
      answers: JSON.stringify(graded),
      finishedAt: new Date(),
    },
  });

  return ok({ attempt: { ...attempt, percentage, passed, score, totalMarks } });
}
