"use client";

// CodeMind Academy — browser-side presigned direct-upload helper (Phase 23).
//
// Runs in the ADMIN UI only. Implements the three legs of the direct flow:
//   1. POST  /api/admin/media-uploads/init    (session-authenticated)
//   2. PUT   <uploadUrl>                      (direct to PRIVATE R2 — the URL
//                                             is a short-lived signed grant;
//                                             it contains NO credential)
//   3. POST  /api/admin/media-uploads/complete (session-authenticated)
//
// HARD RULES:
//   * No R2 credentials, endpoints, or bucket names are EVER constructed or
//     stored here — the only URL used is the one the init endpoint returned.
//   * The storage key is never known to this module (the server keeps it in
//     the signed token).
//   * The Content-Type sent on the PUT is the one the server granted, byte
//     for byte — the server re-verifies the stored object's type at complete
//     and discards the upload on any mismatch.
//   * `PRESIGNED_UNSUPPORTED` surfaces as a typed outcome so callers can fall
//     back to the buffered endpoints on MEDIA_BACKEND=local deployments.
//
// MEDIA UPLOAD UX (this file's second job):
//   * Leg 2 reports REAL byte progress. `fetch()` cannot observe an upload
//     body in flight, so the transfer runs over `XMLHttpRequest` — the
//     smallest mechanism that exposes `upload.onprogress` — with the original
//     `fetch` shape kept as the fallback for runtimes that have no XHR (Node,
//     SSR, tests). Same PUT, same presigned URL, same granted Content-Type,
//     same cookie behaviour (XHR `withCredentials` defaults to false, exactly
//     like fetch's default "same-origin" for a cross-origin request), same
//     CORS preflight, same typed failure outcomes.
//   * Every leg is timed and the durations are returned on the outcome, so
//     "the upload felt slow" can be attributed to init / transfer / complete
//     instead of guessed at. Durations only — never a URL, token or key.
//   * An `AbortSignal` cancels the flow; a cancellation is a typed outcome
//     (`cancelled: true`), never an exception and never a fake error toast.

import {
  emptyUploadLegTimings,
  makeUploadProgress,
  type UploadLegTimings,
  type UploadProgress,
} from "./upload-progress";

export type DirectUploadStage = "init" | "transfer" | "complete";

export type DirectUploadOutcome =
  | { ok: true; data: Record<string, unknown>; timings: UploadLegTimings }
  | {
      ok: false;
      stage: DirectUploadStage;
      /** HTTP status of the failing leg (0 = network error or cancellation). */
      status: number;
      /** Server-provided message (machine codes stay verbatim). */
      error: string;
      /** Machine-readable server code, e.g. PRESIGNED_UNSUPPORTED. */
      code: string | null;
      /** true when simply retrying the whole flow may succeed. */
      retriable: boolean;
      /** true when the admin cancelled — not an error. */
      cancelled?: boolean;
      /** Per-leg durations in ms (diagnostics; contains no URL/token/key). */
      timings: UploadLegTimings;
    };

type UploadInitPayload = {
  uploadUrl: string;
  method: string;
  token: string;
  contentType: string;
  maxBytes: number;
  expiresInSec: number;
  expiresAt: string;
  purpose: string;
};

function nowMs(): number {
  return Date.now();
}

async function postJson(
  url: string,
  body: Record<string, unknown>,
  signal?: AbortSignal | null
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    });
  } catch {
    return { status: 0, data: null };
  }
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, data };
}

function failure(
  stage: DirectUploadStage,
  status: number,
  data: Record<string, unknown> | null,
  fallback: string,
  retriable: boolean,
  timings: UploadLegTimings,
  cancelled?: boolean
): DirectUploadOutcome {
  const error =
    data && typeof data.error === "string" && data.error ? data.error : fallback;
  const code =
    data && typeof data.code === "string" && data.code
      ? data.code
      : cancelled
        ? "ABORTED"
        : null;
  return { ok: false, stage, status, error, code, retriable, timings, ...(cancelled ? { cancelled: true } : {}) };
}

/**
 * Optional browser-side SHA-256 (hex) of the file — sent to complete so the
 * server can verify integrity by streaming the stored object. Returns null
 * when WebCrypto is unavailable or the file is too large to hash in-browser
 * (the server simply skips the check when absent).
 */
export async function sha256HexOfFile(file: File): Promise<string | null> {
  try {
    // Above this size we will not buffer the file in the tab just to hash it.
    if (file.size > 256 * 1024 * 1024) return null;
    if (!globalThis.crypto?.subtle) return null;
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      await file.arrayBuffer()
    );
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  } catch {
    return null;
  }
}

export type DirectUploadInput = {
  purpose: "SESSION_VIDEO" | "LESSON_PDF";
  file: File;
  /** Purpose-specific init fields (e.g. batchId / lessonId). */
  initFields?: Record<string, unknown>;
  /** Purpose-specific completion fields (e.g. title / trackScope / publish). */
  completeFields?: Record<string, unknown>;
  /** Optional browser-computed integrity hash (see sha256HexOfFile). */
  sha256?: string | null;
  /** Progress callback for UI state. */
  onStage?: (stage: DirectUploadStage) => void;
  /**
   * REAL byte progress of leg 2 (the PUT). Fired only from transport events —
   * never from a timer — and only while bytes are actually moving.
   */
  onProgress?: (progress: UploadProgress) => void;
  /** Cancels the whole flow (see `cancelled` on the failure outcome). */
  signal?: AbortSignal | null;
  initEndpoint?: string;
  completeEndpoint?: string;
};

/**
 * Read the upload grant out of an init response.
 *
 * THE WIRE CONTRACT: `/api/admin/media-uploads/init` answers
 * `ok(result.init)` — `NextResponse.json(init)` — so the grant fields sit at the
 * TOP LEVEL of the body:
 *
 *   { uploadUrl, method, token, contentType, maxBytes, expiresInSec, expiresAt, purpose }
 *
 * This used to be read as `body.upload`, a shape the endpoint has never
 * produced. Every real (MEDIA_BACKEND=s3) upload therefore failed at the init
 * leg with a 200 response, surfacing to the admin as "تعذّر بدء الرفع" even
 * though the server had issued a perfectly valid presigned URL. Under
 * MEDIA_BACKEND=local the endpoint answers 409 PRESIGNED_UNSUPPORTED first, so
 * the client fell back to the buffered path and the defect stayed invisible in
 * development — which is exactly why it only ever appeared in production.
 *
 * Both shapes are accepted: the documented top-level contract, and a nested
 * `upload` wrapper, so a future server that namespaces the payload cannot
 * silently break uploads again.
 */
function extractUploadGrant(
  data: Record<string, unknown> | null
): UploadInitPayload | null {
  if (!data) return null;
  const candidate =
    data.upload && typeof data.upload === "object"
      ? (data.upload as Record<string, unknown>)
      : data;
  const { uploadUrl, method, token, contentType, maxBytes, expiresInSec, expiresAt } =
    candidate as Partial<UploadInitPayload>;
  // A grant is only usable with a URL to PUT to and a token to finalize with.
  if (typeof uploadUrl !== "string" || !uploadUrl) return null;
  if (typeof token !== "string" || !token) return null;
  return {
    uploadUrl,
    method: typeof method === "string" && method ? method : "PUT",
    token,
    contentType: typeof contentType === "string" ? contentType : "",
    maxBytes: typeof maxBytes === "number" ? maxBytes : 0,
    expiresInSec: typeof expiresInSec === "number" ? expiresInSec : 0,
    expiresAt: typeof expiresAt === "string" ? expiresAt : "",
    purpose:
      typeof candidate.purpose === "string" ? (candidate.purpose as string) : "",
  };
}

// ---------------------------------------------------------------------------
// Leg 2 transport — REAL progress (XHR) with the original fetch as fallback
// ---------------------------------------------------------------------------

type TransferOutcome = {
  status: number;
  ok: boolean;
  /** The request never reached the storage endpoint (offline / DNS / blocked). */
  networkError: boolean;
  /** The admin cancelled mid-transfer. */
  aborted: boolean;
};

/** True when the runtime can observe upload byte progress. */
function canObserveUploadProgress(): boolean {
  return typeof XMLHttpRequest !== "undefined";
}

function sizeOfFile(file: File | null | undefined): number {
  return file && typeof file.size === "number" && Number.isFinite(file.size) && file.size > 0
    ? file.size
    : 0;
}

/**
 * PUT the file to the presigned URL over XMLHttpRequest.
 *
 * WHY XHR AND NOT fetch: `fetch` has no upload-progress event, so a 500 MB
 * video showed one spinner for minutes with no way to tell "slow" from
 * "stuck". XHR exposes `xhr.upload.onprogress`, whose `loaded` is the number
 * of bytes the browser has actually written to the network — real progress,
 * not an estimate and not a timer.
 *
 * Everything security-relevant is unchanged: the URL and method come from the
 * server's grant, the granted Content-Type is sent byte for byte, and the
 * request carries no cookie (XHR `withCredentials` is false by default, which
 * is what the cross-origin presigned PUT must be — the same behaviour fetch's
 * default "same-origin" credentials mode gives).
 */
function putBytesWithProgress(
  upload: UploadInitPayload,
  file: File,
  opts: { signal: AbortSignal | null; onProgress: (loaded: number, total: number) => void }
): Promise<TransferOutcome> {
  return new Promise<TransferOutcome>((resolve) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (outcome: TransferOutcome) => {
      if (settled) return;
      settled = true;
      if (opts.signal) opts.signal.removeEventListener("abort", onSignalAbort);
      resolve(outcome);
    };
    function onSignalAbort() {
      try {
        xhr.abort();
      } catch {
        // Already finished — nothing to cancel.
      }
    }

    if (opts.signal) {
      if (opts.signal.aborted) {
        finish({ status: 0, ok: false, networkError: false, aborted: true });
        return;
      }
      opts.signal.addEventListener("abort", onSignalAbort, { once: true });
    }

    const fallbackTotal = sizeOfFile(file);
    xhr.upload.onprogress = (event: ProgressEvent) => {
      // `lengthComputable` is false when the transport cannot state a total;
      // fall back to the file size we already know, and never guess.
      const total = event.lengthComputable && event.total > 0 ? event.total : fallbackTotal;
      opts.onProgress(event.loaded, total);
    };
    // loadend fires for success, error AND abort — the settled latch keeps the
    // first (most specific) outcome and drops the rest.
    xhr.onerror = () => finish({ status: 0, ok: false, networkError: true, aborted: false });
    xhr.ontimeout = () => finish({ status: 0, ok: false, networkError: true, aborted: false });
    xhr.onabort = () => finish({ status: 0, ok: false, networkError: false, aborted: true });
    xhr.onloadend = () => {
      const status = typeof xhr.status === "number" ? xhr.status : 0;
      finish({
        status,
        ok: status >= 200 && status < 300,
        networkError: status === 0,
        aborted: false,
      });
    };

    xhr.open(upload.method || "PUT", upload.uploadUrl, true);
    // The signed grant covers exactly this Content-Type; sending any other
    // value makes the storage endpoint reject the PUT.
    xhr.setRequestHeader("Content-Type", upload.contentType);
    xhr.send(file);
  });
}

/**
 * The original transfer shape, kept for runtimes without XMLHttpRequest
 * (Node, SSR, the offline test suites). Progress is not observable here, so
 * callers show an indeterminate transfer instead of inventing a percentage.
 */
async function putBytesWithFetch(
  upload: UploadInitPayload,
  file: File,
  signal: AbortSignal | null
): Promise<TransferOutcome> {
  try {
    const put = await fetch(upload.uploadUrl, {
      method: upload.method || "PUT",
      headers: { "Content-Type": upload.contentType },
      body: file,
      ...(signal ? { signal } : {}),
    });
    return { status: put.status, ok: put.ok, networkError: false, aborted: false };
  } catch {
    return {
      status: 0,
      ok: false,
      networkError: true,
      aborted: signal ? signal.aborted === true : false,
    };
  }
}

/**
 * Run the full direct-upload flow. Never throws — every failure is a typed
 * outcome with the failing stage.
 */
export async function directUpload(
  input: DirectUploadInput
): Promise<DirectUploadOutcome> {
  const initEndpoint = input.initEndpoint ?? "/api/admin/media-uploads/init";
  const completeEndpoint =
    input.completeEndpoint ?? "/api/admin/media-uploads/complete";
  const signal = input.signal ?? null;
  const timings = emptyUploadLegTimings();
  const startedAt = nowMs();
  const wasCancelled = () => signal ? signal.aborted === true : false;

  // --- 1. init ---------------------------------------------------------------
  input.onStage?.("init");
  let legStartedAt = nowMs();
  const init = await postJson(
    initEndpoint,
    {
      purpose: input.purpose,
      fileName: input.file.name,
      sizeBytes: input.file.size,
      contentType: input.file.type,
      ...(input.initFields ?? {}),
    },
    signal
  );
  timings.initMs = nowMs() - legStartedAt;
  if (wasCancelled()) {
    timings.totalMs = nowMs() - startedAt;
    return failure("init", 0, null, "Upload cancelled", false, timings, true);
  }
  if (init.status === 0) {
    timings.totalMs = nowMs() - startedAt;
    return failure("init", 0, null, "Could not reach the upload service", true, timings);
  }
  // A rejected init carries { error, code }; the code is what lets callers
  // branch (PRESIGNED_UNSUPPORTED → buffered fallback) and what turns a
  // generic message into a specific admin-facing reason.
  if (init.status >= 400 || !init.data) {
    timings.totalMs = nowMs() - startedAt;
    return failure("init", init.status, init.data, "Could not start the upload", false, timings);
  }
  const upload = extractUploadGrant(init.data);
  if (!upload) {
    timings.totalMs = nowMs() - startedAt;
    return failure("init", init.status, null, "Malformed upload grant", false, timings);
  }

  // --- 2. PUT the bytes straight to storage ----------------------------------
  input.onStage?.("transfer");
  legStartedAt = nowMs();
  const reportProgress = (loaded: number, total: number) => {
    if (!input.onProgress) return;
    input.onProgress(makeUploadProgress(loaded, total > 0 ? total : sizeOfFile(input.file)));
  };
  const transfer = canObserveUploadProgress()
    ? await putBytesWithProgress(upload, input.file, { signal, onProgress: reportProgress })
    : await putBytesWithFetch(upload, input.file, signal);
  timings.transferMs = nowMs() - legStartedAt;

  if (transfer.aborted || wasCancelled()) {
    timings.totalMs = nowMs() - startedAt;
    return failure("transfer", 0, null, "Upload cancelled", false, timings, true);
  }
  if (transfer.networkError) {
    timings.totalMs = nowMs() - startedAt;
    return failure("transfer", 0, null, "Uploading the file to storage failed", true, timings);
  }
  if (!transfer.ok) {
    // 403 from the bucket almost always means the short-lived grant expired
    // or the signed headers were altered — both are fixed by retrying.
    timings.totalMs = nowMs() - startedAt;
    return failure(
      "transfer",
      transfer.status,
      null,
      transfer.status === 403
        ? "The storage upload grant was rejected or expired — retry the upload"
        : "Uploading the file to storage failed",
      transfer.status === 403 || transfer.status >= 500,
      timings
    );
  }

  // --- 3. complete (verify + record) -----------------------------------------
  input.onStage?.("complete");
  legStartedAt = nowMs();
  const complete = await postJson(
    completeEndpoint,
    {
      token: upload.token,
      originalName: input.file.name,
      ...(input.sha256 ? { sha256: input.sha256 } : {}),
      ...(input.completeFields ?? {}),
    },
    signal
  );
  timings.completeMs = nowMs() - legStartedAt;
  timings.totalMs = nowMs() - startedAt;
  if (wasCancelled()) {
    return failure("complete", 0, null, "Upload cancelled", false, timings, true);
  }
  if (complete.status === 0) {
    return failure("complete", 0, null, "Could not reach the upload service", true, timings);
  }
  if (complete.status >= 400) {
    return failure("complete", complete.status, complete.data, "Could not finalize the upload", complete.status >= 500, timings);
  }
  return { ok: true, data: complete.data ?? {}, timings };
}
