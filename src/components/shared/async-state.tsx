"use client";

// CodeMind Academy — Phase M1 — the ONE async-state vocabulary.
//
// WHY
//   Every data-backed surface in the app re-implements the same three states,
//   and the copies have already drifted:
//
//     admin/admin-dashboard   `LoadingBlock` 4 skeletons · `ErrorBlock` XCircle
//                             + message + outline "Try again" · `EmptyBlock`
//                             a "·" glyph + message
//     teacher/teacher-dashboard `ErrorState` rounded destructive chip +
//                             AlertTriangle + RefreshCw "Retry" ·
//                             `EmptyState` emoji + message + hint
//
//   M1 does NOT migrate those call sites (that is M2+ work behind the frozen
//   view contracts). It provides the ONE primitive and leaves the old local
//   components in place, so the adoption diff can be reviewed on its own.
//
// CONTRACT
//   * Composable: each block renders its own message/action, and accepts
//     `children` for extra content. Nothing here forces a page redesign.
//   * Optional everything: an `ErrorBlock` with no retry is valid; a
//     `LoadingBlock` with no label is valid.
//   * i18n-safe: `messageKey` / `retryLabelKey` resolve through `useT()`. The
//     DEFAULT keys are the platform's existing generic entries (admin.001 /
//     admin.002 / admin.003) — no new dictionary entries are introduced in M1,
//     and a caller with its own wording passes `message` / `retryLabel`
//     instead (exactly what the existing local components do).
//   * RTL-safe: logical utilities only (no `ml-`/`mr-`/`text-left`).
//   * No data access, no fetching, no state: these render what the caller
//     already knows. The retry callback is the caller's own refetch.

import * as React from "react";
import { XCircle, RefreshCw } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

/** Existing generic dictionary entries (no new keys in M1). */
export const GENERIC_ERROR_MESSAGE_KEY = "admin.001";
export const GENERIC_ERROR_TITLE_KEY = "admin.003";
export const GENERIC_RETRY_LABEL_KEY = "admin.002";

/** Resolve "either a literal or an i18n key" the same way in every block. */
function useResolvedText(
  value: React.ReactNode | undefined,
  key: string | undefined,
  fallbackKey?: string
): React.ReactNode {
  const tr = useT();
  if (value !== undefined && value !== null && value !== "") return value;
  if (key) return tr(key);
  if (fallbackKey) return tr(fallbackKey);
  return null;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

export type LoadingBlockProps = {
  /** How many skeleton rows to render (default 4). */
  rows?: number;
  /** Height of one skeleton row (Tailwind class, default `h-12`). */
  rowClassName?: string;
  /** Visible label above the skeletons; usually omitted (the shape says it). */
  label?: React.ReactNode;
  /** i18n key variant of `label`. */
  labelKey?: string;
  className?: string;
  children?: React.ReactNode;
};

/**
 * The shared loading state. It renders SKELETONS rather than a spinner because
 * every screen it replaces already does: the row shape is the local layout, so
 * a fixed-height spinner would be a visible regression on first paint.
 */
export function LoadingBlock({
  rows = 4,
  rowClassName = "h-12",
  label,
  labelKey,
  className,
  children,
}: LoadingBlockProps) {
  const text = useResolvedText(label, labelKey);
  return (
    <div
      className={cn("space-y-3", className)}
      role="status"
      aria-busy="true"
      data-async-state="loading"
    >
      {text ? <p className="text-sm text-muted-foreground text-start">{text}</p> : null}
      {Array.from({ length: Math.max(1, rows) }).map((_, i) => (
        <Skeleton key={i} className={cn("w-full", rowClassName)} />
      ))}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Error
// ---------------------------------------------------------------------------

export type ErrorBlockProps = {
  /** The caller's own message (already localised). Takes precedence. */
  message?: React.ReactNode;
  /** i18n key for the message; defaults to the generic entry when neither is given. */
  messageKey?: string;
  /** Optional heading above the message. */
  title?: React.ReactNode;
  titleKey?: string;
  /** Optional retry affordance; omitted → no button. */
  onRetry?: () => void;
  retryLabel?: React.ReactNode;
  retryLabelKey?: string;
  /** Custom icon; defaults to the destructive XCircle. */
  icon?: React.ReactNode;
  /** Extra action (link, support contact, …) rendered next to retry. */
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
};

/** The shared failure state: icon + message + optional retry/action. */
export function ErrorBlock({
  message,
  messageKey,
  title,
  titleKey,
  onRetry,
  retryLabel,
  retryLabelKey,
  icon,
  action,
  className,
  children,
}: ErrorBlockProps) {
  const tr = useT();
  const text = useResolvedText(message, messageKey, GENERIC_ERROR_MESSAGE_KEY);
  const heading = useResolvedText(title, titleKey);
  const retryText =
    retryLabel !== undefined && retryLabel !== null && retryLabel !== ""
      ? retryLabel
      : tr(retryLabelKey || GENERIC_RETRY_LABEL_KEY);

  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 py-10 px-4 text-center",
        className
      )}
      role="alert"
      data-async-state="error"
    >
      {icon ?? <XCircle className="h-8 w-8 text-destructive" aria-hidden="true" />}
      {heading ? <p className="text-sm font-medium">{heading}</p> : null}
      {text ? <p className="text-sm text-muted-foreground">{text}</p> : null}
      {onRetry || action ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw className="h-3.5 w-3.5 me-1.5" aria-hidden="true" />
              {retryText}
            </Button>
          ) : null}
          {action}
        </div>
      ) : null}
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty
// ---------------------------------------------------------------------------

export type EmptyBlockProps = {
  /** The caller's own message (already localised). */
  message?: React.ReactNode;
  messageKey?: string;
  /** Secondary line under the message. */
  hint?: React.ReactNode;
  hintKey?: string;
  /** Emoji or icon; defaults to none (the message carries the meaning). */
  emoji?: React.ReactNode;
  icon?: React.ReactNode;
  /** Optional call to action (e.g. "Add the first lesson"). */
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
};

/**
 * The shared "nothing to show" state. Deliberately NOT a spinner and NOT an
 * error: an empty list is a fact about the filter/data, so the caller decides
 * the wording — which is why no default message key is imposed here.
 */
export function EmptyBlock({
  message,
  messageKey,
  hint,
  hintKey,
  emoji,
  icon,
  action,
  className,
  children,
}: EmptyBlockProps) {
  const text = useResolvedText(message, messageKey);
  const sub = useResolvedText(hint, hintKey);
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 py-10 px-4 text-center",
        className
      )}
      data-async-state="empty"
    >
      {icon ?? (emoji ? <div className="text-3xl">{emoji}</div> : null)}
      {text ? <p className="text-sm font-medium">{text}</p> : null}
      {sub ? <p className="text-xs text-muted-foreground">{sub}</p> : null}
      {action}
      {children}
    </div>
  );
}

/**
 * A convenience wrapper for the common "error OR empty OR loading OR content"
 * branch. It does not invent behaviour: whichever state the caller declares
 * wins, and the content renders otherwise.
 */
export function AsyncBoundary({
  loading,
  error,
  empty,
  loadingFallback,
  errorFallback,
  emptyFallback,
  children,
}: {
  loading?: boolean;
  error?: boolean;
  empty?: boolean;
  loadingFallback?: React.ReactNode;
  errorFallback?: React.ReactNode;
  emptyFallback?: React.ReactNode;
  children: React.ReactNode;
}) {
  if (loading) return <>{loadingFallback ?? <LoadingBlock />}</>;
  if (error) return <>{errorFallback ?? <ErrorBlock />}</>;
  if (empty) return <>{emptyFallback ?? <EmptyBlock />}</>;
  return <>{children}</>;
}
