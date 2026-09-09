// CodeMind Academy — Session lifecycle & readiness (Phase 13).
//
// The fundamental invariant is PUBLISH ≠ UNLOCK:
//   Administrative lifecycle (DRAFT → READY → PUBLISHED)
//   Student progression       (LOCKED → UNLOCKED → COMPLETED)
// are independent dimensions. A lesson can be PUBLISHED+LOCKED or
// PUBLISHED+UNLOCKED, but never DRAFT/READY + student-visible.
//
// See docs/PHASE_13_SESSION_LIFECYCLE.md.

import { normalizeTrackScope, type TrackScope } from "@/lib/track-scope";

// ---------------------------------------------------------------------------
// LessonStatus
// ---------------------------------------------------------------------------

export const LESSON_STATUSES = ["DRAFT", "READY", "PUBLISHED"] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];

export function normalizeLessonStatus(value: unknown): LessonStatus | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  if ((LESSON_STATUSES as readonly string[]).includes(v)) return v as LessonStatus;
  return null;
}

export function isLessonStatus(value: unknown): value is LessonStatus {
  return normalizeLessonStatus(value) !== null;
}

export function isLessonPublished(status: unknown): boolean {
  return normalizeLessonStatus(status) === "PUBLISHED";
}

// ---------------------------------------------------------------------------
// Helpers: video / pdf presence
// ---------------------------------------------------------------------------

function isMeaningfulUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const t = value.trim();
  if (!t) return false;
  if (t === "#") return false;
  return true;
}

// ---------------------------------------------------------------------------
// Track-aware applicability
// ---------------------------------------------------------------------------
// A resource (quiz/homework) is APPLICABLE to a lesson when its trackScope is
// eligible for the lesson's own trackScope. This mirrors the student-side
// eligibility but from the lesson's perspective:
//
//   Lesson ARABIC    → quizzes SHARED or ARABIC are applicable
//   Lesson LANGUAGE  → quizzes SHARED or LANGUAGE are applicable
//   Lesson SHARED    → only SHARED quizzes are applicable (strict)
//
// Rationale: a SHARED lesson with an ARABIC quiz and a LANGUAGE quiz but no
// SHARED quiz would be considered incomplete for at least one track if we
// counted cross-track variants as satisfying SHARED. The strict rule keeps
// readiness deterministic and forces the admin to author SHARED content on
// SHARED lessons. Track-specific lessons correctly inherit SHARED resources
// because SHARED content is visible to both tracks (same as student eligibility).
// Documented in docs/PHASE_13_SESSION_LIFECYCLE.md § Track-Aware Readiness.

export function isTrackApplicableForLesson(
  lessonScope: unknown,
  resourceScope: unknown
): boolean {
  const lesson = normalizeTrackScope(lessonScope);
  const resource = normalizeTrackScope(resourceScope);
  if (!lesson || !resource) return false;
  if (lesson === "SHARED") return resource === "SHARED";
  // ARABIC or LANGUAGE: eligible = SHARED + own track
  return resource === "SHARED" || resource === lesson;
}

export function filterApplicableResources<T extends { trackScope?: unknown }>(
  lessonScope: unknown,
  resources: T[]
): T[] {
  return resources.filter((r) => isTrackApplicableForLesson(lessonScope, r.trackScope));
}

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export type ReadinessCheck = {
  /** Whether this dimension is required for READY. */
  required: boolean;
  /** Whether a resource of this kind is present at all (track-applicable). */
  present: boolean;
  /** Whether the present resource(s) are valid (e.g. non-empty). */
  valid: boolean;
  /** Human-readable detail for admin UI / tests. */
  detail: string;
  /** Count of applicable resources (for debugging). */
  count: number;
};

export type LessonReadiness = {
  lessonId: string | null;
  status: LessonStatus | null;
  curriculumStatus: string | null;
  trackScope: TrackScope | null;
  isReady: boolean;
  canPublish: boolean;
  checks: {
    video: ReadinessCheck;
    pdf: ReadinessCheck;
    quiz: ReadinessCheck;
    homework: ReadinessCheck;
  };
  errors: string[];
  warnings: string[];
};

// Input shape — plain, DB-free so the helper stays pure.
export type ReadinessInput = {
  id?: string | null;
  status?: unknown;
  curriculumStatus?: unknown;
  trackScope?: unknown;
  videoUrl?: unknown;
  pdfUrl?: unknown;
  // Relations — arrays may be missing (treated as empty) to keep the helper
  // reusable by a lightweight SELECT that doesn't join everything.
  quizzes?: Array<{ trackScope?: unknown; questions?: unknown } | null> | null;
  homeworks?: Array<{ trackScope?: unknown; deadline?: unknown } | null> | null;
  sessionVideos?: Array<unknown> | null;
  // Materials for future PDF handling (Phase 14) — not used yet, but input is
  // accepted so Phase 14 can extend the helper without changing its signature.
  materials?: Array<unknown> | null;
  // For tests: allow explicit lessonId alias
  lessonId?: string | null;
};

// Whether a homework row is considered valid. Currently: it exists and has a
// deadline. Empty homework (no deadline) would be invalid.
function isValidHomework(hw: any | null): boolean {
  if (!hw) return false;
  // deadline should be a Date or parseable string
  if (!hw.deadline) return false;
  if (hw.deadline instanceof Date) return !isNaN(hw.deadline.getTime());
  if (typeof hw.deadline === "string") return !!hw.deadline.trim();
  return true;
}

function isValidQuiz(q: any | null): boolean {
  if (!q) return false;
  if (!Array.isArray(q.questions)) return false;
  // An empty quiz (zero questions) is INVALID — it would deadlock the session
  // if the quiz gate requires "every quiz of the lesson attempted".
  return q.questions.length > 0;
}

export function getLessonReadiness(input: ReadinessInput): LessonReadiness {
  const lessonId = (input.id ?? input.lessonId ?? null) as string | null;
  const status = normalizeLessonStatus(input.status);
  const curriculumStatus =
    typeof input.curriculumStatus === "string" ? input.curriculumStatus : null;
  const trackScope = normalizeTrackScope(input.trackScope as string) ?? null;

  const errors: string[] = [];
  const warnings: string[] = [];

  const isArchived = curriculumStatus === "ARCHIVED";

  // ---- VIDEO ----
  // Phase 13 contract: VIDEO is REQUIRED. Valid when either legacy videoUrl is
  // meaningful OR a SessionVideo is linked (any — published or not). Legacy
  // videoUrl counts (including external URLs); "#" and empty are not counted.
  // Unpublished SessionVideo counts as PREPARED (the video asset exists, even
  // if the batch publish is pending).
  // Track-awareness: videoUrl is inherently shared; SessionVideo count is
  // treated as present irrespective of batch track for Phase 13 minimality —
  // a future session-video cutover can make this track-specific without changing
  // the readiness shape.
  const videoUrlPresent = isMeaningfulUrl(input.videoUrl);
  const sessionVideoCount = Array.isArray(input.sessionVideos)
    ? input.sessionVideos.filter((v) => v != null).length
    : 0;
  const videoPresent = videoUrlPresent || sessionVideoCount > 0;
  const videoValid = videoPresent; // no deeper validation (duration etc.) in Phase 13
  const videoCheck: ReadinessCheck = {
    required: true,
    present: videoPresent,
    valid: videoValid,
    detail: videoPresent
      ? videoUrlPresent
        ? `videoUrl present`
        : `${sessionVideoCount} sessionVideo(s) linked`
      : "no videoUrl and no sessionVideo",
    count: videoPresent ? 1 : 0,
  };
  if (!videoPresent) errors.push("VIDEO_MISSING");

  // ---- PDF ----
  // Phase 13 MUST NOT implement PDF upload. Therefore the readiness engine
  // handles the absence of a PDF safely and explicitly: PDF is NOT required.
  // Legacy pdfUrl (“#”, empty) is ignored. Materials are accepted in the input
  // but do not affect isReady in Phase 13; Phase 14 will make DOCUMENT
  // materials required and pdfUrl the legacy fallback.
  const pdfPresent = isMeaningfulUrl(input.pdfUrl);
  // Materials not evaluated yet — keep pdf as optional.
  const pdfCheck: ReadinessCheck = {
    required: false,
    present: pdfPresent,
    valid: pdfPresent, // if present, valid
    detail: pdfPresent ? "pdfUrl present (legacy)" : "no pdf (optional until Phase 14)",
    count: pdfPresent ? 1 : 0,
  };
  // No error if missing — explicitly optional.

  // ---- QUIZ ----
  // REQUIRED. Present when at least one applicable (track-matching) quiz exists
  // and that quiz has at least one question. An empty quiz is INVALID and does
  // not satisfy the requirement. Track-aware: only quizzes whose trackScope is
  // applicable to the lesson's trackScope count (see isTrackApplicableForLesson).
  const rawQuizzes: any[] = Array.isArray(input.quizzes)
    ? (input.quizzes.filter((q) => q != null) as any[])
    : [];
  const applicableQuizzes = filterApplicableResources(input.trackScope, rawQuizzes);
  const validQuizzes = applicableQuizzes.filter(isValidQuiz);
  const quizPresent = applicableQuizzes.length > 0;
  const quizValid = validQuizzes.length > 0 && validQuizzes.length === applicableQuizzes.length;
  // If any applicable quiz is empty, the whole dimension is invalid.
  const quizHasEmpty = applicableQuizzes.some((q) => !isValidQuiz(q));
  const quizCheck: ReadinessCheck = {
    required: true,
    present: quizPresent,
    valid: !quizHasEmpty && validQuizzes.length > 0,
    detail: !quizPresent
      ? "no applicable quiz"
      : quizHasEmpty
        ? `has empty quiz (applicable=${applicableQuizzes.length}, valid=${validQuizzes.length})`
        : `${validQuizzes.length} valid quiz(zes)`,
    count: applicableQuizzes.length,
  };
  if (!quizPresent) errors.push("QUIZ_MISSING");
  else if (quizHasEmpty) errors.push("QUIZ_EMPTY");

  // ---- HOMEWORK ----
  // REQUIRED. Present when at least one applicable homework exists with a
  // deadline. Missing applicable homework blocks READY. Track-aware same as quiz.
  const rawHomeworks: any[] = Array.isArray(input.homeworks)
    ? (input.homeworks.filter((h) => h != null) as any[])
    : [];
  const applicableHomeworks = filterApplicableResources(input.trackScope, rawHomeworks);
  const validHomeworks = applicableHomeworks.filter(isValidHomework);
  const hwPresent = applicableHomeworks.length > 0;
  const hwValid = validHomeworks.length > 0 && validHomeworks.length === applicableHomeworks.length;
  const hwHasInvalid = applicableHomeworks.some((h) => !isValidHomework(h));
  const homeworkCheck: ReadinessCheck = {
    required: true,
    present: hwPresent,
    valid: !hwHasInvalid && validHomeworks.length > 0,
    detail: !hwPresent
      ? "no applicable homework"
      : hwHasInvalid
        ? `has invalid homework (applicable=${applicableHomeworks.length}, valid=${validHomeworks.length})`
        : `${validHomeworks.length} valid homework(s)`,
    count: applicableHomeworks.length,
  };
  if (!hwPresent) errors.push("HOMEWORK_MISSING");
  else if (hwHasInvalid) errors.push("HOMEWORK_INVALID");

  // ---- Overall ----
  // ARCHIVED is never ready nor publishable — short-circuit.
  const requiredChecksValid =
    (videoCheck.required ? videoCheck.present && videoCheck.valid : true) &&
    (quizCheck.required ? quizCheck.present && quizCheck.valid : true) &&
    (homeworkCheck.required ? homeworkCheck.present && homeworkCheck.valid : true);

  let isReady = requiredChecksValid && !isArchived;

  // Published / archived lessons are considered not-ready for transition
  // purposes in the sense that they cannot become READY via readiness — they
  // are already beyond that. But the readiness payload still reports the
  // underlying content completeness for admin debugging.
  // The `isReady` flag is purely content completeness (minus archived).
  // `canPublish` adds lifecycle awareness: READY state + isReady + not archived.

  if (isArchived) {
    errors.push("ARCHIVED");
    isReady = false;
  }

  const canPublish = isReady && status === "READY" && !isArchived;

  // Warnings for edge cases that don't block but are worth surfacing.
  if (pdfPresent && pdfCheck.required === false) {
    warnings.push("PDF present but not required until Phase 14");
  }
  if (rawQuizzes.length > applicableQuizzes.length) {
    warnings.push(`${rawQuizzes.length - applicableQuizzes.length} quiz(zes) ignored by track scope`);
  }
  if (rawHomeworks.length > applicableHomeworks.length) {
    warnings.push(`${rawHomeworks.length - applicableHomeworks.length} homework(s) ignored by track scope`);
  }
  if (sessionVideoCount > 0 && !videoUrlPresent) {
    warnings.push("video via SessionVideo only — legacy videoUrl empty");
  }

  return {
    lessonId,
    status,
    curriculumStatus,
    trackScope,
    isReady,
    canPublish,
    checks: {
      video: videoCheck,
      pdf: pdfCheck,
      quiz: quizCheck,
      homework: homeworkCheck,
    },
    errors,
    warnings,
  };
}

// Convenience: does the lesson have enough content to be considered READY?
export function isLessonContentReady(input: ReadinessInput): boolean {
  return getLessonReadiness(input).isReady;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type TransitionCode =
  | "OK"
  | "ALREADY_IN_TARGET"
  | "INVALID_STATUS"
  | "UNKNOWN_STATUS"
  | "ARCHIVED_BLOCKED"
  | "NOT_READY"
  | "FORBIDDEN_TRANSITION";

export type TransitionResult = {
  ok: boolean;
  code: TransitionCode;
  message: string;
};

/**
 * Pure transition validator. Does NOT hit the database.
 *
 * Allowed (Phase 13):
 *   DRAFT    → READY      if isReady
 *   READY    → DRAFT      allowed (admin correction)
 *   READY    → PUBLISHED  via OPEN only (enforced by caller — this validator
 *                         will allow it when readiness is true, but routes
 *                         must still verify the ceremony)
 * Forbidden:
 *   DRAFT    → PUBLISHED  never (must stage READY first)
 *   PUBLISHED→ DRAFT      never
 *   PUBLISHED→ READY      not supported in Phase 13 (explicitly forbidden to keep
 *                         publish idempotent and history stable)
 *   any → any when ARCHIVED
 *   READY   → READY / PUBLISHED → PUBLISHED are idempotent (treated as OK)
 */
export function canTransition(
  from: LessonStatus | string | null | undefined,
  to: LessonStatus | string | null | undefined,
  opts: { readiness?: LessonReadiness | null; curriculumStatus?: string | null } = {}
): TransitionResult {
  const f = normalizeLessonStatus(from);
  const t = normalizeLessonStatus(to);
  if (!f || !t) {
    return { ok: false, code: "UNKNOWN_STATUS", message: "unknown status" };
  }
  if (f === t) {
    return { ok: true, code: "ALREADY_IN_TARGET", message: "already in target" };
  }
  const curriculumStatus = opts.curriculumStatus ?? null;
  if (curriculumStatus === "ARCHIVED") {
    return { ok: false, code: "ARCHIVED_BLOCKED", message: "archived lessons cannot change lifecycle" };
  }

  // Forbidden patterns
  if (f === "DRAFT" && t === "PUBLISHED") {
    return { ok: false, code: "FORBIDDEN_TRANSITION", message: "DRAFT→PUBLISHED is forbidden — stage READY first" };
  }
  if (f === "PUBLISHED" && t === "DRAFT") {
    return { ok: false, code: "FORBIDDEN_TRANSITION", message: "PUBLISHED→DRAFT is forbidden" };
  }
  if (f === "PUBLISHED" && t === "READY") {
    return { ok: false, code: "FORBIDDEN_TRANSITION", message: "PUBLISHED→READY is not supported in Phase 13" };
  }

  // Allowed with readiness gate
  if (f === "DRAFT" && t === "READY") {
    if (!opts.readiness || !opts.readiness.isReady) {
      return { ok: false, code: "NOT_READY", message: "lesson is not ready — missing required content" };
    }
    return { ok: true, code: "OK", message: "DRAFT→READY allowed" };
  }

  if (f === "READY" && t === "DRAFT") {
    return { ok: true, code: "OK", message: "READY→DRAFT allowed (admin correction)" };
  }

  if (f === "READY" && t === "PUBLISHED") {
    if (!opts.readiness || !opts.readiness.isReady) {
      return { ok: false, code: "NOT_READY", message: "lesson is not ready — cannot publish" };
    }
    return { ok: true, code: "OK", message: "READY→PUBLISHED allowed via OPEN ceremony" };
  }

  // Any other combination (should not happen with 3 states)
  return { ok: false, code: "FORBIDDEN_TRANSITION", message: `${f}→${t} is not allowed` };
}

// Helper: should the student universe include this lesson?
// Policy: PUBLISHED + not ARCHIVED. Unpublished (DRAFT/READY) are excluded.
export function isStudentVisibleLesson(
  lesson: { status?: unknown; curriculumStatus?: unknown }
): boolean {
  if (lesson.curriculumStatus === "ARCHIVED") return false;
  return isLessonPublished(lesson.status);
}

// Sync helper for the deprecated isPublished mirror. New code should use status
// directly; this exists so any manual SQL or legacy reader can interpret the
// mirror correctly, and so the OPEN ceremony can keep the two in sync.
export function publishedMirrorFromStatus(status: LessonStatus): boolean {
  return status === "PUBLISHED";
}
export function statusFromPublishedMirror(isPublished: boolean): LessonStatus {
  return isPublished ? "PUBLISHED" : "DRAFT";
}
