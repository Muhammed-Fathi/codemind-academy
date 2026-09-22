// CodeMind Academy — Phase I: the Parent academic follow-up READER.
//
// WHAT THIS MODULE IS
//   The ONE place the Parent surfaces turn canonical academic facts into a
//   human-readable view-model. It is a PRESENTATION ADAPTER, not an authority:
//
//     Phase H → lesson state, current lesson, lock reason, unmet requirements,
//               hold boundary, overrides, catch-up eligibility
//               (`loadCourseProgression`, `evaluateStudentCatchup`)
//     Phase F → absence cases, excused/unexcused, hold rows
//               (`listAbsencesForParent`)
//     Phase G → homework/quiz lifecycle + submission classification
//               (`STUDENT_HOMEWORK_LIST_FILTER`, the canonical late rule)
//
//   Nothing here re-derives a completion, hold, lock, pass/fail or retry rule.
//   If the canonical authority says the student may progress, this module says
//   the same thing. "Action Needed" is an aggregation of canonical facts and
//   never invents one.
//
// WHAT THIS MODULE IS NOT
//   * Not a second academic truth system — no rule of its own.
//   * Not a writer. Every function here is read-only (the route layer proves
//     it with a write-tracking regression test).
//   * Not an ID store. The payload deliberately carries NO lesson/quiz/
//     homework/hold database ids — a parent-facing screen has no business
//     holding them, and a leak there is a probe handle. `studentId` is the
//     single exception: it is the approved `?studentId=` API contract and is
//     verified against the ParentStudentLink on every call.
//
// SCOPE
//   Every read is bounded: a fixed, small number of queries per child (one
//   canonical progression load for the WHOLE course — never one per lesson),
//   issued concurrently. Loading N children costs N bounded loads, not
//   N × lessons.

import { db } from "@/lib/db";
import { getEnrollment } from "@/lib/enrollment";
import { normalizeSchoolType } from "@/lib/school-type";
import { pickL10n, type Locale } from "@/lib/i18n-core";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import {
  EXCLUDE_ARCHIVED_LESSON,
  lessonCourseChainOr,
} from "@/lib/session-progress";
import { trackScopeWhere } from "@/lib/track-scope";
import { STUDENT_HOMEWORK_LIST_FILTER } from "@/lib/student-visibility";
import { listAbsencesForParent } from "@/lib/absence-review";
import {
  evaluateStudentCatchup,
  loadCourseProgression,
  PROGRESSION_REASON_AR,
  toCatchupHoldView,
  toUnmetEntries,
  type CourseProgression,
  type LessonEvaluation,
  type ProgressionUnmetCode,
  type ProgressionUnmetEntry,
} from "@/lib/progression";

// ---------------------------------------------------------------------------
// 1. Link resolution — the ONLY way a parent names a child
// ---------------------------------------------------------------------------
//
// "authenticated Parent → active legitimate ParentStudentLink → requested
// Student", resolved server-side every single time. A `studentId` that is not
// in the parent's own link set is indistinguishable from one that does not
// exist: both resolve to `null`, and every caller answers 404.

export type LinkedChildRow = {
  id: string;
  grade: string | null;
  schoolType: string | null;
  studentCode: string | null;
  user: { name: string; avatarUrl: string | null } | null;
  group: {
    id: string;
    name: string;
    schedule: string | null;
    course: {
      id: string;
      slug: string;
      name: string;
      nameAr: string;
      color: string | null;
    } | null;
  } | null;
};

export type LinkedChildResolution = {
  parentId: string;
  /** Every linked student id, in a stable order (link age, then id). */
  childIds: string[];
  /** The resolved child — never a student outside `childIds`. */
  student: LinkedChildRow;
};

/**
 * Resolve the child a parent request is about.
 *
 * `studentId === null` means "the first linked child" (the dashboard default).
 * An unknown, unlinked, or forged id returns `null` — the caller must answer
 * 404, never 403 (a 403 would confirm the id exists).
 */
export async function resolveLinkedChild(
  parentUserId: string,
  studentId: string | null | undefined
): Promise<LinkedChildResolution | null> {
  const parent = await db.parent.findUnique({
    where: { userId: parentUserId },
    select: {
      id: true,
      children: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          student: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              group: {
                include: {
                  course: {
                    select: {
                      id: true,
                      slug: true,
                      name: true,
                      nameAr: true,
                      color: true,
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  });
  if (!parent || parent.children.length === 0) return null;

  const childIds = parent.children.map((link) => link.student.id);
  const requested = typeof studentId === "string" && studentId ? studentId : null;
  const targetId = requested ?? childIds[0];
  const link = parent.children.find((l) => l.student.id === targetId);
  if (!link) return null;

  return {
    parentId: parent.id,
    childIds,
    student: link.student as unknown as LinkedChildRow,
  };
}

/**
 * Read `?studentId=` off a request defensively.
 *
 * Parent route handlers are invoked by Next with a real `NextRequest`, but the
 * offline suites pass a minimal object — so the reader tolerates a missing
 * `nextUrl` and falls back to the raw `url`. It NEVER falls back to the body:
 * a client-supplied id in a POST body is not a query parameter and must stay
 * inert (that is the point of the existing "spoofed body changes nothing"
 * regression).
 */
export function readStudentIdParam(req: unknown): string | null {
  const candidate = req as
    | { nextUrl?: { searchParams?: URLSearchParams | null } | null; url?: string }
    | null
    | undefined;
  const params = candidate?.nextUrl?.searchParams;
  if (params && typeof params.get === "function") {
    const value = params.get("studentId");
    return value && value.trim() ? value.trim() : null;
  }
  const url = candidate?.url;
  if (typeof url === "string" && url) {
    try {
      const value = new URL(url).searchParams.get("studentId");
      return value && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** The child switcher: names only, no academics, no ids beyond the contract. */
export async function listLinkedChildRefs(
  parentUserId: string,
  locale: Locale
): Promise<
  Array<{ id: string; name: string; courseName: string | null; avatarUrl: string | null }>
> {
  const parent = await db.parent.findUnique({
    where: { userId: parentUserId },
    select: {
      children: {
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        include: {
          student: {
            include: {
              user: { select: { name: true, avatarUrl: true } },
              group: {
                include: { course: { select: { name: true, nameAr: true } } },
              },
            },
          },
        },
      },
    },
  });
  return (parent?.children ?? []).map((link) => ({
    id: link.student.id,
    name: link.student.user?.name ?? "",
    courseName: link.student.group?.course
      ? pickL10n(locale, link.student.group.course.nameAr, link.student.group.course.name)
      : null,
    avatarUrl: link.student.user?.avatarUrl ?? null,
  }));
}

// ---------------------------------------------------------------------------
// 2. View-model vocabulary
// ---------------------------------------------------------------------------

export type ProgressionStateView = "LOCKED" | "UNLOCKED" | "COMPLETED";

export type RequirementView = {
  required: boolean;
  done: boolean;
  /** Video only: the binding percent (0-100). 0/100 elsewhere. */
  value: number;
  /** Video only: how many REQUIRED recordings gate the lesson. */
  requiredCount?: number;
  completedCount?: number;
};

export type ParentLessonView = {
  /** `Lesson.officialCode` when present — a display code, never a DB id. */
  code: string | null;
  title: string;
  /** 1-based position in the child's curriculum order. */
  position: number;
  state: ProgressionStateView;
  unlocked: boolean;
  completed: boolean;
  /** Canonical Arabic reason (null when nothing blocks). */
  reason: string | null;
  reasonCode: ProgressionUnmetCode | null;
  unmet: ProgressionUnmetEntry[];
  requirements: {
    video: RequirementView | null;
    quiz: RequirementView | null;
    homework: RequirementView | null;
  };
  /** True when an Admin override (not an academic fact) grants access. */
  overrideGranted: boolean;
};

export type ParentHomeworkStatus =
  | "NOT_SUBMITTED_YET"
  | "MISSING_OVERDUE"
  | "SUBMITTED"
  | "SUBMITTED_LATE"
  | "GRADED";

export type ParentHomeworkView = {
  title: string;
  lessonTitle: string | null;
  /** PUBLISHED = still accepting work; CLOSED = historically visible. */
  acceptingSubmissions: boolean;
  dueAt: string | null;
  status: ParentHomeworkStatus;
  submittedAt: string | null;
  /** Canonical Phase G lateness: submittedAt > deadline, or status LATE. */
  late: boolean;
  grade: number | null;
  maxMarks: number | null;
  /** Teacher feedback belonging to THIS child's submission. */
  feedback: string | null;
};

export type ParentQuizView = {
  title: string;
  lessonTitle: string | null;
  /** FINISHED attempts only (an open attempt is ungraded: Phase 6). */
  attempts: number;
  lastOutcome: "PASSED" | "FAILED" | null;
  lastPercentage: number | null;
  bestPercentage: number | null;
  lastCompletedAt: string | null;
};

export type ParentAbsenceView = {
  sessionTitle: string;
  sessionStartAt: string;
  status: string;
  /** The excuse text on the case (read-only for a parent). */
  reason: string | null;
  holdActive: boolean;
  decidedAt: string | null;
  decisionNote: string | null;
};

export type ParentHoldView = {
  lessonTitle: string | null;
  /** False when the missed lesson is outside every curriculum (vacuous hold). */
  inUniverse: boolean;
  reason: string | null;
  unmet: ProgressionUnmetEntry[];
  /** Catch-up-eligible right now = the student can clear the hold. */
  eligible: boolean;
};

export type ParentSessionView = {
  title: string;
  /** Only carried when the session's lesson is inside the child's universe. */
  lessonTitle: string | null;
  startAt: string;
  endsAt: string;
  status: "SCHEDULED" | "LIVE" | "COMPLETED" | "CANCELLED";
  teacherName: string | null;
  rescheduled: boolean;
  originalStartAt: string | null;
  rescheduleCount: number;
  cancelledAt: string | null;
  cancelReason: string | null;
};

/**
 * Every code the aggregation may emit. The canonical Phase H unmet codes
 * (`ProgressionUnmetCode`, `ABSENCE_HOLD` included) travel THROUGH untouched —
 * the parent layer never renames one — plus two presentation-only codes and
 * one "the lesson itself is locked" roll-up that carries the canonical reason
 * text alongside it.
 */
export type ParentActionCode =
  | ProgressionUnmetCode
  | "LESSON_LOCKED"
  | "CATCHUP_REQUIRED"
  | "HOMEWORK_OVERDUE"
  | "SESSION_RESCHEDULED"
  | "SESSION_CANCELLED";

export type ParentActionItem = {
  code: ParentActionCode;
  /** "blocking" = the student cannot move forward; "attention" = FYI. */
  severity: "blocking" | "attention";
  /**
   * Canonical Arabic when the code IS a canonical progression code
   * (`PROGRESSION_REASON_AR`), otherwise an i18n dict key the route resolves.
   */
  label: string;
  detail: string | null;
};

export type ParentChildSnapshot = {
  student: {
    id: string;
    name: string;
    grade: string | null;
    schoolType: string | null;
    studentCode: string | null;
    avatarUrl: string | null;
  };
  course: {
    name: string;
    track: string | null;
  } | null;
  group: { name: string; schedule: string | null } | null;
  progress: {
    completedLessons: number;
    totalLessons: number;
    pct: number;
    currentLesson: ParentLessonView | null;
    lockedLessons: number;
  };
  lessons: ParentLessonView[];
  holds: ParentHoldView[];
  absences: {
    excused: number;
    unexcused: number;
    pending: number;
    recent: ParentAbsenceView[];
  };
  homework: {
    submitted: number;
    graded: number;
    overdue: number;
    items: ParentHomeworkView[];
  };
  quizzes: {
    taken: number;
    passed: number;
    items: ParentQuizView[];
  };
  sessions: {
    upcoming: ParentSessionView[];
    rescheduled: ParentSessionView[];
    cancelled: ParentSessionView[];
  };
  teacherFeedback: Array<{
    source: "HOMEWORK" | "TEACHER_NOTE";
    title: string | null;
    note: string;
    authorName: string | null;
    at: string;
  }>;
  actionNeeded: ParentActionItem[];
  /** Server evaluation instant — the snapshot is a point-in-time view. */
  evaluatedAt: string;
};

// ---------------------------------------------------------------------------
// 3. The snapshot — one bounded, concurrent load per child
// ---------------------------------------------------------------------------

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function requirementView(
  r: LessonEvaluation["video"] | LessonEvaluation["quiz"] | LessonEvaluation["assignment"]
): RequirementView | null {
  if (!r) return null;
  const out: RequirementView = {
    required: !!r.required,
    done: !!r.done,
    value: typeof r.value === "number" ? r.value : 0,
  };
  if (typeof r.requiredCount === "number") out.requiredCount = r.requiredCount;
  if (typeof r.completedCount === "number") out.completedCount = r.completedCount;
  return out;
}

function lessonView(
  evaluation: LessonEvaluation,
  titleByLessonId: Map<string, { title: string; titleAr: string; officialCode: string | null }>,
  position: number,
  locale: Locale
): ParentLessonView {
  const meta = titleByLessonId.get(evaluation.lessonId);
  return {
    code: meta?.officialCode ?? null,
    title: meta ? pickL10n(locale, meta.titleAr, meta.title) : "",
    position,
    state: evaluation.state,
    unlocked: evaluation.unlocked,
    completed: evaluation.completed,
    reason: evaluation.reason,
    reasonCode: evaluation.reasonCode,
    unmet: toUnmetEntries(evaluation.unmet),
    requirements: {
      video: requirementView(evaluation.video),
      quiz: requirementView(evaluation.quiz),
      homework: requirementView(evaluation.assignment),
    },
    overrideGranted: !!evaluation.override,
  };
}

/** Canonical → view, for every lesson of the child's universe. */
function buildLessonViews(
  progression: CourseProgression | null,
  titleByLessonId: Map<string, { title: string; titleAr: string; officialCode: string | null }>,
  locale: Locale
): ParentLessonView[] {
  if (!progression) return [];
  return progression.lessons.map((evaluation, index) =>
    lessonView(evaluation, titleByLessonId, index + 1, locale)
  );
}

function homeworkStatus(input: {
  submittedAt: Date | null;
  status: string | null;
  deadline: Date | null;
  grade: number | null;
  now: Date;
}): { status: ParentHomeworkStatus; late: boolean } {
  const { submittedAt, status, deadline, grade, now } = input;
  // The canonical Phase G late rule (`publicSubmission`): the stored status OR
  // the actual timestamp vs the original deadline — never a new rule.
  const late =
    String(status ?? "").toUpperCase() === "LATE" ||
    (!!submittedAt && !!deadline && submittedAt.getTime() > deadline.getTime());
  if (!submittedAt) {
    // No valid submission. The distinction the product demands: an upcoming
    // deadline is "not submitted yet", a passed one is "missing / overdue".
    return {
      status: deadline && deadline.getTime() < now.getTime() ? "MISSING_OVERDUE" : "NOT_SUBMITTED_YET",
      late: false,
    };
  }
  const graded =
    String(status ?? "").toUpperCase() === "GRADED" || grade !== null;
  if (graded) return { status: "GRADED", late };
  if (late) return { status: "SUBMITTED_LATE", late };
  return { status: "SUBMITTED", late: false };
}

function sessionView(
  session: {
    title: string;
    titleAr: string;
    startAt: Date;
    duration: number;
    status: string;
    lessonId: string | null;
    cancelledAt: Date | null;
    cancelReason: string | null;
    rescheduleCount: number;
    originalStartAt: Date | null;
    teacher?: { user?: { name?: string | null } | null } | null;
    substituteTeacher?: { user?: { name?: string | null } | null } | null;
  },
  lessonTitleById: Map<string, string>,
  locale: Locale
): ParentSessionView {
  const status = String(session.status ?? "SCHEDULED").toUpperCase();
  return {
    title: pickL10n(locale, session.titleAr, session.title),
    // Same rule the existing dashboard applies to `nextSession`: the session
    // itself is group-bound, but the LESSON it hangs off is curriculum — a
    // staged or archived lesson's title stays hidden.
    lessonTitle: session.lessonId ? (lessonTitleById.get(session.lessonId) ?? null) : null,
    startAt: iso(session.startAt) ?? "",
    endsAt: iso(new Date(session.startAt.getTime() + Math.max(0, session.duration) * 60000)) ?? "",
    status:
      status === "LIVE" || status === "COMPLETED" || status === "CANCELLED"
        ? status
        : "SCHEDULED",
    teacherName:
      session.substituteTeacher?.user?.name ?? session.teacher?.user?.name ?? null,
    rescheduled: Number(session.rescheduleCount ?? 0) > 0,
    originalStartAt: iso(session.originalStartAt),
    rescheduleCount: Number(session.rescheduleCount ?? 0),
    cancelledAt: iso(session.cancelledAt),
    cancelReason: session.cancelReason ?? null,
  };
}

/**
 * Action Needed — AGGREGATION ONLY.
 *
 * Every item below is a canonical fact restated. The list never adds a rule:
 *   * ABSENCE_HOLD / LESSON_LOCKED / CATCHUP_REQUIRED come from the Phase H
 *     evaluation and the Phase H catch-up evaluation;
 *   * VIDEO_INCOMPLETE / QUIZ_NOT_PASSED / HOMEWORK_NOT_SUBMITTED are the
 *     canonical unmet codes of the CURRENT lesson (their labels are the
 *     canonical `PROGRESSION_REASON_AR` strings, verbatim);
 *   * HOMEWORK_OVERDUE is the canonical deadline-vs-submission fact;
 *   * the session items are the Phase F lifecycle states.
 *
 * If the canonical authority says the student may progress, nothing here says
 * otherwise — an empty list is the honest answer.
 */
function buildActionNeeded(input: {
  currentLesson: ParentLessonView | null;
  holds: ParentHoldView[];
  homeworkItems: ParentHomeworkView[];
  sessions: {
    upcoming: ParentSessionView[];
    rescheduled: ParentSessionView[];
    cancelled: ParentSessionView[];
  };
}): ParentActionItem[] {
  const out: ParentActionItem[] = [];
  const seen = new Set<string>();

  const push = (
    code: ParentActionCode,
    severity: ParentActionItem["severity"],
    label: string,
    detail: string | null
  ) => {
    const key = `${code}:${detail ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ code, severity, label, detail });
  };

  // 1. An ACTIVE hold outranks everything: it is the Phase F/H boundary.
  for (const hold of input.holds) {
    push(
      "ABSENCE_HOLD",
      "blocking",
      PROGRESSION_REASON_AR.ABSENCE_HOLD,
      hold.lessonTitle
    );
    if (hold.eligible) {
      push("CATCHUP_REQUIRED", "blocking", "parent.action.catchupNow", hold.lessonTitle);
    } else if (hold.inUniverse) {
      push("CATCHUP_REQUIRED", "blocking", "parent.action.catchupBlocked", hold.reason);
    }
  }

  // 2. The current lesson's own canonical unmet requirements.
  const current = input.currentLesson;
  if (current) {
    // The canonical unmet codes of the CURRENT lesson are the honest answer to
    // "what should the student do now" whether or not the lesson is open — an
    // UNLOCKED lesson with an outstanding requirement is still outstanding
    // work. The codes and their labels are the engine's own, verbatim.
    for (const entry of current.unmet) {
      push(entry.kind, "blocking", entry.label, current.title);
    }
    if (!current.unlocked && current.reasonCode) {
      push(
        current.reasonCode === "ABSENCE_HOLD" ? "ABSENCE_HOLD" : "LESSON_LOCKED",
        "blocking",
        current.reason ?? PROGRESSION_REASON_AR[current.reasonCode] ?? "",
        current.title
      );
    }
  }

  // 3. Homework the deadline has passed without a valid submission.
  for (const hw of input.homeworkItems) {
    if (hw.status === "MISSING_OVERDUE") {
      push("HOMEWORK_OVERDUE", "blocking", "parent.action.homeworkOverdue", hw.title);
    }
  }

  // 4. Live-session lifecycle the parent must know about (never blocking).
  for (const s of input.sessions.rescheduled) {
    push("SESSION_RESCHEDULED", "attention", "parent.action.sessionRescheduled", s.title);
  }
  for (const s of input.sessions.cancelled) {
    push("SESSION_CANCELLED", "attention", "parent.action.sessionCancelled", s.title);
  }

  return out;
}

/**
 * Build the complete read-only academic snapshot for ONE linked child.
 *
 * BOUNDED: a fixed number of queries regardless of how many lessons,
 * assignments, quizzes or sessions the course has, issued concurrently. The
 * canonical progression engine is loaded ONCE for the whole course — never
 * once per lesson.
 */

/**
 * Phase I — the ONE place every Parent reporting surface reads a course
 * completion count from.
 *
 * Before Phase I there were three independent recounts of the same question
 * (the dashboard's `courseProgress`, the analytics screen's `completedLessons`,
 * and the weekly/monthly reports derived from the dashboard). All three counted
 * the LEGACY `LessonProgress.isCompleted` sticky flag — an artefact the Phase H
 * engine explicitly stopped trusting, and one that ignores sequentiality,
 * absence holds and overrides. Three copies of one academic verdict is exactly
 * the duplicate truth Phase I removes: every parent screen now reports the
 * engine's own number, produced here.
 *
 * `completed` is the engine's EFFECTIVE completion (`completed && unlocked` — a
 * factually complete but hold-blocked lesson is not something the child has
 * finished). `total` is the engine's own universe size, so the pair can never
 * disagree.
 *
 * Returns `null` when the child has no resolvable course (not enrolled, lapsed
 * entitlement, course removed); callers keep their historical zero rather than
 * turning a reporting screen into a 500.
 */
export async function loadCanonicalCourseProgress(
  studentId: string,
  courseId: string | null | undefined
): Promise<{ completed: number; total: number } | null> {
  if (!courseId) return null;
  try {
    const progression = await loadCourseProgression(studentId, courseId);
    return {
      completed: progression.lessons.filter((l) => l.completed && l.unlocked).length,
      total: progression.lessons.length,
    };
  } catch {
    return null;
  }
}

export async function loadChildAcademicSnapshot(params: {
  resolution: LinkedChildResolution;
  locale: Locale;
  now?: Date;
}): Promise<ParentChildSnapshot> {
  const now = params.now ?? new Date();
  const { parentId, student } = params.resolution;
  const locale = params.locale === "en" ? "en" : "ar";
  const studentId = student.id;

  const emptySessions = {
    upcoming: [] as ParentSessionView[],
    rescheduled: [] as ParentSessionView[],
    cancelled: [] as ParentSessionView[],
  };

  // Enrollment is the shared rule (ACTIVE group + paid entitlement) — the
  // same verdict `canAccessLesson` applies, so a parent can never be shown a
  // course their child is not entitled to.
  const enrollment = await getEnrollment(studentId);
  const courseId = enrollment.isEnrolled ? enrollment.courseId : null;
  const schoolType = enrollment.schoolType ?? normalizeSchoolType(student.schoolType);
  const childTrack = trackScopeWhere(schoolType);

  // --- Canonical Phase H evaluation (ONE load for the whole course) -------
  // --- Phase H catch-up evaluation ---------------------------------------
  // --- Phase F absence cases (linked-child scoped inside the reader) ------
  const [progression, catchup, absenceCases] = await Promise.all([
    courseId ? loadCourseProgression(studentId, courseId, { schoolType, now }) : null,
    evaluateStudentCatchup(studentId, { now }),
    listAbsencesForParent(parentId, { now, childId: studentId, limit: 50 }),
  ]);

  const lessonIds = progression ? progression.lessons.map((l) => l.lessonId) : [];

  // Lesson titles for the SAME universe. The ids are an internal join key and
  // never leave this module.
  const titleByLessonId = new Map<
    string,
    { title: string; titleAr: string; officialCode: string | null }
  >();
  if (lessonIds.length > 0) {
    const rows = await db.lesson.findMany({
      where: { id: { in: lessonIds } },
      select: { id: true, title: true, titleAr: true, officialCode: true },
    });
    for (const row of rows) {
      titleByLessonId.set(row.id, {
        title: row.title,
        titleAr: row.titleAr,
        officialCode: row.officialCode ?? null,
      });
    }
  }
  const lessonTitleById = new Map<string, string>(
    [...titleByLessonId.entries()].map(([id, meta]) => [
      id,
      pickL10n(locale, meta.titleAr, meta.title),
    ])
  );

  const lessons = buildLessonViews(progression, titleByLessonId, locale);

  // Canonical completion: `completed` is the historical FACT, `state` the
  // access TRUTH — the same "effective completion" the student dashboard
  // applies. A factually complete but hold-blocked lesson is not done.
  const completedLessons = lessons.filter((l) => l.completed && l.unlocked).length;
  const unlockedLessonIds = new Set(
    (progression?.lessons ?? []).filter((l) => l.unlocked).map((l) => l.lessonId)
  );

  // --- Homework + quizzes -------------------------------------------------
  // Student-visible slice: the child's own PUBLISHED, non-archived, in-course,
  // in-track universe, filtered by the Phase G lifecycle (a DRAFT assignment
  // does not exist for the child, so it cannot exist for the parent either).
  // Explicit row types: the three branches below (course / no course) must
  // agree on a shape the rest of the function can rely on.
  type HomeworkRow = {
    id: string;
    title: string;
    titleAr: string;
    deadline: Date | null;
    maxMarks: number | null;
    status: string | null;
    lessonId: string;
  };
  type QuizRow = { id: string; title: string; titleAr: string; lessonId: string };
  type SubmissionRow = {
    homeworkId: string;
    status: string | null;
    submittedAt: Date | null;
    grade: number | null;
    feedback: string | null;
  };
  const [homeworkRows, quizRows, submissionRows]: [
    HomeworkRow[],
    QuizRow[],
    SubmissionRow[],
  ] = courseId
    ? await Promise.all([
        db.homework.findMany({
          where: {
            ...childTrack,
            ...STUDENT_HOMEWORK_LIST_FILTER,
            lesson: {
              ...LESSON_STUDENT_STATUS_FILTER,
              ...EXCLUDE_ARCHIVED_LESSON,
              OR: lessonCourseChainOr(courseId),
            },
          },
          select: {
            id: true,
            title: true,
            titleAr: true,
            deadline: true,
            maxMarks: true,
            status: true,
            lessonId: true,
          },
          orderBy: { deadline: "desc" },
        }),
        db.quiz.findMany({
          where: {
            status: "PUBLISHED",
            ...childTrack,
            lesson: {
              ...LESSON_STUDENT_STATUS_FILTER,
              ...EXCLUDE_ARCHIVED_LESSON,
              OR: lessonCourseChainOr(courseId),
            },
          },
          select: {
            id: true,
            title: true,
            titleAr: true,
            lessonId: true,
          },
        }),
        db.homeworkSubmission.findMany({
          where: { studentId },
          select: {
            homeworkId: true,
            status: true,
            submittedAt: true,
            grade: true,
            feedback: true,
            gradedAt: true,
          },
        }),
      ])
    : ([[], [], []] as [HomeworkRow[], QuizRow[], SubmissionRow[]]);

  // CONTENT VISIBILITY — the parent sees what the CHILD sees. The student
  // homework/quiz surfaces only name assignments of lessons the student has
  // actually unlocked, so a future session's assignment stays hidden. A
  // submission/attempt that already exists stays visible (graded history on a
  // lesson a hold later locked is the child's own past work, not future
  // content).
  const submissionByHomework = new Map(submissionRows.map((s) => [s.homeworkId, s]));
  const homeworkItems: ParentHomeworkView[] = [];
  for (const hw of homeworkRows) {
    const lessonVisible =
      unlockedLessonIds.has(hw.lessonId) || submissionByHomework.has(hw.id);
    if (!lessonVisible) continue;
    const sub = submissionByHomework.get(hw.id) ?? null;
    const submittedAt = sub?.submittedAt ?? null;
    const { status, late } = homeworkStatus({
      submittedAt,
      status: sub?.status ?? null,
      deadline: hw.deadline ?? null,
      grade: sub?.grade ?? null,
      now,
    });
    homeworkItems.push({
      title: pickL10n(locale, hw.titleAr, hw.title),
      lessonTitle: lessonTitleById.get(hw.lessonId) ?? null,
      acceptingSubmissions: String(hw.status ?? "").toUpperCase() === "PUBLISHED",
      dueAt: iso(hw.deadline),
      status,
      submittedAt: iso(submittedAt),
      late,
      grade: sub?.grade ?? null,
      maxMarks: hw.maxMarks ?? null,
      feedback: sub?.feedback ?? null,
    });
  }

  const quizIds = quizRows
    .filter((q) => unlockedLessonIds.has(q.lessonId))
    .map((q) => q.id);
  const attempts = quizIds.length
    ? await db.quizAttempt.findMany({
        where: { studentId, quizId: { in: quizIds }, finishedAt: { not: null } },
        orderBy: { finishedAt: "asc" },
        select: {
          quizId: true,
          percentage: true,
          passed: true,
          finishedAt: true,
        },
      })
    : [];
  const attemptsByQuiz = new Map<string, typeof attempts>();
  for (const attempt of attempts) {
    const list = attemptsByQuiz.get(attempt.quizId) ?? [];
    list.push(attempt);
    attemptsByQuiz.set(attempt.quizId, list);
  }
  const quizItems: ParentQuizView[] = [];
  for (const quiz of quizRows) {
    if (!unlockedLessonIds.has(quiz.lessonId)) continue;
    const list = attemptsByQuiz.get(quiz.id) ?? [];
    const last = list[list.length - 1] ?? null;
    quizItems.push({
      title: pickL10n(locale, quiz.titleAr, quiz.title),
      lessonTitle: lessonTitleById.get(quiz.lessonId) ?? null,
      attempts: list.length,
      lastOutcome: last ? (last.passed ? "PASSED" : "FAILED") : null,
      lastPercentage: last ? last.percentage : null,
      bestPercentage:
        list.length > 0 ? Math.max(...list.map((a) => a.percentage)) : null,
      lastCompletedAt: iso(last?.finishedAt),
    });
  }

  // --- Live sessions (upcoming / rescheduled / cancelled) -----------------
  // ONE query, partitioned in JS. `toLiveSessionPayload`'s fields are read
  // raw here so the parent view stays minimal and carries no ids.
  let sessionViews: ParentSessionView[] = [];
  if (enrollment.groupId) {
    const windowStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const rows = await db.liveSession.findMany({
      where: {
        groupId: enrollment.groupId,
        OR: [
          { startAt: { gte: now } },
          { startAt: { gte: windowStart }, status: "CANCELLED" },
          { startAt: { gte: windowStart }, lastRescheduledAt: { not: null } },
        ],
      },
      orderBy: { startAt: "asc" },
      take: 60,
      select: {
        title: true,
        titleAr: true,
        startAt: true,
        duration: true,
        status: true,
        lessonId: true,
        cancelledAt: true,
        cancelReason: true,
        rescheduleCount: true,
        originalStartAt: true,
        teacher: { select: { user: { select: { name: true } } } },
        substituteTeacher: { select: { user: { select: { name: true } } } },
      },
    });
    sessionViews = rows.map((row) => sessionView(row, lessonTitleById, locale));
  }
  const upcoming = sessionViews
    .filter((s) => (s.status === "SCHEDULED" || s.status === "LIVE") && s.startAt >= iso(now)!)
    .slice(0, 5);
  const rescheduled = sessionViews
    .filter((s) => s.rescheduled && s.status !== "CANCELLED")
    .slice(-5)
    .reverse();
  const cancelled = sessionViews
    .filter((s) => s.status === "CANCELLED")
    .slice(-5)
    .reverse();

  // --- Teacher feedback ---------------------------------------------------
  // Two existing channels, both already parent-visible by construction:
  //   * the teacher's feedback on the child's own submission (Phase G);
  //   * TeacherNote — the write path (`createTeacherNoteWithFanout`) fans
  //     every note out to the linked parents as an ANNOUNCEMENT, and the model
  //     carries no internal/private class to separate.
  const notes = await db.teacherNote.findMany({
    where: { studentId },
    orderBy: { createdAt: "desc" },
    take: 5,
    select: {
      note: true,
      createdAt: true,
      teacher: { select: { user: { select: { name: true } } } },
    },
  });
  const teacherFeedback: ParentChildSnapshot["teacherFeedback"] = [
    ...homeworkItems
      .filter((hw) => !!hw.feedback)
      .map((hw) => ({
        source: "HOMEWORK" as const,
        title: hw.title,
        note: hw.feedback as string,
        authorName: null,
        at: hw.submittedAt ?? "",
      })),
    ...notes.map((n) => ({
      source: "TEACHER_NOTE" as const,
      title: null,
      note: n.note,
      authorName: n.teacher?.user?.name ?? null,
      at: iso(n.createdAt) ?? "",
    })),
  ];

  // --- Phase F absence cases ----------------------------------------------
  const absences: ParentChildSnapshot["absences"] = {
    excused: 0,
    unexcused: 0,
    pending: 0,
    recent: [],
  };
  for (const item of absenceCases) {
    const status = String(item.status ?? "").toUpperCase();
    if (status === "EXCUSED") absences.excused += 1;
    else if (status === "UNEXCUSED") absences.unexcused += 1;
    else if (status === "PENDING_REASON" || status === "PENDING_REVIEW") absences.pending += 1;
  }
  absences.recent = absenceCases.slice(0, 8).map((item) => ({
    sessionTitle: pickL10n(locale, item.session?.titleAr, item.session?.title),
    sessionStartAt: item.session?.startAt ?? "",
    status: String(item.status ?? ""),
    reason: item.reason ?? null,
    holdActive: String(item.hold?.status ?? "").toUpperCase() === "ACTIVE",
    decidedAt: item.decidedAt ?? null,
    decisionNote: item.decisionNote ?? null,
  }));

  // --- Phase H holds (catch-up views, ids stripped) ------------------------
  const holds: ParentHoldView[] = catchup.holds.map((hold) => {
    const view = toCatchupHoldView(hold);
    return {
      lessonTitle: view.lessonTitle,
      inUniverse: view.inUniverse,
      reason: view.reason,
      unmet: view.unmet,
      eligible: view.eligible,
    };
  });

  const currentLesson =
    (progression?.currentLessonId
      ? lessons.find((l) => l.position ===
          (progression.lessons.findIndex((x) => x.lessonId === progression.currentLessonId) + 1)
        ) ?? null
      : null) ?? null;

  const actionNeeded = buildActionNeeded({
    currentLesson,
    holds,
    homeworkItems,
    sessions: { upcoming, rescheduled, cancelled },
  });

  const totalLessons = lessons.length;
  const pct =
    totalLessons > 0 ? Math.min(100, Math.round((completedLessons / totalLessons) * 100)) : 0;

  return {
    student: {
      id: studentId,
      name: student.user?.name ?? "",
      grade: student.grade ?? null,
      schoolType: student.schoolType ?? null,
      studentCode: student.studentCode ?? null,
      avatarUrl: student.user?.avatarUrl ?? null,
    },
    course: student.group?.course
      ? {
          name: pickL10n(
            locale,
            student.group.course.nameAr,
            student.group.course.name
          ),
          track: schoolType ?? null,
        }
      : null,
    group: student.group
      ? { name: student.group.name, schedule: student.group.schedule ?? null }
      : null,
    progress: {
      completedLessons,
      totalLessons,
      pct,
      currentLesson,
      lockedLessons: lessons.filter((l) => !l.unlocked).length,
    },
    lessons,
    holds,
    absences,
    homework: {
      submitted: homeworkItems.filter((h) => h.submittedAt !== null).length,
      graded: homeworkItems.filter((h) => h.status === "GRADED").length,
      overdue: homeworkItems.filter((h) => h.status === "MISSING_OVERDUE").length,
      items: homeworkItems,
    },
    quizzes: {
      taken: quizItems.filter((q) => q.attempts > 0).length,
      passed: quizItems.filter((q) => q.lastOutcome === "PASSED").length,
      items: quizItems,
    },
    sessions: { upcoming, rescheduled, cancelled },
    teacherFeedback,
    actionNeeded,
    evaluatedAt: now.toISOString(),
  };
}
