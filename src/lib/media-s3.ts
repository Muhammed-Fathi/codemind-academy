// CodeMind Academy — S3-compatible storage backend (Cloudflare R2).
//
// This module implements the `StorageBackend` contract from `src/lib/media.ts`
// on top of the official AWS S3 SDK so it works against Cloudflare R2's
// S3-compatible API. It is LOADED LAZILY by `createStorageBackend("s3")` —
// a deployment running the default `MEDIA_BACKEND=local` never imports the
// AWS SDK at all.
//
// SECURITY MODEL:
//   * R2 objects are PRIVATE. No public bucket access, no ACL grants, no
//     anonymous reads. Reads ALWAYS flow: Browser → CodeMind server → R2 —
//     there is NO presigned GET and there is NO bucket LIST capability.
//   * WRITES for large admin media may flow direct: Browser → R2 via a
//     SHORT-LIVED presigned PUT issued by `createPresignedPutUrl` (Phase 23).
//     That is the only signed-URL surface in the entire codebase: PUT only,
//     signed over the exact server-generated key, expiring within minutes.
//     The storage key is always generated server-side; the client never
//     supplies one. Every authorization decision stays in the routes and in
//     `src/lib/media-upload.ts` / `src/lib/session-materials.ts`.
//   * All R2 credentials are SERVER-SIDE env vars only (R2_*). Nothing here
//     may ever be referenced from a NEXT_PUBLIC_* variable or client bundle.
//     A presigned URL carries a time-boxed request signature — never a
//     credential — and grants PUT on exactly one key.
//   * This layer still moves BYTES ONLY. MIME allow-lists, size ceilings,
//     magic-byte validation, storage-key generation and every authorization
//     decision remain in the routes and `src/lib/session-materials.ts`.
//
// BEHAVIORAL PARITY with `LocalStorageBackend` (verified by
// tests/s3-storage-r2.test.js):
//   * read()/sha256() of a missing object reject with an ENOENT-coded error,
//     exactly like the fs-based backend, so `.catch(() => null)` callers keep
//     mapping "missing" to 404 without changes.
//   * stat()/readStream() return `null` for a missing object.
//   * delete() is idempotent.
//   * Inclusive byte ranges use the SAME resolution as the local backend
//     (shared `resolveStorageReadRange`): open-ended bounds allowed, `end`
//     past EOF is CLAMPED, `start` at/past EOF or start>end throws
//     RangeError, and the 416 HTTP mapping stays the route's job.
//   * sha256() streams the object through the hash — it never buffers the
//     whole object in memory.

import { createHash } from "crypto";
import { Readable } from "stream";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  StorageBackend,
  StorageBackendName,
  StorageReadRange,
  StorageStreamResult,
  StorageWriteMetadata,
  PrivateFileStat,
} from "./media";
import { resolveStorageReadRange } from "./media";
import { resolveDirectUploadOrigin } from "./r2-upload-origin";

/**
 * Minimal structural surface of an S3 client. The real `S3Client` satisfies
 * it; tests inject a deterministic fake at exactly THIS boundary, so the
 * suite never touches the network.
 */
export interface S3ClientLike {
  send(command: unknown): Promise<Record<string, unknown>>;
}

export interface S3StorageBackendOptions {
  /** The S3/R2 client used to move bytes. Injected for testability. */
  client: S3ClientLike;
  /** Target bucket, e.g. `codemind-academy-media`. */
  bucket: string;
}

/** True for S3/R2 responses meaning "object does not exist" — nothing else. */
function isS3NotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  // R2/S3 spell absence as NoSuchKey on GET and NotFound (or a bare 404) on
  // HEAD. A 403 is an authorization problem, NOT absence — never map it away.
  if (e.name === "NoSuchKey" || e.name === "NotFound") return true;
  return e.$metadata?.httpStatusCode === 404;
}

/**
 * Same missing-object shape the local (fs) backend produces: an Error whose
 * `code` is "ENOENT". Route helpers that catch-and-404 therefore behave
 * identically under both backends.
 */
function missingObjectError(key: string): Error {
  const err = new Error(`ENOENT: no such storage object, '${key}'`);
  (err as { code?: string }).code = "ENOENT";
  return err;
}

/** Coerce an SDK response body into a Node Readable without extra copying. */
function toReadable(body: unknown): Readable {
  if (body instanceof Readable) return body;
  if (body && typeof (body as Readable).pipe === "function") {
    return body as Readable;
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    return Readable.from(Buffer.isBuffer(body) ? body : Buffer.from(body));
  }
  if (typeof body === "string") return Readable.from(Buffer.from(body));
  // null/undefined body — treat as an empty object.
  return Readable.from([]);
}

/** Drain a stream into a Buffer (used only by full-object `read`). */
async function collectStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * S3-compatible backend for private media objects. Objects are addressed by
 * the same database-controlled `storageKey` the application has always used;
 * keys are stored verbatim (`<scope>/<random>.<ext>` is a valid object key).
 *
 * The server is the principal for every READ. Writes go through `write()`
 * (server-buffered) or — for the Phase 23 direct upload flow — through a
 * short-lived presigned PUT created by `createPresignedPutUrl`. No public
 * ACLs, no presigned GET, no list capability, ever.
 */
export class S3StorageBackend implements StorageBackend {
  readonly name: StorageBackendName = "s3";
  private readonly client: S3ClientLike;
  private readonly bucket: string;

  constructor(options: S3StorageBackendOptions) {
    this.client = options.client;
    this.bucket = options.bucket;
  }

  /**
   * Persist bytes under `key`. `mimeType` is stored as the object's
   * ContentType; `originalName` stays on the MediaAsset row (the source of
   * truth), exactly as with the local backend. No ACL is set — R2 objects
   * are private by default.
   */
  async write(
    key: string,
    data: Buffer | Uint8Array,
    metadata?: StorageWriteMetadata
  ): Promise<string> {
    const body = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ...(metadata?.mimeType ? { ContentType: metadata.mimeType } : {}),
      })
    );
    return key;
  }

  /** Read the whole object. Rejects with an ENOENT-coded error if missing. */
  async read(key: string): Promise<Buffer> {
    let out: Record<string, unknown>;
    try {
      out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
    } catch (err) {
      if (isS3NotFound(err)) throw missingObjectError(key);
      throw err;
    }
    return collectStream(toReadable(out.Body));
  }

  /** Remove the object. Idempotent: S3 delete is 204 even when absent. */
  async delete(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
      );
    } catch (err) {
      if (isS3NotFound(err)) return; // already gone — parity with local
      throw err;
    }
  }

  /** Object metadata, or `null` when the object does not exist. */
  async stat(key: string): Promise<PrivateFileStat | null> {
    let out: Record<string, unknown>;
    try {
      out = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
    } catch (err) {
      if (isS3NotFound(err)) return null;
      throw err;
    }
    const lastModified =
      out.LastModified instanceof Date ? out.LastModified : null;
    const size = Number(out.ContentLength ?? 0);
    return {
      size,
      lastModified,
      // The object's recorded Content-Type (null when the service omits it).
      // Used by Phase 23 completion to verify what actually landed in R2.
      contentType: typeof out.ContentType === "string" ? out.ContentType : null,
    };
  }

  /**
   * SHA-256 hex of the object's bytes, STREAMED through the hash — the
   * object is never buffered whole in memory, matching the local backend.
   * Missing objects reject with the same ENOENT-coded error as `read`.
   */
  async sha256(key: string): Promise<string> {
    let out: Record<string, unknown>;
    try {
      out = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
    } catch (err) {
      if (isS3NotFound(err)) throw missingObjectError(key);
      throw err;
    }
    const hash = createHash("sha256");
    const stream = toReadable(out.Body);
    for await (const chunk of stream) {
      hash.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return hash.digest("hex");
  }

  /**
   * Streaming read with an optional inclusive byte range.
   *
   * Semantics are IDENTICAL to `LocalStorageBackend.readStream` because both
   * resolve the range through the shared `resolveStorageReadRange`:
   *   * missing object → `null` (routes map to 404);
   *   * `{start, end}` inclusive, either bound open;
   *   * `end` past EOF is clamped to the last byte;
   *   * unsatisfiable/invalid ranges throw RangeError — the ROUTE owns the
   *     416 mapping, exactly as today.
   *
   * Flow: HEAD for the total size (so clamping/416 are decided with S3
   * semantics before any ranged GET), then a plain GET or a
   * `Range: bytes=start-end` GET. Ranged responses are NOT re-clamped here;
   * S3 honours the header and `Content-Length` is computed from the resolved
   * range so callers get consistent 206 bookkeeping either way.
   */
  async readStream(
    key: string,
    range?: StorageReadRange
  ): Promise<StorageStreamResult | null> {
    let head: Record<string, unknown>;
    try {
      head = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key })
      );
    } catch (err) {
      if (isS3NotFound(err)) return null;
      throw err;
    }
    const size = Number(head.ContentLength ?? 0);
    // Throws RangeError for unsatisfiable/invalid ranges — same messages as
    // the local backend (shared implementation).
    const resolved = resolveStorageReadRange(range, size);

    if (size === 0) {
      return {
        stream: Readable.from([]),
        size: 0,
        start: 0,
        end: -1,
        contentLength: 0,
      };
    }

    const { start, end } = resolved;
    const isPartial = start !== 0 || end !== size - 1;
    let out: Record<string, unknown>;
    try {
      out = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: key,
          ...(isPartial ? { Range: `bytes=${start}-${end}` } : {}),
        })
      );
    } catch (err) {
      // Vanished between HEAD and GET — treat as missing, like the local
      // backend treating a racing unlink as a miss.
      if (isS3NotFound(err)) return null;
      throw err;
    }
    return {
      stream: toReadable(out.Body),
      size,
      start,
      end,
      contentLength: end - start + 1,
    };
  }

  /**
   * Issue a SHORT-LIVED presigned PUT for one exact object key.
   *
   * Phase 23 — the only signed-URL surface in the codebase. Guarantees:
   *   * PUT-only: the command signed is constructed HERE, internally, and is
   *     always a PutObjectCommand. Callers cannot pass a command, so no
   *     GetObject/List/Multipart command can ever be presigned.
   *   * Exact key: the key is signed into the URL; the client cannot change
   *     it without invalidating the signature.
   *   * Content-Type pinned by the grant + ENFORCED at completion: the
   *     browser MUST send exactly the Content-Type this grant carries, and
   *     the presigned completion HEADs the stored object and deletes/rejects
   *     any mismatch. (The AWS SDK presigner deliberately marks content-type
   *     UNSIGNABLE in SigV4 query URLs — `unsignableHeaders.add("content-type")`
   *     in @aws-sdk/s3-request-presigner — so no presigning setup can bind it
   *     by signature; the byte-level guarantee lives in the completion
   *     verification, which is stronger anyway: the stored bytes themselves
   *     are checked, not the request.)
   *   * Short expiry: bounded by [PRESIGN_PUT_MIN_EXPIRES_SEC,
   *     PRESIGN_PUT_MAX_EXPIRES_SEC] — minutes, never hours.
   *   * No credential exposure: the URL carries an AWS SigV4 query signature
   *     only; the R2 secret key never leaves the server.
   *
   * `signer` is an injection point for tests. The default performs PURE
   * COMPUTATION with the real SDK presigner — it never performs network I/O.
   */
  async createPresignedPutUrl(
    input: PresignedPutRequest,
    signer: PresignedPutSigner = defaultPresignedPutSigner
  ): Promise<PresignedPutGrant> {
    const key = typeof input.key === "string" ? input.key : "";
    if (!key || key.startsWith("/") || key.includes("..") || /[\u0000-\u001f\u007f]/.test(key)) {
      throw new Error("createPresignedPutUrl: invalid storage key");
    }
    const contentType = String(input.contentType ?? "").trim();
    if (!contentType) {
      throw new Error(
        "createPresignedPutUrl: contentType is required — the presigned PUT signs it"
      );
    }
    const expiresInSec = Math.floor(Number(input.expiresInSec));
    if (
      !Number.isSafeInteger(expiresInSec) ||
      expiresInSec < PRESIGN_PUT_MIN_EXPIRES_SEC ||
      expiresInSec > PRESIGN_PUT_MAX_EXPIRES_SEC
    ) {
      throw new Error(
        `createPresignedPutUrl: expiresInSec must be an integer between ` +
          `${PRESIGN_PUT_MIN_EXPIRES_SEC} and ${PRESIGN_PUT_MAX_EXPIRES_SEC}`
      );
    }

    // The ONLY command ever presigned. Do not widen this to accept commands
    // from callers — the PUT-only guarantee depends on it being built here.
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentType: contentType,
    });
    const url = await signer(this.client, command, { expiresInSec });
    if (typeof url !== "string" || url.length === 0) {
      throw new Error("createPresignedPutUrl: signer produced no URL");
    }
    return {
      url,
      method: "PUT",
      key,
      contentType,
      expiresInSec,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  }
}

// ---------------------------------------------------------------------------
// Presigned PUT — types, bounds and the default signer (Phase 23)
// ---------------------------------------------------------------------------

/** Presign expiry bounds (seconds): short-lived by construction. */
export const PRESIGN_PUT_MIN_EXPIRES_SEC = 60;
export const PRESIGN_PUT_MAX_EXPIRES_SEC = 900;

/** Request shape for `S3StorageBackend.createPresignedPutUrl`. */
export type PresignedPutRequest = {
  /** Exact object key — generated server-side, never by a client. */
  key: string;
  /** Content-Type the browser MUST send; signed into the URL. */
  contentType: string;
  /** Lifetime of the presigned URL, bounded to a short window. */
  expiresInSec: number;
};

/** What a successful presign returns — the minimum the browser needs. */
export type PresignedPutGrant = {
  url: string;
  method: "PUT";
  key: string;
  contentType: string;
  expiresInSec: number;
  expiresAt: Date;
};

/**
 * Test boundary for URL signing. The real implementation performs pure
 * SigV4 computation (no network). Tests inject a deterministic fake HERE —
 * the same dependency-injection seam as `S3ClientLike`.
 */
export type PresignedPutSigner = (
  client: S3ClientLike,
  command: unknown,
  options: { expiresInSec: number }
) => Promise<string>;

/**
 * The real signer: `@aws-sdk/s3-request-presigner.getSignedUrl`. Pure
 * computation — the SDK presigns by walking the client's middleware stack
 * in-memory; it performs no network I/O and never transmits the secret key
 * anywhere. Import is static but this whole module is loaded lazily by
 * `createStorageBackend("s3")`, so local-backend deployments never load it.
 */
export const defaultPresignedPutSigner: PresignedPutSigner = async (
  client,
  command,
  { expiresInSec }
) =>
  getSignedUrl(
    client as unknown as Parameters<typeof getSignedUrl>[0],
    command as Parameters<typeof getSignedUrl>[1],
    { expiresIn: expiresInSec }
  );

// ---------------------------------------------------------------------------
// Configuration — SERVER-SIDE env vars only. Fail closed on anything missing.
// ---------------------------------------------------------------------------

/** Required R2/S3 configuration resolved from the server environment. */
export type R2StorageConfig = {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  /** R2's region is `auto`. */
  region: string;
  /** Full S3 API endpoint (defaults to the R2 endpoint for the account). */
  endpoint: string;
  /** Exact virtual-hosted upload origin (shared contract). */
  uploadOrigin?: string;
};

/** Variables that MUST be present (and non-empty) for the s3 backend. */
export const REQUIRED_R2_ENV_VARS = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
] as const;

/**
 * Resolve R2 configuration from server env vars.
 *
 * FAIL CLOSED: any missing required variable throws, naming the MISSING VAR
 * NAMES ONLY — never values. No credential ever appears in an error message,
 * a log line, or anything browser-visible.
 */
export function resolveR2Config(env: NodeJS.ProcessEnv = process.env): R2StorageConfig {
  const missing = REQUIRED_R2_ENV_VARS.filter(
    (name) => !String(env[name] ?? "").trim()
  );
  if (missing.length > 0) {
    throw new Error(
      `MEDIA_BACKEND=s3 requires server-side env vars that are missing or ` +
        `empty: ${missing.join(", ")}. See .env.example. These are ` +
        `server-only secrets — they must never be NEXT_PUBLIC_* variables.`
    );
  }
  const accountId = String(env.R2_ACCOUNT_ID).trim();
  const endpoint =
    String(env.R2_S3_ENDPOINT ?? "").trim() ||
    `https://${accountId}.r2.cloudflarestorage.com`;
  return {
    accountId,
    accessKeyId: String(env.R2_ACCESS_KEY_ID).trim(),
    secretAccessKey: String(env.R2_SECRET_ACCESS_KEY).trim(),
    bucket: String(env.R2_BUCKET).trim(),
    region: String(env.R2_REGION ?? "").trim() || "auto",
    endpoint,
    uploadOrigin: resolveDirectUploadOrigin({
      MEDIA_BACKEND: "s3",
      R2_BUCKET: String(env.R2_BUCKET).trim(),
      R2_ACCOUNT_ID: accountId,
      R2_S3_ENDPOINT: endpoint,
    }).origin ?? undefined,
  };
}

/**
 * Build the real S3 client for R2. Constructing the client performs NO
 * network I/O; requests happen only when the backend sends commands.
 */
export function createR2S3Client(config: R2StorageConfig): S3ClientLike {
  return new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
  });
}

/**
 * Entry point used by `createStorageBackend("s3")` in `src/lib/media.ts`:
 * resolve env, build the client, wrap it. Throws (fail closed) when the
 * required R2 variables are absent.
 */
export function createS3StorageBackendFromEnv(
  env: NodeJS.ProcessEnv = process.env
): S3StorageBackend {
  const config = resolveR2Config(env);
  return new S3StorageBackend({
    client: createR2S3Client(config),
    bucket: config.bucket,
  });
}
