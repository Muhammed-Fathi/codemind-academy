# Deployment Guide

CodeMind Academy ships as a **single Next.js deployment** — frontend,
API routes, and Prisma ORM are bundled together. This guide covers the
recommended targets, environment setup, build/run commands, domain +
HTTPS, logs, updates, and rollback.

For local development see [`DEVELOPMENT_GUIDE.md`](DEVELOPMENT_GUIDE.md).

---

## Table of Contents

1. [Deployment Targets](#1-deployment-targets)
2. [Database Strategy](#2-database-strategy)
3. [Environment Variables](#3-environment-variables)
4. [Build](#4-build)
5. [Start](#5-start)
6. [Domain & HTTPS](#6-domain--https)
7. [Database Migrations](#7-database-migrations)
8. [Seeding](#8-seeding)
9. [Logs](#9-logs)
10. [Updates](#10-updates)
11. [Rollback](#11-rollback)
12. [Mini Services](#12-mini-services)

---

## 1. Deployment Targets

### Option A — Vercel (recommended for fastest setup)

Next.js is a first-class citizen on Vercel. Zero-config deployment:

1. Push the repo to GitHub / GitLab / Bitbucket.
2. In Vercel dashboard, **New Project → Import** the repo.
3. Framework preset: **Next.js** (auto-detected).
4. Build command: `bun run build` (or leave default — Vercel detects
   `next build`).
5. Install command: `bun install`.
6. Set environment variables (Project → Settings → Environment
   Variables):
   - `DATABASE_URL` — see section 2 for production DB choice.
   - `NEXT_PUBLIC_URL` — your production URL (e.g.
     `https://codemind.academy`).
7. Deploy. Vercel provides:
   - HTTPS out of the box (Let's Encrypt).
   - CDN for static assets.
   - Edge functions for API routes.
   - Preview deployments for every PR.

> **Note**: If you use Vercel, switch from SQLite to a managed
> PostgreSQL (see section 2). Vercel's serverless filesystem is
> ephemeral — SQLite writes will not persist.

### Option B — VPS with Docker / Caddy / nginx

For self-hosting on a VPS (e.g. DigitalOcean, Hetzner, AWS Lightsail):

1. Provision an Ubuntu 22.04+ VPS with ≥ 2 vCPU, 4 GB RAM.
2. Install:
   - **Bun** (`curl -fsSL https://bun.sh/install | bash`)
   - **Git**
   - **Caddy** or **nginx** (for TLS termination)
3. Clone the repo, `bun install`, configure `.env`.
4. Build the standalone bundle (`bun run build`).
5. Run the production server behind Caddy/nginx.

Sample Caddyfile (TLS auto-managed by Caddy):

```caddy
codemind.academy {
    reverse_proxy localhost:3000 {
        header_up Host {host}
        header_up X-Real-IP {remote_host}
        header_up X-Forwarded-For {remote_host}
        header_up X-Forwarded-Proto {scheme}
    }
}
```

Sample systemd service (`/etc/systemd/system/codemind.service`):

```ini
[Unit]
Description=CodeMind Academy Next.js
After=network.target

[Service]
Type=simple
User=codemind
WorkingDirectory=/home/codemind/codemind-academy
Environment=NODE_ENV=production
Environment=DATABASE_URL=file:/home/codemind/codemind-academy/db/custom.db
Environment=NEXT_PUBLIC_URL=https://codemind.academy
ExecStart=/home/codemind/.bun/bin/bun /home/codemind/codemind-academy/.next/standalone/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable codemind
sudo systemctl start codemind
sudo systemctl status codemind
```

---

## 2. Database Strategy

### SQLite (development / single-VPS)

- Zero-config, file-based at `db/custom.db`.
- Default `DATABASE_URL="file:./db/custom.db"` in `.env.example`.
- Fine for: dev, demos, single-VPS deployments up to ~100 concurrent
  users.
- Backup: just copy the file (`cp db/custom.db backup/custom-$(date +%F).db`).

### PostgreSQL (production recommended)

For multi-instance / serverless deployments (Vercel, Kubernetes, ECS),
switch to PostgreSQL:

1. Provision a managed PostgreSQL (Neon, Supabase, Railway, RDS).
2. Edit `prisma/schema.prisma`:
   ```prisma
   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }
   ```
3. Set `DATABASE_URL` in your environment:
   ```
   DATABASE_URL="postgresql://user:password@host:5432/codemind?schema=public"
   ```
4. Recreate the schema:
   ```bash
   bun run db:push
   bun run scripts/seed.ts
   ```
5. Run a one-time SQLite → PostgreSQL data migration if you have
   existing data (use `pgloader` or a custom Prisma script).

> **Note**: PostgreSQL migration is **Not Currently Implemented** in
> the codebase — the schema currently uses `provider = "sqlite"`. The
> schema itself is portable (no SQLite-specific types are used) but
> the `datasource` block must be changed before deploying.

### MySQL / SQL Server

Not supported. Prisma can target them but the CodeMind schema has not
been validated against them.

---

## 3. Environment Variables

CodeMind is intentionally minimal on env vars. Required for production:

```bash
# Database — SQLite file path OR PostgreSQL connection string
DATABASE_URL="file:./db/custom.db"
# or:
# DATABASE_URL="postgresql://user:password@host:5432/codemind?schema=public"

# Public URL of the deployed application (used for referral links,
# email magic links, etc.)
NEXT_PUBLIC_URL="https://codemind.academy"
```

### What you do NOT need to set

- **No `JWT_SECRET`** — auth uses cookie sessions persisted in the
  `Setting` table.
- **No `NEXTAUTH_SECRET`** — NextAuth is installed but not used;
  auth is custom.
- **No `OPENAI_API_KEY`** — AI is powered by `z-ai-web-dev-sdk` which
  handles credentials internally (in the sandbox). For production,
  ensure the SDK's host environment is configured per the SDK docs.
- **No payment gateway keys** — payments are manual (InstaPay /
  Vodafone Cash / e& Cash), verified by the admin.

### Branding overrides (optional)

The following can be set in the database via Admin → Settings (no env
var needed):

- `brand_name`, `brand_tagline`
- `whatsapp_teacher`, `whatsapp_technical`, `whatsapp_subscription`
- `academic_year`
- `price_monthly`, `price_3months`, `price_6months`, `price_early_bird`

Defaults live in `src/lib/brand.ts`.

---

## 4. Build

```bash
# Install dependencies (if not already done)
bun install

# Push the latest schema to the database (idempotent)
bun run db:push

# Build the standalone Next.js bundle
bun run build
```

What `bun run build` does (from `package.json`):

```bash
prisma generate && next build && node scripts/copy-standalone-assets.mjs
```

- `prisma generate` regenerates the Prisma Client from
  `prisma/schema.prisma` so the build always type-checks against the
  current schema.
- `next build` produces `.next/` (compiled) + `.next/standalone/`
  (self-contained server, because `output: "standalone"` is set in
  `next.config.ts`) and performs full TypeScript validation — any TS
  error fails the build.
- `scripts/copy-standalone-assets.mjs` copies the two asset trees the
  standalone server needs (it is a small Node script, so this works on
  Windows CMD as well as Linux/macOS, unlike the previous `cp -r`
  chain):
  - `.next/static` → `.next/standalone/.next/static` (static chunks,
    otherwise the server can't find them),
  - `public` → `.next/standalone/public` (logo, manifest, robots,
    sitemap).

The result: `.next/standalone/server.js` — a single Node-compatible
entry point that can run anywhere without `node_modules` (Prisma
client is bundled).

### TypeScript checking

`next.config.ts` sets `typescript.ignoreBuildErrors: false`, so any
TS error fails the build. Run `bun run lint` first to catch issues
earlier.

---

## 5. Start

```bash
# Production server (logs to server.log)
bun run start
```

What `bun run start` does (from `package.json`):

```bash
NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee server.log
```

- `NODE_ENV=production` enables Next.js production optimizations.
- `bun` runs the Node-compatible `server.js` (you can swap to `node`
  if you prefer: `node .next/standalone/server.js`).
- `tee server.log` captures stdout/stderr for diagnosis.

The server listens on port **3000** by default. To change it, set
`PORT` before running:

```bash
PORT=4000 bun run start
```

### Health check

The root API endpoint `GET /api/` returns a small JSON status. Use
it for uptime monitoring:

```bash
curl https://codemind.academy/api/
```

---

## 6. Domain & HTTPS

### Vercel

- Domains are configured in the Vercel dashboard (Project → Settings →
  Domains).
- HTTPS is automatic (Let's Encrypt, auto-renewed).
- Vercel handles DNS validation and redirects HTTP → HTTPS.

### VPS (Caddy)

- Caddy automatically provisions and renews Let's Encrypt certificates
  for any domain pointed at your server.
- Just configure the domain in your `Caddyfile` (see section 1B).
- Open ports 80 (HTTP, for ACME challenge + redirect) and 443 (HTTPS).

### VPS (nginx + certbot)

```bash
sudo apt install nginx certbot python3-certbot-nginx
sudo certbot --nginx -d codemind.academy -d www.codemind.academy
```

Sample nginx site config:

```nginx
server {
    listen 80;
    server_name codemind.academy www.codemind.academy;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name codemind.academy www.codemind.academy;

    ssl_certificate /etc/letsencrypt/live/codemind.academy/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/codemind.academy/privkey.pem;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

---

## 7. Database Migrations

### Schema push (recommended for SQLite dev)

```bash
bun run db:push
```

Runs `prisma db push --accept-data-loss`. Idempotent — safe to run
after every schema change. The `--accept-data-loss` flag is set
because SQLite column drops are not supported without recreating the
table (Prisma handles this internally).

### Prisma migrations (recommended for PostgreSQL production)

```bash
# Create a migration from schema changes
bun run db:migrate
# (internally: prisma migrate dev — prompts for a migration name)

# Apply migrations in production
bunx prisma migrate deploy
```

This creates timestamped migration files in `prisma/migrations/` that
should be committed to Git for reproducible production deploys.

### Regenerate Prisma client

After editing `prisma/schema.prisma`:

```bash
bun run db:generate
```

### Reset the database (destructive)

```bash
bun run db:reset
# (internally: prisma migrate reset)
```

Drops and recreates the database, re-runs all migrations, and runs
the seed script if configured.

---

## 8. Seeding

### Initial seed (required for first deploy)

```bash
# After db:push on a fresh database
bun run scripts/seed.ts
```

Creates:
- 4 demo users (admin / teacher / student / parent) with scrypt-hashed
  passwords.
- 1 demo course (Programming & AI) with full Part 1 + Part 2
  curriculum (parts → units → topics → lessons).
- 1 sample quiz (3 questions) on the first lesson.
- 1 sample homework on the first lesson.
- 1 group ("Group A — Sat & Tue 6PM") with the demo student enrolled.
- 2 live sessions (1 upcoming + 1 past with attendance).
- 4 subscription plans (Monthly / 3 Months / 6 Months / Early Bird).
- 3 sample notifications.
- 10 default settings (brand, whatsapp numbers, prices).
- 3 default lesson plan templates (for the teacher portal).

### Optional: extra parent demo

```bash
bun run scripts/seed-parent-demo.ts
```

### Production seeding

On a production deploy, you typically want only:
- The 4 subscription plans.
- The default settings (brand, whatsapp, prices).
- The course + curriculum.
- The 3 lesson plan templates.

You can either:
1. Run `scripts/seed.ts` once and then delete the demo users via the
   admin UI, or
2. Fork the seeder into `scripts/seed-production.ts` and remove the
   demo user creation.

---

## 9. Logs

### Dev server log

```
dev.log
```

- Created by `bun run dev` (which pipes `next dev -p 3000` through
  `tee dev.log`).
- Contains: Next.js compilation logs, API route compilations, request
  logs, error stack traces.
- Read the most recent lines for diagnostics:
  ```bash
  tail -n 100 dev.log
  ```

### Production server log

```
server.log
```

- Created by `bun run start` (which pipes `bun .next/standalone/server.js`
  through `tee server.log`).
- Contains: production request logs, errors, OOM messages.
- Rotate this file with `logrotate` on a VPS:
  ```
  /home/codemind/codemind-academy/server.log {
      weekly
      rotate 8
      compress
      missingok
      notifempty
      copytruncate
  }
  ```

### Prisma query log

Disabled by default (`log: ['error', 'warn']` in `src/lib/db.ts`).
For deep debugging, temporarily change to `['query', 'error', 'warn']`
and restart the dev server.

---

## 10. Updates

To deploy a new version on a VPS:

```bash
# 1. SSH into the server
ssh codemind@your-vps

# 2. Navigate to the project
cd /home/codemind/codemind-academy

# 3. Pull the latest code
git pull origin main

# 4. Install any new dependencies
bun install

# 5. Push any schema changes (idempotent)
bun run db:push
# (or for PostgreSQL: bunx prisma migrate deploy)

# 6. Rebuild the standalone bundle
bun run build

# 7. Restart the production server
sudo systemctl restart codemind

# 8. Verify
curl https://codemind.academy/api/
sudo systemctl status codemind
tail -n 50 server.log
```

For Vercel: every `git push` to `main` triggers a redeploy
automatically. Preview deployments are created for PRs.

---

## 11. Rollback

### Vercel

1. In Vercel dashboard → Project → Deployments.
2. Find the previous working deployment.
3. Click the "..." menu → **Promote to Production**.
4. The previous deployment becomes live immediately.

### VPS (git-based rollback)

```bash
# 1. View recent commits to find the last known-good hash
git log --oneline -20

# 2. Check out that commit
git checkout <commit-hash>

# 3. Reinstall dependencies (in case they changed)
bun install

# 4. Rebuild
bun run build

# 5. Restart the server
sudo systemctl restart codemind

# 6. Verify
curl https://codemind.academy/api/
```

### Database rollback

If a schema migration broke something:

1. Check out the previous code commit (which has the old
   `prisma/schema.prisma`).
2. Run `bun run db:push` to revert the schema (this may cause data
   loss on dropped columns — restore from backup if needed).
3. Restore the database file from backup:
   ```bash
   cp backup/custom-2024-09-01.db db/custom.db
   sudo systemctl restart codemind
   ```

### Database backup strategy

For SQLite:

```bash
# Daily backup
cp db/custom.db backups/custom-$(date +%F).db

# Retain 30 days
find backups/ -name "custom-*.db" -mtime +30 -delete
```

Add this as a cron job:

```cron
0 3 * * * cp /home/codemind/codemind-academy/db/custom.db /home/codemind/codemind-academy/backups/custom-$(date +\%F).db && find /home/codemind/codemind-academy/backups/ -name "custom-*.db" -mtime +30 -delete
```

For PostgreSQL, use `pg_dump`:

```bash
pg_dump $DATABASE_URL > backups/codemind-$(date +%F).sql
```

---

## 12. Mini Services

CodeMind's main Next.js app handles 100% of the production traffic.
Optional sidecar services can live in `mini-services/` and be reached
via the `?XTransformPort=<port>` query parameter (Caddy gateway
pattern).

Each mini-service should:
- Be a separate Bun project with its own `package.json`.
- Define `index.ts` as the entry file.
- Use a hardcoded port (not `PORT` env var) so the gateway can route
  to it deterministically.
- Be started with `bun --hot index.ts` for auto-restart on file
  changes.

### Reaching a mini-service from the frontend

```ts
// Frontend (relative URL + XTransformPort query)
const res = await fetch('/api/whatever?XTransformPort=3030');
```

The Caddyfile routes the request to `localhost:3030`. Never hardcode
`http://localhost:3030` in client code — it won't work in production.

### WebSocket (Socket.IO) example

For real-time features (e.g. live chat in a LiveSession):

1. Create `mini-services/chat-service/index.ts` running Socket.IO on
   port 3003.
2. Frontend connects via:
   ```ts
   import { io } from "socket.io-client";
   const socket = io("/?XTransformPort=3003");
   ```
3. Caddy routes the WebSocket upgrade to `localhost:3003`.

See `examples/` for a reference implementation.

---

## Deployment Checklist

- [ ] `.env` configured with `DATABASE_URL` (SQLite path or
      PostgreSQL connection string).
- [ ] `NEXT_PUBLIC_URL` set to the production domain.
- [ ] `bun run db:push` ran successfully.
- [ ] `bun run scripts/seed.ts` ran (first deploy only).
- [ ] `bun run build` completed without errors.
- [ ] `bun run lint` is clean.
- [ ] Server started (`bun run start` or systemd service).
- [ ] HTTPS reverse proxy (Caddy / nginx / Vercel) configured.
- [ ] DNS A/AAAA records point to the server / Vercel.
- [ ] `curl https://your-domain/api/` returns 200.
- [ ] Login works (`admin@codemind.academy` / `admin123`).
- [ ] Database backup cron job in place (VPS only).
- [ ] `server.log` rotate config in place (VPS only).
- [ ] Demo accounts either removed or password-changed (production).

---

## F. Deployment / Migration Guide — 2026 Platform Upgrade

This section covers upgrading an **existing, populated** CodeMind Academy
installation to the 2026 platform release. Everything in this upgrade is
**additive**: no column is dropped, no row is deleted, and no historical
record is rewritten. A production database can be upgraded in place.

### F.1 What changes

| Area | Change |
|---|---|
| Schema | New tables `Batch`, `MediaAsset`, `SessionVideo`, `SessionVideoView`, `MockExam`, `MockExamQuestion`, `UserSession`, `PasswordResetToken`, `SecurityRateLimit`, `SecurityEvent`, `QuizAttemptEvidence`. New nullable columns on `User`, `Student`, `Question`, `ExamQuestion`, `LessonProgress`, `ExamAttempt`, `QuizAttempt`. |
| Storage | New private directory (`MEDIA_STORAGE_PATH`) for uploaded videos and quiz snapshots. |
| Sessions | Single-device enforcement. Existing cookies remain valid; a `UserSession` row is created on next login. |
| Academic year | Now `2026 / 2027`, sourced from `src/lib/brand.ts` and overridable by the `academic_year` row in `Setting`. |

### F.2 Pre-flight

```bash
# 1. Back up the database — non-negotiable.
cp db/custom.db "db/custom.$(date +%Y%m%d-%H%M%S).db.bak"

# 2. Back up any existing uploads.
tar czf storage-backup-$(date +%Y%m%d).tar.gz storage/ 2>/dev/null || true

# 3. Note the current commit so you can roll back (see §11).
git rev-parse HEAD > .last-deployed-commit
```

### F.3 Environment

Add the new variables from `.env.example` to your `.env`. The minimum set that
must be reviewed before going live:

* `MEDIA_STORAGE_PATH` — an absolute path on a **persistent** volume, outside
  the web root. Never expose it through nginx; `/api/media/[id]` is the only
  legitimate reader and it authorises every request.
* `QUIZ_EVIDENCE_RETENTION_DAYS` — camera snapshots are personal data. Set the
  shortest period your integrity policy tolerates (default `30`).
* `DELIVERY_DEV_LOG` — **must be `false`** in production, otherwise password
  reset tokens are written to the server log.
* `EMAIL_*` / `SMS_*` — without at least one configured channel, password reset
  requests will succeed silently but deliver nothing.

```bash
mkdir -p "$MEDIA_STORAGE_PATH"
chmod 700 "$MEDIA_STORAGE_PATH"
chown "$APP_USER":"$APP_USER" "$MEDIA_STORAGE_PATH"
```

### F.4 Applying the migration

The upgrade ships as `prisma/migrations/20260906120000_platform_upgrade_2026/migration.sql`.

**Preferred — Prisma:**

```bash
npx prisma migrate deploy
npx prisma generate
```

**Fallback — direct SQL.** If the host cannot reach `binaries.prisma.sh` (an
air-gapped or egress-filtered server), apply the same file with the sqlite3
CLI. The migration is written to be idempotent-safe under a transaction:

```bash
sqlite3 db/custom.db < prisma/migrations/20260906120000_platform_upgrade_2026/migration.sql
sqlite3 db/custom.db "INSERT INTO _prisma_migrations
  (id, checksum, migration_name, started_at, finished_at, applied_steps_count)
  VALUES (lower(hex(randomblob(16))), '', '20260906120000_platform_upgrade_2026',
          datetime('now'), datetime('now'), 1);"
```

Recording the row in `_prisma_migrations` is important — otherwise a later
`prisma migrate deploy` will try to apply it a second time. See
`docs/DATABASE_MIGRATION.md` for the full sqlite3-direct procedure.

### F.5 Post-migration data steps

None are mandatory — the application backfills lazily and safely:

* **Batches** are created on demand from the admin *Session Videos* screen, and
  a student is bound to the batch of their school type the first time they open
  the session-video list.
* **`User.status`** defaults to `ACTIVE` for every existing user.
* **`Question.schoolType`** is `NULL` for every existing question, which means
  *shared* — every existing question stays usable by both Arabic and Language
  mock exams. Tag questions later, at your own pace, from the Question Bank
  tabs.
* **Students with no school type** appear under the *Unspecified* tab in the
  admin Students screen; assign them there.

Optional verification:

```bash
sqlite3 db/custom.db "SELECT COUNT(*) FROM User WHERE status IS NULL;"        # expect 0
sqlite3 db/custom.db "SELECT schoolType, COUNT(*) FROM Student GROUP BY 1;"
node --test tests/                                                            # offline schema tests
```

### F.6 Build and restart

```bash
npm ci
npm run build
pm2 restart codemind --update-env   # or: systemctl restart codemind
pm2 logs codemind --lines 100
```

### F.7 Smoke test

1. **Login** as a student on device A, then on device B — device A must be
   signed out and the account marked `SUSPENDED_MULTI_DEVICE`.
2. **Admin → Students** — reactivate that student; they can sign in again and
   the badge clears.
3. **Admin → Session Videos** — create the Arabic batch, publish one video by
   URL and one by upload; confirm the uploaded one plays from `/api/media/...`
   and returns 403 when logged out.
4. **Student → Session Videos** — watch a video; the percentage must rise with
   real playback time, and seeking to the end must *not* complete it.
5. **Student → Quiz** — the consent screen appears first; decline once (quiz
   still runs), then accept and confirm the live indicator and that snapshots
   land in **Admin → Quiz Review**.
6. **Mock exam** — create one per school type, verify the pool count and that a
   student only receives questions from their own bank.
7. **Forgot password** — request a reset, confirm the response is identical for
   a real and a fake identifier, then complete the reset and verify all other
   sessions were revoked.

### F.8 Rollback

Because the migration is purely additive, the previous application build runs
unchanged against the upgraded database — new tables and nullable columns are
simply ignored. To roll back:

```bash
git checkout "$(cat .last-deployed-commit)"
npm ci && npm run build && pm2 restart codemind
```

Restore `db/custom.*.db.bak` only if you must also discard data created after
the upgrade.

### F.9 Password reset — production requirements (EMAIL ONLY, Gmail SMTP)

Password recovery is **email only**. Phone numbers are still collected during
registration and shown in profiles, but they are **never** used for account
recovery: there is no SMS path, no OTP code, and no phone-based reset UI.

**What IS implemented and verified (source-level):**

| Property | Where |
|---|---|
| No account enumeration — identical response for found / unknown / rate-limited | `password-reset/request` |
| Rate limiting per email (3 / 15 min) and per IP (10 / hr) | `password-reset/request` |
| Cryptographically random secret; only its SHA-256 is persisted | `lib/security.ts` |
| Raw token never logged and never returned in a response | both routes |
| Requesting a new token invalidates the previous unused ones | `request` |
| Single use — `usedAt` stamped in the same transaction as the password change | `confirm` |
| Replay/expiry/attempt-limit (5) rejection, all with a uniform error | `confirm` |
| New password hashed with scrypt (`hashPassword`), never stored in plaintext | `confirm` |
| All sessions revoked after a successful reset | `revokeAllSessions` |
| Audit trail stores only the MASKED destination | `logSecurityEvent` |
| Gmail SMTP transport with STARTTLS on 587 (`requireTLS`, TLS ≥ 1.2) | `lib/mailer.ts` |
| SMTP credentials read from env only; redacted from errors/logs/API responses | `lib/mailer.ts` |

**Required before production:**

1. Create a Gmail **App Password** (not your normal Gmail password) at
   <https://myaccount.google.com/apppasswords> (needs 2-Step Verification).
2. Set the environment variables **server-side only** (never in a client bundle:
   the `SMTP_*` / `EMAIL_*` variables are read exclusively by
   `src/lib/mailer.ts`, which server code imports):
   - `SMTP_HOST=smtp.gmail.com`
   - `SMTP_PORT=587` (STARTTLS; use `465` + `SMTP_SECURE=1` only if 587 is blocked)
   - `SMTP_USER=<your codemind Gmail address>`
   - `SMTP_PASSWORD=<the 16-char Gmail App Password>`
   - `EMAIL_FROM` — optional; Gmail only allows the authenticated address, so
     leave it empty to default to `SMTP_USER`.
   - `NEXT_PUBLIC_URL` — **must** be the real public origin (HTTPS in
     production), or the reset link in the email will point at
     `http://localhost:3000`.
   - `PASSWORD_RESET_TTL_MINUTES` (default 15).
   - Ensure `DELIVERY_DEV_LOG` is unset in production.
3. Smoke test with `npm run test:email` from the server (see
   `docs/DEVELOPMENT_GUIDE.md` / the script header): it verifies credentials
   and STARTTLS first, then sends a real test email.
4. End-to-end test after deploy: request a reset for a real account, open the
   link from the email, set a new password, and confirm every existing session
   is logged out.

`hasDeliveryProvider()` (`src/lib/delivery.ts`) reports whether Gmail SMTP is
usable and can be surfaced on an admin health screen (server-side only).
