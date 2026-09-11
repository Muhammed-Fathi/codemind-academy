// CodeMind Academy — Session (lesson) progression & access control.
//
// A student unlocks the next session only after satisfying every REQUIRED
// condition of the current one:
//   1. watched the lesson video to >= 95%
//   2. completed (passed-or-attempted) the lesson quiz
//   3. submitted the lesson assignment (homework)
//
// A component that does not exist is NOT required — a lesson without a quiz
// can never lock a student forever. Enforcement lives here (server side) and
// the UI merely mirrors the result.

import { db } from "@/lib/db";
import {
  LESSON_STUDENT_STATUS_FILTER,
  isStudentVisibleStatus,
} from "@/lib/session-lifecycle";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import {
  canAccessTrackScope,
  trackScopeWhere,
} from "@/lib/track-scope";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";
import { getStudentSchoolType } from "@/lib/enrollment";

// ---------------------------------------------------------------------------
// The progression UNIVERSE — how a lesson is attached to a course
// ---------------------------------------------------------------------------
//
// The canonical curriculum hierarchy is Course → Part → Unit → Lesson, reached
// through `Lesson.unitId`. `Topic` is a nullable LEGACY compatibility layer
// (`Lesson.topicId`) that still holds most of the seeded content.
//
// Both chains must reach the progression universe. If only the legacy chain is
// queried, an official unit-linked lesson (topicId = null) is invisible to
// `getCourseSessionProgress` — and an invisible lesson is NOT the same thing as
// a locked lesson: it never appears in the sequence, so `canAccessLesson`
// answers LESSON_NOT_FOUND (404) for it and the student can never get past it.
//
// When a lesson carries BOTH links the canonical `unitId` chain wins; the
// legacy chain is a fallback, never a second opinion. That single rule is what
// keeps there being exactly one progression system, and it is applied
// identically by the ordering below and by `/api/courses/[slug]` so a session
// is always displayed where the engine enforces it.

// ---------------------------------------------------------------------------
// Active-curriculum filters (Phase 11)
// ---------------------------------------------------------------------------
//
// Archived lessons are history, not curriculum: they keep their rows (so
// progress, attempts and submissions stay intact) but are excluded from every
// ACTIVE-curriculum read — the progression universe, the course tree, lesson
// navigation, dashboards, certificates and parent reports. Teacher
// management/grading scopes deliberately do NOT exclude archived rows (a
// pending legacy submission still needs grading); see the Phase 11 doc.
//
// Phase 13 adds the sibling filter `LESSON_STUDENT_STATUS_FILTER`
// (`status = PUBLISHED`) to the SAME set of reads. The two are always applied
// together and neither implies the other:
//
//   DRAFT / READY     → not in the student curriculum at all (invisible)
//   PUBLISHED         → in the curriculum; progression decides LOCKED/UNLOCKED
//   ARCHIVED          → history, never curriculum, whatever its status says

/** Spread into any lesson `where` to exclude archived lessons. */
export const EXCLUDE_ARCHIVED_LESSON = {
  curriculumStatus: { not: "ARCHIVED" },
} as const;

// ---------------------------------------------------------------------------
// Track scope (Phase 12)
// ---------------------------------------------------------------------------
//
// A lesson also belongs to a TRACK: `Lesson.trackScope` is SHARED (both school
// types), ARABIC or LANGUAGE. The student's side of the comparison is their
// own `Student.schoolType` row — never a request parameter, never the UI
// locale.
//
// The filter is applied to the progression UNIVERSE, i.e. to the same
// `findMany` that defines the session sequence. That placement is deliberate
// and is what makes one rule cover everything at once:
//
//   * an ineligible lesson is not in `sessions`, so it can never be an unlock
//     target, never satisfies completion and never advances progression;
//   * `canAccessLesson` answers LESSON_NOT_FOUND (a 404, not a 403) for it, so
//     guessing an id from the other track learns nothing about its existence;
//   * `canAccessQuiz` / `canAccessHomework` delegate to `canAccessLesson`, so
//     they inherit the same verdict without a second implementation;
//   * `getUnlockedLessonIds` (course tree, homework list, dashboard) inherits
//     it too, so no list endpoint can describe the other track's content.
//
// It NARROWS the universe; it never reorders it and never changes what
// "completed" means. Phase 4 progression semantics are untouched — with every
// lesson SHARED the result is byte-for-byte the pre-Phase-12 result.

/** Dual-chain course filter: canonical `unitId` chain OR legacy `topicId` chain. */
export function lessonCourseChainOr(courseId: string) {
  return [
    { unit: { part: { courseId } } },
    { topic: { unit: { part: { courseId } } } },
  ];
}

/** Dual-chain filter for a set of courses. */
export function lessonCoursesChainOr(courseIds: string[]) {
  return [
    { unit: { part: { courseId: { in: courseIds } } } },
    { topic: { unit: { part: { courseId: { in: courseIds } } } } },
  ];
}

/** Chain fields needed to place a lesson in its course. Shared by every query. */
export const LESSON_CHAIN_SELECT = {
  id: true,
  order: true,
  videoUrl: true,
  unitId: true,
  topicId: true,
  unit: {
    select: {
      id: true,
      order: true,
      part: { select: { id: true, order: true, courseId: true } },
    },
  },
  topic: {
    select: {
      order: true,
      unit: {
        select: {
          id: true,
          order: true,
          part: { select: { id: true, order: true, courseId: true } },
        },
      },
    },
  },
} as const;

export type LessonChain = {
  id: string;
  order: number;
  videoUrl: string | null;
  unitId: string | null;
  topicId: string | null;
  unit: {
    id: string;
    order: number;
    part: { id: string; order: number; courseId: string };
  } | null;
  topic: {
    order: number;
    unit: {
      id: string;
      order: number;
      part: { id: string; order: number; courseId: string };
    };
  } | null;
};

/**
 * The course a lesson belongs to, canonical chain first. Returns null for a
 * lesson that is attached to neither — such a lesson is not part of any course
 * and therefore not part of any progression.
 */
export function resolveLessonCourseId(lesson: LessonChain): string | null {
  return (
    lesson.unit?.part.courseId ??
    lesson.topic?.unit.part.courseId ??
    null
  );
}

/**
 * Sortable position of a lesson inside `courseId`. `null` when neither chain
 * of this lesson resolves to `courseId` (defensive: the query should not
 * return such a row, and silently inventing a position would be worse than
 * dropping it).
 *
 * Deterministic total order: Part.order → Unit.order → Topic.order →
 * Lesson.order → id. Unit-linked lessons have no Topic, so they sort by
 * `topicOrder = TOPIC_ORDER_NONE` and therefore come before the legacy topics
 * of the same Unit; the trailing id tie-break makes the order total even when
 * two rows share every declared `order`.
 */
const TOPIC_ORDER_NONE = -1;

type ChainPosition = {
  partOrder: number;
  unitOrder: number;
  topicOrder: number;
};

function chainPositionOf(
  lesson: LessonChain,
  courseId: string
): ChainPosition | null {
  if (lesson.unit && lesson.unit.part.courseId === courseId) {
    return {
      partOrder: lesson.unit.part.order,
      unitOrder: lesson.unit.order,
      topicOrder: TOPIC_ORDER_NONE,
    };
  }
  const legacy = lesson.topic;
  if (legacy && legacy.unit.part.courseId === courseId) {
    return {
      partOrder: legacy.unit.part.order,
      unitOrder: legacy.unit.order,
      topicOrder: legacy.order,
    };
  }
  return null;
}

function comparePosition(
  a: ChainPosition & { order: number; id: string },
  b: ChainPosition & { order: number; id: string }
): number {
  return (
    a.partOrder - b.partOrder ||
    a.unitOrder - b.unitOrder ||
    a.topicOrder - b.topicOrder ||
    a.order - b.order ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
}

/**
 * Order the lessons of `courseId` deterministically, dropping any row that
 * cannot be attributed to this course.
 */
export function orderCourseLessons<T extends LessonChain>(
  lessons: T[],
  courseId: string
): T[] {
  return lessons
    .map((lesson) => ({ lesson, pos: chainPositionOf(lesson, courseId) }))
    .filter((x): x is { lesson: T; pos: ChainPosition } => x.pos !== null)
    .sort((x, y) =>
      comparePosition(
        { ...x.pos, order: x.lesson.order, id: x.lesson.id },
        { ...y.pos, order: y.lesson.order, id: y.lesson.id }
      )
    )
    .map((x) => x.lesson);
}

export type SessionRequirement = {
  /** Whether this lesson actually has the component at all. */
  required: boolean;
  done: boolean;
  /** 0-100 where meaningful (video), else 0/100. */
  value: number;
};

export type SessionStatusRow = {
  lessonId: string;
  order: number;
  /** true when every REQUIRED condition of this lesson is satisfied. */
  completed: boolean;
  /** true when the student is allowed to open this lesson. */
  unlocked: boolean;
  video: SessionRequirement;
  quiz: SessionRequirement;
  assignment: SessionRequirement;
};

export type CourseSessionProgress = {
  courseId: string;
  /** Ordered lessons with their gating status. */
  sessions: SessionStatusRow[];
  byLessonId: Map<string, SessionStatusRow>;
  /** First lesson the student should work on. */
  currentLessonId: string | null;
};

/**
 * Compute the gating state of every lesson of `courseId` for `studentId`.
 * Uses a fixed, small number of queries regardless of the lesson count.
 *
 * `schoolType` may be supplied by a caller that has already loaded the student
 * row; when omitted it is read from the database. It decides the track slice
 * of the universe (see the Phase 12 block above) and is always normalised
 * here, so an unrecognised value fails closed to SHARED-only rather than
 * widening the universe.
 */
export async function getCourseSessionProgress(
  studentId: string,
  courseId: string,
  schoolType?: SchoolType | string | null
): Promise<CourseSessionProgress> {
  const resolvedSchoolType = normalizeSchoolType(
    schoolType === undefined
      ? (
          await db.student.findUnique({
            where: { id: studentId },
            select: { schoolType: true },
          })
        )?.schoolType
      : schoolType
  );

  // ONE progression universe: a lesson belongs to this course through the
  // canonical Unit chain OR the legacy Topic chain, and (Phase 13) is
  // PUBLISHED in the administrative lifecycle. `orderCourseLessons` then
  // applies the deterministic Course → Part → Unit → (Topic) → Lesson order,
  // which Prisma `orderBy` cannot express on its own because the Topic link is
  // nullable. Archived lessons are history, not curriculum (Phase 11), so the
  // universe excludes them: every progression surface derives from `found`.
  //
  // Phase 12 adds the track slice: only lessons whose `trackScope` this
  // student is eligible for enter the universe at all.
  // Phase 13 adds the LIFECYCLE slice: only PUBLISHED sessions are part of a
  // student's curriculum at all. A DRAFT/READY lesson is not a locked session
  // — it does not exist for students — and an unpublished lesson must never
  // enter the sequence, because a lesson in the sequence is a lesson the next
  // one waits for. `isPublished` is gone from this predicate on purpose: the
  // mirror must not drive progression.
  const found = await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      ...EXCLUDE_ARCHIVED_LESSON,
      ...trackScopeWhere(resolvedSchoolType),
      OR: [
        { unit: { part: { courseId } } },
        { topic: { unit: { part: { courseId } } } },
      ],
    },
    select: {
      ...LESSON_CHAIN_SELECT,
      quizzes: { select: { id: true } },
      homeworks: { select: { id: true } },
    },
  }) as unknown as Array<LessonChain & { quizzes: { id: string }[]; homeworks: { id: string }[] }>
  const lessons = orderCourseLessons(found, courseId) as Array<LessonChain & { quizzes: { id: string }[]; homeworks: { id: string }[] }>;

  const lessonIds = lessons.map((l) => l.id);
  const quizIds = lessons.flatMap((l) => l.quizzes.map((q: { id: string }) => q.id));
  const homeworkIds = lessons.flatMap((l) => l.homeworks.map((h: { id: string }) => h.id));

  const [progressRows, quizAttempts, submissions] = await Promise.all([
    lessonIds.length
      ? db.lessonProgress.findMany({
          where: { studentId, lessonId: { in: lessonIds } },
          select: { lessonId: true, videoPercent: true, videoCompleted: true, isCompleted: true },
        })
      : Promise.resolve<Array<{ lessonId: string; videoPercent: number; videoCompleted: boolean; isCompleted: boolean }>>([]),
    quizIds.length
      ? db.quizAttempt.findMany({
          where: { studentId, quizId: { in: quizIds }, finishedAt: { not: null } },
          select: { quizId: true, percentage: true },
        })
      : Promise.resolve<Array<{ quizId: string; percentage: number }>>([]),
    homeworkIds.length
      ? db.homeworkSubmission.findMany({
          where: {
            studentId,
            homeworkId: { in: homeworkIds },
            submittedAt: { not: null },
          },
          select: { homeworkId: true },
        })
      : Promise.resolve<Array<{ homeworkId: string }>>([]),
  ]);

  const progressByLesson = new Map(progressRows.map((p) => [p.lessonId, p]));
  const attemptedQuizzes = new Set(quizAttempts.map((a) => a.quizId));
  const submittedHomeworks = new Set(submissions.map((s) => s.homeworkId));

  const sessions: SessionStatusRow[] = [];
  let previousCompleted = true; // the very first lesson is always unlocked

  for (const lesson of lessons) {
    const lp = progressByLesson.get(lesson.id) as { videoPercent: number; videoCompleted: boolean; isCompleted: boolean } | undefined;

    const hasVideo = !!lesson.videoUrl;
    const videoPercent = lp?.videoPercent ?? 0;
    const videoDone = hasVideo
      ? !!lp?.videoCompleted || videoPercent >= VIDEO_COMPLETION_THRESHOLD
      : true;

    const hasQuiz = lesson.quizzes.length > 0;
    const quizDone = hasQuiz
      ? lesson.quizzes.every((q) => attemptedQuizzes.has(q.id))
      : true;

    const hasHomework = lesson.homeworks.length > 0;
    const assignmentDone = hasHomework
      ? lesson.homeworks.every((h) => submittedHomeworks.has(h.id))
      : true;

    const completed = videoDone && quizDone && assignmentDone;

    const row: SessionStatusRow = {
      lessonId: lesson.id,
      order: lesson.order,
      completed,
      unlocked: previousCompleted,
      video: { required: hasVideo, done: videoDone, value: hasVideo ? videoPercent : 100 },
      quiz: { required: hasQuiz, done: quizDone, value: quizDone ? 100 : 0 },
      assignment: {
        required: hasHomework,
        done: assignmentDone,
        value: assignmentDone ? 100 : 0,
      },
    };
    sessions.push(row);
    previousCompleted = completed;
  }

  const current = sessions.find((s) => s.unlocked && !s.completed) || null;

  return {
    courseId,
    sessions,
    byLessonId: new Map(sessions.map((s) => [s.lessonId, s])),
    currentLessonId: current?.lessonId ?? null,
  };
}

export type AccessReason =
  | null
  | "NOT_ENROLLED"
  | "LESSON_NOT_FOUND"
  | "PREVIOUS_SESSION_INCOMPLETE";

export type LessonAccess = {
  allowed: boolean;
  reason: AccessReason;
  status: SessionStatusRow | null;
};

/**
 * Gating result for a resource that hangs off a lesson (quiz, homework).
 * `status` is deliberately absent: it describes the REQUIREMENTS of a session
 * the caller may not be allowed to open yet, and returning it would tell a
 * probing client which components (video / quiz / assignment) a locked
 * session hides.
 */
export type ResourceAccess = {
  allowed: boolean;
  reason: AccessReason;
};

/**
 * Server-side authorization for opening a single lesson. Must be called by
 * every route that returns lesson content — hiding it in the UI is not enough.
 */
export async function canAccessLesson(
  studentId: string,
  lessonId: string
): Promise<LessonAccess> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      ...LESSON_CHAIN_SELECT,
      trackScope: true,
      status: true,
      curriculumStatus: true,
    },
  });
  if (!lesson) return { allowed: false, reason: "LESSON_NOT_FOUND", status: null };

  // LIFECYCLE GATE (Phase 13, the same structural choice as the track gate
  // below): refusal happens HERE, before progression is computed, and the
  // verdict is LESSON_NOT_FOUND — indistinguishable from a nonexistent id, so
  // probing lesson ids cannot enumerate what an admin has staged but not
  // opened. The progression universe already excludes non-PUBLISHED lessons;
  // this explicit gate keeps the rule visible and keeps the answer correct if
  // a future reader ever widens that query.
  if (
    !isStudentVisibleStatus(lesson.status) ||
    String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED"
  ) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", status: null };
  }

  // Canonical `unitId` chain first, legacy `topicId` chain as fallback (see
  // `resolveLessonCourseId`). A lesson attached to neither is not part of any
  // course this gating rule can verify, so access stays closed.
  const courseId = resolveLessonCourseId(lesson);
  if (!courseId) return { allowed: false, reason: "LESSON_NOT_FOUND", status: null };

  // Enrollment must be judged by exactly the same rule as getEnrollment():
  // membership of an ACTIVE group bound to this course. Omitting `isActive`
  // here would let a student whose group was deactivated keep opening lesson
  // content even though /api/courses/[slug] already refuses them — an
  // inconsistency between two authorization paths is a bug in itself.
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      schoolType: true,
      group: { select: { courseId: true, isActive: true } },
    },
  });
  if (
    !student?.group ||
    !student.group.isActive ||
    student.group.courseId !== courseId
  ) {
    return { allowed: false, reason: "NOT_ENROLLED", status: null };
  }

  // TRACK GATE (Phase 12, check #5 of the authorization contract).
  //
  // A lesson belonging to the other school type is refused HERE, before any
  // progression is computed. The verdict is LESSON_NOT_FOUND — the same
  // answer an id that does not exist gets — so probing ids from the other
  // track cannot reveal that the lesson is real. The progression universe
  // excludes it as well; this explicit gate keeps the rule visible and
  // correct even if a future reader widens that query.
  const schoolType = normalizeSchoolType(student.schoolType);
  if (!canAccessTrackScope(schoolType, lesson.trackScope)) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", status: null };
  }

  const progress = await getCourseSessionProgress(studentId, courseId, schoolType);
  const status = progress.byLessonId.get(lessonId) || null;
  if (!status) return { allowed: false, reason: "LESSON_NOT_FOUND", status: null };
  if (!status.unlocked)
    return { allowed: false, reason: "PREVIOUS_SESSION_INCOMPLETE", status };

  return { allowed: true, reason: null, status };
}

// ---------------------------------------------------------------------------
// Resource-level gating (quiz, homework)
// ---------------------------------------------------------------------------
//
// A quiz or an assignment is only ever reachable through the session it
// belongs to. Without this, a student who knows (or guesses) an id could POST
// straight to `/api/quizzes/<id>/submit` for a session they have not unlocked
// and pre-satisfy that session's quiz requirement — turning the quiz gate into
// a no-op for the whole course, and reading the questions/answers of content
// they were never allowed to open.
//
// Both helpers resolve to the OWNING LESSON and then re-use `canAccessLesson`,
// so there is exactly one definition of "may this student open this session".

/**
 * Gate a resource that belongs to a lesson AND carries its own trackScope.
 *
 * Two independent conditions, both fail-closed:
 *   1. the owning lesson must be open to this student (`canAccessLesson`,
 *      which already enforces enrollment, the lesson's own trackScope and the
 *      progression gate);
 *   2. the resource's OWN trackScope must be eligible for the student.
 *
 * Condition 2 is not redundant: a SHARED lesson may legitimately host an
 * ARABIC quiz and a LANGUAGE quiz, so the resource scope can be narrower than
 * the lesson scope. It can never usefully be WIDER — a LANGUAGE quiz on a
 * LANGUAGE lesson is already refused by condition 1 for an ARABIC student.
 */
async function gateTrackedResource(
  studentId: string,
  lessonId: string | null,
  trackScope: unknown
): Promise<ResourceAccess> {
  if (!lessonId) return { allowed: false, reason: "LESSON_NOT_FOUND" };

  const access = await canAccessLesson(studentId, lessonId);
  if (!access.allowed) return { allowed: false, reason: access.reason };

  const schoolType = await getStudentSchoolType(studentId);
  if (!canAccessTrackScope(schoolType, trackScope)) {
    // Same non-oracle answer as "this resource does not exist": a student
    // probing the other track's quiz/homework ids learns nothing.
    return { allowed: false, reason: "LESSON_NOT_FOUND" };
  }
  return { allowed: true, reason: null };
}

/**
 * Server-side authorization for a quiz. Callers must treat
 * `LESSON_NOT_FOUND` as 404 and the other reasons as 403.
 */
export async function canAccessQuiz(
  studentId: string,
  quizId: string
): Promise<ResourceAccess> {
  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
    select: { lessonId: true, trackScope: true },
  });
  if (!quiz) return { allowed: false, reason: "LESSON_NOT_FOUND" };
  return gateTrackedResource(studentId, quiz.lessonId, quiz.trackScope);
}

/** Server-side authorization for a homework/assignment. */
export async function canAccessHomework(
  studentId: string,
  homeworkId: string
): Promise<ResourceAccess> {
  const homework = await db.homework.findUnique({
    where: { id: homeworkId },
    select: { lessonId: true, trackScope: true },
  });
  if (!homework) return { allowed: false, reason: "LESSON_NOT_FOUND" };
  return gateTrackedResource(studentId, homework.lessonId, homework.trackScope);
}

/**
 * Batch gate a set of lessons at once and report which ones are open.
 *
 * Used by list endpoints (course tree, homework list, dashboard) so a single
 * request cannot describe the protected content of sessions the student has
 * not unlocked. One progression computation for the whole course — no N+1.
 */
export async function getUnlockedLessonIds(
  studentId: string,
  courseId: string
): Promise<Set<string>> {
  const progress = await getCourseSessionProgress(studentId, courseId);
  return new Set(
    progress.sessions.filter((s) => s.unlocked).map((s) => s.lessonId)
  );
}
