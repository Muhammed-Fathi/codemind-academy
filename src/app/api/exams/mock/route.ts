import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Mock Exam API
// Generates randomized practice exams from Question Bank.
import { NextRequest } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { normalizeSchoolType, questionBankFilter } from "@/lib/school-type";
import { getEnrollment } from "@/lib/enrollment";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const EXAM_TYPES = ["UNIT", "MONTHLY", "MOCK", "FINAL"] as const;
const MAX_EXAM_QUESTIONS = 100;
// A submission carries one row per served question; the cap only bounds
// crafted payloads (GET never serves more than MAX_EXAM_QUESTIONS).
const MAX_SUBMITTED_ANSWERS = 200;

function normalizeExamType(value: unknown): string {
  return typeof value === "string" && (EXAM_TYPES as readonly string[]).includes(value)
    ? value
    : "MOCK";
}

function normalizeDifficulty(value: unknown): string {
  return value === "EASY" || value === "MEDIUM" || value === "HARD"
    ? value
    : "mixed";
}

// GET /api/exams/mock?count=10&difficulty=EASY|MEDIUM|HARD|mixed&examType=MOCK|UNIT|MONTHLY|FINAL
export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.094"), 403);

  const url = new URL(req.url);
  // Client-supplied count is untrusted: clamp it into a sane range. (A linked
  // admin exam overrides it with its own configured count below.)
  const rawCount = parseInt(url.searchParams.get("count") || "10", 10);
  let count = Math.min(
    MAX_EXAM_QUESTIONS,
    Math.max(1, Number.isNaN(rawCount) ? 10 : rawCount)
  );
  let difficulty = normalizeDifficulty(url.searchParams.get("difficulty"));
  const examType = normalizeExamType(url.searchParams.get("examType"));
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
    // A course-bound exam is invisible outside that course. 404 (not 403) so
    // the response never confirms a foreign course's exam exists.
    if (mockExam.courseId && mockExam.courseId !== courseId)
      return err(tApi("api.211"), 404);
    count = mockExam.questionCount;
    difficulty = mockExam.difficulty === "MIXED" ? "mixed" : mockExam.difficulty;
  }

  // Bank isolation: only questions tagged with the student's school type, or
  // explicitly shared (schoolType = null), can ever be selected.
  const bankFilter = questionBankFilter(studentSchoolType);

  // Get quiz questions from lessons in the course — BOTH chains: canonical
  // unit-linked lessons and legacy topic-linked lessons. Phase 5 minimal
  // compatibility fix: a topic-only pool silently excluded every canonical
  // lesson's questions from mock exams. Grading (POST) is id-based and
  // unaffected; nothing else about mock exams changes.
  // Phase 13: the pool is the student universe, so a question that belongs to
  // a session an admin has staged but not opened can never be served into a
  // mock exam. Without this clause the retired `isPublished` flag — which no
  // longer gates anything — would be the only barrier, and staged material
  // would reach students through the back door of the shared question bank.
  // NOTE: this route does not exclude ARCHIVED lessons and still does not:
  // that is Phase 11's deliberate scope choice for the exam pool, not a
  // lifecycle question, so it is left untouched here.
  const lessons = await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      OR: [
        { unit: { part: { courseId } } },
        { topic: { unit: { part: { courseId } } } },
      ],
    },
    select: { id: true },
  });
  const lessonIds = lessons.map((l) => l.id);

  // FIXED exams use their pinned set; RANDOM exams sample the matching bank.
  const isFixedExam = !!mockExam && mockExam.selectionMode === "FIXED";
  const pinned =
    mockExam && isFixedExam
      ? await db.mockExamQuestion.findMany({
          where: { mockExamId: mockExam.id },
          orderBy: { order: "asc" },
          select: { questionId: true, examQuestionId: true, order: true },
        })
      : null;

  const quizQuestions = await db.question.findMany({
    where: pinned
      ? {
          id: { in: pinned.map((p) => p.questionId).filter(Boolean) as string[] },
          ...bankFilter,
        }
      : { quiz: { lessonId: { in: lessonIds } }, ...bankFilter },
    include: { quiz: { select: { lesson: { select: { titleAr: true, title: true } } } } },
  });

  // Get exam questions (same bank isolation applies)
  const examQuestions = await db.examQuestion.findMany({
    where: pinned
      ? {
          id: {
            in: pinned.map((p) => p.examQuestionId).filter(Boolean) as string[],
          },
          ...bankFilter,
        }
      : { lessonId: { in: lessonIds }, ...bankFilter },
    include: { lesson: { select: { titleAr: true, title: true } } },
  });

  // Combine all questions.
  //
  // NOTE: this draft carries NO answer key. The stored `answer` / explanation
  // stay on the server; the client receives prompts + shuffled options only,
  // and learns correctness from the POST review payload after submitting.
  // Shipping the key here would let any student read every correct answer
  // from the network tab before answering.
  type Q = {
    id: string;
    type: string;
    prompt: string;
    promptAr: string | null;
    options: string;
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

  let selected: Q[];
  if (pinned) {
    // FIXED contract: serve the pinned set AS-IS — every pinned in-bank
    // question, in pinned `order`. No difficulty filter, no shuffle, no
    // slicing: re-requesting the same exam yields the same questions in the
    // same order, and pins can never silently fall out of the set.
    const orderOf = new Map<string, number>();
    for (const p of pinned) {
      if (p.questionId) orderOf.set(p.questionId, p.order);
      if (p.examQuestionId) orderOf.set(p.examQuestionId, p.order);
    }
    selected = allQs
      .filter((q) => orderOf.has(q.id))
      .sort((a, b) => (orderOf.get(a.id) as number) - (orderOf.get(b.id) as number));
  } else {
    // RANDOM contract: filter by difficulty if specified, then shuffle the
    // pool server-side and serve up to `count`. Every request re-samples —
    // there is no server-side in-progress state; the attempt is created
    // atomically at submit (POST), so a refresh before submitting simply
    // drafts a fresh set.
    let pool = allQs;
    if (difficulty !== "mixed") {
      pool = allQs.filter((q) => q.difficulty === difficulty);
      if (pool.length === 0) pool = allQs; // fallback
    }

    // Shuffle + pick N
    selected = shuffle(pool).slice(0, Math.min(count, pool.length));
  }

  // Shuffle options within each question (MCQ only). Positional information
  // is meaningless to the grader — the client answers with the selected
  // option TEXT and POST re-grades against the stored key.
  const questions = selected.map((q) => {
    const opts: string[] = JSON.parse(q.options);
    const optsAr = q.type === "MCQ" ? shuffle(opts) : opts;
    return {
      id: q.id,
      type: q.type,
      prompt: q.promptAr || q.prompt,
      options: optsAr,
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
  const { examType: rawExamType, durationMin: rawDurationMin, answers, mockExamId } = body as {
    examType?: string;
    durationMin?: number;
    mockExamId?: string | null;
    answers: { questionId: string; selected: string; isCorrect: boolean; marks: number }[];
  };
  if (!answers || !Array.isArray(answers)) return err("Answers required", 400);
  if (answers.length > MAX_SUBMITTED_ANSWERS) return err("Too many answers", 400);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.095"), 404);
  const studentSchoolType = normalizeSchoolType(student.schoolType);

  // Same enrollment gate as GET: a crafted submission from an unenrolled
  // student must not create attempt history.
  const enrollment = await getEnrollment(student.id);
  if (!enrollment.isEnrolled || !enrollment.courseId)
    return err(tApi("api.096"), 400);

  // Re-grade on the server from the stored answer keys: the client-sent
  // `isCorrect` / `marks` values are never trusted for scoring. Non-string
  // ids are dropped from the key lookup (their rows grade as unknown → 0)
  // rather than reaching Prisma, where they would only 500.
  const questionIds = answers
    .map((a) => a.questionId)
    .filter((id): id is string => typeof id === "string" && id.length > 0);

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
      select: { id: true, answer: true, marks: true, options: true, explanation: true },
    }),
    db.examQuestion.findMany({
      where: { id: { in: questionIds }, ...gradingBankFilter },
      select: { id: true, answer: true, marks: true, options: true, explanation: true },
    }),
  ]);
  const keyById = new Map<string, { answer: string; marks: number; options: string; explanation: string | null }>();
  for (const q of [...bankQuestions, ...bankExamQuestions]) {
    keyById.set(q.id, { answer: q.answer, marks: q.marks, options: q.options, explanation: q.explanation ?? null });
  }

  // Grade every row AND build the post-submit review. `correctText` is the
  // correct option's text (the client shuffled display order, so an index
  // would be meaningless); it is only ever revealed here, after submit.
  const graded: { questionId: string; selected: string; isCorrect: boolean; marks: number }[] = [];
  const review: {
    questionId: string;
    selected: string;
    isCorrect: boolean;
    marks: number;
    correctText: string | null;
    explanation: string | null;
  }[] = [];
  for (const a of answers) {
    const key = keyById.get(a.questionId);
    if (!key) {
      // Unknown question id — score it as 0 rather than trusting the client.
      graded.push({ ...a, isCorrect: false, marks: 0 });
      review.push({
        questionId: a.questionId,
        selected: String(a.selected ?? ""),
        isCorrect: false,
        marks: 0,
        correctText: null,
        explanation: null,
      });
      continue;
    }
    // The client shuffles option order, so it reports the SELECTED TEXT.
    let isCorrect = false;
    let correctText: string | null = null;
    try {
      const opts: string[] = JSON.parse(key.options);
      const correct = opts[parseInt(key.answer, 10)];
      correctText = correct !== undefined ? String(correct) : null;
      isCorrect =
        String(a.selected) === String(key.answer) ||
        (correctText !== null && String(a.selected) === correctText);
    } catch {
      isCorrect = String(a.selected) === String(key.answer);
    }
    graded.push({ ...a, isCorrect, marks: key.marks });
    review.push({
      questionId: a.questionId,
      selected: String(a.selected ?? ""),
      isCorrect,
      marks: key.marks,
      correctText,
      explanation: key.explanation,
    });
  }

  // A mock exam may only be attributed to a PUBLISHED exam of the student's
  // own type (and course, when the exam is course-bound). Anything else —
  // unknown id, unpublished, foreign bank, foreign course — silently falls
  // back to an unlinked practice attempt rather than failing the submit.
  let linkedExam: { id: string; durationMin: number; passMark: number } | null = null;
  if (mockExamId) {
    const exam = await db.mockExam.findUnique({
      where: { id: mockExamId },
      select: {
        id: true,
        schoolType: true,
        courseId: true,
        isPublished: true,
        durationMin: true,
        passMark: true,
      },
    });
    if (
      exam &&
      exam.isPublished &&
      exam.schoolType === studentSchoolType &&
      (!exam.courseId || exam.courseId === enrollment.courseId)
    ) {
      linkedExam = exam;
    }
  }
  const passMark = linkedExam?.passMark ?? 60;
  // Linked attempts inherit the exam's configured duration; free practice
  // echoes the client value within sane bounds (display-only either way —
  // elapsed time is not server-enforced).
  const durationMin = linkedExam
    ? linkedExam.durationMin
    : Math.min(300, Math.max(0, Number(rawDurationMin) || 0));

  const totalMarks = graded.reduce((s, a) => s + (a.marks || 0), 0);
  const score = graded.filter((a) => a.isCorrect).reduce((s, a) => s + (a.marks || 0), 0);
  const percentage = totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;
  const passed = percentage >= passMark;

  const attempt = await db.examAttempt.create({
    data: {
      studentId: student.id,
      mockExamId: linkedExam?.id ?? null,
      schoolType: studentSchoolType,
      examType: normalizeExamType(rawExamType),
      questionCount: graded.length,
      durationMin,
      score,
      totalMarks,
      percentage,
      passed,
      // Immutable snapshot: results survive later question edits/deletions.
      answers: JSON.stringify(graded),
      finishedAt: new Date(),
    },
  });

  return ok({ attempt: { ...attempt, percentage, passed, score, totalMarks }, review });
}
