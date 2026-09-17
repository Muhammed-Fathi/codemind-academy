"use client";

// ============================================================
// CodeMind Academy — Admin: shared media upload progress panel
//
// ONE component renders the upload state for BOTH session videos and session
// PDFs, so the two surfaces cannot drift: same phases, same wording, same
// bar, same byte formatting, same cancel/retry affordances.
//
// It renders NOTHING when idle, and it never invents a number:
//   * the percentage and the byte counts come from the transport's real
//     progress samples (src/lib/direct-upload.ts → useMediaUpload);
//   * when the byte count is not observable (the buffered MEDIA_BACKEND=local
//     fallback) the bar is indeterminate and the panel SAYS so;
//   * when every byte has left the browser but the storage response is still
//     pending, the label changes — that tail is real waiting, not a stuck bar.
//
// Layout uses logical properties only (ms-/me-/start-/end-) so the panel is
// correct in Arabic (RTL) and English (LTR).
// ============================================================

import * as React from "react";
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  UPLOAD_AWAITING_RESPONSE_KEY,
  UPLOAD_FILE_LINE_KEY,
  UPLOAD_PROGRESS_DETAIL_KEY,
  UPLOAD_PROGRESS_UNAVAILABLE_KEY,
  formatUploadBytes,
  uploadPhaseLabelKey,
  type UploadStateSnapshot,
} from "@/lib/upload-progress";

export function UploadProgressPanel({
  state,
  onCancel,
  onRetry,
  className,
}: {
  state: UploadStateSnapshot;
  /** Offered while an upload is in flight. Omit to render no cancel button. */
  onCancel?: (() => void) | null;
  /** Offered after a failure. Omit to render no retry button. */
  onRetry?: (() => void) | null;
  className?: string;
}) {
  const tr = useT();
  const { phase, fileName, percent, computable, loadedBytes, totalBytes, failure } = state;

  if (phase === "idle") return null;

  const busy = phase === "preparing" || phase === "uploading" || phase === "confirming";
  // Bytes are all sent but the storage answer has not come back yet — the
  // honest explanation for a bar sitting at 100% for a few seconds.
  const awaitingResponse = phase === "uploading" && computable && percent >= 100;
  const headingKey = awaitingResponse
    ? UPLOAD_AWAITING_RESPONSE_KEY
    : uploadPhaseLabelKey(phase);
  const heading = headingKey ? tr(headingKey) : "";

  const showBar = phase === "uploading" || phase === "confirming" || phase === "succeeded";
  const barValue = phase === "succeeded" || phase === "confirming" ? 100 : computable ? percent : 0;
  const sizeText = totalBytes > 0 ? formatUploadBytes(totalBytes) : "";
  const detailText = computable
    ? tr(UPLOAD_PROGRESS_DETAIL_KEY, {
        p1: formatUploadBytes(loadedBytes),
        p2: sizeText,
        p3: String(Math.round(percent)),
      })
    : tr(UPLOAD_PROGRESS_UNAVAILABLE_KEY);

  const Icon = phase === "succeeded" ? CheckCircle2 : phase === "failed" ? XCircle : Loader2;

  return (
    <div
      className={cn(
        "rounded-lg border p-3 space-y-2",
        phase === "succeeded" && "border-emerald-500/40 bg-emerald-500/5",
        phase === "failed" && "border-destructive/40 bg-destructive/5",
        className
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          className={cn(
            "w-4 h-4 shrink-0",
            busy && "animate-spin",
            phase === "succeeded" && "text-emerald-600 dark:text-emerald-400",
            phase === "failed" && "text-destructive"
          )}
          aria-hidden="true"
        />
        {/* Announced politely: the admin does not have to watch the bar. */}
        <span role="status" aria-live="polite" className="text-xs font-semibold">
          {heading}
        </span>

        {fileName && (
          <span
            className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
            dir="auto"
            title={fileName}
          >
            {sizeText ? tr(UPLOAD_FILE_LINE_KEY, { p1: fileName, p2: sizeText }) : fileName}
          </span>
        )}

        {busy && onCancel && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="ms-auto h-7 text-[11px]"
            onClick={onCancel}
          >
            {tr("admin.568")}
          </Button>
        )}
        {phase === "failed" && onRetry && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="ms-auto h-7 text-[11px]"
            onClick={onRetry}
          >
            {tr("admin.002")}
          </Button>
        )}
      </div>

      {showBar && (
        <div className={cn("space-y-1", !computable && phase !== "succeeded" && "animate-pulse")}>
          <Progress
            value={barValue}
            aria-label={heading}
            aria-valuetext={detailText}
            className={cn("h-2", phase === "succeeded" && "[&>div]:bg-emerald-500")}
          />
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
            {computable ? (
              <>
                {/* Numbers stay LTR inside the RTL sentence: bidi would
                    otherwise reorder "32.4 MB / 80.0 MB" and the percent. */}
                <span dir="ltr" className="tabular-nums">
                  {`${formatUploadBytes(loadedBytes)} / ${sizeText}`}
                </span>
                <span dir="ltr" className="tabular-nums font-semibold">
                  {`${Math.round(percent)}%`}
                </span>
              </>
            ) : (
              <span>{detailText}</span>
            )}
          </div>
        </div>
      )}

      {phase === "failed" && failure && (
        <p className="text-xs text-destructive" dir="auto">
          {failure.detail ? `${tr(failure.messageKey)} — ${failure.detail}` : tr(failure.messageKey)}
        </p>
      )}
    </div>
  );
}
