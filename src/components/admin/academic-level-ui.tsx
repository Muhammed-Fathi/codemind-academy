"use client";

// Phase K (manual-QA pass) — shared academic-level UI vocabulary for the
// admin views. Pure presentation: the level is ALWAYS read from the row the
// server returned (Course.academicLevel, its derived Lesson cache, or the
// typed Student.academicLevel). Nothing here decides or writes a level.
//
// ---------------------------------------------------------------------------
// Phase M1 — ONE implementation behind FOUR public names.
//
// Until M1 the same three semantics were implemented twice (a Radix `Select`
// variant and a hand-rolled chip group) and the "should this control exist at
// all?" rule lived in a third wrapper. `AcademicLevelFilter` is now the single
// implementation:
//
//   variant="select"     → the compact dropdown   (was `AcademicLevelFilterSelect`)
//   variant="segmented"  → [ الكل ][ أولى ][ ثانية ] chips (was `AcademicLevelSegmentedFilter`)
//   scope={...}          → renders NOTHING unless the caller's scope really
//                          spans both levels       (was `OptionalAcademicLevelFilter`)
//
// The historical exports are kept as thin compatibility aliases during M1
// (`academic-level-ui` is imported by ~20 call sites and its exported NAMES are
// asserted by the Phase K/L suites). ZERO visible behaviour change: the DOM
// contract — `data-academic-level-filter`, `data-academic-level-scope`,
// `aria-pressed`, `role="group"`, the aria-labels, the class strings — is
// byte-identical to the pre-M1 components.
//
// The LABEL vocabulary moved to the pure module `@/lib/academic-level-labels`
// so it can also serve the teacher/server-facing surfaces without importing a
// client component. `academicLevelLabel` / `courseWithLevelLabel` below are
// unchanged wrappers over it.
// ---------------------------------------------------------------------------

import * as React from "react";
import { useT, pickAuto } from "@/lib/i18n";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  academicLevelLabelFor,
  courseOptionLabelFor,
  isKnownAcademicLevel,
  spansBothLevels,
  type AcademicLevelLike,
  type LabelResolver,
  type LevelScopeInput,
  type LevelLabelKeyOverrides,
} from "@/lib/academic-level-labels";

/**
 * The two selectable levels, in curriculum order (enum values, never labels).
 *
 * Declared HERE, literally, because the Phase K manual-QA suite pins this exact
 * line: the admin UI is the surface where an admin picks a level, so the two
 * canonical enum values must be visible in the admin source rather than only
 * imported. `tests/phase-m-primitives.test.js` asserts this list and the shared
 * library's `ACADEMIC_LEVEL_VALUES` are the same two values in the same order.
 */
export const ACADEMIC_LEVEL_OPTIONS = ["FIRST_SECONDARY", "SECOND_SECONDARY"] as const;

/**
 * The admin vocabulary table, declared inline for the same reason (the Phase K
 * suite pins the literal `admin.643/644/645/648` references). It is handed to
 * the shared label library as an override, so the label COMPOSITION still has
 * exactly one implementation.
 */
const ADMIN_LEVEL_LABEL_KEYS: LevelLabelKeyOverrides = {
  FIRST_SECONDARY: "admin.643",
  SECOND_SECONDARY: "admin.644",
  UNSPECIFIED: "admin.645",
} as const;

/** "All Levels" chip/option label (`admin.648`). */
const ADMIN_ALL_LEVELS_LABEL_KEY = "admin.648";

/** Phase K2 — localized academic-level label (never hardcoded in JSX). */
export function academicLevelLabel(
  tr: LabelResolver,
  level: AcademicLevelLike
): string {
  return academicLevelLabelFor(tr, level, ADMIN_LEVEL_LABEL_KEYS);
}

/** One badge for a course/lesson/group level. Legacy unlevelled rows show
    "Unspecified" (muted) instead of hiding the fact. */
export function AcademicLevelBadge({
  level,
  className,
}: {
  level: AcademicLevelLike;
  className?: string;
}) {
  const tr = useT();
  const known = isKnownAcademicLevel(level);
  return (
    <Badge
      variant="outline"
      className={`text-[10px] ${known ? "border-primary/40 text-primary" : "opacity-60"} ${className || ""}`}
      title={tr("admin.642")}
      data-academic-level={level || "UNSPECIFIED"}
    >
      {academicLevelLabel(tr, level)}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// AcademicLevelFilter — the ONE control
// ---------------------------------------------------------------------------

export type AcademicLevelFilterProps = {
  /** `""` = All (the absence of a filter), or a canonical AcademicLevel value. */
  value: string;
  onChange: (v: string) => void;
  /**
   * `"segmented"` (default) = the one-click chip group
   * `[ الكل ] [ أولى ثانوي ] [ ثانية ثانوي ]`.
   * `"select"` = the compact dropdown for filter bars.
   */
  variant?: "segmented" | "select";
  /**
   * When provided, the control renders NOTHING unless the scope spans both
   * levels (the server derives `spansBothLevels` from the caller's OWN rows).
   * `undefined` = always render (the admin's platform-wide views).
   */
  scope?: LevelScopeInput;
  /** Label for the "no filter" chip/option (default `admin.648` = "All Levels"). */
  allLabelKey?: string;
  /** Accessible label of the group/trigger (default `admin.642`). */
  ariaLabelKey?: string;
  className?: string;
};

/**
 * The shared academic-level filter.
 *
 * Both variants share the SAME options, the SAME authority and the SAME
 * accessibility contract; they differ only in the visual affordance and in how
 * many pixels a filter bar may spend. Ordering a long dropdown by course is not
 * a substitute for either: the two official courses share the SAME display name,
 * so their rows are indistinguishable inside one list without an explicit
 * level switch.
 *
 * `""` means ALL — it is the absence of a filter, never a third level. The
 * narrowing itself always happens in the caller's SERVER query; this component
 * hides nothing by itself.
 */
export function AcademicLevelFilter({
  value,
  onChange,
  variant = "segmented",
  scope,
  allLabelKey = ADMIN_ALL_LEVELS_LABEL_KEY,
  ariaLabelKey = "admin.642",
  className,
}: AcademicLevelFilterProps) {
  const tr = useT();

  // Scope gate — `undefined` means "the caller owns the whole platform view and
  // always wants the control"; anything else must positively span both levels.
  if (scope !== undefined && !spansBothLevels(scope)) return null;

  const allLabel = tr(allLabelKey);
  const levelOptions: Array<{ value: string; label: string }> =
    ACADEMIC_LEVEL_OPTIONS.map((l) => ({
      value: l as string,
      label: academicLevelLabel(tr, l),
    }));

  const scopeMarker =
    scope === undefined ? undefined : { "data-academic-level-scope": "BOTH" };

  if (variant === "select") {
    return (
      <Select
        value={value || "all"}
        onValueChange={(v) => onChange(v === "all" ? "" : v)}
      >
        <SelectTrigger
          className={className || "w-44"}
          aria-label={tr(ariaLabelKey)}
          data-academic-level-filter={value || "ALL"}
          {...scopeMarker}
        >
          <SelectValue placeholder={allLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">{allLabel}</SelectItem>
          {ACADEMIC_LEVEL_OPTIONS.map((l) => (
            <SelectItem key={l} value={l}>
              {academicLevelLabel(tr, l)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const chipOptions: Array<{ value: string; label: string }> = [
    { value: "", label: allLabel },
    ...levelOptions,
  ];

  return (
    <div
      role="group"
      aria-label={tr(ariaLabelKey)}
      className={`inline-flex flex-wrap items-center gap-1 rounded-lg border bg-muted/30 p-0.5 ${className || ""}`}
      data-academic-level-filter={value || "ALL"}
      {...scopeMarker}
    >
      {chipOptions.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value || "ALL"}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(o.value)}
            className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
              active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Phase K (manual-QA pass) — the compact DROPDOWN variant, kept as a named
 * alias so the existing filter bars keep their exact markup and call sites.
 * `className` defaults to the historical `w-44`.
 */
export function AcademicLevelFilterSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  return (
    <AcademicLevelFilter
      value={value}
      onChange={onChange}
      variant="select"
      className={className}
    />
  );
}

/**
 * Phase L manual-QA fix — the COMPACT segmented level switch:
 *
 *   [ الكل ] [ أولى ثانوي ] [ ثانية ثانوي ]
 *
 * Used where a list or a selector can legitimately hold BOTH levels at once
 * (Session Videos, the teacher lesson picker and other shared teacher lists).
 * Ordering a long dropdown by course is not a substitute: the two official
 * courses share the SAME display name, so their lessons are indistinguishable
 * inside one list without an explicit level switch.
 *
 * Same authority and the same two enum values as `AcademicLevelFilterSelect`
 * (which stays the compact-dropdown variant for filter bars). `""` means ALL —
 * it is the absence of a filter, never a third level.
 *
 * The visual language is the platform's existing segmented control
 * (rounded-lg chip group with an aria-pressed toggle), so this introduces no
 * new component vocabulary.
 */
export function AcademicLevelSegmentedFilter({
  value,
  onChange,
  allLabelKey = ADMIN_ALL_LEVELS_LABEL_KEY,
  className,
  ariaLabelKey = "admin.642",
}: {
  /** "" = All, or a canonical AcademicLevel value. */
  value: string;
  onChange: (v: string) => void;
  /** Label for the "no filter" chip (admin.648 = "All Levels" by default). */
  allLabelKey?: string;
  className?: string;
  ariaLabelKey?: string;
}) {
  return (
    <AcademicLevelFilter
      value={value}
      onChange={onChange}
      variant="segmented"
      allLabelKey={allLabelKey}
      ariaLabelKey={ariaLabelKey}
      className={className}
    />
  );
}

/**
 * Phase L manual-QA fix #4 — the OPTIONAL teacher-side level separator.
 *
 * THE PRODUCT RULE THIS ENCODES
 *   A level filter is only meaningful where a teacher's scope can actually
 *   contain BOTH levels on one shared list. A teacher who owns a single level
 *   must NOT get an extra control that can never change anything, so this
 *   component renders NOTHING unless `scope` says the two levels are both
 *   present (the server derives `spansBothLevels` from the teacher's OWN
 *   groups — Teacher → Group → Course → AcademicLevel — and ships it with the
 *   list payload).
 *
 * It reuses the ONE shared segmented vocabulary (`AcademicLevelSegmentedFilter`),
 * so the teacher sees exactly the same `[ الكل ][ أولى ثانوي ][ ثانية ثانوي ]`
 * pattern as the admin.
 *
 * Presentation only: the caller passes the chosen value to its API so the
 * narrowing happens in the QUERY; this component hides nothing by itself.
 */
export function OptionalAcademicLevelFilter({
  scope,
  value,
  onChange,
  className,
}: {
  /** `{ spansBothLevels }` from the payload, or a boolean. */
  scope: { spansBothLevels?: boolean } | boolean | null | undefined;
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const spans = typeof scope === "boolean" ? scope : !!scope?.spansBothLevels;
  if (!spans) return null;
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className || ""}`} data-academic-level-scope="BOTH">
      <AcademicLevelSegmentedFilter value={value} onChange={onChange} />
    </div>
  );
}

/**
 * Course option text for group / exam selectors: "name — level".
 *
 * The NAME side stays with the platform's canonical `pickAuto` (the locale
 * aware `nameAr`/`name` field-pair picker — not a level concern); only the
 * composition of "name + level" moved into the pure label library, so the
 * separator and the level text have exactly one definition.
 */
export function courseWithLevelLabel(
  tr: LabelResolver,
  c: { nameAr?: string | null; name?: string | null; academicLevel?: AcademicLevelLike }
): string {
  return courseOptionLabelFor(
    tr,
    pickAuto(c.nameAr || "", c.name || ""),
    c.academicLevel,
    ADMIN_LEVEL_LABEL_KEYS
  );
}

