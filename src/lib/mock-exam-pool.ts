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
//        a. BANK-ONLY — the record is not attached to any lesson
//           (`Question.quizId` is NULL — `Quiz.lessonId` is non-nullable, so a
//           question either has no quiz at all or a quiz inside a lesson;
//           `ExamQuestion.lessonId` is NULL). This is the FREE BANK the Admin
//           populates by hand, and the case that was broken.
//        b. LESSON-LINKED — the record hangs off a lesson of a course, and
//           that lesson is a student-visible lesson of the exam's course (or
//           of every course when the exam is not course-bound). The
//           student-visibility rule is the existing Phase 13/16 one:
//           `status = PUBLISHED` (LESSON_STUDENT_STATUS_FILTER). Whether
//           ARCHIVED lessons are excluded is unchanged from before this
//           module — see the note in the student route.
//   3. NOT DELETED. There is no archive flag on a question; deletion is the
//      only removal, and the Admin lifecycle route refuses to delete a
//      question that a FIXED exam pins or an attempt references.
//
// NOTHING ELSE. Difficulty is a SELECTION FILTER (the exam's setting), not an
// eligibility requirement; and a question's AI provenance, tags, category,
// marks, origin or generated metadata are irrelevant — a manually authored
// row and an AI-generated row are the same record shape once stored. The AI
// Generator is therefore never required.
//
// FROZEN RANDOM SELECTION
// -----------------------
// A RANDOM exam must not silently change the questions under a student who is
// answering, and yet a retry must be a genuinely different paper. This module
// derives the paper deterministically from
//
//     seed = HMAC-SHA256(server secret, student | course | exam | attemptIndex
//                        | count | difficulty)
//
// and ranks every eligible question by `HMAC-SHA256(server secret, seed|id)`,
// keeping the `count` lowest digests. Consequences:
//
//   * re-requesting the SAME attempt (refresh, back button, second tab)
//     returns the same questions in the same order — nothing changes;
//   * `attemptIndex` is the number of FINISHED attempts, so the paper only
//     changes after a submit — i.e. a retry is a new paper;
//   * the rank depends on the question id alone, so an unrelated pool edit
//     (a question added or removed) does not reshuffle an existing paper;
//   * the ordering is computed server-side from a secret the client never
//     sees, so a student cannot predict or choose their own set.
//
// The attempt's answers are still snapshotted into `ExamAttempt.answers` at
// submit, so a recorded result stays readable even if the bank changes later.

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

/** `Question` rows attached to one of `lessonIds`. */
export function lessonLinkedQuestionWhere(
  lessonIds: readonly string[]
): Prisma.QuestionWhereInput {
  return { quiz: { lessonId: { in: [...lessonIds] } } };
}

/**
 * The eligible `Question` pool for a school type. `lessonIds` is the
 * student-visible lesson set of the exam's course (the caller resolves it with
 * `loadMockExamLessonIds`); an empty list simply means "bank-only only".
 *
 * The bank filter is ANDed, never merged, so a nested `OR` can never widen it.
 */
export function mockExamQuestionPoolWhere(
  schoolType: SchoolType,
  lessonIds: readonly string[]
): Prisma.QuestionWhereInput {
  return {
    AND: [
      questionBankFilter(schoolType),
      mockExamQuestionScopeWhere(lessonIds),
    ],
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

/** The scope half of the `ExamQuestion` contract (legacy table). */
export function mockExamExamQuestionScopeWhere(
  lessonIds: readonly string[]
): Prisma.ExamQuestionWhereInput {
  return lessonIds.length > 0
    ? { OR: [{ lessonId: null }, { lessonId: { in: [...lessonIds] } }] }
    : { lessonId: null };
}

/** The eligible legacy `ExamQuestion` pool (same contract, lessonId column). */
export function mockExamExamQuestionPoolWhere(
  schoolType: SchoolType,
  lessonIds: readonly string[]
): Prisma.ExamQuestionWhereInput {
  return {
    AND: [
      questionBankFilter(schoolType),
      mockExamExamQuestionScopeWhere(lessonIds),
    ],
  };
}

// ---------------------------------------------------------------------------
// Lesson universe (Admin-side counting)
// ---------------------------------------------------------------------------

/**
 * Student-visible lessons, optionally limited to one course, across BOTH
 * curriculum chains (canonical `unit.part.courseId` and legacy
 * `topic.unit.part.courseId`). This mirrors the query in the student mock
 * route — the same rule, expressed once for the Admin-side pool count.
 */
export function mockExamLessonWhere(
  courseId: string | null
): Prisma.LessonWhereInput {
  // Two explicit branches (not one shared variable) so each relation filter is
  // a literal Prisma accepts.
  const chain = courseId
    ? {
        OR: [
          { unit: { part: { courseId } } },
          { topic: { unit: { part: { courseId } } } },
        ] as Prisma.LessonWhereInput[],
      }
    : {
        OR: [
          { unit: { part: { courseId: { not: null } } } },
          { topic: { unit: { part: { courseId: { not: null } } } } },
        ] as Prisma.LessonWhereInput[],
      };
  return { ...LESSON_STUDENT_STATUS_FILTER, ...chain };
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
  /** Question-bank rows (what a FIXED exam can pin). */
  question: number;
  /** Legacy ExamQuestion rows (RANDOM pool only). */
  examQuestion: number;
  /** Question-bank rows with no lesson link — the manual free bank. */
  bankOnly: number;
  /** Question-bank rows attached to a student-visible lesson. */
  lessonLinked: number;
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
}): Promise<MockExamEligiblePool> {
  const lessonIds =
    opts.lessonIds ?? (await loadMockExamLessonIds(opts.courseId ?? null));
  const questionWhere = mockExamQuestionPoolWhere(opts.schoolType, lessonIds);
  const examQuestionWhere = mockExamExamQuestionPoolWhere(
    opts.schoolType,
    lessonIds
  );
  const onlyBank = {
    AND: [questionWhere, bankOnlyQuestionWhere()],
  };
  const onlyLinked = {
    AND: [questionWhere, lessonLinkedQuestionWhere(lessonIds)],
  };
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
