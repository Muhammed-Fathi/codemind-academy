# Phase 23 — Presigned R2 Uploads for Large Admin Media

Status: IMPLEMENTED (offline-verified). No deployment, no bucket change, no
schema change.

## What changed

Large private admin media (session videos, lesson/material PDFs) no longer has
to buffer through the app server. Uploads now flow **directly from the browser
to the private Cloudflare R2 bucket** under a short-lived, tightly-scoped
presigned PUT, while every read stays server-proxied exactly as before:

```
Browser → POST /api/admin/media-uploads/init     (requireRole("ADMIN") + rate limit)
            server: authorize target (batch/lesson), validate declared MIME +
            size against the SAME allow-lists/ceilings as the buffered path,
            check volume quota, generate the EXACT storage key server-side,
            presign a short-lived PUT carrying the granted Content-Type,
            sign an HMAC
            upload-intent token bound to every upload parameter.
        ← { uploadUrl, method: "PUT", token, contentType, maxBytes,
            expiresInSec, expiresAt }

Browser → PUT <uploadUrl>        (bytes straight into the PRIVATE bucket)

Browser → POST /api/admin/media-uploads/complete   (requireRole("ADMIN") + rate limit)
            server: verify intent token (signature/expiry/user/purpose/exact
            key/content type/max bytes) → re-run target authorization →
            HEAD/stat: exists → non-empty → size ≤ signed max → stored
            Content-Type matches the granted type → magic bytes (PDF) →
            SHA-256
            (when provided) → ONLY THEN create MediaAsset + related rows.
            Any object-level failure DELETES the object by its exact key.
```

Quiz evidence images are **deliberately unchanged** — they keep the
server-proxied upload path.

## Files

| File | Change |
| --- | --- |
| `src/lib/media-s3.ts` | `createPresignedPutUrl` (PUT-only presigning, exact-key + bounded expiry, injectable signer), `stat()` now reports stored `ContentType`. The ONLY signed-URL surface in the codebase. |
| `src/lib/db-serialization.ts` | NEW — database-aware serialization: provider detection (`DATABASE_URL` scheme), per-storage-key `pg_advisory_xact_lock` acquisition inside the finalization transaction (PostgreSQL), deliberate no-op on SQLite (single-writer database). |
| `src/lib/media-upload.ts` | NEW — purpose registry (SESSION_VIDEO / LESSON_PDF), HMAC upload-intent tokens (sign/verify), `initPresignedUpload`, `completePresignedUpload` (object → verification → DB rows; **idempotent replay via persisted storageKey linkage**; reference-checked exact-key cleanup), HTTP status table. |
| `src/lib/session-materials.ts` | `uploadLessonPdfMaterial` refactored to delegate its row-creation half to the NEW `finalizeLessonPdfMaterial` — reused verbatim by the presigned PDF completion (no duplicated replace/deactivate/refcount logic). Behavior unchanged. |
| `src/lib/media.ts` | `PrivateFileStat` gains optional `contentType` (S3 HEAD reports it; local fs reports `null`). |
| `src/app/api/admin/media-uploads/init/route.ts` | NEW — ADMIN + `pdfUpload` rate limit + init. |
| `src/app/api/admin/media-uploads/complete/route.ts` | NEW — ADMIN + `pdfUpload` rate limit + completion. |
| `src/lib/direct-upload.ts` | NEW — browser-side 3-leg flow (init → PUT → complete), typed per-stage failures, optional WebCrypto SHA-256. No credential/bucket/key knowledge. |
| `src/components/admin/session-videos-view.tsx` | Video upload uses the direct flow; falls back to the buffered multipart POST on `PRESIGNED_UNSUPPORTED` (MEDIA_BACKEND=local deployments). |
| `src/components/admin/session-pdf-manager.tsx` | PDF upload uses the direct flow (with browser SHA-256); same fallback. |
| `src/lib/i18n-dict-2026.ts` | `admin.506`–`admin.508` per-stage failure strings (ar/en). |
| `next.config.ts` | `@aws-sdk/s3-request-presigner` added to `serverExternalPackages` (server-only SDK family). |
| `.env.example` | `MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC` documented; R2 comment updated to describe the presigned PUT surface. |
| `tests/presigned-uploads-phase23.test.js` | NEW — the full offline verification matrix. |

Dependency change: **`@aws-sdk/s3-request-presigner` (added, pinned to the same
3.1131.x SDK family)** — the minimum needed for presigning. Nothing else added;
`bun.lock` untouched.

## upload-init design

`initPresignedUpload` (server-side only):

1. `purpose` must be `SESSION_VIDEO` or `LESSON_PDF` (evidence excluded).
2. **Active-backend gate**: `resolveStorageBackendName() === "s3"` or the
   request is refused with `PRESIGNED_UNSUPPORTED` (409). Under
   `MEDIA_BACKEND=local` there is no object store to upload to — fail closed,
   the client falls back to the buffered endpoints.
3. Declared size: positive safe integer and ≤ the purpose ceiling
   (`MEDIA_MAX_VIDEO_BYTES` / `MEDIA_MAX_PDF_BYTES` — the SAME limits the
   buffered path enforces).
4. Declared MIME: normalized and allow-listed (`video/*` set /
   `application/pdf`); PDFs tolerate omission and default to
   `application/pdf`. The exact value rides on the presigned PUT grant and is
   ENFORCED AT COMPLETION: the AWS SDK presigner deliberately marks
   content-type unsignable in SigV4 query URLs (`unsignableHeaders` in
   `@aws-sdk/s3-request-presigner`), so the byte-level guarantee is the
   completion HEAD — a stored object whose Content-Type differs from the
   grant is deleted and rejected (`MIME_MISMATCH`). The browser client always
   sends the granted type byte-for-byte.
5. Target authorization, re-used from the buffered paths: batch must exist
   (video), lesson must exist and not be archived (PDF).
6. Volume quota (`MEDIA_QUOTA_BYTES`) checked BEFORE anything is issued.
7. Storage key generated server-side via `makeStorageKey(scope, ext)` — the
   client never sees or influences it.
8. `createPresignedPutUrl({ key, contentType, expiresInSec })` — builds the
   `PutObjectCommand` internally (callers cannot pass a command ⇒ nothing but
   a PUT can ever be presigned) and signs it with `@aws-sdk/s3-request-presigner`.
9. HMAC upload-intent token signed; response returns only
   `{ uploadUrl, method, token, contentType, maxBytes, expiresInSec, expiresAt, purpose }`.

## Intent-token design

`token = base64url(payload) + "." + base64url(HMAC-SHA256(payload))`, keyed by
`SECURITY_HASH_SECRET` (production-mandatory, see `src/lib/env.ts`), with a
domain-separated context `codemind.upload-intent.v1` so this MAC can never be
confused with any other use of the secret.

```jsonc
{
  "v": 1,
  "jti": "<random nonce>",       // HMAC uniqueness nonce (NOT the consumed marker)
  "sub": "<admin user id>",      // completion must come from this user
  "purpose": "SESSION_VIDEO" | "LESSON_PDF",
  "kind": "VIDEO" | "DOCUMENT",
  "key": "session-videos/<random>.mp4",   // EXACT storage key
  "contentType": "video/mp4",             // type the browser must send & object must carry
  "maxBytes": 536870912,                  // ceiling at verification time
  "iat": 1760000000,
  "exp": 1760000600
}
```

Verification (`verifyUploadIntent`) is structural → constant-time MAC →
expiry → bearer check. Any tampering with any field (key, user, purpose,
kind, type, size, time) invalidates the MAC; the hard `exp − iat ≤ 3600`
structural bound means no hand-crafted token can extend the window.

Presign/intent window: `MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC` (default 600,
clamped to [60, 900] seconds).

## Completion verification design

`completePresignedUpload`, in order:

1. Intent token: signature → expiry (410) → user (403) → purpose/kind.
2. Re-run target authorization (batch/lesson may have changed since init) —
   the same checks init applied.
3. `HEAD` the object through the storage backend:
   * missing → `MISSING_OBJECT` (nothing to clean);
   * empty, or size > token `maxBytes` → reject + delete;
   * stored `Content-Type` ≠ token type → `MIME_MISMATCH` + delete;
4. PDF only: stream-read the first 1 KB → `%PDF-` magic must be present,
   else `MAGIC_REJECTED` + delete; sanitized original name must still be
   `.pdf`, else `EXTENSION_REJECTED` + delete.
5. If the browser supplied `sha256` (hex): stream-hash the stored object and
   compare constant-time; mismatch → `SHA256_MISMATCH` + delete.
6. **Only now** create rows — video: `MediaAsset(VIDEO, storage=S3)` +
   `SessionVideo` in one transaction; PDF: `finalizeLessonPdfMaterial`
   (deactivate prior active material of the same scope, create rows, refcount
   cleanup) — the exact logic the buffered path has always used.
7. DB failure after verification → attempt exact-key delete of the verified
   object, answer `DB_CREATE_FAILED` with `cleaned: true/false`.

Deletes are always by EXACT key (from the signed token). There is **no prefix
delete and no listing anywhere** in the flow.

### Failure ordering (no phantom rows, no silent orphans, no lost bytes)

```
object → verification → DB rows
```

* A failure before step 6 can never leave a DB row.
* A failure in step 6 (rows failed) triggers exact-key object cleanup — but
  ONLY after proving no `MediaAsset` row records the key (the cleanup guard
  refuses otherwise), and ONLY after a linkage re-check that converts
  "failure after the rows actually landed" into the idempotent success. If
  the delete itself is refused or fails, the response reports
  `cleaned: false`; no row ever points at missing bytes.

## R2 CORS requirement (manual operator step — NOT applied by this repo)

Direct browser PUTs are cross-origin requests. The bucket CORS policy must
allow exactly this (apply once in the Cloudflare dashboard / via `wrangler` —
the application never mutates bucket configuration):

```json
[
  {
    "AllowedOrigins": [
      "https://codemind.academy",
      "http://localhost:3000"
    ],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

Notes:

* **Origins**: the production origin(s) that serve the admin UI — the
  documented deployment origin is `https://codemind.academy`; add any
  additional admin-facing origin explicitly. `localhost:3000` is for local
  development only. Never use `"*"`.
* **Methods**: `PUT` only. The flow never presigns GET/POST/LIST — if you
  find yourself adding `GET`, something has regressed (reads must stay
  server-proxied).
* **AllowedHeaders**: `content-type` — the header the server grants and the
  browser must echo. Nothing else is needed (SigV4 query auth carries the
  rest).
* `MaxAgeSeconds` lets the browser cache the preflight.

## Replay & idempotency (Phase 23 hardening)

Completion is **IDEMPOTENT — not "single-use"**. The intent token is never
"consumed" by the token itself and there is **no in-memory consumed-token
set** (non-authoritative under serverless/multi-instance) and **no `jti`
ledger** (that would need a new table). The consumed marker is the
**persisted database linkage**: a `MediaAsset` row recorded under the EXACT
`storageKey` bound in the token. It is written only after full object
verification, so it means exactly "this upload was already finalized".

`/complete` therefore behaves deterministically for every replay of the same
token:

| State of the key at replay time | Outcome |
| --- | --- |
| Not linked to any `MediaAsset` | normal first completion proceeds |
| Linked to the SAME resource this token targets (same video batch/lesson, or same active lesson×trackScope material) | **idempotent success** — the ORIGINAL `MediaAsset`/video/material ids are returned with `replay: true`; no rows created, no object touched, no deletes issued |
| Linked, but differently (other kind / batch / lesson / scope, or an orphaned partial row) | **fail closed** — `409 ALREADY_LINKED`; the linked rows and the object are left untouched |
| Previously finalized, then refcount-cleaned by a newer upload | fails safely (`MISSING_OBJECT`/`ALREADY_LINKED`) — the newer material and its bytes are never touched |

The same resolution re-runs inside the DB-failure handler: if a row creation
"fails" because the linkage actually landed (post-commit cleanup error, or a
concurrent identical completion winning the race), the completion returns the
idempotent success instead of an error.

**Cleanup-safety invariant (audited across every cleanup call site):**
`cleanupObject` refuses to delete unless `MediaAsset.count({ storageKey }) === 0`
— and refuses when the check itself cannot be performed (DB outage). Since the
`MediaAsset` row IS the reference the storage abstraction addresses bytes by,
the invariant "never delete bytes that are already referenced by a valid DB
record" holds structurally, for verification failures and DB failures alike.
A genuine first-attempt failure (no rows ever created) still cleans the
unreferenced upload by its exact key.

### Concurrency (two simultaneous `/complete` calls of the same token)

Sequential replay is closed by the check above; CONCURRENT twins are closed by
**database-level serialization** (`src/lib/db-serialization.ts`) — no
in-memory locks (non-authoritative on serverless), no schema change:

* **PostgreSQL (production)** — the row-creating transaction first acquires
  `pg_advisory_xact_lock(<63-bit FNV-1a of the exact storageKey>)` INSIDE the
  transaction, then RE-CHECKS the persisted linkage. The lock is exclusive per
  key across every connection/process/instance of the same database and is
  held until COMMIT/ROLLBACK, so the second twin blocks, then observes the
  first twin's committed linkage and returns the idempotent result. The race
  is closed BY THE DATABASE — authoritative regardless of where requests
  land. No schema/migration required; advisory locks need no cleanup (they
  vanish with the transaction, even on crash).
* **SQLite (local development/tests)** — `pg_advisory_xact_lock` does not
  exist there, so the advisory call is skipped (local dev never depends on
  PostgreSQL). SQLite's own database-level SINGLE WRITER serializes the
  finalizations: a losing transaction's write fails (WAL BUSY_SNAPSHOT /
  busy timeout) and the completion failure path re-resolves the persisted
  linkage — by then committed — and returns the idempotent result.

Verified invariant under barrier-synchronized concurrent twins (deterministic
offline races, repeated trials, both purposes, both database modes): exactly
one `MediaAsset`, exactly one logical relationship (`SessionVideo` / one final
active `Material`), both callers receive the same id + one idempotent replay
response, the object remains intact, and zero deletes are issued. A forced
writer-lock failure (busy model) lands in the failure path and still returns
the idempotent result without touching the object.

Invariant: **one upload intent / exact storage key ⇒ at most one logical
finalized media relationship** — sequentially AND concurrently.

## Environment

* `MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC` — presign/intent lifetime, default 600,
  clamped [60, 900].
* No new R2 variables; the existing `R2_*` set is unchanged and stays
  server-side only.

## Verification

`node tests/presigned-uploads-phase23.test.js` proves the full matrix offline
(fake S3 client + fake signer + fake db at the established injection
boundaries): role matrix pins, exact-key presign, intent signature/expiry/
user/tamper cases, MIME/size/magic/SHA-256 rejections with object deletion,
missing object, DB-rows-only-after-verification, DB-failure cleanup, no
presigned GET, no LIST, no credential exposure.
