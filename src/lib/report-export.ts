// CodeMind Academy — the EXPORT FILE NAME for a report download.
//
// WHY THIS EXISTS (Manual-QA fix, final round)
// ============================================
// The Parent Monthly Report exports through the browser's print dialog
// (`window.print()` → "Save as PDF"), and both Chrome and Edge take the default
// file name from `document.title`. The page title was the app's own
// ("CodeMind Academy"), so every export landed on disk as
// `CodeMind Academy.pdf` — indistinguishable from every other report.
//
// The browser gives no other hook: the print dialog cannot be handed a file
// name programmatically. The supported approach is to set `document.title`
// around the print call and restore it afterwards, which is what the component
// does — and this module owns the NAME, so the rule lives in exactly one place
// and can be unit-tested without a DOM:
//
//   * academy name   → `brand.name`
//   * report TYPE    → "Monthly Report" / "Weekly Report" (never swapped)
//   * month + year   → derived from the REPORT PERIOD, not from "now"
//
// The month/year are resolved with the project's own localized month names
// (`Intl` through the `ar-EG` / `en-GB` locales), so the Arabic file name uses
// the same month wording as the report itself.
//
// Privacy: the name deliberately carries NO student identifier — a downloaded
// file often travels (email, shared drive, USB stick) and a student's name has
// no business being in the file name unless a requirement asks for it.
//
// Determinism: the same report period always produces the same file name.

import { brand } from "@/lib/brand";

/** Which report is being exported. Never inferred from the period. */
export type ReportExportKind = "MONTHLY" | "WEEKLY";

const REPORT_TYPE_EN: Record<ReportExportKind, string> = {
  MONTHLY: "Monthly Report",
  WEEKLY: "Weekly Report",
};

const REPORT_TYPE_AR: Record<ReportExportKind, string> = {
  MONTHLY: "تقرير شهر",
  WEEKLY: "تقرير أسبوع",
};

/**
 * Characters that are illegal in a file name on Windows/macOS/Linux
 * (`< > : " / \ | ? *`), plus control characters, collapsed to a single space.
 */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
}

/**
 * A month/year label for the GIVEN date, in the caller's locale.
 * Returns an empty string for an unusable date so the caller can degrade
 * gracefully instead of shipping "Invalid Date" into a file name.
 */
export function reportPeriodLabel(at: Date | string | number, locale: "ar" | "en" = "en"): string {
  const date = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return "";
  // `ar-EG-u-nu-latn` keeps the Arabic month NAME with Latin digits, matching
  // the product's own "سبتمبر 2026" wording (plain `ar-EG` would emit Arabic
  // -Indic digits: "سبتمبر ٢٠٢٦").*/
  const tag = locale === "ar" ? "ar-EG-u-nu-latn" : "en-GB";
  try {
    return date.toLocaleDateString(tag, { month: "long", year: "numeric" });
  } catch {
    // A minimal ICU build can lack the locale: fall back to a stable label.
    return `${date.getFullYear()}`;
  }
}

/**
 * `CodeMind Academy - Monthly Report - September 2026` (English builds)
 * `CodeMind Academy - تقرير شهر سبتمبر 2026`            (Arabic builds)
 *
 * The ext-less name is what `document.title` carries while printing; the
 * browser appends `.pdf`.
 */
export function reportExportFileName(params: {
  kind: ReportExportKind;
  /** The report PERIOD (the report's own month), never "today". */
  period: Date | string | number;
  locale?: "ar" | "en";
}): string {
  const { kind, period, locale = "en" } = params;
  const type = locale === "ar" ? REPORT_TYPE_AR[kind] : REPORT_TYPE_EN[kind];
  const label = reportPeriodLabel(period, locale);
  // Arabic reads "تقرير شهر سبتمبر 2026" as one phrase, so the type and the
  // period are joined by a space and only the academy is separated by a dash.
  const body = locale === "ar" ? [type, label].filter(Boolean).join(" ") : [type, label].filter(Boolean).join(" - ");
  return sanitizeFileName([brand.name, body].filter(Boolean).join(" - "));
}

/**
 * Resolve the report period for a report document.
 *
 * `data.reportMonth` is a DISPLAY string, so it is parsed only as a fallback;
 * the explicit `periodAt` is preferred when the payload carries one.
 */
export function reportPeriodFrom(data: {
  periodAt?: string | number | null;
  reportMonth?: string | null;
}): Date {
  if (data.periodAt) {
    const explicit = new Date(data.periodAt);
    if (!Number.isNaN(explicit.getTime())) return explicit;
  }
  const parsed = data.reportMonth ? new Date(String(data.reportMonth)) : new Date(NaN);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  // Last resort: the current period — still a month/year, never a bare title.
  return new Date();
}

/**
 * Run a print with a TEMPORARY document title, restoring it afterwards.
 *
 * `window.print()` is synchronous in Chrome/Edge/Firefox (it blocks until the
 * dialog closes), so the `finally` runs after the dialog and the app title is
 * never permanently changed. The title is captured and restored by identity, so
 * nested/failed prints cannot leave the page renamed.
 */
export function withPrintTitle(
  title: string,
  print: () => void,
  doc: Document | null | undefined = typeof document === "undefined" ? null : document
): void {
  if (!doc) {
    print();
    return;
  }
  const previous = doc.title;
  try {
    if (title) doc.title = title;
    print();
  } finally {
    doc.title = previous;
  }
}
