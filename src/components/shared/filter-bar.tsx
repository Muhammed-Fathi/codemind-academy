"use client";

// CodeMind Academy — Phase M1 — the shared FILTER BAR (layout only).
//
// WHY
//   Every list view builds its own row of filter controls, and the rows have
//   drifted in three ways that matter on a phone-first, RTL-first product:
//     * wrapping: some rows wrap, others squeeze and clip their last control;
//     * labels: some controls carry a visible label, others only an
//       `aria-label`, so a screen reader sees an unlabelled combobox;
//     * direction: a few rows used physical utilities (`mr-`, `text-right`)
//       which put the spacing on the wrong side once the RTL layout loads.
//
// WHAT THIS IS
//   Pure composition: a responsive row (`FilterBar`) and a labelled control
//   cell (`FilterField`). It renders `children` — it does not know about
//   academic levels, tracks, search boxes or any other specific filter, and it
//   does not fetch or filter anything. The caller keeps its own state and its
//   own server query.
//
// WHAT THIS IS NOT
//   M1 does NOT move any existing filter across pages, does NOT restyle the
//   existing rows, and does NOT replace `AcademicLevelFilter*` (which keeps its
//   own pinned DOM contract). Adopters compose the two: a filter bar can hold
//   an `<AcademicLevelFilter variant="select" />` like any other child.
//
// RTL: logical utilities only (`ms-`/`me-`/`text-start`), matching the rest of
// the app; nothing here is position-dependent, so the same markup is correct in
// `dir="rtl"` and `dir="ltr"`.

import * as React from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

export type FilterBarProps = {
  /** The filter controls, in reading order. */
  children: React.ReactNode;
  /**
   * Trailing slot for non-filter actions (e.g. "Export", a count caption).
   * Kept as a separate prop so callers do not have to fake an ordering.
   */
  actions?: React.ReactNode;
  className?: string;
  /** Extra classes for the inner wrapping row. */
  rowClassName?: string;
};

/**
 * A wrapping, RTL-safe row of filter controls.
 *
 * Widths: the row never forces a horizontal scroll. Children that can shrink
 * (`min-w-0`) shrink first; a child that must keep its width wraps onto its own
 * line instead of clipping — the behaviour the platform's filter rows already
 * assume but do not all implement.
 */
export function FilterBar({
  children,
  actions,
  className,
  rowClassName,
}: FilterBarProps) {
  return (
    <div
      className={cn("w-full", className)}
      data-filter-bar=""
    >
      <div
        className={cn(
          "flex flex-wrap items-end gap-2 sm:gap-3",
          rowClassName
        )}
      >
        {children}
        {actions ? (
          <div className="flex flex-wrap items-center gap-2 ms-auto">
            {actions}
          </div>
        ) : null}
      </div>
    </div>
  );
}

export type FilterFieldProps = {
  /** Control(s) for one filter. */
  children: React.ReactNode;
  /** Visible label text (already localised). */
  label?: React.ReactNode;
  /** i18n key for the label; ignored when `label` is given. */
  labelKey?: string;
  /**
   * Accessible name when the label is NOT rendered visibly (`hideLabel`).
   * Mirrors the `aria-label` the existing controls take.
   */
  ariaLabel?: string;
  ariaLabelKey?: string;
  /** `id` of the control, so the visible label is a real `<label for>`. */
  htmlFor?: string;
  /**
   * Render the label for assistive tech only. Use when the control's own
   * placeholder/summary already names the filter visually.
   */
  hideLabel?: boolean;
  /** Helper text under the control. */
  hint?: React.ReactNode;
  hintKey?: string;
  className?: string;
  controlClassName?: string;
};

/**
 * One labelled filter cell: an optional `<label>`, the control, an optional
 * hint. The label wiring (`htmlFor` / `aria-label`) is the caller's, so this
 * stays compatible with the Radix `Select` triggers and the segmented chip
 * groups already in use (both accept `aria-label`).
 */
export function FilterField({
  children,
  label,
  labelKey,
  ariaLabel,
  ariaLabelKey,
  htmlFor,
  hideLabel = false,
  hint,
  hintKey,
  className,
  controlClassName,
}: FilterFieldProps) {
  const tr = useT();
  const text =
    label !== undefined && label !== null && label !== ""
      ? label
      : labelKey
        ? tr(labelKey)
        : null;
  const aria =
    ariaLabel !== undefined && ariaLabel !== ""
      ? ariaLabel
      : ariaLabelKey
        ? tr(ariaLabelKey)
        : typeof text === "string"
          ? text
          : undefined;
  const hintText =
    hint !== undefined && hint !== null && hint !== ""
      ? hint
      : hintKey
        ? tr(hintKey)
        : null;

  // A control that cannot be reached by `<label for>` (no `htmlFor`, label
  // visually hidden) still needs its accessible name. Injecting it onto the
  // control is the only way to do that from the outside, and it is done only
  // when the caller has not already named the control itself.
  const labelledChild =
    hideLabel &&
    !htmlFor &&
    aria &&
    React.isValidElement(children) &&
    !(children.props as { "aria-label"?: string; "aria-labelledby"?: string })[
      "aria-label"
    ] &&
    !(children.props as { "aria-labelledby"?: string })["aria-labelledby"]
      ? React.cloneElement(children as React.ReactElement<{ "aria-label"?: string }>, {
          "aria-label": aria,
        })
      : children;

  return (
    <div
      className={cn("flex min-w-0 flex-col gap-1", className)}
      data-filter-field=""
    >
      {text ? (
        <label
          htmlFor={htmlFor}
          className={cn(
            "text-xs font-medium text-muted-foreground text-start",
            hideLabel && "sr-only"
          )}
        >
          {text}
        </label>
      ) : null}
      <div className={cn("min-w-0", controlClassName)}>{labelledChild}</div>
      {hintText ? (
        <p className="text-[11px] text-muted-foreground text-start">{hintText}</p>
      ) : null}
    </div>
  );
}
