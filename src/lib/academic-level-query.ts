// CodeMind Academy — Phase M1 — the ONE shared `?academicLevel=` query parser.
//
// THE CONTRACT (identical for every route, admin and teacher alike)
//   absent / "" / "all" (any case)   → { ok: true, level: null }   NO narrowing
//   "FIRST_SECONDARY" | "SECOND_SECONDARY" (any case/spacing)
//                                    → { ok: true, level }        narrow to it
//   anything else                    → { ok: false, raw }          caller → 400
//
// WHY "unknown ⇒ 400" AND NOT "unknown ⇒ all"
//   A filter may only ever NARROW a result set. Silently treating a typo as
//   "all" would WIDEN the list the caller asked for, which on a teacher route
//   is an authorization-shaped failure and on an admin route is a wrong-data
//   failure. The value is therefore never guessed, never defaulted: it is
//   either a canonical `AcademicLevel` or a refusal.
//
// WHAT THIS MODULE IS NOT
//   * It does not read a session, a role or a database. It parses a string.
//   * It does not decide WHAT to narrow. Every caller composes the returned
//     level into its OWN already-authorized query (`groupsOfLevelWhere` for a
//     teacher's own groups, `Course.academicLevel` for the catalogue, the
//     derived `Lesson.academicLevel` cache for lesson lists). The parser can
//     therefore never widen an existing scope: `null` means "the caller's
//     default scope", and a level means "the subset of it".
//
// RELATIONSHIP TO `src/lib/teacher-academic-level.ts`
//   That module's `parseAcademicLevelQuery` is the teacher-side ORIGINAL of this
//   contract (Phase L manual-QA fix #4) and its behaviour is a SUPERSET-compatible
//   subset of this one: it only ever receives a string. M1 did NOT rewrite the
//   teacher helpers — the teacher routes keep calling them, and
//   `tests/phase-m-primitives.test.js` proves the two implementations agree on
//   every input shape (empty, whitespace, "all" in any case, both canonical
//   levels in any case/spacing, junk, null, undefined, numbers, objects).

import {
  isAcademicLevel,
  normalizeAcademicLevel,
  type AcademicLevel,
} from "@/lib/academic-level";

/** The parsed result: either "no narrowing" (`null`) or one canonical level. */
export type AcademicLevelParam =
  | { ok: true; level: AcademicLevel | null }
  | { ok: false; raw: string };

/** What a route can hand in: a raw query string, a URL, or a SearchParams-like. */
export type AcademicLevelParamSource =
  | string
  | null
  | undefined
  | { get(name: string): string | null }
  | URL
  | { url?: string | null };

/** `""` ("nothing was requested") in the boolean sense — never a wildcard value. */
export const ACADEMIC_LEVEL_PARAM = "academicLevel" as const;

/**
 * Parse a single query VALUE.
 *
 *   null / undefined / ""    → { ok: true, level: null }
 *   "all" (any case)         → { ok: true, level: null }
 *   canonical level (any case / spacing, e.g. "first-secondary")
 *                            → { ok: true, level }
 *   anything else            → { ok: false, raw }
 *
 * Tolerant on the OUTSIDE (a missing value is not an error — every list is
 * legal without a level), strict on the INSIDE (a present but unrecognised
 * value is refused rather than ignored).
 */
export function parseAcademicLevelValue(raw: unknown): AcademicLevelParam {
  if (raw === null || raw === undefined) return { ok: true, level: null };
  if (typeof raw !== "string") return { ok: false, raw: String(raw) };

  const value = raw.trim();
  if (!value) return { ok: true, level: null };
  if (value.toLowerCase() === "all") return { ok: true, level: null };

  const normalized = normalizeAcademicLevel(value);
  if (normalized) return { ok: true, level: normalized };
  return { ok: false, raw: value };
}

/**
 * Parse the `?academicLevel=` value out of a `URLSearchParams` / `URL` / raw
 * string / `{ get() }` source. `name` defaults to `"academicLevel"` so a route
 * can read the standard parameter with one call.
 */
export function parseAcademicLevelParam(
  source: AcademicLevelParamSource,
  name: string = ACADEMIC_LEVEL_PARAM
): AcademicLevelParam {
  if (source === null || source === undefined) return { ok: true, level: null };

  if (typeof source === "string") {
    // A bare string is the VALUE (not a query string): the caller already
    // isolated it, which is the shape `parseAcademicLevelValue` takes.
    return parseAcademicLevelValue(source);
  }

  try {
    if (source instanceof URL) {
      return parseAcademicLevelValue(source.searchParams.get(name));
    }
    if (typeof (source as { get?: unknown }).get === "function") {
      return parseAcademicLevelValue(
        (source as { get(name: string): string | null }).get(name)
      );
    }
    // The `{ url }` shape several route handlers and verifiers are called with.
    const url = (source as { url?: string | null }).url;
    if (typeof url === "string" && url) {
      return parseAcademicLevelValue(new URL(url).searchParams.get(name));
    }
  } catch {
    // An unparseable URL means "nothing was requested" — never a crash and
    // never a widened list. Identical to the teacher helper's tolerance.
    return { ok: true, level: null };
  }
  return { ok: true, level: null };
}

/**
 * Parse a value that may arrive as a SINGLE string or as REPEATED parameters
 * (`?academicLevel=a&academicLevel=b`). Repeated values must name the SAME
 * level: a contradiction is refused (400) instead of silently picking one.
 */
export function parseAcademicLevelParams(
  source: AcademicLevelParamSource,
  name: string = ACADEMIC_LEVEL_PARAM
): AcademicLevelParam {
  let all: string[] = [];
  try {
    if (source instanceof URL) {
      all = source.searchParams.getAll(name);
    } else if (
      source &&
      typeof source === "object" &&
      typeof (source as { getAll?: unknown }).getAll === "function"
    ) {
      all = (source as { getAll(name: string): string[] }).getAll(name);
    } else {
      return parseAcademicLevelParam(source, name);
    }
  } catch {
    return { ok: true, level: null };
  }

  if (all.length === 0) return { ok: true, level: null };
  let chosen: AcademicLevel | null = null;
  for (const raw of all) {
    const parsed = parseAcademicLevelValue(raw);
    if (!parsed.ok) return parsed;
    if (parsed.level === null) continue;
    if (chosen !== null && chosen !== parsed.level) {
      return { ok: false, raw: all.join(",") };
    }
    chosen = parsed.level;
  }
  return { ok: true, level: chosen };
}

/**
 * Convenience for callers that want the Prisma-shaped `where` fragment rather
 * than a level: `{ course: { academicLevel } }` is the ONE definition of "a
 * group of level L" and lives in `src/lib/academic-level.ts`
 * (`groupsOfLevelWhere`); this re-export exists so a route does not have to
 * import two modules to compose the common case.
 */
export { isAcademicLevel };
