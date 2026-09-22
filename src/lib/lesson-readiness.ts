// CodeMind Academy — teacher lesson-readiness model (batched, request-time).
//
// Answers "which of MY students are ready to progress past THIS lesson, and
// what exactly is each of them missing" — computed ON DEMAND from the SAME
// canonical engine every student surface reads (`evaluateProgressionCore`),
// so the teacher view can never contradict the student's requirements card.
//
// SCOPE — a teacher sees ONLY lessons of courses they teach (their groups'
// courses) and ONLY students of their own groups in that course. Anything
// else is NOT_YOUR_LESSON (the route maps it to 404, same as the existing
// teacher-notes scope rule, so the refusal confirms nothing).
//
// COST — a FIXED ~12 batched queries regardless of student count: the lesson
// (+ its quizzes/homeworks), the lesson's candidate videos, and one IN-query
// per fact table (legacy progress, passed attempts, submissions, holds,
// overrides, watch percents) plus the shared applicability triple-query.
// Per-student evaluation runs the PURE core in JS (single-lesson universe:
// readiness is about THIS lesson's own requirements, not chain position).
// No N+1, no cron, no cache — every read is live (well within any 24h
// freshness bound by construction).
//
// REDACTION — rows carry requirement STATES ( percents, pass/submit flags,
// absence verdicts), never lesson CONTENT (no video bytes/urls, no quiz
// questions, no homework attachments). A teacher already entitled to the
// lesson sees nothing here they could not open themselves.

import {
  LESSON_CHAIN_SELECT,
  evaluateProgressionCore,
  isOverrideRowActive,
  resolveLessonCourseId,
  type LessonChain,
  type ProgressionCoreFacts,
  type ProgressionCoreLesson,
} from "@/lib/progression";
import { VIDEO_COMPLETION_THRESHOLD } from "@/lib/progress";
import { canAccessTrackScope } from "@/lib/track-scope";
import { normalizeSchoolType } from "@/lib/school-type";
import { isManagedPrivateStorage } from "@/lib/media";
import {
  effectiveRequirementMode,
  loadVideoApplicabilityMany,
  type ApplicabilityDb,
  type ApplicabilityReason,
  type RequirementMode,
} from "@/lib/video-applicability";

export type ReadinessVideoItem = {
  id: string;
  title: string;
  titleAr: string;
  requiredPercent: number;
  trackable: boolean;
  currentPercent: number;
  completed: boolean;
  requirementMode: RequirementMode;
  applicability: ApplicabilityReason;
  /** Phase F absence state behind an ABSENT_STUDENTS verdict (else nulls). */
  attendanceStatus: string | null;
  reviewStatus: string | null;
  finalized: boolean;
};

export type ReadinessStudentRow = {
  studentId: string;
  studentName: string;
  groupName: string | null;
  /** Nothing left to do (requirements met, waived by override, or vacuous). */
  ready: boolean;
  /** An ACTIVE override waives this lesson's requirements for the student. */
  overridden: boolean;
  video: {
    required: boolean;
    done: boolean;
    value: number;
    requiredCount: number;
    completedCount: number;
    items: ReadinessVideoItem[];
    exempt: ReadinessVideoItem[];
  };
  quiz: { required: boolean; done: boolean; pending: { id: string; title: string; titleAr: string }[] };
  homework: { required: boolean; done: boolean; pending: { id: string; title: string; titleAr: string }[] };
};

export type LessonReadinessResult =
  | {
      ok: true;
      lesson: { id: string; title: string; titleAr: string; courseId: string };
      students: ReadinessStudentRow[];
    }
  | { ok: false; code: "LESSON_NOT_FOUND" | "NOT_YOUR_LESSON" };

export type ReadinessTeacherGroup = {
  id: string;
  courseId: string | null;
  name: string;
  students: {
    id: string;
    schoolType: unknown;
    batchId: string | null;
    user: { name: string | null } | null;
  }[];
};

/**
 * Minimal db surface the readiness loader needs: the shared absence-facts
 * triple (reused from `ApplicabilityDb` — the loader delegates to
 * `loadVideoApplicabilityMany`, so this contract extends it) plus the eight
 * fact-table reads.
 *
 * Argument shapes are NARROW on purpose: each mirrors exactly the query the
 * loader issues (a valid Prisma args subset — same where-keys, same
 * select-keys, literal `"ACTIVE"` for the enum filter). A broad
 * `(args: unknown)` parameter is a REAL typing bug: the generated delegates
 * are generic and parameter-constrained, and under contravariance a method
 * that accepts only Prisma args is NOT assignable to an interface claiming
 * arbitrary `unknown` — the real PrismaClient was rejected at every call
 * site. Narrow args keep the real client (and transaction clients, whose
 * delegates share the same signatures) assignable with zero casts.
 */
export type LessonReadinessDb = ApplicabilityDb & {
  lesson: {
    findUnique(args: {
      where: { id: string };
      select: {
        id: boolean;
        order: boolean;
        videoUrl: boolean;
        unitId: boolean;
        topicId: boolean;
        unit: {
          select: {
            id: boolean;
            order: boolean;
            part: { select: { id: boolean; order: boolean; courseId: boolean } };
          };
        };
        topic: {
          select: {
            order: boolean;
            unit: {
              select: {
                id: boolean;
                order: boolean;
                part: { select: { id: boolean; order: boolean; courseId: boolean } };
              };
            };
          };
        };
        title: boolean;
        titleAr: boolean;
        quizzes: {
          where: { status: string };
          select: { id: boolean; title: boolean; titleAr: boolean; trackScope: boolean };
        };
        homeworks: {
          where: { status: { in: string[] } };
          select: { id: boolean; title: boolean; titleAr: boolean; trackScope: boolean };
        };
      };
    }): Promise<unknown>;
  };
  sessionVideo: {
    findMany(args: {
      where: {
        lessonId: string;
        batchId: { in: string[] };
        isPublished: boolean;
        isRequiredForProgression: boolean;
      };
      select: {
        id: boolean;
        batchId: boolean;
        title: boolean;
        titleAr: boolean;
        requiredPercent: boolean;
        requirementMode: boolean;
        isRequiredForProgression: boolean;
        liveSessionId: boolean;
        media: { select: { storage: boolean } };
        batch: { select: { schoolType: boolean } };
      };
    }): Promise<Array<Record<string, unknown>>>;
  };
  lessonProgress: {
    findMany(args: {
      where: { studentId: { in: string[] }; lessonId: string };
      select: { studentId: boolean; videoPercent: boolean; videoCompleted: boolean; videoCompletedAt: boolean };
    }): Promise<Array<Record<string, unknown>>>;
  };
  quizAttempt: {
    findMany(args: {
      where: { studentId: { in: string[] }; quizId: { in: string[] }; finishedAt: { not: null }; passed: boolean };
      select: { studentId: boolean; id: boolean; quizId: boolean; percentage: boolean; finishedAt: boolean };
    }): Promise<Array<Record<string, unknown>>>;
  };
  homeworkSubmission: {
    findMany(args: {
      where: { studentId: { in: string[] }; homeworkId: { in: string[] }; submittedAt: { not: null } };
      select: { studentId: boolean; homeworkId: boolean; submittedAt: boolean; status: boolean };
    }): Promise<Array<Record<string, unknown>>>;
  };
  absenceHold: {
    findMany(args: {
      where: { studentId: { in: string[] }; status: "ACTIVE" };
      select: {
        studentId: boolean;
        id: boolean;
        absenceReviewId: boolean;
        sessionId: boolean;
        absenceReview: { select: { lessonId: boolean } };
      };
    }): Promise<Array<Record<string, unknown>>>;
  };
  progressionOverride: {
    findMany(args: {
      where: { studentId: { in: string[] } };
      select: {
        studentId: boolean;
        id: boolean;
        lessonId: boolean;
        reason: boolean;
        createdAt: boolean;
        expiresAt: boolean;
        revokedAt: boolean;
      };
    }): Promise<Array<Record<string, unknown>>>;
  };
  sessionVideoView: {
    findMany(args: {
      where: { studentId: { in: string[] }; sessionVideoId: { in: string[] } };
      select: { studentId: boolean; sessionVideoId: boolean; percent: boolean };
    }): Promise<Array<Record<string, unknown>>>;
  };
};

export async function loadLessonReadiness(
  client: LessonReadinessDb,
  teacherGroups: readonly ReadinessTeacherGroup[],
  lessonId: string,
  now: Date = new Date()
): Promise<LessonReadinessResult> {
  const lesson = (await client.lesson.findUnique({
    where: { id: lessonId },
    select: {
      ...LESSON_CHAIN_SELECT,
      title: true,
      titleAr: true,
      videoUrl: true,
      quizzes: {
        where: { status: "PUBLISHED" },
        select: { id: true, title: true, titleAr: true, trackScope: true },
      },
      homeworks: {
        where: { status: { in: ["PUBLISHED", "CLOSED"] } },
        select: { id: true, title: true, titleAr: true, trackScope: true },
      },
    },
  })) as
    | (LessonChain & {
        title: string;
        titleAr: string;
        videoUrl: string | null;
        quizzes: { id: string; title: string; titleAr: string; trackScope: unknown }[];
        homeworks: { id: string; title: string; titleAr: string; trackScope: unknown }[];
      })
    | null;
  if (!lesson) return { ok: false, code: "LESSON_NOT_FOUND" };

  const courseId = resolveLessonCourseId(lesson);
  const groups = teacherGroups.filter((g) => g.courseId !== null && g.courseId === courseId);
  if (!courseId || groups.length === 0) return { ok: false, code: "NOT_YOUR_LESSON" };

  // Students of MY groups in THIS course (deduped — a student sits in one
  // group, but never trust multiplicity for correctness).
  const seen = new Set<string>();
  const students: { id: string; name: string; groupName: string; schoolType: string | null; batchId: string | null }[] = [];
  for (const g of groups) {
    for (const s of g.students ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      students.push({
        id: s.id,
        name: s.user?.name ?? "—",
        groupName: g.name,
        schoolType: normalizeSchoolType(s.schoolType) as string | null,
        batchId: s.batchId ?? null,
      });
    }
  }
  const studentIds = students.map((s) => s.id);
  const batchIds = [...new Set(students.map((s) => s.batchId).filter((b): b is string => !!b))];
  const quizIds = lesson.quizzes.map((q) => q.id);
  const homeworkIds = lesson.homeworks.map((h) => h.id);

  // Candidate videos: published + mode-gated + own-batch (batch-enumerated
  // across the roster, then sliced per student in JS below). The where-keys
  // on the dual-written legacy flag (⟺ mode ≠ OPTIONAL), exactly like the
  // canonical loader, so selection cannot drift from enforcement.
  const videoRows =
    batchIds.length > 0
      ? await client.sessionVideo.findMany({
          where: {
            lessonId,
            batchId: { in: batchIds },
            isPublished: true,
            isRequiredForProgression: true,
          },
          select: {
            id: true,
            batchId: true,
            title: true,
            titleAr: true,
            requiredPercent: true,
            requirementMode: true,
            isRequiredForProgression: true,
            liveSessionId: true,
            media: { select: { storage: true } },
            batch: { select: { schoolType: true } },
          },
        })
      : [];
  const videoIds = [...new Set(videoRows.map((v) => String(v.id)))];
  // The mode rides along: the applicability authority re-derives it from
  // each ref, and a mode-less ref would resolve to OPTIONAL (every ABSENT
  // video silently exempting everyone).
  const absentCandidates = videoRows
    .filter((v) => effectiveRequirementMode(v) === "ABSENT_STUDENTS" && v.liveSessionId)
    .map((v) => ({
      id: String(v.id),
      requirementMode: effectiveRequirementMode(v),
      liveSessionId: String(v.liveSessionId),
    }));

  const [
    progressRows,
    attemptRows,
    submissionRows,
    holdRows,
    overrideRows,
    viewRows,
    applicability,
  ] = await Promise.all([
    studentIds.length > 0
      ? client.lessonProgress.findMany({
          where: { studentId: { in: studentIds }, lessonId },
          select: { studentId: true, videoPercent: true, videoCompleted: true, videoCompletedAt: true },
        })
      : Promise.resolve([]),
    studentIds.length > 0 && quizIds.length > 0
      ? client.quizAttempt.findMany({
          where: { studentId: { in: studentIds }, quizId: { in: quizIds }, finishedAt: { not: null }, passed: true },
          select: { studentId: true, id: true, quizId: true, percentage: true, finishedAt: true },
        })
      : Promise.resolve([]),
    studentIds.length > 0 && homeworkIds.length > 0
      ? client.homeworkSubmission.findMany({
          where: { studentId: { in: studentIds }, homeworkId: { in: homeworkIds }, submittedAt: { not: null } },
          select: { studentId: true, homeworkId: true, submittedAt: true, status: true },
        })
      : Promise.resolve([]),
    studentIds.length > 0
      ? client.absenceHold.findMany({
          where: { studentId: { in: studentIds }, status: "ACTIVE" },
          select: { studentId: true, id: true, absenceReviewId: true, sessionId: true, absenceReview: { select: { lessonId: true } } },
        })
      : Promise.resolve([]),
    studentIds.length > 0
      ? client.progressionOverride.findMany({
          where: { studentId: { in: studentIds } },
          select: { studentId: true, id: true, lessonId: true, reason: true, createdAt: true, expiresAt: true, revokedAt: true },
        })
      : Promise.resolve([]),
    studentIds.length > 0 && videoIds.length > 0
      ? client.sessionVideoView.findMany({
          where: { studentId: { in: studentIds }, sessionVideoId: { in: videoIds } },
          select: { studentId: true, sessionVideoId: true, percent: true },
        })
      : Promise.resolve([]),
    absentCandidates.length > 0 && studentIds.length > 0
      ? loadVideoApplicabilityMany(client, studentIds, absentCandidates)
      : Promise.resolve(new Map()),
  ]);

  // Index every fact table by student (single pass each).
  const legacyByStudent = new Map<string, { percent: number; completed: boolean; completedAt: string | null }>();
  for (const p of progressRows) {
    legacyByStudent.set(String(p.studentId), {
      percent: (p.videoPercent as number | null) ?? 0,
      completed: !!p.videoCompleted,
      completedAt: p.videoCompletedAt ? new Date(p.videoCompletedAt as Date).toISOString() : null,
    });
  }
  const passedByStudent = new Map<string, Set<string>>();
  for (const a of attemptRows) {
    const key = String(a.studentId);
    if (!passedByStudent.has(key)) passedByStudent.set(key, new Set());
    passedByStudent.get(key)!.add(String(a.quizId));
  }
  const submittedByStudent = new Map<string, Set<string>>();
  for (const s of submissionRows) {
    const key = String(s.studentId);
    if (!submittedByStudent.has(key)) submittedByStudent.set(key, new Set());
    submittedByStudent.get(key)!.add(String(s.homeworkId));
  }
  const holdsByStudent = new Map<string, { holdId: string; reviewId: string; sessionId: string; lessonId: string | null }[]>();
  for (const h of holdRows) {
    const key = String(h.studentId);
    const list = holdsByStudent.get(key) ?? [];
    list.push({
      holdId: String(h.id),
      reviewId: String(h.absenceReviewId),
      sessionId: String(h.sessionId),
      lessonId: ((h.absenceReview as { lessonId: string | null } | null)?.lessonId ?? null) as string | null,
    });
    holdsByStudent.set(key, list);
  }
  const overridesByStudent = new Map<string, { overrideId: string; lessonId: string; reason: string; grantedAt: string; expiresAt: string | null }[]>();
  for (const o of overrideRows) {
    if (
      !isOverrideRowActive(
        {
          revokedAt: (o.revokedAt as Date | null) ?? null,
          expiresAt: (o.expiresAt as Date | null) ?? null,
        },
        now
      )
    )
      continue;
    const key = String(o.studentId);
    const list = overridesByStudent.get(key) ?? [];
    list.push({
      overrideId: String(o.id),
      lessonId: String(o.lessonId),
      reason: String((o.reason as string | null) ?? ""),
      grantedAt: new Date(o.createdAt as Date).toISOString(),
      expiresAt: o.expiresAt ? new Date(o.expiresAt as Date).toISOString() : null,
    });
    overridesByStudent.set(key, list);
  }
  const watchByStudentVideo = new Map<string, number>();
  for (const w of viewRows) {
    watchByStudentVideo.set(`${String(w.studentId)} ${String(w.sessionVideoId)}`, (w.percent as number | null) ?? 0);
  }

  const quizTitleById = new Map(lesson.quizzes.map((q) => [q.id, { id: q.id, title: q.title, titleAr: q.titleAr }]));
  const homeworkTitleById = new Map(lesson.homeworks.map((h) => [h.id, { id: h.id, title: h.title, titleAr: h.titleAr }]));

  const rows: ReadinessStudentRow[] = students.map((s) => {
    // Per-student slices through the SAME predicates the canonical loader
    // applies: batch audience + batch schoolType for videos, track scope
    // for quizzes/homeworks.
    const myVideos = videoRows.filter(
      (v) =>
        String(v.batchId) === s.batchId &&
        (s.schoolType === null ||
          String((v.batch as { schoolType: unknown } | null)?.schoolType ?? "") === "" ||
          normalizeSchoolType((v.batch as { schoolType: unknown } | null)?.schoolType) === s.schoolType)
    );
    const myVerdicts = applicability.get(s.id) ?? new Map();
    const requiredVideos: ProgressionCoreLesson["requiredVideos"] = [];
    const exemptItems: ReadinessVideoItem[] = [];
    const videoMeta = new Map<string, { requirementMode: RequirementMode; applicability: ApplicabilityReason; attendanceStatus: string | null; reviewStatus: string | null; finalized: boolean }>();
    const watchFor = (videoId: string) => watchByStudentVideo.get(`${s.id} ${videoId}`) ?? 0;
    for (const v of myVideos) {
      const mode = effectiveRequirementMode(v);
      if (mode === "OPTIONAL") continue;
      const trackable = isManagedPrivateStorage((v.media as { storage: unknown } | null)?.storage);
      const base = {
        id: String(v.id),
        title: String(v.title),
        titleAr: String(v.titleAr),
        requiredPercent: (v.requiredPercent as number | null) ?? VIDEO_COMPLETION_THRESHOLD,
        trackable,
      };
      if (mode === "ALL_STUDENTS") {
        requiredVideos.push(base);
        videoMeta.set(base.id, {
          requirementMode: mode,
          applicability: "ALL_STUDENTS",
          attendanceStatus: null,
          reviewStatus: null,
          finalized: false,
        });
      } else {
        const verdict = myVerdicts.get(base.id) ?? { applicable: false as const, reason: "NO_SESSION_LINK" as const };
        const meta = {
          requirementMode: mode,
          applicability: verdict.reason,
          attendanceStatus: verdict.detail?.attendanceStatus ?? null,
          reviewStatus: verdict.detail?.reviewStatus ?? null,
          finalized: verdict.detail?.finalized ?? false,
        };
        if (verdict.applicable) {
          requiredVideos.push(base);
          videoMeta.set(base.id, meta);
        } else {
          const pct = watchFor(base.id);
          exemptItems.push({
            ...base,
            currentPercent: pct,
            completed: false,
            ...meta,
          });
        }
      }
    }
    requiredVideos.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    exemptItems.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const myQuizIds = lesson.quizzes
      .filter((q) => canAccessTrackScope(s.schoolType, q.trackScope))
      .map((q) => q.id);
    const myHomeworkIds = lesson.homeworks
      .filter((h) => canAccessTrackScope(s.schoolType, h.trackScope))
      .map((h) => h.id);

    const legacy = legacyByStudent.get(s.id);
    const facts: ProgressionCoreFacts = {
      legacyVideoByLesson: new Map(
        legacy ? [[lesson.id, { percent: legacy.percent, completed: legacy.completed, completedAt: legacy.completedAt }]] : []
      ),
      passedQuizIds: passedByStudent.get(s.id) ?? new Set(),
      passedAttemptByQuiz: new Map(),
      submittedHomeworkIds: submittedByStudent.get(s.id) ?? new Set(),
      submissionByHomework: new Map(),
      videoWatchPercent: new Map(
        [...requiredVideos, ...exemptItems].map((v) => [v.id, watchFor(v.id)] as const)
      ),
    };
    const coreLesson: ProgressionCoreLesson = {
      id: lesson.id,
      order: 0,
      hasLegacyVideo: !!lesson.videoUrl,
      requiredVideos,
      quizIds: myQuizIds,
      homeworkIds: myHomeworkIds,
    };
    const studentOverrides = (overridesByStudent.get(s.id) ?? []).filter((o) => o.lessonId === lesson.id);
    const evaluated = evaluateProgressionCore({
      lessons: [coreLesson],
      facts,
      holds: holdsByStudent.get(s.id) ?? [],
      overrides: studentOverrides,
    }).lessons[0];

    const hasAnyRequirement =
      evaluated.video.required || evaluated.quiz.required || evaluated.assignment.required;
    const overridden = studentOverrides.length > 0;
    const ready = overridden || evaluated.completed || !hasAnyRequirement;

    const items: ReadinessVideoItem[] = (evaluated.video.items ?? []).map((it) => {
      const meta = videoMeta.get(it.id) ?? {
        requirementMode: "ALL_STUDENTS" as const,
        applicability: "ALL_STUDENTS" as const,
        attendanceStatus: null,
        reviewStatus: null,
        finalized: false,
      };
      return {
        id: it.id,
        title: it.title,
        titleAr: it.titleAr,
        requiredPercent: it.requiredPercent,
        trackable: it.trackable,
        currentPercent: it.currentPercent,
        completed: it.completed,
        ...meta,
      };
    });
    const passed = passedByStudent.get(s.id) ?? new Set();
    const submitted = submittedByStudent.get(s.id) ?? new Set();

    return {
      studentId: s.id,
      studentName: s.name,
      groupName: s.groupName,
      ready,
      overridden,
      video: {
        required: evaluated.video.required,
        done: evaluated.video.done,
        value: evaluated.video.value,
        requiredCount: evaluated.video.requiredCount ?? items.length,
        completedCount: evaluated.video.completedCount ?? items.filter((i) => i.completed).length,
        items,
        exempt: exemptItems,
      },
      quiz: {
        required: evaluated.quiz.required,
        done: evaluated.quiz.done,
        pending: myQuizIds.filter((id) => !passed.has(id)).map((id) => quizTitleById.get(id)!).filter(Boolean),
      },
      homework: {
        required: evaluated.assignment.required,
        done: evaluated.assignment.done,
        pending: myHomeworkIds.filter((id) => !submitted.has(id)).map((id) => homeworkTitleById.get(id)!).filter(Boolean),
      },
    };
  });

  // Deterministic roster order (group, then name) regardless of storage order.
  rows.sort((a, b) => {
    const ga = a.groupName ?? "";
    const gb = b.groupName ?? "";
    if (ga !== gb) return ga < gb ? -1 : 1;
    return a.studentName < b.studentName ? -1 : 1;
  });

  return {
    ok: true,
    lesson: { id: lesson.id, title: lesson.title, titleAr: lesson.titleAr, courseId },
    students: rows,
  };
}
