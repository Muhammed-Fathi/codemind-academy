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

/** Server error codes returned by /api/admin/media-uploads/{init,complete}. */
const CODE_TO_KEY: Record<string, string> = {
  // Input problems — the admin can fix these and retry immediately.
  INVALID_CONTENT_TYPE: "admin.534",
  UNSUPPORTED_PURPOSE: "admin.534",
  INVALID_SIZE: "admin.535",
  QUOTA_EXCEEDED: "admin.535",
  PDF_TOO_LARGE: "admin.535",
  PDF_MIME_REJECTED: "admin.534",
  PDF_EXTENSION_REJECTED: "admin.534",
  PDF_MAGIC_REJECTED: "admin.534",
  PDF_EMPTY: "admin.534",
  // Infrastructure — retrying may help, but it is not the admin's input.
  STORAGE_UNAVAILABLE: "admin.536",
  DB_UNAVAILABLE: "admin.536",
  DB_CREATE_FAILED: "admin.536",
  // Target selection — the admin must pick a different session/group.
  BATCH_NOT_FOUND: "admin.537",
  LESSON_NOT_FOUND: "admin.537",
  LESSON_ARCHIVED: "admin.537",
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

/** True when a failed upload is worth retrying unchanged. */
export function isUploadCodeRetriable(code: string | null | undefined): boolean {
  if (!code) return false;
  return (
    code === "STORAGE_UNAVAILABLE" ||
    code === "DB_UNAVAILABLE" ||
    code === "DB_CREATE_FAILED"
  );
}
