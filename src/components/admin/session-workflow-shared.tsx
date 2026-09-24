"use client";

// ============================================================
// CodeMind Academy — Admin publishing workflow: shared pieces
//
// Badges, the server-readiness checklist, the workflow stepper and the
// confirm dialog used by the session list + detail screens.
//
// TWO RULES GOVERN THIS FILE
//   1. Readiness is RENDERED, never computed: every readiness value on
//      screen comes from the `readiness` object the server returned. There
//      is no local evaluation of video/quiz/homework presence here —
//      importing the lifecycle computation into a component is the defect
//      this file exists to prevent.
//   2. No hardcoded UI strings: every user-facing string goes through
//      `tr("admin.3xx")`, and layout uses logical properties so Arabic
//      (RTL) and English (LTR) render correctly.
// ============================================================

import * as React from "react";
import { motion } from "framer-motion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useT } from "@/lib/i18n";
import { formatUploadBytes } from "@/lib/upload-progress";
import {
  CheckCircle2,
  XCircle,
  MinusCircle,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import type {
  AdminSessionDetail,
  AdminSessionHomeworkSummary,
  AdminSessionListItem as BaseAdminSessionListItem,
  AdminSessionListResponse as BaseAdminSessionListResponse,
  AdminSessionMaterialSummary,
  AdminSessionQuizSummary,
  AdminSessionVideoSummary,
  CurriculumStatus,
  LessonStatus,
  TrackScope,
} from "@/lib/admin-sessions";
import type { LessonReadinessSnapshot } from "@/lib/session-lifecycle";

/** Phase K — read-only level CONTEXT the list endpoint adds to each row:
    the derived Lesson.academicLevel and its course's canonical level. Kept
    out of the input contract in `@/lib/admin-sessions` (level is never an
    admin lesson input). */
export type AdminSessionLevelContext = {
  academicLevel?: string | null;
  identity: BaseAdminSessionListItem["identity"] & {
    course: (NonNullable<BaseAdminSessionListItem["identity"]["course"]> & {
      academicLevel?: string | null;
    }) | null;
  };
};
export type AdminSessionListItem = Omit<BaseAdminSessionListItem, "identity"> & AdminSessionLevelContext;
export type AdminSessionListResponse = Omit<BaseAdminSessionListResponse, "lessons"> & {
  lessons: AdminSessionListItem[];
};

export type {
  AdminSessionDetail,
  AdminSessionHomeworkSummary,
  AdminSessionMaterialSummary,
  AdminSessionQuizSummary,
  AdminSessionVideoSummary,
};
export type { CurriculumStatus, LessonStatus, TrackScope };
export type { LessonReadinessSnapshot };

// ---------------------------------------------------------------------------
// Fetch helper: one error shape for the whole workflow
// ---------------------------------------------------------------------------

export type FetchResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; error: string; code: string | null; data: any };

export async function fetchJson<T>(url: string, init?: RequestInit): Promise<FetchResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    return { ok: false, status: 0, error: "admin.001", code: "NETWORK_ERROR", data: null };
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const message =
      (data && typeof data.error === "string" && data.error) || "admin.001";
    const code =
      (data && typeof data.code === "string" && data.code) ||
      (typeof message === "string" && /^[A-Z][A-Z0-9_]*(:[a-zA-Z]+)?$/.test(message)
        ? message
        : null);
    return { ok: false, status: res.status, error: message, code, data };
  }
  return { ok: true, status: res.status, data: data as T };
}

/** Human text for a server error: machine codes stay machine-readable. */
export function serverErrorText(tr: (k: string) => string, error: string): string {
  if (error === "admin.001") return tr("admin.001");
  // Machine codes (FORBIDDEN_FIELD:title, LESSON_ARCHIVED, …) are shown
  // verbatim — translating them would hide the contract from the operator.
  return error;
}

// ---------------------------------------------------------------------------
// Badges: status / track scope / curriculum standing
// ---------------------------------------------------------------------------

export function StatusBadge({ status }: { status: LessonStatus | string }) {
  const tr = useT();
  const s = String(status || "").toUpperCase();
  const label =
    s === "PUBLISHED" ? tr("admin.345") : s === "READY" ? tr("admin.344") : tr("admin.343");
  const cls =
    s === "PUBLISHED"
      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
      : s === "READY"
        ? "bg-sky-500/15 text-sky-700 dark:text-sky-300 border-sky-500/30"
        : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30";
  return (
    <Badge variant="outline" className={cls}>
      {label}
    </Badge>
  );
}

export function TrackScopeBadge({ scope }: { scope: TrackScope | string }) {
  const tr = useT();
  const s = String(scope || "").toUpperCase();
  const label =
    s === "ARABIC" ? tr("admin.350") : s === "LANGUAGE" ? tr("admin.351") : tr("admin.349");
  const cls =
    s === "SHARED"
      ? "bg-violet-500/15 text-violet-700 dark:text-violet-300 border-violet-500/30"
      : "bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30";
  return (
    <Badge variant="outline" className={cls}>
      {label}
    </Badge>
  );
}

export function CurriculumBadge({ value }: { value: CurriculumStatus | string }) {
  const tr = useT();
  const s = String(value || "").toUpperCase();
  const label =
    s === "OFFICIAL" ? tr("admin.346") : s === "ARCHIVED" ? tr("admin.321") : tr("admin.347");
  const cls =
    s === "ARCHIVED"
      ? "bg-muted text-muted-foreground"
      : s === "OFFICIAL"
        ? "bg-primary/10 text-primary border-primary/30"
        : "";
  return (
    <Badge variant={s === "LEGACY" ? "secondary" : "outline"} className={cls}>
      {label}
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Readiness checklist — server payload rendering ONLY
// ---------------------------------------------------------------------------

const READINESS_KEY_LABEL: Record<string, string> = {
  VIDEO: "admin.380",
  PDF: "admin.381",
  QUIZ: "admin.382",
  HOMEWORK: "admin.383",
};

export function ReadinessStateIcon({ state }: { state: string }) {
  if (state === "OK")
    return <CheckCircle2 className="w-4 h-4 text-emerald-600 dark:text-emerald-400" />;
  if (state === "MISSING")
    return <XCircle className="w-4 h-4 text-red-600 dark:text-red-400" />;
  if (state === "INVALID")
    return <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400" />;
  return <MinusCircle className="w-4 h-4 text-muted-foreground" />;
}

export function readinessStateLabelKey(state: string): string {
  if (state === "OK") return "admin.410";
  if (state === "MISSING") return "admin.409";
  if (state === "INVALID") return "admin.411";
  return "admin.412";
}

/**
 * Phase D — human, Arabic-first explanation of a readiness code. Readiness
 * stays SERVER-COMPUTED (the code comes from the checklist payload); this
 * map only translates the stable code into what an admin reads. Unknown
 * codes fall back to `null` so the raw code is shown instead of a lie.
 */
const READINESS_REASON_LABEL: Record<string, string> = {
  VIDEO_OK: "admin.610",
  VIDEO_MISSING: "admin.611",
  VIDEO_TRACK_INCOMPLETE: "admin.612",
  PDF_OK: "admin.613",
  PDF_MISSING: "admin.614",
  PDF_TRACK_INCOMPLETE: "admin.615",
  QUIZ_OK: "admin.616",
  QUIZ_MISSING: "admin.617",
  QUIZ_EMPTY: "admin.618",
  HOMEWORK_OK: "admin.619",
  HOMEWORK_MISSING: "admin.620",
  HOMEWORK_INSTRUCTIONS_EMPTY: "admin.621",
  HOMEWORK_TRACK_INCOMPLETE: "admin.622",
  CURRICULUM_ARCHIVED: "admin.623",
};

/** The translated reason for a checklist item's code (or null). */
export function readinessReasonText(
  tr: (k: string) => string,
  code: string
): string | null {
  const key = READINESS_REASON_LABEL[code];
  return key ? tr(key) : null;
}

/**
 * The checklist. `readiness` is the server snapshot — `present`, `valid`,
 * `required` and `state` are displayed exactly as received. No prop here is
 * ever derived from lesson fields in the component.
 */
export function ReadinessChecklist({
  readiness,
  compact = false,
}: {
  readiness: LessonReadinessSnapshot;
  compact?: boolean;
}) {
  const tr = useT();
  return (
    <div className="space-y-2">
      <div className={`grid gap-2 ${compact ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
        {readiness.items.map((item) => (
          <div
            key={item.key}
            className="flex items-start gap-2.5 rounded-lg border p-2.5"
          >
            <span className="mt-0.5 shrink-0">
              <ReadinessStateIcon state={item.state} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="text-sm font-semibold">
                  {tr(READINESS_KEY_LABEL[item.key] || "admin.455")}
                </span>
                <Badge variant="outline" className="text-[10px]">
                  {tr(readinessStateLabelKey(item.state))}
                </Badge>
                <Badge variant="secondary" className="text-[10px]">
                  {item.required ? tr("admin.406") : tr("admin.407")}
                </Badge>
              </div>
              {/* Phase D — the human reason first (Arabic-first, no DB jargon),
                  machine detail secondary. */}
              {readinessReasonText(tr, item.code) && (
                <p
                  className={`mt-1 text-[12px] leading-relaxed ${
                    item.state === "OK"
                      ? "text-muted-foreground"
                      : "font-medium text-foreground"
                  }`}
                >
                  {readinessReasonText(tr, item.code)}
                </p>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-muted-foreground">
                <span>
                  {item.present ? tr("admin.408") : tr("admin.409")}
                  {" · "}
                  {item.valid ? tr("admin.410") : tr("admin.411")}
                </span>
                <code className="rounded bg-muted px-1 py-px font-mono text-[10px]" dir="ltr">
                  {item.code}
                </code>
              </div>
            </div>
          </div>
        ))}
      </div>

      {readiness.blocking.length > 0 && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-2.5">
          <div className="text-xs font-semibold text-destructive">
            {tr("admin.404")} — {tr("admin.403")}
          </div>
          <div className="mt-1 flex flex-wrap gap-1">
            {readiness.blocking.map((code) => (
              <code
                key={code}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                dir="ltr"
              >
                {code}
              </code>
            ))}
          </div>
        </div>
      )}

      {readiness.notes.length > 0 && (
        <div className="rounded-lg border p-2.5">
          <div className="text-xs font-semibold text-muted-foreground">{tr("admin.405")}</div>
          <div className="mt-1 flex flex-wrap gap-1">
            {readiness.notes.map((note) => (
              <code
                key={note}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]"
                dir="ltr"
              >
                {note}
              </code>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow stepper: Create → Stage → Readiness → Review → OPEN
// ---------------------------------------------------------------------------

const WORKFLOW_STEPS = [
  "admin.458",
  "admin.454",
  "admin.455",
  "admin.456",
  "admin.457",
] as const;

/**
 * Pure presentation of `status` (+ whether the server says the lesson can be
 * ready): DRAFT lives in Create/Stage, READY in Review, PUBLISHED at Open.
 * This is a position indicator, not a readiness evaluation.
 */
export function WorkflowStepper({
  status,
  canBeReady,
}: {
  status: LessonStatus | string;
  canBeReady: boolean | null;
}) {
  const tr = useT();
  const s = String(status || "").toUpperCase();
  const active = s === "PUBLISHED" ? 4 : s === "READY" ? 3 : canBeReady ? 2 : 1;
  return (
    <ol className="flex flex-wrap items-center gap-1.5" aria-label={tr("admin.456")}>
      {WORKFLOW_STEPS.map((key, i) => {
        const done = i < active;
        const current = i === active;
        return (
          <li key={key} className="flex items-center gap-1.5">
            {i > 0 && (
              <span className="text-muted-foreground" aria-hidden="true">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 12 12"
                  className="flip-rtl rtl:-scale-x-100"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                >
                  <path d="M4 2l4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </span>
            )}
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-semibold ${
                current
                  ? "border-primary bg-primary/10 text-primary"
                  : done
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
                    : "border-border text-muted-foreground"
              }`}
              aria-current={current ? "step" : undefined}
            >
              <span
                className={`grid place-items-center w-4 h-4 rounded-full text-[10px] tabular-nums ${
                  current
                    ? "bg-primary text-primary-foreground"
                    : done
                      ? "bg-emerald-500 text-white"
                      : "bg-muted text-muted-foreground"
                }`}
              >
                {i + 1}
              </span>
              {tr(key)}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Generic confirm dialog (archive / unpublish / deactivate…)
// ---------------------------------------------------------------------------

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmingLabel,
  confirming = false,
  danger = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  confirmingLabel: string;
  confirming?: boolean;
  danger?: boolean;
  onConfirm: () => void;
}) {
  const tr = useT();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={confirming}>
            {tr("admin.288")}
          </Button>
          <Button
            variant={danger ? "destructive" : "default"}
            onClick={onConfirm}
            disabled={confirming}
          >
            {confirming && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {confirming ? confirmingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Small building blocks
// ---------------------------------------------------------------------------

export function SectionCard({
  title,
  action,
  children,
}: {
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border bg-card p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold">{title}</h3>
        {action}
      </div>
      {children}
    </motion.section>
  );
}

/**
 * Human-readable bytes. Delegates to the ONE definition in
 * `src/lib/upload-progress.ts` so a material row and the live upload progress
 * bar can never format the same size differently.
 */
export function formatBytes(n: number | null | undefined): string {
  return formatUploadBytes(n);
}

export function formatDateTime(value: string | Date | null | undefined): string {
  if (!value) return "—";
  try {
    const d = typeof value === "string" ? new Date(value) : value;
    return d.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}
