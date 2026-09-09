// CodeMind Academy — Track scope (Phase 12).
//
// THE CONTRACT
// ============
// There is exactly ONE course. `trackScope` is the content-eligibility
// dimension underneath the shared academic skeleton:
//
//   Course (shared)
//     └── Part → Unit → Lesson.trackScope
//                           ├── Quiz.trackScope
//                           └── Homework.trackScope
//
//   SHARED   → eligible for ARABIC students AND LANGUAGE students
//   ARABIC   → eligible for ARABIC students only
//   LANGUAGE → eligible for LANGUAGE students only
//
// THE RULES THIS MODULE OWNS
// ==========================
//  1. Matching is derived SERVER-SIDE from the student's own
//     `Student.schoolType` row. It is NEVER taken from a request parameter,
//     a body field, the URL, the client locale, or the UI language. Arabic
//     UI != Arabic school; they are unrelated facts.
//  2. Everything FAILS CLOSED. A student whose school type is unknown,
//     missing or unrecognised is eligible for SHARED content ONLY — never for
//     track-specific content. An unknown `trackScope` value is likewise
//     treated as ineligible rather than as SHARED.
//  3. Track scope is a FILTER, not a second progression engine. It narrows
//     the lesson universe that `getCourseSessionProgress` already computes, so
//     an ineligible lesson never enters the sequence, never becomes an unlock
//     target, never satisfies completion and never appears in prev/next.
//     Phase 4 progression semantics are untouched.
//  4. `trackScope` is metadata, not curriculum. The official curriculum stays
//     2 Parts / 7 Units / 23 lessons with `officialCode` 1-1..7-3 unique,
//     whatever scopes exist.
//
// SESSION VIDEOS deliberately do NOT carry a `trackScope` column: their track
// is `Batch.schoolType`, which is non-nullable and is already the segment the
// whole session-video system is built on. Adding a second dimension there
// would create two sources of truth for one fact. A video intended for both
// tracks is published to both batches, sharing ONE MediaAsset — so no media
// bytes are duplicated. See `videoTrackFilter` below.

import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";

export type TrackScope = "SHARED" | "ARABIC" | "LANGUAGE";

export const TRACK_SCOPES: readonly TrackScope[] = [
  "SHARED",
  "ARABIC",
  "LANGUAGE",
] as const;

/**
 * Normalise any stored/incoming value to a canonical TrackScope, or null.
 * `null` means "not a track scope" — callers must treat that as INELIGIBLE,
 * never as SHARED.
 */
export function normalizeTrackScope(value: unknown): TrackScope | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  if (v === "SHARED" || v === "ALL" || v === "BOTH") return "SHARED";
  // A school type is also a valid track scope: ARABIC/LANGUAGE mean the same
  // thing on both sides of the comparison, which is what keeps the rule a
  // single lookup instead of a mapping table.
  const asSchoolType = normalizeSchoolType(v);
  return asSchoolType; // "ARABIC" | "LANGUAGE" | null
}

export function isTrackScope(value: unknown): value is TrackScope {
  return normalizeTrackScope(value) !== null;
}

/**
 * Every track scope a student is eligible for.
 *
 * SHARED is always included. The student's own track is added only when their
 * school type is a recognised value — an unknown/missing school type yields
 * SHARED alone, which is the fail-closed rule.
 */
export function eligibleTrackScopes(
  schoolType: SchoolType | string | null | undefined
): TrackScope[] {
  const normalized = normalizeSchoolType(schoolType);
  return normalized ? ["SHARED", normalized] : ["SHARED"];
}

/**
 * The single authorization predicate: may a student of `schoolType` consume
 * content whose scope is `trackScope`?
 *
 * Fail-closed on BOTH sides: an unrecognised school type only ever matches
 * SHARED, and an unrecognised scope matches nothing.
 */
export function canAccessTrackScope(
  schoolType: SchoolType | string | null | undefined,
  trackScope: unknown
): boolean {
  const scope = normalizeTrackScope(trackScope);
  if (!scope) return false;
  return eligibleTrackScopes(schoolType).includes(scope);
}

/**
 * Prisma `where` fragment narrowing a `trackScope` column to what a student
 * may see. Spread it into any content query.
 *
 * Uses an explicit `in` list rather than an `OR`, so the predicate stays a
 * single index-friendly condition and cannot be accidentally widened by
 * another `OR` at the same level.
 */
export function trackScopeWhere(
  schoolType: SchoolType | string | null | undefined
): { trackScope: { in: TrackScope[] } } {
  return trackScopeInWhere(eligibleTrackScopes(schoolType));
}

/**
 * Same predicate, built from an explicit scope set instead of a school type.
 * Used by the parent surface, whose eligible set is the UNION of their
 * enrolled children's tracks rather than a single school type.
 */
export function trackScopeInWhere(
  scopes: Iterable<TrackScope>
): { trackScope: { in: TrackScope[] } } {
  return { trackScope: { in: [...new Set(scopes)] } };
}

/**
 * Prisma `where` fragment for session videos.
 *
 * A video's track IS its batch's school type, so eligibility is an equality
 * on `batch.schoolType`. A student with no recognised school type gets NO
 * videos at all — there is no such thing as a "shared" batch, because
 * `Batch.schoolType` is non-nullable by design.
 */
export function videoTrackFilter(
  schoolType: SchoolType | string | null | undefined
): { batch: { schoolType: SchoolType } | { schoolType: { in: SchoolType[] } } } {
  const normalized = normalizeSchoolType(schoolType);
  return normalized
    ? { batch: { schoolType: normalized } }
    : // Impossible-to-satisfy filter: fails closed without inventing a value.
      { batch: { schoolType: { in: [] as SchoolType[] } } };
}

// ---------------------------------------------------------------------------
// Questions (Question.schoolType / ExamQuestion.schoolType)
// ---------------------------------------------------------------------------
//
// A question's school type is NULLABLE and NULL MEANS SHARED — that convention
// predates Phase 12 (the mock-exam bank isolation relies on it) and is kept
// exactly as-is. Phase 12 adds the missing half: the SESSION QUIZ flow now
// enforces it too.

/**
 * Prisma `where` fragment selecting the questions a student may be served.
 * `schoolType: null` rows are SHARED and stay available to both tracks, so an
 * Arabic student can never be served a LANGUAGE question and vice versa.
 */
export function eligibleQuestionFilter(
  schoolType: SchoolType | string | null | undefined
) {
  const normalized = normalizeSchoolType(schoolType);
  return normalized
    ? { OR: [{ schoolType: normalized }, { schoolType: null }] }
    : { schoolType: null };
}

/**
 * Runtime counterpart of `eligibleQuestionFilter` — the single predicate used
 * when filtering an already-loaded set (the frozen attempt question set, the
 * grading loop). Selection and grading call THIS, so they cannot drift apart.
 */
export function isQuestionEligible(
  schoolType: SchoolType | string | null | undefined,
  questionSchoolType: unknown
): boolean {
  if (questionSchoolType === null || questionSchoolType === undefined) {
    return true; // SHARED question
  }
  const normalized = normalizeSchoolType(questionSchoolType);
  if (!normalized) return false; // unrecognised tag → ineligible (fail closed)
  return normalized === normalizeSchoolType(schoolType);
}

// ---------------------------------------------------------------------------
// Question tagging precedence (teacher/admin authoring)
// ---------------------------------------------------------------------------
//
// Every newly created session question must resolve to exactly one of
// SHARED(null) / ARABIC / LANGUAGE. Precedence is EXPLICIT and ordered:
//
//   1. An explicit `schoolType` supplied by the author — including an explicit
//      "SHARED", which means NULL. An author's deliberate choice always wins.
//   2. Otherwise, the OWNING QUIZ's trackScope when that quiz is
//      track-specific (ARABIC / LANGUAGE). A question created inside an
//      ARABIC-only quiz is an ARABIC question; leaving it NULL would make a
//      track-specific quiz serve shared-tagged questions to the other track
//      the moment it is reused.
//   3. Otherwise SHARED (NULL) — the quiz itself is shared content.
//
// Step 2 deliberately inherits from the QUIZ and not from the LESSON: the
// quiz is the unit that owns the question, and a SHARED lesson may host both
// an ARABIC and a LANGUAGE quiz. Inheriting the lesson would silently
// collapse that distinction.

/**
 * Resolve the `schoolType` to persist on a new question.
 * Returns `null` for SHARED (the stored representation).
 *
 * `explicit` is the raw author-supplied value:
 *   - undefined / absent        → fall through to the quiz's scope
 *   - "SHARED" / "" / null      → explicitly shared (null)
 *   - "ARABIC" / "LANGUAGE"     → that track
 *   - anything else             → REJECTED by the caller via
 *                                 `parseQuestionSchoolTypeInput`
 */
export function resolveQuestionSchoolType(
  explicit: unknown,
  quizTrackScope: unknown
): SchoolType | null {
  if (explicit !== undefined) {
    if (explicit === null) return null;
    if (typeof explicit === "string") {
      const v = explicit.trim();
      if (v === "") return null;
      const scope = normalizeTrackScope(v);
      if (scope === "SHARED") return null;
      if (scope) return scope; // ARABIC | LANGUAGE
      // Unrecognised: fall through rather than inventing a tag. Callers that
      // must reject do so with `parseQuestionSchoolTypeInput` first.
    }
  }
  const inherited = normalizeTrackScope(quizTrackScope);
  return inherited === "ARABIC" || inherited === "LANGUAGE" ? inherited : null;
}

/**
 * Strict parse of an author-supplied question school type.
 *
 *   `{ ok: true, specified: false }`            → absent, apply precedence
 *   `{ ok: true, specified: true, value: null }` → explicitly SHARED
 *   `{ ok: true, specified: true, value }`       → ARABIC / LANGUAGE
 *   `{ ok: false }`                              → present but meaningless;
 *                                                  the route must return 400
 *                                                  rather than silently
 *                                                  storing a shared tag.
 */
export function parseQuestionSchoolTypeInput(
  raw: unknown
):
  | { ok: true; specified: false }
  | { ok: true; specified: true; value: SchoolType | null }
  | { ok: false } {
  if (raw === undefined) return { ok: true, specified: false };
  if (raw === null) return { ok: true, specified: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const v = raw.trim();
  if (v === "") return { ok: true, specified: true, value: null };
  const scope = normalizeTrackScope(v);
  if (!scope) return { ok: false };
  return { ok: true, specified: true, value: scope === "SHARED" ? null : scope };
}

/** Localised labels — never hardcode track names in components. */
export const TRACK_SCOPE_LABELS: Record<
  TrackScope,
  { ar: string; en: string }
> = {
  SHARED: { ar: "مشترك", en: "Shared" },
  ARABIC: { ar: "مدارس عربي", en: "Arabic School" },
  LANGUAGE: { ar: "مدارس لغات", en: "Language School" },
};
