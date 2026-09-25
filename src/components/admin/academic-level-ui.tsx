"use client";

// Phase K (manual-QA pass) — shared academic-level UI vocabulary for the
// admin views. Pure presentation: the level is ALWAYS read from the row the
// server returned (Course.academicLevel, its derived Lesson cache, or the
// typed Student.academicLevel). Nothing here decides or writes a level.

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

/** The two selectable levels, in curriculum order (enum values, never labels). */
export const ACADEMIC_LEVEL_OPTIONS = ["FIRST_SECONDARY", "SECOND_SECONDARY"] as const;

/** Phase K2 — localized academic-level label (never hardcoded in JSX). */
export function academicLevelLabel(
  tr: (k: string) => string,
  level: string | null | undefined
): string {
  if (level === "FIRST_SECONDARY") return tr("admin.643");
  if (level === "SECOND_SECONDARY") return tr("admin.644");
  return tr("admin.645");
}

/** One badge for a course/lesson/group level. Legacy unlevelled rows show
    "Unspecified" (muted) instead of hiding the fact. */
export function AcademicLevelBadge({
  level,
  className,
}: {
  level: string | null | undefined;
  className?: string;
}) {
  const tr = useT();
  const known = level === "FIRST_SECONDARY" || level === "SECOND_SECONDARY";
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

/** Level filter: "" = all levels. A VIEW filter that composes with the other
    list filters; the lists themselves are filtered server-side. */
export function AcademicLevelFilterSelect({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  className?: string;
}) {
  const tr = useT();
  return (
    <Select value={value || "all"} onValueChange={(v) => onChange(v === "all" ? "" : v)}>
      <SelectTrigger className={className || "w-44"} aria-label={tr("admin.642")}>
        <SelectValue placeholder={tr("admin.648")} />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">{tr("admin.648")}</SelectItem>
        {ACADEMIC_LEVEL_OPTIONS.map((l) => (
          <SelectItem key={l} value={l}>
            {academicLevelLabel(tr, l)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Course option text for group / exam selectors: "name — level". */
export function courseWithLevelLabel(
  tr: (k: string) => string,
  c: { nameAr?: string | null; name?: string | null; academicLevel?: string | null }
): string {
  return `${pickAuto(c.nameAr || "", c.name || "")} — ${academicLevelLabel(tr, c.academicLevel)}`;
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
  allLabelKey = "admin.648",
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
  const tr = useT();
  const options: Array<{ value: string; label: string }> = [
    { value: "", label: tr(allLabelKey) },
    ...ACADEMIC_LEVEL_OPTIONS.map((l) => ({ value: l as string, label: academicLevelLabel(tr, l) })),
  ];
  return (
    <div
      role="group"
      aria-label={tr(ariaLabelKey)}
      className={`inline-flex flex-wrap items-center gap-1 rounded-lg border bg-muted/30 p-0.5 ${className || ""}`}
      data-academic-level-filter={value || "ALL"}
    >
      {options.map((o) => {
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
