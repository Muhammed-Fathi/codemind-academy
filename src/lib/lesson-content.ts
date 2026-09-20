// CodeMind Academy — LESSON CONTENT SUMMARY authority (Phase C).
//
// THE CONTRACT
// ============
// The Lesson is the canonical academic session. The student curriculum has
// FOUR kinds of academic content hanging off it — videos, materials (PDFs),
// quizzes and homework — and before Phase C every student surface answered
// "does this lesson have X?" with its own private query: the course tree
// counted quiz/homework rows WITHOUT the track filter, the lesson page
// applied the filter, the dashboard exposed only the legacy videoUrl. The
// same lesson therefore looked different depending on which screen rendered
// it. This module is the ONE server-side authority every student-facing
// curriculum surface now calls.
//
//   Course → Part → Unit → Lesson (academic session)
//                             ├── SessionVideo (batch audience)  → video
//                             ├── Material (trackScope)          → material
//                             ├── Quiz      (trackScope)         → quiz
//                             └── Homework  (trackScope)         → homework
//
// WHAT IT ANSWERS (and nothing more)
// ==================================
// For a given viewer and lesson:
//   * Does this lesson contain student-visible VIDEOS?
//   * Does this lesson contain student-visible MATERIALS?
//   * Does this lesson have a QUIZ (for this viewer)?
//   * Does this lesson have HOMEWORK (for this viewer)?
// as an ABSENT / AVAILABLE(/ LOCKED) state plus a natural count. It is a
// PRESENCE + ELIGIBILITY summary, NOT a second progression engine: it never
// reads LessonProgress, never computes unlock state, never decides readiness
// and never changes what "completed" means. Progression stays exclusively in
// `src/lib/session-progress.ts`; readiness stays exclusively in
// `src/lib/session-lifecycle.ts`.
//
// STATES (no more than the application actually supports)
// =======================================================
//   ABSENT     the component does not exist for this lesson FOR THIS VIEWER
//              (no rows at all, or only rows belonging to the other
//              audience/track — cross-audience rows are never exposed or
//              counted, so they read as ABSENT-for-you, exactly like the
//              lesson page's already-filtered lists).
//   AVAILABLE  at least one student-visible, authorized instance exists.
//   LOCKED     the component exists for this viewer but an ALREADY-EXISTING
//              child-component access rule currently blocks its use. The
//              current application has no such rule that fires BELOW an
//              accessible lesson (quiz/homework gates delegate to
//              `canAccessLesson`, which this summary never bypasses; a
//              track-ineligible row is hidden, not locked — the platform's
//              documented non-oracle policy), so NO PRODUCER EMITS LOCKED
//              today. The state is defined so the UI can render it and a
//              future phase can produce it without a contract change.
//
// WHO CALLS IT
// ============
//   * GET /api/courses/[slug]        — course tree indicators (per lesson)
//   * GET /api/lessons/[id]          — lesson page workspace summary
//   * GET /api/students/me/dashboard — Continue Learning card summary
// All three pass the viewer context they already resolved; the module never
// re-derives authorization, it REUSES the established predicates:
//   `eligibleTrackScopes` / `videoTrackFilter` (track, Phase 12),
//   `buildMaterialDescriptors` (materials, Phase 14),
//   the batch + publication video rule (Phase A/B).
//
// LEGACY COMPATIBILITY (documented, retained — never migrated)
// ============================================================
//   * `Lesson.videoUrl` — when a lesson has NO student-visible modern
//     SessionVideo row, a non-empty legacy URL still counts as ONE video
//     (the exact fallback the course tree applied since Phase B). Modern
//     rows always win; a legacy URL never inflates the modern count.
//   * `Lesson.pdfUrl` — handled INSIDE `buildMaterialDescriptors` (a
//     LEGACY_URL descriptor only when no Material descriptor exists); this
//     module merely forwards the column.
//   * The legacy Topic chain is untouched: callers pass whatever lessons
//     their (already dual-chain) curriculum query returned.
//
// WHAT THIS MODULE NEVER DOES
// ===========================
//   * Never leaks identities: the summary carries states and counts only —
//     no ids, no titles, no URLs, no storage keys.
//   * Never bypasses `canAccessLesson`: callers must gate the lesson itself
//     exactly as they do today. The tree keeps its Phase 16 contract —
//     presence badges are LOCK-INDEPENDENT for PUBLISHED lessons (the
//     skeleton) while every protected field stays redacted.
//   * Never invents content: an empty lesson summarises as all-ABSENT.

import { db } from "@/lib/db";
import {
  eligibleTrackScopes,
  normalizeTrackScope,
  videoTrackFilter,
  type TrackScope,
} from "@/lib/track-scope";
import { buildMaterialDescriptors } from "@/lib/session-materials";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** ABSENT = nothing for this viewer; AVAILABLE = usable now; LOCKED = exists but gated. */
export type LessonContentState = "ABSENT" | "AVAILABLE" | "LOCKED";

export type LessonContentComponent = {
  state: LessonContentState;
  /**
   * Natural count of student-visible instances for this viewer (modern
   * SessionVideo rows; downloadable material descriptors — legacy pdfUrl
   * included as at most one; eligible quizzes; eligible homeworks). 0
   * whenever the state is not AVAILABLE. Presence is `count > 0`.
   */
  count: number;
};

export type LessonContentSummary = {
  lessonId: string;
  video: LessonContentComponent;
  material: LessonContentComponent;
  quiz: LessonContentComponent;
  homework: LessonContentComponent;
};

/**
 * The viewer whose eligibility slice the summary is computed in. Resolved by
 * the CALLER from the same server-side state its authorization already uses —
 * never from a request parameter.
 *
 *   STUDENT — one school type + one batch (the Phase A/B video audience rule).
 *             A student with no resolvable batch sees NO modern video rows
 *             (fail-closed, identical to the session-video list).
 *   PARENT  — the UNION of linked children's tracks (`getParentTrackScopes`).
 *   STAFF   — teacher/admin preview: every scope, every publication state a
 *             staff preview already sees.
 */
export type LessonContentViewer =
  | { role: "STUDENT"; schoolType: SchoolType | string | null; batchId: string | null }
  | { role: "PARENT"; scopes: readonly TrackScope[] }
  | { role: "STAFF" };

/** The static per-lesson rows a caller's curriculum query already carries. */
export type LessonContentLessonInput = {
  id: string;
  videoUrl?: string | null;
  pdfUrl?: string | null;
  quizzes?: readonly { id: string; trackScope?: unknown; status?: unknown }[] | null;
  homeworks?: readonly { id: string; trackScope?: unknown; status?: unknown }[] | null;
  /** Active Material rows WITH media metadata (the Phase 14 descriptor input). */
  materials?: Parameters<typeof buildMaterialDescriptors>[0]["materials"] | null;
};

/** Serializable summary shape for API payloads (plain strings/numbers only). */
export type LessonContentSummaryPayload = {
  video: LessonContentComponent;
  material: LessonContentComponent;
  quiz: LessonContentComponent;
  homework: LessonContentComponent;
};

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function eligibleScopesOf(viewer: LessonContentViewer): TrackScope[] | null {
  if (viewer.role === "STAFF") return null; // unrestricted (staff preview)
  if (viewer.role === "PARENT") return [...viewer.scopes];
  return eligibleTrackScopes(viewer.schoolType);
}

/** A child row (quiz/homework) is visible to this viewer only in eligible scopes. */
function rowScopeEligible(
  eligible: TrackScope[] | null,
  trackScope: unknown
): boolean {
  if (!eligible) return true; // staff: every scope
  const scope = normalizeTrackScope(trackScope);
  if (!scope) return false; // fail closed, same as the Prisma `in` filter
  return eligible.includes(scope);
}

/**
 * Phase G — a child row (quiz/homework) in DRAFT is authoring-only: it is
 * neither exposed nor COUNTED for students and parents (a badge or a
 * requirement derived from it would describe something the student can never
 * open). Staff preview keeps DRAFT rows visible. A missing/unknown status is
 * treated as visible — legacy rows predate the column and default to live.
 */
function rowLifecycleVisible(
  viewer: LessonContentViewer,
  status: unknown
): boolean {
  if (viewer.role === "STAFF") return true;
  return String(status ?? "").toUpperCase() !== "DRAFT";
}

function part(count: number): LessonContentComponent {
  return { state: count > 0 ? "AVAILABLE" : "ABSENT", count };
}

function normalizeMaterialCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

// ---------------------------------------------------------------------------
// Pure per-lesson summary (over already-loaded rows)
// ---------------------------------------------------------------------------

/**
 * Build ONE lesson's content summary from rows the caller already loaded.
 *
 * `visibleVideoCount` is the number of student-visible modern SessionVideo
 * rows for this viewer (use `countVisibleSessionVideos` /
 * `buildLessonContentSummaries` to resolve it with the exact batch +
 * publication + track rule). When the caller omits it, the modern video
 * dimension is treated as absent and the legacy `videoUrl` fallback decides
 * alone.
 */
export function buildLessonContentSummary(input: {
  lessonId: string;
  viewer: LessonContentViewer;
  legacyVideoUrl?: string | null;
  legacyPdfUrl?: string | null;
  /** Count of modern SessionVideo rows ALREADY filtered to this viewer. */
  visibleVideoCount?: number;
  quizzes?: readonly { id: string; trackScope?: unknown; status?: unknown }[] | null;
  homeworks?: readonly { id: string; trackScope?: unknown; status?: unknown }[] | null;
  materials?: LessonContentLessonInput["materials"];
}): LessonContentSummary {
  const eligible = eligibleScopesOf(input.viewer);

  // VIDEO — modern SessionVideo rows are authoritative; the legacy column is
  // a documented fallback counting as AT MOST one video when nothing modern
  // is visible (never added on top of a modern count).
  const modernCount =
    Number.isFinite(input.visibleVideoCount) && (input.visibleVideoCount ?? 0) > 0
      ? Math.floor(input.visibleVideoCount as number)
      : 0;
  const legacyVideo = typeof input.legacyVideoUrl === "string" && input.legacyVideoUrl.trim().length > 0;
  const videoCount = modernCount > 0 ? modernCount : legacyVideo ? 1 : 0;

  // MATERIAL — the Phase 14 descriptor authority, over the UNREDACTED list:
  // presence is lock-independent (the Phase 16 skeleton contract), scope and
  // downloadability are enforced by buildMaterialDescriptors itself
  // (isActive, linked asset, eligible trackScope, legacy pdfUrl fallback).
  const materialCount = normalizeMaterialCount(
    buildMaterialDescriptors({
      materials: (input.materials ?? null) as Parameters<typeof buildMaterialDescriptors>[0]["materials"],
      legacyPdfUrl: input.legacyPdfUrl ?? null,
      includeProtected: true,
      eligibleScopes: eligible,
    }).length
  );

  // QUIZ / HOMEWORK — existence in the viewer's OWN track slice. Rows of the
  // other audience are neither exposed nor counted (audience isolation), so
  // they read as ABSENT for this viewer — the same verdict the lesson page's
  // track-filtered lists reach, now from one shared implementation.
  const quizzes = Array.isArray(input.quizzes) ? input.quizzes : [];
  const homeworks = Array.isArray(input.homeworks) ? input.homeworks : [];
  const quizCount = quizzes.filter(
    (q) =>
      q?.id &&
      rowScopeEligible(eligible, q.trackScope) &&
      rowLifecycleVisible(input.viewer, q.status)
  ).length;
  const homeworkCount = homeworks.filter(
    (h) =>
      h?.id &&
      rowScopeEligible(eligible, h.trackScope) &&
      rowLifecycleVisible(input.viewer, h.status)
  ).length;

  return {
    lessonId: input.lessonId,
    video: part(videoCount),
    material: part(materialCount),
    quiz: part(quizCount),
    homework: part(homeworkCount),
  };
}

// ---------------------------------------------------------------------------
// Modern SessionVideo visibility (the Phase A/B audience rule)
// ---------------------------------------------------------------------------

/**
 * Count the PUBLISHED SessionVideo rows of `lessonIds` that THIS viewer may
 * see, keyed by lessonId.
 *
 *   STUDENT (with batch) — own batch + isPublished + track (the exact rule
 *       the lesson player and the standalone library apply; a student whose
 *       batch cannot be resolved sees nothing — fail-closed).
 *   PARENT / STAFF — any PUBLISHED row linked to the lesson (the retained
 *       tree-preview behaviour; parents preview through the tree exactly as
 *       before, badges carry no identities).
 *
 * One query regardless of lesson count.
 */
export async function countVisibleSessionVideos(input: {
  lessonIds: readonly string[];
  viewer: LessonContentViewer;
}): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (!input.lessonIds.length) return counts;

  let rows: { lessonId: string | null }[] = [];
  if (input.viewer.role === "STUDENT") {
    const schoolType = normalizeSchoolType(input.viewer.schoolType);
    if (!input.viewer.batchId || !schoolType) return counts; // fail closed
    rows = await db.sessionVideo.findMany({
      where: {
        batchId: input.viewer.batchId,
        isPublished: true,
        lessonId: { in: [...input.lessonIds] },
        // A student with an unrecognised school type gets an impossible
        // filter — presence fails closed, exactly like the video list.
        ...videoTrackFilter(schoolType),
      },
      select: { lessonId: true },
    });
  } else {
    // PARENT preview / STAFF preview: retained pre-Phase-C behaviour.
    rows = await db.sessionVideo.findMany({
      where: { isPublished: true, lessonId: { in: [...input.lessonIds] } },
      select: { lessonId: true },
    });
  }
  for (const r of rows) {
    if (!r.lessonId) continue;
    counts.set(r.lessonId, (counts.get(r.lessonId) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Batched summaries for curriculum surfaces (course tree, dashboards)
// ---------------------------------------------------------------------------

/**
 * Build content summaries for MANY lessons with a bounded number of queries:
 * the caller's rows are reused as-is; only the modern-video dimension needs
 * its own (single) query.
 *
 * Note what this deliberately does NOT take: no progress rows, no unlock
 * state, no lifecycle verdicts. Callers keep applying `canAccessLesson` /
 * the progression engine exactly as before — this module only describes
 * content presence inside the lesson rows the caller was already allowed to
 * read.
 */
export async function buildLessonContentSummaries(input: {
  lessons: readonly LessonContentLessonInput[];
  viewer: LessonContentViewer;
}): Promise<Map<string, LessonContentSummary>> {
  const lessons = (input.lessons ?? []).filter((l) => l?.id);
  const out = new Map<string, LessonContentSummary>();
  if (!lessons.length) return out;

  const videoCounts = await countVisibleSessionVideos({
    lessonIds: lessons.map((l) => l.id),
    viewer: input.viewer,
  });

  for (const lesson of lessons) {
    out.set(
      lesson.id,
      buildLessonContentSummary({
        lessonId: lesson.id,
        viewer: input.viewer,
        legacyVideoUrl: lesson.videoUrl ?? null,
        legacyPdfUrl: lesson.pdfUrl ?? null,
        visibleVideoCount: videoCounts.get(lesson.id) ?? 0,
        quizzes: lesson.quizzes ?? [],
        homeworks: lesson.homeworks ?? [],
        materials: lesson.materials ?? [],
      })
    );
  }
  return out;
}

// ---------------------------------------------------------------------------
// Payload serialization
// ---------------------------------------------------------------------------

/** Plain-object shape for API responses (states + counts, nothing else). */
export function toLessonContentPayload(
  summary: LessonContentSummary | null | undefined
): LessonContentSummaryPayload | null {
  if (!summary) return null;
  return {
    video: { state: summary.video.state, count: summary.video.count },
    material: { state: summary.material.state, count: summary.material.count },
    quiz: { state: summary.quiz.state, count: summary.quiz.count },
    homework: { state: summary.homework.state, count: summary.homework.count },
  };
}

/**
 * Convenience predicate for surfaces that think in booleans (the tree badges).
 * LOCKED is intentionally NOT "has" — only AVAILABLE means usable now.
 */
export function hasContentPart(
  summary: LessonContentSummary | null | undefined,
  partKey: "video" | "material" | "quiz" | "homework"
): boolean {
  return summary?.[partKey]?.state === "AVAILABLE";
}
