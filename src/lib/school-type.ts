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
