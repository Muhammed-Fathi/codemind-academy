"use client";

// CodeMind Academy — Admin media upload state machine (session video + PDF).
//
// ONE hook drives BOTH admin upload surfaces, so the video and the PDF show
// the same phases, the same real byte progress, the same failure wording and
// the same protections. Without it the two screens drifted (the PDF screen
// disabled its inputs while busy, the video screen did not; neither could tell
// "sending bytes" from "server is confirming").
//
// WHAT IT GUARANTEES
//   * Multi-stage visibility: preparing → uploading → confirming →
//     succeeded / failed. `succeeded` is only ever reached AFTER the
//     complete leg answered 2xx — the admin is never told "uploaded" while
//     the server has not verified and recorded the file.
//   * Real progress: percentages come from the transport's byte counters
//     (see src/lib/direct-upload.ts). No timers, no animation-only progress.
//   * Single flight: a synchronous latch refuses a second run, so a double
//     click cannot issue two init/PUT/complete cycles.
//   * Cancellable: `cancel()` aborts the in-flight request; the result is a
//     typed cancellation, not an error.
//   * Recoverable: a failure keeps the panel (with the byte count it reached)
//     and offers `retry()`; picking another file calls `reset()`.
//   * Unmount-safe: after unmount no state is written and the success timer
//     is cleared. The request itself is deliberately NOT aborted on unmount —
//     an admin navigating away mid-upload still gets the file saved and
//     recorded by the server, exactly as before this hook existed.

import * as React from "react";
import {
  directUpload,
  type DirectUploadInput,
} from "@/lib/direct-upload";
import { resolveUploadFailure } from "@/lib/upload-error-text";
import {
  createUploadRunGuard,
  emptyUploadTimings,
  initialUploadState,
  isBusyUploadPhase,
  logUploadTimings,
  reduceUploadState,
  shouldReportProgress,
  UPLOAD_PROGRESS_MIN_INTERVAL_MS,
  type UploadFailure,
  type UploadProgress,
  type UploadStateEvent,
  type UploadStateSnapshot,
  type UploadTimings,
} from "@/lib/upload-progress";

/**
 * What a surface hands to `run()`. Same fields as the direct-upload helper
 * plus an optional `prepare` step: work that must happen BEFORE init while
 * the UI already says "preparing" (the PDF integrity hash, which reads the
 * whole file into memory — a real, measurable part of the wait).
 */
export type MediaUploadRequest = Omit<
  DirectUploadInput,
  "onStage" | "onProgress" | "signal" | "sha256"
> & {
  sha256?: string | null;
  prepare?: () => Promise<{ sha256?: string | null } | void>;
};

/**
 * The buffered multipart fallback used when the deployment's storage backend
 * cannot serve presigned uploads (MEDIA_BACKEND=local). Byte progress is not
 * observable there, so the panel switches to an honest indeterminate state.
 */
export type BufferedFallback = (
  file: File
) => Promise<{ ok: boolean; status?: number; error?: string | null }>;

export type MediaUploadResult =
  | { ok: true }
  | { ok: false; duplicate: true }
  | { ok: false; cancelled: true }
  | { ok: false; failure: UploadFailure };

export type MediaUploadApi = {
  state: UploadStateSnapshot;
  /** True during preparing / uploading / confirming — disable inputs with it. */
  isBusy: boolean;
  run: (request: MediaUploadRequest, fallback?: BufferedFallback | null) => Promise<MediaUploadResult>;
  /** Re-runs the last request unchanged; null when there is nothing to retry. */
  retry: () => Promise<MediaUploadResult | null>;
  cancel: () => void;
  /** Clears a finished/failed state. A no-op while an upload is in flight. */
  reset: () => void;
};

export function useMediaUpload(options?: { successHoldMs?: number }): MediaUploadApi {
  const successHoldMs =
    options && typeof options.successHoldMs === "number" && options.successHoldMs >= 0
      ? options.successHoldMs
      : 1800;

  const [state, setState] = React.useState<UploadStateSnapshot>(initialUploadState);
  const stateRef = React.useRef<UploadStateSnapshot>(state);
  const mountedRef = React.useRef(true);
  const guardRef = React.useRef(createUploadRunGuard());
  const abortRef = React.useRef<AbortController | null>(null);
  const successTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunRef = React.useRef<{
    request: MediaUploadRequest;
    fallback: BufferedFallback | null;
  } | null>(null);
  const lastReportRef = React.useRef<{ at: number; progress: UploadProgress | null }>({
    at: 0,
    progress: null,
  });

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (successTimerRef.current) {
        clearTimeout(successTimerRef.current);
        successTimerRef.current = null;
      }
    };
  }, []);

  /** The only writer of upload state: the pure reducer + an unmount guard. */
  const dispatch = React.useCallback((event: UploadStateEvent) => {
    const next = reduceUploadState(stateRef.current, event);
    stateRef.current = next;
    if (!mountedRef.current) return;
    setState(next);
  }, []);

  const clearSuccessTimer = React.useCallback(() => {
    if (successTimerRef.current) {
      clearTimeout(successTimerRef.current);
      successTimerRef.current = null;
    }
  }, []);

  const run = React.useCallback(
    async (
      request: MediaUploadRequest,
      fallback?: BufferedFallback | null
    ): Promise<MediaUploadResult> => {
      // Synchronous single-flight latch: a second click in the same tick is
      // refused BEFORE any request is created (a disabled button alone cannot
      // guarantee this, because React state lands on the next render).
      if (!guardRef.current.acquire()) return { ok: false, duplicate: true };

      lastRunRef.current = { request, fallback: fallback ?? null };
      clearSuccessTimer();
      lastReportRef.current = { at: 0, progress: null };

      const controller = new AbortController();
      abortRef.current = controller;

      const file = request.file;
      const fileName = file && typeof file.name === "string" ? file.name : null;
      const fileBytes = file && typeof file.size === "number" ? file.size : 0;
      dispatch({ type: "start", fileName, totalBytes: fileBytes });

      const finishSuccess = (timings: UploadTimings): MediaUploadResult => {
        guardRef.current.release();
        abortRef.current = null;
        dispatch({ type: "succeeded", timings });
        logUploadTimings({
          purpose: request.purpose,
          phase: "succeeded",
          bytes: fileBytes,
          timings,
        });
        // Hold the success state briefly so "تم رفع الملف بنجاح" is actually
        // seen, then clear the panel without any further user action.
        if (mountedRef.current && successHoldMs > 0) {
          successTimerRef.current = setTimeout(() => {
            successTimerRef.current = null;
            dispatch({ type: "reset" });
          }, successHoldMs);
        }
        return { ok: true };
      };

      const finishCancelled = (timings: UploadTimings): MediaUploadResult => {
        guardRef.current.release();
        abortRef.current = null;
        dispatch({ type: "cancelled" });
        logUploadTimings({
          purpose: request.purpose,
          phase: "idle",
          bytes: fileBytes,
          timings,
        });
        return { ok: false, cancelled: true };
      };

      const finishFailure = (
        failure: UploadFailure,
        timings: UploadTimings
      ): MediaUploadResult => {
        guardRef.current.release();
        abortRef.current = null;
        dispatch({ type: "failed", failure, timings });
        logUploadTimings({
          purpose: request.purpose,
          phase: "failed",
          bytes: fileBytes,
          timings,
        });
        return { ok: false, failure };
      };

      const { prepare, ...uploadInput } = request;
      let prepareMs = 0;
      let sha256 = request.sha256 ?? null;

      try {
        if (prepare) {
          const preparedAt = Date.now();
          const prepared = await prepare();
          prepareMs = Date.now() - preparedAt;
          if (prepared && typeof prepared.sha256 === "string") sha256 = prepared.sha256;
          if (controller.signal.aborted) {
            return finishCancelled({ ...emptyUploadTimings(), prepareMs });
          }
        }

        const out = await directUpload({
          ...uploadInput,
          sha256,
          signal: controller.signal,
          onStage: (stage) => dispatch({ type: "stage", stage }),
          onProgress: (progress) => {
            // Throttled on purpose: XHR progress fires far faster than a frame,
            // and re-rendering the whole form during a 512 MB upload is exactly
            // the kind of self-inflicted slowdown this phase removes.
            const now = Date.now();
            const last = lastReportRef.current;
            if (
              !shouldReportProgress(
                last.progress,
                progress,
                now - last.at,
                UPLOAD_PROGRESS_MIN_INTERVAL_MS
              )
            ) {
              return;
            }
            lastReportRef.current = { at: now, progress };
            dispatch({
              type: "progress",
              loadedBytes: progress.loadedBytes,
              totalBytes: progress.totalBytes,
            });
          },
        });

        const timings: UploadTimings = {
          ...emptyUploadTimings(),
          ...out.timings,
          prepareMs,
        };

        if (out.ok) return finishSuccess(timings);
        if (out.cancelled === true || out.code === "ABORTED") return finishCancelled(timings);

        // MEDIA_BACKEND=local: the server refused to presign, so the bytes go
        // through the app's own buffered multipart endpoint instead.
        if (out.code === "PRESIGNED_UNSUPPORTED" && fallback) {
          dispatch({ type: "buffered", totalBytes: fileBytes });
          const bufferedAt = Date.now();
          let fb: { ok: boolean; status?: number; error?: string | null };
          try {
            fb = await fallback(file);
          } catch (e) {
            fb = { ok: false, status: 0, error: (e as Error)?.message || "admin.001" };
          }
          const bufferedMs = Date.now() - bufferedAt;
          const bufferedTimings: UploadTimings = {
            ...timings,
            transferMs: timings.transferMs + bufferedMs,
            totalMs: timings.totalMs + bufferedMs,
          };
          if (controller.signal.aborted) return finishCancelled(bufferedTimings);
          if (fb.ok) return finishSuccess(bufferedTimings);
          return finishFailure(
            resolveUploadFailure({
              stage: "buffered",
              status: typeof fb.status === "number" ? fb.status : 500,
              code: null,
              error: fb.error ?? null,
            }),
            bufferedTimings
          );
        }

        return finishFailure(
          resolveUploadFailure({
            stage: out.stage,
            status: out.status,
            code: out.code,
            error: out.error,
            // A cancellation already returned above, so this leg genuinely
            // failed. (`out.cancelled` is narrowed to false/undefined here.)
            cancelled: false,
          }),
          timings
        );
      } catch (e) {
        // directUpload never throws; `prepare` (or a caller bug) can.
        return finishFailure(
          resolveUploadFailure({
            stage: "init",
            status: 0,
            code: null,
            error: (e as Error)?.message || "admin.001",
            cancelled: controller.signal.aborted,
          }),
          { ...emptyUploadTimings(), prepareMs }
        );
      }
    },
    [clearSuccessTimer, dispatch, successHoldMs]
  );

  const retry = React.useCallback(async (): Promise<MediaUploadResult | null> => {
    const last = lastRunRef.current;
    if (!last) return null;
    return run(last.request, last.fallback);
  }, [run]);

  const cancel = React.useCallback(() => {
    const controller = abortRef.current;
    if (controller) controller.abort();
  }, []);

  const reset = React.useCallback(() => {
    // Never clear the state of an upload that is still running: the panel is
    // the only proof the admin has that something is in flight.
    if (guardRef.current.isBusy()) return;
    clearSuccessTimer();
    lastRunRef.current = null;
    dispatch({ type: "reset" });
  }, [clearSuccessTimer, dispatch]);

  return {
    state,
    isBusy: isBusyUploadPhase(state.phase),
    run,
    retry,
    cancel,
    reset,
  };
}
