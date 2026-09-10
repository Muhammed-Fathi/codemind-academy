// CodeMind Academy — Teacher authored-content workflow (Phase 18).
//
// THE ONE PLACE that answers, for every teacher write:
//
//   authenticated → teacher role → teacher owns the course → the lesson
//   belongs to that course → the resource belongs to that lesson → the track
//   scope is valid
//
// Why a module and not per-route code: Phase 18 adds four write routes
// (homework create/update, question create/update/delete) on top of the two
// that already existed (quiz create, homework grading). Every one of them must
// resolve the lesson's course through the CANONICAL chain
// (Course → Part → Unit → Lesson) with the legacy Topic chain only as a
// fallback, and every one of them must scope the write to the teacher's own
// courses. Duplicating that logic six times is how the Phase 12/13 audits
// found routes that agreed on five of the six steps.
//
// WHAT THIS MODULE DOES **NOT** DO
//   * It never trusts a client-supplied course id. Ownership is resolved from
//     the authenticated teacher's `Group.courseId` rows; the request body only
//     supplies a lesson id, which is then checked against that resolved set.
//   * It never infers a track scope. `resolveContentTrackScope`
//     (src/lib/track-scope.ts) owns that decision and is used verbatim.
//   * It never invents a lifecycle state. `Lesson.status` (Phase 13) decides
//     whether a lesson is student-visible; this module only applies the
//     authoring rule "no NEW content on an ARCHIVED lesson" and leaves DRAFT /
//     READY / PUBLISHED equally authorable — a teacher configures a session
//     precisely so that the admin ceremony can publish it afterwards.
//   * It never edits assessment history. Reference counting below is what lets
//     the routes refuse a mutation that would rewrite a frozen attempt or
//     silently shrink a FIXED mock exam.

import { db } from "@/lib/db";
import { normalizeTrackScope, type TrackScope } from "@/lib/track-scope";
import { normalizeSchoolType } from "@/lib/school-type";

// ---------------------------------------------------------------------------
// Input limits — deterministic, shared by routes and tests
// ---------------------------------------------------------------------------
//
// Every write path bounds its input at the edge. The numbers are deliberately
// generous (a teacher is trusted to write long instructions) but FINITE, so a
// crafted payload cannot store an unbounded blob or a 10^9-minute time limit.
// They are exported so the API and the suite assert the same contract.
//
// Out-of-range input is REJECTED (400), never silently clamped: a teacher who
// types 0 minutes must learn that the limit was not stored, not discover later
// that the quiz quietly runs untimed.

export const TEACHER_LIMITS = {
  TITLE_MAX: 160,
  TITLE_AR_MAX: 160,
  DESCRIPTION_MAX: 1000,
  INSTRUCTIONS_MAX: 4000,
  PROMPT_MAX: 2000,
  PROMPT_AR_MAX: 2000,
  EXPLANATION_MAX: 1000,
  OPTION_MAX: 500,
  OPTIONS_MIN: 2,
  OPTIONS_MAX: 10,
  QUESTIONS_PER_QUIZ_MAX: 100,
  MARKS_MIN: 1,
  MARKS_MAX: 100,
  PASS_MARK_MIN: 0,
  PASS_MARK_MAX: 100,
  /** Quiz time limit, in MINUTES. See src/lib/session-quiz.ts for enforcement. */
  TIME_LIMIT_MIN: 1,
  TIME_LIMIT_MAX: 300,
} as const;

/** Sanity bounds for a deadline — not a policy, just "is this a real date". */
const DEADLINE_MIN = Date.UTC(2000, 0, 1);
const DEADLINE_MAX = Date.UTC(2100, 0, 1);

/** Trim + length-bound a string field. Returns null when too long. */
export function boundedText(
  value: unknown,
  max: number,
  { required = false }: { required?: boolean } = {}
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) {
    return required ? { ok: false } : { ok: true, value: null };
  }
  const s = String(value).trim();
  if (s.length > max) return { ok: false };
  if (required && s.length === 0) return { ok: false };
  return { ok: true, value: s.length === 0 ? null : s };
}

/** Parse a deadline into a Date inside the sanity window. */
export function parseDeadline(value: unknown): Date | null {
  if (value === undefined || value === null || value === "") return null;
  const d = value instanceof Date ? value : new Date(String(value));
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  if (t < DEADLINE_MIN || t > DEADLINE_MAX) return null;
  return d;
}

// ---------------------------------------------------------------------------
// Canonical chain resolution
// ---------------------------------------------------------------------------

/** The course/part/unit a lesson hangs from, canonical chain first. */
export type LessonPlacement = {
  courseId: string;
  courseName: string;
  courseNameAr: string | null;
  partId: string;
  partTitle: string;
  partTitleAr: string | null;
  unitId: string;
  unitTitle: string;
  unitTitleAr: string | null;
  /** Canonical (Course → Part → Unit → Lesson) or legacy (… → Topic → Lesson). */
  chain: "CANONICAL" | "LEGACY";
};

/** The minimal lesson shape every ownership check needs. */
export type ChainLesson = {
  id: string;
  officialCode: string | null;
  trackScope: unknown;
  status: string;
  curriculumStatus: string;
  unit?: {
    id: string;
    title: string;
    titleAr: string | null;
    part: {
      id: string;
      title: string;
      titleAr: string | null;
      courseId: string;
      course?: { name: string; nameAr: string | null } | null;
    };
  } | null;
  topic?: {
    unit: {
      id: string;
      title: string;
      titleAr: string | null;
      part: {
        id: string;
        title: string;
        titleAr: string | null;
        courseId: string;
        course?: { name: string; nameAr: string | null } | null;
      };
    };
  } | null;
};

/**
 * Resolve a lesson's placement, CANONICAL FIRST.
 *
 * The canonical chain is `Lesson.unitId → Unit → Part → Course`; the legacy
 * chain is `Lesson.topicId → Topic → Unit → Part → Course`. Official lessons
 * (Phase 11) carry `unitId` and a NULL `topicId`, so a topic-only resolver
 * returns `null` for the entire official curriculum — the exact bug the
 * Phase 18 discovery found in the teacher lesson/homework/grading readers.
 */
export function lessonPlacement(lesson: ChainLesson | null | undefined): LessonPlacement | null {
  if (!lesson) return null;
  const canonical = lesson.unit;
  const legacy = lesson.topic?.unit;
  const unit = canonical ?? legacy;
  if (!unit) return null;
  const part = unit.part;
  if (!part) return null;
  const course = part.course ?? null;
  return {
    courseId: part.courseId,
    courseName: course?.name ?? "",
    courseNameAr: course?.nameAr ?? null,
    partId: part.id,
    partTitle: part.title,
    partTitleAr: part.titleAr,
    unitId: unit.id,
    unitTitle: unit.title,
    unitTitleAr: unit.titleAr,
    chain: canonical ? "CANONICAL" : "LEGACY",
  };
}

/** Prisma `select` for everything `lessonPlacement` reads, both chains. */
export const LESSON_PLACEMENT_SELECT = {
  id: true,
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
          courseId: true,
          course: { select: { name: true, nameAr: true } },
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
              courseId: true,
              course: { select: { name: true, nameAr: true } },
            },
          },
        },
      },
    },
  },
} as const;

/** The course ids a teacher owns — from their groups, never from a request. */
export function teacherCourseIds(teacher: {
  groups: Array<{ courseId: string }>;
}): string[] {
  return [...new Set(teacher.groups.map((g) => g.courseId))];
}

// ---------------------------------------------------------------------------
// Authorization results
// ---------------------------------------------------------------------------

export type LessonDenial =
  /** Unknown lesson id → 404 (never 403: an id probe must not be an oracle). */
  | "NOT_FOUND"
  /** Real lesson, but through a course this teacher does not teach → 403. */
  | "NOT_OWNED"
  /** No course chain at all → the lesson cannot be managed → 404. */
  | "NO_CHAIN";

export type OwnedLesson =
  | { ok: true; lesson: ChainLesson; placement: LessonPlacement }
  | { ok: false; reason: LessonDenial; status: 404 | 403 };

export function denialStatus(reason: LessonDenial): 404 | 403 {
  return reason === "NOT_OWNED" ? 403 : 404;
}

/**
 * Load a lesson and prove the teacher may write to it.
 *
 * The single ownership predicate for every teacher write in Phase 18. It
 * resolves the placement canonically first, then requires the placement's
 * course to be one of the teacher's own courses. A lesson with no chain is
 * treated as unknown (404) rather than unowned, because there is no course to
 * be denied against.
 */
export async function loadOwnedLesson(
  lessonId: string,
  courseIds: readonly string[]
): Promise<OwnedLesson> {
  const lesson = (await db.lesson.findUnique({
    where: { id: lessonId },
    select: LESSON_PLACEMENT_SELECT,
  })) as ChainLesson | null;
  if (!lesson) return { ok: false, reason: "NOT_FOUND", status: 404 };
  const placement = lessonPlacement(lesson);
  if (!placement) return { ok: false, reason: "NO_CHAIN", status: 404 };
  if (!courseIds.includes(placement.courseId)) {
    return { ok: false, reason: "NOT_OWNED", status: 403 };
  }
  return { ok: true, lesson, placement };
}

/** Lesson lifecycle/curriculum flags used by the authoring guards. */
export function isArchivedLesson(lesson: Pick<ChainLesson, "curriculumStatus">): boolean {
  return String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED";
}

/** The lesson's own track scope, normalized (fail-closed to null). */
export function lessonTrackScope(
  lesson: Pick<ChainLesson, "trackScope">
): TrackScope | null {
  return normalizeTrackScope(lesson.trackScope);
}

// ---------------------------------------------------------------------------
// Question reference counting — the frozen-history / FIXED-pin guards
// ---------------------------------------------------------------------------
//
// A `Question` row is referenced by exactly two things:
//   * `QuizAnswer` rows — the FROZEN question set of a `QuizAttempt`
//     (Phase 5). An answer row of an open attempt means a student is taking
//     the question RIGHT NOW; a row of a finished attempt is graded history.
//   * `MockExamQuestion` pins — a FIXED mock exam serves its pinned set
//     AS-IS, so removing a pinned question shrinks the exam silently.
//
// Both are read in ONE query each (never N+1) and counted in JS, so the count
// cannot drift from the rows the guards act on.

export type QuestionReferences = {
  answers: number;
  openAttempts: number;
  gradedAttempts: number;
  /** Pins on a FIXED (selectionMode === "FIXED") mock exam — the blocking kind. */
  fixedExamPins: number;
  /** Pins on a RANDOM exam. Recorded for information; never blocks. */
  randomExamPins: number;
  /** Total MockExamQuestion rows pointing at this question. */
  examPins: number;
};

export type QuestionPin = {
  mockExamId: string;
  title: string;
  titleAr: string | null;
  schoolType: string;
  selectionMode: string;
  order: number;
};

export async function loadQuestionReferences(questionId: string): Promise<{
  references: QuestionReferences;
  pins: QuestionPin[];
}> {
  const [answers, pins] = await Promise.all([
    db.quizAnswer.findMany({
      where: { questionId },
      select: { attemptId: true, attempt: { select: { finishedAt: true } } },
    }),
    db.mockExamQuestion.findMany({
      where: { questionId },
      select: {
        order: true,
        mockExam: {
          select: {
            id: true,
            title: true,
            titleAr: true,
            schoolType: true,
            selectionMode: true,
          },
        },
      },
    }),
  ]);

  const open = new Set<string>();
  const graded = new Set<string>();
  for (const a of answers) {
    if (a.attempt?.finishedAt) graded.add(a.attemptId);
    else open.add(a.attemptId);
  }

  const questionPins: QuestionPin[] = pins
    .filter((p) => !!p.mockExam)
    .map((p) => ({
      mockExamId: p.mockExam.id,
      title: p.mockExam.title,
      titleAr: p.mockExam.titleAr,
      schoolType: String(p.mockExam.schoolType),
      selectionMode: String(p.mockExam.selectionMode),
      order: p.order,
    }));

  return {
    references: {
      answers: answers.length,
      openAttempts: open.size,
      gradedAttempts: graded.size,
      fixedExamPins: questionPins.filter((p) => p.selectionMode === "FIXED").length,
      randomExamPins: questionPins.filter((p) => p.selectionMode !== "FIXED").length,
      examPins: questionPins.length,
    },
    pins: questionPins,
  };
}

/** Fields whose edit changes how an attempt is graded. */
export const GRADING_FIELDS = ["answer", "options", "type", "marks"] as const;
export type GradingField = (typeof GRADING_FIELDS)[number];

/**
 * May a question be DELETED, given its references?
 *
 * "Delete rejected when referenced" is the Phase 18 rule. There is no archival
 * strategy for `Question` (no soft-delete column, and adding one would be a
 * schema change this phase deliberately avoids), and deletion CASCADES into
 * `QuizAnswer` — which would silently rewrite the frozen set of every attempt
 * that ever included the question and shrink a FIXED exam. So deletion is
 * refused whenever either reference exists.
 */
export function canDeleteQuestion(refs: QuestionReferences): {
  allowed: boolean;
  blockers: string[];
} {
  const blockers: string[] = [];
  if (refs.answers > 0) blockers.push("FROZEN_ANSWERS");
  if (refs.openAttempts > 0) blockers.push("OPEN_ATTEMPT");
  if (refs.gradedAttempts > 0) blockers.push("GRADED_ATTEMPT");
  if (refs.fixedExamPins > 0) blockers.push("FIXED_EXAM_PIN");
  return { allowed: blockers.length === 0, blockers };
}

/**
 * May the given patch be applied, given the question's references?
 *
 * Two independent locks, both derived from the frozen-set contract:
 *
 *  * GRADING LOCK (`openAttempts > 0 || gradedAttempts > 0`) — `answer`,
 *    `options`, `type` and `marks` are read from the LIVE question row when an
 *    attempt is served and graded (the frozen set pins the question's ID, not
 *    its text). Editing them under an open attempt changes a running
 *    assessment, and editing them after a finish would make the stored score
 *    disagree with the key a student is shown. Both are refused.
 *  * ELIGIBILITY LOCK (`openAttempts > 0 || gradedAttempts > 0`) — `schoolType`
 *    is re-applied when the frozen set is loaded, so re-tagging a question
 *    would remove a question from an attempt the student already saw (or add
 *    one they never saw). Refused while any answer row exists.
 *
 * Text and analytic metadata (`prompt`, `promptAr`, `explanation`,
 * `difficulty`) stay editable: they cannot change what was graded, and
 * `difficulty` re-labelling historical analytics is the documented Phase 6
 * behaviour (src/lib/quiz-analytics.ts).
 */
export function questionEditGuards(
  refs: QuestionReferences,
  patch: Record<string, unknown>
):
  | { allowed: true }
  | { allowed: false; blockedFields: string[]; reason: "FROZEN_ATTEMPT" | "FIXED_EXAM_PIN" } {
  const attempted = refs.openAttempts > 0 || refs.gradedAttempts > 0;
  const blockedFields: string[] = [];
  if (attempted) {
    for (const f of GRADING_FIELDS) {
      if (patch[f] !== undefined) blockedFields.push(f);
    }
    if (patch.schoolType !== undefined) blockedFields.push("schoolType");
  }
  if (blockedFields.length > 0) {
    return { allowed: false, blockedFields, reason: "FROZEN_ATTEMPT" };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Question scope containment
// ---------------------------------------------------------------------------

/**
 * A question's `schoolType` is a SELECTION filter inside an already-gated
 * container, so the authoring ceiling is the OWNING QUIZ's scope:
 *
 *   * the quiz is track-specific → a question may be that track or SHARED
 *     (an explicit SHARED stays meaningful: the quiz gate narrows it);
 *   * the quiz is SHARED → the question may be either track or SHARED. This is
 *     the documented way one shared quiz serves different question sets to the
 *     two tracks, and it is what `isQuestionEligible` already enforces at read
 *     time.
 *
 * A LANGUAGE question inside an ARABIC quiz is refused: it is unreachable, and
 * storing unreachable content is how a teacher ends up believing they
 * configured something. Returns the stored representation (null = SHARED).
 */
export function isQuestionScopeWithinQuiz(
  requested: string | null,
  quizTrackScope: unknown
): boolean {
  const quiz = normalizeTrackScope(quizTrackScope);
  if (!quiz) return false; // fail closed
  if (requested === null) return true; // SHARED
  const wanted = normalizeSchoolType(requested);
  if (!wanted) return false;
  return quiz === "SHARED" || quiz === wanted;
}

// ---------------------------------------------------------------------------
// Question draft validation (shared by quiz-create and question-create)
// ---------------------------------------------------------------------------
//
// One validator, used by BOTH write paths, so a question created inside a new
// quiz and a question appended to an existing quiz cannot disagree about what
// is acceptable. It returns a REASON CODE rather than a message: the route maps
// the code to a localized string (`getServerT`), and the tests assert the code.

export type ValidatedQuestion = {
  type: "MCQ" | "TRUE_FALSE";
  prompt: string;
  promptAr: string | null;
  options: string[];
  answer: string;
  explanation: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
  /** Stored representation: null = SHARED. */
  schoolType: "ARABIC" | "LANGUAGE" | null;
  /** True when no `schoolType` was supplied (the caller inherits the quiz's). */
  schoolTypeInherited: boolean;
};

export type QuestionValidationReason =
  | "TYPE"
  | "PROMPT_REQUIRED"
  | "PROMPT_TOO_LONG"
  | "PROMPT_AR_TOO_LONG"
  | "OPTIONS_COUNT"
  | "OPTION_TOO_LONG"
  | "ANSWER_REQUIRED"
  | "ANSWER_RANGE"
  | "EXPLANATION_TOO_LONG"
  | "MARKS_RANGE"
  | "TRACK_INVALID"
  | "TRACK_OUT_OF_QUIZ_SCOPE";

export type QuestionValidation =
  | { ok: true; question: ValidatedQuestion }
  | { ok: false; reason: QuestionValidationReason };

/**
 * Validate one author-supplied question draft.
 *
 * `quizTrackScope` is the scope the question will live under — the quiz being
 * created or the existing quiz being appended to. An explicitly supplied
 * question track must be CONTAINED by it (see `isQuestionScopeWithinQuiz`);
 * an absent one is inherited by the caller through the Phase 12 precedence
 * (`resolveQuestionSchoolType`), reported here as `schoolTypeInherited`.
 */
export function validateQuestionDraft(
  raw: {
    type?: unknown;
    prompt?: unknown;
    promptAr?: unknown;
    options?: unknown;
    answer?: unknown;
    explanation?: unknown;
    difficulty?: unknown;
    marks?: unknown;
    schoolType?: unknown;
  },
  quizTrackScope: unknown
): QuestionValidation {
  const type = raw.type === "TRUE_FALSE" ? "TRUE_FALSE" : raw.type === "MCQ" || raw.type === undefined ? "MCQ" : null;
  if (!type) return { ok: false, reason: "TYPE" };

  const prompt = typeof raw.prompt === "string" ? raw.prompt.trim() : "";
  if (!prompt) return { ok: false, reason: "PROMPT_REQUIRED" };
  if (prompt.length > TEACHER_LIMITS.PROMPT_MAX) {
    return { ok: false, reason: "PROMPT_TOO_LONG" };
  }
  if (raw.promptAr !== undefined && raw.promptAr !== null) {
    if (typeof raw.promptAr !== "string") return { ok: false, reason: "PROMPT_AR_TOO_LONG" };
    if (raw.promptAr.length > TEACHER_LIMITS.PROMPT_AR_MAX) {
      return { ok: false, reason: "PROMPT_AR_TOO_LONG" };
    }
  }

  let options: string[];
  let answer: string;
  if (type === "TRUE_FALSE") {
    // A TRUE_FALSE question always stores the canonical pair, and the answer is
    // a 0/1 index into it — never the client's own strings.
    options = ["True", "False"];
    const a = String(raw.answer ?? "0");
    answer = a === "1" || a.toLowerCase() === "false" ? "1" : "0";
  } else {
    if (!Array.isArray(raw.options)) return { ok: false, reason: "OPTIONS_COUNT" };
    options = raw.options.map((o) => (typeof o === "string" ? o.trim() : String(o ?? "").trim()));
    if (options.length < TEACHER_LIMITS.OPTIONS_MIN) {
      return { ok: false, reason: "OPTIONS_COUNT" };
    }
    if (options.length > TEACHER_LIMITS.OPTIONS_MAX) {
      return { ok: false, reason: "OPTIONS_COUNT" };
    }
    if (options.some((o) => o.length === 0)) return { ok: false, reason: "OPTIONS_COUNT" };
    if (options.some((o) => o.length > TEACHER_LIMITS.OPTION_MAX)) {
      return { ok: false, reason: "OPTION_TOO_LONG" };
    }
    if (raw.answer === undefined || raw.answer === null || raw.answer === "") {
      return { ok: false, reason: "ANSWER_REQUIRED" };
    }
    answer = String(raw.answer);
    const idx = Number(answer);
    if (!Number.isInteger(idx) || idx < 0 || idx >= options.length) {
      return { ok: false, reason: "ANSWER_RANGE" };
    }
  }

  const explanation =
    raw.explanation === undefined || raw.explanation === null
      ? null
      : String(raw.explanation);
  if (explanation && explanation.length > TEACHER_LIMITS.EXPLANATION_MAX) {
    return { ok: false, reason: "EXPLANATION_TOO_LONG" };
  }

  const difficulty =
    raw.difficulty === "EASY" || raw.difficulty === "HARD" ? raw.difficulty : "MEDIUM";

  const marks = Number(raw.marks ?? 1);
  if (
    !Number.isInteger(marks) ||
    marks < TEACHER_LIMITS.MARKS_MIN ||
    marks > TEACHER_LIMITS.MARKS_MAX
  ) {
    return { ok: false, reason: "MARKS_RANGE" };
  }

  // Track tagging. `parseQuestionSchoolTypeInput` semantics are honoured here
  // but its REJECTION is reported as a reason code, and the containment rule
  // (question ⊆ quiz) is applied before anything is stored.
  const inferred = raw.schoolType;
  let schoolType: "ARABIC" | "LANGUAGE" | null = null;
  let schoolTypeInherited = true;
  const explicitShared =
    inferred === null || (typeof inferred === "string" && inferred.trim() === "");
  if (inferred !== undefined) {
    if (explicitShared) {
      // Phase 12: an EXPLICIT "SHARED" (stored as null) is an author decision,
      // not an absence — it is respected and never overridden by the quiz.
      schoolType = null;
      schoolTypeInherited = false;
    } else {
      const scope = normalizeTrackScope(inferred);
      if (!scope) return { ok: false, reason: "TRACK_INVALID" };
      schoolType = scope === "SHARED" ? null : scope;
      schoolTypeInherited = false;
    }
  }
  if (!isQuestionScopeWithinQuiz(schoolType, quizTrackScope)) {
    return { ok: false, reason: "TRACK_OUT_OF_QUIZ_SCOPE" };
  }

  return {
    ok: true,
    question: {
      type,
      prompt,
      promptAr:
        typeof raw.promptAr === "string" && raw.promptAr.trim() !== ""
          ? raw.promptAr.trim()
          : null,
      options,
      answer,
      explanation,
      difficulty,
      marks,
      schoolType,
      schoolTypeInherited,
    },
  };
}

/**
 * Localized message for a validation reason. Shared so both question write
 * routes answer identically, and so the message keys are declared once.
 * `p1` carries the 1-based question index wherever the message names one.
 */
export function questionValidationMessage(
  t: (key: string, params?: Record<string, unknown>) => string,
  reason: QuestionValidationReason,
  index = 1
): string {
  switch (reason) {
    case "TYPE":
      return t("api.184", { p1: "?" });
    case "PROMPT_REQUIRED":
      return t("api.181", { p1: index });
    case "PROMPT_TOO_LONG":
      return t("api.251", { p1: TEACHER_LIMITS.PROMPT_MAX });
    case "PROMPT_AR_TOO_LONG":
      return t("api.251", { p1: TEACHER_LIMITS.PROMPT_AR_MAX });
    case "OPTIONS_COUNT":
      return t("api.182", { p1: index });
    case "OPTION_TOO_LONG":
      return t("api.252", {
        p1: TEACHER_LIMITS.OPTIONS_MIN,
        p2: TEACHER_LIMITS.OPTIONS_MAX,
        p3: TEACHER_LIMITS.OPTION_MAX,
      });
    case "ANSWER_REQUIRED":
      return t("api.183", { p1: index });
    case "ANSWER_RANGE":
      return t("api.253");
    case "EXPLANATION_TOO_LONG":
      return t("api.251", { p1: TEACHER_LIMITS.EXPLANATION_MAX });
    case "MARKS_RANGE":
      return t("api.254", {
        p1: TEACHER_LIMITS.MARKS_MIN,
        p2: TEACHER_LIMITS.MARKS_MAX,
      });
    case "TRACK_INVALID":
      return t("api.229");
    case "TRACK_OUT_OF_QUIZ_SCOPE":
      return t("api.255");
  }
}

// ---------------------------------------------------------------------------
// Question API payloads
// ---------------------------------------------------------------------------

/** The question shape every teacher question surface returns. */
export function questionPayload(q: {
  id: string;
  quizId: string | null;
  type: string;
  prompt: string;
  promptAr: string | null;
  options: string;
  answer: string;
  explanation: string | null;
  difficulty: string;
  marks: number;
  schoolType: string | null;
  createdAt?: Date;
}) {
  let options: string[] = [];
  try {
    const parsed = JSON.parse(q.options);
    if (Array.isArray(parsed)) options = parsed.map((o) => String(o));
  } catch {
    options = [];
  }
  return {
    id: q.id,
    quizId: q.quizId,
    type: q.type,
    prompt: q.prompt,
    promptAr: q.promptAr,
    options,
    answer: q.answer,
    explanation: q.explanation,
    difficulty: q.difficulty,
    marks: q.marks,
    /** Stored form: null = SHARED. */
    schoolType: q.schoolType,
    trackScope: q.schoolType === null ? "SHARED" : String(q.schoolType),
    createdAt: q.createdAt ?? null,
  };
}

// ---------------------------------------------------------------------------
// Shared payload helpers (quiz detail, question detail, homework detail)
// ---------------------------------------------------------------------------

/** Localized-first title pair used across the teacher payloads. */
export function localizedTitle(
  row: { title: string; titleAr?: string | null } | null | undefined
): string {
  if (!row) return "";
  return row.titleAr || row.title;
}

/** A lesson stamp that every teacher payload embeds (picker parity). */
export function lessonStamp(lesson: {
  id: string;
  title: string;
  titleAr: string;
  officialCode: string | null;
  trackScope: unknown;
  status: string;
  curriculumStatus: string;
  unitId?: string | null;
  topicId?: string | null;
}) {
  return {
    id: lesson.id,
    title: localizedTitle(lesson),
    titleRaw: lesson.title,
    officialCode: lesson.officialCode,
    trackScope: normalizeTrackScope(lesson.trackScope) ?? "SHARED",
    status: lesson.status,
    curriculumStatus: lesson.curriculumStatus,
  };
}
