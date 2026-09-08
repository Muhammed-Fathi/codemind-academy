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
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";

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
 */
export async function getCourseSessionProgress(
  studentId: string,
  courseId: string
): Promise<CourseSessionProgress> {
  const lessons = await db.lesson.findMany({
    where: { topic: { unit: { part: { courseId } } }, isPublished: true },
    orderBy: [
      { topic: { unit: { part: { order: "asc" } } } },
      { topic: { unit: { order: "asc" } } },
      { topic: { order: "asc" } },
      { order: "asc" },
    ],
    select: {
      id: true,
      order: true,
      videoUrl: true,
      quizzes: { select: { id: true } },
      homeworks: { select: { id: true } },
    },
  });

  const lessonIds = lessons.map((l) => l.id);
  const quizIds = lessons.flatMap((l) => l.quizzes.map((q) => q.id));
  const homeworkIds = lessons.flatMap((l) => l.homeworks.map((h) => h.id));

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
    const lp = progressByLesson.get(lesson.id);

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
      id: true,
      topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } },
    },
  });
  if (!lesson) return { allowed: false, reason: "LESSON_NOT_FOUND", status: null };

  // `topic` is the nullable legacy link; a lesson without it is not attached
  // to any course this gating rule can verify, so access stays closed.
  const courseId = lesson.topic?.unit.part.courseId;
  if (!courseId) return { allowed: false, reason: "LESSON_NOT_FOUND", status: null };

  // Enrollment must be judged by exactly the same rule as getEnrollment():
  // membership of an ACTIVE group bound to this course. Omitting `isActive`
  // here would let a student whose group was deactivated keep opening lesson
  // content even though /api/courses/[slug] already refuses them — an
  // inconsistency between two authorization paths is a bug in itself.
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { group: { select: { courseId: true, isActive: true } } },
  });
  if (
    !student?.group ||
    !student.group.isActive ||
    student.group.courseId !== courseId
  ) {
    return { allowed: false, reason: "NOT_ENROLLED", status: null };
  }

  const progress = await getCourseSessionProgress(studentId, courseId);
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

/** Gate any resource that belongs to a lesson, by lesson id. */
async function gateByLesson(
  studentId: string,
  lessonId: string | null
): Promise<ResourceAccess> {
  if (!lessonId) return { allowed: false, reason: "LESSON_NOT_FOUND" };
  const access = await canAccessLesson(studentId, lessonId);
  return { allowed: access.allowed, reason: access.reason };
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
    select: { lessonId: true },
  });
  if (!quiz) return { allowed: false, reason: "LESSON_NOT_FOUND" };
  return gateByLesson(studentId, quiz.lessonId);
}

/** Server-side authorization for a homework/assignment. */
export async function canAccessHomework(
  studentId: string,
  homeworkId: string
): Promise<ResourceAccess> {
  const homework = await db.homework.findUnique({
    where: { id: homeworkId },
    select: { lessonId: true },
  });
  if (!homework) return { allowed: false, reason: "LESSON_NOT_FOUND" };
  return gateByLesson(studentId, homework.lessonId);
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
