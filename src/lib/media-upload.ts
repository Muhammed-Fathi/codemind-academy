// CodeMind Academy — Presigned direct-upload orchestration (Phase 23).
//
// THE FLOW (large admin media never buffers through the app server):
//
//   Browser → POST /api/admin/media-uploads/init   (requireRole("ADMIN") + rate limit)
//             server: authorize target (batch/lesson), validate declared MIME +
//             size, check quota, generate the EXACT storage key server-side,
//             presign a SHORT-LIVED PUT carrying the granted Content-Type,
//             sign an HMAC
//             upload-intent token bound to every upload parameter.
//           ← { uploadUrl, method: "PUT", token, contentType, maxBytes,
//               expiresInSec, expiresAt }
//
//   Browser → PUT <uploadUrl>   (direct to the PRIVATE R2 bucket — no app
//             server in the byte path, no credential in the browser)
//
//   Browser → POST /api/admin/media-uploads/complete (requireRole("ADMIN") + rate limit)
//             server: verify the intent token (signature, expiry, user,
//             purpose, exact key, content type, max bytes), RE-RUN the target
//             authorization, then HEAD/stat the object: exists → size ≤ max →
//             stored Content-Type matches → magic bytes (PDF) → SHA-256 (when
//             provided). ONLY THEN are MediaAsset + related rows created.
//             Any verification failure deletes the object (exact key, never a
//             prefix) and rejects. A DB failure after verification deletes the
//             verified object too (best-effort exact-key cleanup).
//
// SECURITY CONTRACT (what must never regress):
//   * requireRole("ADMIN") on BOTH endpoints; rate limits preserved.
//   * The storage key is generated here (makeStorageKey) and signed into BOTH
//     the presigned URL and the intent token. The client can never choose,
//     see, or alter it.
//   * The intent token is HMAC-SHA256 keyed by SECURITY_HASH_SECRET
//     (src/lib/env) — signature verified constant-time; tampering with any
//     bound field (key, user, purpose, kind, content type, max bytes,
//     expiry) breaks the MAC.
//   * Presigned URLs are PUT-only, minutes-short, and scoped to ONE exact
//     key. No presigned GET exists anywhere; no bucket LIST capability exists.
//   * The bucket stays PRIVATE: reads still flow only through the authorized
//     proxies (/api/media/[id], /api/materials/[id]).
//   * Object verification happens BEFORE any DB write: object → verification
//     → rows. No phantom MediaAsset rows can exist.
//   * COMPLETION IS IDEMPOTENT. The consumed marker is PERSISTED DB LINKAGE —
//     a MediaAsset row under the exact token-bound storageKey — never the jti
//     alone and never an in-memory set (both non-authoritative here). A
//     replayed completion returns the original result (`replay: true`) with
//     no duplicate rows and no deletes; a key linked differently fails closed
//     (ALREADY_LINKED) untouched; cleanup refuses to delete any object that
//     still has a MediaAsset row — never delete referenced bytes.
//
// QUIZ EVIDENCE IS DELIBERATELY OUT OF SCOPE: it keeps its server-proxied
// upload path unchanged.

import { createHmac, randomBytes, timingSafeEqual } from "crypto";
import { db } from "@/lib/db";
import { getSecurityHashSecret } from "@/lib/env";
import {
  MAX_PDF_BYTES,
  MAX_VIDEO_BYTES,
  extFromMime,
  getStorageBackend,
  hasPdfExtension,
  hasPdfMagicBytes,
  isAllowedPdfMime,
  isAllowedVideoMime,
  makeStorageKey,
  mediaStorageValueForBackend,
  resolveStorageBackendName,
  sanitizeOriginalFilename,
  type StorageBackend,
} from "@/lib/media";
import {
  finalizeLessonPdfMaterial,
  parseMaterialTrackScopeInput,
  type FinalizeLessonPdfResult,
} from "@/lib/session-materials";
import { acquireUploadFinalizeLock } from "@/lib/db-serialization";
import { normalizeTrackScope, type TrackScope } from "@/lib/track-scope";
import { assertVolumeQuota } from "@/lib/storage-quotas";

// ---------------------------------------------------------------------------
// Purposes
// ---------------------------------------------------------------------------

/** The upload purposes that may use the presigned flow. Evidence excluded. */
export const UPLOAD_PURPOSES = ["SESSION_VIDEO", "LESSON_PDF"] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export function isUploadPurpose(value: unknown): value is UploadPurpose {
  return (
    typeof value === "string" &&
    (UPLOAD_PURPOSES as readonly string[]).includes(value)
  );
}

/**
 * Per-purpose policy. Every limit here is the SAME limit the buffered path
 * enforces — the direct flow never widens an allow-list or a size ceiling.
 */
type UploadPurposeSpec = {
  purpose: UploadPurpose;
  /** `MediaAsset.kind` this purpose creates. */
  kind: "VIDEO" | "DOCUMENT";
  /** Storage-key scope (`<scope>/<random>.<ext>`), same as the buffered path. */
  keyScope: string;
  /** Per-file ceiling — MAX_VIDEO_BYTES / MAX_PDF_BYTES. */
  maxBytes: number;
  /** Allow-list for the DECLARED content type (checked before presigning). */
  isAllowedMime: (mime: string) => boolean;
  /** Content type used when the client omits one (PDF only). */
  defaultContentType: string | null;
  /** Extension for the server-generated key. */
  extFor: (mime: string) => string;
  /**
   * Magic-byte verification over the first bytes of the stored object, where
   * applicable. Videos keep the buffered path's semantics (MIME allow-list
   * only); PDFs must start with `%PDF-` within the first KB.
   */
  verifyMagicBytes?: (head: Buffer) => boolean;
  /** Extension enforcement over the sanitized original name (PDF: .pdf). */
  requireExtension?: (name: string) => boolean;
};

const PURPOSE_SPECS: Record<UploadPurpose, UploadPurposeSpec> = {
  SESSION_VIDEO: {
    purpose: "SESSION_VIDEO",
    kind: "VIDEO",
    keyScope: "session-videos",
    maxBytes: MAX_VIDEO_BYTES,
    isAllowedMime: (mime) => isAllowedVideoMime(mime),
    defaultContentType: null, // a video upload MUST declare its type
    extFor: (mime) => extFromMime(mime),
    // No magic-byte check: parity with the buffered video path.
  },
  LESSON_PDF: {
    purpose: "LESSON_PDF",
    kind: "DOCUMENT",
    keyScope: "session-pdfs",
    maxBytes: MAX_PDF_BYTES,
    isAllowedMime: (mime) => isAllowedPdfMime(mime),
    defaultContentType: "application/pdf",
    extFor: () => "pdf",
    verifyMagicBytes: (head) => hasPdfMagicBytes(head),
    requireExtension: (name) => hasPdfExtension(name),
  },
};

// ---------------------------------------------------------------------------
// Presign expiry (short by construction)
// ---------------------------------------------------------------------------

export const PRESIGN_EXPIRES_DEFAULT_SEC = 600;
export const PRESIGN_EXPIRES_MIN_SEC = 60;
export const PRESIGN_EXPIRES_MAX_SEC = 900; // "short" — never more than 15 min

/**
 * Resolve the presign/intent window from `MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC`.
 * Clamped into a short bounded range so a bad value degrades to a safe bound
 * instead of disabling the expiry (same policy pattern as rate limits).
 */
export function resolvePresignExpiresSec(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = Number(String(env.MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC ?? "").trim());
  if (!Number.isFinite(raw) || raw <= 0) return PRESIGN_EXPIRES_DEFAULT_SEC;
  return Math.min(
    PRESIGN_EXPIRES_MAX_SEC,
    Math.max(PRESIGN_EXPIRES_MIN_SEC, Math.floor(raw))
  );
}

// ---------------------------------------------------------------------------
// Upload intent token — HMAC-SHA256 over every bound upload parameter
// ---------------------------------------------------------------------------

const INTENT_VERSION = 1;
/** Domain-separated HMAC context: this MAC never signs anything else. */
const INTENT_HMAC_CONTEXT = "codemind.upload-intent.v1";
/**
 * Hard ceiling on any intent lifetime, regardless of configuration. A token
 * is a single-upload grant, not a session.
 */
export const INTENT_MAX_TTL_SEC = 3600;

export type UploadIntentPayload = {
  v: typeof INTENT_VERSION;
  /** Random nonce — one intent per upload, never reused. */
  jti: string;
  /** The admin the grant was issued to (completion must come from them). */
  sub: string;
  purpose: UploadPurpose;
  kind: "VIDEO" | "DOCUMENT";
  /** The EXACT storage key. Completion verifies this key and nothing else. */
  key: string;
  /** Content type the browser must send and the object must carry. */
  contentType: string;
  /** Ceiling the object must not exceed (declared size at init). */
  maxBytes: number;
  /** Issued-at / expiry, unix seconds. */
  iat: number;
  exp: number;
};

function intentMac(payloadB64: string, secret: string): string {
  return createHmac("sha256", secret)
    .update(`${INTENT_HMAC_CONTEXT}.${payloadB64}`)
    .digest("base64url");
}

/**
 * Sign an upload intent. The token is `base64url(payload) + "." + HMAC`.
 * SECURITY_HASH_SECRET keys the MAC (production mandatory, see src/lib/env).
 */
export function signUploadIntent(
  payload: UploadIntentPayload,
  secret: string = getSecurityHashSecret()
): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url"
  );
  return `${body}.${intentMac(body, secret)}`;
}

export type UploadIntentVerification =
  | { ok: true; payload: UploadIntentPayload }
  | {
      ok: false;
      reason: "MALFORMED" | "BAD_SIGNATURE" | "EXPIRED" | "USER_MISMATCH";
    };

/**
 * Verify an upload intent token: structure → constant-time MAC → expiry →
 * optional bearer check. Every bound field is re-validated so a token that
 * was hand-crafted with a different-but-signed shape can never pass.
 */
export function verifyUploadIntent(
  token: unknown,
  options: {
    expectedUser?: string | null;
    nowSec?: number;
    secret?: string;
  } = {}
): UploadIntentVerification {
  const raw = typeof token === "string" ? token.trim() : "";
  const parts = raw.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: "MALFORMED" };
  }
  const [body, mac] = parts;
  const expectedMac = intentMac(
    body,
    options.secret ?? getSecurityHashSecret()
  );
  const a = Buffer.from(mac);
  const b = Buffer.from(expectedMac);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "BAD_SIGNATURE" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "MALFORMED" };
  }
  const p = payload as Partial<UploadIntentPayload> | null;
  if (!p || typeof p !== "object") return { ok: false, reason: "MALFORMED" };
  if (p.v !== INTENT_VERSION) return { ok: false, reason: "MALFORMED" };
  const jti = p.jti;
  if (typeof jti !== "string" || !jti) return { ok: false, reason: "MALFORMED" };
  const sub = p.sub;
  if (typeof sub !== "string" || !sub) return { ok: false, reason: "MALFORMED" };
  if (!isUploadPurpose(p.purpose)) return { ok: false, reason: "MALFORMED" };
  const purpose = p.purpose;
  if (p.kind !== "VIDEO" && p.kind !== "DOCUMENT") {
    return { ok: false, reason: "MALFORMED" };
  }
  const kind = p.kind;
  const key = p.key;
  if (
    typeof key !== "string" ||
    !key ||
    key.startsWith("/") ||
    key.includes("..")
  ) {
    return { ok: false, reason: "MALFORMED" };
  }
  const contentType = p.contentType;
  if (typeof contentType !== "string" || !contentType.trim()) {
    return { ok: false, reason: "MALFORMED" };
  }
  const maxBytes = p.maxBytes;
  if (typeof maxBytes !== "number" || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    return { ok: false, reason: "MALFORMED" };
  }
  const iat = p.iat;
  const exp = p.exp;
  if (
    typeof iat !== "number" ||
    !Number.isSafeInteger(iat) ||
    typeof exp !== "number" ||
    !Number.isSafeInteger(exp) ||
    exp <= iat ||
    exp - iat > INTENT_MAX_TTL_SEC
  ) {
    return { ok: false, reason: "MALFORMED" };
  }

  const now = options.nowSec ?? Math.floor(Date.now() / 1000);
  if (now >= exp) return { ok: false, reason: "EXPIRED" };
  if (options.expectedUser != null && options.expectedUser !== "" && sub !== options.expectedUser) {
    return { ok: false, reason: "USER_MISMATCH" };
  }
  return {
    ok: true,
    payload: { v: INTENT_VERSION, jti, sub, purpose, kind, key, contentType, maxBytes, iat, exp },
  };
}

// ---------------------------------------------------------------------------
// Error codes + HTTP mapping (routes own the status codes; this is the table)
// ---------------------------------------------------------------------------

export const UPLOAD_ERROR_STATUS = {
  // init
  UNSUPPORTED_PURPOSE: 400,
  PRESIGNED_UNSUPPORTED: 409, // MEDIA_BACKEND != s3 — client falls back
  INVALID_SIZE: 413,
  INVALID_CONTENT_TYPE: 415,
  QUOTA_EXCEEDED: 413,
  BATCH_NOT_FOUND: 404,
  LESSON_NOT_FOUND: 404,
  LESSON_ARCHIVED: 409,
  STORAGE_UNAVAILABLE: 500,
  // intent
  INTENT_INVALID: 400,
  INTENT_BAD_SIGNATURE: 403,
  INTENT_EXPIRED: 410,
  INTENT_USER_MISMATCH: 403,
  // completion business validation
  TITLE_REQUIRED: 400,
  INVALID_TRACK_SCOPE: 400,
  // object verification
  MISSING_OBJECT: 409,
  EMPTY_OBJECT: 413,
  TOO_LARGE: 413,
  MIME_MISMATCH: 415,
  MAGIC_REJECTED: 415,
  EXTENSION_REJECTED: 415,
  SHA256_INVALID: 400,
  SHA256_MISMATCH: 400,
  VERIFICATION_FAILED: 500,
  // finalization
  DB_CREATE_FAILED: 500,
  /** The database is unavailable — fail closed, touch nothing, retriable. */
  DB_UNAVAILABLE: 503,
  /** Replay of a token whose key is already linked, but differently. */
  ALREADY_LINKED: 409,
} as const;

export type UploadErrorCode = keyof typeof UPLOAD_ERROR_STATUS;

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

export type MediaUploadDeps = {
  /** Prisma client (or a compatible fake). Defaults to the real `db`. */
  db?: typeof db;
  /**
   * Storage backend that holds (or will hold) the presigned object.
   * Defaults to the process-wide S3 backend.
   */
  backend?: StorageBackend;
  /** HMAC secret override (tests). Defaults to SECURITY_HASH_SECRET. */
  hmacSecret?: string;
  /** Clock override (tests), unix seconds. */
  nowSec?: () => number;
};

/**
 * Structural surface the presign-capable backend must expose. Kept narrow so
 * tests can inject a deterministic fake at the same boundary.
 */
type PresignedPutGrantLike = {
  url: string;
  method: string;
  key: string;
  contentType: string;
  expiresInSec: number;
  expiresAt: Date;
};

type PresignCapableBackend = StorageBackend & {
  createPresignedPutUrl(input: {
    key: string;
    contentType: string;
    expiresInSec: number;
  }): Promise<PresignedPutGrantLike>;
};

function normalizeMime(raw: unknown): string {
  return String(raw ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length > 0 ? v : null;
}

function safeHexEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a.toLowerCase());
  const bb = Buffer.from(b.toLowerCase());
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Exact-key cleanup — NEVER a prefix/list operation.
 *
 * CLEANUP-SAFETY INVARIANT (Phase 23 replay hardening): never delete bytes
 * that a valid DB record still references. Before any delete, count the
 * MediaAsset rows recording this EXACT storage key; if ANY exist — a prior
 * successful completion, a partially-created linkage, or a concurrent
 * completion of the same token — the bytes are LINKED and deletion is
 * REFUSED (fail closed). The same refusal applies when the reference check
 * itself cannot be performed (DB unavailable): an unverifiable delete is a
 * no delete.
 */
async function cleanupObject(
  backend: StorageBackend,
  client: typeof db,
  key: string
): Promise<boolean> {
  try {
    const linked = await client.mediaAsset.count({
      where: { storageKey: key },
    });
    if (Number(linked) > 0) return false;
  } catch {
    return false; // cannot prove the key unreferenced → do not delete
  }
  try {
    await backend.delete(key);
    return true;
  } catch {
    return false;
  }
}

type TargetValidation =
  | {
      ok: true;
      batchId: string | null;
      lessonId: string | null;
      lesson: { id: string; title: string | null; trackScope?: unknown } | null;
    }
  | { ok: false; code: UploadErrorCode; message: string };

/**
 * Re-usable target authorization for both purposes. Runs on init AND again
 * on completion (the target may have been deleted/archived in between).
 * This is the same authorization the buffered paths apply — ADMIN-only
 * role checks stay in the routes; entity ownership/validation lives here.
 */
async function validateUploadTarget(
  client: typeof db,
  purpose: UploadPurpose,
  batchIdRaw: unknown,
  lessonIdRaw: unknown
): Promise<TargetValidation> {
  if (purpose === "SESSION_VIDEO") {
    const batchId = asTrimmedString(batchIdRaw);
    if (!batchId) return { ok: false, code: "BATCH_NOT_FOUND", message: "Batch not found" };
    const batch = await client.batch.findUnique({ where: { id: batchId }, select: { id: true } });
    if (!batch) return { ok: false, code: "BATCH_NOT_FOUND", message: "Batch not found" };
    const lessonId = asTrimmedString(lessonIdRaw);
    if (lessonId) {
      const lesson = await client.lesson.findUnique({
        where: { id: lessonId },
        select: { id: true },
      });
      if (!lesson) return { ok: false, code: "LESSON_NOT_FOUND", message: "Lesson not found" };
    }
    return { ok: true, batchId, lessonId, lesson: null };
  }

  // LESSON_PDF — same lesson rules as uploadLessonPdfMaterial.
  const lessonId = asTrimmedString(lessonIdRaw);
  if (!lessonId) return { ok: false, code: "LESSON_NOT_FOUND", message: "Lesson not found" };
  const lesson = await client.lesson.findUnique({
    where: { id: lessonId },
    select: { id: true, title: true, curriculumStatus: true, trackScope: true },
  });
  if (!lesson) return { ok: false, code: "LESSON_NOT_FOUND", message: "Lesson not found" };
  if (String(lesson.curriculumStatus).toUpperCase() === "ARCHIVED") {
    return {
      ok: false,
      code: "LESSON_ARCHIVED",
      message: "Cannot attach materials to an archived lesson",
    };
  }
  return {
    ok: true,
    batchId: null,
    lessonId,
    lesson: { id: lesson.id, title: lesson.title, trackScope: lesson.trackScope },
  };
}

function collectStreamHead(stream: import("stream").Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    stream.on("error", reject);
    stream.on("data", (chunk: Buffer) => {
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      chunks.push(b);
      total += b.length;
      if (total >= 1024) stream.destroy?.();
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("close", () => resolve(Buffer.concat(chunks)));
  });
}

// ---------------------------------------------------------------------------
// upload-init
// ---------------------------------------------------------------------------

export type PresignedUploadInitInput = {
  purpose: unknown;
  actorUserId: string | null;
  /** Browser-declared file size — re-verified against the real object later. */
  sizeBytes: unknown;
  /** Browser-declared MIME — granted to the browser and verified at completion. */
  contentType: unknown;
  /** Browser-declared filename — metadata only, never the storage key. */
  fileName?: unknown;
  /** SESSION_VIDEO target. */
  batchId?: unknown;
  /** SESSION_VIDEO optional lesson link / LESSON_PDF required target. */
  lessonId?: unknown;
};

export type PresignedUploadInit =
  | {
      ok: true;
      init: {
        uploadUrl: string;
        method: "PUT";
        token: string;
        contentType: string;
        maxBytes: number;
        expiresInSec: number;
        expiresAt: string;
        purpose: UploadPurpose;
      };
    }
  | { ok: false; code: UploadErrorCode; message: string };

/**
 * Authorize + plan + presign one direct upload. Performs NO byte movement and
 * NO bucket LIST — just validation, key generation, a presigned PUT, and an
 * intent token. Fail-closed unless the ACTIVE backend is `s3`: under
 * `MEDIA_BACKEND=local` there is no object store to upload to, and the client
 * is told to fall back to the buffered path (PRESIGNED_UNSUPPORTED).
 */
export async function initPresignedUpload(
  input: PresignedUploadInitInput,
  deps: MediaUploadDeps = {}
): Promise<PresignedUploadInit> {
  // 1. Purpose.
  if (!isUploadPurpose(input.purpose)) {
    return { ok: false, code: "UNSUPPORTED_PURPOSE", message: "Unsupported upload purpose" };
  }
  const spec = PURPOSE_SPECS[input.purpose];

  // 2. The direct flow requires the ACTIVE backend to be the object store.
  let activeBackendName: string;
  try {
    activeBackendName = resolveStorageBackendName();
  } catch {
    return {
      ok: false,
      code: "PRESIGNED_UNSUPPORTED",
      message: "Direct uploads are not available for the active storage backend",
    };
  }
  if (activeBackendName !== "s3") {
    return {
      ok: false,
      code: "PRESIGNED_UNSUPPORTED",
      message: "Direct uploads are not available for the active storage backend",
    };
  }

  // 3. Declared size — against the SAME ceiling the buffered path enforces.
  const sizeBytes = Number(input.sizeBytes);
  if (
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes <= 0 ||
    sizeBytes > spec.maxBytes
  ) {
    return {
      ok: false,
      code: "INVALID_SIZE",
      message: "File size is missing, empty, or exceeds the allowed maximum",
    };
  }

  // 4. Declared content type — allow-listed; the grant carries it and the
  //    completion HEAD holds the browser to it (the SigV4 presigner leaves
  //    content-type unsigned by SDK design, so enforcement is at completion).
  const declaredMime = normalizeMime(input.contentType);
  const contentType = declaredMime || spec.defaultContentType;
  if (!contentType || !spec.isAllowedMime(contentType)) {
    return {
      ok: false,
      code: "INVALID_CONTENT_TYPE",
      message: "MIME type is not allowed for this upload",
    };
  }

  // 5. Target authorization (batch / lesson / archived state).
  const client = deps.db ?? db;
  let target: TargetValidation;
  try {
    target = await validateUploadTarget(client, spec.purpose, input.batchId, input.lessonId);
  } catch (e) {
    // Authorization itself could not be performed (DB outage): fail closed
    // without issuing anything — retriable, nothing was created or deleted.
    return { ok: false, code: "DB_UNAVAILABLE", message: (e as Error).message };
  }
  if (!target.ok) return target;

  // 6. Volume quota — checked BEFORE anything is issued (same gate the
  //    buffered path applies before its first written byte).
  const quota = await assertVolumeQuota(sizeBytes);
  if (!quota.ok) {
    return { ok: false, code: "QUOTA_EXCEEDED", message: "Media storage quota exceeded" };
  }

  // 7. Resolve the backend + presign. The key is generated HERE and only
  //    ever exists in the presigned URL and the intent token.
  let backend: StorageBackend;
  try {
    backend = deps.backend ?? (await getStorageBackend("s3"));
  } catch (e) {
    return { ok: false, code: "STORAGE_UNAVAILABLE", message: (e as Error).message };
  }
  const presignable = backend as Partial<PresignCapableBackend>;
  if (typeof presignable.createPresignedPutUrl !== "function") {
    return {
      ok: false,
      code: "PRESIGNED_UNSUPPORTED",
      message: "The active storage backend does not support direct uploads",
    };
  }

  const key = makeStorageKey(spec.keyScope, spec.extFor(contentType));
  const expiresInSec = resolvePresignExpiresSec();

  let grant: PresignedPutGrantLike;
  try {
    grant = await presignable.createPresignedPutUrl!({
      key,
      contentType,
      expiresInSec,
    });
  } catch (e) {
    return { ok: false, code: "STORAGE_UNAVAILABLE", message: (e as Error).message };
  }

  // 8. Sign the upload intent — bound to user, purpose, kind, exact key,
  //    content type, max size and expiry.
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const iat = nowSec();
  const token = signUploadIntent(
    {
      v: INTENT_VERSION,
      jti: randomBytes(16).toString("base64url"),
      sub: String(input.actorUserId ?? ""),
      purpose: spec.purpose,
      kind: spec.kind,
      key: grant.key,
      contentType: grant.contentType,
      maxBytes: spec.maxBytes,
      iat,
      exp: iat + grant.expiresInSec,
    },
    deps.hmacSecret
  );

  return {
    ok: true,
    init: {
      uploadUrl: grant.url,
      method: "PUT",
      token,
      contentType: grant.contentType,
      maxBytes: spec.maxBytes,
      expiresInSec: grant.expiresInSec,
      expiresAt: grant.expiresAt.toISOString(),
      purpose: spec.purpose,
    },
  };
}

// ---------------------------------------------------------------------------
// upload-complete
// ---------------------------------------------------------------------------

/**
 * Replay / idempotency resolution.
 *
 * The upload intent token carries a `jti` nonce for HMAC uniqueness, but the
 * CONSUMED MARKER is deliberately NOT the token and NOT any in-memory set
 * (non-authoritative on serverless). It is the PERSISTED DATABASE LINKAGE:
 * a `MediaAsset` row recorded under the EXACT server-generated `storageKey`
 * bound in the token. That row is what the storage abstraction addresses the
 * bytes by, it survives restarts and multi-instance deployments, and it is
 * written only after full object verification — so "a row with this key
 * exists" means exactly "this upload was already finalized".
 *
 *   NOT_LINKED    — no MediaAsset records this key → proceed with the flow.
 *   FINALIZED     — the key is linked to the intended resource exactly as
 *                   this token would have linked it → the completion is an
 *                   IDEMPOTENT REPLAY: return the original result untouched.
 *   INCONSISTENT  — the key is linked, but to something else (different
 *                   kind / batch / lesson / scope, or an orphaned partial
 *                   row) → FAIL CLOSED without creating rows and WITHOUT
 *                   any destructive action.
 */
type ExistingLinkage =
  | { status: "NOT_LINKED" }
  | {
      status: "FINALIZED";
      mediaAssetId: string;
      video: Record<string, unknown> | null;
      material: Record<string, unknown> | null;
    }
  | { status: "INCONSISTENT" };

type VerifiedTarget = Extract<TargetValidation, { ok: true }>;

async function resolveExistingLinkage(
  client: typeof db,
  payload: UploadIntentPayload,
  target: VerifiedTarget,
  trackScope: TrackScope | null
): Promise<ExistingLinkage> {
  try {
    const asset = await client.mediaAsset.findFirst({
      where: { storageKey: payload.key },
    });
    if (!asset) return { status: "NOT_LINKED" };

    if (payload.purpose === "SESSION_VIDEO") {
      const video = (await client.sessionVideo.findFirst({
        where: { mediaAssetId: asset.id },
      })) as {
        id: string;
        batchId: string;
        lessonId: string | null;
      } | null;
      if (asset.kind !== "VIDEO") return { status: "INCONSISTENT" };
      if (
        video &&
        video.batchId === target.batchId &&
        (video.lessonId ?? null) === (target.lessonId ?? null)
      ) {
        // The exact linkage this completion would (re-)create already
        // exists → idempotent replay of the first, successful completion.
        return {
          status: "FINALIZED",
          mediaAssetId: asset.id,
          video: video as unknown as Record<string, unknown>,
          material: null,
        };
      }
      return { status: "INCONSISTENT" };
    }

    // LESSON_PDF
    const material = (await client.material.findFirst({
      where: {
        lessonId: target.lessonId!,
        trackScope: trackScope ?? undefined,
        isActive: true,
        kind: "ADMIN_UPLOADED",
      },
      include: { media: { select: { id: true, storageKey: true } } },
    })) as {
      id: string;
      lessonId: string;
      title: string;
      trackScope: TrackScope;
      isActive: boolean;
      mediaAssetId: string | null;
      media?: { id: string; storageKey: string | null } | null;
    } | null;
    if (asset.kind !== "DOCUMENT") return { status: "INCONSISTENT" };
    if (
      material &&
      material.mediaAssetId === asset.id &&
      material.media?.storageKey === payload.key
    ) {
      return {
        status: "FINALIZED",
        mediaAssetId: asset.id,
        video: null,
        material: {
          id: material.id,
          lessonId: material.lessonId,
          title: material.title,
          kind: "ADMIN_UPLOADED",
          trackScope: material.trackScope,
          isActive: true,
          mediaAssetId: asset.id,
          downloadUrl: `/api/materials/${material.id}`,
          mimeType: asset.mimeType,
          sizeBytes: asset.sizeBytes,
          originalName: asset.originalName,
        } as unknown as Record<string, unknown>,
      };
    }
    return { status: "INCONSISTENT" };
  } catch {
    // The linkage cannot be determined (DB unavailable). Reporting NOT_LINKED
    // is still safe: every subsequent step needs the DB anyway, and the
    // guarded cleanup refuses any delete it cannot prove unreferenced.
    return { status: "NOT_LINKED" };
  }
}

export type PresignedUploadCompleteInput = {
  token: unknown;
  actorUserId: string | null;
  /** Optional hex SHA-256 of the uploaded bytes (computed by the browser). */
  sha256?: unknown;
  /** Original filename — metadata + (.pdf extension check), never a key. */
  originalName?: unknown;
  // SESSION_VIDEO payload:
  batchId?: unknown;
  title?: unknown;
  titleAr?: unknown;
  description?: unknown;
  publish?: unknown;
  // Shared / LESSON_PDF payload:
  lessonId?: unknown;
  trackScope?: unknown;
};

export type PresignedUploadCompleteResult =
  | {
      ok: true;
      purpose: UploadPurpose;
      mediaAssetId: string;
      /**
       * true when this completion is an IDEMPOTENT REPLAY of an already
       * finalized upload (persisted linkage found for the exact key): the
       * original result is returned untouched — no new rows, no deletes.
       */
      replay?: boolean;
      video?: Record<string, unknown> | null;
      material?: Record<string, unknown> | null;
      replaced?: { materialId: string; mediaAssetId: string | null }[];
      cleanedUpAssets?: string[];
    }
  | { ok: false; code: UploadErrorCode; message: string; cleaned?: boolean };

/**
 * Verify a completed direct upload, then — and only then — create the DB rows.
 *
 * ORDERING (no phantom rows, no orphaned bytes without an attempt to clean):
 *   token → authorization → HEAD/stat → size → Content-Type → magic bytes →
 *   SHA-256 → DB rows. Every object-level failure DELETES the object by its
 *   exact key. A DB failure after successful verification also attempts
 *   exact-key cleanup. Deletes are exact-key only — never a prefix, never a
 *   listing.
 */
export async function completePresignedUpload(
  input: PresignedUploadCompleteInput,
  deps: MediaUploadDeps = {}
): Promise<PresignedUploadCompleteResult> {
  const nowSec = deps.nowSec ?? (() => Math.floor(Date.now() / 1000));

  // 1. Intent token — signature, expiry, bearer binding.
  const intent = verifyUploadIntent(input.token, {
    expectedUser: input.actorUserId,
    nowSec: nowSec(),
    secret: deps.hmacSecret,
  });
  if (!intent.ok) {
    const code: UploadErrorCode =
      intent.reason === "EXPIRED"
        ? "INTENT_EXPIRED"
        : intent.reason === "USER_MISMATCH"
          ? "INTENT_USER_MISMATCH"
          : intent.reason === "BAD_SIGNATURE"
            ? "INTENT_BAD_SIGNATURE"
            : "INTENT_INVALID";
    return {
      ok: false,
      code,
      message:
        intent.reason === "EXPIRED"
          ? "Upload window expired — start the upload again"
          : intent.reason === "USER_MISMATCH"
            ? "This upload was issued to a different user"
            : "Invalid upload token",
    };
  }
  const payload = intent.payload;
  const spec = PURPOSE_SPECS[payload.purpose];

  // Defense in depth: the signed kind must still match the purpose spec.
  if (spec.kind !== payload.kind) {
    return { ok: false, code: "INTENT_INVALID", message: "Invalid upload token" };
  }

  // 2. Re-run target authorization (batch/lesson may have changed since init).
  const client = deps.db ?? db;
  let target: TargetValidation;
  try {
    target = await validateUploadTarget(client, payload.purpose, input.batchId, input.lessonId);
  } catch (e) {
    // DB outage during re-authorization: fail closed BEFORE any storage or
    // cleanup I/O — nothing was verified, nothing may be deleted.
    return { ok: false, code: "DB_UNAVAILABLE", message: (e as Error).message };
  }
  if (!target.ok) return target;

  // 3. Purpose-specific business validation (cheap, before any object I/O —
  //    a bad payload must never cost a verified upload its bytes).
  let title = "";
  let trackScope: TrackScope | undefined;
  if (payload.purpose === "SESSION_VIDEO") {
    title = asTrimmedString(input.title) ?? "";
    if (!title) return { ok: false, code: "TITLE_REQUIRED", message: "Title is required" };
  } else {
    const scopeParse = parseMaterialTrackScopeInput(input.trackScope);
    if (!scopeParse.ok) {
      return {
        ok: false,
        code: "INVALID_TRACK_SCOPE",
        message: "trackScope must be SHARED, ARABIC, or LANGUAGE",
      };
    }
    // Unspecified → inherit the lesson's OWN scope (the buffered path's
    // default), resolved server-side from the lesson row — never from the
    // request payload.
    trackScope = scopeParse.specified
      ? scopeParse.value
      : normalizeTrackScope(target.lesson?.trackScope) ?? "SHARED";
  }

  // 3.5 IDEMPOTENT REPLAY — check the PERSISTED consumed marker before any
  //     storage I/O or row creation. The marker is the MediaAsset linkage
  //     under the exact token-bound storageKey (authoritative DB state; not
  //     the jti, not an in-memory set — both are non-authoritative here).
  const linkage = await resolveExistingLinkage(
    client,
    payload,
    target,
    trackScope ?? null
  );
  if (linkage.status === "FINALIZED") {
    return {
      ok: true,
      purpose: payload.purpose,
      mediaAssetId: linkage.mediaAssetId,
      replay: true,
      video: linkage.video,
      material: linkage.material,
      replaced: [],
      cleanedUpAssets: [],
    };
  }
  if (linkage.status === "INCONSISTENT") {
    // The key is already recorded, but linked differently than this token
    // would link it. NEVER modify or delete it — fail closed, keep bytes.
    return {
      ok: false,
      code: "ALREADY_LINKED",
      message:
        "This upload was already recorded with different data — refusing to modify it",
    };
  }

  let backend: StorageBackend;
  try {
    backend = deps.backend ?? (await getStorageBackend("s3"));
  } catch (e) {
    return { ok: false, code: "STORAGE_UNAVAILABLE", message: (e as Error).message };
  }

  // 4. HEAD/stat the object — it must exist, be non-empty, within the signed
  //    ceiling, and carry the GRANTED content type.
  let stat: Awaited<ReturnType<StorageBackend["stat"]>>;
  try {
    stat = await backend.stat(payload.key);
  } catch (e) {
    return { ok: false, code: "VERIFICATION_FAILED", message: (e as Error).message };
  }
  if (!stat) {
    return {
      ok: false,
      code: "MISSING_OBJECT",
      message: "No uploaded object found for this upload token",
    };
  }
  const size = Number(stat.size);
  if (!Number.isSafeInteger(size) || size <= 0) {
    const cleaned = await cleanupObject(backend, client, payload.key);
    return { ok: false, code: "EMPTY_OBJECT", message: "Uploaded object is empty", cleaned };
  }
  if (size > payload.maxBytes) {
    const cleaned = await cleanupObject(backend, client, payload.key);
    return { ok: false, code: "TOO_LARGE", message: "File exceeds size limit", cleaned };
  }
  const headMime = normalizeMime(stat.contentType ?? "");
  if (headMime !== normalizeMime(payload.contentType)) {
    const cleaned = await cleanupObject(backend, client, payload.key);
    return {
      ok: false,
      code: "MIME_MISMATCH",
      message: "Stored object content type does not match the authorized upload",
      cleaned,
    };
  }

  // 5. Magic bytes (streamed first-KB read), where applicable.
  if (spec.verifyMagicBytes) {
    let head: Buffer;
    try {
      const result = await backend.readStream(payload.key, { start: 0, end: 1023 });
      if (!result) {
        const cleaned = await cleanupObject(backend, client, payload.key);
        return { ok: false, code: "MISSING_OBJECT", message: "Uploaded object vanished during verification", cleaned };
      }
      head = await collectStreamHead(result.stream);
    } catch (e) {
      return { ok: false, code: "VERIFICATION_FAILED", message: (e as Error).message };
    }
    if (!spec.verifyMagicBytes(head)) {
      const cleaned = await cleanupObject(backend, client, payload.key);
      return { ok: false, code: "MAGIC_REJECTED", message: "File content is not a valid PDF", cleaned };
    }
  }

  // 6. Original name metadata + extension enforcement (PDF: .pdf).
  const originalName = sanitizeOriginalFilename(
    asTrimmedString(input.originalName) ?? undefined,
    spec.kind === "DOCUMENT" ? "document.pdf" : "video"
  );
  if (spec.requireExtension && !spec.requireExtension(originalName)) {
    const cleaned = await cleanupObject(backend, client, payload.key);
    return {
      ok: false,
      code: "EXTENSION_REJECTED",
      message: "Only .pdf files are accepted",
      cleaned,
    };
  }

  // 7. Optional SHA-256 integrity proof (browser-computed, streamed check).
  let sha256Hex: string | null = null;
  if (input.sha256 != null) {
    const claimed = asTrimmedString(input.sha256);
    if (!claimed || !/^[a-f0-9]{64}$/i.test(claimed)) {
      const cleaned = await cleanupObject(backend, client, payload.key);
      return { ok: false, code: "SHA256_INVALID", message: "Invalid sha256 field", cleaned };
    }
    try {
      sha256Hex = await backend.sha256(payload.key);
    } catch (e) {
      return { ok: false, code: "VERIFICATION_FAILED", message: (e as Error).message };
    }
    if (!safeHexEqual(sha256Hex, claimed)) {
      const cleaned = await cleanupObject(backend, client, payload.key);
      return {
        ok: false,
        code: "SHA256_MISMATCH",
        message: "Uploaded object failed the integrity check",
        cleaned,
      };
    }
  }

  // 8. Object VERIFIED. Only now create rows. The bytes live in R2 — the row
  //    records the S3 storage value (never inferred from the key shape).
  const storage = mediaStorageValueForBackend("s3");

  try {
    if (payload.purpose === "SESSION_VIDEO") {
      const titleAr =
        (asTrimmedString(input.titleAr) && String(input.titleAr).trim()) || title;
      const description = asTrimmedString(input.description);
      const publish = input.publish === true;

      let created:
        | { kind: "CREATED"; assetId: string; video: Record<string, unknown> }
        | { kind: "FINALIZED"; mediaAssetId: string; video: Record<string, unknown> | null }
        | { kind: "INCONSISTENT" };
      if (typeof (client as { $transaction?: unknown }).$transaction === "function") {
        created = await (client as typeof db).$transaction(async (tx: any) => {
          // Phase 23 concurrency: serialize finalization per exact storage
          // key, then RE-CHECK the persisted linkage inside the lock. A twin
          // completion that committed first makes this tx return the
          // idempotent result instead of creating duplicate rows.
          await acquireUploadFinalizeLock(tx, payload.key);
          const linkage = await resolveExistingLinkage(
            tx as unknown as typeof db,
            payload,
            target,
            trackScope ?? null
          );
          if (linkage.status === "FINALIZED") {
            return {
              kind: "FINALIZED" as const,
              mediaAssetId: linkage.mediaAssetId,
              video: linkage.video,
            };
          }
          if (linkage.status === "INCONSISTENT") {
            return { kind: "INCONSISTENT" as const };
          }
          const asset = await tx.mediaAsset.create({
            data: {
              kind: spec.kind,
              storage,
              storageKey: payload.key,
              mimeType: payload.contentType,
              sizeBytes: size,
              originalName,
              isPrivate: true,
              createdById: input.actorUserId ?? null,
            },
          });
          const video = await tx.sessionVideo.create({
            data: {
              batchId: target.batchId!,
              lessonId: target.lessonId,
              mediaAssetId: asset.id,
              title,
              titleAr,
              description,
              isPublished: publish,
              publishedAt: publish ? new Date() : null,
            },
          });
          return {
            kind: "CREATED" as const,
            assetId: asset.id,
            video: video as unknown as Record<string, unknown>,
          };
        });
      } else {
        const asset = await client.mediaAsset.create({
          data: {
            kind: spec.kind,
            storage,
            storageKey: payload.key,
            mimeType: payload.contentType,
            sizeBytes: size,
            originalName,
            isPrivate: true,
            createdById: input.actorUserId ?? null,
          },
        });
        const video = await client.sessionVideo.create({
          data: {
            batchId: target.batchId!,
            lessonId: target.lessonId,
            mediaAssetId: asset.id,
            title,
            titleAr,
            description,
            isPublished: publish,
            publishedAt: publish ? new Date() : null,
          },
        });
        created = {
          kind: "CREATED",
          assetId: asset.id,
          video: video as unknown as Record<string, unknown>,
        };
      }

      // A twin completion committed first — this tx saw its rows under the
      // lock. Return the idempotent result; nothing was created here.
      if (created.kind === "FINALIZED") {
        return {
          ok: true,
          purpose: payload.purpose,
          mediaAssetId: created.mediaAssetId,
          replay: true,
          video: created.video,
        };
      }
      if (created.kind === "INCONSISTENT") {
        return {
          ok: false,
          code: "ALREADY_LINKED",
          message:
            "This upload was already recorded with different data — refusing to modify it",
        };
      }

      return {
        ok: true,
        purpose: payload.purpose,
        mediaAssetId: created.assetId,
        video: created.video,
      };
    }

    // LESSON_PDF — shared finalization (deactivate prior + rows + refcount
    // cleanup). The presigned bytes are already verified and in R2; the
    // target, scope and title were all validated before any object I/O.
    const finalized = await finalizeLessonPdfMaterial(
      {
        lesson: target.lesson!,
        trackScope: trackScope!,
        title: asTrimmedString(input.title),
        storage,
        storageKey: payload.key,
        mimeType: payload.contentType,
        sizeBytes: size,
        originalName,
        actorUserId: input.actorUserId,
      },
      client,
      {
        // Phase 23 concurrency gate — runs FIRST inside the finalizer's own
        // transaction: acquire the per-storage-key advisory lock, then
        // re-check the persisted linkage. A twin completion that committed
        // first turns this finalize into the idempotent replay outcome (or a
        // fail-closed ALREADY_LINKED refusal) with zero rows written.
        serialize: async (tx): Promise<
          | { proceed: true }
          | { proceed: false; outcome: FinalizeLessonPdfResult }
        > => {
          await acquireUploadFinalizeLock(tx, payload.key);
          const linkage = await resolveExistingLinkage(
            tx as unknown as typeof db,
            payload,
            target,
            trackScope ?? null
          );
          if (linkage.status === "FINALIZED") {
            return {
              proceed: false,
              outcome: {
                ok: true,
                replay: true,
                material: linkage.material as FinalizeLessonPdfResult extends {
                  ok: true;
                  material: infer M
                }
                  ? M
                  : never,
                replaced: [],
                cleanedUpAssets: [],
              },
            };
          }
          if (linkage.status === "INCONSISTENT") {
            return {
              proceed: false,
              outcome: {
                ok: false,
                code: "ALREADY_LINKED",
                message:
                  "This upload was already recorded with different data — refusing to modify it",
              },
            };
          }
          return { proceed: true };
        },
      }
    );
    if (!finalized.ok) {
      // ALREADY_LINKED from the gate means a linkage already existed and
      // NOTHING was written here — the referenced bytes must never be
      // touched (and the guard would refuse anyway; skipping is explicit).
      const cleaned =
        finalized.code === "ALREADY_LINKED"
          ? undefined
          : await cleanupObject(backend, client, payload.key);
      return { ok: false, code: finalized.code, message: finalized.message, cleaned };
    }

    return {
      ok: true,
      purpose: payload.purpose,
      mediaAssetId: finalized.material.mediaAssetId,
      replay: finalized.replay === true ? true : undefined,
      material: finalized.material as unknown as Record<string, unknown>,
      replaced: finalized.replaced,
      cleanedUpAssets: finalized.cleanedUpAssets,
    };
  } catch (e) {
    // DB failure AFTER a verified upload. Before ANY destructive action,
    // re-resolve the linkage: if the rows actually landed (the failure was
    // post-commit cleanup, or a concurrent identical completion won the
    // race), the upload IS finalized — return the idempotent result instead
    // of an error. Only when the key is provably unreferenced does the
    // guarded exact-key cleanup run (it re-checks and refuses on any doubt).
    const after = await resolveExistingLinkage(
      client,
      payload,
      target,
      trackScope ?? null
    ).catch(() => null);
    if (after && after.status === "FINALIZED") {
      return {
        ok: true,
        purpose: payload.purpose,
        mediaAssetId: after.mediaAssetId,
        replay: true,
        video: after.video,
        material: after.material,
        replaced: [],
        cleanedUpAssets: [],
      };
    }
    const cleaned = await cleanupObject(backend, client, payload.key);
    return {
      ok: false,
      code: "DB_CREATE_FAILED",
      message: (e as Error).message || "Failed to record the upload",
      cleaned,
    };
  }
}
