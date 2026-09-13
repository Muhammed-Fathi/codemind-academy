// CodeMind Academy — S3-compatible storage backend (Cloudflare R2).
//
// This module implements the `StorageBackend` contract from `src/lib/media.ts`
// on top of the official AWS S3 SDK so it works against Cloudflare R2's
// S3-compatible API. It is LOADED LAZILY by `createStorageBackend("s3")` —
// a deployment running the default `MEDIA_BACKEND=local` never imports the
// AWS SDK at all.
//
// SECURITY MODEL (unchanged from the local backend):
//   * R2 objects are PRIVATE. No public bucket access, no ACL grants, no
//     signed URLs, no direct browser uploads. Bytes flow:
//         Browser → CodeMind server → R2
//   * All R2 credentials are SERVER-SIDE env vars only (R2_*). Nothing here
//     may ever be referenced from a NEXT_PUBLIC_* variable or client bundle.
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
import type {
  StorageBackend,
  StorageBackendName,
  StorageReadRange,
  StorageStreamResult,
  StorageWriteMetadata,
  PrivateFileStat,
} from "./media";
import { resolveStorageReadRange } from "./media";

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
 * No signed URLs, no public ACLs, no presigned uploads: the server is the
 * only principal that ever talks to the bucket.
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
    return { size, lastModified };
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
}

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
