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

export type DirectUploadStage = "init" | "transfer" | "complete";

export type DirectUploadOutcome =
  | { ok: true; data: Record<string, unknown> }
  | {
      ok: false;
      stage: DirectUploadStage;
      /** HTTP status of the failing leg (0 = network error). */
      status: number;
      /** Server-provided message (machine codes stay verbatim). */
      error: string;
      /** Machine-readable server code, e.g. PRESIGNED_UNSUPPORTED. */
      code: string | null;
      /** true when simply retrying the whole flow may succeed. */
      retriable: boolean;
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

async function postJson(
  url: string,
  body: Record<string, unknown>
): Promise<{ status: number; data: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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
  retriable: boolean
): DirectUploadOutcome {
  const error =
    data && typeof data.error === "string" && data.error ? data.error : fallback;
  const code =
    data && typeof data.code === "string" && data.code ? data.code : null;
  return { ok: false, stage, status, error, code, retriable };
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
  initEndpoint?: string;
  completeEndpoint?: string;
};

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

  // --- 1. init ---------------------------------------------------------------
  input.onStage?.("init");
  const init = await postJson(initEndpoint, {
    purpose: input.purpose,
    fileName: input.file.name,
    sizeBytes: input.file.size,
    contentType: input.file.type,
    ...(input.initFields ?? {}),
  });
  if (init.status === 0) {
    return failure("init", 0, null, "Could not reach the upload service", true);
  }
  if (init.status >= 400 || !init.data || typeof (init.data as { upload?: unknown }).upload !== "object") {
    return failure("init", init.status, init.data, "Could not start the upload", false);
  }
  const upload = init.data.upload as unknown as UploadInitPayload;
  if (
    !upload ||
    typeof upload.uploadUrl !== "string" ||
    !upload.uploadUrl ||
    typeof upload.token !== "string" ||
    !upload.token
  ) {
    return failure("init", init.status, null, "Malformed upload grant", false);
  }

  // --- 2. PUT the bytes straight to storage ----------------------------------
  input.onStage?.("transfer");
  let put: Response;
  try {
    put = await fetch(upload.uploadUrl, {
      method: upload.method || "PUT",
      headers: { "Content-Type": upload.contentType },
      body: input.file,
    });
  } catch {
    return failure("transfer", 0, null, "Uploading the file to storage failed", true);
  }
  if (!put.ok) {
    // 403 from the bucket almost always means the short-lived grant expired
    // or the signed headers were altered — both are fixed by retrying.
    return failure(
      "transfer",
      put.status,
      null,
      put.status === 403
        ? "The storage upload grant was rejected or expired — retry the upload"
        : "Uploading the file to storage failed",
      put.status === 403 || put.status >= 500
    );
  }

  // --- 3. complete (verify + record) -----------------------------------------
  input.onStage?.("complete");
  const complete = await postJson(completeEndpoint, {
    token: upload.token,
    originalName: input.file.name,
    ...(input.sha256 ? { sha256: input.sha256 } : {}),
    ...(input.completeFields ?? {}),
  });
  if (complete.status === 0) {
    return failure("complete", 0, null, "Could not reach the upload service", true);
  }
  if (complete.status >= 400) {
    return failure("complete", complete.status, complete.data, "Could not finalize the upload", complete.status >= 500);
  }
  return { ok: true, data: complete.data ?? {} };
}
