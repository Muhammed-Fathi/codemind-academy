"use client";

// CodeMind Academy — Phase M1 — the shared STATUS BADGE.
//
// WHY
//   The same four status colours are written out by hand in many views, e.g.
//     <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">Approved</Badge>
//   repeated for approved/active/published, and the amber/red twins for
//   pending/rejected. Copy-paste has already produced variants that forget the
//   dark-mode text colour or use `rose-` where the rest use `red-`.
//
// WHAT THIS IS
//   One `<StatusBadge tone=…>` that renders the EXISTING token classes (the
//   amber/emerald/red/primary pairs already used across the admin and teacher
//   surfaces) through the existing `Badge` component. No new colour tokens are
//   introduced, and the tone table is exported so a view can build its own
//   status→tone map without re-spelling class strings.
//
// WHAT THIS IS NOT (M1)
//   M1 does NOT mass-replace the existing badges; the local `statusBadge` /
//   `StatusBadge` helpers stay where they are, and nothing imports this file
//   yet. Adoption (and the deletion of the local copies) is M2+ work, one view
//   at a time, behind that view's existing DOM contract.
//
// RTL: nothing positional; the badge is inline-flex and inherits direction.

import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Semantic tones, mapped to the platform's existing colour vocabulary.
 * `neutral` is the outline badge; `muted` is the de-emphasised variant used for
 * "unspecified"/legacy rows.
 */
export type StatusTone =
  | "neutral"
  | "muted"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "level";

/** The exact class strings the platform already uses for these states. */
export const STATUS_TONE_CLASSES: Record<StatusTone, string> = {
  neutral: "",
  muted: "opacity-60",
  success:
    "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30",
  warning:
    "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30",
  danger: "bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30",
  info: "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30",
  level: "border-primary/40 text-primary",
};

export type StatusBadgeProps = {
  tone?: StatusTone;
  children: React.ReactNode;
  /** Optional leading icon (rendered by `Badge`'s own `[&>svg]` rules). */
  icon?: React.ReactNode;
  /** Extra classes; merged AFTER the tone so a caller can still override. */
  className?: string;
  title?: string;
  /** Tooltip/label override for tests and screen readers. */
  "aria-label"?: string;
};

/**
 * One status pill. `neutral` deliberately resolves to the plain outline badge
 * (no colour) because a status that has no colour in the platform today must
 * not acquire one just by being migrated.
 */
export function StatusBadge({
  tone = "neutral",
  children,
  icon,
  className,
  title,
  "aria-label": ariaLabel,
}: StatusBadgeProps) {
  return (
    <Badge
      variant="outline"
      title={title}
      aria-label={ariaLabel}
      data-status-tone={tone}
      className={cn(STATUS_TONE_CLASSES[tone], className)}
    >
      {icon}
      {children}
    </Badge>
  );
}

/**
 * Look up a tone from a caller-supplied map, so views with their own status
 * vocabularies (payment states, lesson workflow states, …) keep ownership of
 * the mapping while sharing the rendering. Unknown statuses fall back to
 * `neutral` — the tone never guesses.
 */
export function statusToneOf(
  status: string | null | undefined,
  map: Readonly<Record<string, StatusTone>>,
  fallback: StatusTone = "neutral"
): StatusTone {
  if (!status) return fallback;
  return map[status] || fallback;
}
