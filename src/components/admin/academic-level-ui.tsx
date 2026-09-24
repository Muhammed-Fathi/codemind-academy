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
