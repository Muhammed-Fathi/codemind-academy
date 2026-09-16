# Phase 26G — Production Integrations & Infrastructure QA

**Date:** 2026-09-16 (UTC)
**Branch:** `arena/01a0a89c-codemind-academy` (cut from `main` @ `95b41d0`, the Phase 26F merge)
**Mode:** PRODUCTION-INTEGRATION QA. Read-only verification first, then the
minimum set of fixes the findings required.

## 0. Safety attestation — what this phase did NOT do

| Prohibited action | Status |
|---|---|
| Deploy to Vercel | **NOT DONE.** No Vercel project created, no `vercel` CLI invoked. |
| Create the Vercel project | **NOT DONE.** |
| Modify production Neon (delete / truncate / reset / reseed) | **NOT DONE.** No production connection string was requested, printed, or used. |
| Rotate or expose secrets | **NOT DONE.** No secret value appears in this document, in any diff, or in any log quoted here. |
| Print secrets / passwords / tokens / SMTP creds / R2 keys / `CRON_SECRET` / full `DATABASE_URL` | **NOT DONE.** Only variable NAMES appear. |
| Alter production data | **NOT DONE.** |
| Send real production email | **NOT DONE.** No SMTP host was contacted. |
| Modify live R2 CORS | **NOT DONE.** Analysed only (§4.6). |
| Schedule the live cron | **NOT DONE.** `vercel.json` was already correct and was left untouched. |
| Weaken an existing test | **NOT DONE.** Every test edit either adds assertions or re-pins an allowlist *plus* a new proof. No threshold was lowered, no assertion deleted. |
| Redesign Phase 24–26F architecture | **NOT DONE.** |

**Deliverable state:** implementation + verification complete, **no PR opened,
nothing merged, nothing deployed** (§17 of the brief).

---

## 1. Discovery summary

The repository ships a **provider-split** platform: SQLite (`prisma/schema.prisma`
+ `prisma/migrations`, 12 migrations) for local/dev/test, PostgreSQL
(`prisma/postgres/schema.prisma` + `prisma/postgres/migrations`, `0_init` +
one timestamped migration) for production. Production is targeted at
**Vercel Hobby + Neon PostgreSQL + Cloudflare R2 + Gmail SMTP (Nodemailer) +
Vercel Cron**, built with `npm run build:postgres`.

What the inventory found, in one line each:

* **Neon/PostgreSQL path is structurally sound** — the 26D hotfix separation is
  intact, the derived PG schema is in sync, and the migration chain is clean.
  One **non-blocking** connection-semantics risk was found (`sslmode=require`, §2.3).
* **The PG17 full-chain proof was NOT on `main`.** It existed only on two
  unmerged auxiliary branches (`arena/pg17-full-chain-reference` @ `1a7f9ab`,
  `arena/pg17-reference-artifact` @ `c692a42`). **Prepared for delivery to
  `main`** — committed to the Phase 26G branch, **pending Git delivery** because
  the sandbox credential cannot push workflow files (§4.3, §4.5).
* **One production-safety workflow was effectively disabled** on branch pushes:
  `phase26d-postgres-concurrency.yml` had its `push:` trigger pinned to a single
  dead phase branch. **Fixed** (§3.4).
* **R2 / private media is correct and strong** — private bucket, server-proxied
  reads, PUT-only short-lived presigned uploads, server-generated keys,
  no credentials anywhere near a client bundle. No blocker.
* **Retention/cron is correct** — fails closed, constant-time bearer compare,
  GET-only, `vercel.json` schedule already Hobby-legal.
* **Gmail SMTP is correct** — server-only, credential-redacting errors, never
  fatal to the request. No email-backed notification or payment mail exists
  (notifications are in-app/DB only), so the mail surface is exactly two flows.
* **ONE GO-LIVE BLOCKER was found and fixed:** every absolute link was built as
  `process.env.NEXT_PUBLIC_URL || "http://localhost:3000"`, in three shipped
  call sites, with **no production validation**. A production deploy that never
  set `NEXT_PUBLIC_URL` emits password-reset and teacher-activation links that
  point at `localhost` — delivered, token-valid, and unusable (§6, §7).
* **One pre-existing RED test was found on `main`** (`payment-lifecycle-phase25-ledger`),
  introduced by the Phase 26F merge. Diagnosed and re-pinned (§13.3).
* **The Windows-only test-harness defect** in `tests/security-hardening.test.js`
  was reproduced, root-caused and fixed (§14).

---

## 2. Integrations matrix

| Integration | Config vars | Source files | Runtime dependency | Verification method | Status |
|---|---|---|---|---|---|
| **Neon PostgreSQL (Prisma)** | `DATABASE_URL` | `prisma/postgres/schema.prisma`, `src/lib/db.ts`, `prisma/postgres/migrations/*` | `@prisma/client` generated from the **PG** schema; Rust engine | `npm run build:postgres` output client `provider = "postgresql"`; `tests/migration-providers.test.js` (54); `tests/pg-baseline-inspection.test.mjs`; CI PG17 service | **OK** (1 non-blocking finding, §2.3) |
| **PostgreSQL migrations** | `DATABASE_URL` | `prisma/postgres/migrations/0_init` + `20260915180000_phase26d_quiz_attempt_architecture` | `prisma migrate deploy --schema prisma/postgres/schema.prisma` (manual, never in build) | `grep -c migrate` on the build log = 0; `tests/migration-sql.test.js` (15); `tests/migration-providers.test.js` (54); PG17 full-chain workflow | **OK** |
| **SQLite (dev/test)** | `DATABASE_URL=file:…` | `prisma/schema.prisma`, `prisma/migrations/*` (12) | Prisma SQLite client | full offline sweep, §13 | **OK** |
| **Cloudflare R2 (private media)** | `MEDIA_BACKEND=s3`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_REGION` (default `auto`), `R2_S3_ENDPOINT` (optional) | `src/lib/media-s3.ts`, `src/lib/media.ts`, `src/lib/media-upload.ts`, `src/lib/direct-upload.ts` | `@aws-sdk/client-s3` + `s3-request-presigner` (server-only, lazy-loaded, `serverExternalPackages`) | `tests/s3-storage-r2.test.js` (184), `tests/presigned-uploads-phase23.test.js` (327), `tests/production-storage-phase21.test.js` (180), `tests/media-storage-wiring.test.js` (318) | **OK** |
| **Presigned direct upload (Phase 23)** | `MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC` (600, clamped 60–900) | `src/lib/media-upload.ts`, `src/lib/media-s3.ts`, `src/app/api/admin/media-uploads/{init,complete}` | HMAC intent token keyed by `SECURITY_HASH_SECRET` | `tests/presigned-uploads-phase23.test.js` (327) | **OK** |
| **Gmail SMTP (Nodemailer)** | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `EMAIL_FROM` (opt), `SMTP_SECURE` (opt) | `src/lib/mailer.ts`, `src/lib/delivery.ts` | nodemailer, STARTTLS 587 / implicit TLS 465 | source audit + `scripts/send-test-email.ts` (not run — no disposable mailbox in this sandbox) | **OK** |
| **Password-reset mail** | as above + `NEXT_PUBLIC_URL`, `PASSWORD_RESET_TTL_MINUTES` | `src/app/api/auth/password-reset/request/route.ts` | SMTP | source audit + `tests/phase26a-public-auth.test.js` (121) | **OK after §6 fix** |
| **Teacher activation mail** | as above + `TEACHER_ACTIVATION_TTL_HOURS` | `src/app/api/admin/teacher-applications/[id]/approve/route.ts` | SMTP | source audit + `tests/teacher-application-phase20.test.js` (75) | **OK after §6 fix** |
| **Vercel Cron (retention purge)** | `CRON_SECRET`, `DATABASE_URL`, `QUIZ_EVIDENCE_RETENTION_DAYS` | `src/app/api/cron/purge-evidence/route.ts`, `src/lib/evidence-retention.ts`, `vercel.json` | `pg` (single connection), `node:crypto` | `tests/vercel-cron-retention-phase24.test.js` (161) | **OK** |
| **App / base URL** | `NEXT_PUBLIC_URL` — **HTTPS-only in production** | `src/lib/app-url.ts` (**new, 26G**), `src/lib/env.ts`, 3 call sites | none | `tests/security-hardening.test.js` (368) + 46-case accept/reject proof (§8) | **FIXED (was the blocker)** |
| **Security hash secret** | `SECURITY_HASH_SECRET` | `src/lib/env.ts`, `src/instrumentation.ts`, `next.config.ts` | node crypto | `tests/security-hardening.test.js` (368) | **OK** |
| **Production build** | `DATABASE_URL`, `SECURITY_HASH_SECRET`, `NEXT_PUBLIC_URL` (https), `SKIP_PRODUCTION_ENV_CHECK` (opt) | `package.json` → `build:postgres`, `next.config.ts`, `scripts/copy-standalone-assets.mjs` | prisma + next 16.3.4 | ran it, exit 0 (§9) + 3 build-time contract cases (§9.1) | **OK** |
| **Backup / restore** | `BACKUP_PASSPHRASE` (opt) | `scripts/db/backup-postgres.sh`, `scripts/db/restore-postgres.sh`, `scripts/db/verify-postgres.mjs`, `scripts/media/migrate-media.mjs` | `pg_dump`/`pg_restore` (not present on Vercel) | read-only review (§11) | **GAP — non-blocking** |
| **Monitoring / health** | none | `src/app/api/route.ts` | none | read-only review (§10) | **GAP — non-blocking** |

---

## 3. Neon / PostgreSQL QA

### 3.1 Provider architecture (PASS)

| Check | Result |
|---|---|
| Production schema is `prisma/postgres/schema.prisma`, `provider = "postgresql"` | PASS |
| SQLite and PostgreSQL migration directories are separated | PASS — `prisma/migrations/` (12, sqlite) vs `prisma/postgres/migrations/` (`0_init` + 26D, `migration_lock.toml provider = "postgresql"`) |
| Derived PG schema in sync with the source | PASS — `node scripts/db/make-postgres-schema.mjs --check` → `prisma/postgres/schema.prisma: in sync` / `postgres-baseline.sql: in sync` |
| `build:postgres` generates from the PG schema | PASS — build log line 5: `Prisma schema loaded from prisma/postgres/schema.prisma`; generated `node_modules/.prisma/client/schema.prisma` → `provider = "postgresql"` |
| Production DB provider | PASS — PostgreSQL |
| Vercel build never runs migrations | PASS — `grep -c migrate /tmp/build-postgres.log` → **0**. `build:postgres` = `prisma generate --schema … && next build && node scripts/copy-standalone-assets.mjs`. Migrations stay a separate, operator-run `prisma migrate deploy`. |
| Phase 26B/26D recovery architecture preserved | PASS — `tests/group-track-recovery-postgres.test.mjs` and `tests/migration-providers.test.js` unchanged and green (the former is hard-gated in CI on real PG17; locally it refuses a non-PostgreSQL URL, see §13.4) |
| No SQLite-only syntax on the production path | PASS — `grep -in "datetime\|autoincrement\|pragma"` over `prisma/postgres/migrations/*/migration.sql` matches **comments only**. `0_init` uses `TIMESTAMPTZ(3)`, `TEXT`, native enums, `BOOLEAN`. |
| 26B folded into the baseline (not a separate PG step) | PASS — `0_init` line 522–534 defines `Group."trackScope" "TrackScope"` (nullable, no default) — exactly the 26B semantics. `0_init` = 55 tables / 21 enums, matching the runbook's presence battery. |

### 3.2 Connection handling (review)

`src/lib/db.ts` is `new PrismaClient({ log: ['error'] })` with no explicit
`datasourceUrl`, no `connection_limit`, and no `pool_timeout`. It reuses one
instance across warm invocations in dev only (`globalForPrisma`); in production
each serverless instance constructs its own.

| Concern | Assessment | Severity |
|---|---|---|
| Default `connection_limit` (Prisma: `num_physical_cpus * 2 + 1` per instance) multiplied across concurrent Vercel instances can exhaust Neon's connection cap | Real under load, **configuration-only**. Fix by using Neon's **pooled** endpoint and/or `?connection_limit=1&pool_timeout=20`. No code change. | **IMPORTANT NON-BLOCKING** |
| No Prisma slow-query / error metrics beyond `log: ['error']` | See §10 | **IMPORTANT NON-BLOCKING** |
| `pg` (cron route, `scripts/db/*`) opens a plain `pg.Client` with no SSL options | Handled by `sslmode` in the URL — see §2.3 | see below |

### 3.3 `sslmode=require` — the known warning, analysed (IMPORTANT NON-BLOCKING)

**This is a genuine, verified semantic divergence, not a style nit.** The
repository ships **two** PostgreSQL clients and they read the *same* connection
string differently:

| Client | Meaning of `sslmode=require` | Evidence |
|---|---|---|
| **Prisma** (Rust connector, `src/lib/db.ts`) | **libpq semantics**: encrypt, **do NOT verify** the server certificate or its hostname. | Prisma follows the libpq ladder; `require` is documented by PostgreSQL as "encrypt only", and Neon's own engineering blog calls it vulnerable to trivial MITM. |
| **node-postgres** `pg` 8.23.0 (`/api/cron/purge-evidence`, `scripts/db/*`) | **verify-full, TODAY** — and **libpq (weaker) semantics after pg v9**. | Vendored source: `node_modules/pg-connection-string/index.js:139-158` maps `prefer`/`require`/`verify-ca` to **no change** (i.e. `rejectUnauthorized` stays `true`) and calls `deprecatedSslModeWarning()`, whose text reads: *"these modes will adopt standard libpq semantics, which have weaker security guarantees … If you want the current behavior, explicitly use 'sslmode=verify-full'"*. |

Consequences for CodeMind:

1. **Today** the two clients disagree: Prisma encrypts without authenticating
   the server; `pg` authenticates. A `sslmode=require` Neon URL therefore gives
   the cron route real MITM protection and gives Prisma none.
2. **After a `pg` major bump** (currently impossible accidentally — `package.json`
   pins `pg: ^8.23.0`) the `pg` side silently **loses** certificate verification.
   Nothing in the app would notice.
3. A **`SECURITY WARNING` process warning is already emitted at runtime** by
   `pg-connection-string` whenever such a URL is parsed.

**Classification: IMPORTANT NON-BLOCKING** (the connection still succeeds and
is still encrypted; the gap is server *authentication*, and it is closed by one
connection-string change — not by a code change).

**Recommendation (applied to docs, not to code — the URL is operator-owned):**

```
DATABASE_URL="postgresql://<user>:<password>@<neon-host>/<db>?sslmode=verify-full"
```

* `verify-full` is unambiguous in **both** clients, today and after pg v9.
* Neon serves publicly-issued certificates, so Node verifies against its bundled
  trust store with no `sslrootcert`.
* If any hop in front of Neon terminates TLS in a way `verify-full` rejects, the
  fallback is `sslmode=require&channel_binding=require` (Neon's own hardening,
  which binds the TLS channel to the password) — **never** a bare `require`.
* Never `disable` / `allow` / `prefer` on a production URL.

Documented in `.env.example` (§PostgreSQL) and `docs/POSTGRES_CUTOVER_RUNBOOK.md` §6.

**No production connection string was requested, read, or printed while
producing this analysis.**

---

## 4. PostgreSQL migration chain

### 4.1 Chain inventory

| # | Migration | Applied where | Content |
|---|---|---|---|
| PG-1 | `0_init` (951 lines, `sha256 c7f5d3fa…ef80`) | Neon (baselined) + every fresh PG DB | 21 enums, 55 tables, FKs, indexes = the pre-26D production schema **including** the Phase 26B `Group.trackScope` column |
| PG-2 | `20260915180000_phase26d_quiz_attempt_architecture` (173 lines, `sha256 2c1bdde1…e104`) | after `0_init` | `QuizRetryGrant` + `Quiz` blueprint cols + `QuizAttempt.attemptNumber/status/retryGrantId` + 10 `QuizAnswer` snapshot cols. **Additive only** — no DROP/DELETE/TRUNCATE/table rewrite |

SQLite keeps its own 12-step history; the two directories never mix
(`migration_lock.toml` guards the PG directory).

### 4.2 Chain checks (PASS)

| Check | Result |
|---|---|
| Checksums / integrity where the repo tracks them | PASS — both SHA-256 pins re-verified against `main`: `c7f5d3fa76931d02e48c5cd2c4bfdb972c0f25e528e3c0c116736d3729cefa80` and `2c1bdde167f7dfff9b79a61f116da3dbd93b13c6aa27825404a79312ec7be104`. `tests/migration-providers.test.js` enforces them. |
| No accidental SQLite SQL in the PG chain | PASS (§3.1) |
| No duplicate provider history | PASS — one `migration_lock.toml` (`provider = "postgresql"`); the PG directory contains **no** copy of any SQLite migration name |
| No impossible ordering | PASS — `0_init` (baseline) → `20260915180000_…` (additive). Alphabetical == chronological. |
| Additive / non-destructive | PASS — `grep` over PG-2 shows only `CREATE TABLE` / `ADD COLUMN` / `CREATE INDEX` / `ADD CONSTRAINT` + two documented backfills; no `DROP`, no `TRUNCATE`, no `DELETE` |
| All PG-specific types valid | PASS — `TIMESTAMPTZ(3)`, native enums, `JSONB`-free `TEXT` maps where Prisma emits `TEXT` |

### 4.3 PG17 full-chain workflow — **PREPARED FOR DELIVERY TO `main` (pending Git delivery)**

> **Delivery-state wording (corrected after review).**
> This workflow is **committed to the Phase 26G branch and ready to reach
> `main`** — it is **NOT on `main` yet**. The Phase 26G commit has not been
> pushed or merged: the sandbox's GitHub App credential is refused with
> *"refusing to allow a GitHub App to create or update workflow … without
> `workflows` permission"*, and the brief for this phase forbids splitting out
> or discarding the workflow changes to work around that. Once the branch is
> pushed with a credential that has the `workflows` scope (§4.5), the file will
> be on `main` like any other merge. This document describes the *prepared*
> state, not a completed delivery.

**Finding.** The permanent, reproducible proof that a clean PostgreSQL 17
database migrates from **zero** to the current schema existed **only on two
unmerged auxiliary branches**:

| Branch | Commit | Content | State before 26G |
|---|---|---|---|
| `arena/pg17-full-chain-reference` | `1a7f9ab` | `.github/workflows/pg17-full-chain-reference.yml` (392 lines, 2 jobs) | **NOT on main** — never merged |
| `arena/pg17-reference-artifact` | `c692a42` | +74 lines appended to `.github/workflows/migration-providers-postgres.yml` (pre-26D reference generation step) | **NOT on main** — never merged |

Both branch off `98dfb5f`, i.e. they predate the Phase 26E and 26F merges, so
they could not be merged as-is without dragging `main` backwards.

**Decision: prepare `arena/pg17-full-chain-reference` (the full-chain workflow)
verbatim for delivery, and subsume the `pg17-reference-artifact` addition.**

* The full-chain workflow's **job 1** (`pre26d-0-init-reference`) already
  produces exactly the artifact `pg17-reference-artifact` added
  (`pg17-0-init.json`, same filename, uploaded under the same artifact name
  `pg17-0-init-reference`), validates it with a superset of the assertions, and
  additionally proves `migrate status` clean + second `migrate deploy` no-op.
  Shipping both would duplicate one artifact under two jobs.
* It additionally delivers the **post-26D** reference, which is the actual
  goal ("zero → current schema") and which `pg17-reference-artifact` does not
  provide.

**Verification performed before promoting (all PASS):**

* YAML parses; jobs = `pre26d-0-init-reference`, `full-chain-phase26d-reference`.
* Triggers: `push: branches: ["arena/**"]`, `pull_request: branches: [main]`,
  `workflow_dispatch` — so it now protects every phase branch **and** the PR path.
* The two embedded SHA-256 pins still match `main`'s migration files
  (`c7f5d3fa…`, `2c1bdde1…`).
* All four inline Node scripts pass `node --check`.
* Every constraint name, index name and column name the validator asserts was
  grepped against `prisma/postgres/migrations/20260915180000_…/migration.sql` —
  all present (9/9 names, 18/18 columns).
* Every host it touches is a disposable `postgres:17` GitHub Actions service
  container with throwaway credentials; it uses no repository secret and its own
  `SAFETY_GUARD_JS` refuses non-localhost / production-looking / non-`codemind_*`
  URLs. **It performs no production mutation** and does not touch application
  code, the Prisma schema, or any migration SQL.

### 4.4 Disabled production-safety trigger — **FIXED**

`.github/workflows/phase26d-postgres-concurrency.yml` had:

```yaml
on:
  push:
    branches: ["arena/01a0a540-codemind-academy"]   # a DEAD phase branch
```

so the Phase 26D PostgreSQL concurrency hard-gate **never ran on any branch push**
— only on PRs to `main` and manual dispatch. Changed to `branches: ["arena/**"]`,
matching its two sibling gates. The test, its sentinel logic and its
"a skip is a failure" gate are untouched. **Same delivery state as §4.3:
committed to the Phase 26G branch, pending Git delivery (§4.5).**

### 4.5 Workflow files that require privileged Git delivery

Three files under `.github/workflows/**` are part of Phase 26G. They are
**committed locally and are correct**, but the sandbox's GitHub App credential
cannot push them:

```
! [remote rejected] … (refusing to allow a GitHub App to create or update
  workflow `.github/workflows/migration-providers-postgres.yml`
  without `workflows` permission)
```

| File | Change | Why it needs the `workflows` scope |
|---|---|---|
| `.github/workflows/pg17-full-chain-reference.yml` | **NEW** (404 lines) — permanent PG17 full-chain migration proof | new file under `.github/workflows/` |
| `.github/workflows/migration-providers-postgres.yml` | +10 lines — disposable HTTPS origin for the production build step | modified file under `.github/workflows/` |
| `.github/workflows/phase26d-postgres-concurrency.yml` | trigger widened from a dead branch to `arena/**` | modified file under `.github/workflows/` |

**Safe delivery procedure (for the user, with their own credentials).** No
history rewriting, no splitting, no discarding:

```bash
# In any clone that has the Phase 26G branch (or in this workspace):
git fetch origin arena/01a0a89c-codemind-academy   # if working from a fresh clone
git switch arena/01a0a89c-codemind-academy         # or: git checkout <branch>
git log --oneline -1                               # expect the Phase 26G commit
git push origin arena/01a0a89c-codemind-academy    # pushes ALL of it, workflows included
```

A user token (fine-grained PAT or classic PAT with the `workflows` scope, or
`gh auth login` in an interactive session) is not subject to the GitHub App
restriction, so the single existing commit pushes unchanged. **Do not** amend,
rebase, or split the commit to work around this — the Phase 26G history is
intentionally one complete commit.

**Until then:** the files exist in the working tree and in the branch's local
history, and nothing in this phase depends on the push having happened.

---

## 5. R2 / private media QA

### 5.1 Private-bucket semantics (PASS)

| Check | Result |
|---|---|
| Bucket is private; no public-object assumption | PASS — `S3StorageBackend` sets **no ACL** on `PutObject` (R2 objects are private by default); the header of `src/lib/media-s3.ts` states the model and every read is proxied. |
| Reads are server-proxied | PASS — `GET /api/media/[id]` and `GET /api/materials/[id]` stream bytes (`Browser → server → R2`). **No presigned GET exists anywhere**; `getSignedUrl` is used in exactly one place, over a `PutObjectCommand` constructed inside `createPresignedPutUrl`. |
| Endpoint format | PASS — `https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`, overridable via `R2_S3_ENDPOINT`. |
| Region handling | PASS — `R2_REGION` defaults to `"auto"`. |
| Credentials server-only | PASS — `resolveR2Config()` reads `R2_*` only; `grep -rhoE "NEXT_PUBLIC_[A-Z0-9_]+" src/` returns **only `NEXT_PUBLIC_URL`**. |
| Fail-closed config | PASS — `REQUIRED_R2_ENV_VARS = [R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET]`; any blank → throw naming **variable names only**. |
| Backend selector fail-closed | PASS — `resolveStorageBackendName("")` → `local`; **any unsupported value throws** rather than silently writing to the ephemeral filesystem. |
| `MEDIA_BACKEND=s3` on Vercel | Required. Unset ⇒ `local` ⇒ bytes land on the **ephemeral** serverless filesystem and vanish. Highest-value single env var to get right. |

### 5.2 Presigned upload (PASS)

| Property | Implementation |
|---|---|
| Method | **PUT only** — the `PutObjectCommand` is built inside `createPresignedPutUrl`; callers cannot pass a command, so GET/LIST/multipart can never be presigned. |
| Key | **Server-generated** (`makeStorageKey`: `<scope>/<base36-time>-<32 hex>`), signed into both the URL and the HMAC intent token. Client never supplies or sees it. |
| Key validation | rejects empty, leading `/`, `..`, and C0/DEL control characters. |
| Content-Type | granted by the server; the browser must echo it; **completion HEADs the stored object and deletes it on mismatch**. |
| Upload expiry | `MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC`, default **600 s**, hard-clamped to **[60, 900]**. |
| Download expiry | N/A — there is no presigned download. |
| Intent token | HMAC-SHA256 keyed by `SECURITY_HASH_SECRET`, domain-separated, constant-time verified, bound to `jti/sub/purpose/kind/key/contentType/maxBytes/iat/exp`, TTL ≤ 3600 s. |
| Authorization | `requireRole("ADMIN")` on **both** `init` and `complete`; target authorization re-run on completion. |
| Idempotency | the consumed marker is the **persisted `MediaAsset` linkage under the exact key**, never an in-memory set; replay returns the original ids with `replay: true`. |
| Cleanup safety | `cleanupObject()` counts `MediaAsset` rows for the exact key and **refuses to delete** if any exist, or if the count itself fails. |
| Size / MIME bounds | per-purpose allow-lists (`video/mp4,webm,ogg,quicktime`; `application/pdf`), ceilings `MEDIA_MAX_VIDEO_BYTES` (512 MB) / `MEDIA_MAX_PDF_BYTES` (25 MB), PDF magic bytes `%PDF-` in the first KB, `.pdf` extension required. |

### 5.3 Retrieval authorization (PASS)

`GET /api/media/[id]`: `requireUser` → 404 for a non-managed/absent asset →
quiz evidence **ADMIN only** (with `QUIZ_EVIDENCE_ACCESSED` audit) →
DOCUMENT assets **ADMIN only** (students must use `/api/materials/[id]`) →
session videos: ADMIN/TEACHER always; STUDENT requires **published** +
own `batchId` + matching `schoolType` derived server-side; PARENT denied →
orphan assets ADMIN only. Always `Cache-Control: private, no-store`,
`X-Content-Type-Options: nosniff`, `Accept-Ranges: bytes`, strict Range parsing
with 416, streaming reads (never buffered).

`GET /api/materials/[id]` enforces the Phase 14 **10-check** contract
(`authorizeMaterialDownload`), which covers lifecycle/PUBLISHED and
progression, so **archived/unpublished material stays denied**.

### 5.4 Missing / deleted objects (PASS)

`isS3NotFound()` maps **only** `NoSuchKey` / `NotFound` / HTTP 404 to
absence; a **403 is never mapped away** (authorization problem ≠ absence).
Missing objects produce the same non-oracle 404 as an unknown id
(`read()/sha256()` reject with an `ENOENT`-coded error — byte-parity with the
local backend; `stat()/readStream()` return `null`). `delete()` is idempotent.

### 5.5 Raw S3 errors do not reach clients (PASS)

A non-`RangeError` from the storage layer propagates to Next.js, which answers
a generic 500 in production with no stack trace. No bucket name, endpoint,
request id or key appears in any error body. `Content-Disposition` is
`inline` for media and `materialContentDisposition()` (`inline` /
`attachment`) for materials.

### 5.6 CORS — **analysed, deliberately NOT modified**

`docs/PHASE_23_PRESIGNED_R2_UPLOADS.md` §"R2 CORS requirement" documents the
exact policy:

```json
[{ "AllowedOrigins": ["https://codemind.academy", "http://localhost:3000"],
   "AllowedMethods": ["PUT"],
   "AllowedHeaders": ["content-type"],
   "ExposeHeaders": ["etag"],
   "MaxAgeSeconds": 3600 }]
```

* **Rule honoured:** localhost is present for development only; `*` is
  explicitly forbidden by the doc; methods are `PUT` only (adding `GET` would
  mean reads had stopped being server-proxied — a regression signal).
* **Launch action (operator, not code):** replace/add the exact Vercel
  production origin once the project exists. The repository never mutates
  bucket configuration, and **this phase did not touch live R2 CORS**.
* **IMPORTANT NON-BLOCKING:** presigned PUTs will fail CORS preflight until the
  production origin is added. The client surfaces this as a typed
  `"transfer"`-stage failure and falls back gracefully; small uploads can still
  use the buffered path, but the fallback is also `local`-backend-only, so this
  must be done before large media is uploaded in production.

---

## 6. Media retention / cron QA

### 6.1 Route contract (PASS) — `GET /api/cron/purge-evidence`

| Check | Result |
|---|---|
| Requires `CRON_SECRET` | PASS |
| Fails closed when the secret is missing/blank | PASS — **503** `{"ok":false,"error":"misconfigured","reason":"CRON_SECRET_NOT_SET"}` before any work |
| Unauthorized | PASS — **401** for absent / malformed / wrong bearer |
| Comparison | PASS — both sides SHA-256'd to 32 bytes then `timingSafeEqual` (length- and content-independent); token length capped at 1024 |
| Never leaks `CRON_SECRET` | PASS — fixed minimal bodies; the secret is only ever compared, never logged or returned |
| Not triggerable anonymously | PASS — only `Authorization: Bearer`; **query string is never read** and session/cookie state is ignored, so neither anonymous users nor logged-in admins can trigger it |
| Non-PostgreSQL `DATABASE_URL` | PASS — **503** `DATABASE_URL_NOT_POSTGRES` before touching anything |
| Destructive work before authorization | PASS — none; the `pg.Client` is constructed only after the bearer check succeeds |
| Deletion criteria | PASS — `QuizAttemptEvidence` where `retainUntil IS NOT NULL AND retainUntil <= now`; `NULL` = keep forever (fail-closed against data loss) |
| Retention window | PASS — `QUIZ_EVIDENCE_RETENTION_DAYS` (default 30, validated 1..3650, throws on garbage) |
| DB/object sequencing | PASS — rows delete in ONE transaction; **objects delete after commit**, per-object best-effort, failures recorded and retried next run (an unreferenced asset is found again) |
| Protected tables | PASS — `SecurityEvent`, `AuditLog`, `TeacherApplication`, `TeacherActivationToken`, `UserSession`, `PasswordResetToken`, `SecurityRateLimit`, `QuizAttempt`, `Student`, `User` counts are snapshotted before/after and a move ⇒ invariant violation (500, no partial result) |
| Idempotent / retry-safe | PASS — expired rows stay expired; deleted objects are never re-listed |
| Method gating | PASS — `GET` only; `POST/PUT/PATCH/DELETE` → **405** before any purge logic |

### 6.2 Vercel Cron compatibility (PASS, with one verify-before-deploy item)

| Requirement | Repo | Verdict |
|---|---|---|
| HTTP method | Vercel Cron issues **GET**; route exports `GET` | OK |
| Route path | `vercel.json` `crons[0].path = "/api/cron/purge-evidence"`; route is `src/app/api/cron/purge-evidence/route.ts` | OK — exact match |
| Auth header | Vercel sends `Authorization: Bearer $CRON_SECRET` when the project has `CRON_SECRET`; the route reads exactly that | OK |
| Schedule | `0 3 * * *` = once daily at 03:00 UTC | OK — Hobby permits **once per day** per job; 1 job of 100 allowed |
| Runtime | `runtime = "nodejs"`, `dynamic = "force-dynamic"` | OK |
| `maxDuration` | `300` | **Verify.** 300 s is the **Hobby ceiling and requires Fluid Compute** (default for projects created after Apr 2025). A project created with Fluid Compute **off** has a 60 s Hobby maximum and Vercel will reject the deploy. If that happens, set `maxDuration = 60` — the job is bounded and idempotent, so leftovers simply roll to the next day. |

**The live cron was NOT scheduled and `vercel.json` was NOT modified.**

---

## 7. Gmail SMTP / Nodemailer QA

### 7.1 Configuration (PASS)

| Check | Result |
|---|---|
| Single credential owner | PASS — `src/lib/mailer.ts` is the **only** module that reads SMTP vars; it is never imported from a client component |
| Host / port / secure | PASS — `smtp.gmail.com:587` with `secure:false` + **`requireTLS:true`** (never falls back to plaintext); `SMTP_SECURE=1` or port 465 switches to implicit TLS; `tls: { minVersion: "TLSv1.2" }` |
| Timeouts | PASS — connect 20 s, greeting 20 s, socket 30 s (fails fast on a dead network) |
| Required vars | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, **`SMTP_PASSWORD`** (all four must be non-empty) |
| Sender identity | `EMAIL_FROM` when set, else `SMTP_USER` (Gmail requires the From to be the authenticated address) |
| Credential redaction | PASS — `sanitizeError()` strips the password **and** the username from any error string before it is returned; `smtpDiagnostics()` masks the user to `x***@domain` |
| App never crashes on SMTP failure | PASS — `sendMailViaSmtp` returns `{ok:false,…}`; `sendEmail` wraps it in try/catch; both reset and activation routes complete their DB/audit work regardless |
| URLs inside mail | `appUrl(...)` from `src/lib/app-url.ts` — **fixed this phase** (§8) |
| No localhost hardcoding | PASS after the §8 fix — the only remaining `"http://localhost:3000"` literal is `DEV_APP_URL`, unreachable when `NODE_ENV=production` |

### 7.2 Mail-backed flows (inventory)

| Flow | Email-backed? | Route |
|---|---|---|
| Password reset | **Yes** | `POST /api/auth/password-reset/request` |
| Teacher activation | **Yes** | `POST /api/admin/teacher-applications/[id]/approve` |
| In-app notifications (all 11 types) | **No** — DB rows only, read via `/api/notifications` | `src/lib/notify.ts` |
| Payment / subscription mail | **Does not exist** — payments are manually verified; no mail is sent on any payment transition | `src/lib/payment-transitions.ts` (no `sendEmail` import) |
| Admin / teacher / student notification mail | **Does not exist** | — |

`grep -rn "sendEmail" src/` returns exactly the two routes above. The mail
surface is therefore small and fully audited.

**Not run:** `npm run test:email` (`scripts/send-test-email.ts`) — it requires a
real Gmail App Password and a disposable recipient, and the brief forbids
sending real production mail. **IMPORTANT NON-BLOCKING** for launch: perform one
`smtpDiagnostics()`/`verifySmtpConnection()` smoke test from the deployed host
before go-live (Vercel outbound TCP is allowed; some providers rate-limit or
block serverless IPs).

---

## 8. URL / origin configuration — the fix (HTTPS-ONLY in production)

### 8.0 The production contract, stated exactly

`NEXT_PUBLIC_URL` — enforced by `src/lib/app-url.ts` at **build** time
(`next.config.ts`) and at **startup** (`src/instrumentation.ts`).

**PRODUCTION (`NODE_ENV=production`) — all of the following must hold, or the
build/boot is refused:**

| Rule | Detail |
|---|---|
| Present and non-blank | after `trim()`; unset / `""` / `"   "` are all rejected |
| Absolute | must parse as an absolute URL; `codemind.academy`, `//codemind.academy`, `/x`, `https://` are all rejected |
| **Scheme is exactly `https:`** | `http:` is **rejected even for a public host**. `ftp:`, `file:`, `mailto:`, `javascript:`, `data:` are rejected for the same reason (single scheme gate, no escape hatch) |
| Not loopback | `localhost`, `127.0.0.0/8`, `::1`, `0.0.0.0`, `*.localhost`, `*.local`, and IPv4-mapped loopback (`::ffff:127.0.0.1`, normalized by WHATWG URL to `::ffff:7f00:1`). **https does not rescue a loopback host** |
| No embedded credentials | `https://user:pass@host` and `https://user@host` are rejected |
| No query string | a `?` in the base would collide with the token `appUrl()` appends |
| No fragment | a `#` in the base would discard everything `appUrl()` appends |

A **base path is allowed** (`https://codemind.academy/app`), because
`appUrl()` appends after it; trailing slashes are normalized away so
`appUrl()` can never mint `//x`.

**DEVELOPMENT / TEST (`NODE_ENV` = `development` | `test` | unset)** — no
validation at all. `NEXT_PUBLIC_URL` when set, otherwise the
`http://localhost:3000` fallback. Local development is unchanged; the offline
verifiers keep working.

**Why HTTPS-only (threat model).** This origin is the prefix of every
password-reset link and every teacher-activation link — URLs that carry a
single-use credential in the query string. Over plain HTTP that token is
readable *and rewritable* by anyone on the path, and any `https → http` hop
leaks it in a `Referer`. Both flows are account-takeover / account-creation
surfaces. There is no legitimate reason for a production deploy of this app to
be served over plain HTTP, so the validator **fails closed** rather than
"allowing it with a warning": a misconfiguration must stop the build, not ship
and quietly mint insecure credential URLs.

### 8.1 The defect (GO-LIVE BLOCKER)

Three shipped call sites built every absolute link as:

```ts
process.env.NEXT_PUBLIC_URL || "http://localhost:3000"
```

`src/app/api/auth/password-reset/request/route.ts` (reset link),
`src/app/api/admin/teacher-applications/[id]/approve/route.ts` (activation
link), `src/app/api/students/me/referral/route.ts` (share URL).

In production, an unset `NEXT_PUBLIC_URL` therefore produces **reset and
activation emails that link to `http://localhost:3000`** — the mail is
delivered, the token is valid, the audit log records `delivered=true`, and the
link goes nowhere. Neither flow can be completed by a real person. This is
squarely the brief's "password-reset/teacher-activation email links unusable in
production" and "missing critical env validation that causes unsafe behavior"
blocker class.

### 8.2 The fix

1. **New `src/lib/app-url.ts`** — the single place that decides what an
   acceptable origin is and how a path is appended:
   * `getAppUrlProblem(env)` — non-production: never a problem. Production:
     enforces the full HTTPS-only contract in §8.0. Messages name the
     **variable only**, never a value.
   * `resolveAppUrl(env)` — throws in production when unusable; dev/test keep
     the `http://localhost:3000` fallback (behaviour unchanged).
   * `appUrl(pathAndQuery, env)` — the only mint for an absolute link. Paths are
     server-authored and always carry a freshly minted token or a stored code,
     so nothing client-supplied can reach the origin half → **no open redirect**.
2. **`src/lib/env.ts`** — `validateProductionEnv()` now also enforces the
   origin, so the failure is caught by `next.config.ts` (build) and
   `src/instrumentation.ts` (startup), not by a locked-out user.
3. **Three call sites migrated**; `DEV_APP_URL` is now the only localhost
   literal and it is unreachable when `NODE_ENV=production`.
4. **`.env.example`** documents the new contract, why the build environment
   needs the value too (`NEXT_PUBLIC_*` is inlined into any **client** bundle
   that reads it), and the `SKIP_PRODUCTION_ENV_CHECK=1` escape hatch.
5. **CI** — `migration-providers-postgres.yml` now supplies a disposable public
   **HTTPS** origin (`https://ci-only.invalid`, RFC 2606) for its production
   build (it already supplied a disposable `SECURITY_HASH_SECRET`). The first
   pass used `http://ci-only.invalid`; the HTTPS-only tightening required that
   to become `https://`.

Verified empirically: no client component reads `NEXT_PUBLIC_URL` today, so the
**server** bundle retains a runtime `process.env.NEXT_PUBLIC_URL` lookup rather
than a baked-in literal. The build-time check is still the right place to
enforce it (fail at deploy, and correct for any future client-side reader).

### 8.2b Regression pins for the HTTPS-only contract

`tests/security-hardening.test.js` now compiles `src/lib/app-url.ts` alongside
`src/lib/env.ts` and exercises the module **directly**, not only through
`env.ts`. It pins the complete accept table (6 origins), the complete reject
table (31 values — including `http://codemind.academy` itself, `https://`
loopback, the whole `127/8` block, embedded credentials, query strings,
fragments, `ftp:`/`file:`/`mailto:`/`javascript:`/`data:`, protocol-relative
and scheme-less forms), the throw-not-fallback behaviour of `resolveAppUrl()`,
trailing-slash normalization, `appUrl()` minting in both production and test,
the untouched dev/test localhost fallback, and four source-level invariants
(no `http:` acceptance branch anywhere in the validator; exactly one scheme
gate; credentials and query/fragment both rejected; none of the three call
sites hardcodes a localhost origin outside a comment).

**Suite: 304 → 368 passed, 0 failed.**

### 8.3 Redirects / deep links / notification links (PASS, unchanged)

`src/lib/deep-link.ts` + `src/lib/notification-links.ts` accept only
`lesson|video|quiz|homework:<id>` with an id of 1–64 `[A-Za-z0-9_-]` chars.
Every external URL form (`https://…`, `//…`, `/admin/…`, `javascript:`) is
rejected, and a stored link is never authorization. `src/lib/media.ts`
`isSafeExternalUrl()` blocks SSRF targets. No client-provided URL is echoed.

---

## 9. Production build QA — `npm run build:postgres`

Command actually run (values are disposable; no production secret was used):

```
PRISMA_QUERY_ENGINE_LIBRARY=… PRISMA_SCHEMA_ENGINE_BINARY=… \
SECURITY_HASH_SECRET=<disposable> NEXT_PUBLIC_URL=https://codemind.example.academy \
DATABASE_URL=postgresql://user:pass@localhost:5432/codemind \
npm run build:postgres
```

| Check | Result |
|---|---|
| Uses the PostgreSQL schema | PASS — `Prisma schema loaded from prisma/postgres/schema.prisma`; generated `node_modules/.prisma/client/schema.prisma` → `provider = "postgresql"` |
| Does NOT mutate the DB | PASS — `grep -c migrate /tmp/build-postgres.log` = **0**. `prisma generate` never connects; `next build` never calls `migrate`. |
| Does NOT run migrations automatically | PASS — nothing in `build:postgres` or `vercel.json` triggers `migrate deploy` |
| Standalone assets copied | PASS — `copy-standalone-assets: .next/static -> .next/standalone/.next/static` and `public -> .next/standalone/public` |
| All pages/routes compile | PASS — `✓ Compiled successfully in 1227ms`, `Finished TypeScript in 12.0s`, `✓ Generating static pages (71/71)`, full `Route (app)` table emitted |
| `BUILD_EXIT` | **0** |
| No server-only secret in a client bundle | PASS — `grep -rl "<disposable secret>" .next/static` → **no hits**; `grep -rhoE "NEXT_PUBLIC_[A-Z0-9_]+" src/` → only `NEXT_PUBLIC_URL` (a public-by-design value); no `R2_*` / `SMTP_*` / `CRON_SECRET` literal anywhere in `.next/static` |
| Fails safely when required production config is absent | PASS — with `NEXT_PUBLIC_URL` unset: `⨯ Failed to load next.config.ts … [codemind] Refusing to start: production environment is not configured. - NEXT_PUBLIC_URL is required when NODE_ENV=production. …` (names the variable, never a value), at config-load time, i.e. **before compiling** |
| Escape hatch still works | PASS — `SKIP_PRODUCTION_ENV_CHECK=1` loads the config normally (`✓ Running next.config.ts took 26ms`) |
| SQLite build NOT substituted | PASS — `build:postgres` was used; `npm run build` was never run for production verification |

### 9.1 The three build-time contract cases, run for real

Each is a real `next build` with `NODE_ENV=production` and a disposable
`SECURITY_HASH_SECRET` (the origin is a PUBLIC value, so it is shown; the
secret is not).

| Case | Command fragment | Result |
|---|---|---|
| **production + missing `NEXT_PUBLIC_URL` → FAIL** | `env -u NEXT_PUBLIC_URL npx next build` | `exit=1`, `⨯ Failed to load next.config.ts` → `Refusing to start: production environment is not configured. - NEXT_PUBLIC_URL is required when NODE_ENV=production. Set it to the public https origin of the deployment …` — at **config load**, before compiling |
| **production + HTTP public URL → FAIL** | `NEXT_PUBLIC_URL=http://codemind.example.academy npx next build` | `exit=1`, `⨯ Failed to load next.config.ts` → `Refusing to start: production environment is not configured. - NEXT_PUBLIC_URL must use the https scheme in production — plain http is rejected. This origin becomes the prefix of every password-reset and teacher-activation link, and those URLs carry a single-use credential in the query string: over http the token is readable and rewritable by anyone on the path, and any https->http hop leaks it in a Referer. …` |
| **production + HTTPS public URL → PASS** | `NEXT_PUBLIC_URL=https://codemind.example.academy npm run build:postgres` | `✓ Compiled successfully`, `Finished TypeScript`, `✓ Generating static pages (71/71)`, standalone assets copied, **`BUILD_EXIT=0`**, generated datasource `provider = "postgresql"`, `grep -c migrate` = **0** |

**dev/test localhost HTTP → PASS** is proven at the unit level in §8.2b (the
localhost fallback is exercised for `NODE_ENV` = `development`, `test` and
unset) and by the whole offline sweep, which runs with `NODE_ENV` unset and
mints `http://localhost:3000/...` links. A `next dev` server is not started in
this sandbox, and does not need to be: the production guard is a no-op outside
`NODE_ENV=production`, which is exactly the invariant being pinned.

**Sandbox caveat, stated plainly.** This sandbox cannot reach
`binaries.prisma.sh` (only `registry.npmjs.org`, `github.com`, `codeload.github.com`
and `pypi.org` are reachable), so `prisma generate` cannot download the real
query/schema engines. To let `generate → tsc → next build` actually execute, the
two engine paths were pointed at **inert stand-in files in `/tmp`** (outside the
repository, never committed, and not referenced by any repo file). The build
reached `BUILD_EXIT=0` and emitted every artifact, but its log contains one
line that is **purely an artifact of those stand-ins**:

```
Error [PrismaClientInitializationError]: Unable to require(`/tmp/prisma-stub/libquery_engine.so.node`).
The Prisma engines do not seem to be compatible with your system. … file too short
```

(raised during "Collecting page data", where Next evaluates a module that
constructs `PrismaClient`; the builder continued and exited 0). This line does
**not** occur in CI, where `npm ci` downloads the real engines from
`binaries.prisma.sh`. **The authoritative production-build proof is the
`migration-providers-postgres.yml` job "Application regressions, generated
client and PostgreSQL build", which runs `npm ci && npx prisma generate &&
npx tsc --noEmit && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/codemind_migrations npm run build:postgres` against real PG17 with real
engines.** Everything else in this section (schema, no-migration, standalone
copy, secret scan, fail-safe behaviour, exit code) is genuine and reproducible.

---

## 10. Monitoring / health QA

| Surface | State | Classification |
|---|---|---|
| `GET /api` | Returns `{"message":"Hello, world!"}`. A liveness probe only — no DB, storage, or dependency state, and no build/version marker. | **IMPORTANT NON-BLOCKING** |
| Error logging | `PrismaClient({ log: ['error'] })` in production; `console.error` in the cron route (message only, no stack to clients); `SecurityEvent` / `AuditLog` tables for security-relevant actions. Adequate but not aggregated. | **IMPORTANT NON-BLOCKING** |
| Slow-query logging | **Absent.** Prisma `log: ['error']` does not include `warn`/query timing; no `statement_timeout` is set on the app connection. | **FUTURE ENHANCEMENT** |
| Media / R2 health visibility | **Absent.** No endpoint or metric reports R2 reachability, bucket size, or object-count drift. | **IMPORTANT NON-BLOCKING** |
| DB health visibility | **Absent** from any endpoint; `scripts/db/check-pg-migration-state.mjs` and `scripts/db/verify-postgres.mjs` exist but are operator-run CLI tools. | **IMPORTANT NON-BLOCKING** |
| Notification metrics | In-app fan-out is chunked and audited, but no counter/gauge is exposed. | **FUTURE ENHANCEMENT** |
| Backup status visibility | `scripts/db/backup-postgres.sh` writes a manifest — but it cannot run on Vercel (§11). | **IMPORTANT NON-BLOCKING** |
| Storage usage visibility | `MEDIA_QUOTA_BYTES` can cap the local backend; there is **no** equivalent quota/usage signal for the R2 backend. | **IMPORTANT NON-BLOCKING** |

**No paid monitoring dependency was introduced or proposed.** If a health
endpoint is added later, the safe shape is: unauthenticated **liveness only**
(static `200 {"ok":true,"version":…}`), with DB/R2/SMTP checks placed behind an
operator secret or omitted entirely — an unauthenticated readiness endpoint that
reports dependency state is an information leak and a probing oracle.

---

## 11. Backup / restore readiness

| Capability | Launch-ready for the Vercel target? | Detail |
|---|---|---|
| **DB snapshot / branch** | **Partial** | Neon provides provider-side snapshots / branching / PITR. **Verify the Free-tier retention window with the provider before go-live** — do not assume PITR is included. `scripts/db/backup-postgres.sh` is a correct, checksummed, optionally AES-256-encrypted `pg_dump` wrapper, but it needs `pg_dump` + a writable filesystem + cron, **none of which exist on Vercel**. |
| **Offsite DB copy** | **Gap** | Recommended: a scheduled GitHub Actions workflow (free tier) running `pg_dump` against Neon and uploading the artifact (or pushing to R2). Not built — no host exists today, and inventing one is out of scope. |
| **Media backup / recovery** | **Gap** | `scripts/media/migrate-media.mjs` is **local-filesystem → local-filesystem only**; it has no S3/R2 support. There is no R2 backup or restore tool in the repository. R2 durability is currently the only protection. Mitigation that costs nothing: enable **R2 bucket versioning** + a periodic `rclone`/`aws s3 sync` copy from a scheduled runner. |
| **Application rollback** | **Ready** | Vercel instant rollback to any previous deployment — built in, free, no tooling needed. |
| **Migration rollback strategy** | **Adequate** | Prisma has no automatic down-migrations. Both PG migrations are **additive**, so the practical rollback is: restore the DB snapshot/branch → redeploy the previous build. `0_init` is byte-frozen and checksum-pinned; PG-2 is additive-only, so "roll forward to a fixed state" is also available. |
| **Failed deployment recovery** | **Ready** | `src/instrumentation.ts` refuses to boot a misconfigured production deployment; `next.config.ts` refuses to build one. Vercel keeps the previous deployment live if a build fails. |

**Nothing destructive was executed. No restore was rehearsed against production.**

**Consolidated: 4 recoverability gaps, all IMPORTANT NON-BLOCKING** (Neon
retention-window verification, offsite DB copy, R2 media backup, Vercel-specific
runbook). `docs/GO_LIVE_RUNBOOK.md` and `docs/POSTGRES_CUTOVER_RUNBOOK.md` are
**VPS-shaped** (they assume `pg_dump`, `openssl`, a media volume, and system
cron) and do not describe the Vercel target. Writing a Vercel-specific
backup/rollback runbook is the single highest-value follow-up.

---

## 12. Security cross-check (Phase 26F guarantees preserved)

| Guarantee | Result |
|---|---|
| Secret leakage | PASS — `grep -rhoE "NEXT_PUBLIC_[A-Z0-9_]+" src/` → `NEXT_PUBLIC_URL` only. No `R2_*`, `SMTP_*`, `CRON_SECRET`, or `DATABASE_URL` literal reaches `.next/static` (verified by scanning the built client bundle). `.env*` is gitignored (`!.env.example` only) and `git ls-files` is asserted by `tests/security-hardening.test.js` §9. |
| Logs containing credentials | PASS — `mailer.sanitizeError()` strips password **and** user; the cron route logs counters only; `inspect-pg-baseline.mjs` wraps every failure in a message that suppresses details "to protect credentials"; R2 errors name **variable names only**. |
| Signed-URL scope | PASS — PUT-only, one exact server-generated key, 60–900 s, no presigned GET, no LIST (§5.2). |
| Cron authentication | PASS — constant-time bearer, fail-closed 503, query string ignored, sessions ignored (§6.1). |
| SMTP credentials server-only | PASS — `src/lib/mailer.ts` only; never client-imported. |
| `DATABASE_URL` server-only | PASS — read only by `src/lib/db.ts` (Prisma), the cron route, and `scripts/**`. Never returned in a response. |
| SSR / client-bundle exposure | PASS — built-bundle scan (§9); `serverExternalPackages` keeps the AWS SDK out of the webpack bundle; `src/lib/media-s3.ts` is lazy-loaded only when `MEDIA_BACKEND=s3`. |
| Unsafe redirects | PASS — deep-link allow-list (§8.3); `appUrl()` never takes an origin from a request. |
| Arbitrary R2 object keys | PASS — keys are server-generated; `createPresignedPutUrl` rejects `""`, leading `/`, `..`, and control characters; the intent token MAC binds the exact key. |
| Raw S3 errors exposing internals | PASS (§5.5). |
| Production error messages | PASS — fixed minimal bodies on the cron route; Next.js generic 500 elsewhere; non-oracle 404s preserved. |
| No Phase 26F authorization regression | PASS — `tests/auth-cross-role-phase26f.test.js` (20 + `PHASE26F_VERIFIER_OK`), `tests/authorization-invariants.test.js` (93), `tests/security-audit-gate.test.js` (116), `tests/security-hardening.test.js` (368), `tests/security-hardening-phase20.test.js` (192) all green. |

---

## 13. Testing

### 13.1 Command

```
bash /tmp/run-tests.sh     # one `node <file>` per suite in tests/, in name order
```

### 13.2 Result

**Before (clean `main`):** 2 red suites (`final-integration-phase22`,
`payment-lifecycle-phase25-ledger`).
**After (Phase 26G):** 1 red suite — `tests/final-integration-phase22.test.js`,
which requires a seeded `db/custom.db` (gitignored, never committed). Not
caused by this phase and not fixable in a fresh clone (§13.4).

Full per-suite numbers: **§13.5**.

### 13.3 Pre-existing failure found on `main` — diagnosed and re-pinned

`tests/payment-lifecycle-phase25-ledger.test.js` was **already red on `main`
before any 26G edit** (`138 passed, 1 failed`).

* **Cause:** the Phase 26F merge (`95b41d0`, PR #81) added
  `src/app/api/admin/plans/[id]/route.ts`, whose plan-deletion guard reads
  `db.payment.count({ where: { requestedPlanId: id } })` — the first reference
  to a payment **request-intent field** outside the suite's PR2a/PR3 allowlist.
* **Not a security regression:** the file is a **server** route and the suite's
  own stricter invariant ("intent ids appear in server files only") passes.
* **Fix (this phase, additive):** allowlisted the file **and** added a proof,
  in the same shape as the existing admin-queue pin, that it is read-only over
  `Payment` (no `payment.{update,create,delete,upsert}(`, no `$transaction(`,
  and it must contain `db.payment.count(`). `src/lib/payment-transitions.ts`
  remains the sole writer. Result: **140 passed, 0 failed**.
* The `>=`-style thresholds and every other assertion in that suite are untouched.

### 13.4 Environment-dependent, NOT repo defects

| Suite | Behaviour here | Why | Where it is green |
|---|---|---|---|
| `tests/final-integration-phase22.test.js` | `FAIL: db/custom.db missing for curriculum check` | It asserts against the **seeded development database** (2 named admins, 23 OFFICIAL lessons, 2 parts / 7 units). `db/custom.db` is gitignored (`*.db`, `/db/`) and holds production-shaped account data. | A developer machine with the seeded DB. Not part of any CI workflow. |
| `tests/group-track-recovery-postgres.test.mjs` | exits 1 with `Error: Invalid PostgreSQL target` at import | It is a **hard gate**, not a skip: it refuses any non-PostgreSQL URL. No PostgreSQL server is installable in this sandbox (no `psql`/`initdb`, no package access). | `migration-providers-postgres.yml`, "Prove guarded historical Group reconciliation and Prisma recovery" (real PG17 service container). |
| `tests/phase26d-concurrency-postgres.test.mjs` | prints `PHASE26D_CONCURRENCY_SKIPPED`, exits 0 | Deliberate graceful skip; CI turns the sentinel into a **hard failure**. | `phase26d-postgres-concurrency.yml` (real PG17). |
| `tests/pg-baseline-inspection.test.mjs` | `PG_BASELINE_INSPECTION_OK` | Passes, and its own output states it is **embedded PGlite only; NOT real PostgreSQL proof**. | The real proof is the PG17 workflow (§3.3). |

### 13.5 Full sweep — authoritative numbers

```
$ bash /tmp/run-tests.sh    # DATABASE_URL=file:./db/custom.db,
                            # SECURITY_HASH_SECRET=<ci-only placeholder>,
                            # NEXT_PUBLIC_URL=https://codemind.example.academy
```

| Suite | exit | Result |
|---|---|---|
| admin-publishing-phase15 | 0 | 384 passed, 0 failed |
| auth-cross-role-phase26f | 0 | 20 passed, 0 failed + `PHASE26F_VERIFIER_OK` |
| authorization-invariants | 0 | 93 passed, 0 failed |
| calendar-i18n-phase9 | 0 | 444 passed, 0 failed |
| curriculum-reconciliation-phase11 | 0 | 56 passed, 0 failed |
| **final-integration-phase22** | **1** | `FAIL: db/custom.db missing for curriculum check` (§13.4) |
| kodgy-phase10 | 0 | 231 passed, 0 failed |
| media-storage-wiring | 0 | 318 passed, 0 failed |
| migration-providers | 0 | 54 passed, 0 failed |
| migration-sql | 0 | 15 passed, 0 failed |
| mock-exam-grading-isolation | 0 | 22 passed, 0 failed |
| mock-exam-phase8 | 0 | 135 passed, 0 failed |
| parent-analytics-alignment-phase19 | 0 | 176 passed, 0 failed |
| parent-dashboard-isolation | 0 | 112 passed, 0 failed |
| parent-monthly-report | 0 | 67 passed, 0 failed |
| payment-experience-phase25-pr3 | 0 | 128 passed, 0 failed |
| payment-lifecycle-phase25-ledger | 0 | **140 passed, 0 failed** (was 138/1 on `main` — §13.3) |
| payment-lifecycle-phase25-pr2a-grandfather | 0 | 32 assertions passed, 0 failed |
| payment-lifecycle-phase25-pr2a | 0 | 169 passed, 0 failed |
| payment-lifecycle-phase25-pr2b-concurrency | 0 | 114 assertions passed, 0 failed |
| payment-lifecycle-phase25-pr2b-fullchain | 0 | 135 assertions passed, 0 failed |
| payment-lifecycle-phase25-pr2b-utc-tz | 0 | 863 assertions passed, 0 failed (10 timezones) |
| payment-lifecycle-phase25-pr2b | 0 | 252 assertions passed, 0 failed |
| phase25-pr4-inventory | 0 | 203 passed, 0 failed |
| phase25-pr4-release-gate | 0 | 93 passed, 0 failed |
| phase26a-public-auth | 0 | 121 passed, 0 failed |
| phase26b-group-track | 0 | 83 passed, 0 failed |
| phase26b-student-flow | 0 | 39 passed, 0 failed |
| phase26c-admin-full-flow | 0 | 86 passed, 0 failed |
| phase26c-schooltype-enum-typing | 0 | 43 passed, 0 failed |
| phase26d-concurrency-postgres | 0 | `PHASE26D_CONCURRENCY_SKIPPED` (no PG here — §13.4) |
| phase26d-teacher-full-flow | 0 | 136 passed, 0 failed |
| phase26e-parent-full-flow | 0 | 380 passed, 0 failed |
| platform-upgrade-2026-migration | 0 | 98 passed, 0 failed |
| presigned-uploads-phase23 | 0 | 327 passed, 0 failed |
| production-storage-phase21 | 0 | 180 passed, 0 failed |
| quiz-analytics | 0 | 44 passed, 0 failed |
| registration-validators | 0 | 24 passed, 0 failed |
| s3-storage-r2 | 0 | 184 passed, 0 failed |
| security-audit-gate | 0 | **116 passed, 0 failed** (+ 43 in its browser sub-verify) |
| security-hardening-phase20 | 0 | 192 passed, 0 failed |
| security-hardening | 0 | **368 passed, 0 failed** (was 293 before the §14/§8 work, 304 after it, 368 after the HTTPS-only tightening) |
| seed-idempotency | 0 | 18 passed, 0 failed |
| session-lifecycle-phase13 | 0 | 302 passed, 0 failed |
| session-materials-phase14 | 0 | 127 passed, 0 failed |
| session-notifications-phase17 | 0 | 319 passed, 0 failed |
| session-progression | 0 | 162 passed, 0 failed |
| session-quiz | 0 | 70 passed, 0 failed |
| student-locked-curriculum-phase16 | 0 | 366 passed, 0 failed |
| teacher-application-phase20 | 0 | 75 passed, 0 failed |
| teacher-workflow-phase18 | 0 | 371 passed, 0 failed |
| track-architecture-phase12 | 0 | 310 passed, 0 failed |
| vercel-cron-retention-phase24 | 0 | 161 passed, 0 failed |
| group-track-recovery-postgres (.mjs) | 1 | `Error: Invalid PostgreSQL target` (hard gate — §13.4) |
| pg-baseline-inspection (.mjs) | 0 | `PG_BASELINE_INSPECTION_OK` (PGlite, not real-PG proof) |

**Totals: 55 suites — 53 `exit=0` with a pass summary, 2 `exit=1`.**
Of the two failures, one (`group-track-recovery-postgres`) is a deliberate hard
gate that refuses to run without real PostgreSQL, and one
(`final-integration-phase22`) is the pre-existing seeded-DB artifact — both
explained in §13.4. **No suite that was green on `main` went red, and
`payment-lifecycle-phase25-ledger` went from red to green.**

### 13.6 Typecheck

`npx tsc --noEmit` → **exit 0, no output** (run after every source edit).

### 13.7 Derivation integrity

`node scripts/db/make-postgres-schema.mjs --check` →
`prisma/postgres/schema.prisma: in sync` / `postgres-baseline.sql: in sync`.

### 13.8 Second consequence of the §8 fix — the production-mode audit harness

The new production origin contract is **not** free: it broke one existing
verifier, and the break had to be fixed properly rather than waived.

`scripts/verify-security-audit-gate-browser.mjs` deliberately sets
`NODE_ENV = "production"` so it can audit the *shipped* posture (security
headers, `Secure`/`HttpOnly`/`SameSite`, CSRF against a real JSDOM cookie
engine). It already seeded a throwaway `SECURITY_HASH_SECRET` for exactly this
reason. With the §8 change it began crashing with
`Refusing to start: production environment is not configured — NEXT_PUBLIC_URL
is required…`, taking `tests/security-audit-gate.test.js` from 116/0 to 115/1.

**Fix (in the harness, not in the contract):** seed a disposable public origin,
set **unconditionally** rather than with `||`:

```js
process.env.NEXT_PUBLIC_URL = "https://audit-gate.invalid";   // RFC 2606
```

Unconditional matters: the ordinary **dev** value of that variable is
`http://localhost:3000`, and a developer or CI runner that has it exported would
be rejected by the production contract even though the harness forced production
mode itself. The value is never dialled — the only client is JSDOM talking to a
loopback `127.0.0.1` server.

Verified: `node scripts/verify-security-audit-gate-browser.mjs` → 43 passed /
0 failed / `SECURITY_AUDIT_GATE_BROWSER_OK`, **including when re-run with
`NEXT_PUBLIC_URL=http://localhost:3000` exported** (the hostile case).
`tests/security-audit-gate.test.js` → **116 passed, 0 failed**.

**Waiving the check with `SKIP_PRODUCTION_ENV_CHECK=1` was rejected** — the
harness exists to prove the production posture, and the whole point of the block
is that production configuration is actually present.

---

## 14. Windows test-harness defect — FIXED

**Symptom (user-reported, Windows only):** `tests/security-hardening.test.js`
prints `found 0 routes in protected namespaces` and exits 1.

**Root cause** (confirmed by simulation, not guessed):

```js
// BEFORE
const routes = walk(api).map((p) => path.relative(REPO, p));
const protectedRoutes = routes.filter((r) =>
  RP.isProtectedApiPath("/" + path.dirname(r).replace(/^src\/app\//, "").replace(/\\/g, "/"))
);
```

`path.relative()` returns `src\app\api\admin\overview` on Windows. The prefix
regex `/^src\/app\//` is applied **before** the backslash rewrite, so it never
matches; the rewrite then yields `/src/app/api/admin/overview`, which is not any
protected namespace (`/api/admin`, …). §6's whole per-route authorization sweep
then iterated an **empty** list and passed vacuously — and the `>= 60`
assertion, which is the only thing that caught it, failed.

**Fix** (normalise BEFORE removing the prefix, and store the normalised form):

```js
const routes = walk(api).map((p) =>
  path.relative(REPO, p).split(path.sep).join("/")
);
const routeDir = (r) => r.split("/").slice(0, -1).join("/");
const protectedRoutes = routes.filter((r) =>
  RP.isProtectedApiPath("/" + routeDir(r).replace(/^src\/app\//, ""))
);
```

`path.dirname` **cannot** be used on the normalised string: on Windows
`path.win32.dirname("src/app/api/admin/overview")` returns
`src\app\api\admin` and re-introduces the backslashes. `routeDir()` is
byte-identical on every platform. Storing the POSIX form in `routes` also fixes
the downstream `startsWith("src/app/api/admin/")` filter, which had the same
latent defect.

**Regression pins added (3 new assertions, none removed or relaxed):**

1. every discovered path is separator-normalised (`!r.includes("\\")`);
2. every protected route still starts with `src/app/api/` (catches the exact
   "double-prefixed `/src/app/api/…`" shape the bug produced);
3. discovery finds ≥ 1 route in **each** of `admin`, `students`, `parents`,
   `teacher` — the precise symptom (all namespaces empty at once).

**The `>= 60` assertion is preserved verbatim.**

**Cross-platform proof:** the normalised expression yields `/api/admin` for both
a Windows-shaped input (`src\app\api\admin\overview`) and a POSIX input.

**Local counts match the user's proof exactly:** total API routes **110**;
admin **49**; students **16**; parents **5**; teacher **14**.
Suite result: **295 → 368 passed, 0 failed** on Linux (unchanged behaviour,
+11 assertions across this and the §6 work).

---

## 15. Production environment inventory (authoritative)

Names below are **exactly** what the shipped code reads. Two names in the phase
brief differ from the implementation and are called out explicitly.

### 15.1 Required for launch

| Var | Server/Client | Secret | Format | Production behaviour if missing/invalid |
|---|---|---|---|---|
| `DATABASE_URL` | server | **YES** | `postgresql://…?sslmode=verify-full` (see §3.3) | Prisma cannot connect → every DB route 500s. The cron route answers 503 `DATABASE_URL_NOT_POSTGRES` for a non-PG URL. |
| `SECURITY_HASH_SECRET` | server | **YES** | ≥ 32 chars, not the dev fallback, not the `.env.example` placeholder | **Build and server startup refuse to proceed.** Keys IP hashes (audit/rate-limit) and device fingerprints. |
| `NEXT_PUBLIC_URL` | client + server | no (public by design) | **absolute `https:` origin only** — not loopback, no credentials, no `?`, no `#` — e.g. `https://codemind.academy`. Base path allowed. Dev/test: any value, defaults to `http://localhost:3000`. | **Build and server startup refuse to proceed (26G).** `http://<public-host>` is rejected too — the origin prefixes reset/activation links that carry a single-use token (§8.0). Previously: silent localhost links in reset/activation mail. |
| `MEDIA_BACKEND` | server | no | `s3` (production) or `local` | Unset ⇒ `local` ⇒ bytes go to the **ephemeral** serverless filesystem and are lost. Any unsupported value ⇒ **fail-closed throw** on the first storage operation (never a silent fallback). |
| `R2_ACCOUNT_ID` | server | no (but sensitive) | Cloudflare account id | `MEDIA_BACKEND=s3` → **fail-closed throw**, names the missing var only |
| `R2_ACCESS_KEY_ID` | server | **YES** | R2 S3 token access key | same |
| `R2_SECRET_ACCESS_KEY` | server | **YES** | R2 S3 token secret | same |
| `R2_BUCKET` | server | no | bucket name | same |
| `R2_REGION` | server | no | `auto` (default) | optional — defaults to `auto` |
| `R2_S3_ENDPOINT` | server | no | `https://<account>.r2.cloudflarestorage.com` | optional — derived from `R2_ACCOUNT_ID` when blank. **NOTE: this is `R2_S3_ENDPOINT`, not `R2_ENDPOINT`.** |
| `SMTP_HOST` | server | no | `smtp.gmail.com` | `isSmtpConfigured()` false ⇒ **no mail is delivered**; reset tokens still mint and validate correctly, so the flow cannot be completed by a real person |
| `SMTP_PORT` | server | no | `587` (STARTTLS) / `465` (implicit TLS) | same |
| `SMTP_USER` | server | no | Gmail address | same |
| `SMTP_PASSWORD` | server | **YES** | 16-char Gmail **App Password** | same. **NOTE: this is `SMTP_PASSWORD`, not `SMTP_PASS`.** |
| `CRON_SECRET` | server | **YES** | `openssl rand -hex 32` | Cron route answers **503 `CRON_SECRET_NOT_SET`**; the purge never runs (fail-closed). Never a `NEXT_PUBLIC_*` var. |

### 15.2 Optional / tuned

| Var | Default | Notes |
|---|---|---|
| `EMAIL_FROM` | `SMTP_USER` | Sender header. **NOTE: the implementation reads `EMAIL_FROM`, not `SMTP_FROM`.** Gmail requires it to equal the authenticated address. |
| `SMTP_SECURE` | `0` | `1` ⇒ implicit TLS on 465 |
| `MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC` | `600` | clamped to **[60, 900]** |
| `MEDIA_MAX_VIDEO_BYTES` | `536870912` (512 MB) | per-file ceiling |
| `MEDIA_MAX_IMAGE_BYTES` | `5242880` (5 MB) | quiz evidence |
| `MEDIA_MAX_PDF_BYTES` | `26214400` (25 MB) | session PDFs |
| `MEDIA_QUOTA_BYTES` | unlimited | **local backend only** — no equivalent for R2 (§10) |
| `MEDIA_STORAGE_PATH` | `./storage/media` | **local backend only** — irrelevant (and unusable) on Vercel |
| `QUIZ_EVIDENCE_RETENTION_DAYS` | `30` | validated 1..3650; invalid ⇒ **throws** |
| `PASSWORD_RESET_TTL_MINUTES` | `15` | |
| `TEACHER_ACTIVATION_TTL_HOURS` | `72` | |
| `NOTIFICATION_FANOUT_CHUNK_SIZE` | `500` | clamped to **[1, 1000]**. **Added to `.env.example` this phase** — it was read by `src/lib/notify.ts` but undocumented. |
| `RATE_LIMIT_*` (7 vars) | per-endpoint defaults | unparseable ⇒ clamped, **never disables** the limiter |
| `CSP_REPORT_ONLY` / `CSP_DISABLED` | `0` / `0` | operator kill-switches, no redeploy needed |
| `HSTS_DISABLED` | `0` | operator kill-switch |
| `DELIVERY_DEV_LOG` | `1` | **ignored when `NODE_ENV=production`** — redacted log line only |
| `SKIP_PRODUCTION_ENV_CHECK` | unset | `1` skips the **build-time** env contract only; the runtime guard in `src/instrumentation.ts` still enforces it |
| `BACKUP_PASSPHRASE` | unset | AES-256 backup encryption; **not usable on Vercel** (no shell) |
| `POSTGRES_URL` | unset | accepted by `scripts/db/verify-postgres.mjs` and `scripts/phase25-pr4-inventory.mjs` as an alternative target |
| `SEED_ADMIN_PASSWORD` / `SEED_DEMO_PASSWORD` | unset | seeder only; unset + `NODE_ENV=production` ⇒ **the seeder refuses to run** |
| `EMAIL_TEST_TO` | — | `scripts/send-test-email.ts` only |

### 15.3 Client-exposed surface

`grep -rhoE "NEXT_PUBLIC_[A-Z0-9_]+" src/` → **`NEXT_PUBLIC_URL`** and nothing
else. No secret can become public via a `NEXT_PUBLIC_` prefix.

---

## 16. Files changed

| File | Change |
|---|---|
| `src/lib/app-url.ts` | **NEW.** Production-validated origin resolution + `appUrl()` link minting (blocker fix). **HTTPS-only** in production since the review round (§8.0). |
| `src/lib/env.ts` | `validateProductionEnv()` now enforces the origin; documents the no-production-fallback rule and the HTTPS-only threat model. |
| `src/app/api/auth/password-reset/request/route.ts` | reset link now minted via `appUrl()`. |
| `src/app/api/admin/teacher-applications/[id]/approve/route.ts` | activation link now minted via `appUrl()`. |
| `src/app/api/students/me/referral/route.ts` | share URL now minted via `appUrl()` (+ `encodeURIComponent` on the code). |
| `.env.example` | `NEXT_PUBLIC_URL` production contract — **HTTPS-only**, bare origin, with the threat model; R2 exact names; SMTP exact names; `sslmode=verify-full` rationale; **added `NOTIFICATION_FANOUT_CHUNK_SIZE`**. |
| `tests/security-hardening.test.js` | **Windows portability fix** in §6 route discovery + 3 regression pins; production-origin assertions in §1; `prod()` baseline extended by one public var (no assertion weakened); **HTTPS-only contract table — 6 accept + 31 reject + throw/append/fallback pins + 4 source invariants (§8.2b)**. |
| `tests/payment-lifecycle-phase25-ledger.test.js` | allowlist re-pin for the Phase 26F plans route **plus** a new read-only proof (fixes a suite that was already red on `main`). |
| `.github/workflows/pg17-full-chain-reference.yml` | **NEW — promoted from `arena/pg17-full-chain-reference` @ `1a7f9ab`** (verified, + provenance header). **Pending Git delivery (§4.5).** |
| `.github/workflows/phase26d-postgres-concurrency.yml` | dead-branch `push:` trigger → `arena/**`. **Pending Git delivery (§4.5).** |
| `.github/workflows/migration-providers-postgres.yml` | supplies a disposable **HTTPS** origin (`https://ci-only.invalid`) for its production build. **Pending Git delivery (§4.5).** |
| `scripts/verify-security-audit-gate-browser.mjs` | seeds a disposable public `NEXT_PUBLIC_URL` for its forced-production audit run (§13.8). Contract satisfied, **not** waived. |
| `docs/POSTGRES_CUTOVER_RUNBOOK.md` | §6 `sslmode` guidance (`verify-full`, with the `channel_binding` fallback). |
| `docs/VERCEL_FREE_DEPLOYMENT_PLAN.md` | supersede notice: the storage/cron/SMTP/sslmode details in that plan are stale; points at the authoritative sources. |
| `docs/PHASE_26G_PRODUCTION_INTEGRATIONS_QA.md` | **NEW** — this document. |
| `docs/PLATFORM_ROLE_CAPABILITIES.md` | **NOT changed** — deliberately. It records only role/authorization capabilities proven against a real database, and it makes no claim about storage, mail, cron or origin configuration. Nothing in this phase changes or clarifies a *capability* it asserts, and adding unverified integration claims to it would violate its own stated rule. |

---

## 17. Exact commands and results

See **§13.5** (test sweep) and **§9** (build). Additional one-offs:

```
$ sha256sum prisma/postgres/migrations/0_init/migration.sql \
            prisma/postgres/migrations/20260915180000_phase26d_quiz_attempt_architecture/migration.sql
c7f5d3fa76931d02e48c5cd2c4bfdb972c0f25e528e3c0c116736d3729cefa80  prisma/postgres/migrations/0_init/migration.sql
2c1bdde167f7dfff9b79a61f116da3dbd93b13c6aa27825404a79312ec7be104  prisma/postgres/migrations/20260915180000_phase26d_quiz_attempt_architecture/migration.sql

$ node scripts/db/make-postgres-schema.mjs --check
prisma/postgres/schema.prisma: in sync
postgres-baseline.sql: in sync

$ npx tsc --noEmit
(no output, exit 0)

$ grep -rhoE "NEXT_PUBLIC_[A-Z0-9_]+" src/ | sort -u
NEXT_PUBLIC_URL

$ grep -c migrate /tmp/build-postgres.log
0

# ---- HTTPS-only origin contract: 46-case accept/reject proof -----------------
# (compiles src/lib/app-url.ts with tsc and exercises it directly)
$ node /tmp/prove-origin.mjs
  OK  want=FAIL got=FAIL  production + missing NEXT_PUBLIC_URL => fail
  OK  want=FAIL got=FAIL  production + HTTP public URL  (http://codemind.example.com) => fail
  OK  want=PASS got=PASS  production + HTTPS public URL (https://codemind.academy) => pass
  OK  want=PASS got=PASS  dev/test localhost HTTP => pass
  … 42 further rows …
  prod  https://codemind.academy + /reset-password?token=abc -> https://codemind.academy/reset-password?token=abc
  prod  https://codemind.academy/app/ + /activate?token=abc  -> https://codemind.academy/app/activate?token=abc
  prod  https://codemind.academy/// (trailing slashes)       -> https://codemind.academy
  test  (no var) + /reset-password?token=abc                 -> http://localhost:3000/reset-password?token=abc
ORIGIN_CONTRACT_PROOF_OK (46 cases)

# ---- the same four cases against REAL next builds ----------------------------
$ env -u NEXT_PUBLIC_URL NODE_ENV=production … npx next build
⨯ Failed to load next.config.ts
Error: [codemind] Refusing to start: production environment is not configured.
  - NEXT_PUBLIC_URL is required when NODE_ENV=production. …
exit=1

$ NODE_ENV=production NEXT_PUBLIC_URL=http://codemind.example.academy … npx next build
⨯ Failed to load next.config.ts
Error: [codemind] Refusing to start: production environment is not configured.
  - NEXT_PUBLIC_URL must use the https scheme in production — plain http is rejected. …
exit=1

$ NEXT_PUBLIC_URL=https://codemind.example.academy … npm run build:postgres
✓ Compiled successfully in 1346ms · Finished TypeScript in 13.0s · ✓ Generating static pages (71/71)
BUILD_EXIT=0

$ NODE_ENV=production SKIP_PRODUCTION_ENV_CHECK=1 … npx next build   # escape hatch
✓ Running next.config.ts took 26ms
```

---

## 18. Unresolved items by severity

### GO-LIVE BLOCKER

**None remaining.**

One was found in the first pass (§8.1: unvalidated origin → localhost links in
security-sensitive mail) and fixed. A review round then tightened that fix:
the validator had accepted `http://<public-host>`, which is unacceptable for an
origin that prefixes password-reset and teacher-activation links. The contract
is now **HTTPS-only** (§8.0), pinned by 37 new assertions (§8.2b) and proven
against real `next build` runs (§9.1).

### IMPORTANT NON-BLOCKING

1. **`sslmode` divergence (§3.3).** Prisma treats `require` as encrypt-only;
   `pg` treats it as `verify-full` today and will silently downgrade to
   encrypt-only at pg v9. Use `sslmode=verify-full`; document the
   `channel_binding=require` fallback. *Docs updated; the URL is operator-owned.*
2. **Connection-limit tuning (§3.2).** Use Neon's pooled endpoint and/or
   `?connection_limit=1&pool_timeout=20`; unmanaged defaults can exhaust
   Neon's connection cap under concurrent Vercel instances.
3. **R2 CORS production origin (§5.6).** Must be added by hand once the Vercel
   origin exists. Not done — the brief forbids it.
4. **`maxDuration = 300` (§6.2).** Verify Fluid Compute is enabled on the
   project; a non-Fluid Hobby project caps at 60 s and Vercel will reject the
   deploy.
5. **Monitoring (§10).** `GET /api` is liveness-only; no DB/R2/SMTP/backup/
   storage-usage visibility. Safe shape suggested; nothing built.
6. **Backup/recoverability (§11).** Verify the Neon Free-tier retention window;
   add an offsite `pg_dump` (scheduled GitHub Action); enable R2 versioning or
   add a media sync — **no R2 backup/restore tooling exists in the repo**.
7. **Runbook gap (§11).** `GO_LIVE_RUNBOOK.md` / `POSTGRES_CUTOVER_RUNBOOK.md`
   are VPS-shaped and do not describe the Vercel target.
8. **SMTP smoke test from the deployed host (§7.2).** Not performed (would send
   real mail). Run `verifySmtpConnection()` once from the deployed host before
   go-live.
9. **`tests/final-integration-phase22.test.js` is red in any fresh clone**
   (§13.4) — it needs the seeded, gitignored `db/custom.db`.
10. **The three workflow files cannot be pushed from this sandbox (§4.5).**
    The GitHub App credential lacks the `workflows` scope. Nothing is wrong
    with the files; they need one push with a user credential that has the
    scope.

### FUTURE ENHANCEMENT

11. Slow-query logging / Prisma `warn` + `statement_timeout` (§10).
12. Notification delivery metrics (§10).
13. R2 storage-usage / quota signal (the local backend has `MEDIA_QUOTA_BYTES`;
    the S3 backend has no equivalent) (§10).
14. `studentCode` required + auto-assigned at referral-code generation
    (already recorded in `PLATFORM_ROLE_CAPABILITIES.md` §3.3 — carried forward,
    not re-raised).
15. Paid observability — explicitly not proposed.

---

## 19. Recommendation

**READY FOR GIT DELIVERY.**

* Every GO-LIVE BLOCKER found has been fixed in this branch, including the
  HTTPS-only tightening that the review round raised (§8.0, §8.2b, §9.1).
* No blocker remains open.
* Typecheck clean, production build clean, the whole offline regression sweep
  green except one suite that is red in *any* fresh clone for an environmental
  reason that predates this phase and is documented (§13.4).
* A pre-existing red suite was diagnosed and re-pinned rather than ignored.
* Nothing was deployed, merged, or turned into a PR — per §17 of the brief.
* **Caveat on the word "delivery":** three files under `.github/workflows/`
  are committed here but cannot be pushed from this sandbox (§4.5). They are
  correct and complete; they need one push with a user credential that carries
  the `workflows` scope.

**Before the Vercel project is created**, work the IMPORTANT NON-BLOCKING list
in this order: (1) set `sslmode=verify-full` and the connection limit on
`DATABASE_URL`; (2) set all 15 required vars from §15.1 — remembering that
`NEXT_PUBLIC_URL` must be **`https://`**; (3) confirm Fluid Compute /
`maxDuration`; (4) add the production origin to R2 CORS; (5) run one SMTP smoke
test; (6) verify the Neon retention window and stand up an offsite `pg_dump`;
(7) enable R2 versioning.
