// CodeMind Academy — Admin upload error → specific reason (isomorphic).
//
// The direct-upload flow reports WHICH leg failed (`stage`) and, when the
// server rejected the request, a machine `code`. Showing only the stage left
// admins with one generic "تعذّر بدء الرفع. حاول تاني." for every possible
// cause — wrong file type, oversize file, storage outage, wrong session — so
// the only available response was to retry blindly.
//
// This maps a server code onto a dictionary key that names the ACTUAL cause.
// One definition shared by every admin upload screen (session videos, lesson
// PDFs) so the same failure always reads the same way.
//
// `resolveUploadFailure` (below) is the single place that turns a failed leg
// into what the UI shows: the stage message, the specific reason when the
// server gave one, a distinct message for a pure network failure, and whether
// retrying the SAME file can help.

import type { UploadFailure, UploadStageName } from "./upload-progress";

/** Server error codes returned by /api/admin/media-uploads/{init,complete}. */
const CODE_TO_KEY: Record<string, string> = {
  // Input problems — the admin can fix these and retry immediately.
  INVALID_CONTENT_TYPE: "admin.534",
  UNSUPPORTED_PURPOSE: "admin.534",
  MIME_MISMATCH: "admin.534",
  INVALID_SIZE: "admin.535",
  QUOTA_EXCEEDED: "admin.535",
  PDF_TOO_LARGE: "admin.535",
  TOO_LARGE: "admin.535",
  PDF_MIME_REJECTED: "admin.534",
  PDF_EXTENSION_REJECTED: "admin.534",
  PDF_MAGIC_REJECTED: "admin.534",
  PDF_EMPTY: "admin.534",
  // PDF content verification at the complete leg (stored object re-checked).
  MAGIC_REJECTED: "admin.574",
  EXTENSION_REJECTED: "admin.575",
  EMPTY_OBJECT: "admin.576",
  SHA256_MISMATCH: "admin.577",
  SHA256_INVALID: "admin.577",
  VERIFICATION_FAILED: "admin.577",
  MISSING_OBJECT: "admin.577",
  // The signed grant is single-use and short-lived: start the upload again.
  INTENT_EXPIRED: "admin.578",
  INTENT_INVALID: "admin.578",
  INTENT_BAD_SIGNATURE: "admin.578",
  INTENT_USER_MISMATCH: "admin.578",
  ALREADY_LINKED: "admin.579",
  // Completion payload validation the admin can fix in the form.
  TITLE_REQUIRED: "admin.580",
  // Infrastructure — retrying may help, but it is not the admin's input.
  STORAGE_UNAVAILABLE: "admin.536",
  DB_UNAVAILABLE: "admin.536",
  DB_CREATE_FAILED: "admin.536",
  // Target selection — the admin must pick a different session/group.
  BATCH_NOT_FOUND: "admin.537",
  LESSON_NOT_FOUND: "admin.537",
  LESSON_ARCHIVED: "admin.537",
  // Academic link contract (Phase A) — the video's Lesson × Batch identity.
  // LESSON_REQUIRED has its own reason because the picker itself is the fix.
  LESSON_REQUIRED: "admin.583",
  COURSE_MISMATCH: "admin.584",
  TRACK_MISMATCH: "admin.585",
};

/** Stage → the message that names the leg (used when no code mapped). */
const STAGE_TO_KEY: Record<UploadStageName | "buffered", string> = {
  init: "admin.506", // تعذّر بدء الرفع. حاول تاني.
  transfer: "admin.507", // فشل رفع الملف للتخزين. حاول تاني.
  complete: "admin.508", // تعذّر تأكيد الرفع — الملف ما اتخزنش.
  buffered: "admin.507",
};

/**
 * Dictionary key for a server upload error code, or `null` when the code
 * carries no specific meaning (the caller then falls back to its stage text).
 *
 * Returns a KEY, not a translated string: the caller owns the locale via its
 * own `useT()`, which keeps this module free of React and server-only i18n.
 */
export function uploadErrorCodeKey(code: string | null | undefined): string | null {
  if (!code || typeof code !== "string") return null;
  return CODE_TO_KEY[code] ?? null;
}

/** Dictionary key naming the failing leg. */
export function uploadStageMessageKey(stage: UploadStageName | "buffered" | string | null | undefined): string {
  return STAGE_TO_KEY[String(stage) as UploadStageName] ?? "admin.506";
}

/** True when a failed upload is worth retrying unchanged. */
export function isUploadCodeRetriable(code: string | null | undefined): boolean {
  if (!code) return false;
  return (
    code === "STORAGE_UNAVAILABLE" ||
    code === "DB_UNAVAILABLE" ||
    code === "DB_CREATE_FAILED" ||
    // A corrupted / vanished object is a transport accident, not a bad file:
    // the same file uploaded again is expected to succeed.
    code === "SHA256_MISMATCH" ||
    code === "VERIFICATION_FAILED" ||
    code === "MISSING_OBJECT" ||
    // An expired or rejected grant is replaced by a fresh init on retry.
    code === "INTENT_EXPIRED" ||
    code === "INTENT_INVALID" ||
    code === "INTENT_BAD_SIGNATURE"
  );
}

export type UploadFailureInput = {
  stage: UploadStageName | "buffered" | string;
  status?: number | null;
  code?: string | null;
  /** Server-provided text (may be a machine code or an English literal). */
  error?: string | null;
  cancelled?: boolean | null;
};

/** True when the failure happened without ever reaching the server. */
function isNetworkFailure(status: number): boolean {
  return status === 0;
}

/**
 * Turn one failed upload leg into the exact thing the admin is shown.
 *
 * Precedence (highest first):
 *   1. cancellation — not an error at all (`cancelled: true`);
 *   2. a pure network failure (status 0) — one clear retryable message, the
 *      same on every screen;
 *   3. a server code with a mapped reason — the SPECIFIC cause, and the raw
 *      server text is deliberately dropped: for infrastructure codes it can
 *      carry storage/DB internals that are not the admin's business;
 *   4. the stage message, plus the raw server text for the init/complete legs
 *      only (contract messages such as `LESSON_ARCHIVED` stay readable). The
 *      transfer leg never appends raw text: there is nothing useful in it.
 */
export function resolveUploadFailure(input: UploadFailureInput): UploadFailure {
  const stage = (String(input.stage) as UploadStageName | "buffered") || "init";
  const status = typeof input.status === "number" && Number.isFinite(input.status) ? input.status : 0;
  const code = typeof input.code === "string" && input.code ? input.code : null;
  const error = typeof input.error === "string" && input.error ? input.error : null;
  const cancelled = input.cancelled === true || code === "ABORTED";

  if (cancelled) {
    return {
      stage,
      code,
      status,
      messageKey: "admin.569", // تم إلغاء الرفع
      reasonKey: null,
      detail: null,
      rawError: null,
      retriable: false,
      network: false,
      cancelled: true,
    };
  }

  if (isNetworkFailure(status)) {
    return {
      stage,
      code,
      status,
      messageKey: "admin.567", // تعذّر الاتصال بخدمة الرفع — راجع اتصال الإنترنت
      reasonKey: null,
      detail: null,
      rawError: stage === "buffered" ? error : null,
      retriable: true,
      network: true,
      cancelled: false,
    };
  }

  const reasonKey = uploadErrorCodeKey(code);
  if (reasonKey) {
    return {
      stage,
      code,
      status,
      messageKey: reasonKey,
      reasonKey,
      detail: null,
      rawError: null,
      retriable: isUploadCodeRetriable(code),
      network: false,
      cancelled: false,
    };
  }

  const messageKey = uploadStageMessageKey(stage);
  // A storage-side 403 on the transfer leg means the short-lived grant was
  // rejected or expired — a fresh init replaces it, so retrying does help.
  const grantRejected = stage === "transfer" && status === 403;
  // Only the app's own legs carry text worth appending: contract messages such
  // as `LESSON_ARCHIVED` or a localized sentence. The buffered fallback keeps
  // its text in `rawError` instead, and the transfer leg has nothing useful.
  const showDetail =
    (stage === "init" || stage === "complete") && !!error && error !== "admin.001";
  return {
    stage,
    code,
    status,
    messageKey,
    reasonKey: null,
    detail: showDetail ? error : null,
    rawError: stage === "buffered" ? error : null,
    // 5xx on the app's own legs is transient, and a rejected/expired storage
    // grant is replaced by a fresh init — both are worth retrying. A 4xx
    // without a known code is not something the admin can fix by repeating the
    // same request.
    retriable: status >= 500 || grantRejected,
    network: false,
    cancelled: false,
  };
}

/**
 * The exact string an admin toast/panel shows for one resolved failure.
 *
 * `tr` is the caller's own translator, so this stays free of React and of the
 * server-only i18n layer. Order: the buffered endpoint's own (already
 * localized) text wins; otherwise the resolved message key, with the server's
 * contract text appended when it adds information. A missing dictionary entry
 * can never render an empty toast — it falls back to the generic admin.001.
 */
export function uploadFailureMessage(
  failure: UploadFailure,
  tr: (key: string, params?: Record<string, unknown>) => string
): string {
  const raw = failure.rawError;
  if (raw && raw !== "admin.001") return raw;
  const base = tr(failure.messageKey);
  if (!base) return tr("admin.001");
  return failure.detail ? `${base} — ${failure.detail}` : base;
}
