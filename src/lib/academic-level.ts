// CodeMind Academy — Academic level (First / Second Secondary) helpers.
//
// PHASE K2 — the APPLICATION AUTHORITY for `AcademicLevel`
// (docs/MULTI_LEVEL_FINAL_CONTRACT.md §2). This module mirrors
// `src/lib/school-type.ts`: it centralises parsing, labels and the runtime
// invariants, and it introduces NO second source of truth.
//
//   * Course.academicLevel  — curriculum authority of a course.
//   * Student.academicLevel — the student's typed declared level.
//   * Active assignment     — Student.groupId → Group.courseId →
//                             Course.academicLevel (no Group.academicLevel).
//   * Lesson.academicLevel  — DERIVED cache of the owning course's level via
//                             Unit→Part→Course or Topic→Unit→Part→Course.
//   * Student.grade         — DISPLAY MIRROR ONLY, derived from the level by
//                             `gradeLabelFor`. Never an authority.
//
// Levels and tracks (`SchoolType` / `trackScope`) are ORTHOGONAL gates: a
// write path must pass BOTH; neither is inferred from the other.
//
// K1 left every column nullable and backfilled the whole platform to
// SECOND_SECONDARY; K3 tightens the database. Until then the helpers below
// treat NULL as "unknown" and FAIL CLOSED wherever a decision depends on it.

import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeSchoolType, type SchoolType } from "@/lib/school-type";

export type AcademicLevel = "FIRST_SECONDARY" | "SECOND_SECONDARY";

export const ACADEMIC_LEVELS: readonly AcademicLevel[] = [
  "FIRST_SECONDARY",
  "SECOND_SECONDARY",
] as const;

/** Normalise any stored/incoming value to a canonical AcademicLevel, or null. */
export function normalizeAcademicLevel(value: unknown): AcademicLevel | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (v === "FIRST_SECONDARY") return "FIRST_SECONDARY";
  if (v === "SECOND_SECONDARY") return "SECOND_SECONDARY";
  return null;
}

export function isAcademicLevel(value: unknown): value is AcademicLevel {
  return normalizeAcademicLevel(value) !== null;
}

/**
 * Strict, REQUIRED parse for every WRITE path (registration, admin create /
 * update, course create). Same contract as `requireSchoolType`: a missing or
 * unrecognised value is a distinct failure the caller MUST reject — never a
 * default, because a guessed level silently changes which curriculum a
 * student is bound to.
 */
export function requireAcademicLevel(
  value: unknown
): { ok: true; value: AcademicLevel } | { ok: false; reason: "EMPTY" | "INVALID" } {
  if (value === null || value === undefined) return { ok: false, reason: "EMPTY" };
  if (typeof value === "string" && value.trim() === "") return { ok: false, reason: "EMPTY" };
  const normalized = normalizeAcademicLevel(value);
  if (!normalized) return { ok: false, reason: "INVALID" };
  return { ok: true, value: normalized };
}

/** Localised label pair for UI (never hardcode these in components). */
export const ACADEMIC_LEVEL_LABELS: Record<AcademicLevel, { ar: string; en: string }> = {
  FIRST_SECONDARY: { ar: "الصف الأول الثانوي", en: "First Secondary" },
  SECOND_SECONDARY: { ar: "الصف الثاني الثانوي", en: "Second Secondary" },
};

/**
 * The `Student.grade` DISPLAY MIRROR per level. `"2nd Secondary"` is
 * byte-identical to the historical hard-coded value, so no existing row
 * needs rewriting. `grade` is written ONLY through this map from K2 on; it
 * is never parsed back into a level.
 */
export const GRADE_LABEL_BY_LEVEL: Record<AcademicLevel, string> = {
  FIRST_SECONDARY: "1st Secondary",
  SECOND_SECONDARY: "2nd Secondary",
};

export function gradeLabelFor(level: AcademicLevel): string {
  return GRADE_LABEL_BY_LEVEL[level];
}

// ---------------------------------------------------------------------------
// I1 — enrollment invariant: Student.academicLevel === Group.course.academicLevel
// ---------------------------------------------------------------------------

/**
 * THE group-level predicate: may a student of `studentLevel` be assigned to
 * a group whose course is `courseLevel`? EXACT equality, fail-closed on
 * BOTH sides (an unknown student level or an unlevelled course matches
 * nothing). It never mutates anything and never infers a level from a
 * track, a grade string or a course name.
 */
export function groupLevelEligible(studentLevel: unknown, courseLevel: unknown): boolean {
  const s = normalizeAcademicLevel(studentLevel);
  const c = normalizeAcademicLevel(courseLevel);
  if (!s || !c) return false;
  return s === c;
}

/** Stable application error every assignment-producing path raises for I1. */
export const LEVEL_MISMATCH_CODE = "ACADEMIC_LEVEL_MISMATCH" as const;

// ---------------------------------------------------------------------------
// I2 — lesson invariant: Lesson.academicLevel === chain-derived Course level
// ---------------------------------------------------------------------------

type LessonChainClient = {
  unit: { findUnique: (args: any) => Promise<any> };
  topic: { findUnique: (args: any) => Promise<any> };
};

/**
 * Derive a lesson's level from its parent chain — the ONLY producer of
 * `Lesson.academicLevel`. Canonical `unitId` wins; the legacy `topicId`
 * chain is used only when there is no unit. Returns `null` for an orphan or
 * an unlevelled course (callers must not guess).
 */
export async function deriveLessonLevel(
  link: { unitId: string | null | undefined; topicId: string | null | undefined },
  client: LessonChainClient = db as unknown as LessonChainClient
): Promise<AcademicLevel | null> {
  if (link.unitId) {
    const unit = await client.unit.findUnique({
      where: { id: link.unitId },
      select: { part: { select: { course: { select: { academicLevel: true } } } } },
    });
    return normalizeAcademicLevel(unit?.part?.course?.academicLevel);
  }
  if (link.topicId) {
    const topic = await client.topic.findUnique({
      where: { id: link.topicId },
      select: {
        unit: { select: { part: { select: { course: { select: { academicLevel: true } } } } } },
      },
    });
    return normalizeAcademicLevel(topic?.unit?.part?.course?.academicLevel);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Registration offerings — the ONLY advertised Level × Track combinations
// ---------------------------------------------------------------------------

export type RegistrationOffering = {
  academicLevel: AcademicLevel;
  tracks: SchoolType[];
};

type OfferingGroupRow = {
  trackScope: unknown;
  course: { academicLevel: unknown } | null;
};

/**
 * Pure reducer: a (level, track) pair is OFFERED iff at least one ACTIVE,
 * CLASSIFIED (`trackScope` ∈ ARABIC|LANGUAGE) group exists on a course of
 * that level. This is exactly the population the student group picker can
 * serve, so registration and enrollment can never disagree. Tracks are
 * never advertised independently of a level, and a level with zero
 * classified groups is not advertised at all.
 */
export function computeRegistrationOfferings(rows: readonly OfferingGroupRow[]): RegistrationOffering[] {
  const byLevel = new Map<AcademicLevel, Set<SchoolType>>();
  for (const row of rows) {
    const level = normalizeAcademicLevel(row.course?.academicLevel);
    const track = normalizeSchoolType(row.trackScope);
    if (!level || !track) continue;
    let set = byLevel.get(level);
    if (!set) {
      set = new Set<SchoolType>();
      byLevel.set(level, set);
    }
    set.add(track);
  }
  const out: RegistrationOffering[] = [];
  for (const level of ACADEMIC_LEVELS) {
    const set = byLevel.get(level);
    if (!set || set.size === 0) continue;
    out.push({
      academicLevel: level,
      tracks: (["ARABIC", "LANGUAGE"] as const).filter((t) => set.has(t)),
    });
  }
  return out;
}

export function isOfferedPair(
  offerings: readonly RegistrationOffering[],
  academicLevel: AcademicLevel,
  schoolType: SchoolType
): boolean {
  const o = offerings.find((x) => x.academicLevel === academicLevel);
  return !!o && o.tracks.includes(schoolType);
}

/** Server-side source of truth used by GET /api/registration/options AND the registration POST. */
export async function loadRegistrationOfferings(): Promise<RegistrationOffering[]> {
  const rows = await db.group.findMany({
    where: { isActive: true, trackScope: { in: ["ARABIC", "LANGUAGE"] } },
    select: { trackScope: true, course: { select: { academicLevel: true } } },
  });
  return computeRegistrationOfferings(rows as OfferingGroupRow[]);
}

// ---------------------------------------------------------------------------
// Diagnostics — one shared audit (K2 admin endpoint, K3 gate, Phase N checksum)
// ---------------------------------------------------------------------------

export type LevelIntegrityReport = {
  /** Students assigned to a group whose course level differs (I1 violators). */
  studentGroupMismatches: { studentId: string; studentLevel: string | null; groupId: string; courseLevel: string | null }[];
  /** Lessons whose stored level differs from the chain-derived level (I2 violators). */
  lessonMismatches: { lessonId: string; storedLevel: string | null; derivedLevel: string | null }[];
  nullCounts: { courses: number; students: number; lessons: number; orphanLessons: number };
};

export async function auditLevelIntegrity(client: any = db): Promise<LevelIntegrityReport> {
  const groupedStudents = await client.student.findMany({
    where: { groupId: { not: null } },
    select: {
      id: true,
      academicLevel: true,
      groupId: true,
      group: { select: { course: { select: { academicLevel: true } } } },
    },
  });
  const studentGroupMismatches: LevelIntegrityReport["studentGroupMismatches"] = [];
  for (const s of groupedStudents as any[]) {
    const courseLevel = s.group?.course?.academicLevel ?? null;
    if (!groupLevelEligible(s.academicLevel, courseLevel)) {
      studentGroupMismatches.push({
        studentId: s.id,
        studentLevel: s.academicLevel ?? null,
        groupId: s.groupId,
        courseLevel,
      });
    }
  }

  const lessons = await client.lesson.findMany({
    select: {
      id: true,
      academicLevel: true,
      unit: { select: { part: { select: { course: { select: { academicLevel: true } } } } } },
      topic: {
        select: {
          unit: { select: { part: { select: { course: { select: { academicLevel: true } } } } } },
        },
      },
    },
  });
  const lessonMismatches: LevelIntegrityReport["lessonMismatches"] = [];
  let orphanLessons = 0;
  let nullLessons = 0;
  for (const l of lessons as any[]) {
    const derived = normalizeAcademicLevel(
      l.unit?.part?.course?.academicLevel ?? l.topic?.unit?.part?.course?.academicLevel ?? null
    );
    if (!l.unit && !l.topic) orphanLessons++;
    if (!l.academicLevel) nullLessons++;
    if ((l.academicLevel ?? null) !== derived) {
      lessonMismatches.push({ lessonId: l.id, storedLevel: l.academicLevel ?? null, derivedLevel: derived });
    }
  }

  const [courses, students] = await Promise.all([
    client.course.count({ where: { academicLevel: null } }),
    client.student.count({ where: { academicLevel: null } }),
  ]);

  return {
    studentGroupMismatches,
    lessonMismatches,
    nullCounts: { courses, students, lessons: nullLessons, orphanLessons },
  };
}

/** Prisma filter selecting groups a student of `level` may join (I1 half of the picker predicate). */
export function groupsOfLevelWhere(level: AcademicLevel): Prisma.GroupWhereInput {
  return { course: { academicLevel: level } };
}
