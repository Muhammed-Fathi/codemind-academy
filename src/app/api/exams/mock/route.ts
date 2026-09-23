import { getServerT } from "@/lib/i18n-server";
import type { Prisma } from "@prisma/client";
// CodeMind Academy — Mock Exam API
// Generates randomized practice exams from Question Bank.
import { NextRequest } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { normalizeSchoolType, questionBankFilter } from "@/lib/school-type";
import { getEnrollment } from "@/lib/enrollment";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import {
  applyFrozenPaperOrder,
  dedupeById,
  encodeFrozenPaper,
  mockExamAttemptIndex,
  mockExamPaperSeed,
  mockExamRandomExamScopeWhere,
  mockExamRandomScopeWhere,
  mockExamSampleSeed,
  pickFrozenAttemptRow,
  readFrozenPaper,
  selectMockExamQuestions,
  stableOptionOrder,
  type FrozenMockExamPaper,
} from "@/lib/mock-exam-pool";
import { randomUUID } from "crypto";

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

/**
 * One row per question id, first occurrence wins. A crafted payload that
 * repeats a question must not turn into two graded rows — an attempt is a
 * set of questions, never a multiset. Rows without a usable string id are
 * passed through untouched: they grade as unknown (0), exactly like before.
 */
function dedupeSubmittedAnswers<
  T extends { questionId?: unknown }
>(answers: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const a of answers) {
    const id =
      a && typeof a.questionId === "string" && a.questionId.length > 0
        ? a.questionId
        : null;
    if (!id) {
      out.push(a);
      continue;
    }
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(a);
  }
  return out;
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
  const bankFilter: Prisma.QuestionWhereInput =
    questionBankFilter(studentSchoolType);
  // Same bank rule for the legacy table — typed for its own model so the two
  // `findMany` calls below compose strictly typed `AND` arrays.
  const examBankFilter: Prisma.ExamQuestionWhereInput =
    questionBankFilter(studentSchoolType);

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
  //
  // Phase K2 — MULTI-LEVEL SCOPE. The lesson universe is the exam's OWN
  // course when the exam is course-bound (the shared `mockExamLessonWhere`
  // rule). A legacy course-less admin exam gets NO automatic lesson-linked
  // pool (fail closed — its automatic scope would otherwise be "every
  // course", i.e. every academic level); it can still serve the free-bank
  // rows the admin explicitly attached to it. Free practice (no exam) keeps
  // sampling the student's own enrolled course.
  const poolCourseId = mockExam ? mockExam.courseId : courseId;
  const lessons = poolCourseId
    ? await db.lesson.findMany({
        where: {
          ...LESSON_STUDENT_STATUS_FILTER,
          OR: [
            { unit: { part: { courseId: poolCourseId } } },
            { topic: { unit: { part: { courseId: poolCourseId } } } },
          ],
        },
        select: { id: true },
      })
    : [];
  // The literal above is the SAME rule as `mockExamLessonWhere(poolCourseId)`
  // (shared with the admin guards); a course-less scope resolves to NO lesson.
  const lessonIds = lessons.map((l) => l.id);

  // ---------------------------------------------------------------------
  // RESUME OR START: the frozen paper of a published exam
  // ---------------------------------------------------------------------
  // A published exam's attempt is opened HERE, on the first GET, so the
  // selected question ids can be frozen into the attempt row: a refresh, a
  // second tab, or coming back later replays exactly the same paper even if
  // the Admin edits the Question Bank in between. The row stays OPEN
  // (`finishedAt = NULL`) until the student submits, and is NOT counted as an
  // attempt anywhere — every count in the platform (the student's list, the
  // parent dashboard, the retry index below) only ever looks at FINISHED rows.
  // Free practice (no `mockExamId`) writes no row at all: it is not an exam
  // attempt, and it keeps the previous read-only behaviour.
  const openAttempt = mockExam
    ? await db.examAttempt.findFirst({
        where: {
          studentId: student.id,
          mockExamId: mockExam.id,
          finishedAt: null,
        },
        // Oldest open paper wins, deterministically: two concurrent starts can
        // at worst leave an extra open row behind (no unique constraint can be
        // added to this table by an additive migration), and every later read
        // resolves to the same one instead of alternating between them.
        orderBy: { startedAt: "asc" },
        select: { id: true, answers: true },
      })
    : null;
  const frozen = readFrozenPaper(openAttempt?.answers);

  // ---------------------------------------------------------------------
  // POOL SCOPE (src/lib/mock-exam-pool.ts)
  // ---------------------------------------------------------------------
  // FIXED exams resolve their pinned ids; RANDOM exams draw from the exam's
  // course pool — the questions of a student-visible lesson of that course —
  // PLUS the free Question Bank rows the Admin attached to THIS exam. A manual
  // question is therefore eligible for exactly the exams it was attached to,
  // never for every course of the bank.

  const isFixedExam = !!mockExam && mockExam.selectionMode === "FIXED";
  // A resumed paper needs no pin read: the frozen ids ARE the paper.
  const pinned =
    mockExam && isFixedExam && !frozen
      ? await db.mockExamQuestion.findMany({
          where: { mockExamId: mockExam.id },
          orderBy: { order: "asc" },
          select: { questionId: true, examQuestionId: true, order: true },
        })
      : null;

  // NOTE: the `where` stays an INLINE ternary of object literals. Prisma
  // infers the result payload (including `include`) from the argument literal;
  // a computed union such as `a ?? b` makes it fall back to the bare model and
  // the `include` silently disappears from the result type.
  const pinnedQuestionIds = pinned
    ? (pinned.map((p) => p.questionId).filter(Boolean) as string[])
    : [];
  const pinnedExamQuestionIds = pinned
    ? (pinned.map((p) => p.examQuestionId).filter(Boolean) as string[])
    : [];
  const quizQuestions = await db.question.findMany({
    // A frozen paper is read back BY ID, deliberately WITHOUT the bank filter:
    // the ids were bank-validated the moment the paper was drawn, and the
    // whole point of the freeze is that a later bank edit (a question moved to
    // another school's bank, a lesson lifecycle change) cannot alter the paper
    // a student has already started. Only a row that no longer exists at all
    // (deleted) drops out — and that is reported as a shortfall.
    where: frozen
      ? { id: { in: frozen.ids } }
      : pinned
        ? { AND: [bankFilter, { id: { in: pinnedQuestionIds } }] }
        : {
            AND: [
              bankFilter,
              mockExamRandomScopeWhere(lessonIds, mockExam?.id ?? null),
            ],
          },
    include: { quiz: { select: { lesson: { select: { titleAr: true, title: true } } } } },
  });

  // Get exam questions (same bank isolation and, for RANDOM exams, the same
  // scope rule applied to the legacy table).
  const examQuestions = await db.examQuestion.findMany({
    // Same frozen-paper rule as above (the legacy table has no answer key
    // difference: the ids ARE the paper).
    where: frozen
      ? { id: { in: frozen.ids } }
      : pinned
        ? { AND: [examBankFilter, { id: { in: pinnedExamQuestionIds } }] }
        : {
            AND: [
              examBankFilter,
              mockExamRandomExamScopeWhere(lessonIds, mockExam?.id ?? null),
            ],
          },
    include: { lesson: { select: { titleAr: true, title: true } } },
  });

  // Combine all questions. Duplicate ids are impossible across the two tables
  // (cuid primary keys) but the pool is deduped anyway, so one attempt can
  // never contain the same question twice whatever the source looks like.
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
    createdAt: Date | null;
  };
  const allQs: Q[] = dedupeById([
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
      createdAt: q.createdAt ?? null,
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
      // ExamQuestion has no createdAt column; null sorts it before quiz rows
      // and the id tie-break keeps the order stable.
      createdAt: null,
    })),
  ]);

  if (allQs.length === 0) {
    // A published Admin exam whose pool is empty is a configuration problem the
    // student cannot fix, so it gets its own explicit message (and the Admin
    // list flags it). Free practice keeps the original wording. No attempt row
    // is opened for an exam that cannot serve a single question.
    return ok({
      exam: null,
      message: mockExam ? tApi("api.310") : tApi("api.097"),
      selectionMode: mockExam ? mockExam.selectionMode : "RANDOM",
      requestedCount: count,
      eligiblePool: 0,
      shortfall: null,
    });
  }

  // The seed on the paper: it selects the questions of a NEW paper and fixes
  // the served option order of EVERY paper (a resumed one replays its stored
  // seed, so a refresh cannot reshuffle the options either).
  let paperSeed: string;
  let selected: Q[];
  if (frozen) {
    // FROZEN contract: exactly the ids stored at start, in the stored order.
    // Rows the bank can no longer serve (deleted, or moved to another school's
    // bank) drop out and are reported through `shortfall` below — the set is
    // never extended or re-drawn.
    selected = applyFrozenPaperOrder(allQs, frozen.ids);
    paperSeed = frozen.seed;
  } else if (pinned) {
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
    paperSeed = mockExamPaperSeed({
      studentId: student.id,
      examId: mockExam?.id ?? "practice",
      nonce: randomUUID(),
    });
  } else {
    // RANDOM contract: filter by difficulty if specified, then take the
    // attempt-stable sample of the pool and serve up to `count`.
    //
    // The sample is derived from (student, exam, attempt index) through a
    // server-secret HMAC (see src/lib/mock-exam-pool.ts), so the initial draw
    // is unpredictable to the client and the next attempt draws a different
    // paper. It is ALSO stored on the exam attempt as soon as it is drawn
    // (below), which is what makes it final.
    let pool = allQs;
    if (difficulty !== "mixed") {
      pool = allQs.filter((q) => q.difficulty === difficulty);
      if (pool.length === 0) pool = allQs; // fallback
    }

    const attemptIndex = await mockExamAttemptIndex(
      student.id,
      mockExam ? mockExam.id : null
    );
    paperSeed = mockExamSampleSeed({
      studentId: student.id,
      courseId,
      examId: mockExam ? mockExam.id : null,
      attemptIndex,
      count,
      difficulty,
    });
    selected = selectMockExamQuestions(pool, count, paperSeed);
  }

  // Option order is PRESENTATION only, but it is derived from the paper seed
  // (server secret + the question id) instead of `Math.random`, so the same
  // paper always renders its options in the same order: position carries no
  // meaning to the grader, which compares the selected option TEXT.
  const questions = selected.map((q) => {
    const opts: string[] = JSON.parse(q.options);
    const optsServed = q.type === "MCQ" ? stableOptionOrder(opts, paperSeed, q.id) : opts;
    return {
      id: q.id,
      type: q.type,
      prompt: q.promptAr || q.prompt,
      options: optsServed,
      difficulty: q.difficulty,
      marks: q.marks,
      source: q.source,
      lessonTitle: q.lessonTitle,
    };
  });

  const totalMarks = questions.reduce((s, q) => s + q.marks, 0);
  const durationMin =
    mockExam?.durationMin ?? Math.max(10, Math.ceil(questions.length * 1.5));
  // A resumed paper is measured against the count IT was drawn for: the Admin
  // editing the exam's configured count mid-attempt must not turn a complete
  // paper into a "short" one (or the reverse).
  const requestedCount = frozen ? frozen.requested : count;
  // A published exam whose pool shrank below its configured count serves what
  // IS eligible and says so, instead of silently pretending it is complete.
  // A frozen paper reports the questions the bank can still serve from it.
  const shortfall =
    questions.length < requestedCount
      ? {
          requested: requestedCount,
          served: questions.length,
          message: tApi("api.311", { p1: requestedCount, p2: questions.length }),
        }
      : null;

  // ---------------------------------------------------------------------
  // FREEZE (published exams only)
  // ---------------------------------------------------------------------
  // Written AFTER the payload is built, so only a paper that is really being
  // served is stored — an empty or unservable exam never opens an attempt. A
  // resumed paper needs no write: it is already stored, and re-freezing would
  // be the one way a paper could change underfoot.
  let attemptId = openAttempt?.id ?? null;
  if (mockExam && !frozen) {
    const paper: FrozenMockExamPaper = {
      v: 1,
      kind: "mock-exam-paper",
      examId: mockExam.id,
      selectionMode: isFixedExam ? "FIXED" : "RANDOM",
      difficulty,
      requested: count,
      ids: questions.map((q) => q.id),
      seed: paperSeed,
      startedAt: new Date().toISOString(),
    };
    const data = {
      questionCount: questions.length,
      durationMin,
      answers: encodeFrozenPaper(paper),
    };
    if (openAttempt) {
      // An open row whose payload was not a readable paper (only possible for
      // a row written before this contract existed): reuse it instead of
      // littering a second open attempt for the same exam.
      await db.examAttempt.update({ where: { id: openAttempt.id }, data });
    } else {
      const row = await db.examAttempt.create({
        data: {
          studentId: student.id,
          mockExamId: mockExam.id,
          schoolType: studentSchoolType,
          examType,
          score: 0,
          totalMarks: 0,
          percentage: 0,
          passed: false,
          // Explicit SQL NULL: the paper is OPEN until the student submits.
          // (`finishedAt` is the only status column this table has, so every
          // count filters on it — an open paper is not an attempt.)
          finishedAt: null,
          ...data,
        },
      });
      attemptId = row.id;
    }
  }

  return ok({
    exam: {
      mockExamId: mockExam?.id ?? null,
      title: mockExam ? mockExam.title : null,
      titleAr: mockExam ? mockExam.titleAr : null,
      schoolType: studentSchoolType,
      examType,
      selectionMode: mockExam ? mockExam.selectionMode : "RANDOM",
      requestedCount,
      eligiblePool: allQs.length,
      questionCount: questions.length,
      durationMin,
      passMark: mockExam?.passMark ?? 60,
      totalMarks,
      questions,
      shortfall,
      /** The open attempt this paper belongs to (null for free practice). */
      attemptId,
      /** True when the paper was replayed from storage, not drawn afresh. */
      resumed: !!frozen,
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
  const { examType: rawExamType, durationMin: rawDurationMin, answers: rawAnswers, mockExamId } = body as {
    examType?: string;
    durationMin?: number;
    mockExamId?: string | null;
    answers: { questionId: string; selected: string; isCorrect: boolean; marks: number }[];
  };
  if (!rawAnswers || !Array.isArray(rawAnswers)) return err("Answers required", 400);
  if (rawAnswers.length > MAX_SUBMITTED_ANSWERS) return err("Too many answers", 400);
  // One row per question id, first occurrence wins (see helper above).
  const answers = dedupeSubmittedAnswers(rawAnswers);

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

  const result = {
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
  };

  // If this submission answers a FROZEN paper (the student started the exam,
  // so an open attempt holds its ids), the submission FINALIZES that row: the
  // attempt keeps the identity and `startedAt` it was given when the paper was
  // frozen, and only gains its result. A submission that never started an exam
  // attempt (an API client, or free practice) creates a finished row exactly
  // as before.
  const openRows = linkedExam
    ? await db.examAttempt.findMany({
        where: {
          studentId: student.id,
          mockExamId: linkedExam.id,
          finishedAt: null,
        },
        // Oldest open paper first, so `pickFrozenAttemptRow`'s tie-break is
        // deterministic even if a concurrent double-start left two rows.
        orderBy: { startedAt: "asc" },
        select: { id: true, answers: true },
      })
    : [];
  const target = pickFrozenAttemptRow(
    openRows,
    graded.map((g) => g.questionId)
  );

  const attempt = target
    ? await db.examAttempt.update({ where: { id: target }, data: result })
    : await db.examAttempt.create({ data: result });

  return ok({ attempt: { ...attempt, percentage, passed, score, totalMarks }, review });
}
