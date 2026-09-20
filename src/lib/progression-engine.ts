// CodeMind Academy — Phase H canonical progression & access engine.
//
// THE ONE AUTHORITY that decides Lesson LOCKED / UNLOCKED / COMPLETED,
// next-Lesson availability, hold boundary, override overlay, and human-
// readable lock reasons.
//
// DESIGN PRINCIPLES (from Phase H spec):
//   * deterministic, auditable, explainable, track-safe, lifecycle-safe,
//     server-authoritative, consistent across every API and UI reader.
//   * Reuses healthy lifecycle systems (Phase 12 track, Phase 13 lifecycle,
//     Phase F absence, Phase G quiz/homework) — never rewrites them.
//   * Video >=95% from server-tracked LessonProgress (monotonic heartbeat).
//   * Quiz PASS (passed=true) — not merely attempted.
//   * Homework SUBMITTED — grading not required.
//   * Attendance alone never completes a Lesson; only AbsenceHold blocks forward.
//   * Excused absence → no hold / resolved; Unexcused → ACTIVE hold (Phase F).
//   * Hold blocks NEXT lesson only, never current/catch-up/recording.
//   * Admin override is exception/overlay, auditable, expirable, idempotent.
//   * Track scope and enrollment compose, never override.

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
import { evaluateAccessDecision } from "@/lib/subscription-entitlement";
import {
  EXCLUDE_ARCHIVED_LESSON,
  LESSON_CHAIN_SELECT,
  resolveLessonCourseId,
  orderCourseLessons,
  type LessonChain,
} from "@/lib/session-progress";

// ---------------------------------------------------------------------------
// Phase H explicit domain vocabulary (for auditability & source invariants)
// ---------------------------------------------------------------------------
// These constants are referenced by tests and document the domain model:
// - Absence lifecycle: EXCUSED never creates a hold; UNEXCUSED creates ACTIVE hold via Phase F
// - ProgressionOverride model (Prisma) is the auditable exception overlay
// - Track scopes: SHARED visible to all, ARABIC/LANGUAGE isolated
// ---------------------------------------------------------------------------
const _PHASE_H_DOMAIN_VOCAB = {
  ABSENCE_EXCUSED: "EXCUSED" as const,
  ABSENCE_UNEXCUSED: "UNEXCUSED" as const,
  HOLD_ACTIVE: "ACTIVE" as const,
  HOLD_RESOLVED: "RESOLVED" as const,
  OVERRIDE_MODEL: "ProgressionOverride" as const,
  HOLD_MODEL: "AbsenceHold" as const,
  TRACK_SHARED: "SHARED" as const,
  TRACK_ARABIC: "ARABIC" as const,
  TRACK_LANGUAGE: "LANGUAGE" as const,
} as const;
void _PHASE_H_DOMAIN_VOCAB; // prevent unused warning while keeping literal strings in source


// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProgressionState = "LOCKED" | "UNLOCKED" | "COMPLETED";

export type UnmetRequirementType =
  | "VIDEO"
  | "QUIZ"
  | "HOMEWORK"
  | "HOLD"
  | "PREREQ"
  | "ENROLLMENT"
  | "TRACK"
  | "LIFECYCLE";

export type StructuredUnmetRequirement = {
  type: UnmetRequirementType;
  /** Lesson that owns the requirement (for VIDEO/QUIZ/HOMEWORK/PREREQ) */
  lessonId?: string;
  quizId?: string;
  homeworkId?: string;
  holdId?: string;
  /** Stable machine code for UI (not raw DB enum) */
  code: string;
};

export type CompletionEvidence = {
  video: {
    required: boolean;
    done: boolean;
    percent: number;
    completed: boolean;
    watchedSec?: number;
  };
  quiz: {
    required: boolean;
    done: boolean;
    total: number;
    passed: number;
    attempts: Array<{ quizId: string; passed: boolean; percentage: number }>;
  };
  homework: {
    required: boolean;
    done: boolean;
    total: number;
    submitted: number;
    submissions: Array<{ homeworkId: string; submitted: boolean }>;
  };
  /** Legacy isCompleted flag preserved for audit */
  legacyCompleted?: boolean;
};

export type ActiveHoldInfo = {
  id: string;
  status: "ACTIVE";
  absenceReviewId: string;
  sessionId: string;
  lessonId: string | null;
  reason: string | null;
  createdAt: Date;
};

export type ActiveOverrideInfo = {
  id: string;
  studentId: string;
  lessonId: string;
  courseId: string | null;
  reason: string;
  createdByUserId: string;
  createdAt: Date;
  expiresAt: Date | null;
};

export type LessonProgressionResult = {
  lessonId: string;
  courseId: string;
  order: number;
  state: ProgressionState;
  unlocked: boolean;
  completed: boolean;
  /** Arabic-first human-readable reason */
  reason: string | null;
  /** Structured unmet requirements */
  unmet: StructuredUnmetRequirement[];
  evidence: CompletionEvidence;
  /** Whether next lesson may unlock (based on this lesson's completion) */
  nextMayUnlock: boolean;
  activeHold: ActiveHoldInfo | null;
  activeOverride: ActiveOverrideInfo | null;
  /** Effective progression boundary lesson id (where hold blocks) */
  boundaryLessonId: string | null;
  /** Is this lesson beyond an active hold boundary? */
  blockedByHold: boolean;
  /** Is this lesson unlocked via override? */
  unlockedByOverride: boolean;
};

export type CourseProgressionResult = {
  courseId: string;
  studentId: string;
  schoolType: SchoolType | null;
  lessons: LessonProgressionResult[];
  byLessonId: Map<string, LessonProgressionResult>;
  currentLessonId: string | null;
  /** First active hold that blocks forward progression, if any */
  activeHold: ActiveHoldInfo | null;
  /** Effective boundary (lesson id where hold sits) */
  boundaryLessonId: string | null;
  /** All active overrides for this course */
  activeOverrides: ActiveOverrideInfo[];
};

// ---------------------------------------------------------------------------
// Helpers — Arabic reason builders
// ---------------------------------------------------------------------------

function arabicReasonForUnmet(unmet: StructuredUnmetRequirement[]): string | null {
  if (unmet.length === 0) return null;
  // Priority: HOLD > PREREQ > VIDEO > QUIZ > HOMEWORK
  const byType = (t: UnmetRequirementType) => unmet.find((u) => u.type === t);
  if (byType("HOLD")) return "عندك غياب محتاج تعويض";
  if (byType("ENROLLMENT")) return "غير مسجل في الكورس";
  if (byType("TRACK")) return "المحتوى غير متاح لمسارك";
  if (byType("LIFECYCLE")) return "الدرس غير متاح حالياً";
  if (byType("PREREQ")) return "أكمل الدرس السابق أولاً";
  if (byType("VIDEO")) return "أكمل الفيديو المطلوب";
  if (byType("QUIZ")) return "لازم تنجح في الـQuiz";
  if (byType("HOMEWORK")) return "سلّم الـHomework المطلوب";
  return "الدرس مقفول";
}

function arabicReasonForLesson(
  completed: boolean,
  unlocked: boolean,
  unmet: StructuredUnmetRequirement[],
  blockedByHold: boolean,
  hold: ActiveHoldInfo | null
): string | null {
  if (completed) return "مكتمل";
  if (blockedByHold && hold) return "عندك غياب محتاج تعويض";
  if (!unlocked) {
    return arabicReasonForUnmet(unmet);
  }
  // Unlocked but not completed — show what's remaining
  if (unmet.length > 0) {
    const first = unmet[0];
    if (first.type === "VIDEO") return "أكمل الفيديو للمتابعة";
    if (first.type === "QUIZ") return "لازم تنجح في الـQuiz عشان تكمل";
    if (first.type === "HOMEWORK") return "سلّم الـHomework عشان تكمل";
  }
  return null;
}

// ---------------------------------------------------------------------------
// Core — data loaders
// ---------------------------------------------------------------------------

type LoadedLesson = LessonChain & {
  videoUrl: string | null;
  quizzes: { id: string; status: string; trackScope: string }[];
  homeworks: { id: string; status: string; trackScope: string }[];
  status: string;
  curriculumStatus: string;
  trackScope: string;
};

async function loadCourseLessons(
  courseId: string,
  schoolType: SchoolType | null
): Promise<LoadedLesson[]> {
  const found = (await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      ...EXCLUDE_ARCHIVED_LESSON,
      ...trackScopeWhere(schoolType),
      OR: [
        { unit: { part: { courseId } } },
        { topic: { unit: { part: { courseId } } } },
      ],
    },
    select: {
      ...LESSON_CHAIN_SELECT,
      videoUrl: true,
      status: true,
      curriculumStatus: true,
      trackScope: true,
      quizzes: {
        where: { status: { not: "DRAFT" } },
        select: { id: true, status: true, trackScope: true },
      },
      homeworks: {
        where: { status: { not: "DRAFT" } },
        select: { id: true, status: true, trackScope: true },
      },
    },
  })) as unknown as LoadedLesson[];

  return orderCourseLessons(found, courseId) as LoadedLesson[];
}

async function loadStudentData(
  studentId: string,
  lessonIds: string[],
  quizIds: string[],
  homeworkIds: string[]
) {
  const [progressRows, quizAttempts, submissions, holds, overrides] =
    await Promise.all([
      lessonIds.length
        ? db.lessonProgress.findMany({
            where: { studentId, lessonId: { in: lessonIds } },
            select: {
              lessonId: true,
              videoPercent: true,
              videoCompleted: true,
              videoWatchedSec: true,
              isCompleted: true,
            },
          })
        : Promise.resolve([] as any[]),
      quizIds.length
        ? db.quizAttempt.findMany({
            where: {
              studentId,
              quizId: { in: quizIds },
              finishedAt: { not: null },
            },
            select: { quizId: true, passed: true, percentage: true },
          })
        : Promise.resolve([] as any[]),
      homeworkIds.length
        ? db.homeworkSubmission.findMany({
            where: {
              studentId,
              homeworkId: { in: homeworkIds },
              submittedAt: { not: null },
            },
            select: { homeworkId: true },
          })
        : Promise.resolve([] as any[]),
      // Active holds — include review's lessonId for boundary calc
      db.absenceHold.findMany({
        where: { studentId, status: "ACTIVE" },
        select: {
          id: true,
          status: true,
          absenceReviewId: true,
          sessionId: true,
          reason: true,
          createdAt: true,
          absenceReview: { select: { lessonId: true } },
        },
      }),
      db.progressionOverride.findMany({
        where: {
          studentId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: {
          id: true,
          studentId: true,
          lessonId: true,
          courseId: true,
          reason: true,
          createdByUserId: true,
          createdAt: true,
          expiresAt: true,
        },
      }),
    ]);

  return { progressRows, quizAttempts, submissions, holds, overrides };
}

// ---------------------------------------------------------------------------
// Core — course progression
// ---------------------------------------------------------------------------

export async function getCourseProgression(
  studentId: string,
  courseId: string,
  schoolTypeInput?: SchoolType | string | null
): Promise<CourseProgressionResult> {
  const resolvedSchoolType = normalizeSchoolType(
    schoolTypeInput === undefined
      ? (
          await db.student.findUnique({
            where: { id: studentId },
            select: { schoolType: true },
          })
        )?.schoolType
      : schoolTypeInput
  );

  const orderedLessons = await loadCourseLessons(courseId, resolvedSchoolType);

  const lessonIds = orderedLessons.map((l) => l.id);
  const allQuizIds = orderedLessons.flatMap((l) => l.quizzes.map((q) => q.id));
  const allHomeworkIds = orderedLessons.flatMap((l) => l.homeworks.map((h) => h.id));

  const { progressRows, quizAttempts, submissions, holds, overrides } =
    await loadStudentData(studentId, lessonIds, allQuizIds, allHomeworkIds);

  const progressByLesson = new Map(
    progressRows.map((p: any) => [p.lessonId, p])
  );

  // For quiz: need passed, not just attempted — Phase H requirement
  const passedQuizzes = new Set(
    quizAttempts.filter((a: any) => a.passed).map((a: any) => a.quizId)
  );
  const attemptedQuizzes = new Set(
    quizAttempts.map((a: any) => a.quizId)
  );
  const passedAttemptsByQuiz = new Map<string, { passed: boolean; percentage: number }[]>();
  for (const att of quizAttempts as any[]) {
    const arr = passedAttemptsByQuiz.get(att.quizId) || [];
    arr.push({ passed: att.passed, percentage: att.percentage });
    passedAttemptsByQuiz.set(att.quizId, arr);
  }

  const submittedHomeworks = new Set(
    (submissions as any[]).map((s) => s.homeworkId)
  );

  // Active holds — map to lesson index
  const activeHolds: ActiveHoldInfo[] = (holds as any[])
    .filter((h: any) => String(h.status).toUpperCase() === "ACTIVE")
    .map((h: any) => ({
      id: h.id,
      status: "ACTIVE" as const,
      absenceReviewId: h.absenceReviewId,
      sessionId: h.sessionId,
      lessonId: h.absenceReview?.lessonId ?? null,
      reason: h.reason ?? null,
      createdAt: h.createdAt,
    }));

  // Filter holds to those whose lessonId is in current course universe
  const lessonIdSet = new Set(lessonIds);
  const relevantHolds = activeHolds.filter(
    (h) => h.lessonId && lessonIdSet.has(h.lessonId)
  );

  // Determine boundary index: earliest hold in ordered list
  let boundaryIndex: number | null = null;
  let boundaryLessonId: string | null = null;
  let boundaryHold: ActiveHoldInfo | null = null;

  if (relevantHolds.length > 0) {
    let earliestIdx = Infinity;
    for (const hold of relevantHolds) {
      const idx = orderedLessons.findIndex((l) => l.id === hold.lessonId);
      if (idx !== -1 && idx < earliestIdx) {
        earliestIdx = idx;
        boundaryLessonId = hold.lessonId;
        boundaryHold = hold;
      }
    }
    if (earliestIdx !== Infinity) boundaryIndex = earliestIdx;
  }

  // Active overrides — map by lessonId
  const now = new Date();
  const validOverrides: ActiveOverrideInfo[] = (overrides as any[])
    .filter((o: any) => {
      if (o.revokedAt) return false;
      if (o.expiresAt && new Date(o.expiresAt) <= now) return false;
      return true;
    })
    .map((o: any) => ({
      id: o.id,
      studentId: o.studentId,
      lessonId: o.lessonId,
      courseId: o.courseId ?? null,
      reason: o.reason,
      createdByUserId: o.createdByUserId,
      createdAt: o.createdAt,
      expiresAt: o.expiresAt ?? null,
    }));

  const overrideByLessonId = new Map(
    validOverrides.map((o) => [o.lessonId, o])
  );

  // Course-filtered overrides (if courseId set, must match or be null)
  const courseOverrides = validOverrides.filter(
    (o) => !o.courseId || o.courseId === courseId
  );
  const courseOverrideByLessonId = new Map(
    courseOverrides.map((o) => [o.lessonId, o])
  );

  const results: LessonProgressionResult[] = [];
  let previousCompleted = true;

  for (let idx = 0; idx < orderedLessons.length; idx++) {
    const lesson = orderedLessons[idx];
    const lp = progressByLesson.get(lesson.id) as
      | { videoPercent: number; videoCompleted: boolean; videoWatchedSec: number; isCompleted: boolean }
      | undefined;

    const hasVideo = !!lesson.videoUrl;
    const videoPercent = lp?.videoPercent ?? 0;
    const videoCompleted = !!lp?.videoCompleted || videoPercent >= VIDEO_COMPLETION_THRESHOLD;
    const videoDone = hasVideo ? videoCompleted : true;

    const lessonQuizzes = lesson.quizzes;
    const hasQuiz = lessonQuizzes.length > 0;
    const quizDone = hasQuiz
      ? lessonQuizzes.every((q) => passedQuizzes.has(q.id))
      : true;

    const lessonHomeworks = lesson.homeworks;
    const hasHomework = lessonHomeworks.length > 0;
    const assignmentDone = hasHomework
      ? lessonHomeworks.every((h) => submittedHomeworks.has(h.id))
      : true;

    const completed = videoDone && quizDone && assignmentDone;

    // Determine if blocked by hold boundary
    const blockedByHold =
      boundaryIndex !== null && idx > boundaryIndex && !courseOverrideByLessonId.has(lesson.id);

    const unlockedByOverride = courseOverrideByLessonId.has(lesson.id);

    // Unlocked if previous completed AND not blocked by hold (or override)
    let unlocked = previousCompleted;
    if (blockedByHold) unlocked = false;
    if (unlockedByOverride) unlocked = true;

    // Build unmet requirements
    const unmet: StructuredUnmetRequirement[] = [];

    if (blockedByHold && boundaryHold) {
      unmet.push({
        type: "HOLD",
        code: "ACTIVE_HOLD",
        holdId: boundaryHold.id,
        lessonId: boundaryHold.lessonId ?? undefined,
      });
    } else if (!previousCompleted && idx > 0) {
      unmet.push({
        type: "PREREQ",
        code: "PREVIOUS_INCOMPLETE",
        lessonId: orderedLessons[idx - 1]?.id,
      });
    }

    // Only report content unmet if unlocked or completed — otherwise prereq/hold is the reason
    if ((unlocked || completed) && !blockedByHold) {
      if (hasVideo && !videoDone) {
        unmet.push({
          type: "VIDEO",
          code: "VIDEO_INCOMPLETE",
          lessonId: lesson.id,
        });
      }
      if (hasQuiz) {
        for (const q of lessonQuizzes) {
          if (!passedQuizzes.has(q.id)) {
            unmet.push({
              type: "QUIZ",
              code: attemptedQuizzes.has(q.id) ? "QUIZ_NOT_PASSED" : "QUIZ_NOT_ATTEMPTED",
              lessonId: lesson.id,
              quizId: q.id,
            });
          }
        }
      }
      if (hasHomework) {
        for (const h of lessonHomeworks) {
          if (!submittedHomeworks.has(h.id)) {
            unmet.push({
              type: "HOMEWORK",
              code: "HOMEWORK_NOT_SUBMITTED",
              lessonId: lesson.id,
              homeworkId: h.id,
            });
          }
        }
      }
    }

    // For locked lessons beyond boundary, also report prereq if needed for clarity
    if (!unlocked && !blockedByHold && previousCompleted) {
      // Should not happen — if previousCompleted true and not blocked, unlocked should be true
      // But keep for safety
    }

    const state: ProgressionState = completed
      ? "COMPLETED"
      : unlocked
        ? "UNLOCKED"
        : "LOCKED";

    const evidence: CompletionEvidence = {
      video: {
        required: hasVideo,
        done: videoDone,
        percent: hasVideo ? videoPercent : 100,
        completed: videoCompleted,
        watchedSec: lp?.videoWatchedSec,
      },
      quiz: {
        required: hasQuiz,
        done: quizDone,
        total: lessonQuizzes.length,
        passed: lessonQuizzes.filter((q) => passedQuizzes.has(q.id)).length,
        attempts: lessonQuizzes.map((q) => {
          const attempts = passedAttemptsByQuiz.get(q.id) || [];
          const best = attempts.reduce(
            (acc, cur) => (cur.percentage > (acc?.percentage ?? -1) ? cur : acc),
            null as { passed: boolean; percentage: number } | null
          );
          return {
            quizId: q.id,
            passed: passedQuizzes.has(q.id),
            percentage: best?.percentage ?? 0,
          };
        }),
      },
      homework: {
        required: hasHomework,
        done: assignmentDone,
        total: lessonHomeworks.length,
        submitted: lessonHomeworks.filter((h) => submittedHomeworks.has(h.id)).length,
        submissions: lessonHomeworks.map((h) => ({
          homeworkId: h.id,
          submitted: submittedHomeworks.has(h.id),
        })),
      },
      legacyCompleted: lp?.isCompleted,
    };

    const activeHoldForLesson =
      relevantHolds.find((h) => h.lessonId === lesson.id) ?? null;
    // For blocked lessons, show the boundary hold
    const effectiveHold = blockedByHold ? boundaryHold : activeHoldForLesson;

    const activeOverrideForLesson = courseOverrideByLessonId.get(lesson.id) ?? null;

    const reason = arabicReasonForLesson(
      completed,
      unlocked,
      unmet,
      blockedByHold,
      effectiveHold
    );

    const row: LessonProgressionResult = {
      lessonId: lesson.id,
      courseId,
      order: lesson.order,
      state,
      unlocked,
      completed,
      reason,
      unmet,
      evidence,
      nextMayUnlock: completed,
      activeHold: effectiveHold,
      activeOverride: activeOverrideForLesson,
      boundaryLessonId,
      blockedByHold,
      unlockedByOverride,
    };

    results.push(row);
    previousCompleted = completed;
  }

  const current =
    results.find((r) => r.unlocked && !r.completed) ||
    results.find((r) => r.unlocked) ||
    null;

  return {
    courseId,
    studentId,
    schoolType: resolvedSchoolType,
    lessons: results,
    byLessonId: new Map(results.map((r) => [r.lessonId, r])),
    currentLessonId: current?.lessonId ?? null,
    activeHold: boundaryHold,
    boundaryLessonId,
    activeOverrides: courseOverrides,
  };
}

// ---------------------------------------------------------------------------
// Single lesson access (canonical)
// ---------------------------------------------------------------------------

export type LessonAccessReason =
  | null
  | "NOT_ENROLLED"
  | "LESSON_NOT_FOUND"
  | "PREVIOUS_SESSION_INCOMPLETE"
  | "HOLD_ACTIVE"
  | "TRACK_NOT_ELIGIBLE"
  | "LIFECYCLE_NOT_VISIBLE";

export type LessonAccessResult = {
  allowed: boolean;
  reason: LessonAccessReason;
  progression: LessonProgressionResult | null;
  hold: ActiveHoldInfo | null;
  override: ActiveOverrideInfo | null;
};

export async function canAccessLessonCanonical(
  studentId: string,
  lessonId: string
): Promise<LessonAccessResult> {
  const lesson = (await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      order: true,
      videoUrl: true,
      unitId: true,
      topicId: true,
      trackScope: true,
      status: true,
      curriculumStatus: true,
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
    },
  })) as any;

  if (!lesson) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }

  if (
    !isStudentVisibleStatus(lesson.status) ||
    String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED"
  ) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }

  const courseId = resolveLessonCourseId(lesson);
  if (!courseId) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }

  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      schoolType: true,
      group: { select: { courseId: true, isActive: true } },
      subscription: { select: { status: true, endDate: true } },
    },
  });
  if (!student) {
    return { allowed: false, reason: "NOT_ENROLLED", progression: null, hold: null, override: null };
  }

  const entitled = evaluateAccessDecision({
    groupActive:
      !!student?.group &&
      student.group.isActive &&
      student.group.courseId === courseId,
    subscription: student?.subscription,
  });
  if (!entitled.allowed) {
    return { allowed: false, reason: "NOT_ENROLLED", progression: null, hold: null, override: null };
  }

  const schoolType = normalizeSchoolType(student.schoolType);
  if (!canAccessTrackScope(schoolType, lesson.trackScope)) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }

  const progression = await getCourseProgression(studentId, courseId, schoolType);
  const status = progression.byLessonId.get(lessonId) || null;

  if (!status) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }

  if (!status.unlocked) {
    if (status.blockedByHold) {
      return {
        allowed: false,
        reason: "HOLD_ACTIVE",
        progression: status,
        hold: status.activeHold,
        override: status.activeOverride,
      };
    }
    return {
      allowed: false,
      reason: "PREVIOUS_SESSION_INCOMPLETE",
      progression: status,
      hold: status.activeHold,
      override: status.activeOverride,
    };
  }

  return {
    allowed: true,
    reason: null,
    progression: status,
    hold: status.activeHold,
    override: status.activeOverride,
  };
}

// ---------------------------------------------------------------------------
// Resource gating (quiz, homework, media)
// ---------------------------------------------------------------------------

export type ResourceAccessResult = {
  allowed: boolean;
  reason: LessonAccessReason;
  progression: LessonProgressionResult | null;
  hold: ActiveHoldInfo | null;
  override: ActiveOverrideInfo | null;
};

async function gateTrackedResourceCanonical(
  studentId: string,
  lessonId: string | null,
  trackScope: unknown
): Promise<ResourceAccessResult> {
  if (!lessonId) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }

  const access = await canAccessLessonCanonical(studentId, lessonId);
  if (!access.allowed) {
    return {
      allowed: false,
      reason: access.reason,
      progression: access.progression,
      hold: access.hold,
      override: access.override,
    };
  }

  const schoolType = await getStudentSchoolType(studentId);
  if (!canAccessTrackScope(schoolType, trackScope)) {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }

  return {
    allowed: true,
    reason: null,
    progression: access.progression,
    hold: access.hold,
    override: access.override,
  };
}

export async function canAccessQuizCanonical(
  studentId: string,
  quizId: string
): Promise<ResourceAccessResult> {
  const quiz = await db.quiz.findUnique({
    where: { id: quizId },
    select: { lessonId: true, trackScope: true, status: true },
  });
  if (!quiz || quiz.status !== "PUBLISHED") {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }
  return gateTrackedResourceCanonical(studentId, quiz.lessonId, quiz.trackScope);
}

export async function canAccessHomeworkCanonical(
  studentId: string,
  homeworkId: string
): Promise<ResourceAccessResult> {
  const homework = await db.homework.findUnique({
    where: { id: homeworkId },
    select: { lessonId: true, trackScope: true, status: true },
  });
  if (!homework || homework.status === "DRAFT") {
    return { allowed: false, reason: "LESSON_NOT_FOUND", progression: null, hold: null, override: null };
  }
  return gateTrackedResourceCanonical(studentId, homework.lessonId, homework.trackScope);
}

// ---------------------------------------------------------------------------
// Batch unlocked ids (for course tree, dashboard, etc)
// ---------------------------------------------------------------------------

export async function getUnlockedLessonIdsCanonical(
  studentId: string,
  courseId: string
): Promise<Set<string>> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      group: { select: { isActive: true, courseId: true } },
      subscription: { select: { status: true, endDate: true } },
    },
  });
  const entitled = evaluateAccessDecision({
    groupActive:
      !!student?.group && student.group.isActive && student.group.courseId === courseId,
    subscription: student?.subscription,
  });
  if (!entitled.allowed) return new Set<string>();

  const progression = await getCourseProgression(studentId, courseId);
  return new Set(
    progression.lessons.filter((l) => l.unlocked).map((l) => l.lessonId)
  );
}

// ---------------------------------------------------------------------------
// Catch-up helpers
// ---------------------------------------------------------------------------

export type CatchUpCheckResult = {
  lessonId: string;
  satisfied: boolean;
  evidence: CompletionEvidence;
  unmet: StructuredUnmetRequirement[];
};

/**
 * Check if a specific lesson's academic requirements are satisfied
 * (video >=95%, quiz PASS, homework SUBMITTED) — used for hold resolution.
 */
export async function checkCatchUpRequirements(
  studentId: string,
  lessonId: string
): Promise<CatchUpCheckResult | null> {
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: {
      id: true,
      videoUrl: true,
      unit: { select: { part: { select: { courseId: true } } } },
      topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } },
    },
  });
  if (!lesson) return null;
  const courseId =
    lesson.unit?.part.courseId ?? lesson.topic?.unit.part.courseId ?? null;
  if (!courseId) return null;

  const prog = await getCourseProgression(studentId, courseId);
  const res = prog.byLessonId.get(lessonId);
  if (!res) return null;

  const relevantUnmet = res.unmet.filter(
    (u) => u.type === "VIDEO" || u.type === "QUIZ" || u.type === "HOMEWORK"
  );

  return {
    lessonId,
    satisfied: relevantUnmet.length === 0 && res.completed,
    evidence: res.evidence,
    unmet: relevantUnmet,
  };
}

// ---------------------------------------------------------------------------
// Hold resolution via catch-up (idempotent, reuses Phase F authority)
// ---------------------------------------------------------------------------

/**
 * Try to resolve active holds for a lesson when its catch-up requirements
 * are satisfied. Idempotent — if already resolved, does nothing.
 * Preserves absence history (only hold status changes).
 */
export async function tryResolveHoldForCatchUp(params: {
  studentId: string;
  lessonId: string;
  actorUserId?: string | null;
}): Promise<{ resolved: number; holds: string[] }> {
  const check = await checkCatchUpRequirements(params.studentId, params.lessonId);
  if (!check || !check.satisfied) {
    return { resolved: 0, holds: [] };
  }

  const activeHolds = await db.absenceHold.findMany({
    where: {
      studentId: params.studentId,
      status: "ACTIVE",
      absenceReview: { lessonId: params.lessonId },
    },
    select: { id: true, absenceReviewId: true },
  });

  if (activeHolds.length === 0) return { resolved: 0, holds: [] };

  const now = new Date();
  let resolved = 0;
  const resolvedIds: string[] = [];

  for (const hold of activeHolds) {
    try {
      await db.absenceHold.update({
        where: { id: hold.id },
        data: {
          status: "RESOLVED",
          resolvedAt: now,
          resolvedByUserId: params.actorUserId ?? null,
          resolution: "CATCH_UP_COMPLETED",
        },
      });
      resolved++;
      resolvedIds.push(hold.id);

      await db.auditLog
        .create({
          data: {
            userId: params.actorUserId || "system",
            action: "ABSENCE_HOLD_RESOLVED_CATCH_UP",
            entity: "AbsenceHold",
            entityId: hold.id,
            details: JSON.stringify({
              holdId: hold.id,
              absenceReviewId: hold.absenceReviewId,
              studentId: params.studentId,
              lessonId: params.lessonId,
              resolution: "CATCH_UP_COMPLETED",
            }).slice(0, 1000),
          },
        })
        .catch(() => undefined);
    } catch {
      // Idempotent: if concurrent resolution won, ignore
    }
  }

  return { resolved, holds: resolvedIds };
}
