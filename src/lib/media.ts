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
//
// Byte movement is expressed as a `StorageBackend` (see below) so an
// S3-compatible object store can be added without touching any caller. This
// layer moves BYTES ONLY: MIME allow-lists, size ceilings, magic-byte
// validation, filename sanitisation, storage-key generation and — above all —
// every authorization decision stay in the routes and in
// `src/lib/session-materials.ts`. The backend never decides who may read.

import { promises as fs } from "fs";
import path from "path";
import { createHash, randomBytes } from "crypto";
import type { Readable } from "stream";

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

function resolveSafePath(storageKey: string, root: string = MEDIA_ROOT): string {
  // `turbopackIgnore` keeps the bundler from treating this dynamic path as a
  // reason to trace the entire project into the server output. The path is
  // still resolved normally at runtime.
  const target = path.resolve(/*turbopackIgnore: true*/ root, storageKey);
  const resolvedRoot = path.resolve(/*turbopackIgnore: true*/ root);
  // Defend against path traversal in a stored key.
  if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
    throw new Error("Invalid storage key");
  }
  return target;
}

// ---------------------------------------------------------------------------
// Storage backend abstraction
// ---------------------------------------------------------------------------
//
// A backend addresses objects by the same database-controlled `storageKey`
// the application has always used. Under `local` that key is a path relative
// to MEDIA_ROOT; under a future object-store backend it is an object key
// verbatim (`makeStorageKey` already emits `<scope>/<random>.<ext>`, which is
// a valid key in both worlds).

/** Backend-neutral metadata about a stored object. */
export type PrivateFileStat = {
  /** Object size in bytes. */
  size: number;
  /** Last modification time, when the backend exposes one. */
  lastModified: Date | null;
};

/**
 * Inclusive byte range, mirroring the `Range: bytes=start-end` semantics the
 * media routes already implement. An omitted bound means "from the start" /
 * "to the end".
 */
export type StorageReadRange = {
  start?: number;
  end?: number;
};

/** A ranged read: the byte stream plus the offsets a 206 response needs. */
export type StorageStreamResult = {
  stream: Readable;
  /** Size of the WHOLE object — for `Content-Range: bytes s-e/TOTAL`. */
  size: number;
  /** First byte included (inclusive). */
  start: number;
  /** Last byte included (inclusive); `-1` only for an empty object. */
  end: number;
  /** `end - start + 1` — the value for `Content-Length`. */
  contentLength: number;
};

/** Optional metadata a backend may persist alongside the bytes. */
export type StorageWriteMetadata = {
  mimeType?: string | null;
  originalName?: string | null;
};

/** Backends compiled into THIS build. Object storage lands in a later step. */
export const SUPPORTED_STORAGE_BACKENDS = ["local"] as const;
export type StorageBackendName = (typeof SUPPORTED_STORAGE_BACKENDS)[number];

export interface StorageBackend {
  readonly name: StorageBackendName;
  /** Persist bytes; returns the key they were stored under. */
  write(
    key: string,
    data: Buffer | Uint8Array,
    metadata?: StorageWriteMetadata
  ): Promise<string>;
  /** Read the whole object. Rejects when it does not exist. */
  read(key: string): Promise<Buffer>;
  /** Remove the object. Idempotent: a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Object metadata, or null when the object does not exist. */
  stat(key: string): Promise<PrivateFileStat | null>;
  /** SHA-256 hex of the object's bytes, streamed (no full buffering). */
  sha256(key: string): Promise<string>;
  /**
   * Streaming read with an optional inclusive byte range. Returns null when
   * the object does not exist; throws RangeError for an unsatisfiable range.
   */
  readStream(
    key: string,
    range?: StorageReadRange
  ): Promise<StorageStreamResult | null>;
}

/** A byte offset must be a non-negative safe integer (parity with Phase 20). */
function assertSafeByteOffset(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid storage range ${label}: ${value}`);
  }
}

/**
 * The historical behaviour, unchanged: bytes on a private filesystem volume
 * under MEDIA_ROOT, addressed by an unguessable key, reachable only through
 * an authorized route.
 */
export class LocalStorageBackend implements StorageBackend {
  readonly name: StorageBackendName = "local";
  private readonly root: string;

  constructor(root: string = MEDIA_ROOT) {
    this.root = root;
  }

  private resolve(key: string): string {
    return resolveSafePath(key, this.root);
  }

  async write(key: string, data: Buffer | Uint8Array): Promise<string> {
    // The local backend has nowhere to persist `metadata`: mimeType and
    // originalName live on the MediaAsset row, which stays the source of
    // truth. An object-store backend maps them onto ContentType instead.
    const target = this.resolve(key);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    return key;
  }

  async read(key: string): Promise<Buffer> {
    return fs.readFile(this.resolve(key));
  }

  async delete(key: string): Promise<void> {
    await fs.unlink(this.resolve(key)).catch(() => {});
  }

  async stat(key: string): Promise<PrivateFileStat | null> {
    const st = await fs.stat(this.resolve(key)).catch(() => null);
    if (!st) return null;
    return { size: st.size, lastModified: st.mtime };
  }

  async sha256(key: string): Promise<string> {
    const { createReadStream } = await import("fs");
    const target = this.resolve(key);
    return new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      const stream = createReadStream(target);
      stream.on("error", reject);
      stream.on("data", (chunk) => hash.update(chunk as Buffer));
      stream.on("end", () => resolve(hash.digest("hex")));
    });
  }

  async readStream(
    key: string,
    range?: StorageReadRange
  ): Promise<StorageStreamResult | null> {
    const { createReadStream } = await import("fs");
    const target = this.resolve(key);
    const st = await fs.stat(target).catch(() => null);
    if (!st || !st.isFile()) return null;
    const size = st.size;
    const rangeRequested =
      !!range && (range.start !== undefined || range.end !== undefined);

    // Degenerate case: an empty object has no addressable byte.
    if (size === 0) {
      if (rangeRequested) {
        throw new RangeError("Unsatisfiable storage range: object is empty");
      }
      return { stream: createReadStream(target), size: 0, start: 0, end: -1, contentLength: 0 };
    }

    // Resolve the inclusive range using S3/R2 semantics, so the object-store
    // backend added next behaves identically and the routes need no special
    // casing per backend:
    //   * `start` at or beyond EOF is unsatisfiable -> throw, and the caller
    //     answers 416 (the HTTP mapping stays the route's job, as today);
    //   * `end` beyond EOF is CLAMPED to the last byte (S3 does the same).
    let start = 0;
    let end = size - 1;
    if (range?.start !== undefined) {
      assertSafeByteOffset(range.start, "start");
      start = range.start;
    }
    if (range?.end !== undefined) {
      assertSafeByteOffset(range.end, "end");
      end = range.end;
    }
    if (start > end) {
      throw new RangeError(`Invalid storage range: start ${start} > end ${end}`);
    }
    if (start >= size) {
      throw new RangeError(
        `Unsatisfiable storage range: start ${start} for a ${size}-byte object`
      );
    }
    if (end > size - 1) end = size - 1;

    const isPartial = start !== 0 || end !== size - 1;
    return {
      stream: createReadStream(target, isPartial ? { start, end } : undefined),
      size,
      start,
      end,
      contentLength: end - start + 1,
    };
  }
}

/**
 * Resolve the active backend name from `MEDIA_BACKEND`.
 *
 * FAIL-CLOSED BY DESIGN. An unset or empty value means `local`, which is the
 * historical behaviour, so existing deployments are unaffected. Any other
 * unsupported value THROWS rather than degrading: `MEDIA_BACKEND=s3` silently
 * falling back to the local filesystem would write bytes to an ephemeral disk
 * while the operator believes they are durable.
 */
export function resolveStorageBackendName(
  env: NodeJS.ProcessEnv = process.env
): StorageBackendName {
  const raw = (env.MEDIA_BACKEND ?? "").trim();
  if (raw === "") return "local";
  const normalized = raw.toLowerCase();
  if ((SUPPORTED_STORAGE_BACKENDS as readonly string[]).includes(normalized)) {
    return normalized as StorageBackendName;
  }
  throw new Error(
    `MEDIA_BACKEND="${raw}" is not a supported storage backend. Supported in ` +
      `this build: ${SUPPORTED_STORAGE_BACKENDS.join(", ")}. Refusing to fall ` +
      `back to "local" — unset MEDIA_BACKEND or set it to "local" explicitly.`
  );
}

/** Build a backend by name. */
export function createStorageBackend(
  name: StorageBackendName = resolveStorageBackendName()
): StorageBackend {
  switch (name) {
    case "local":
      return new LocalStorageBackend();
    default: {
      // Exhaustiveness guard: widening SUPPORTED_STORAGE_BACKENDS without
      // implementing the case here is a COMPILE error, not a runtime surprise.
      const unimplemented: never = name;
      throw new Error(`storage backend not implemented: ${String(unimplemented)}`);
    }
  }
}

let activeBackend: StorageBackend | null = null;

/**
 * The process-wide backend, resolved lazily on first use and then cached. A
 * misconfigured `MEDIA_BACKEND` therefore throws on the first storage
 * operation (a clear server-side error) instead of at import time.
 */
export function getStorageBackend(): StorageBackend {
  if (!activeBackend) activeBackend = createStorageBackend();
  return activeBackend;
}

// ---------------------------------------------------------------------------
// Public helpers — names and signatures preserved; they delegate to the
// active backend, so no caller had to change.
// ---------------------------------------------------------------------------

/** Persist bytes into private storage. Returns the storage key. */
export async function writePrivateFile(
  storageKey: string,
  data: Buffer | Uint8Array,
  metadata?: StorageWriteMetadata
): Promise<string> {
  return getStorageBackend().write(storageKey, data, metadata);
}

export async function readPrivateFile(storageKey: string): Promise<Buffer> {
  return getStorageBackend().read(storageKey);
}

export async function deletePrivateFile(storageKey: string): Promise<void> {
  return getStorageBackend().delete(storageKey);
}

export async function privateFileStat(
  storageKey: string
): Promise<PrivateFileStat | null> {
  return getStorageBackend().stat(storageKey);
}

/**
 * Streaming, optionally ranged read of a private object.
 *
 * Introduced to establish the contract an object-store backend will implement
 * so large private videos stop being fully buffered into memory. NOT yet
 * consumed by any route — the routes keep their current behaviour (and their
 * existing strict Range/416 handling) until they are migrated deliberately.
 */
export async function readPrivateFileStream(
  storageKey: string,
  range?: StorageReadRange
): Promise<StorageStreamResult | null> {
  return getStorageBackend().readStream(storageKey, range);
}

// ---------------------------------------------------------------------------
// Phase 21 — integrity checksums (media migration + backup verification).
// ---------------------------------------------------------------------------

/** SHA-256 hex of bytes (migration manifests, integrity proofs). */
export function sha256Buffer(data: Buffer | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** SHA-256 hex of a private-storage object, streamed (no full buffering). */
export async function sha256PrivateFile(storageKey: string): Promise<string> {
  return getStorageBackend().sha256(storageKey);
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
