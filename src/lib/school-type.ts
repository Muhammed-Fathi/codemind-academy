// CodeMind Academy — School type (Arabic / Language school) helpers.
//
// IMPORTANT: `Student.schoolType` already existed in the schema and is written
// at registration (`/api/auth/register`) and by the admin create-student route.
// This module only normalises and centralises it — it does NOT introduce a
// second classification system, and nothing is hardcoded in the frontend.

export type SchoolType = "ARABIC" | "LANGUAGE";

export const SCHOOL_TYPES: readonly SchoolType[] = ["ARABIC", "LANGUAGE"] as const;

/** Normalise any stored/incoming value to a canonical SchoolType, or null. */
export function normalizeSchoolType(value: unknown): SchoolType | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase();
  if (v === "ARABIC" || v === "AR" || v === "عربي") return "ARABIC";
  if (v === "LANGUAGE" || v === "LANGUAGES" || v === "LANG" || v === "لغات")
    return "LANGUAGE";
  return null;
}

export function isSchoolType(value: unknown): value is SchoolType {
  return normalizeSchoolType(value) !== null;
}

/**
 * Strict, REQUIRED parse for every WRITE path (registration, admin create,
 * admin update). This is the single place that decides whether an incoming
 * school type may be stored:
 *
 *   `{ ok: true, value }` → a canonical SchoolType, safe to persist
 *   `{ ok: false }`       → absent or unrecognised; the caller MUST reject
 *                           the request. It must never fall back to a
 *                           default, because a guessed school type silently
 *                           changes which track content and which session
 *                           videos a student receives.
 *
 * `Student.schoolType` is nullable in the schema (an "unspecified" student is
 * a real state), but a write path that was GIVEN a school type is not allowed
 * to quietly discard it — hence a distinct `{ ok: false }` rather than null.
 */
export function requireSchoolType(
  value: unknown
): { ok: true; value: SchoolType } | { ok: false; reason: "EMPTY" | "INVALID" } {
  if (value === null || value === undefined) return { ok: false, reason: "EMPTY" };
  if (typeof value === "string" && value.trim() === "")
    return { ok: false, reason: "EMPTY" };
  const normalized = normalizeSchoolType(value);
  if (!normalized) return { ok: false, reason: "INVALID" };
  return { ok: true, value: normalized };
}

/** Localised label pair for UI (never hardcode these in components). */
export const SCHOOL_TYPE_LABELS: Record<SchoolType, { ar: string; en: string }> = {
  ARABIC: { ar: "مدارس عربي", en: "Arabic School" },
  LANGUAGE: { ar: "مدارس لغات", en: "Language School" },
};

/**
 * Prisma `where` fragment selecting questions usable by a given school type.
 * `schoolType: null` rows are SHARED questions available to both banks, so an
 * Arabic exam can never pick a question explicitly tagged LANGUAGE and vice
 * versa.
 */
export function questionBankFilter(schoolType: SchoolType, includeShared = true) {
  return includeShared
    ? { OR: [{ schoolType }, { schoolType: null }] }
    : { schoolType };
}
