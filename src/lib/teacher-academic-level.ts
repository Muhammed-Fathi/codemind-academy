// CodeMind Academy — Teacher ACADEMIC LEVEL scoping (Phase L manual-QA fix #4).
//
// THE PROBLEM THIS SOLVES
//   A teacher can legitimately own groups in BOTH academic levels, and the two
//   official courses share ONE display name. Every teacher list that mixes
//   them (dashboard, analytics, quizzes, homework, sessions, lesson pickers)
//   therefore needs a one-click level separator — and that separator must be a
//   REAL restriction of the underlying query, not a visual hide of rows that
//   were already downloaded.
//
// THE ONE RULE
//   The level lives on `Course` and nowhere else (`Course.academicLevel`).
//   `Teacher.academicLevel` does not exist and must never be added: a teacher's
//   level scope is DERIVED as
//
//       Teacher → Group (Group.teacherId) → Group.courseId → Course.academicLevel
//
//   `GET ?academicLevel=FIRST_SECONDARY` can only NARROW that derived set: it
//   is applied as an extra Prisma `where` on the teacher's OWN groups, so it
//   composes with ownership and can never widen authorization. `all`/absent
//   means "every level the teacher owns"; an unrecognised value is refused
//   (400) rather than silently treated as "all", because a typo must never
//   broaden a list.
//
// `groupsOfLevelWhere` from `@/lib/academic-level` is the single shared
// predicate this module composes with — one definition of "a group of level L"
// for the whole platform.
//
// FIX #4 CORRECTION (what changed after review)
//   * Every teacher list payload carries `academicLevelScope(teacher.groups)`
//     computed from the UNFILTERED group set, so the UI can render the separator
//     only when the teacher really owns both levels (a single-level teacher
//     never gets a meaningless control).
//   * The separator is wired on EVERY surface where both levels can appear and
//     is always backed by a SERVER query (`?academicLevel=` on the list routes);
//     an unknown value is refused with 400 rather than silently widening.
//   * Attendance additionally refuses a `groupId` that does not belong to the
//     requested level (403, `api.156`), so the parameter can never be used to
//     reach another level's roster.
//   * `academicLevelParamOf` is tolerant on purpose: verifiers call route
//     handlers directly with a minimal request object, and a missing or
//     unparseable `url` means "nothing was requested" — never a crash and never
//     a widened list.

import { db } from "@/lib/db";
import {
  groupsOfLevelWhere,
  isAcademicLevel,
  type AcademicLevel,
} from "@/lib/academic-level";
import {
  parseAcademicLevelParam,
  parseAcademicLevelValue,
} from "@/lib/academic-level-query";

/** `""` / `all` (any case) = every level; anything else must be canonical. */
export type LevelScope = AcademicLevel | null;

/**
 * Parse the `?academicLevel=` query value.
 *
 *   null / "" / "all"            → { ok: true, level: null }   (no narrowing)
 *   "FIRST_SECONDARY" | "SECOND_SECONDARY" → { ok: true, level }
 *   anything else                → { ok: false }               (caller → 400)
 *
 * Phase M1: the RULES now live in ONE place — `parseAcademicLevelValue` in
 * `@/lib/academic-level-query` — and this function is the teacher-side adapter
 * over it. The behaviour is unchanged for every input a route can produce
 * (a query value is always `string | null`): the exact `string` semantics
 * (trim, case-insensitive `all`, `normalizeAcademicLevel`, unknown → refusal)
 * are asserted input-by-input against the shared implementation in
 * `tests/phase-m-primitives.test.js`.
 *
 * The one deliberate difference is the NON-string guard below: it preserves the
 * historical tolerance this helper had for a direct call with a minimal
 * request, where "not a level" meant "nothing was requested" rather than a
 * 400. Moving that guard into the shared parser would make it accept junk as
 * "all"; removing it would make a verifier's minimal request fail. Keeping it
 * HERE is the behaviour-preserving choice, and the shared parser stays strict.
 */
export function parseAcademicLevelQuery(
  raw: unknown
): { ok: true; level: LevelScope } | { ok: false; raw: string } {
  if (typeof raw !== "string") return { ok: true, level: null };
  return parseAcademicLevelValue(raw);
}

/**
 * Read `?academicLevel=` straight off a route request.
 *
 * Tolerant on purpose: several verifiers call route handlers directly with a
 * minimal request object, so a missing/unparseable `url` simply means "no
 * narrowing was requested" — never a crash and never a widened list.
 */
export function academicLevelParamOf(
  req: unknown
): { ok: true; level: LevelScope } | { ok: false; raw: string } {
  return parseAcademicLevelParam(
    (req as { url?: string } | null | undefined) ?? null
  );
}

/** The teacher shape these helpers read (a subset of the Teacher profile). */
type TeacherLike = {
  id: string;
  groups: Array<{ id: string; courseId: string; course?: { academicLevel?: string | null } | null }>;
};

/**
 * The ids of the teacher's OWN groups that belong to `level`, resolved in the
 * DATABASE (an extra `where` on `Group`, not an in-memory hide). Returns `null`
 * when no narrowing was asked for.
 */
export async function teacherGroupIdsOfLevel(
  teacher: TeacherLike,
  level: LevelScope,
  client: typeof db = db
): Promise<Set<string> | null> {
  if (!level) return null;
  const rows = await client.group.findMany({
    where: { teacherId: teacher.id, ...groupsOfLevelWhere(level) },
    select: { id: true },
  });
  return new Set(rows.map((g: { id: string }) => g.id));
}

/**
 * The teacher's groups, narrowed to `level` when one was requested.
 *
 * The narrowing is verified against the database, then applied to the profile's
 * already-owned group list — so the result is always a SUBSET of what the
 * teacher owns, in the profile's own order, and a level the teacher does not
 * teach yields an empty list rather than a widened one.
 */
export async function scopedTeacherGroups<T extends TeacherLike>(
  teacher: T,
  level: LevelScope,
  client: typeof db = db
): Promise<T["groups"]> {
  const allowed = await teacherGroupIdsOfLevel(teacher, level, client);
  if (!allowed) return teacher.groups;
  return teacher.groups.filter((g) => allowed.has(g.id));
}

/** The distinct course ids of the teacher's groups, optionally level-narrowed. */
export async function scopedTeacherCourseIds(
  teacher: TeacherLike,
  level: LevelScope,
  client: typeof db = db
): Promise<string[]> {
  const groups = await scopedTeacherGroups(teacher, level, client);
  return Array.from(new Set(groups.map((g) => g.courseId)));
}

/**
 * The teacher's FULL level scope — computed from the UNFILTERED group set and
 * shipped with every teacher list payload.
 *
 * It exists so the UI can decide whether to OFFER a level separator at all: a
 * teacher whose scope contains a single level never gets an unnecessary
 * control. It is presentation metadata — it grants nothing and filters nothing.
 */
export function academicLevelScope(
  groups: Array<{ course?: { academicLevel?: string | null } | null }>
): { academicLevels: AcademicLevel[]; spansBothLevels: boolean } {
  const levels = new Set<AcademicLevel>();
  for (const g of groups) {
    const level = g.course?.academicLevel;
    if (isAcademicLevel(level)) levels.add(level);
  }
  // Canonical display order (First then Second) so the chips never reorder.
  const ordered = (["FIRST_SECONDARY", "SECOND_SECONDARY"] as AcademicLevel[]).filter((l) =>
    levels.has(l)
  );
  return { academicLevels: ordered, spansBothLevels: ordered.length > 1 };
}
