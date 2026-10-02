// CodeMind Academy — Phase M1 — the ONE pure academic-level LABEL vocabulary.
//
// WHY THIS MODULE EXISTS
//   Two academic levels are live and the two official courses share ONE display
//   name (`البرمجة والذكاء الاصطناعي`), while their curricula reuse the same
//   printed `officialCode`s (`1-1 …`). Every list, selector and heading that
//   renders a course, a group or a lesson therefore has to carry the level
//   explicitly — and before M1 that composition was written FIVE times, in five
//   slightly different shapes:
//
//     ui/academic-level-ui      `courseWithLevelLabel` → "Name — Level"   (em dash)
//     teacher/teacher-sessions  `courseLabel`         → "Level · Name"    (middle dot)
//     teacher/teacher-authoring `lessonLabel`         → "Level · code · title"
//     teacher/readiness-view    inline template       → "[Level · ]code — title"
//     admin/session-videos-view inline templates      → "Level · code — title[ · Unit n]"
//
//   This module is the single implementation of those compositions. It is
//   PURE: no React, no i18n import, no API call, no database access. The caller
//   supplies (a) a label resolver — the i18n `tr` function, or any function
//   from an i18n key to a string — and (b) already-localised display text
//   (`pickAuto(nameAr, name)`), so nothing here can depend on a locale, a
//   component tree or a request.
//
// WHAT IT IS NOT
//   * NOT an authority. `Course.academicLevel` (in the database) and
//     `src/lib/academic-level.ts` (parse/normalise/invariants) remain the only
//     authorities. This file derives NOTHING: it maps an already-canonical
//     level value to display text and composes labels.
//   * NOT a second source of level values: the key table below is typed
//     `satisfies Record<AcademicLevel, string>`, so adding a level to the enum
//     becomes a COMPILE error here until its label key is declared.
//
// M1 SCOPE — the pinned call sites listed above are NOT rewritten in M1: their
// exact rendered strings are pinned by the Phase K/L source tests
// (tests/academic-level-phaseK-manualqa.test.js,
//  tests/teacher-academic-level-phaseL.test.js,
//  tests/session-videos-level-filter-phaseL.test.js).
// `tests/phase-m-primitives.test.js` instead proves this module reproduces each
// of those templates BYTE-FOR-BYTE, so M2 can migrate the call sites with zero
// rendered-output change.

import type { AcademicLevel } from "@/lib/academic-level";

/** Anything a level field can be at runtime (canonical value, legacy null, junk). */
export type AcademicLevelLike = string | null | undefined;

/** i18n key → display string (the client's `tr` / `useT()` function). */
export type LabelResolver = (key: string) => string;

/** `{ spansBothLevels }` from a scoped payload (teacher lists), or a boolean. */
export type LevelScopeInput =
  | { spansBothLevels?: boolean }
  | boolean
  | null
  | undefined;

// ---------------------------------------------------------------------------
// Separators — the platform's ONE typographic vocabulary for level labels.
// ---------------------------------------------------------------------------

/** Middle dot used inside a label (`Level · Name`, `Level · code · title`). */
export const LEVEL_LABEL_SEPARATOR = " · ";

/** Em dash between a course/lesson name and its level (`Name — Level`). */
export const LEVEL_SUFFIX_SEPARATOR = " — ";

// ---------------------------------------------------------------------------
// Label keys (localised in src/lib/i18n-dict-2026.ts)
// ---------------------------------------------------------------------------

/**
 * The canonical i18n key per level. `satisfies` makes a NEW enum value a
 * compile error until it has a key here — the same fail-closed discipline the
 * authority module uses.
 */
export const ACADEMIC_LEVEL_LABEL_KEYS = {
  FIRST_SECONDARY: "admin.643",
  SECOND_SECONDARY: "admin.644",
} as const satisfies Record<AcademicLevel, string>;

/** Shown for a legacy row whose level is NULL — never hidden, never guessed. */
export const ACADEMIC_LEVEL_UNSPECIFIED_LABEL_KEY = "admin.645";

/** The two canonical values (display order), typed as the enum union. */
export const ACADEMIC_LEVEL_VALUES = [
  "FIRST_SECONDARY",
  "SECOND_SECONDARY",
] as const;

/** True only for the two canonical enum values. */
export function isKnownAcademicLevel(
  level: AcademicLevelLike
): level is AcademicLevel {
  return level === "FIRST_SECONDARY" || level === "SECOND_SECONDARY";
}

/**
 * Per-surface overrides for the label keys. This exists because the ADMIN UI
 * component (`src/components/admin/academic-level-ui.tsx`) declares the admin
 * vocabulary inline — a Phase K manual-QA pin asserts that file literally
 * references `admin.643`, `admin.644`, `admin.645` and `admin.648`, so that a
 * future dictionary rename cannot silently detach the admin UI from its own
 * keys. The UI passes its table in; the composition itself stays here, so
 * there is still exactly ONE label implementation.
 */
export type LevelLabelKeyOverrides = Partial<
  Record<AcademicLevel | "UNSPECIFIED", string>
>;

/** The i18n key for any level value (canonical or unknown → `admin.645`). */
export function academicLevelLabelKey(
  level: AcademicLevelLike,
  overrides?: LevelLabelKeyOverrides
): string {
  if (isKnownAcademicLevel(level)) {
    return overrides?.[level] || ACADEMIC_LEVEL_LABEL_KEYS[level];
  }
  return overrides?.UNSPECIFIED || ACADEMIC_LEVEL_UNSPECIFIED_LABEL_KEY;
}

// ---------------------------------------------------------------------------
// Level labels
// ---------------------------------------------------------------------------

/**
 * The level's display text — ALWAYS a string, never empty:
 * `أولى ثانوي` / `ثانية ثانوي` / `غير محدد` for an unknown or legacy value.
 * This is the only place the "unknown" fallback is decided.
 */
export function academicLevelLabelFor(
  resolve: LabelResolver,
  level: AcademicLevelLike,
  overrides?: LevelLabelKeyOverrides
): string {
  return resolve(academicLevelLabelKey(level, overrides));
}

/**
 * `"أولى ثانوي · "` when the level is known, `""` when it is not — for the
 * surfaces that prefix a label only if there is something truthful to prefix
 * (the readiness picker and the live-session lesson options).
 */
export function academicLevelPrefixFor(
  resolve: LabelResolver,
  level: AcademicLevelLike
): string {
  return isKnownAcademicLevel(level)
    ? `${academicLevelLabelFor(resolve, level)}${LEVEL_LABEL_SEPARATOR}`
    : "";
}

// ---------------------------------------------------------------------------
// Course / group labels
// ---------------------------------------------------------------------------

/**
 * `"Name — Level"` — the canonical OPTION text for a course/group selector.
 * The name arrives already localised (`pickAuto(nameAr, name)`); the level
 * always follows, so two identically-named official courses stay
 * distinguishable inside one dropdown.
 */
export function courseOptionLabelFor(
  resolve: LabelResolver,
  name: string,
  level: AcademicLevelLike,
  overrides?: LevelLabelKeyOverrides
): string {
  return `${name}${LEVEL_SUFFIX_SEPARATOR}${academicLevelLabelFor(resolve, level, overrides)}`;
}

/**
 * `"Level · Name"` — the canonical HEADING/row text (course sections, group
 * options). The level is omitted entirely for a legacy row with no level: a
 * heading must never invent or pad a fact it does not have.
 */
export function levelFirstLabelFor(
  resolve: LabelResolver,
  name: string,
  level: AcademicLevelLike
): string {
  return isKnownAcademicLevel(level)
    ? `${academicLevelLabelFor(resolve, level)}${LEVEL_LABEL_SEPARATOR}${name}`
    : name;
}

// ---------------------------------------------------------------------------
// Lesson labels
// ---------------------------------------------------------------------------

/** The lesson facts a label may carry. Every field is display text already. */
export type LessonLabelSource = {
  /** Canonical level of the lesson's course (`Course.academicLevel`). */
  academicLevel?: AcademicLevelLike;
  /** Printed curriculum code (`1-1`, `7-3`) — NOT unique across levels. */
  officialCode?: string | null;
  /** Already-localised lesson title (`pickAuto(titleAr, title)`). */
  title?: string | null;
  /** Already-localised unit caption (`الوحدة 1` / `Unit 1`), optional. */
  unitLabel?: string | null;
};

export type LessonLabelOptions = {
  /** Separator between the official code and the title. Default `" · "`. */
  codeSeparator?: string;
  /**
   * `true` (default) always prefixes the level — including `غير محدد` for a
   * level-less lesson, which the authoring picker needs so no row is ambiguous.
   * `false` omits the prefix when the level is unknown (readiness / session
   * videos), matching their existing templates.
   */
  levelWhenUnknown?: boolean;
  /**
   * Omit the level entirely. The authoring `lessonLabel(lesson, tr?)` returns
   * the bare `code · title` when no translator is available, so a `null`
   * resolver means "no i18n context — no level".
   */
  omitLevel?: boolean;
};

/**
 * `"Level · code · title"` (defaults) — the canonical LESSON label.
 *
 * The level leads because the same printed `officialCode` exists at both levels
 * (18 shared codes) and the two courses share one name: a label without the
 * level can resolve to the wrong curriculum, and the id — not the code — is the
 * only real identity.
 */
export function lessonLabelFor(
  resolve: LabelResolver | null,
  lesson: LessonLabelSource | null | undefined,
  options: LessonLabelOptions = {}
): string {
  if (!lesson) return "";
  const {
    codeSeparator = LEVEL_LABEL_SEPARATOR,
    levelWhenUnknown = true,
    omitLevel = false,
  } = options;

  const title = lesson.title ?? "";
  const base = lesson.officialCode
    ? `${lesson.officialCode}${codeSeparator}${title}`
    : title;
  const withUnit = lesson.unitLabel
    ? `${base}${LEVEL_LABEL_SEPARATOR}${lesson.unitLabel}`
    : base;

  if (omitLevel || !resolve) return withUnit;
  const prefix = levelWhenUnknown
    ? `${academicLevelLabelFor(resolve, lesson.academicLevel)}${LEVEL_LABEL_SEPARATOR}`
    : academicLevelPrefixFor(resolve, lesson.academicLevel);
  return `${prefix}${withUnit}`;
}

// ---------------------------------------------------------------------------
// Scope predicate — the ONE "do both levels exist here?" rule
// ---------------------------------------------------------------------------

/**
 * Should a level separator be OFFERED at all?
 *
 * A control is only meaningful where one shared list can actually contain both
 * levels; a teacher (or list) whose scope holds a single level must never get a
 * control that cannot change anything. The server derives
 * `academicLevelScope(...).spansBothLevels` from the caller's OWN groups and
 * ships it with the payload; this predicate reads it, and accepts a bare
 * boolean for callers that already resolved it.
 *
 * Fail-closed: `null` / `undefined` / `{}` ⇒ `false` ⇒ no control.
 *
 * `OptionalAcademicLevelFilter` in the level UI keeps this expression INLINE
 * (it is pinned verbatim by tests/teacher-academic-level-phaseL.test.js); this
 * function is the canonical form the new `AcademicLevelFilter` uses, and
 * `tests/phase-m-primitives.test.js` proves the two agree on every input shape.
 */
export function spansBothLevels(scope: LevelScopeInput): boolean {
  return typeof scope === "boolean" ? scope : !!scope?.spansBothLevels;
}
