// CodeMind Academy — Phase G: homework file contract.
//
// THE ONE PLACE that defines which files may ride on the Homework workflow:
//
//   * the TEACHER's assignment attachment (PDF / DOCX / PPTX / ZIP),
//   * the STUDENT's submission file     (PDF / DOCX / JPG / JPEG / PNG / ZIP),
//
// both capped at 25 MB per file.
//
// Everything here is pure validation — byte movement, storage keys, presigned
// grants and authorization stay where they already live (src/lib/media.ts,
// src/lib/media-upload.ts, the routes). This module only answers: "is this
// file admissible for this homework role, and how do we prove it?"
//
// DOCUMENTED WIDENING (Phase G discovery report)
// ----------------------------------------------
// The pre-G private-media infrastructure admitted exactly ONE document type:
// application/pdf, proven by the `%PDF-` header. Phase G widens the document
// allow-list to OOXML office files, ZIP archives and two image types because
// the product requires them. Consequences, deliberately accepted:
//
//   * DOCX / PPTX / ZIP share the ZIP container signature (`PK\x03\x04`).
//     Magic verification can therefore prove "ZIP container family" but not
//     the exact OOXML flavour — the extension + declared MIME select the
//     flavour, the magic bytes reject everything that is not even a ZIP.
//   * No executable/script type is admissible: the allow-lists below contain
//     no .exe/.msi/.js/.html/.svg/.php or any double-extension bearer — the
//     extension check reads the FINAL extension of the sanitized name only.
//   * Delivery stays private-by-construction: unguessable server-generated
//     keys, no public bucket path, downloads only through the authorized
//     /api/media/[id] proxy with `Content-Disposition: attachment` and
//     `X-Content-Type-Options: nosniff` — a stored file is never executed or
//     rendered by the platform.
//   * PDF / JPEG / PNG keep FULL magic-byte verification (stable signatures).

/** 25 MB per file — fixed by the Phase G product decision. */
export const MAX_HOMEWORK_FILE_BYTES = Number(
  process.env.MEDIA_MAX_HOMEWORK_FILE_BYTES || 25 * 1024 * 1024
);

/** The two homework file roles. */
export type HomeworkFileRole = "TEACHER_ATTACHMENT" | "STUDENT_SUBMISSION";

/** Canonical MIME types, keyed by final extension (lowercase, no dot). */
const HOMEWORK_MIME_BY_EXT: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

/** Extensions admissible per role (final extension of the sanitized name). */
const ROLE_ALLOWED_EXTENSIONS: Record<HomeworkFileRole, readonly string[]> = {
  TEACHER_ATTACHMENT: ["pdf", "docx", "pptx", "zip"],
  STUDENT_SUBMISSION: ["pdf", "docx", "jpg", "jpeg", "png", "zip"],
};

/** Strip parameters and lowercase — same contract as media.ts. */
function normalizeMime(raw: unknown): string {
  return String(raw ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

/** Final extension of a filename (already sanitized by the caller). */
export function homeworkFileExtension(filename: string): string | null {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(filename ?? ""));
  return m ? m[1].toLowerCase() : null;
}

/** Is this declared MIME admissible for the given homework file role? */
export function isAllowedHomeworkFileMime(
  role: HomeworkFileRole,
  mime: unknown
): boolean {
  const m = normalizeMime(mime);
  if (!m) return false;
  return ROLE_ALLOWED_EXTENSIONS[role].some(
    (ext) => HOMEWORK_MIME_BY_EXT[ext] === m
  );
}

/** Is this (sanitized) filename's final extension admissible for the role? */
export function hasAllowedHomeworkFileExtension(
  role: HomeworkFileRole,
  filename: string
): boolean {
  const ext = homeworkFileExtension(filename);
  return ext !== null && ROLE_ALLOWED_EXTENSIONS[role].includes(ext);
}

/** The canonical extension for a declared MIME (for server-generated keys). */
export function extFromHomeworkFileMime(role: HomeworkFileRole, mime: unknown): string | null {
  const m = normalizeMime(mime);
  if (!m) return null;
  // Prefer role order so image/jpeg resolves to "jpg" for submissions.
  for (const ext of ROLE_ALLOWED_EXTENSIONS[role]) {
    if (HOMEWORK_MIME_BY_EXT[ext] === m) return ext;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Magic bytes
// ---------------------------------------------------------------------------

const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]); // "PK\x03\x04"
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function startsWith(buf: Buffer, magic: Buffer, window: number): boolean {
  if (buf.length < magic.length) return false;
  const max = Math.min(buf.length - magic.length, window);
  for (let i = 0; i <= max; i++) {
    if (buf.subarray(i, i + magic.length).equals(magic)) return true;
  }
  return false;
}

/** PDF header `%PDF-` within the first KB (same tolerance as media.ts). */
export function hasPdfMagic(buf: Buffer): boolean {
  return startsWith(buf, Buffer.from("%PDF-"), 1024);
}

/** ZIP container signature `PK\x03\x04` at the very start. */
export function hasZipMagic(buf: Buffer): boolean {
  return buf.length >= 4 && buf.subarray(0, 4).equals(ZIP_MAGIC);
}

/** JPEG SOI marker `FF D8 FF` at the very start. */
export function hasJpegMagic(buf: Buffer): boolean {
  return (
    buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
  );
}

/** PNG 8-byte signature at the very start. */
export function hasPngMagic(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_MAGIC);
}

/**
 * Magic-byte predicate for the head of a stored/buffered object, per role and
 * declared MIME. Used by BOTH the presigned completion verifier and the
 * buffered routes so one rule proves the bytes everywhere.
 */
export function verifyHomeworkFileMagicBytes(
  role: HomeworkFileRole,
  mime: unknown,
  head: Buffer
): boolean {
  const m = normalizeMime(mime);
  if (!isAllowedHomeworkFileMime(role, m)) return false;
  switch (m) {
    case "application/pdf":
      return hasPdfMagic(head);
    case "image/jpeg":
      return hasJpegMagic(head);
    case "image/png":
      return hasPngMagic(head);
    case "application/zip":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return hasZipMagic(head);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Buffered validation (local dev fallback + student multipart path)
// ---------------------------------------------------------------------------

export type HomeworkFileValidationFailure =
  | "EMPTY"
  | "TOO_LARGE"
  | "EXTENSION_REJECTED"
  | "MIME_REJECTED"
  | "MAGIC_REJECTED";

export type HomeworkFileValidation =
  | { ok: true; sizeBytes: number; mimeType: string; originalName: string; extension: string }
  | { ok: false; code: HomeworkFileValidationFailure; message: string };

/**
 * Full buffered validation of a homework file: the caller MUST pass the real
 * bytes — a claimed MIME/extension without matching magic bytes is rejected.
 * `sanitizeOriginalFilename` (src/lib/media.ts) must already have been applied
 * to `originalName`; this function never trusts a raw client name.
 */
export function validateHomeworkFile(input: {
  role: HomeworkFileRole;
  buffer: Buffer | Uint8Array | null | undefined;
  claimedMime?: string | null;
  originalName: string;
  maxBytes?: number;
}): HomeworkFileValidation {
  const max =
    typeof input.maxBytes === "number" && input.maxBytes > 0
      ? input.maxBytes
      : MAX_HOMEWORK_FILE_BYTES;
  const buf = input.buffer
    ? Buffer.isBuffer(input.buffer)
      ? input.buffer
      : Buffer.from(input.buffer)
    : null;

  if (!buf || buf.length === 0) {
    return { ok: false, code: "EMPTY", message: "Empty file" };
  }
  if (buf.length > max) {
    return { ok: false, code: "TOO_LARGE", message: "File exceeds the 25 MB limit" };
  }
  if (!hasAllowedHomeworkFileExtension(input.role, input.originalName)) {
    return {
      ok: false,
      code: "EXTENSION_REJECTED",
      message: "File type not allowed for homework files",
    };
  }
  const claimed = normalizeMime(input.claimedMime);
  if (claimed && !isAllowedHomeworkFileMime(input.role, claimed)) {
    return {
      ok: false,
      code: "MIME_REJECTED",
      message: "MIME type not allowed for homework files",
    };
  }
  // A missing Content-Type is tolerated only when the extension is admissible
  // (multipart clients sometimes omit it); the RESOLVED mime is canonical.
  const ext = homeworkFileExtension(input.originalName)!;
  const mimeType = claimed || HOMEWORK_MIME_BY_EXT[ext];
  if (!verifyHomeworkFileMagicBytes(input.role, mimeType, buf)) {
    return {
      ok: false,
      code: "MAGIC_REJECTED",
      message: "File content does not match its type",
    };
  }
  return {
    ok: true,
    sizeBytes: buf.length,
    mimeType,
    originalName: input.originalName,
    extension: ext,
  };
}
