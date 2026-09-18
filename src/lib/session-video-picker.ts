// CodeMind Academy — Admin session-video LESSON PICKER selection logic
// (Phase A of the academic session workflow).
//
// PURE and client-safe: no I/O, no React, no server imports except the
// track-fit predicate. This module decides what the Admin picker SHOWS and
// how the deep-link preselect lands; the server ALWAYS re-validates the
// final (lesson, batch) pair (src/lib/session-video-link.ts) — nothing here
// can widen what the server accepts.
//
// BATCH MODEL (the system's real semantics — see session-lifecycle.ts
// readiness and the enrollment module): a Batch is a SCHOOL-TYPE audience
// pool. Readiness counts SHARED coverage per batch.schoolType and student
// visibility resolves by schoolType; the Admin batch UI creates batches
// without a course. A batch MAY still declare a course (schema allows it) —
// such a batch is scoped to that course's lessons. Therefore:
//
//   course-bound batch → picker offers that course's eligible lessons only
//   pool batch         → picker offers every course's eligible lessons
//
// "Eligible" = not ARCHIVED + track fit (lessonFitsBatch — the client mirror
// of the server's rule 6): SHARED fits both batches, ARABIC/LANGUAGE fit
// their own. DRAFT/READY/PUBLISHED lifecycle is irrelevant for ADMIN staging
// — official lessons are staging targets before they are ever published.

import { lessonFitsBatch } from "@/lib/session-video-link";

export type PickerLesson = {
  id: string;
  title: string;
  titleAr: string;
  officialCode: string | null;
  trackScope: string;
};

export type LessonGroup = {
  /** Stable React key — one group per (course, unit). */
  key: string;
  courseId: string;
  /** Display name of the owning course (Arabic-first), for pool batches. */
  courseName: string | null;
  unitOrder: number;
  lessons: PickerLesson[];
};

export type PickerBatch = {
  id: string;
  schoolType: unknown;
  /** null = school-type pool batch (the kind the Admin UI creates). */
  course: { id: string } | null | undefined;
};

/** Arabic-first display name for a course node of the admin courses tree. */
export function courseDisplayName(course: {
  nameAr?: unknown;
  name?: unknown;
}): string | null {
  const ar = typeof course.nameAr === "string" ? course.nameAr.trim() : "";
  if (ar) return ar;
  const en = typeof course.name === "string" ? course.name.trim() : "";
  return en || null;
}

/**
 * Build the picker's unit groups for ONE batch from the admin courses tree
 * (GET /api/admin/courses?tree=1 — courses → parts → units → lessons, with
 * the legacy unit → topics → lessons chain alongside).
 *
 * Scope: a course-bound batch sees ONLY its course; a pool batch sees every
 * course. Within the scope each lesson must be non-archived and track-fitting
 * (lessonFitsBatch). Dual-chained lessons (unit + topic) appear once per
 * unit. Groups come back in tree order — the caller renders the labels.
 */
export function buildLessonGroups(
  courses: unknown,
  batch: PickerBatch
): LessonGroup[] {
  const courseNodes = Array.isArray(courses) ? courses : [];
  const groups: LessonGroup[] = [];

  for (const c of courseNodes as any[]) {
    if (!c || typeof c.id !== "string") continue;
    // Course-bound batches are scoped to their own course.
    if (batch.course && batch.course.id !== c.id) continue;

    for (const part of c.parts || []) {
      for (const unit of part?.units || []) {
        const seen = new Set<string>();
        const lessons: PickerLesson[] = [];
        const push = (l: any) => {
          if (!l || typeof l.id !== "string" || seen.has(l.id)) return;
          if (l.curriculumStatus === "ARCHIVED") return;
          if (!lessonFitsBatch(l.trackScope, batch.schoolType)) return;
          seen.add(l.id);
          lessons.push({
            id: l.id,
            title: l.title,
            titleAr: l.titleAr,
            officialCode: l.officialCode ?? null,
            trackScope: l.trackScope,
          });
        };
        for (const l of unit?.lessons || []) push(l);
        for (const t of unit?.topics || []) for (const l of t?.lessons || []) push(l);
        if (lessons.length > 0) {
          groups.push({
            key: `${c.id}-${unit.id}`,
            courseId: c.id,
            courseName: courseDisplayName(c),
            unitOrder: unit.order,
            lessons,
          });
        }
      }
    }
  }
  return groups;
}

/** Every lesson id the picker can currently offer for this batch. Accepts
    any group shape that carries lessons (the pure groups and the view's
    labeled groups both qualify). */
export function flattenEligibleLessonIds(
  groups: Array<{ lessons: Array<{ id: string }> }>
): Set<string> {
  const ids = new Set<string>();
  for (const g of groups) for (const l of g.lessons) ids.add(l.id);
  return ids;
}

/**
 * Where should the deep-linked lesson land? Called by the session-videos
 * view when the admin arrives from a lesson page.
 *
 *   null                       → the lesson's track has no batch at all:
 *                                there is no legal home, do not consume.
 *   { switchTo: null }         → the ACTIVE batch already fits — keep it.
 *   { switchTo: batchId }      → switch to the lesson's track batch first.
 */
export function deepLinkTargetBatch(
  lessonTrackScope: unknown,
  batches: Array<{ id: string; schoolType: unknown }>,
  activeBatchId: string | null
): { switchTo: string | null } | null {
  if (!lessonFitsBatch(lessonTrackScope, "ARABIC") && !lessonFitsBatch(lessonTrackScope, "LANGUAGE")) {
    // Unknown/degenerate scope — nothing is a legal home.
    return null;
  }
  if (lessonTrackScope === "ARABIC" || lessonTrackScope === "LANGUAGE") {
    const target = batches.find(
      (b) => lessonFitsBatch(lessonTrackScope, b.schoolType) && b.id !== activeBatchId
    );
    // A batch of the lesson's track exists and is not active → switch.
    // (If it IS active, the find misses and we keep the active batch.)
    if (target && target.id !== activeBatchId) return { switchTo: target.id };
    const ownTrackActive = batches.some(
      (b) => b.id === activeBatchId && lessonFitsBatch(lessonTrackScope, b.schoolType)
    );
    return ownTrackActive ? { switchTo: null } : null;
  }
  // SHARED (or otherwise both-track) — the active batch always fits.
  return { switchTo: null };
}
