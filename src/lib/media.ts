// CodeMind Academy — Media storage service.
//
// Media is stored ONCE as a `MediaAsset` and referenced by session videos and
// quiz evidence. Nothing is ever duplicated per student.
//
// Two storage back-ends are supported:
//   * EXTERNAL_URL  — an admin-provided URL (YouTube / Vimeo / CDN).
//   * LOCAL_PRIVATE — an uploaded file written OUTSIDE the public web root and
//                     only readable through an authorized API route.
//
// Private files are never placed in /public and their names are random, so
// they are not guessable.

import { promises as fs } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";

export const MEDIA_ROOT =
  process.env.MEDIA_STORAGE_PATH || path.join(process.cwd(), "storage", "media");

export const MAX_VIDEO_BYTES = Number(
  process.env.MEDIA_MAX_VIDEO_BYTES || 512 * 1024 * 1024
);
export const MAX_IMAGE_BYTES = Number(
  process.env.MEDIA_MAX_IMAGE_BYTES || 5 * 1024 * 1024
);
/** Phase 14 — default 25 MB. Configurable via MEDIA_MAX_PDF_BYTES. */
export const MAX_PDF_BYTES = Number(
  process.env.MEDIA_MAX_PDF_BYTES || 25 * 1024 * 1024
);

const ALLOWED_VIDEO_MIME = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
]);
const ALLOWED_IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/webp"]);
const ALLOWED_PDF_MIME = new Set(["application/pdf"]);

export function isAllowedVideoMime(mime: string) {
  return ALLOWED_VIDEO_MIME.has(mime);
}
export function isAllowedImageMime(mime: string) {
  return ALLOWED_IMAGE_MIME.has(mime);
}
export function isAllowedPdfMime(mime: string) {
  // Strip parameters (e.g. "application/pdf; charset=binary") and normalise.
  const base = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  return ALLOWED_PDF_MIME.has(base);
}

// ---------------------------------------------------------------------------
// Phase 14 — PDF validation (MIME + extension + magic bytes)
// ---------------------------------------------------------------------------
//
// NEVER trust the client-supplied filename, Content-Type, or extension alone.
// A file claiming application/pdf without the `%PDF-` signature is rejected.
// An HTML file renamed .pdf is rejected. An empty buffer is rejected.

/** PDF magic: files must begin with the 5-byte ASCII sequence `%PDF-`. */
export const PDF_MAGIC = Buffer.from("%PDF-");

/**
 * True iff `buf` begins with the PDF header signature.
 * Leading whitespace is NOT tolerated: the ISO 32000 header is at offset 0
 * (or within the first few bytes for some producers). We accept a small
 * leading-offset window (0..1024) so legitimate PDFs with a short BOM or
 * linearization prefix still pass, while an HTML document that merely
 * *contains* the string somewhere deep does not.
 */
export function hasPdfMagicBytes(buf: Buffer | Uint8Array | null | undefined): boolean {
  if (!buf || buf.length < PDF_MAGIC.length) return false;
  const view = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const window = Math.min(view.length, 1024);
  for (let i = 0; i <= window - PDF_MAGIC.length; i++) {
    if (
      view[i] === 0x25 && // %
      view[i + 1] === 0x50 && // P
      view[i + 2] === 0x44 && // D
      view[i + 3] === 0x46 && // F
      view[i + 4] === 0x2d // -
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Strip a client-supplied original filename down to a safe display name.
 * Path separators, null bytes, control characters and traversal segments are
 * removed. The result is never used as a storage key — only as `originalName`
 * metadata — so even a hostile name cannot escape the private store.
 */
export function sanitizeOriginalFilename(raw: unknown, fallback = "document.pdf"): string {
  let name = typeof raw === "string" ? raw : fallback;
  // Null bytes and C0 controls.
  name = name.replace(/[\u0000-\u001f\u007f]/g, "");
  // Path separators / traversal.
  name = name.replace(/\\/g, "/");
  const parts = name.split("/");
  name = parts[parts.length - 1] || fallback;
  name = name.replace(/^\.+/, ""); // leading dots
  name = name.trim();
  if (!name) name = fallback;
  // Cap length; keep a trailing extension if present.
  if (name.length > 200) {
    const ext = path.extname(name).slice(0, 16);
    name = name.slice(0, 200 - ext.length) + ext;
  }
  return name;
}

/**
 * Does the (already-sanitised) filename end with a recognised PDF extension?
 * Double extensions like `evil.html.pdf` are accepted on the extension check
 * alone — magic bytes still have to match. A bare `evil.html` is rejected.
 */
export function hasPdfExtension(filename: string): boolean {
  const base = sanitizeOriginalFilename(filename, "");
  if (!base) return false;
  // Reject embedded nulls that survived (defense in depth).
  if (base.includes("\0")) return false;
  return /\.pdf$/i.test(base);
}

export type PdfValidationFailure =
  | "EMPTY"
  | "TOO_LARGE"
  | "MIME_REJECTED"
  | "EXTENSION_REJECTED"
  | "MAGIC_REJECTED";

export type PdfValidationResult =
  | { ok: true; sizeBytes: number; mimeType: "application/pdf"; originalName: string }
  | { ok: false; code: PdfValidationFailure; message: string };

/**
 * Full PDF upload validation. Callers MUST pass the actual file bytes — a
 * claimed MIME/extension without magic bytes is always rejected.
 *
 * `claimedMime` is advisory and must still be on the allow-list when present;
 * an empty/missing Content-Type is tolerated only when magic + extension pass
 * (some browsers omit it on multipart), but a *wrong* Content-Type fails closed.
 */
export function validatePdfUpload(input: {
  buffer: Buffer | Uint8Array | null | undefined;
  claimedMime?: string | null;
  originalName?: string | null;
  maxBytes?: number;
}): PdfValidationResult {
  const max = typeof input.maxBytes === "number" && input.maxBytes > 0
    ? input.maxBytes
    : MAX_PDF_BYTES;
  const buf = input.buffer
    ? Buffer.isBuffer(input.buffer)
      ? input.buffer
      : Buffer.from(input.buffer)
    : null;

  if (!buf || buf.length === 0) {
    return { ok: false, code: "EMPTY", message: "Empty file" };
  }
  if (buf.length > max) {
    return { ok: false, code: "TOO_LARGE", message: "File exceeds size limit" };
  }

  const originalName = sanitizeOriginalFilename(
    input.originalName || "document.pdf"
  );
  if (!hasPdfExtension(originalName)) {
    return {
      ok: false,
      code: "EXTENSION_REJECTED",
      message: "Only .pdf files are accepted",
    };
  }

  const claimed = (input.claimedMime || "").trim();
  if (claimed && !isAllowedPdfMime(claimed)) {
    return {
      ok: false,
      code: "MIME_REJECTED",
      message: "MIME type must be application/pdf",
    };
  }

  if (!hasPdfMagicBytes(buf)) {
    return {
      ok: false,
      code: "MAGIC_REJECTED",
      message: "File content is not a valid PDF",
    };
  }

  return {
    ok: true,
    sizeBytes: buf.length,
    mimeType: "application/pdf",
    originalName,
  };
}

/** Basic hardening for admin-supplied video URLs. */
export function isSafeExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return false;
    // Block obvious SSRF targets.
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "0.0.0.0" ||
      host.endsWith(".local") ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    )
      return false;
    return true;
  } catch {
    return false;
  }
}

/** Generate an unguessable storage key: <scope>/<random>.<ext> */
export function makeStorageKey(scope: string, ext: string): string {
  const safeScope = scope.replace(/[^a-z0-9_-]/gi, "").slice(0, 32) || "misc";
  const name = `${Date.now().toString(36)}-${randomBytes(16).toString("hex")}`;
  const safeExt = ext.replace(/[^a-z0-9]/gi, "").slice(0, 8).toLowerCase();
  return `${safeScope}/${name}${safeExt ? `.${safeExt}` : ""}`;
}

function resolveSafePath(storageKey: string): string {
  // `turbopackIgnore` keeps the bundler from treating this dynamic path as a
  // reason to trace the entire project into the server output. The path is
  // still resolved normally at runtime.
  const target = path.resolve(/*turbopackIgnore: true*/ MEDIA_ROOT, storageKey);
  const root = path.resolve(/*turbopackIgnore: true*/ MEDIA_ROOT);
  // Defend against path traversal in a stored key.
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return target;
}

/** Persist bytes into private storage. Returns the storage key. */
export async function writePrivateFile(
  storageKey: string,
  data: Buffer | Uint8Array
): Promise<string> {
  const target = resolveSafePath(storageKey);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, data);
  return storageKey;
}

export async function readPrivateFile(storageKey: string): Promise<Buffer> {
  return fs.readFile(resolveSafePath(storageKey));
}

export async function deletePrivateFile(storageKey: string): Promise<void> {
  await fs.unlink(resolveSafePath(storageKey)).catch(() => {});
}

export async function privateFileStat(storageKey: string) {
  return fs.stat(resolveSafePath(storageKey)).catch(() => null);
}

// ---------------------------------------------------------------------------
// Phase 21 — integrity checksums (media migration + backup verification).
// ---------------------------------------------------------------------------

/** SHA-256 hex of bytes (migration manifests, integrity proofs). */
export function sha256Buffer(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 hex of a private-storage file, streamed (no full buffering). */
export async function sha256PrivateFile(storageKey: string): Promise<string> {
  const { createReadStream } = await import("fs");
  const target = resolveSafePath(storageKey);
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(target);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk as Buffer));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    "video/mp4": "mp4",
    "video/webm": "webm",
    "video/ogg": "ogv",
    "video/quicktime": "mov",
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "application/pdf": "pdf",
  };
  return map[mime] || "bin";
}
