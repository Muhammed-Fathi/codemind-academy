// CodeMind Academy — Session Quiz core (Phase 5).
//
// The single place that decides the two things the Session Quiz flow must
// never let the client influence:
//
//   1. WHICH questions an attempt covers — the attempt's question set is
//      PERSISTED (as `QuizAnswer` rows) the moment the attempt is created and
//      never re-derived from the live Question Bank afterwards. Refresh,
//      navigation, reconnect and logout/login all return the same set, and a
//      question added to the quiz mid-attempt cannot join an open attempt.
//   2. HOW an attempt is graded — server-side only, from the authoritative
//      answer stored on the question row. Score, percentage, correctness and
//      marks are computed here; client-provided values are never read.
//
// Relation to the other assessment surfaces (deliberate boundaries):
//   * Mock exams (`/api/exams/mock`, `ExamAttempt`) are a SEPARATE flow that
//     samples the shared Question Bank at attempt time and snapshots answers
//     as JSON. They do not share state with Session Quiz attempts.
//   * Phase 4 progression (`src/lib/session-progress.ts`) stays the single
//     source of truth for "is the quiz requirement satisfied" (a finished
//     QuizAttempt exists). Nothing here re-implements unlocking.
//
// Selection policy (existing product architecture, unchanged):
//   A `Quiz` OWNS its questions (`Question.quizId`) — that ownership IS the
//   Session Quiz configuration. There is no per-student randomisation for
//   session quizzes (random sampling is a Mock Exam feature), so the set
//   selected for an attempt is the quiz's questions, frozen at attempt
//   creation. Different students therefore see the same set for the same
//   quiz, but each attempt still freezes its own independent copy.

import { db } from "@/lib/db";
import type { Question } from "@prisma/client";
import {
  eligibleQuestionFilter,
  isQuestionEligible,
} from "@/lib/track-scope";
import type { SchoolType } from "@/lib/school-type";

// ---------------------------------------------------------------------------
// Track eligibility (Phase 12)
// ---------------------------------------------------------------------------
//
// `Question.schoolType` already existed and the MOCK-EXAM flow already
// honoured it. The SESSION QUIZ flow did not: it froze every question of the
// quiz into the attempt regardless of the student's school type, and graded
// all of them. Phase 12 closes that.
//
// The rule, applied at BOTH ends so selection and grading cannot drift apart:
//
//   schoolType = null   → SHARED question, eligible for every student
//   schoolType = ARABIC → eligible for ARABIC students only
//   schoolType = LANGUAGE → eligible for LANGUAGE students only
//
//   * SELECTION: `seedAttemptQuestions` only freezes eligible questions, so a
//     new attempt's immutable set never contains a question the student must
//     not see.
//   * SERVING: `loadAttemptQuestionSet` re-applies the same predicate to the
//     frozen set. That covers attempts opened BEFORE this hardening (whose
//     rows may hold an ineligible question) and the pre-Phase-5 upgrade path
//     that adopts the live quiz questions.
//   * GRADING: `gradeAttemptQuestionSet` re-applies it a third time and drops
//     the question from the set entirely — it contributes neither marks nor
//     score, so an ineligible question can never receive credit, even if a
//     stale answer row exists for it.
//
// The attempt's frozen set REMAINS authoritative: this narrows it, it never
// re-derives it from the live bank.


// ---------------------------------------------------------------------------
// Question-set selection & persistence
// ---------------------------------------------------------------------------

/**
 * A question covered by an attempt, plus the answer row that pins it to that
 * attempt. `answerId === null` marks a question that is part of the set but
 * not yet persisted — only possible for attempts opened BEFORE Phase 5 (see
 * `loadAttemptQuestionSet`).
 */
export type AttemptQuestion = {
  answerId: string | null;
  questionId: string;
  selected: string;
  question: Pick<
    Question,
    | "id"
    | "type"
    | "prompt"
    | "promptAr"
    | "options"
    | "answer"
    | "explanation"
    | "difficulty"
    | "marks"
    | "schoolType"
  >;
};

/** Deterministic question order of a quiz (creation order, id tie-break). */
const QUIZ_QUESTION_ORDER = [{ createdAt: "asc" }, { id: "asc" }] as const;

/**
 * Persist the current questions of `quizId` as the frozen question set of
 * attempt `attemptId` (one `QuizAnswer` placeholder per question, unanswered).
 * Called exactly once, at attempt creation.
 *
 * Phase 12: only the questions ELIGIBLE for `schoolType` are frozen in. The
 * attempt set is immutable afterwards, so this is the one moment a
 * wrong-track question could ever enter an attempt — filtering here is what
 * makes the guarantee structural rather than a read-time convention.
 */
export async function seedAttemptQuestions(
  attemptId: string,
  quizId: string,
  schoolType: SchoolType | null
): Promise<void> {
  const questions = await db.question.findMany({
    where: { quizId, ...eligibleQuestionFilter(schoolType) },
    select: { id: true },
    orderBy: [...QUIZ_QUESTION_ORDER],
  });
  if (questions.length === 0) return;
  await db.quizAnswer.createMany({
    data: questions.map((q) => ({
      attemptId,
      questionId: q.id,
      selected: "",
      isCorrect: false,
    })),
  });
}

/**
 * The authoritative question set of an attempt.
 *
 *  * attempt with persisted rows → exactly those rows (frozen set);
 *  * attempt with NO rows → the attempt predates Phase 5 (opened before this
 *    hardening deployed). Its set is read from the live quiz questions —
 *    identical to the pre-Phase-5 behaviour — until submit persists the
 *    graded rows. This is a one-way upgrade path, never a fallback a NEW
 *    attempt can reach.
 *
 * Questions deleted from the bank after attempt creation disappear from the
 * set together with their (cascade-deleted) answer rows; questions EDITED
 * keep their place in the set and are graded against the current
 * authoritative answer key. New questions never join an existing attempt.
 */
export async function loadAttemptQuestionSet(
  attemptId: string,
  schoolType: SchoolType | null
): Promise<AttemptQuestion[]> {
  const rows = await db.quizAnswer.findMany({
    where: { attemptId },
    include: { question: true },
  });
  if (rows.length > 0) {
    // Prisma cannot order a relation by a nested relation field, so apply the
    // same deterministic order the quiz itself uses in JS.
    return rows
      .map((r) => ({
        answerId: r.id,
        questionId: r.questionId,
        selected: r.selected,
        question: r.question,
      }))
      // Phase 12 track gate: an attempt opened before this hardening may hold
      // an answer row for a question this student must not see. Dropping it
      // here means it is neither served nor graded — the frozen set stays
      // authoritative, it is only ever narrowed.
      .filter((e) => isQuestionEligible(schoolType, e.question.schoolType))
      .sort(
        (a, b) =>
          a.question.createdAt.getTime() - b.question.createdAt.getTime() ||
          (a.question.id < b.question.id ? -1 : a.question.id > b.question.id ? 1 : 0)
      );
  }

  // Pre-Phase-5 in-flight attempt: adopt the live quiz questions (read-only).
  const quiz = await db.quizAttempt.findUnique({
    where: { id: attemptId },
    select: {
      quiz: { select: { questions: { orderBy: [...QUIZ_QUESTION_ORDER] } } },
    },
  });
  return (quiz?.quiz.questions ?? [])
    .filter((q) => isQuestionEligible(schoolType, q.schoolType))
    .map((q) => ({
      answerId: null,
      questionId: q.id,
      selected: "",
      question: q,
    }));
}

/**
 * The track-eligible questions of a quiz, read live from the bank.
 *
 * Used by the direct-submit/retake path, where there is no frozen attempt set
 * to narrow. It applies exactly the same predicate `seedAttemptQuestions`
 * uses, so a retake can never grade a wider set than a started attempt would
 * have frozen.
 */
export async function loadQuizQuestionSet(
  quizId: string,
  schoolType: SchoolType | null
): Promise<AttemptQuestion[]> {
  const questions = await db.question.findMany({
    where: { quizId, ...eligibleQuestionFilter(schoolType) },
    orderBy: [...QUIZ_QUESTION_ORDER],
  });
  return questions.map((q) => ({
    answerId: null,
    questionId: q.id,
    selected: "",
    question: q,
  }));
}

// ---------------------------------------------------------------------------
// Server-side grading
// ---------------------------------------------------------------------------

/** A submitted answer as accepted from the client (values are NOT trusted). */
export type SubmittedAnswer = { questionId: string; selected: unknown };

/**
 * Normalise a submitted answer for storage/grading. Option answers are option
 * INDEXES ("0".."n"), so anything longer than a few characters is garbage —
 * bound it so a crafted payload cannot store an unbounded blob.
 */
export function sanitizeSelectedInput(raw: unknown): string {
  if (typeof raw === "number" && Number.isInteger(raw)) return String(raw);
  if (typeof raw !== "string") return "";
  return raw.length > 16 ? "" : raw;
}

/** One graded question of an attempt (result/review payload after submit). */
export type GradedAttemptQuestion = {
  questionId: string;
  selected: string;
  isCorrect: boolean;
  correctAnswer: string;
  marks: number;
  prompt: string;
  promptAr: string | null;
  options: string[];
  explanation: string | null;
};

export type GradedAttempt = {
  graded: GradedAttemptQuestion[];
  score: number;
  totalMarks: number;
  percentage: number;
  passed: boolean;
};

/**
 * Grade an attempt's question set against submitted answers.
 *
 * Server-authoritative: iterates the ATTEMPT's questions (never the client's
 * list), loads the correct answer from the question row, compares the
 * sanitised selected value, and sums marks. Submitted answers for questions
 * outside the attempt are ignored; a question submitted twice keeps the FIRST
 * occurrence (the pre-Phase-5 semantics). No score/percentage/correctness
 * value from the client is ever read.
 */
export function gradeAttemptQuestionSet(
  set: AttemptQuestion[],
  submittedAnswers: SubmittedAnswer[],
  passMark: number,
  schoolType: SchoolType | null = null
): GradedAttempt {
  // First occurrence per questionId wins, mirroring the historical
  // `answersRaw.find(...)` semantics.
  const selectedByQuestion = new Map<string, string>();
  for (const a of submittedAnswers) {
    if (typeof a?.questionId !== "string") continue;
    if (!selectedByQuestion.has(a.questionId)) {
      selectedByQuestion.set(a.questionId, sanitizeSelectedInput(a.selected));
    }
  }

  // Phase 12 — GRADING enforces the track rule independently of selection.
  // An ineligible question is removed from the set BEFORE any arithmetic, so
  // it contributes neither to `totalMarks` nor to `score`: it can never
  // receive credit, and it can never inflate or deflate the denominator.
  // `schoolType` defaults to null (SHARED-only) on purpose — a caller that
  // forgets to pass it grades the narrowest set, never the widest.
  // Questions with no school type are SHARED and always eligible.
  const eligibleSet = set.filter((entry) =>
    isQuestionEligible(schoolType, entry.question.schoolType)
  );

  let score = 0;
  let totalMarks = 0;
  const graded: GradedAttemptQuestion[] = eligibleSet.map((entry) => {
    const q = entry.question;
    totalMarks += q.marks;
    const selected = selectedByQuestion.get(q.id) ?? "";
    const isCorrect = selected === q.answer;
    if (isCorrect) score += q.marks;
    return {
      questionId: q.id,
      selected,
      isCorrect,
      correctAnswer: q.answer,
      marks: q.marks,
      prompt: q.prompt,
      promptAr: q.promptAr,
      options: safeParseOptions(q.options),
      explanation: q.explanation,
    };
  });

  const percentage =
    totalMarks > 0 ? Math.round((score / totalMarks) * 100) : 0;
  return { graded, score, totalMarks, percentage, passed: percentage >= passMark };
}

/** Parse a question's JSON options, never throwing on malformed legacy data. */
export function safeParseOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map((o) => String(o)) : [];
  } catch {
    return [];
  }
}
