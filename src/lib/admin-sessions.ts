// CodeMind Academy — Admin session-management contracts (Phase 15).
//
// THE CONTRACT
// ============
// The admin publishing workflow (Create/Edit → Stage Materials → Readiness →
// Review → OPEN) is a UI over the EXISTING server-side lifecycle and readiness
// machinery. This module owns the thin input contracts that machinery needs
// and nothing else:
//
//   • which lesson fields an admin may create / edit (safe metadata only);
//   • which fields are NEVER trusted from the client (`status`, `isPublished`,
//     `isLocked`, `officialCode`, `curriculumStatus`, placement, legacy media
//     urls, identity fields);
//   • the list-query filter grammar.
//
// THE RULES THIS MODULE OWNS
// ==========================
//  1. Lifecycle is NOT writable here. There is deliberately no parser that
//     yields a `status`, and the routes built on these parsers have no code
//     path that writes one. Publishing flows through `transitionLesson` only.
//  2. Official curriculum identity is reconciler-owned. Creation can never
//     mint an `officialCode` (or an OFFICIAL row); placement moves (`unitId` /
//     `topicId` changes) are rejected — the reconciler owns placement.
//  3. Legacy media urls (`videoUrl` / `pdfUrl`) are not writable. Videos are
//     staged through the SessionVideo system, PDFs through the Phase 14
//     material API; letting PATCH write the legacy strings would be a second,
//     unvalidated upload system that also feeds the readiness contract.
//  4. Everything FAILS CLOSED: unknown enum values, wrong types and sensitive
//     fields are 400s with machine-readable codes, never silent ignores.
//  5. This module is PURE (no prisma, no I/O) so the Phase 15 suite exercises
//     the shipped validators directly. Existence checks (does the unit exist?)
//     stay in the routes, next to the database.
//
// See docs/PHASE_15_ADMIN_PUBLISHING_WORKFLOW.md for the full contract.

import {
  normalizeTrackScope,
  type TrackScope,
} from "@/lib/track-scope";
import {
  LESSON_STATUSES,
  normalizeLessonStatus,
  type LessonStatus,
} from "@/lib/session-lifecycle";

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

export type CurriculumStatus = "OFFICIAL" | "LEGACY" | "ARCHIVED";

export const CURRICULUM_STATUSES: readonly CurriculumStatus[] = [
  "OFFICIAL",
  "LEGACY",
  "ARCHIVED",
] as const;

export function normalizeCurriculumStatus(
  value: unknown
): CurriculumStatus | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  if (v === "OFFICIAL" || v === "LEGACY" || v === "ARCHIVED") return v;
  return null;
}

/** Re-exported so routes/tests share one spelling of the lifecycle lattice. */
export { LESSON_STATUSES, normalizeLessonStatus };
export type { LessonStatus, TrackScope };

// ---------------------------------------------------------------------------
// Field policy
// ---------------------------------------------------------------------------

/**
 * Fields the client must never supply on EITHER create or update. Each is
 * rejected with `FORBIDDEN_FIELD` naming the field, so a caller learns the
 * boundary instead of silently dropping input.
 *
 *   status / isPublished / isLocked — the lifecycle machine owns these;
 *   officialCode                    — the reconciler owns official identity;
 *   curriculumStatus                — archive/restore is its own ceremony;
 *   topicId                         — no new legacy-chain rows, ever;
 *   videoUrl / pdfUrl               — stage via SessionVideo / material APIs;
 *   id / lessonId / courseId        — identity comes from the URL / the unit;
 *   createdAt / updatedAt           — database-owned.
 */
export const FORBIDDEN_LESSON_FIELDS: readonly string[] = [
  "status",
  "isPublished",
  "isLocked",
  "officialCode",
  "curriculumStatus",
  "topicId",
  "videoUrl",
  "pdfUrl",
  "id",
  "lessonId",
  "courseId",
  "createdAt",
  "updatedAt",
] as const;

/** `unitId` is required on create but immutable afterwards (reconciler owns placement). */
export const UPDATE_ONLY_FORBIDDEN_FIELDS: readonly string[] = [
  "unitId",
] as const;

export type FieldRejection = { ok: false; code: "FORBIDDEN_FIELD"; field: string };

function rejectForbiddenField(
  body: Record<string, unknown>,
  extra: readonly string[] = []
): FieldRejection | null {
  for (const field of [...FORBIDDEN_LESSON_FIELDS, ...extra]) {
    if (body[field] !== undefined) return { ok: false, code: "FORBIDDEN_FIELD", field };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scalar parsers (shared by create + update)
// ---------------------------------------------------------------------------

const TITLE_MAX = 200;
const TEXT_MAX = 5000;
const DURATION_MIN = 1;
const DURATION_MAX = 1440;

function parseTitle(
  raw: unknown,
  field: "title" | "titleAr"
): { ok: true; value: string } | { ok: false; code: string } {
  if (typeof raw !== "string") return { ok: false, code: `${field.toUpperCase()}_REQUIRED` };
  const v = raw.trim();
  if (v.length === 0) return { ok: false, code: `${field.toUpperCase()}_REQUIRED` };
  if (v.length > TITLE_MAX) return { ok: false, code: `${field.toUpperCase()}_TOO_LONG` };
  return { ok: true, value: v };
}

function parseOptionalText(
  raw: unknown,
  field: string
): { ok: true; value: string | null } | { ok: false; code: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, code: `INVALID_${field.toUpperCase()}` };
  const v = raw.trim();
  if (v.length === 0) return { ok: true, value: null };
  if (v.length > TEXT_MAX) return { ok: false, code: `${field.toUpperCase()}_TOO_LONG` };
  return { ok: true, value: v };
}

function parseOptionalDuration(
  raw: unknown
): { ok: true; value: number | null } | { ok: false; code: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < DURATION_MIN || n > DURATION_MAX) {
    return { ok: false, code: "INVALID_DURATION" };
  }
  return { ok: true, value: n };
}

function parseOptionalOrder(
  raw: unknown
): { ok: true; value: number | null } | { ok: false; code: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 100000) {
    return { ok: false, code: "INVALID_ORDER" };
  }
  return { ok: true, value: n };
}

function parseOptionalTrackScope(
  raw: unknown
): { ok: true; value: TrackScope | null } | { ok: false; code: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw === "string" && raw.trim() === "") return { ok: true, value: null };
  const scope = normalizeTrackScope(raw);
  if (!scope) return { ok: false, code: "INVALID_TRACK_SCOPE" };
  return { ok: true, value: scope };
}

// ---------------------------------------------------------------------------
// Create (DRAFT-only; the route applies LESSON_NEW_LIFECYCLE itself)
// ---------------------------------------------------------------------------

export type CreateLessonInput = {
  title: string;
  titleAr: string;
  /** Canonical chain only: the unit this session belongs to. */
  unitId: string;
  trackScope: TrackScope;
  description: string | null;
  summary: string | null;
  duration: number | null;
  /** Explicit position; when null the route appends after the unit's max. */
  order: number | null;
};

export type CreateLessonParse =
  | { ok: true; value: CreateLessonInput }
  | { ok: false; code: string; field?: string };

export function parseCreateLessonInput(body: unknown): CreateLessonParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "INVALID_BODY" };
  }
  const b = body as Record<string, unknown>;

  const forbidden = rejectForbiddenField(b);
  if (forbidden) return { ...forbidden };

  const title = parseTitle(b.title, "title");
  if (!title.ok) return title;
  const titleAr = parseTitle(b.titleAr, "titleAr");
  if (!titleAr.ok) return titleAr;

  if (typeof b.unitId !== "string" || b.unitId.trim().length === 0) {
    return { ok: false, code: "UNIT_ID_REQUIRED" };
  }

  const trackScope = parseOptionalTrackScope(b.trackScope);
  if (!trackScope.ok) return trackScope;
  const description = parseOptionalText(b.description, "description");
  if (!description.ok) return description;
  const summary = parseOptionalText(b.summary, "summary");
  if (!summary.ok) return summary;
  const duration = parseOptionalDuration(b.duration);
  if (!duration.ok) return duration;
  const order = parseOptionalOrder(b.order);
  if (!order.ok) return order;

  return {
    ok: true,
    value: {
      title: title.value,
      titleAr: titleAr.value,
      unitId: b.unitId.trim(),
      trackScope: trackScope.value ?? "SHARED",
      description: description.value,
      summary: summary.value,
      duration: duration.value,
      order: order.value,
    },
  };
}

// ---------------------------------------------------------------------------
// Update (safe metadata + track scope; placement and lifecycle immutable)
// ---------------------------------------------------------------------------

export type UpdateLessonInput = {
  title?: string;
  titleAr?: string;
  description?: string | null;
  summary?: string | null;
  duration?: number;
  order?: number;
  trackScope?: TrackScope;
};

export type UpdateLessonParse =
  | { ok: true; value: UpdateLessonInput; touched: string[] }
  | { ok: false; code: string; field?: string };

const UPDATABLE_FIELDS = [
  "title",
  "titleAr",
  "description",
  "summary",
  "duration",
  "order",
  "trackScope",
] as const;

export function parseUpdateLessonInput(body: unknown): UpdateLessonParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, code: "INVALID_BODY" };
  }
  const b = body as Record<string, unknown>;

  const forbidden = rejectForbiddenField(b, UPDATE_ONLY_FORBIDDEN_FIELDS);
  if (forbidden) return { ...forbidden };

  const value: UpdateLessonInput = {};
  const touched: string[] = [];

  if (b.title !== undefined) {
    const t = parseTitle(b.title, "title");
    if (!t.ok) return t;
    value.title = t.value;
    touched.push("title");
  }
  if (b.titleAr !== undefined) {
    const t = parseTitle(b.titleAr, "titleAr");
    if (!t.ok) return t;
    value.titleAr = t.value;
    touched.push("titleAr");
  }
  if (b.description !== undefined) {
    const t = parseOptionalText(b.description, "description");
    if (!t.ok) return t;
    // Null clears the field; undefined would have left it untouched.
    value.description = t.value;
    touched.push("description");
  }
  if (b.summary !== undefined) {
    const t = parseOptionalText(b.summary, "summary");
    if (!t.ok) return t;
    value.summary = t.value;
    touched.push("summary");
  }
  if (b.duration !== undefined) {
    const d = parseOptionalDuration(b.duration);
    if (!d.ok) return d;
    if (d.value !== null) {
      value.duration = d.value;
      touched.push("duration");
    }
  }
  if (b.order !== undefined) {
    const o = parseOptionalOrder(b.order);
    if (!o.ok) return o;
    if (o.value !== null) {
      value.order = o.value;
      touched.push("order");
    }
  }
  if (b.trackScope !== undefined) {
    const s = parseOptionalTrackScope(b.trackScope);
    if (!s.ok) return s;
    if (s.value !== null) {
      value.trackScope = s.value;
      touched.push("trackScope");
    }
  }

  if (touched.length === 0) return { ok: false, code: "NOTHING_TO_UPDATE" };
  return { ok: true, value, touched };
}

// ---------------------------------------------------------------------------
// Archive ceremony input
// ---------------------------------------------------------------------------

export type ArchiveAction = "ARCHIVE" | "RESTORE";

export function parseArchiveAction(body: unknown): ArchiveAction | null {
  if (body === null || body === undefined) return "ARCHIVE";
  if (typeof body !== "object" || Array.isArray(body)) return null;
  const raw = (body as Record<string, unknown>).action;
  if (raw === undefined || raw === null) return "ARCHIVE";
  if (typeof raw !== "string") return null;
  const v = raw.trim().toUpperCase();
  if (v === "ARCHIVE") return "ARCHIVE";
  if (v === "RESTORE") return "RESTORE";
  return null;
}

/**
 * Pure archive eligibility: archiving must never smuggle a lifecycle
 * transition. A PUBLISHED lesson has to be unpublished first (through the
 * ceremony), so the only archivable states are the admin-visible ones.
 */
export function canArchiveFromStatus(status: unknown): boolean {
  const s = normalizeLessonStatus(status);
  return s === "DRAFT" || s === "READY";
}

// ---------------------------------------------------------------------------
// List query grammar
// ---------------------------------------------------------------------------

export type LessonListQuery = {
  courseId: string | null;
  status: LessonStatus | null;
  trackScope: TrackScope | null;
  curriculumStatus: CurriculumStatus | null;
  q: string | null;
  includeReadiness: boolean;
  page: number;
  pageSize: number;
};

export const LESSON_LIST_DEFAULT_PAGE_SIZE = 50;
export const LESSON_LIST_MAX_PAGE_SIZE = 200;

export type LessonListQueryParse =
  | { ok: true; value: LessonListQuery }
  | { ok: false; code: string; field?: string };

function parsePositiveInt(raw: string | null, fallback: number): number | null {
  if (raw === null || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

export function parseLessonListQuery(
  params: { get: (key: string) => string | null } | URLSearchParams | Record<string, string | null | undefined>
): LessonListQueryParse {
  const get = (key: string): string | null => {
    if (typeof (params as { get?: unknown }).get === "function") {
      return (params as { get: (k: string) => string | null }).get(key);
    }
    const v = (params as Record<string, string | null | undefined>)[key];
    return v ?? null;
  };

  const courseIdRaw = get("courseId");
  const courseId = courseIdRaw && courseIdRaw.trim() ? courseIdRaw.trim() : null;

  const statusRaw = get("status");
  let status: LessonStatus | null = null;
  if (statusRaw && statusRaw.trim()) {
    const s = normalizeLessonStatus(statusRaw);
    if (!s) return { ok: false, code: "INVALID_STATUS", field: "status" };
    status = s;
  }

  const scopeRaw = get("trackScope");
  let trackScope: TrackScope | null = null;
  if (scopeRaw && scopeRaw.trim()) {
    const s = normalizeTrackScope(scopeRaw);
    if (!s) return { ok: false, code: "INVALID_TRACK_SCOPE", field: "trackScope" };
    trackScope = s;
  }

  const curriculumRaw = get("curriculumStatus");
  let curriculumStatus: CurriculumStatus | null = null;
  if (curriculumRaw && curriculumRaw.trim()) {
    const c = normalizeCurriculumStatus(curriculumRaw);
    if (!c) return { ok: false, code: "INVALID_CURRICULUM_STATUS", field: "curriculumStatus" };
    curriculumStatus = c;
  }

  const qRaw = get("q");
  const q = qRaw && qRaw.trim() ? qRaw.trim().slice(0, 120) : null;

  const includeReadiness =
    (get("includeReadiness") || "").trim().toLowerCase() === "1" ||
    (get("includeReadiness") || "").trim().toLowerCase() === "true";

  const page = parsePositiveInt(get("page"), 1);
  if (page === null) return { ok: false, code: "INVALID_PAGE", field: "page" };
  const pageSizeRaw = parsePositiveInt(get("pageSize"), LESSON_LIST_DEFAULT_PAGE_SIZE);
  if (pageSizeRaw === null) return { ok: false, code: "INVALID_PAGE_SIZE", field: "pageSize" };
  const pageSize = Math.min(pageSizeRaw, LESSON_LIST_MAX_PAGE_SIZE);

  return {
    ok: true,
    value: { courseId, status, trackScope, curriculumStatus, q, includeReadiness, page, pageSize },
  };
}

/** Every parser in this module rejects with one of these machine codes. */
export const ADMIN_SESSION_ERROR_CODES = [
  "FORBIDDEN_FIELD",
  "INVALID_BODY",
  "TITLE_REQUIRED",
  "TITLE_TOO_LONG",
  "TITLEAR_REQUIRED",
  "TITLEAR_TOO_LONG",
  "UNIT_ID_REQUIRED",
  "INVALID_TRACK_SCOPE",
  "INVALID_DESCRIPTION",
  "DESCRIPTION_TOO_LONG",
  "INVALID_SUMMARY",
  "SUMMARY_TOO_LONG",
  "INVALID_DURATION",
  "INVALID_ORDER",
  "NOTHING_TO_UPDATE",
  "INVALID_STATUS",
  "INVALID_CURRICULUM_STATUS",
  "INVALID_PAGE",
  "INVALID_PAGE_SIZE",
  "LESSON_NOT_FOUND",
  "UNIT_NOT_FOUND",
  "LESSON_ARCHIVED",
  "INVALID_ARCHIVE_ACTION",
  "ARCHIVE_REQUIRES_UNPUBLISH",
] as const;

// ---------------------------------------------------------------------------
// Wire shapes (TYPE-ONLY for the client: import with `import type`)
// ---------------------------------------------------------------------------
//
// The admin session APIs below return these shapes. They live here — next to
// the parsers — so the routes and the UI cannot drift apart on field names.
// Client components must import them with `import type` (erased at build):
// this module's runtime imports `session-lifecycle`, which pulls `@/lib/db`,
// and the database client must never enter the browser bundle.

/** Curriculum identity of a session, canonical chain first, legacy fallback. */
export type AdminSessionIdentity = {
  course: { id: string; slug: string; name: string; nameAr: string } | null;
  part: { id: string; title: string; titleAr: string; order: number } | null;
  unit: { id: string; title: string; titleAr: string; order: number } | null;
  topic: { id: string; title: string; titleAr: string; order: number } | null;
};

export type AdminSessionCounts = {
  quizzes: number;
  homeworks: number;
  /** Active PDF materials (all scopes). */
  materials: number;
  sessionVideos: number;
  sessionVideosPublished: number;
};

export type AdminSessionPublication = {
  id: string;
  segment: string;
  publishedAt: string;
} | null;

/**
 * One row of `GET /api/admin/lessons`. `readiness` is present only when the
 * caller passes `includeReadiness=1`, and is ALWAYS the server computation
 * (`computeLessonReadiness` over live rows) — the UI never derives it.
 */
export type AdminSessionListItem = {
  id: string;
  officialCode: string | null;
  title: string;
  titleAr: string;
  order: number;
  status: LessonStatus;
  trackScope: TrackScope;
  curriculumStatus: CurriculumStatus;
  duration: number;
  identity: AdminSessionIdentity;
  counts: AdminSessionCounts;
  /** Legacy compatibility flags (booleans only — never the raw strings). */
  legacy: { hasVideoUrl: boolean; hasPdfUrl: boolean };
  publication: AdminSessionPublication;
  /** @deprecated compat mirror, echoed read-only. Never an input anywhere. */
  isPublishedCompat: boolean;
  readiness: import("@/lib/session-lifecycle").LessonReadinessSnapshot | null;
};

export type AdminSessionListResponse = {
  lessons: AdminSessionListItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
  };
};

export type AdminSessionQuizSummary = {
  id: string;
  title: string;
  titleAr: string;
  trackScope: TrackScope;
  order: number;
  passMark: number;
  timeLimit: number | null;
  questionCount: number;
};

export type AdminSessionHomeworkSummary = {
  id: string;
  title: string;
  titleAr: string;
  trackScope: TrackScope;
  deadline: string;
  maxMarks: number;
  /** Admin-visible: the full instructions text (read-only in Phase 15). */
  instructions: string | null;
  hasInstructions: boolean;
  submissionsCount: number;
};

export type AdminSessionVideoSummary = {
  id: string;
  title: string;
  titleAr: string;
  batch: { id: string; name: string; nameAr: string; schoolType: string };
  requiredPercent: number;
  isPublished: boolean;
  publishedAt: string | null;
  createdAt: string;
};

export type AdminSessionMaterialSummary = {
  id: string;
  title: string;
  kind: string;
  trackScope: TrackScope;
  isActive: boolean;
  mediaAssetId: string | null;
  downloadUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  originalName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type AdminSessionHistoryEntry = {
  id: string;
  action: string;
  details: string | null;
  createdAt: string;
  user: { id: string; name: string; email: string } | null;
};

/**
 * `GET /api/admin/lessons/[id]` — everything the session detail workflow
 * renders, in ONE response (no duplicate fetches, no stale readiness).
 */
export type AdminSessionDetail = {
  id: string;
  officialCode: string | null;
  title: string;
  titleAr: string;
  order: number;
  description: string | null;
  summary: string | null;
  duration: number;
  status: LessonStatus;
  trackScope: TrackScope;
  curriculumStatus: CurriculumStatus;
  /** @deprecated compat mirror, echoed read-only. Never an input anywhere. */
  isPublishedCompat: boolean;
  identity: AdminSessionIdentity;
  /** Legacy compatibility urls (admin-only, read-only, never writable). */
  legacy: { videoUrl: string | null; pdfUrl: string | null };
  quizzes: AdminSessionQuizSummary[];
  homeworks: AdminSessionHomeworkSummary[];
  sessionVideos: AdminSessionVideoSummary[];
  materials: AdminSessionMaterialSummary[];
  readiness: import("@/lib/session-lifecycle").LessonReadinessSnapshot;
  publication: AdminSessionPublication;
  history: AdminSessionHistoryEntry[];
};
