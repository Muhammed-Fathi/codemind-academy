// CodeMind Academy — Mock exam question pool (THE single source of truth).
//
// Why this module exists
// ----------------------
// Mock exams draw from the Question Bank. Historically the pool was defined
// only INSIDE the two API routes, and the two definitions disagreed:
//
//   * creation/publish guards counted EVERY row of the matching bank, while
//   * the student RANDOM path required the question to belong to a QUIZ whose
//     lesson sits in the student's course.
//
// A question created manually by an Admin in the Question Bank has NO quizId
// (the "Add Question" dialog never sends one), so it was invisible to the
// student RANDOM pool — the exam was creatable and publishable but served
// nothing. FIXED exams were unaffected because they are served by explicit
// question ids. The AI Generator creates questions INSIDE a lesson quiz, which
// is the only reason AI-generated questions appeared to work.
//
// ELIGIBILITY CONTRACT (both selection modes, both question tables)
// -----------------------------------------------------------------
// A Question Bank record is eligible for a mock exam when:
//
//   1. BANK: `Question.schoolType` is the exam's school type or NULL (shared)
//      — the platform's existing `questionBankFilter`, unchanged.
//   2. SCOPE: either
//        a. LESSON-LINKED — the record hangs off a lesson of a course, and
//           that lesson is a student-visible lesson of the exam's course (or
//           of every course when the exam is not course-bound). The
//           student-visibility rule is the existing Phase 13/16 one:
//           `status = PUBLISHED` (LESSON_STUDENT_STATUS_FILTER). Whether
//           ARCHIVED lessons are excluded is unchanged from before this
//           module — see the note in the student route.
//        b. ATTACHED TO THIS EXAM — the record is a free Question Bank row
//           (`Question.quizId` is NULL: `Quiz.lessonId` is non-nullable, so a
//           question either has no quiz at all or a quiz inside a lesson) and
//           the Admin explicitly attached it to THIS exam
//           (`MockExamQuestion` row).
//   3. NOT DELETED. There is no archive flag on a question; deletion is the
//      only removal, and the Admin lifecycle route refuses to delete a
//      question that a FIXED exam pins or an attempt references.
//
// A manually created question is therefore NEVER global: it becomes eligible
// for exactly the exams the Admin attached it to. Course A's manual question
// cannot appear in a Course B exam of the same school type unless the Admin
// attaches it there too — the earlier "lesson-less questions are eligible for
// every course of the bank" rule was too broad and has been removed.
//
// NOTHING ELSE. Difficulty is a SELECTION FILTER (the exam's setting), not an
// eligibility requirement; and a question's AI provenance, tags, category,
// marks, origin or generated metadata are irrelevant — a manually authored
// row and an AI-generated row are the same record shape once stored. The AI
// Generator is therefore never required.
//
// FIXED exams are served from their explicit pins (also `MockExamQuestion`
// rows) and are validated against this same bank + scope rule at creation
// time, so a pin can never pull in another school's or another course's
// material.
//
// FROZEN PAPER (why the contract above is not enough on its own)
// -------------------------------------------------------------
// A deterministic sample is not a frozen paper: it is recomputed from the LIVE
// pool on every request, so an Admin adding (or deleting) a question mid-
// attempt would silently swap a question under the student. The paper is
// therefore persisted when the attempt STARTS and is replayed from storage:
//
//   * the first GET of a published exam opens an `ExamAttempt` row
//     (`finishedAt = NULL`) and writes the frozen paper — the ordered question
//     ids plus the seed used for the per-attempt option order — into the row;
//   * every later GET for that student+exam RESUMES that row and serves the
//     SAME ids in the SAME order, however the bank changed in between;
//   * submitting finalizes the row (score, answers snapshot, `finishedAt`), so
//     counts/history/retry behaviour are exactly as before: only FINISHED rows
//     count as attempts, and the next start draws a new paper;
//   * free practice (no `mockExamId`) is NOT an exam attempt: it stays
//     read-only, unpersisted, deterministic per (student, params, attempt
//     index) and never writes a row.
//
// The seed still exists and is still the mechanism that CHOOSES the paper
// (server-secret HMAC, so a student can neither predict nor pick their set);
// freezing is what makes the choice final.

import { createHmac } from "crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { questionBankFilter, type SchoolType } from "@/lib/school-type";
import { getSecurityHashSecret } from "@/lib/env";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";

export type MockExamSelectionMode = "RANDOM" | "FIXED";

// ---------------------------------------------------------------------------
// Pool where-fragments
// ---------------------------------------------------------------------------

/**
 * `Question` rows that belong to no lesson: the Admin's manual free bank.
 *
 * `quizId: null` IS the whole case: `Quiz.lessonId` is non-nullable, so a
 * question either has no quiz at all (what the "Add Question" dialog stores)
 * or belongs to a quiz that belongs to a lesson.
 */
export function bankOnlyQuestionWhere(): Prisma.QuestionWhereInput {
  return { quizId: null };
}

/**
 * `Question` rows the Admin attached to THIS exam (`MockExamQuestion`). Used
 * for RANDOM pool membership; FIXED exams use the same rows as pins.
 */
export function mockExamAttachedQuestionWhere(
  mockExamId: string
): Prisma.QuestionWhereInput {
  return { mockExamLinks: { some: { mockExamId } } };
}

/** The `ExamQuestion` twin of `mockExamAttachedQuestionWhere`. */
export function mockExamAttachedExamQuestionWhere(
  mockExamId: string
): Prisma.ExamQuestionWhereInput {
  return { mockExamLinks: { some: { mockExamId } } };
}

/**
 * The SCOPE half of a RANDOM (or FIXED-without-explicit-selection) exam's
 * pool: a lesson-linked question of the exam's course, or a FREE bank question
 * this exam attached. Never both, and never a free question that belongs to
 * no exam.
 */
export function mockExamRandomScopeWhere(
  lessonIds: readonly string[],
  mockExamId: string | null
): Prisma.QuestionWhereInput {
  const lessons =
    lessonIds.length > 0 ? lessonLinkedQuestionWhere(lessonIds) : null;
  const attached = mockExamId
    ? {
        AND: [
          bankOnlyQuestionWhere(),
          mockExamAttachedQuestionWhere(mockExamId),
        ],
      }
    : null;
  if (lessons && attached) return { OR: [lessons, attached] };
  return lessons ?? attached ?? { quizId: null, id: { in: [] } };
}

/** The `ExamQuestion` twin of `mockExamRandomScopeWhere`. */
export function mockExamRandomExamScopeWhere(
  lessonIds: readonly string[],
  mockExamId: string | null
): Prisma.ExamQuestionWhereInput {
  const lessons =
    lessonIds.length > 0 ? { lessonId: { in: [...lessonIds] } } : null;
  const attached = mockExamId
    ? { AND: [{ lessonId: null }, mockExamAttachedExamQuestionWhere(mockExamId)] }
    : null;
  if (lessons && attached) return { OR: [lessons, attached] };
  return lessons ?? attached ?? { lessonId: null, id: { in: [] } };
}

/**
 * The full RANDOM pool of one exam: bank filter AND (`mockExamRandomScopeWhere`).
 */
export function mockExamRandomPoolWhere(
  schoolType: SchoolType,
  lessonIds: readonly string[],
  mockExamId: string | null
): Prisma.QuestionWhereInput {
  return {
    AND: [
      questionBankFilter(schoolType),
      mockExamRandomScopeWhere(lessonIds, mockExamId),
    ],
  };
}

/** The `ExamQuestion` twin of `mockExamRandomPoolWhere`. */
export function mockExamRandomExamPoolWhere(
  schoolType: SchoolType,
  lessonIds: readonly string[],
  mockExamId: string | null
): Prisma.ExamQuestionWhereInput {
  return {
    AND: [
      questionBankFilter(schoolType),
      mockExamRandomExamScopeWhere(lessonIds, mockExamId),
    ],
  };
}

/** `Question` rows attached to one of `lessonIds`. */
export function lessonLinkedQuestionWhere(
  lessonIds: readonly string[]
): Prisma.QuestionWhereInput {
  return { quiz: { lessonId: { in: [...lessonIds] } } };
}

/**
 * The `Question` rows a FIXED exam may PIN: a bank-matching row that is either
 * lesson-linked inside the exam's scope or a free bank row the Admin picked by
 * hand. Pins are per-exam and served only to that exam's students, so an
 * explicit pin is never a cross-course leak — which is exactly why this rule
 * (and not the RANDOM pool rule) governs the FIXED picker and validation.
 */
export function mockExamFixedPinWhere(
  schoolType: SchoolType,
  lessonIds: readonly string[]
): Prisma.QuestionWhereInput {
  return {
    AND: [questionBankFilter(schoolType), mockExamQuestionScopeWhere(lessonIds)],
  };
}

/**
 * The scope half of the contract on its own: bank-only OR lesson-linked to
 * one of `lessonIds`. Exposed so a caller that must ALSO state the bank filter
 * literally (the Admin create route validates FIXED selections) can compose
 * the two without duplicating either rule.
 */
export function mockExamQuestionScopeWhere(
  lessonIds: readonly string[]
): Prisma.QuestionWhereInput {
  return lessonIds.length > 0
    ? { OR: [bankOnlyQuestionWhere(), lessonLinkedQuestionWhere(lessonIds)] }
    : bankOnlyQuestionWhere();
}

/**
 * Student-visible lessons, optionally limited to one course, across BOTH
 * curriculum chains (canonical `unit.part.courseId` and legacy
 * `topic.unit.part.courseId`). This mirrors the query in the student mock
 * route — the same rule, expressed once for the Admin-side pool count.
 */
export function mockExamLessonWhere(
  courseId: string | null
): Prisma.LessonWhereInput {
  // Two literal branches (rather than one shared variable) so each relation
  // filter is exactly the shape Prisma's LessonWhereInput accepts.
  if (courseId) {
    return {
      ...LESSON_STUDENT_STATUS_FILTER,
      OR: [
        { unit: { part: { courseId } } },
        { topic: { unit: { part: { courseId } } } },
      ],
    };
  }
  // "Every course" = the lesson is attached to a curriculum chain at all.
  // Part.courseId and Unit.partId and Topic.unitId are all NON-nullable, so a
  // lesson with a unit (canonical) or a topic (legacy) necessarily resolves to
  // a course — the same set the student query's relation chain matches, and
  // expressible with top-level nullable scalars (nested relation filters do
  // not accept `null` comparisons).
  return {
    ...LESSON_STUDENT_STATUS_FILTER,
    OR: [{ unitId: { not: null } }, { topicId: { not: null } }],
  };
}

export async function loadMockExamLessonIds(courseId: string | null) {
  const lessons = await db.lesson.findMany({
    where: mockExamLessonWhere(courseId),
    select: { id: true },
  });
  return lessons.map((l) => l.id);
}

// ---------------------------------------------------------------------------
// Eligible pool count (creation + publish guards, Admin UI)
// ---------------------------------------------------------------------------

export type MockExamEligiblePool = {
  /** Question-bank rows eligible for this exam (what a FIXED exam can pin). */
  question: number;
  /** Legacy ExamQuestion rows eligible for this exam (RANDOM pool only). */
  examQuestion: number;
  /**
   * Eligible Question-bank rows that carry NO lesson link — i.e. the free
   * bank rows this exam explicitly attached. Zero for an exam that attached
   * none: a manual question is never eligible on its own.
   */
  bankOnly: number;
  /** Eligible Question-bank rows that come from a student-visible lesson. */
  lessonLinked: number;
  /** Eligible Question-bank rows attached to THIS exam (RANDOM pool only). */
  attached: number;
  /** RANDOM servable size with the exam's difficulty applied. */
  servable: number;
  /** RANDOM servable size per difficulty, both tables. */
  byDifficulty: { EASY: number; MEDIUM: number; HARD: number };
  /** Total eligible records across both tables. */
  total: number;
};

/**
 * Count the eligible pool an exam of this bank/course can be served from.
 * `difficulty` is the exam's setting; like the attempt path, an empty
 * difficulty slice falls back to the whole pool, so `servable` is exactly
 * what a RANDOM exam of this configuration would serve.
 */
export async function countMockExamEligiblePool(opts: {
  schoolType: SchoolType;
  courseId?: string | null;
  difficulty?: string | null;
  lessonIds?: readonly string[];
  /** The exam whose attachments extend the pool (omit while creating one). */
  mockExamId?: string | null;
}): Promise<MockExamEligiblePool> {
  const lessonIds =
    opts.lessonIds ?? (await loadMockExamLessonIds(opts.courseId ?? null));
  const examId = opts.mockExamId ?? null;
  const questionWhere = mockExamRandomPoolWhere(
    opts.schoolType,
    lessonIds,
    examId
  );
  const examQuestionWhere = mockExamRandomExamPoolWhere(
    opts.schoolType,
    lessonIds,
    examId
  );
  const onlyBank = { AND: [questionWhere, bankOnlyQuestionWhere()] };
  const onlyLinked = {
    AND: [questionWhere, lessonLinkedQuestionWhere(lessonIds)],
  };
  const onlyAttached = examId
    ? { AND: [questionWhere, mockExamAttachedQuestionWhere(examId)] }
    : { AND: [questionWhere, { id: { in: [] } }] };
  const q = (extra: object) => ({
    AND: [questionWhere, extra],
  });
  const eq = (extra: object) => ({
    AND: [examQuestionWhere, extra],
  });

  const [
    question,
    examQuestion,
    bankOnly,
    lessonLinked,
    attached,
    qEasy,
    qMedium,
    qHard,
    eqEasy,
    eqMedium,
    eqHard,
  ] = await Promise.all([
    db.question.count({ where: questionWhere }),
    db.examQuestion.count({ where: examQuestionWhere }),
    db.question.count({ where: onlyBank }),
    db.question.count({ where: onlyLinked }),
    db.question.count({ where: onlyAttached }),
    db.question.count({ where: q({ difficulty: "EASY" }) }),
    db.question.count({ where: q({ difficulty: "MEDIUM" }) }),
    db.question.count({ where: q({ difficulty: "HARD" }) }),
    db.examQuestion.count({ where: eq({ difficulty: "EASY" }) }),
    db.examQuestion.count({ where: eq({ difficulty: "MEDIUM" }) }),
    db.examQuestion.count({ where: eq({ difficulty: "HARD" }) }),
  ]);

  const byDifficulty = {
    EASY: qEasy + eqEasy,
    MEDIUM: qMedium + eqMedium,
    HARD: qHard + eqHard,
  };
  const total = question + examQuestion;
  const wanted = opts.difficulty;

  return {
    question,
    examQuestion,
    bankOnly,
    lessonLinked,
    attached,
    byDifficulty,
    total,
    servable:
      wanted === "EASY" || wanted === "MEDIUM" || wanted === "HARD"
        ? byDifficulty[wanted] > 0
          ? byDifficulty[wanted]
          : total
        : total,
  };
}

// ---------------------------------------------------------------------------
// Frozen RANDOM selection
// ---------------------------------------------------------------------------

/** Deterministic per-attempt seed. Same attempt -> same seed -> same paper. */
export function mockExamSampleSeed(opts: {
  studentId: string;
  courseId: string | null;
  examId: string | null;
  attemptIndex: number;
  count: number;
  difficulty: string;
}): string {
  const material = [
    "mock-exam-v1",
    opts.studentId,
    opts.courseId ?? "-",
    opts.examId ?? "-",
    String(opts.attemptIndex),
    String(opts.count),
    opts.difficulty,
  ].join("|");
  return createHmac("sha256", getSecurityHashSecret())
    .update(material)
    .digest("hex");
}

/** Deterministic, secret-keyed rank of one candidate inside one paper. */
function candidateRank(seed: string, id: string): string {
  return createHmac("sha256", getSecurityHashSecret())
    .update(`${seed}|${id}`)
    .digest("hex");
}

/** Stable ordering of a pool: creation time, then id. */
export function stablePoolOrder<
  T extends { id: string; createdAt?: Date | string | null }
>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (at !== bt) return at - bt;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/**
 * Remove duplicate ids, keeping the first occurrence. An attempt is a SET of
 * questions: never the same question twice, whatever the caller passes.
 */
export function dedupeById<T extends { id: string }>(items: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}

/**
 * The frozen paper: rank the eligible pool by the attempt seed and keep the
 * `count` lowest digests. Deterministic for a given (pool, seed, count), so
 * calling it twice for the same attempt returns the identical paper.
 */
export function selectMockExamQuestions<
  T extends { id: string; createdAt?: Date | string | null }
>(pool: readonly T[], count: number, seed: string): T[] {
  const unique = dedupeById(pool);
  if (count <= 0 || unique.length === 0) return [];
  const take = Math.min(count, unique.length);
  return stablePoolOrder(unique)
    .map((item) => ({ item, rank: candidateRank(seed, item.id) }))
    .sort((a, b) =>
      a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.item.id < b.item.id ? -1 : 1
    )
    .slice(0, take)
    .map((r) => r.item);
}

/**
 * Attempt index used by the seed: the number of FINISHED attempts for this
 * student on this exam (or on free practice when `examId` is null). Only a
 * submit advances it, so an in-progress paper can never change underfoot.
 */
export async function mockExamAttemptIndex(
  studentId: string,
  examId: string | null
): Promise<number> {
  return db.examAttempt.count({
    where: {
      studentId,
      mockExamId: examId,
      finishedAt: { not: null },
    },
  });
}

// ---------------------------------------------------------------------------
// The frozen paper
// ---------------------------------------------------------------------------

/**
 * What an OPEN attempt stores in `ExamAttempt.answers`.
 *
 * `ExamAttempt.answers` is the attempt's JSON payload. For a FINISHED attempt
 * it is (and stays) the array of graded answer rows written at submit. For an
 * attempt that has STARTED but not yet been submitted it is this envelope
 * instead: the ordered question ids of the paper and the seed that fixes the
 * per-question option order, so a refresh replays the identical paper.
 *
 * `readFrozenPaper` returns NULL for every other payload — including the
 * legacy graded array — which keeps every pre-existing row readable exactly
 * as before.
 */
export type FrozenMockExamPaper = {
  v: 1;
  kind: "mock-exam-paper";
  /** The exam this paper belongs to (never null: practice is not frozen). */
  examId: string;
  selectionMode: MockExamSelectionMode;
  /** The difficulty the paper was drawn with ("mixed" = no filter). */
  difficulty: string;
  /** The count the paper was asked for (shortfall is reported against it). */
  requested: number;
  /** The frozen question ids, IN THE SERVED ORDER. */
  ids: string[];
  /** Server-secret seed: fixes the option order of every question. */
  seed: string;
  startedAt: string;
};

export function encodeFrozenPaper(paper: FrozenMockExamPaper): string {
  return JSON.stringify(paper);
}

/** Parse an attempt payload into a frozen paper, or NULL when it is not one. */
export function readFrozenPaper(raw: unknown): FrozenMockExamPaper | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const p = parsed as Partial<FrozenMockExamPaper>;
  if (p.kind !== "mock-exam-paper" || p.v !== 1) return null;
  if (typeof p.examId !== "string" || p.examId.length === 0) return null;
  if (!Array.isArray(p.ids) || !p.ids.every((id) => typeof id === "string")) {
    return null;
  }
  return {
    v: 1,
    kind: "mock-exam-paper",
    examId: p.examId,
    selectionMode: p.selectionMode === "FIXED" ? "FIXED" : "RANDOM",
    difficulty: typeof p.difficulty === "string" ? p.difficulty : "mixed",
    requested:
      typeof p.requested === "number" && Number.isFinite(p.requested)
        ? p.requested
        : p.ids.length,
    ids: [...(p.ids as string[])],
    seed: typeof p.seed === "string" ? p.seed : "",
    startedAt: typeof p.startedAt === "string" ? p.startedAt : "",
  };
}

/** A fresh server-secret seed for a paper's presentation order. */
export function mockExamPaperSeed(opts: {
  studentId: string;
  examId: string;
  nonce: string;
}): string {
  return createHmac("sha256", getSecurityHashSecret())
    .update(["mock-exam-paper-v1", opts.studentId, opts.examId, opts.nonce].join("|"))
    .digest("hex");
}

/**
 * Deterministic shuffle of one question's options: the same (paper seed,
 * question id) always yields the same order, so a refresh — or a second tab —
 * replays the paper exactly as it was first served. The order stays
 * unpredictable to the client (server secret) and position carries no meaning:
 * the client answers with the selected option TEXT.
 */
export function stableOptionOrder(
  options: readonly string[],
  seed: string,
  questionId: string
): string[] {
  const keyed = options.map((value, index) => ({
    value,
    index,
    rank: createHmac("sha256", getSecurityHashSecret())
      .update(`${seed}|${questionId}|${index}`)
      .digest("hex"),
  }));
  keyed.sort((a, b) =>
    a.rank < b.rank ? -1 : a.rank > b.rank ? 1 : a.index - b.index
  );
  return keyed.map((k) => k.value);
}

/**
 * Reorder a pool to a frozen id list: exactly the frozen ids, in the frozen
 * order, silently dropping ids the bank can no longer serve (deleted rows, or
 * rows moved out of this school's bank). The set is never extended.
 */
export function applyFrozenPaperOrder<
  T extends { id: string }
>(items: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const out: T[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (item) out.push(item);
  }
  return out;
}

/**
 * Which OPEN attempt a submission finalizes.
 *
 * A student can, at worst, hold a few open rows for one exam (a concurrent
 * double start). The paper that was actually answered is the one the submitted
 * ids belong to, so the row whose frozen ids cover the most submitted ids
 * wins; ties break to the oldest row, keeping the choice deterministic. A
 * submission that matches NO frozen paper (an API client that never started,
 * or a crafted payload of ids that were never served) finalizes nothing and
 * creates its own finished row, exactly like before this contract existed.
 */
export function pickFrozenAttemptRow(
  rows: readonly { id: string; answers: unknown }[],
  submittedIds: readonly string[]
): string | null {
  const submitted = new Set(submittedIds.filter((id) => typeof id === "string"));
  let bestId: string | null = null;
  let bestScore = 0;
  for (const row of rows) {
    const paper = readFrozenPaper(row.answers);
    if (!paper) continue;
    let score = 0;
    for (const id of paper.ids) if (submitted.has(id)) score += 1;
    if (score > bestScore) {
      bestScore = score;
      bestId = row.id;
    }
  }
  return bestId;
}
