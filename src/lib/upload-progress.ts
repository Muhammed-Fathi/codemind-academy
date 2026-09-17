// CodeMind Academy — Admin media upload: progress + phase contract.
//
// ONE definition of "what the admin sees while a session video / session PDF
// is being uploaded", shared by:
//   * src/lib/direct-upload.ts          (the 3-leg browser flow reports into it)
//   * src/lib/upload-error-text.ts      (failure → message key resolution)
//   * src/hooks/use-media-upload.ts     (the client state machine)
//   * src/components/admin/upload-progress-panel.tsx (the visual panel)
//
// HARD RULES FOR THIS FILE
//   * PURE + ISOMORPHIC: no React, no `fetch`, no XHR, no storage knowledge,
//     no environment reads beyond NODE_ENV for the dev-only timing log. It is
//     compiled and exercised directly by tests/media-upload-progress.test.js.
//   * NO SECRETS: nothing here ever sees a presigned URL, a token, a storage
//     key, or a credential — and `logUploadTimings` prints DURATIONS ONLY.
//   * Progress is DERIVED FROM REAL BYTES. There is no timer-based fake
//     progress anywhere in this module: every percentage comes from a
//     (loadedBytes, totalBytes) pair reported by the transport.
//
// The media contract itself (video MIME allow-list + 512 MB, PDF
// application/pdf + .pdf + %PDF- magic + 25 MB) lives in src/lib/media.ts and
// is enforced server-side; this module never re-decides it.

// ---------------------------------------------------------------------------
// Phases — the state the admin can SEE
// ---------------------------------------------------------------------------

/**
 * The visible upload lifecycle. `preparing` / `uploading` / `confirming` are
 * the three BUSY phases; they map 1:1 onto the three legs of the direct flow
 * (init → PUT → complete) so "uploading the bytes" is never confused with
 * "the server is verifying and recording the file".
 */
export const UPLOAD_PHASES = [
  "idle",
  "preparing",
  "uploading",
  "confirming",
  "succeeded",
  "failed",
] as const;

export type UploadPhase = (typeof UPLOAD_PHASES)[number];

/** Phases during which the upload button MUST be disabled. */
export const BUSY_UPLOAD_PHASES = ["preparing", "uploading", "confirming"] as const;

export function isBusyUploadPhase(phase: UploadPhase | string | null | undefined): boolean {
  return (BUSY_UPLOAD_PHASES as readonly string[]).includes(String(phase));
}

/** Leg names reported by `src/lib/direct-upload.ts`. */
export type UploadStageName = "init" | "transfer" | "complete";

const STAGE_TO_PHASE: Record<UploadStageName, UploadPhase> = {
  init: "preparing",
  transfer: "uploading",
  complete: "confirming",
};

/**
 * Which visible phase a direct-upload leg belongs to. Unknown legs fall back
 * to `uploading` — the safest busy phase (it never claims success).
 */
export function phaseForUploadStage(stage: UploadStageName | string | null | undefined): UploadPhase {
  const mapped = STAGE_TO_PHASE[String(stage) as UploadStageName];
  return mapped ?? "uploading";
}

/**
 * Dictionary key for each phase label. `null` for `idle` (nothing is rendered).
 * Keys resolve through the caller's own `useT()` so this module stays free of
 * React and of the server-only i18n layer.
 */
export const UPLOAD_PHASE_LABEL_KEY: Record<UploadPhase, string | null> = {
  idle: null,
  preparing: "admin.562", // جاري تجهيز الرفع…
  uploading: "admin.563", // جاري رفع الملف…
  confirming: "admin.565", // تم رفع الملف، جاري تأكيد الحفظ…
  succeeded: "admin.566", // تم رفع الملف بنجاح
  failed: "admin.572", // فشل الرفع
};

/** Shown when every byte left the browser but the storage response is pending. */
export const UPLOAD_AWAITING_RESPONSE_KEY = "admin.581";

/** Shown when the byte-level progress is not observable (buffered fallback). */
export const UPLOAD_PROGRESS_UNAVAILABLE_KEY = "admin.573";

/** "{p1} of {p2} — {p3}%" (accessible label + text fallback). */
export const UPLOAD_PROGRESS_DETAIL_KEY = "admin.564";

/** "File: {p1} ({p2})". */
export const UPLOAD_FILE_LINE_KEY = "admin.571";

export function uploadPhaseLabelKey(phase: UploadPhase | string | null | undefined): string | null {
  return UPLOAD_PHASE_LABEL_KEY[String(phase) as UploadPhase] ?? null;
}

// ---------------------------------------------------------------------------
// Progress math — never fake, never > 100, never a division by zero
// ---------------------------------------------------------------------------

export type UploadProgress = {
  /** Bytes the transport has actually handed to the network. */
  loadedBytes: number;
  /** Expected total; 0 when the transport could not determine it. */
  totalBytes: number;
  /** 0..100, one decimal. Always 0 while `computable` is false. */
  percent: number;
  /** False when the total is unknown — the UI must NOT invent a percentage. */
  computable: boolean;
};

/** Clamp to the only range a percentage may occupy. */
export function clampPercent(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 100) return 100;
  return Math.round(value * 10) / 10;
}

/**
 * Percentage of `totalBytes` represented by `loadedBytes`.
 *
 * Fail-safe by construction:
 *   * unknown / zero / negative total → 0 (no division by zero, no NaN, no
 *     Infinity reaching the UI);
 *   * non-finite or negative loaded  → 0;
 *   * loaded > total (a transport that over-reports, or a chunked encoding
 *     whose declared total drifts) → capped at the total, so the result can
 *     NEVER exceed 100.
 */
export function uploadPercent(
  loadedBytes: number | null | undefined,
  totalBytes: number | null | undefined
): number {
  const loaded = typeof loadedBytes === "number" ? loadedBytes : NaN;
  const total = typeof totalBytes === "number" ? totalBytes : NaN;
  if (!Number.isFinite(loaded) || !Number.isFinite(total)) return 0;
  if (total <= 0) return 0;
  if (loaded <= 0) return 0;
  const bounded = Math.min(loaded, total);
  return clampPercent((bounded / total) * 100);
}

/** Build the progress snapshot the UI renders from a raw transport sample. */
export function makeUploadProgress(
  loadedBytes: number | null | undefined,
  totalBytes: number | null | undefined
): UploadProgress {
  const loaded =
    typeof loadedBytes === "number" && Number.isFinite(loadedBytes) && loadedBytes > 0
      ? loadedBytes
      : 0;
  const total =
    typeof totalBytes === "number" && Number.isFinite(totalBytes) && totalBytes > 0
      ? totalBytes
      : 0;
  const computable = total > 0;
  return {
    loadedBytes: computable ? Math.min(loaded, total) : loaded,
    totalBytes: total,
    percent: computable ? uploadPercent(loaded, total) : 0,
    computable,
  };
}

/** The progress snapshot before any byte moved. */
export function emptyUploadProgress(totalBytes = 0): UploadProgress {
  return makeUploadProgress(0, totalBytes);
}

// ---------------------------------------------------------------------------
// Byte formatting — human readable, identical on every admin surface
// ---------------------------------------------------------------------------

/**
 * Human-readable bytes (binary units, one decimal below 100).
 *
 * `8 MB` → "8.0 MB", `512 MB` → "512 MB", `32.4 MB` → "32.4 MB".
 * Invalid / negative input renders an em dash rather than "NaN MB".
 */
export function formatUploadBytes(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[u]}`;
}

// ---------------------------------------------------------------------------
// Render throttling — real progress without a re-render storm
// ---------------------------------------------------------------------------

/**
 * Minimum spacing between two progress renders. An XHR `upload.onprogress`
 * fires far faster than a frame on a fast link; without a gate a large video
 * would spend the whole upload re-rendering the form instead of sending bytes.
 */
export const UPLOAD_PROGRESS_MIN_INTERVAL_MS = 120;

/**
 * Should this sample reach React state?
 *
 * Always yes for: the FIRST sample, the final 100%, a change in whether the
 * total is known, and any jump of ≥1 percentage point. Otherwise only once
 * `elapsedMs` passed the throttle window. Dropping samples can therefore never
 * hide the completion of an upload.
 */
export function shouldReportProgress(
  prev: UploadProgress | null | undefined,
  next: UploadProgress,
  elapsedMs: number,
  minIntervalMs: number = UPLOAD_PROGRESS_MIN_INTERVAL_MS
): boolean {
  if (!prev) return true;
  if (next.percent >= 100) return true;
  if (prev.computable !== next.computable) return true;
  if (next.percent - prev.percent >= 1) return true;
  const elapsed = Number.isFinite(elapsedMs) ? elapsedMs : 0;
  const gate = Number.isFinite(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : 0;
  return elapsed >= gate;
}

// ---------------------------------------------------------------------------
// Failure shape (resolution lives in src/lib/upload-error-text.ts)
// ---------------------------------------------------------------------------

/**
 * Everything the UI needs to present ONE failure. Defined here (not in
 * upload-error-text.ts) because the state reducer carries it; the resolver
 * imports this type, so the dependency stays one-directional.
 */
export type UploadFailure = {
  /** Failing leg: init / transfer / complete, or `buffered` for the fallback. */
  stage: UploadStageName | "buffered";
  /** Machine code from the server, when it sent one. */
  code: string | null;
  /** HTTP status of the failing leg (0 = network error / abort). */
  status: number;
  /** Dictionary key of the PRIMARY message the admin should read. */
  messageKey: string;
  /** Dictionary key naming the specific cause, when the code carried one. */
  reasonKey: string | null;
  /**
   * Server text worth showing verbatim (machine contract messages). NEVER set
   * for the transfer leg: there the only available text is either our own
   * English fallback or a storage-side body, and neither belongs in an Arabic
   * admin toast.
   */
  detail: string | null;
  /** Error text from the buffered fallback endpoint (rendered via serverErrorText). */
  rawError: string | null;
  /** True when retrying the same file unchanged can succeed. */
  retriable: boolean;
  /** True when the leg never reached the server (offline / DNS / blocked). */
  network: boolean;
  /** True when the admin cancelled — a cancellation is not an error. */
  cancelled: boolean;
};

// ---------------------------------------------------------------------------
// Client state machine (pure reducer — the hook only stores the result)
// ---------------------------------------------------------------------------

export type UploadLegTimings = {
  /** POST /api/admin/media-uploads/init */
  initMs: number;
  /** browser → storage PUT (the bytes) */
  transferMs: number;
  /** POST /api/admin/media-uploads/complete */
  completeMs: number;
  /** whole flow */
  totalMs: number;
};

export type UploadTimings = UploadLegTimings & {
  /** Optional browser-side hashing done BEFORE init (PDF integrity proof). */
  prepareMs: number;
};

export function emptyUploadLegTimings(): UploadLegTimings {
  return { initMs: 0, transferMs: 0, completeMs: 0, totalMs: 0 };
}

export function emptyUploadTimings(): UploadTimings {
  return { ...emptyUploadLegTimings(), prepareMs: 0 };
}

function withTimings(base: UploadTimings, patch?: Partial<UploadTimings> | null): UploadTimings {
  if (!patch) return base;
  const next = { ...base };
  for (const key of Object.keys(patch) as (keyof UploadTimings)[]) {
    const v = patch[key];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) next[key] = v;
  }
  return next;
}

export type UploadStateSnapshot = {
  phase: UploadPhase;
  fileName: string | null;
  progress: UploadProgress;
  /** Convenience mirrors of `progress` for the panel + tests. */
  loadedBytes: number;
  totalBytes: number;
  percent: number;
  computable: boolean;
  failure: UploadFailure | null;
  timings: UploadTimings;
};

export type UploadStateEvent =
  | { type: "start"; fileName?: string | null; totalBytes?: number; timings?: Partial<UploadTimings> }
  | { type: "stage"; stage: UploadStageName | string }
  | { type: "progress"; loadedBytes: number; totalBytes: number }
  /** Buffered fallback: bytes move, but the transport cannot report them. */
  | { type: "buffered"; totalBytes?: number }
  | { type: "succeeded"; timings?: Partial<UploadTimings> }
  | { type: "failed"; failure: UploadFailure | null; timings?: Partial<UploadTimings> }
  | { type: "cancelled" }
  | { type: "reset" };

export function initialUploadState(): UploadStateSnapshot {
  return {
    phase: "idle",
    fileName: null,
    progress: emptyUploadProgress(0),
    loadedBytes: 0,
    totalBytes: 0,
    percent: 0,
    computable: false,
    failure: null,
    timings: emptyUploadTimings(),
  };
}

function withProgress(state: UploadStateSnapshot, progress: UploadProgress): UploadStateSnapshot {
  return {
    ...state,
    progress,
    loadedBytes: progress.loadedBytes,
    totalBytes: progress.totalBytes,
    percent: progress.percent,
    computable: progress.computable,
  };
}

/**
 * The ONLY way upload state changes. Pure and total: every event yields a
 * valid snapshot, a terminal phase is never walked back into a busy one by a
 * late event (a stale progress sample after `succeeded` cannot resurrect the
 * bar), and `percent` can never exceed 100.
 */
export function reduceUploadState(
  state: UploadStateSnapshot | null | undefined,
  event: UploadStateEvent
): UploadStateSnapshot {
  const current = state ?? initialUploadState();
  switch (event.type) {
    case "start": {
      const totalBytes =
        typeof event.totalBytes === "number" && Number.isFinite(event.totalBytes) && event.totalBytes > 0
          ? event.totalBytes
          : 0;
      const started: UploadStateSnapshot = {
        ...current,
        phase: "preparing",
        fileName: event.fileName ?? null,
        failure: null,
        timings: withTimings(emptyUploadTimings(), event.timings),
      };
      // The bar starts at 0% with the real file size as its total: an honest
      // "nothing has moved yet", never a guessed percentage.
      return withProgress(started, emptyUploadProgress(totalBytes));
    }
    case "stage": {
      const phase = phaseForUploadStage(event.stage);
      // A late stage callback must not undo a terminal phase.
      if (current.phase === "succeeded" || current.phase === "failed") return current;
      return { ...current, phase };
    }
    case "progress": {
      if (current.phase === "succeeded" || current.phase === "failed") return current;
      // Progress only means something while bytes are moving.
      if (current.phase !== "uploading" && current.phase !== "confirming") {
        return withProgress({ ...current, phase: "uploading" }, makeUploadProgress(event.loadedBytes, event.totalBytes));
      }
      return withProgress(current, makeUploadProgress(event.loadedBytes, event.totalBytes));
    }
    case "buffered": {
      if (current.phase === "succeeded" || current.phase === "failed") return current;
      // The file size is known but the byte counter is NOT (the buffered
      // endpoint is a plain multipart POST), so `computable` stays false: the
      // panel renders an indeterminate bar and says why, instead of showing a
      // percentage nothing ever measured.
      const total =
        typeof event.totalBytes === "number" && Number.isFinite(event.totalBytes) && event.totalBytes > 0
          ? event.totalBytes
          : current.progress.totalBytes;
      return withProgress({ ...current, phase: "uploading" }, {
        loadedBytes: 0,
        totalBytes: total,
        percent: 0,
        computable: false,
      });
    }
    case "succeeded": {
      const progress = current.progress.computable
        ? makeUploadProgress(current.progress.totalBytes, current.progress.totalBytes)
        : current.progress;
      return {
        ...withProgress({ ...current, phase: "succeeded", failure: null }, progress),
        timings: withTimings(current.timings, event.timings),
      };
    }
    case "failed": {
      // The last honest byte count stays on screen next to the failure, so the
      // admin can see HOW FAR the upload got (0% = it never started moving).
      return {
        ...current,
        phase: "failed",
        failure: event.failure ?? null,
        timings: withTimings(current.timings, event.timings),
      };
    }
    case "cancelled":
      return initialUploadState();
    case "reset":
      return initialUploadState();
    default:
      return current;
  }
}

// ---------------------------------------------------------------------------
// Duplicate-submission guard
// ---------------------------------------------------------------------------

/**
 * A synchronous single-flight latch.
 *
 * `disabled={busy}` on a button is NOT enough: React state is applied on the
 * next render, so two clicks inside the same tick both see `busy === false`
 * and both would start an init → PUT → complete cycle (two presigned grants,
 * two objects, two rows). The latch is taken SYNCHRONOUSLY at the top of the
 * run, so the second caller is refused before any request exists.
 */
export function createUploadRunGuard() {
  let busy = false;
  return {
    /** True when the caller may proceed (and now owns the latch). */
    acquire(): boolean {
      if (busy) return false;
      busy = true;
      return true;
    },
    release(): void {
      busy = false;
    },
    isBusy(): boolean {
      return busy;
    },
  };
}

export type UploadRunGuard = ReturnType<typeof createUploadRunGuard>;

// ---------------------------------------------------------------------------
// Safe diagnostics (Step 5) — durations only
// ---------------------------------------------------------------------------

/**
 * One dev-only console line per upload answering "WHICH leg was slow?":
 * prepare (browser hashing) / init / transfer (browser → storage) / complete
 * (verification + row writes) / total.
 *
 * Prints DURATIONS, the purpose, the byte size and the outcome phase ONLY.
 * No presigned URL, no token, no storage key, no bucket or account value, no
 * cookie, no user identity. A no-op in production builds.
 */
export function logUploadTimings(entry: {
  purpose?: string | null;
  phase?: UploadPhase | string | null;
  bytes?: number | null;
  timings?: UploadTimings | UploadLegTimings | null;
}): void {
  if (typeof process !== "undefined" && process.env && process.env.NODE_ENV === "production") return;
  const t = entry.timings ?? emptyUploadTimings();
  const round = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? Math.round(n) : 0);
  console.debug(
    "[media-upload]",
    JSON.stringify({
      purpose: String(entry.purpose ?? ""),
      phase: String(entry.phase ?? ""),
      mb: Math.round(((typeof entry.bytes === "number" && Number.isFinite(entry.bytes) ? entry.bytes : 0) / 1048576) * 10) / 10,
      prepareMs: round((t as UploadTimings).prepareMs),
      initMs: round(t.initMs),
      transferMs: round(t.transferMs),
      completeMs: round(t.completeMs),
      totalMs: round(t.totalMs),
    })
  );
}
