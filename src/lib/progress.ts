// CodeMind Academy — SHARED progress service.
//
// This is the single source of truth for video / session progress. Admin,
// Teacher, Parent and Student dashboards, plus the weekly & monthly reports,
// all read through these functions so no two screens can disagree.
//
// Performance: every function is batch-oriented (one query per table for a set
// of students) — no N+1 loops, no "fetch everything then filter in JS".

import { db } from "@/lib/db";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { canAccessTrackScope } from "@/lib/track-scope";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";

/** Minimum watched share of a video before it counts as completed. */
export const VIDEO_COMPLETION_THRESHOLD = 95;

export type VideoProgressSummary = {
  studentId: string;
  /** Lessons in the student's course that actually have a video. */
  totalVideos: number;
  /** Videos watched to >= VIDEO_COMPLETION_THRESHOLD. */
  completedVideos: number;
  /** Average watched percentage across all required videos (0-100). */
  averagePercent: number;
  /** completedVideos / totalVideos as a percentage (0-100). */
  completionPercent: number;
  totalWatchedMinutes: number;
  lastWatchedAt: Date | null;
};

function emptySummary(studentId: string): VideoProgressSummary {
  return {
    studentId,
    totalVideos: 0,
    completedVideos: 0,
    averagePercent: 0,
    completionPercent: 0,
    totalWatchedMinutes: 0,
    lastWatchedAt: null,
  };
}

/**
 * Resolve, for each student, the set of lesson ids that carry a video and
 * belong to the course the student is enrolled in (via their group),
 * restricted to the student's own TRACK (Phase 19).
 *
 * The per-course video universe is fetched once and then sliced per student
 * with the same `canAccessTrackScope` predicate the progression engine uses:
 * an ARABIC student is never measured on a LANGUAGE-only video (and vice
 * versa), so a dashboard, a report and a certificate cannot disagree about
 * the denominator. A student with an unrecognised school type fails closed
 * to SHARED-only — the same rule as every other content surface.
 */
async function videoLessonIdsByStudent(
  students: { id: string; groupId: string | null; schoolType: SchoolType | string | null }[]
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const groupIds = [...new Set(students.map((s) => s.groupId).filter(Boolean))] as string[];
  if (groupIds.length === 0) {
    for (const s of students) result.set(s.id, []);
    return result;
  }

  const groups = await db.group.findMany({
    where: { id: { in: groupIds } },
    select: { id: true, courseId: true },
  });
  const courseByGroup = new Map(groups.map((g) => [g.id, g.courseId]));
  const courseIds = [...new Set(groups.map((g) => g.courseId))];

  // One query for all courses at once. Both curriculum chains (official
  // lessons are unit-linked) with archived history excluded — the same
  // predicate as lessonCoursesChainOr + EXCLUDE_ARCHIVED_LESSON in
  // session-progress.ts, kept inline to avoid a progress ↔ session-progress
  // import cycle (that module imports VIDEO_COMPLETION_THRESHOLD from here).
  // Phase 13: `status: "PUBLISHED"` replaces the legacy `isPublished` flag as
  // the lifecycle clause (the same predicate the progression universe uses).
  // A staged (DRAFT/READY) lesson is not a video a student is measured on, so
  // counting it would inflate the denominator of every dashboard, report and
  // certificate that reads through this helper.
  const lessons = await db.lesson.findMany({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      curriculumStatus: { not: "ARCHIVED" },
      videoUrl: { not: null },
      OR: [
        { unit: { part: { courseId: { in: courseIds } } } },
        { topic: { unit: { part: { courseId: { in: courseIds } } } } },
      ],
    },
    select: {
      id: true,
      // Phase 19: carried so the per-student slice below can apply the SAME
      // track predicate as the progression universe without a second query.
      trackScope: true,
      unit: { select: { part: { select: { courseId: true } } } },
      topic: { select: { unit: { select: { part: { select: { courseId: true } } } } } },
    },
  });

  const lessonsByCourse = new Map<
    string,
    { id: string; trackScope: unknown }[]
  >();
  for (const l of lessons) {
    const cid = l.unit?.part.courseId ?? l.topic?.unit.part.courseId;
    if (!cid) continue;
    const arr = lessonsByCourse.get(cid) || [];
    arr.push({ id: l.id, trackScope: l.trackScope });
    lessonsByCourse.set(cid, arr);
  }

  for (const s of students) {
    const courseId = s.groupId ? courseByGroup.get(s.groupId as string) : null;
    const schoolType = normalizeSchoolType(s.schoolType as string | null);
    const courseLessons = courseId ? (lessonsByCourse.get(courseId as string) ?? []) : [];
    result.set(
      s.id,
      courseLessons
        .filter((l) => canAccessTrackScope(schoolType, l.trackScope))
        .map((l) => l.id)
    );
  }
  return result;
}

/**
 * Batched video-progress summary for a set of students.
 * Used by Admin, Teacher, Parent dashboards and the parent reports.
 */
export async function getVideoProgressForStudents(
  studentIds: string[]
): Promise<Map<string, VideoProgressSummary>> {
  const out = new Map<string, VideoProgressSummary>();
  if (studentIds.length === 0) return out;

  const students = await db.student.findMany({
    where: { id: { in: studentIds } },
    select: { id: true, groupId: true, schoolType: true },
  });
  for (const s of students) out.set(s.id, emptySummary(s.id));

  const lessonIdsByStudent = await videoLessonIdsByStudent(students);
  const allLessonIds = [...new Set([...lessonIdsByStudent.values()].flat())];
  if (allLessonIds.length === 0) return out;

  const progresses = await db.lessonProgress.findMany({
    where: { studentId: { in: studentIds }, lessonId: { in: allLessonIds } },
    select: {
      studentId: true,
      lessonId: true,
      videoPercent: true,
      videoCompleted: true,
      videoWatchedSec: true,
      lastHeartbeatAt: true,
    },
  });

  const byStudent = new Map<string, typeof progresses>();
  for (const p of progresses) {
    const arr = byStudent.get(p.studentId) || [];
    arr.push(p);
    byStudent.set(p.studentId, arr);
  }

  for (const s of students) {
    const required = lessonIdsByStudent.get(s.id) || [];
    const requiredSet = new Set(required);
    const rows = (byStudent.get(s.id) || []).filter((p) => requiredSet.has(p.lessonId));

    const completedVideos = rows.filter((p) => p.videoCompleted).length;
    const percentSum = rows.reduce((acc, p) => acc + p.videoPercent, 0);
    const watchedSec = rows.reduce((acc, p) => acc + p.videoWatchedSec, 0);
    const lastWatchedAt: Date | null = rows.reduce(
      (acc: Date | null, p) =>
        p.lastHeartbeatAt && (!acc || p.lastHeartbeatAt > acc) ? p.lastHeartbeatAt : acc,
      null as Date | null
    );

    out.set(s.id, {
      studentId: s.id,
      totalVideos: required.length,
      completedVideos,
      // Average is over ALL required videos (unwatched counts as 0%).
      averagePercent: required.length ? Math.round(percentSum / required.length) : 0,
      completionPercent: required.length
        ? Math.round((completedVideos / required.length) * 100)
        : 0,
      totalWatchedMinutes: Math.round(watchedSec / 60),
      lastWatchedAt,
    });
  }

  return out;
}

/** Convenience single-student wrapper around the batched function. */
export async function getVideoProgressForStudent(
  studentId: string
): Promise<VideoProgressSummary> {
  const map = await getVideoProgressForStudents([studentId]);
  return map.get(studentId) || emptySummary(studentId);
}

/**
 * Video progress restricted to a time window — used by the parent weekly and
 * monthly reports so both derive from the same table as the dashboards.
 *
 * Phase 19: the window is read against the student's OWN active video
 * universe (their course, their track, PUBLISHED, non-archived — exactly the
 * set `getVideoProgressForStudents` uses as its denominator). Without the
 * same restriction, a heartbeat left on an archived legacy lesson or on a
 * video of the other school type would count as "watched this week" here
 * while never appearing in the overall denominator — numerator and
 * denominator would describe different lesson universes.
 */
export async function getVideoProgressInRange(
  studentId: string,
  from: Date,
  to: Date
): Promise<{ videosWatched: number; videosCompleted: number; watchedMinutes: number }> {
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { id: true, groupId: true, schoolType: true },
  });
  if (!student) return { videosWatched: 0, videosCompleted: 0, watchedMinutes: 0 };
  const universe = new Set(
    (await videoLessonIdsByStudent([student])).get(studentId) || []
  );
  if (universe.size === 0) {
    return { videosWatched: 0, videosCompleted: 0, watchedMinutes: 0 };
  }
  const rows = await db.lessonProgress.findMany({
    where: {
      studentId,
      lessonId: { in: [...universe] },
      lastHeartbeatAt: { gte: from, lte: to },
    },
    select: { videoWatchedSec: true, videoCompleted: true, videoCompletedAt: true },
  });
  return {
    videosWatched: rows.length,
    videosCompleted: rows.filter(
      (r) => r.videoCompleted && r.videoCompletedAt && r.videoCompletedAt >= from && r.videoCompletedAt <= to
    ).length,
    watchedMinutes: Math.round(
      rows.reduce((acc, r) => acc + r.videoWatchedSec, 0) / 60
    ),
  };
}
