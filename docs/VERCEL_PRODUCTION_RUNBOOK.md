# CodeMind Academy — Vercel Production Deployment Runbook

> **Phase 26H — the authoritative operator runbook for the CURRENT production
> target** (Vercel Hobby + Neon PostgreSQL 17 + Cloudflare R2 + Gmail SMTP +
> Vercel Cron).
>
> The older `docs/GO_LIVE_RUNBOOK.md` (Phase 22) and
> `docs/DEPLOYMENT_GUIDE.md` describe the **VPS** target (systemd, a media
> volume, local cron, Caddy/nftables TLS). They are historical and only
> partially applicable. When the two disagree, **this file wins** for the
> Vercel target; `docs/POSTGRES_CUTOVER_RUNBOOK.md` still owns the
> PostgreSQL migration specifics and is referenced below where relevant.
>
> **Variable NAMES only appear in this document. No secret value is ever
> written here, in a commit, or in a log.** A value that must be shared goes
> into a password manager, never into the repository.

---

## 0. Preconditions

| Requirement | Why |
|---|---|
| Repository at the release commit on `main`, working tree clean | The deployed artifact must be a reviewed commit. Phase 26H's release candidate is `c467127f54ae1ca651e94dad88d9495438c09c06` (merge of PR #82). |
| Vercel account (Hobby is sufficient) | Hosting, HTTPS, Vercel Cron, instant rollback. |
| Neon project (Free tier is sufficient), PostgreSQL **17** | Production database. |
| Cloudflare R2 bucket, **private**, S3 API token (read/write) | Private media (session videos, lesson PDFs, quiz evidence). |
| Gmail account + **App Password** (2-Step Verification on) | Password reset + teacher activation mail. |
| Node.js 22+ and `git` on the operator machine | Runs the migration step outside Vercel. |
| Two generated secrets: `SECURITY_HASH_SECRET`, `CRON_SECRET` | `openssl rand -hex 32` each. Generate locally, store in a password manager, never commit. |
| The Neon recovery branch `pre-phase26d-recovery-20260916` | Historical recovery point from the Phase 26D incident. **Do not delete it in this phase.** |

---

## 1. Neon — project, roles and the two connection strings

1. Create the Neon project with **PostgreSQL 17** and the default database
   (Neon names it `neondb` unless changed). Note the project region — the
   Vercel function region should be the closest reasonable match.
2. Neon exposes **two** connection strings. They are NOT interchangeable:

| Purpose | Which endpoint | Notes |
|---|---|---|
| **Runtime** (Vercel functions, Prisma Client) | the **pooled** endpoint — its host contains `-pooler` | Serverless invocations are bursty; the pooler (PgBouncer) absorbs them and protects Neon's connection cap. |
| **Migrations** (`prisma migrate deploy/status`) | the **direct** endpoint — no `-pooler` in the host | DDL and `_prisma_migrations` bookkeeping must not run through a transaction-mode pooler. |

3. **SSL — use `sslmode=verify-full`.** Do not rely on `sslmode=require`:

   * Prisma treats `require` as *encrypt, do not verify*.
   * `node`'s `pg` driver currently treats `require` as verify-full, but that
     divergence is a known trap (the Phase 26G §2.3 finding) — the two clients
     in this repository (`@prisma/client` for ORM work and `pg` for the cron
     route) would then disagree about what `require` means.
   * If a network middlebox prevents `verify-full`, the documented fallback is
     `sslmode=require&channel_binding=require`, which at least pins the SCRAM
     channel binding. Prefer `verify-full` whenever it works.

4. Recommended runtime URL **shape** (names only — substitute your own values):

   ```
   postgresql://<user>:<password>@<pooled-host>/<database>?sslmode=verify-full&connection_limit=1&pool_timeout=20
   ```

   * `connection_limit=1` + `pool_timeout=20` keeps a burst of serverless
     instances from exhausting Neon's connection budget; the pooling work is
     done by the pooler, not by Prisma.
   * The **migration** URL should be the direct host with `sslmode=verify-full`
     and no `connection_limit`.

5. Record the Neon retention/restore posture for the plan you created (branch
   history window, point-in-time restore window). **Verify it in the Neon
   dashboard rather than assuming it** — Phase 26G flagged this as an
   unverified assumption and Phase 26H could not verify it from the repository
   either. Store the answer in the deployment log.

---

## 2. Database migration — run it SEPARATELY, never in the build

**The Vercel build never migrates.** `npm run build:postgres` runs
`prisma generate --schema prisma/postgres/schema.prisma`, `next build` and the
standalone asset copy — nothing else. Migration is a deliberate operator step
with the **direct** URL:

```bash
# 1. Apply the migration chain (idempotent; safe to re-run).
DATABASE_URL='<DIRECT_NEON_URL>' \
  npx prisma migrate deploy --schema prisma/postgres/schema.prisma

# 2. Prove it converged.
DATABASE_URL='<DIRECT_NEON_URL>' \
  npx prisma migrate status --schema prisma/postgres/schema.prisma
#    → must print: "Database schema is up to date!"
```

The PostgreSQL chain is exactly two migrations, both additive:

| Migration | SHA-256 (must not change) |
|---|---|
| `prisma/postgres/migrations/0_init` | `c7f5d3fa76931d02e48c5cd2c4bfdb972c0f25e528e3c0c116736d3729cefa80` |
| `prisma/postgres/migrations/20260915180000_phase26d_quiz_attempt_architecture` | `2c1bdde167f7dfff9b79a61f116da3dbd93b13c6aa27825404a79312ec7be104` |

Verify them before applying:

```bash
sha256sum prisma/postgres/migrations/0_init/migration.sql \
          prisma/postgres/migrations/20260915180000_phase26d_quiz_attempt_architecture/migration.sql
```

**Never, at any point:**

* `prisma migrate reset` — destroys data;
* `prisma db push --accept-data-loss` against production;
* `DROP`, `TRUNCATE`, manual edits to the SQL files;
* regenerate / squash / rename `0_init` (its checksum is the recovery anchor
  for the Phase 26D incident);
* point the PostgreSQL provider at `prisma/migrations` (the SQLite chain) —
  that is the exact failure the Phase 26D hotfix separated.

**If the ledger shows a `failed` row** (the Phase 26D incident class):
follow `docs/POSTGRES_CUTOVER_RUNBOOK.md` and the recovery flow — mark the
failed migration rolled back, re-apply, then re-verify. Do not reset.

---

## 3. Vercel project import

1. **Import the Git repository** (`Muhammed-Fathi/codemind-academy`, branch
   `main`). Do not create a Vercel project before the migration above has run;
   the first deploy is allowed to fail closed while configuration is
   incomplete, but there is no reason to invite it.
2. **Framework preset:** Next.js (auto-detected). **Root Directory:** the
   repository root.
3. **Build Command:** `npm run build:postgres`.
   `vercel.json` already pins it, and `vercel.json` takes precedence over the
   dashboard setting. Still set *Settings → Build and Deployment → Build
   Command* to the same value, so the project does not silently depend on
   framework defaults (Next.js would otherwise run `npm run build`, which
   generates the **SQLite** Prisma Client — a wrong client for a
   `postgresql://` URL).
4. **Install Command:** leave the default (`npm install`; the committed
   `package-lock.json` pins the tree).
5. **Node.js Version:** 22.x (`package.json` declares `engines.node >= 22`).
6. **Fluid Compute:** confirm it is **enabled** (it is the default for new
   projects). The retention route declares `maxDuration = 300`, which requires
   the Hobby execution ceiling that Fluid Compute provides. If the project has
   Fluid Compute disabled, either enable it or lower the route's `maxDuration`
   to `60` and accept that a large purge rolls over to the next day's run
   (the job is idempotent and bounded).
7. **Do not** set `SKIP_PRODUCTION_ENV_CHECK` in the Production environment.
   That flag exists for CI build hosts and skips the build-time env contract.

---

## 4. Production environment variables

Set these in *Settings → Environment Variables* for **Production** (and
Preview where noted). Values are never written down here — see §13 of
`docs/PHASE_26H_FINAL_REGRESSION_AND_GO_NO_GO.md` for the authoritative
manifest.

Minimum sets:

* **Database** — `DATABASE_URL` (pooled + `sslmode=verify-full`).
* **Application origin** — `NEXT_PUBLIC_URL` = the real public HTTPS origin of
  the deployment. Required: a production build or boot without it is
  **refused** (Phase 26G). It must be set for the **build** environment too.
* **Security** — `SECURITY_HASH_SECRET` (≥32 chars, real random value).
* **Storage** — `MEDIA_BACKEND=s3` plus `R2_ACCOUNT_ID`,
  `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_REGION=auto`
  (and `R2_S3_ENDPOINT` only if you override the derived endpoint).
* **Email** — `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`
  (Gmail App Password), optionally `EMAIL_FROM`, `SMTP_SECURE`.
* **Cron** — `CRON_SECRET`.

Two consequences worth stating explicitly:

* `MEDIA_BACKEND` unset means `local`, i.e. uploads land on the **ephemeral**
  serverless filesystem and vanish. It is the single highest-impact env var to
  get right on Vercel.
* Changing the production domain means changing `NEXT_PUBLIC_URL` **and
  redeploying** — the value is inlined into any client bundle that reads it.

---

## 5. Deploy and read the build log like an operator

1. Deploy. The build must print `Prisma schema loaded from
   prisma/postgres/schema.prisma`, a successful compile, the static-generation
   summary, and the `copy-standalone-assets:` lines.
2. Confirm the build log contains **no** `migrate` output — if a migration ever
   appears in the build log, stop: the build command has been changed away
   from `npm run build:postgres`.
3. Record the **exact production origin** (custom domain, or
   `https://<project>.vercel.app`). The next two steps need it verbatim.

### 5.1 Next.js version floor — standalone + Vercel adapter (do not downgrade)

`next.config.ts` sets `output: "standalone"` (the self-host artifact), and
Vercel's Next.js builder injects a deployment adapter through
`NEXT_ADAPTER_PATH` during its platform rollout. On **Next 16.3.0–16.3.4**
that combination crashes the build at the adapter hook:

```
Running onBuildComplete from <adapter>
> Build error occurred
Error: ENOENT: no such file or directory, open '.next/next-server.js.nft.json'
```

Root cause: Next 16.3.0 stopped emitting the whole-app NFT file when an adapter
is configured (vercel/next.js#93684) while the `standalone` finalizer and the
platform builder still read it. Upstream fix vercel/next.js#97287 was backported
to the 16.3 line and released in **16.3.5** (2026-09-15).

- **This repo pins `next@^16.3.5` / `eslint-config-next@^16.3.5` and the
  lockfile resolves 16.3.5.** `tests/vercel-standalone-adapter-gate.test.js`
  fails if the locked version drops back below 16.3.5 while standalone output
  is unconditional. Do not downgrade Next on this project.
- Reproduced locally for this audit with a two-line stub adapter:
  `NEXT_ADAPTER_PATH=… next build` exits 1 on 16.3.4 and exits 0 on 16.3.5,
  producing byte-identical standalone trees (same file count).
- **Contingency** if a build *still* fails with that ENOENT (e.g. a rebuilt
  lockfile on a different 16.3.x): re-empty the injected variable one shell
  level below the builder by prefixing the build command —
  `NEXT_ADAPTER_PATH= npm run build:postgres` — or set Vercel's Build Command
  override to that same string. This restores the pre-adapter build path; it is
  a contingency, not the preferred state, and must be reported before launch.

---

## 6. Cloudflare R2 CORS — exact origin (mandatory, and ONLY the exact origin)

Direct browser uploads are cross-origin PUTs. Update the bucket CORS policy to
contain the **exact deployed origin** — never a wildcard:

```json
[
  {
    "AllowedOrigins": ["https://<EXACT_PRODUCTION_ORIGIN>", "http://localhost:3000"],
    "AllowedMethods": ["PUT"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["etag"],
    "MaxAgeSeconds": 3600
  }
]
```

* `http://localhost:3000` is for local development only; drop it if you do not
  develop against this bucket.
* `AllowedMethods` stays `PUT`-only. Adding `GET` would mean reads had stopped
  being server-proxied — a regression signal, not a fix.
* `*` is forbidden: it would let any site trigger uploads against the bucket
  with a stolen signed URL.
* The application never mutates bucket configuration; this is an operator step
  performed **after** the exact origin exists.

Verify with one small and one large admin upload from the deployed app, then
confirm the object is readable only through the app (`/api/media/[id]`,
`/api/materials/[id]`).

---

## 7. SMTP smoke test

1. From the deployed app, request a password reset for an
   **operator-controlled mailbox** (never a real user's, and never a bulk
   send). `POST /api/auth/password-reset/request`.
2. Open the received mail and check the link: its host **must** be the
   production origin, over HTTPS. There is no production path that can emit a
   `localhost` link (Phase 26G), and this smoke is what proves it end-to-end in
   the deployed environment.
3. Do not print the token anywhere; the check is about the origin and the fact
   of delivery.
4. The same check applies to the teacher-activation mail: approve a
   throwaway application, inspect the link host, then delete the throwaway row
   through the normal admin surface — or simply skip this half if no throwaway
   application exists.

If no mail arrives, check (in this order): `SMTP_*` completeness, Gmail App
Password validity, sender == authenticated address (`EMAIL_FROM`), Vercel
function logs (the mailer redacts credentials from every error).

---

## 8. Vercel Cron smoke test

```bash
# Authorized: 200 {"ok":true,...}
curl -i -H "Authorization: Bearer $CRON_SECRET" \
  https://<PRODUCTION_ORIGIN>/api/cron/purge-evidence

# Unauthorized: 401 (no header, malformed header, wrong secret)
curl -i https://<PRODUCTION_ORIGIN>/api/cron/purge-evidence

# Method gate: 405 for POST/PUT/PATCH/DELETE
curl -i -X POST https://<PRODUCTION_ORIGIN>/api/cron/purge-evidence
```

* With `CRON_SECRET` unset the route answers **503**
  `{"ok":false,"error":"misconfigured","reason":"CRON_SECRET_NOT_SET"}` and
  purges nothing (fail-closed).
* The secret is accepted only from the `Authorization` header; query strings
  and sessions are ignored.
* Confirm the Vercel dashboard lists the cron (`0 3 * * *`, once daily —
  Hobby-legal) and that the first scheduled invocation appears in the logs.
* Confirm the deployment's function configuration accepted `maxDuration = 300`
  (§3.6 — Fluid Compute).

---

## 9. Post-deploy verification (roles + invariants)

Run through this list before announcing anything:

| # | Check | Expected |
|---|---|---|
| 1 | Public landing page loads over HTTPS | 200, no console errors |
| 2 | Kodgy (assistant) is not visible before login | hidden pre-auth |
| 3 | Register → login → logout | works; session cookie is `HttpOnly`, `Secure` |
| 4 | Protected URL while logged out | redirect / 401 (proxy is defence-in-depth, the API re-checks) |
| 5 | Password reset end-to-end | new password works; old one does not |
| 6 | Student flow | track → enrollment → payment request → lesson unlock → quiz start/submit → homework |
| 7 | Parent flow | link a child → dashboard, analytics, weekly report |
| 8 | Teacher flow | application → approve → activation link → own password → dashboard/scoped content |
| 9 | Admin flow | users, groups, courses, curriculum publishing, payments, coupons, notifications |
| 10 | Media | upload (presigned PUT) + server-proxied read; a non-owner is denied |
| 11 | **Account baseline (read-only)** | `SELECT role, COUNT(*) FROM "User" GROUP BY role ORDER BY role;` → **2 ADMIN, 1 TEACHER, 0 STUDENT, 0 PARENT** unless you deliberately created users after go-live. Re-verify; do not assume. |
| 12 | **Curriculum invariants (read-only)** | 2 Parts, 7 Units, 23 `curriculumStatus='OFFICIAL'` lessons |
| 13 | Read-only anomaly report | `node scripts/phase25-pr4-inventory.mjs --target '<DIRECT_NEON_URL>'` — every query is a single `SELECT`; the tool redacts the URL. |

Never dump full user rows, never print connection strings, never paste tokens
into the deployment log.

---

## 10. Rollback and emergency disable

**Application (fastest, no data risk):**

Vercel → Deployments → pick the previous healthy deployment → *Promote* /
*Rollback*. The previous build is retained by Vercel; migrations are additive,
so an older application version still reads the current schema.

**Database:** there is no down-migration. The practical recoveries are:

1. **Roll forward**: apply a fixed additive migration (preferred — the schema
   history is checked in and reviewed).
2. **Restore a Neon branch / point-in-time copy**, then repoint
   `DATABASE_URL` at it. This is a *new* endpoint; the old one is left intact
   until the new one is verified.

Never run a destructive in-place restore against the live branch.

**Emergency disable switches (environment only, no code change):**

| Goal | Action | Effect |
|---|---|---|
| Stop the retention purge immediately | Clear `CRON_SECRET` | Route answers 503 and purges nothing (fail-closed). |
| Stop all outbound mail | Clear `SMTP_PASSWORD` | `isSmtpConfigured()` is false; no mail is sent; the app keeps working. |
| A security header breaks the site | `HSTS_DISABLED=1` (preferred) or `CSP_DISABLED=1` / `CSP_REPORT_ONLY=1` | Removes HSTS / the CSP. Use only while diagnosing. |
| Freeze the deployment | Vercel → *Pause* project, or disable AutoDeploy | No new builds or traffic. |

Preserve logs and the last good deployment reference **before** any restore.

---

## 11. Post-launch follow-ups (not blockers)

* Offsite `pg_dump` of Neon (scheduled GitHub Actions workflow or an operator
  machine) — the repository's `scripts/db/backup-postgres.sh` needs a shell and
  a filesystem, neither of which exists on Vercel.
* R2 versioning / periodic object copy; there is no R2 backup tool in the
  repository today.
* Monitoring: `/api` is a liveness stub only. DB / R2 / SMTP health and slow
  queries are not exposed anywhere yet (documented as non-blocking in Phase
  26G §10 and Phase 26H §14).
* The admin AI quiz-generation route (`z-ai-web-dev-sdk`) is sandbox-oriented;
  if the production provider has no credentials, that ADMIN/TEACHER-only
  convenience fails gracefully and manual question authoring continues to
  work.
