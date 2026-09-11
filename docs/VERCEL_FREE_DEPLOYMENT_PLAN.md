# CodeMind Academy — Vercel Hobby / Free-Tier Deployment Plan

> **Date:** 2026-09-11 (UTC) — repository at `bd74ada9a4bdfeb0210c8b30007fd2a9c9a54f6f` + branch `arena/01a090f7-codemind-academy`
> **Mode:** READ-ONLY AUDIT + PLANNING — no code, schema, package, env, or deployment changes made except this file
> **Primary question:** Can the current architecture realistically be deployed to Vercel Hobby/Free with free-tier external services, and exactly what must change before deployment?

---

## 1. Executive Summary

**Current architecture is NOT directly Vercel-compatible without architectural changes.** Two hard blockers exist:

1. **SQLite** (`prisma/schema.prisma` provider `sqlite`, `DATABASE_URL=file:./db/custom.db`) — Vercel's filesystem is ephemeral; writes disappear after each function invocation.
2. **Local filesystem media** (`src/lib/media.ts` → `MEDIA_STORAGE_PATH=./storage/media`, `writePrivateFile`/`readPrivateFile` using `fs`) — same ephemerality, plus `storage-quotas.ts` directory walk assumes persistent volume.

Both blockers are **already solved in design** by Phase 21, but Phase 21's solution targets a **single VPS + persistent volume + Caddy**, not Vercel's serverless model. Phase 21 gives us:

- `prisma/schema.postgresql.prisma` (provider swap only, byte-identical models)
- `scripts/db/make-postgres-schema.mjs` + `scripts/db/postgres-baseline.sql` (21 enums + 55 tables + 67 indexes)
- `scripts/db/migrate-sqlite-to-postgres.mjs` (transactional loader, count+hash verified)
- `scripts/db/verify-postgres.mjs` battery (presence, orphans, duplicates, teacher lifecycle, security tables, rate-limit probe, app-shaped queries)
- `scripts/db/backup-postgres.sh` / `restore-postgres.sh` (pg_dump custom + sha256 + manifest)
- `scripts/media/migrate-media.mjs` (SHA-256 per file, never deletes source)
- `src/lib/storage-quotas.ts` + `src/lib/evidence-retention.ts` + `scripts/media/purge-expired-evidence.ts`

**To become Vercel-compatible we must additionally:**

- Point Prisma at PostgreSQL (provider change, connection pooling, migration ledger baseline)
- Replace `LOCAL_PRIVATE` filesystem writes with S3-compatible object storage (Vercel Blob, Cloudflare R2, AWS S3 free tier, Supabase Storage) behind the existing `MediaAsset` abstraction
- Fix 15 pre-existing TypeScript strict errors that cause `next build` to exit 1 even with network (see `docs/PHASE_22_FINAL_REPORT.md`)
- Expose evidence purge and backup as Vercel Cron or external cron, not local cron/systemd
- Translate Caddy responsibilities (HTTPS, X-Real-IP, headers) to Vercel configuration
- Inventory and harden env vars for serverless (server-only secrets vs `NEXT_PUBLIC_*`)

**Security invariants from Phase 20 + Addendum + Security Audit Gate (CONDITIONAL GO, 0 Critical/High open) MUST be preserved verbatim**, especially:

```
Teacher Application → PENDING → Admin Approval → Secure Activation (SHA-256 single-use 72h) → Applicant Password Setup → Active TEACHER
```

**Realistic $0/month starting architecture:**

- **Vercel Hobby** (Next.js 16, Node 22, `output: standalone` ignored on Vercel but harmless)
- **Neon Free** or **Supabase Free PostgreSQL** (or Vercel Postgres free tier — VERIFY CURRENT PROVIDER LIMIT)
- **Cloudflare R2 Free** or **Vercel Blob Hobby** for private media (PDFs, session videos, quiz evidence)
- **Gmail SMTP via `nodemailer`** (existing) or **Resend Free** for transactional email (password reset, teacher activation)
- **Vercel Cron** (Hobby allows 2 cron jobs) for nightly evidence purge + notification cleanup
- **Vercel Analytics / Logs** (built-in, free) + optional **Sentry Free** or **Log Drains**
- DNS via Vercel or Cloudflare Free

**Final readiness:** `NOT COMPATIBLE WITH VERCEL FREE WITHOUT ARCHITECTURAL CHANGES` — but the path is concrete, low-risk, and preserves all security and production-safety principles (safe reconciliation, no destructive reset, FK integrity, media preservation, subscription plan preservation).

---

## 2. Phase History & Architectural Context

### 2.1 Concise Phase Timeline (deployment-relevant only)

| Phase | Major Implementation | Database Impact | Security Impact | Deployment Impact | Current Relevance |
|-------|----------------------|-----------------|-----------------|-------------------|-------------------|
| **P1 — Deployment Readiness Audit** (doc `DEPLOYMENT_READINESS_AUDIT.md`) | Fix privilege escalation via registration, quiz answer leak, parent impersonation | None | CRITICAL + 2 HIGH closed; RBAC baseline | Establishes authz invariants still used | MUST PRESERVE |
| **P2 — Build & Type Safety + Curriculum Source** (`PHASE_2_REPORT.md`, `PHASE_2_BUILD_TYPE_SAFETY.md`) | `ignoreBuildErrors` removed, cross-platform build `prisma generate && next build && copy-standalone-assets`, knowledge model `docs/curriculum/knowledge-model.json` 2/7/23 | None | Honest builds unblock audits | Build command still current; 28 TS errors in P22 are pre-existing baseline, not P2 regression | MUST PRESERVE |
| **P3 — Domain Foundation + Security Hardening** (`PHASE_3_SECURITY_HARDENING.md`, `PHASE_3_REPORT.md`) | `SECURITY_HASH_SECRET` required in prod (`src/lib/env.ts` + `instrumentation.ts` + `next.config.ts`), `src/proxy.ts` defense-in-depth, dependency hygiene, `Track`, `Enrollment`, `Material`, `Lesson.unitId`, `officialCode`, `Batch`, `MediaAsset`, `UserSession`, `PasswordResetToken`, `SecurityEvent`, etc. | Additive migration `20260906120000_platform_upgrade_2026` — 11 new tables, nullable columns | M3, M4 closed; proxy 401 for protected `/api/*` | Introduces persistent session store (`UserSession` SHA-256 hash), env validation, standalone output | MUST PRESERVE |
| **P4 — Student Progression** (`PHASE_4_STUDENT_PROGRESSION.md`) | `src/lib/session-progress.ts` single source of truth (`canAccessLesson`, `canAccessQuiz`, `canAccessHomework`), locked redaction, homework submit endpoint | None | CRITICAL quiz gate fix; leak prevention | No new infra; progression is server-enforced | MUST PRESERVE |
| **P5 — Question Bank & Session Quiz** (`PHASE_5_QUESTION_BANK_SESSION_QUIZ.md`) | Attempt freezing via `QuizAnswer` rows (`src/lib/session-quiz.ts`), server grading | Migration `20260908120000_phase5_quiz_answer_unique` — UNIQUE on `[attemptId, questionId]` | Answer leak fix, tamper resistance | No infra change | MUST PRESERVE |
| **P6 — Quiz Results & Teacher Analytics** (`PHASE_6_QUIZ_RESULTS_TEACHER_ANALYTICS.md`) | Pure analytics `src/lib/quiz-analytics.ts` (finished-only, attempt-weighted) | None | Scope leak fix (teacher course scoping) | No infra | MUST PRESERVE |
| **P7 — Parent Dashboard** (`PHASE_7_PARENT_DASHBOARD_INTEGRATION.md`) | `src/lib/parent-access.ts` parent scope via links, no client ids | None | Content-scope leak closed | No infra | MUST PRESERVE |
| **P8 — Mock Exam Cleanup** (`PHASE_8_MOCK_EXAM_CLEANUP_INTEGRATION.md`) | Stateless draft, no answer key, text-based grading, bank isolation both directions | None | CRITICAL answer key leak fixed | No infra | MUST PRESERVE |
| **P9 — Calendar / I18N** (`PHASE_9_CALENDAR_I18N.md`) | `i18n-core.ts` fallback hardening, scheduler fixes | None | No key leak | No infra | CAN CHANGE FOR VERCEL (i18n irrelevant) |
| **P10 — Kodgy Assistant** (`PHASE_10_KODGY_ASSISTANT.md`) | Scripted assistant, no external AI, no `/api/ai` | None | No secret, no fetch | Removes AI dependency — Vercel-friendly | MUST PRESERVE |
| **P11 — Official Curriculum Reconciliation** (`PHASE_11_OFFICIAL_CURRICULUM_RECONCILIATION.md`) | `src/lib/official-curriculum.ts` reconciler 2 Parts / 7 Units / 23 Lessons, archive sweep | Data migration only (no schema), `officialCode` unique, `curriculumStatus` | Archive invisibility enforced via predicates | Production curriculum seeding mechanism — replaces destructive seed | MUST PRESERVE |
| **P12 — Track Architecture** (`PHASE_12_TRACK_ARCHITECTURE.md`, `PHASE_12_FINAL_REPORT.md`) | `TrackScope` enum (`SHARED/ARABIC/LANGUAGE`) on `Lesson/Quiz/Homework`, `Student.schoolType` nullable enum, `Batch` healing, `src/lib/track-scope.ts` single source | Migration `20260909120000_phase12_track_architecture` — adds `trackScope`, normalises aliases | Cross-track leakage closed; `canAccessTrackScope` | No infra, but introduces batch dimension critical for video access | MUST PRESERVE |
| **P13 — Session Lifecycle** (`PHASE_13_SESSION_LIFECYCLE.md`) | `LessonStatus` enum `DRAFT/READY/PUBLISHED`, `SessionPublication` anchor (idempotency), readiness pure function | Migration `20260909180000_phase13_session_lifecycle` — `status` column + `SessionPublication` table | Closes unpublished preview (parent could open unpublished) | Enables publish workflow; no infra | MUST PRESERVE |
| **P14 — PDF Session Materials** (`PHASE_14_PDF_SESSION_MATERIALS.md`) | `Material(ADMIN_UPLOADED, trackScope) → MediaAsset(DOCUMENT, LOCAL_PRIVATE)`, magic bytes `%PDF-`, authorized `GET /api/materials/[id]` | None (reuse) | PDF authz via 10-check contract, MIME+magic+extension hardening | Introduces private file handling that currently uses local FS — Vercel blocker | MUST PRESERVE (but storage backend must change) |
| **P15 — Admin Publishing Workflow** (`PHASE_15_ADMIN_PUBLISHING_WORKFLOW.md`) | Admin UI for stage→readiness→open→notify, readiness checklist, publication history | None | Recipient count = fan-out query (shared helper) | UI only; no infra | MUST PRESERVE |
| **P16 — Student Locked Curriculum** (`PHASE_16_STUDENT_LOCKED_CURRICULUM.md`) | Locked-but-visible skeletons, unified lesson page, deep-link router `lesson:|video:|quiz:|homework:` | None | Redaction extended to material descriptors | No infra | MUST PRESERVE |
| **P17 — Session Notifications** (`PHASE_17_SESSION_NOTIFICATIONS.md`) | Targeted fan-out `(active student × enrolled course × trackScope)`, preference-aware, deep-linked, chunked 500, deduped `(userId,type,link)`, `notifiedCount/notifiedAt` counters | Migration `20260911000000_phase17_session_notifications` — adds counters to `SessionPublication` | Broadcast bypass fix, link validation | Fan-out is DB-driven, chunked, safe for serverless if chunk size tuned; no persistent worker | MUST PRESERVE |
| **P18 — Teacher Workflow** (`PHASE_18_TEACHER_WORKFLOW.md`) | Homework creation, question edit/delete guards, dual-chain fixes | None | Own-course verification | No infra | MUST PRESERVE |
| **P19 — Parent & Analytics Alignment** (`PHASE_19_PARENT_ANALYTICS_ALIGNMENT.md`) | Official 23-lesson universe everywhere, per-child universes, canonical `orderCourseLessons` | None | No new authz; alignment fixes | No infra | MUST PRESERVE |
| **P20 — Security Hardening II** (`PHASE_20_SECURITY_HARDENING_II.md`) | 10-check contract single definition (`canAccessLesson`), IDOR non-oracle (404 vs 403), rate limiting DB-backed race-free (`SecurityRateLimit` upsert+guarded updateMany), CSP derived from runtime, legacy `Setting:session:*` removal, media hardening (Range strict →416, 404 for external URL) | None | HIGH: closes content-scope residuals | Rate limit is DB-backed multi-process safe — Vercel-compatible; CSP via `next.config.ts` headers | MUST PRESERVE |
| **P20 Addendum — Teacher Applications** (`PHASE_20_ADDENDUM_TEACHER_APPLICATIONS.md`) | Secure lifecycle `PENDING→APPROVED→ACTIVATED` or `→REJECTED`, re-apply reopens same row, `TeacherActivationToken` SHA-256 unique single-use 72h, password set by applicant, no auto-login, 7 audit event types | Migration `20260912000000_phase20_teacher_applications` — `TeacherApplication`, `TeacherActivationToken` | Privilege-preserving, IDOR-safe, rate-limited (`teacherApply` 5/3600/3600) | Email delivery via SMTP; token storage portable | MUST PRESERVE |
| **Pre-P21 Security Audit Gate** (`SECURITY_AUDIT_GATE_PRE_PHASE21.md`) | 8 findings (2 Critical: hardcoded seeder passwords, no login throttle; 3 High: study-plan IDOR, enroll cross-course, leaderboard platform-wide directory; 3 Medium: HSTS, X-Forwarded-For spoof, password floor) — ALL fixed, 0 Critical/High open, R-1…R-7 accepted | None | Gate verdict CONDITIONAL GO — MEDIUM RISKS DOCUMENTED; R-5 defers durability to P21 | Introduces login dual-bucket throttling, HSTS, `clientIpFromHeaders` preferring `X-Real-IP` | MUST PRESERVE |
| **P21 — Production Database & Storage** (`PHASE_21_PRODUCTION_DATABASE_STORAGE.md`, `POSTGRES_CUTOVER_RUNBOOK.md`) | ONE schema source `prisma/schema.prisma` + derived `schema.postgresql.prisma` + `postgres-baseline.sql`, loader `migrate-sqlite-to-postgres.mjs` (one transaction, fail-closed), battery `verify-postgres.mjs`, `pg_dump`/`pg_restore` scripts, media migration `migrate-media.mjs`, evidence purge `purge-expired-evidence.ts`, volume quota `MEDIA_QUOTA_BYTES` | 55 models, 21 enums, 73 FKs, 34 UNIQUEs, 67 indexes — identical on PG | Activation/reset/session/token persistence unchanged, proven on PG (UNIQUE+FK+transactional) | Solves SQLite + ephemeral media for VPS+volume, but volume approach still needs adaptation for Vercel object storage | MUST PRESERVE (but storage backend must evolve for serverless) |
| **P22 — Final Integration** (`PHASE_22_FINAL_REPORT.md`, `GO_LIVE_RUNBOOK.md`) | Production baseline `2 ADMIN + 1 TEACHER + 0 STUDENT/PARENT`, selective cleanup `scripts/phase22-final-integration.mjs`, reconciliation `phase22-reconcile.mjs`, final verification `final-integration-phase22.test.js` 149/149, typecheck 28 errors (13 missing Prisma client + 15 strict mismatches), lint 134, build fails typecheck | No schema change; verifies FK 0, backup SHA256, idempotency | No new security; confirms 71/71 security gate + 42/42 P20 + 26/26 HTTP | Go-live runbook assumes PostgreSQL + durable volume + Caddy — needs Vercel translation | MUST PRESERVE (baseline concept) |

### 2.2 Major Architectural Milestones (deployment-relevant)

- **Authn:** scrypt + per-password salt + timingSafeEqual (`src/lib/auth.ts`), opaque 32-byte token, SHA-256 hash stored (`UserSession.tokenHash UNIQUE`), single-device enforcement with 30-min idle grace, `SUSPENDED_MULTI_DEVICE`.
- **Sessions:** `UserSession` table replaces legacy `Setting:session:*` (removed in P20 with provable precondition `scripts/audit-legacy-sessions.mjs`).
- **Authorization:** `requireUser`/`requireRole`/`requireAdmin` in `src/lib/api.ts`, `getCurrentUserDetailed` returns reason (`NO_SESSION/EXPIRED/REVOKED/SUSPENDED/INACTIVE`), `src/proxy.ts` defense-in-depth cookie-presence 401 for `/api/*`.
- **Content gates:** `src/lib/session-progress.ts` is single definition of enrollment (`Student.group → Group.courseId` active), course chain (`unitId` canonical first, `topicId` legacy), track (`canAccessTrackScope` in `src/lib/track-scope.ts`), lifecycle (`isStudentVisibleStatus` in `src/lib/session-lifecycle.ts`), progression (`unlocked`).
- **Track model:** `TrackScope` on lessons/quizzes/homework/materials, `Student.schoolType` nullable enum failing closed to SHARED, `Batch.schoolType` enum for video distribution, `reconcileStudentBatch()` idempotent.
- **Lifecycle:** `LessonStatus` DRAFT→READY→PUBLISHED, `SessionPublication.lessonId UNIQUE` idempotency, `computeLessonReadiness` pure, `transitionLesson` transactional conditional flip.
- **Media:** `MediaAsset` (EXTERNAL_URL/LOCAL_PRIVATE/S3 enum) + `SessionVideo` + `Material` + `QuizAttemptEvidence`; bytes under `MEDIA_STORAGE_PATH` random keys, served only via authorized routes (`/api/media/[id]`, `/api/materials/[id]`) with Range, disposition, `Cache-Control: private, no-store`.
- **Notifications:** `src/lib/session-notifications.ts` owns eligibility (`getEligibleSessionRecipients`), localized templates, chunked fan-out (500), dedupe `(type,link)`, counters `notifiedCount/notifiedAt`, audit `LESSON_PUBLICATION_NOTIFY`; bulk preference partition in `src/lib/notify.ts`.

### 2.3 Security Milestones

- **P1:** RBAC invariants, parent linking triple match.
- **P3:** `SECURITY_HASH_SECRET` fail-fast at build (`next.config.ts`) and runtime (`instrumentation.ts`), `src/lib/env.ts` rejects placeholders, proxy defense-in-depth.
- **P4:** `denyProgression()` uniform 404 vs 403+code, never status row; locked redaction.
- **P5:** Attempt freeze, server grading.
- **P8:** No answer key in draft, text-based grading.
- **P20:** 10-check contract matrix, IDOR non-oracle, rate limiting deterministic/bounded/observable/race-free, CSP (`script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'`, `frame-src https: youtube/vimeo`, `media-src 'self' blob: https:`, `object-src 'none'`, `frame-ancestors 'self'`), legacy fallback removal, media Range hardening.
- **P20 Addendum:** Teacher lifecycle privilege-safe, token SHA-256 single-use expiring, no auto-login, no password in response, idempotent approval.
- **Gate:** F-01 seeder credential contract (`SEED_ADMIN_PASSWORD`/`SEED_DEMO_PASSWORD` env, random fallback in dev, refuse in prod), F-02 login dual-bucket throttling (`login:id` 10/15min/10min block cleared on success + `login:ip` 40/10min/15min block), F-03 study-plan ownership via `updateMany`, F-04 enroll course/group binding, F-05 HSTS `max-age=15552000; includeSubDomains`, F-06 leaderboard scoped to own course capped 200, F-07 `clientIpFromHeaders` preferring `X-Real-IP`, F-09 8-char floor everywhere.

### 2.4 Database / Production-Safety Milestones

- **Base:** `prisma/schema.prisma` provider `sqlite`, `db/custom.db` gitignored, migrations `20260904090608_add_student_identity_fields` through `20260912000000_phase20_teacher_applications` (9 migrations).
- **P11:** Reconciler idempotent, archive sweep `updateMany` (no deletes), second run zero writes.
- **P12:** Normalisation before DDL (alias mapping → NULL never guess), backfill `trackScope DEFAULT 'SHARED'`, `Student.schoolType` free String → enum nullable.
- **P13:** `status` column `TEXT NOT NULL DEFAULT 'DRAFT'`, guarded backfill `WHERE status='DRAFT' AND isPublished=1` replay-safe, no backfilled `SessionPublication` (audit honesty).
- **P21:** ONE source + derived artifacts, drift check `make-postgres-schema.mjs --check`, loader one transaction fail-closed, verification battery 19 checks + 7 app-shaped queries, backup `pg_dump --format=custom` + `.sha256` + manifest + retention 30d keep-7, restore enforces empty target + battery, media migration SHA-256 per file never deletes source, evidence purge dry-run default `--live --yes`, protected tables count-asserted unchanged, volume quota off by default (unlimited) 413 when set.
- **P22:** Baseline `2 ADMIN (mudiifathii@gmail.com, abdelrahmanmohamedhafez7@gmail.com) + 1 TEACHER (muhammedfathi2005@gmail.com) + 0 STUDENT/PARENT`, official curriculum 2 Parts/7 Units/23 Lessons, subscription plans, settings, security infrastructure, audit, media preservation, FK integrity.

### 2.5 Deployment-Relevant Historical Decisions (classification)

| Decision | Classification | Rationale |
|----------|---------------|-----------|
| SQLite file `db/custom.db` | **CAN CHANGE FOR VERCEL** (BLOCKER) | Must become PostgreSQL; Phase 21 already proves loader + battery; SQLite's `PRAGMA foreign_keys` off by default historically allowed orphans — PG enforces FKs always |
| `UserSession` SHA-256 token hash UNIQUE, `PasswordResetToken` hash UNIQUE single-use, `TeacherActivationToken` hash UNIQUE guarded consume | **MUST PRESERVE** | Security invariants, portable Prisma calls, no raw token storage |
| `SecurityRateLimit` UNIQUE(bucket, identifier) + guarded `upsert(update:{})` + `updateMany WHERE count<limit` | **MUST PRESERVE** | Deterministic, multi-process safe, works serverless |
| `SECURITY_HASH_SECRET` required 32+ chars, no placeholder, fail-fast build+runtime | **MUST PRESERVE** | Keys IP/device hashes; Vercel env var |
| `src/proxy.ts` cookie-presence 401 for `/api/*` | **CAN CHANGE FOR VERCEL** | Defense-in-depth still valid on Vercel Edge; keep, but Vercel already has its own edge; no DB access so compatible |
| `MEDIA_STORAGE_PATH` local filesystem + `writePrivateFile`/`readPrivateFile` | **CAN CHANGE FOR VERCEL** (BLOCKER) | Must become object storage; enum `S3` exists but no client; need adapter |
| `MediaAsset` abstraction (EXTERNAL_URL/LOCAL_PRIVATE/S3) | **MUST PRESERVE** | Already separates storage location from authz; just need new backend behind same contract |
| `SessionPublication.lessonId UNIQUE` idempotency | **MUST PRESERVE** | Prevents double publish/notify; DB-level |
| `Lesson.isPublished` default true kept for compat, `status` is source of truth | **MUST PRESERVE** | Changing default without rebuild causes SQLite `db push` drift trap (documented in P13) |
| `Track`/`Enrollment`/`Course.trackId` dead schema kept not dropped | **MUST PRESERVE** | Destructive DROP buys nothing; declared dead in `docs/PHASE_12_TRACK_ARCHITECTURE.md` |
| `Caddyfile` `:81` with `X-Real-IP` overwrite + reverse proxy to `:3000` | **OBSOLETE for Vercel** | Vercel handles TLS, HTTPS redirect, `X-Real-IP`/`X-Forwarded-For`; headers move to `next.config.ts` + Vercel config |
| `output: "standalone"` + `scripts/start-production.mjs` + `copy-standalone-assets.mjs` | **CAN CHANGE FOR VERCEL** | Standalone is VPS-specific; Vercel ignores `output` and uses its own build; start script not used on Vercel; harmless to keep |
| `nodemailer` Gmail SMTP | **CAN CHANGE FOR VERCEL** but compatible | Works serverless; alternative Resend free tier also works; keep `mailer.ts` abstraction |
| `QUIZ_EVIDENCE_RETENTION_DAYS` + `retainUntil` stamped but never purged before P21 | **NEEDS RE-VALIDATION** | P21 adds purge script; on Vercel must become Cron route |
| `MEDIA_QUOTA_BYTES` off by default (unlimited) | **MUST PRESERVE** | Additive-reject, fail-closed 413 before write, wiring in 3 upload paths (`src/lib/session-materials.ts` + `session-videos` + `quiz evidence`) |
| Seeder hardcoded passwords | **OBSOLETE** (fixed in Gate) | Now env-based random, refuse in prod — must preserve new contract |
| `z-ai-web-dev-sdk` | **NEEDS RE-VALIDATION** | Sandbox auto-configured; production needs real credentials; Kodgy itself is scripted and has no dependency, but `ai-generate-quiz` route uses LLM — verify provider limits |

**Inconsistencies found:**

- `docs/DATABASE_GUIDE.md` (old) still describes 36 models while current `schema.prisma` has 55 models (see `grep ^model` count 55). Current implementation is source of truth — doc is stale but not harmful.
- `docs/ARCHITECTURE.md` describes sessions persisted in `Setting` table (legacy), while current `src/lib/auth.ts` uses `UserSession` table (Phase 20 removed fallback). Implementation is correct; doc is obsolete.
- `docs/DEPLOYMENT_GUIDE.md` Option A says Vercel build command `bun run build` — current `package.json` build is `prisma generate && next build && copy-...` which requires network for `prisma generate`. Vercel has network, so it will succeed, but `bun.lock` vs `package-lock.json` dual presence may cause Vercel to pick npm by default — needs explicit package manager config.

---

## 3. Current Architecture

### 3.1 Repository Map (actual inspected)

```
package.json: name nextjs_tailwind_shadcn_ts, version 0.2.1, Next 16.3.4, React 19, Prisma 6.11.1, pg 8.23.0, @electric-sql/pglite 0.5.8 (dev), nodemailer 9.1.1, sharp 0.35.4
prisma/schema.prisma: datasource sqlite, 55 models, 21 enums, 73 FKs, 34 UNIQUEs, 67 indexes (see §2.5)
prisma/migrations: 9 migrations (20260904…20260912)
prisma/schema.postgresql.prisma: DERIVED, provider postgresql, byte-identical models (Phase 21)
src/app/api: 98 route handlers (admin/*, auth/*, teacher/*, students/me/*, parents/me/*, courses, lessons, quizzes, media, materials, etc.)
src/lib: 30 modules (auth, db, security, rate-limit, env, media, storage-quotas, evidence-retention, session-progress, session-quiz, session-lifecycle, session-materials, session-notifications, track-scope, parent-access, enrollment, teacher-applications, notify, delivery, mailer, etc.)
src/proxy.ts: defense-in-depth cookie-presence 401, matcher /api/:path*
src/instrumentation.ts: production fail-fast via env.ts, NEXT_RUNTIME nodejs guard, globalThis.process.exit indirection for Edge bundle
next.config.ts: output standalone, poweredByHeader false, securityHeaders() = X-Frame-Options SAMEORIGIN, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy camera=(self), HSTS max-age=15552000 includeSubDomains (unless HSTS_DISABLED=1), CSP via decideCspHeader() (report-only toggle CSP_REPORT_ONLY=1, kill CSP_DISABLED=1)
Caddyfile: :81 listener with XTransformPort query → localhost:{port}, default → localhost:3000, header_up X-Real-IP {remote_host} (overwrites client value)
scripts/db: make-postgres-schema.mjs, postgres-baseline.sql (143 statements: 21 CREATE TYPE + 55 CREATE TABLE + 67 CREATE INDEX), migrate-sqlite-to-postgres.mjs, verify-postgres.mjs, pg-lib.mjs, backup-postgres.sh, restore-postgres.sh
scripts/media: migrate-media.mjs, purge-expired-evidence.ts
scripts/start-production.mjs: portable launcher (node/bun), sets NODE_ENV=production, tees to server.log, forwards SIGINT/SIGTERM
.env.example: DATABASE_URL file, NEXT_PUBLIC_URL, SECURITY_HASH_SECRET, MEDIA_STORAGE_PATH, MEDIA_MAX_*_BYTES, QUIZ_EVIDENCE_RETENTION_DAYS, PASSWORD_RESET_TTL_MINUTES, SEED_*_PASSWORD, TEACHER_ACTIVATION_TTL_HOURS, RATE_LIMIT_*, CSP_*, HSTS_DISABLED, SMTP_*, EMAIL_*, DELIVERY_DEV_LOG, MEDIA_QUOTA_BYTES, BACKUP_PASSPHRASE
```

### 3.2 Build & Runtime (actual commands)

```json
// package.json scripts
"dev": "next dev -p 3000",
"build": "prisma generate && next build && node scripts/copy-standalone-assets.mjs",
"start": "bun scripts/start-production.mjs",
"lint": "eslint .",
"typecheck": "tsc --noEmit",
"db:push": "prisma db push --accept-data-loss",
"db:generate": "prisma generate",
"db:migrate": "prisma migrate dev",
"db:reset": "prisma migrate reset"
```

- **Next.js version:** 16.3.4 (`next` dep)
- **React version:** 19.0.0
- **Node runtime requirements:** Node 22+ recommended (per `GO_LIVE_RUNBOOK.md` preflight), Next 16 requires Node >=18.17; Prisma 6.11 requires Node >=18.
- **Bun usage:** `bun.lock` present (221769 lines), `package-lock.json` also present (446409). `start` uses `bun`; build uses `prisma generate` (needs network) + `next build`. Vercel can use Bun if `packageManager` field or `bun.lockb` detected — currently `bun.lock` (text) is new Bun format, but Vercel's detection may prefer npm when both locks exist. Must be configured explicitly.
- **Prisma generation during build:** YES, `prisma generate` is first step of `build`. On Vercel with network, it will succeed (unlike offline sandbox where `binaries.prisma.sh` unreachable). However P22 reports 13 errors from missing client in sandbox + 15 strict errors that remain even after generate — those 15 must be fixed before Vercel build passes typecheck (Vercel runs `next build` which typechecks).
- **Production startup assumes persistent Node server:** YES — `start-production.mjs` spawns `.next/standalone/server.js` and tails `server.log`. On Vercel, this is irrelevant; Vercel serves via serverless functions, not a long-running server. The standalone output is ignored by Vercel.

### 3.3 Database / Schema (current)

- **Datasource:** `sqlite`, `env("DATABASE_URL")`, file `./db/custom.db` (gitignored)
- **Models:** 55 (see `grep ^model` list in §2.5)
- **Enums:** 21 (see list)
- **Migrations:** 9, all additive, SQLite-safe (`ADD COLUMN`, `IF NOT EXISTS`), no DROP/DELETE of user data, P5 dedup keeps `MAX(rowid)` per pair
- **SQLite-specific assumptions found:**
  - No raw SQL in `src/` (zero `$queryRaw`/`$executeRaw`) — verified by `tests/production-storage-phase21.test.js` §3 — so provider switch changes no application query (FACT)
  - JSON opaque String (Question.options, etc.) — never filtered in SQL, stays TEXT on PG (no JSONB)
  - `cuid()` client-generated, `@updatedAt` client-managed
  - `NULL` in UNIQUE distinct on both SQLite and PG (same semantics)
  - `PRAGMA foreign_keys` historically off allowed orphans; PG enforces always — migration to PG may surface latent orphans (needs pre-migration `PRAGMA foreign_key_check`)
  - `Lesson.isPublished` default true kept inert for DDL reasons (P13 doc §isPublished)
  - `onDelete: SetNull` on `Lesson.unit/topic` orphans lessons on delete — 17 orphans noted in PROJECT_STATE

### 3.4 Security Model (actual implementation)

- **Password hashing:** `scryptSync` 16-byte salt, 64-byte hash, `salt:hash`, `timingSafeEqual` (`src/lib/auth.ts:hashPassword`, `verifyPassword`)
- **Sessions:** `UserSession` table, `tokenHash` SHA-256 UNIQUE, `deviceHash` from UA family + OS family + `sec-ch-ua-mobile/platform` hashed with `SECURITY_HASH_SECRET`, `ipHash` hashed with secret, `expiresAt` 7d, `lastSeenAt` throttled 1min, `revokedAt`/`revokedReason`; cookie `cm_session` httpOnly sameSite lax secure in prod path `/`
- **Single-device:** live sessions filtered `revokedAt null && expiresAt > now`, conflicting = different `deviceHash` && `now - lastSeenAt < 30min` → revoke all + suspend account `SUSPENDED_MULTI_DEVICE` + `isActive false` + audit `ACCOUNT_SUSPENDED_MULTI_DEVICE`
- **Account activation:** `User.isActive` bool + `status` enum `ACTIVE/INACTIVE/SUSPENDED_MULTI_DEVICE`
- **Teacher lifecycle:** `TeacherApplication` email UNIQUE, `userId UNIQUE NULLABLE` set only at activation, `status` PENDING default, `reviewedByUserId/reviewedAt`; `TeacherActivationToken` `tokenHash UNIQUE`, `expiresAt` from `TEACHER_ACTIVATION_TTL_HOURS` default 72h, `usedAt` stamped guarded `updateMany` inside `$transaction` with User+Teacher+ACTIVATED writes
- **Password reset:** `PasswordResetToken` hash UNIQUE single-use, TTL `PASSWORD_RESET_TTL_MINUTES` default 15min, `attemptCount` 5, requesting new invalidates previous unused
- **Rate limiting:** `SecurityRateLimit` UNIQUE(bucket, identifier), `checkRateLimit` in `security.ts` = idempotent `upsert(update:{})` + guarded window reset `updateMany WHERE windowStart <= cutoff` + guarded claim `updateMany WHERE count<limit`; policy in `rate-limit.ts` 7 keys (heartbeat 300/60/60, progress 120/60/60, open 20/60/300, notification 30/60/300, materialDownload 120/60/60, pdfUpload 30/60/300, teacherApply 5/3600/3600) with env overrides `RATE_LIMIT_*` clamped, never disableable; identifiers hashed `SHA-256("rl:<key>:<userId>")` no raw PII; 429 carries `Retry-After` + `X-RateLimit-Limit/Remaining` + body `code: RATE_LIMITED` + audit `SecurityEvent RATE_LIMITED`
- **Login throttling (Gate):** dual bucket `login:id` hashed email 10/15min/10min block cleared on success + `login:ip` hashed IP 40/10min/15min block; same 429 shape; `LOGIN_FAILED` audit
- **Audit:** `SecurityEvent` append-only, `ipHash` hashed, `userAgent` truncated 300, `type` enum including `TEACHER_APPLICATION_*`, `TEACHER_ACTIVATION_*`, `RATE_LIMITED`, `MATERIAL_ACCESSED`, `QUIZ_EVIDENCE_ACCESSED`, etc.; `AuditLog` for lifecycle events
- **Cookies:** `httpOnly`, `sameSite: "lax"`, `secure` when `NODE_ENV=production`, `path: "/"`
- **Headers:** `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()`, `Strict-Transport-Security: max-age=15552000; includeSubDomains` (unless `HSTS_DISABLED=1`), CSP via `content-security-policy.ts` (no `unsafe-eval` in prod, `unsafe-inline` for script/style required by Next.js RSC bootstrap + framer-motion/recharts inline styles, `frame-src 'self' https: youtube/nocookie/vimeo`, `media-src 'self' blob: data: https:`, `connect-src 'self'`, `worker-src 'self' blob:`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`, operator toggles `CSP_REPORT_ONLY=1` → report-only, `CSP_DISABLED=1` → remove)
- **Origin/CSRF:** No explicit Origin check; mitigated by `SameSite=Lax` (cross-site POST no cookie) + JSON-only mutations (HTML form cannot produce JSON) + CORS preflight; proven with `tough-cookie` v6 + real `Set-Cookie` from compiled login handler (Gate §31)
- **Protected resources:** `/api/media/[id]` and `/api/materials/[id]` re-authorize every request (batch+track+published+progress), Range strict regex-anchored → 416, `Accept-Ranges: bytes`, `Content-Disposition`, `Cache-Control: private, no-store`; quiz evidence ADMIN-only
- **Secret handling:** `.env` gitignored, `git ls-files` shows no `.env*` tracked except `.env.example`; `env.ts` fails closed on missing/short/placeholder `SECURITY_HASH_SECRET`; tokens hashed before DB/event; SMTP password redacted via `sanitizeError`; URLs redacted in tool outputs

### 3.5 Runtime / Storage / Email / Jobs

- **Media:** `MEDIA_ROOT` = `env.MEDIA_STORAGE_PATH || cwd/storage/media`; `MAX_*_BYTES` env; `isSafeExternalUrl` blocks localhost/0.0.0.0/.local/127./10./192.168./172.16-31; `makeStorageKey` random `<scope>/<timestamp>-<16bytes hex>.<ext>`; `resolveSafePath` defends traversal via `path.resolve` + prefix check; `writePrivateFile` mkdir recursive + writeFile; `readPrivateFile` readFile; `deletePrivateFile` unlink catch; `privateFileStat`; `sha256Buffer`/`sha256PrivateFile` streamed; `extFromMime` map
- **PDF validation (Phase 14):** MIME allow-list `application/pdf` only (strip params, lowercase), magic bytes `%PDF-` within first 1024 bytes, extension `.pdf` via `sanitizeOriginalFilename` (strips null bytes, C0 controls, path separators, leading dots, caps 200 chars), size cap `MAX_PDF_BYTES` 25MB default, no temp files, buffers validated before write
- **Storage quotas (Phase 21):** `src/lib/storage-quotas.ts` — `parseBytesEnv` handles `10GB`/`512 MB`/plain bytes, blank/0 = unlimited (0), garbage throws fail-closed; `resolveQuotaConfig` env `MEDIA_QUOTA_BYTES`; `checkQuota` pure; `getDirectoryBytes` iterative walk, skips symlinks, missing dir 0, no `du` shell-out; `assertVolumeQuota` zero I/O when unset (default path unchanged), 413 `QUOTA_EXCEEDED` before write when set, wired into 3 upload paths (`session-materials.ts` PDF materials incl. `QUOTA_EXCEEDED` result code → 413, `admin/session-videos` route, `quizzes/[id]/evidence` route)
- **Evidence retention (Phase 21):** `src/lib/evidence-retention.ts` rule `retainUntil NOT NULL AND <= now`, NULL/unparseable = keep forever, `QUIZ_EVIDENCE_RETENTION_DAYS` 1..3650 default 30; job `scripts/media/purge-expired-evidence.ts` dry-run by default (read-only handle/SELECTs on PG), deletion needs `--live --yes`, deletes evidence rows in one transaction, unreferenced LOCAL_PRIVATE assets delete row+bytes (bytes after commit, best-effort, next-run convergence), protected tables counts snapshot before/after FAIL on move (`SecurityEvent/AuditLog/TeacherApplication/TeacherActivationToken/UserSession/PasswordResetToken/SecurityRateLimit` + `QuizAttempt/Student/User`)
- **Email:** `src/lib/mailer.ts` only place touching SMTP creds, never imported from client, `isSmtpConfigured` checks 4 vars, `getSmtpConfig` reads `SMTP_HOST/PORT/USER/PASSWORD/EMAIL_FROM`, `getMailTransport` caches, `nodemailer.createTransport` host/port/secure/requireTLS/TLS min 1.2/timeouts 20s/20s/30s, `sanitizeError` redacts password+user, `sendMailViaSmtp` to/subject/text/html, `smtpDiagnostics` masked user, `verifySmtpConnection`; `src/lib/delivery.ts` `hasDeliveryProvider`, `sendTransactionalEmail`, `DELIVERY_DEV_LOG=1` redacted log only when not prod; password reset + teacher activation emails via this path
- **Jobs / Cron:** No `setInterval`, no `setTimeout` in server code except UI (`kodgy` typing timer, toast timeouts) — grep shows only those; no background workers, no in-memory queues, no child processes, no WebSockets, no filesystem watchers, no server-local caches (except mail transport cache + Prisma singleton); scheduled tasks are external scripts: `backup-postgres.sh` (cron), `purge-expired-evidence.ts` (cron), `migrate-media.mjs` (one-off), `phase22-final-integration.mjs` (one-off cleanup), `reconcile-curriculum.ts` (one-off/idempotent)
- **Sharp:** `sharp` dep 0.35.4 present, used for image? No direct usage found in src grep except dependency; likely for Next.js image optimization — Vercel supports sharp natively
- **AI:** `z-ai-web-dev-sdk` 0.0.18 — sandbox auto-configured; Kodgy is scripted no AI; `ai-generate-quiz` route uses LLM (takes ~30s, needs edge? long execution)

---

## 4. Vercel Compatibility Audit

### 4.1 Methodology

Searched entire `src/` for `SQLite`, persistent filesystem, process memory as durable state, long-running processes, background workers, local cron, WebSockets, stateful processes, in-memory queues, child processes, native binaries, persistent sockets, filesystem watchers, server-local caches, local uploaded files, large sync ops.

### 4.2 Findings

| Area | File / Symbol | Current Behavior | Why It Matters for Vercel | Classification | Recommended Alternative | Migration Impact | Security Impact | Cost Impact |
|------|---------------|------------------|---------------------------|----------------|------------------------|------------------|-----------------|-------------|
| **Database provider SQLite** | `prisma/schema.prisma:7 provider sqlite`, `DATABASE_URL=file:./db/custom.db`, `src/lib/db.ts` singleton | File-based, local disk, `PRAGMA foreign_keys` off by default historically | Vercel functions have ephemeral filesystem — writes disappear after invocation, no persistence across instances | **BLOCKER** | PostgreSQL (Neon/Supabase/Vercel Postgres) via `schema.postgresql.prisma`, `DATABASE_URL=postgresql://...` | Requires provider change, loader `migrate-sqlite-to-postgres.mjs`, ledger baseline `prisma migrate resolve --applied`, connection pooling config | FKs now always enforced (good), but latent orphans may surface — must `PRAGMA foreign_key_check` before migration | Free tier DB — VERIFY CURRENT PROVIDER LIMIT for storage/connection limits |
| **Local filesystem media** | `src/lib/media.ts:19 MEDIA_ROOT`, `writePrivateFile:258 mkdir+writeFile`, `readPrivateFile:263`, `deletePrivateFile:268`, `privateFileStat:272`, `storage-quotas.ts:128 readdir+stat` | Bytes written outside web root under random keys, only via authorized routes | Ephemeral FS — uploaded PDFs/videos/evidence lost after deploy or scale | **BLOCKER** | S3-compatible object storage: Vercel Blob, Cloudflare R2, AWS S3, Supabase Storage — implement adapter behind `MediaAsset` contract, keep `storageKey` as object key, `readPrivateFile` → signed URL or stream | Need new client (`@aws-sdk/client-s3` or `@vercel/blob`), migration `migrate-media.mjs` adapted to upload to bucket, SHA-256 verification | Must preserve authorized-route re-check, signed URLs short-lived, no public bucket, `Cache-Control: private, no-store` | R2 free egress, Blob Hobby free — VERIFY CURRENT PROVIDER LIMIT for bandwidth/storage |
| **Filesystem quota walk** | `src/lib/storage-quotas.ts:128 getDirectoryBytes` | Walks `MEDIA_ROOT` to sum file sizes | On object storage, cannot walk local FS; need bucket size API or counter in DB | **REQUIRES ARCHITECTURAL CHANGE** | Keep per-file caps, replace volume quota with bucket quota via provider metrics or DB counter (`MediaAsset.sizeBytes` sum) | Add `sizeBytes` column or use provider API; `assertVolumeQuota` becomes `assertBucketQuota` | Same fail-closed 413 | No extra cost |
| **Evidence purge cron** | `scripts/media/purge-expired-evidence.ts`, `src/lib/evidence-retention.ts` | CLI script, dry-run default, `--live --yes` deletes, meant for cron/systemd | No persistent cron on Vercel Hobby without Vercel Cron | **COMPATIBLE WITH CONFIGURATION** | Expose as `POST /api/cron/purge-evidence` protected by `CRON_SECRET`, triggered by Vercel Cron (Hobby 2 jobs) or external cron (GitHub Actions, Upstash QStash) | Add route, idempotent, metrics JSON | Must not allow anon trigger; protected tables count-asserted unchanged already | Free |
| **Backup cron** | `scripts/db/backup-postgres.sh` | Shell script `pg_dump --format=custom` + sha256 + manifest + retention | No shell access on Vercel; pg_dump needs `postgresql-client` binary | **REQUIRES ARCHITECTURAL CHANGE** | Use managed DB's built-in backups (Neon PITR, Supabase daily) + optional external backup worker (GitHub Action with pg_dump) | No code change if provider backup sufficient; else external | Credentials redacted already | Free provider backups — VERIFY |
| **Long-running AI quiz generation** | `src/app/api/admin/ai-generate-quiz/route.ts:8,15` (imports Prisma) — takes ~30s per doc | LLM call ~30s, admin UI loading state | Vercel Hobby function max duration 10s (Pro 60s, Enterprise 900s) — VERIFY CURRENT PROVIDER LIMIT | **REQUIRES ARCHITECTURAL CHANGE** | Move to Vercel Pro (60s) or background job (Upstash QStash + callback), or stream response, or increase timeout via `maxDuration` export (Next 13.4+) | Add `export const maxDuration = 60` in route, or refactor to async job | No security regression | May need Pro for 30s — cost |
| **Sharp / image optimization** | `sharp` 0.35.4 dep | Used by Next.js image optimization | Vercel supports sharp natively, no extra config | **COMPATIBLE** | None | None | None | Free |
| **@sparticuz/chromium** | `package.json` dep `@sparticuz/chromium 149.0.0` | Likely for PDF? Not used in src grep except dep | Chromium binary large (~100MB), may exceed Vercel function size limit (50MB uncompressed) | **REQUIRES ARCHITECTURAL CHANGE** | Remove if unused, or use Vercel's `puppeteer-core` + `@sparticuz/chromium` with `excludeFiles` or move to external service | Check usage: grep found no import in src — may be unused or used in `z-ai-web-dev-sdk`? If unused, remove; else keep but verify size | No security | Size limit |
| **Process memory as durable state** | `src/lib/db.ts` globalForPrisma singleton | Singleton prevents multiple clients in dev HMR | On serverless, globalThis persists across warm invocations but not durable — okay because DB is external PG, not memory | **COMPATIBLE** | None | None | None | Free |
| **In-memory rate limit** | None — DB-backed `SecurityRateLimit` | Counter in DB, not memory, multi-process safe | Works on Vercel serverless (shared DB) | **COMPATIBLE** | None | None | Preserves determinism | Free but adds DB writes per request |
| **Session persistence** | `UserSession` table, SHA-256 hash, no JWT | Session lookup per request via `findUnique` on `tokenHash` | Works serverless, but adds DB read per request; needs connection pooling | **COMPATIBLE WITH CONFIGURATION** | Configure `connection_limit` for PG (Neon recommends 10-20 for serverless), use Prisma Accelerate or PgBouncer if needed | Add `?connection_limit=10` to DATABASE_URL | No PII leak | Free |
| **Secure cookies** | `src/lib/auth.ts:125 secure: NODE_ENV=production` | httpOnly, sameSite lax, secure in prod, path `/` | Vercel is HTTPS, secure flag correct | **COMPATIBLE** | None | None | Preserves | Free |
| **Caddy X-Real-IP** | `Caddyfile: header_up X-Real-IP {remote_host}` + `src/lib/security.ts:clientIpFromHeaders` prefers X-Real-IP | Trusts proxy-set header, falls back to first XFF | On Vercel, `X-Real-IP` not set by Vercel; Vercel sets `X-Forwarded-For` + `X-Real-IP`? Actually Vercel sets `X-Forwarded-For` and `X-Vercel-Forwarded-For` — VERIFY CURRENT PROVIDER LIMIT. Current code prefers X-Real-IP, which may be absent on Vercel, falling back to XFF (spoofable) | **COMPATIBLE WITH CONFIGURATION** | Update `clientIpFromHeaders` to also trust `X-Vercel-Forwarded-For` or `X-Forwarded-For` first hop when behind Vercel's trusted proxy; document trust boundary | Small code change | IP buckets are abuse throttles only, not authz, so acceptable | Free |
| **Build command** | `package.json: build = prisma generate && next build && copy-standalone-assets` | Generates client then builds | Vercel runs `npm run build` or `vercel build`; `prisma generate` needs network (Vercel has network) — will succeed unlike offline sandbox | **COMPATIBLE WITH CONFIGURATION** | Vercel should run `prisma generate` via build command; `copy-standalone-assets` copies to `.next/standalone` which Vercel ignores but harmless; set `SKIP_PRODUCTION_ENV_CHECK=1` during build if secrets not available at build time, runtime still enforces | Configure env vars in Vercel dashboard; ensure `DATABASE_URL` set at build time or use `SKIP_PRODUCTION_ENV_CHECK` | Build-time secret check currently requires `SECURITY_HASH_SECRET` — must be set or skipped via env var | Free |
| **Standalone output** | `next.config.ts: output standalone` | Produces `.next/standalone/server.js` for VPS | Vercel ignores `output` and uses its own output; not harmful but unnecessary | **COMPATIBLE** | Keep or set `output` only when not on Vercel via env check; or leave as is | None | None | Free |
| **Bun vs npm** | Both `bun.lock` and `package-lock.json` present | Dual lockfiles | Vercel auto-detects package manager; with both present may pick npm (alphabetical or via `packageManager` field) — need explicit | **COMPATIBLE WITH CONFIGURATION** | Add `"packageManager": "bun@1.3.4"` to `package.json` or delete `package-lock.json` if Bun is canonical; Vercel supports Bun | Small config | None | Free |
| **Node version** | `GO_LIVE_RUNBOOK.md` says Node 22+ | Next 16 requires >=18.17 | Vercel Node 22 available via `engines` or dashboard | **COMPATIBLE** | Set `engines.node = 22.x` or Vercel project setting | None | None | Free |
| **Nodemailer / SMTP** | `src/lib/mailer.ts` uses `nodemailer` with STARTTLS 587, timeouts 20s/20s/30s | Sends via Gmail SMTP | Works serverless (outbound TCP allowed on Vercel) but Gmail may block Vercel IPs? Resend API is more reliable serverless | **COMPATIBLE WITH CONFIGURATION** | Keep Gmail or switch to Resend (`resend` npm) for better deliverability on Vercel; `mailer.ts` abstraction makes switch easy | Env vars `SMTP_*` or `RESEND_API_KEY` | Must redact creds already done | Resend free 100 emails/day — VERIFY |
| **Instrumentation fail-fast** | `src/instrumentation.ts` checks `NEXT_RUNTIME !== nodejs` then `assertProductionEnv()` | Refuses to boot if `SECURITY_HASH_SECRET` missing | On Vercel serverless, `register()` runs on cold start; if secret missing, process exits — Vercel will surface 500, which is correct fail-closed | **COMPATIBLE** | None | None | Preserves | Free |
| **Large file upload (512MB video)** | `MEDIA_MAX_VIDEO_BYTES=512MB` | Rejects above limit before write | Vercel Hobby request body limit 4.5MB (Pro 4.5MB, Enterprise larger) — VERIFY CURRENT PROVIDER LIMIT — 512MB upload will fail on Vercel | **BLOCKER** | Must use direct-to-storage upload (presigned S3 URL) or Vercel Blob multipart, or reduce limit for Vercel path; client uploads directly to R2/Blob bypassing Vercel function | Architectural change: new endpoint returns presigned URL, client PUTs to storage, then callback creates `MediaAsset` row | Must validate MIME/magic server-side after upload (download and check) or via provider webhook | Cost: R2 free |
| **PDF 25MB** | `MEDIA_MAX_PDF_BYTES=25MB` | Similar | Also exceeds 4.5MB limit — needs presigned upload | **BLOCKER** (same) | Same as video | Same | Same | Same |
| **Image 5MB** | `MEDIA_MAX_IMAGE_BYTES=5MB` | Slightly above 4.5MB | At limit — may need presigned or reduce to 4MB | **REQUIRES ARCHITECTURAL CHANGE** | Same | Same | Same | Same |
| **WebSockets / mini-services** | `Caddyfile` `XTransformPort` pattern, `mini-services/.gitkeep` empty | Optional sidecars via query param | Vercel does not support raw TCP sidecars on same host; `XTransformPort` pattern is Caddy-specific | **OBSOLETE** | Remove or move mini-services to separate Vercel projects or external | None if unused | None | Free |
| **Child processes** | `scripts/start-production.mjs` uses `spawn` | Launcher only, not used in request path | Not used on Vercel | **COMPATIBLE** | None | None | None | Free |

### 4.3 Summary Table

| Classification | Count | Examples |
|----------------|-------|----------|
| **COMPATIBLE** | 6 | Sharp, Prisma singleton, rate limit DB-backed, instrumentation fail-fast, standalone output, child process launcher |
| **COMPATIBLE WITH CONFIGURATION** | 8 | Evidence purge cron, backup via provider, X-Real-IP handling, build command, Bun vs npm, Node version, SMTP, session persistence |
| **REQUIRES ARCHITECTURAL CHANGE** | 6 | Quota walk, AI quiz 30s, @sparticuz/chromium size, large file upload 512MB/25MB/5MB, backup shell, X-Real-IP on Vercel |
| **BLOCKER** | 4 | SQLite, local filesystem media, large video upload, large PDF upload |
| **OBSOLETE** | 2 | Caddyfile, XTransformPort mini-services |

---

## 5. Recommended Free-Tier Architecture

### 5.1 Primary Recommendation (reliability > security > compatibility > cost > simplicity > scalability)

| Component | Primary Recommendation | Fallback | Purpose | Why Fits CodeMind | Migration Complexity | Integration Complexity | Free-Tier Suitability | Security Implications | Limitations | Required? |
|-----------|------------------------|----------|---------|-------------------|----------------------|------------------------|-----------------------|-----------------------|-------------|-----------|
| **Hosting** | **Vercel Hobby** | Cloudflare Pages (Next.js via OpenNext) or Netlify | Next.js 16 frontend + API routes serverless | First-class Next.js citizen, auto HTTPS, preview deploys, built-in Cron (2 jobs Hobby), zero-config | Low (git push) | Low | Hobby free: 100GB bandwidth, 1000 GB-hours, 10s function duration — VERIFY CURRENT PROVIDER LIMIT | Preserves CSP/HSTS via `next.config.ts`; secure cookies; env secrets via Vercel dashboard | 4.5MB body limit, 10s duration limit on Hobby — needs presigned uploads and maybe Pro for AI quiz | REQUIRED |
| **PostgreSQL** | **Neon Free** (serverless Postgres, autosuspend, 0.5GB storage, 3GB data transfer) | Supabase Free (500MB DB, 2GB bandwidth) or Vercel Postgres (Hobby 256MB) or Railway Free | Replace SQLite with durable relational DB, 55 models, 21 enums, FKs | Phase 21 already proves PG compatibility: no raw SQL, JSON as TEXT, cuid() preserved, DateTime TIMESTAMPTZ, NULL-in-UNIQUE same, loader + battery | Medium (loader + verification) | Low (provider swap + DATABASE_URL) | Neon free generous for MVP — VERIFY CURRENT PROVIDER LIMIT for connection limits (Neon 100 concurrent) | FKs always enforced, audit tables preserved, token hashes UNIQUE enforced | Connection pooling needed for serverless (Neon has built-in pooling via `?pgbouncer=true` or Prisma Accelerate) | REQUIRED |
| **Object Storage** | **Cloudflare R2 Free** (10GB storage, 10M Class A, 10M Class B, free egress) | Vercel Blob Hobby (free tier) or Supabase Storage Free (1GB) or AWS S3 Free (5GB 12mo) | Private PDFs, session videos, quiz evidence — replace local FS | `MediaAsset` already abstraction with `storageKey` random; `MediaStorage` enum has `S3` reserved; authorized routes re-check role; `sha256PrivateFile` can become `sha256` of stream | Medium (implement S3 client, presigned URLs, migration) | Medium (adapter + presigned upload flow) | R2 free egress is key for video bandwidth — VERIFY CURRENT PROVIDER LIMIT | Bucket private, signed URLs short-lived (e.g. 15min), `Cache-Control: private, no-store`, no public list | Need to implement magic-byte validation after direct upload (download and check) | REQUIRED |
| **Email** | **Resend Free** (100 emails/day, 3000/month) — API-based, better deliverability serverless | Gmail SMTP via `nodemailer` (existing) or SendGrid Free (100/day) | Password reset (15min TTL), teacher activation (72h TTL), notifications | `mailer.ts` only place touching creds, abstraction already; `delivery.ts` has `hasDeliveryProvider` check; SMTP timeouts 20s/20s/30s compatible | Low (swap transport) | Low (env vars) | Resend free sufficient for MVP (2 ADMIN +1 TEACHER + few students) — VERIFY | Must redact creds (already), token never logged, masked destination only, TLS 1.2+ | Gmail may block Vercel IPs; Resend API more reliable | REQUIRED for prod (SMTP must be configured or flow cannot be completed by real person) |
| **Cron / Scheduling** | **Vercel Cron** (Hobby 2 cron jobs) | GitHub Actions Cron (free 2000 min/month) or Upstash QStash Free (500 messages/day) | Nightly evidence purge (`purge-expired-evidence.ts`), optional backup trigger, notification cleanup | Evidence purge is idempotent, dry-run default, protected tables count-asserted; no persistent worker needed | Low (expose as `/api/cron/*` with `CRON_SECRET`) | Low | Hobby 2 jobs enough for purge + maybe health check — VERIFY CURRENT PROVIDER LIMIT for cron interval (min 1h on Hobby?) | Must protect with `CRON_SECRET` env, not allow anon; audit via `SecurityEvent` | No shell `pg_dump` on Vercel — use provider backups | OPTIONAL initially, REQUIRED for retention compliance |
| **Monitoring** | **Vercel Built-in Logs + Analytics** (free) | Sentry Free (5k errors/month) or Logtail/Better Stack Free | Error logging, slow query visibility, DB health, media health, notification metrics | `src/lib/db.ts` logs `['error','warn']` in prod; `server.log` becomes Vercel logs; health `GET /api/` | Low | Low | Free tier sufficient for MVP | No PII in logs (already) | No custom dashboards initially | OPTIONAL |
| **DNS** | **Vercel DNS** (free with domain) or **Cloudflare Free** | Namecheap/GoDaddy free DNS | Custom domain `codemind.academy`, HTTPS auto | Vercel auto-provisions Let's Encrypt, auto-renew, HTTP→HTTPS redirect | Low | Low | Free | HSTS via `next.config.ts` + Vercel; `preload` omitted deliberately | None | REQUIRED for custom domain |

**Diagram — Target $0/month:**

```
Browser (RTL Arabic, Cairo font)
  │
  ├─► Vercel Edge Network (HTTPS auto, CDN static, HSTS, CSP headers from next.config.ts)
  │     │
  │     ├─► Next.js 16 Serverless Functions (Node 22, Prisma Client)
  │     │     ├─► Neon Free PostgreSQL (55 models, 21 enums, FKs, UNIQUEs)
  │     │     │     └─► Built-in PITR + daily backups (provider)
  │     │     ├─► Cloudflare R2 Private Bucket (MediaAsset storageKey → object key)
  │     │     │     └─► Presigned PUT for upload (bypass 4.5MB limit) + presigned GET for download (15min) via authorized routes
  │     │     ├─► Resend Free API (password reset, teacher activation)
  │     │     └─► Vercel Cron → /api/cron/purge-evidence (CRON_SECRET)
  │     │
  │     └─► Vercel Blob or R2 for static assets (public/logo.svg etc. already in /public)
  │
  └─► DNS: Vercel or Cloudflare Free → codemind.academy
```

---

## 6. SQLite → PostgreSQL

### 6.1 Schema

**Current:** `prisma/schema.prisma` provider `sqlite`, url `env("DATABASE_URL")`

**Target:** `prisma/schema.postgresql.prisma` provider `postgresql`, url `env("DATABASE_URL")` — DERIVED ARTIFACT, byte-identical models, only provider swapped + header. Regenerate via `node scripts/db/make-postgres-schema.mjs`, verify via `--check` (fails if committed artifact differs from current schema).

**SQLite-specific behavior to handle:**

| Aspect | SQLite Behavior | PostgreSQL Behavior | Action | Evidence |
|--------|-----------------|---------------------|--------|----------|
| **Types** | String→TEXT, Int→INTEGER, Boolean→INTEGER 0/1, DateTime→TEXT ISO or INTEGER ms | String→TEXT, Int→INTEGER, Boolean→BOOLEAN, DateTime→TIMESTAMPTZ(3) | `pg-lib.mjs` maps: String→TEXT, Int→INTEGER, Float→DOUBLE PRECISION, Boolean→BOOLEAN, DateTime→TIMESTAMPTZ(3), enums→native CREATE TYPE ENUM | `scripts/db/pg-lib.mjs`, `postgres-baseline.sql` 143 statements |
| **Defaults** | `now()` → `datetime('now')`, `cuid()` client, `@updatedAt` client | `now()`→`CURRENT_TIMESTAMP`, `cuid()` client, `@updatedAt` client | No DB default for cuid/updatedAt — identical | `schema.prisma` comments, `pg-lib` |
| **Indexes** | `@@index` → SQLite index, no name length limit | `CREATE INDEX` with deterministic name ≤63 bytes | Names truncated/hashed if needed — `pg-lib.emitPostgresDdl` | `postgres-baseline.sql` |
| **Unique constraints** | `NULL` distinct (SQLite and PG agree) | Same | No change needed; duplicate scan finds 0 groups on both sides | Phase 21 doc §3, drill |
| **Enums** | Stored as TEXT, no CHECK constraint | Native `CREATE TYPE ENUM` + CHECK | Normalisation UPDATEs before DDL (alias mapping → NULL never guess) — `20260909120000_phase12_track_architecture` | Phase 12 report |
| **Relations** | `ON DELETE` declared honored, 9 edges without become NO ACTION | Same, but `ON UPDATE CASCADE` emitted on every FK for Prisma diff cleanliness | `pg-lib` emits `ON UPDATE CASCADE` | Phase 21 doc §3 |
| **Date/Time** | Connector-managed UTC, but repo adapter tolerates TEXT-ISO, naive `YYYY-MM-DD HH:MM:SS`, INTEGER ms | TIMESTAMPTZ | Migrator tolerant UTC parsing of all three encodings | `pg-lib.mjs` value mapper |
| **Transactions** | `db.$transaction` works | Same, provider-agnostic | No change | `teacher-applications.ts` uses `$transaction` |
| **Raw SQL** | None in `src/` (zero `$queryRaw`/`$executeRaw`) | Same | No query change | `tests/production-storage-phase21.test.js` §3 sweep |
| **Generated IDs** | `cuid()` client-generated preserved verbatim | Same | Preserved | Loader copies IDs |
| **Concurrency** | SQLite single writer, `SQLITE_BUSY` under publish+heartbeat bursts | MVCC row lock, `updateMany` guarded claims | Rate-limit primitive `upsert(update:{})` + `updateMany WHERE count<limit` proven on PG (drill probe F1) | `verify-phase21-migration.mjs` 28/28 |

**No SQLite-only SQL functions** — every query is Prisma Client call.

### 6.2 Data Migration

**Tool:** `node scripts/db/migrate-sqlite-to-postgres.mjs --source <sqlite> --target <pg-url> --manifest <json>`

**Steps (from `POSTGRES_CUTOVER_RUNBOOK.md` + `PHASE_21_PRODUCTION_DATABASE_STORAGE.md`):**

```
backup (SQLite .backup + sha256 + row counts)
→ provision PostgreSQL (Neon/Supabase, empty DB)
→ create schema (psql -f postgres-baseline.sql OR prisma db push from derived schema where engines reachable)
→ migrate data (loader: ALL 55 tables topological order parents-first, cycle=loud error, parameterized multi-row INSERTs 500/batch, preserve IDs/relationships/timestamps tolerant UTC, ONLY _prisma_migrations excluded, ONE transaction, post-load count+canonical-hash verification INSIDE transaction, mismatch=rollback exit 4, emits JSON manifest per-table rows+sha256 redacted target)
→ relationship validation (FK check, 0 orphans)
→ row-count comparison (per-table, manifest vs source)
→ constraint validation (UNIQUE, PK, FK, enums)
→ application verification (battery verify-postgres.mjs + app-shaped queries G1-G7)
→ configure application (DATABASE_URL PG)
→ controlled cutover (freeze window, read-only maintenance, snapshot, load, battery, ledger baseline, switch, smoke tests)
→ production verification (see §17)
```

**Fail-closed:**

- Source must have all 55 tables else abort (migrate SQLite to head first)
- Target must have baseline AND be empty else abort
- Whole load ONE transaction
- Manifest is auditable receipt

### 6.3 Validation (minimum)

From `scripts/db/verify-postgres.mjs` battery (19 checks) + `verify-phase21-migration.mjs` 28 checks:

- **Users:** count + hash identical, role preserved, `isActive`, `status`
- **Course:** 1 course `programming-ai-2nd-sec` preserved
- **Parts:** 2 Parts preserved
- **Units:** 7 Units preserved
- **Official Lessons:** 23 Lessons `1-1`…`7-3` with `officialCode` unique, `unitId` valid, `curriculumStatus=OFFICIAL`, no archived in active universe
- **Tracks:** `Track` dead schema preserved (2 rows if existed, else 0 — never backfilled)
- **Curriculum state:** `Lesson.status` DRAFT/READY/PUBLISHED, `SessionPublication` anchor preserved, `isPublished` compat mirror parity 0 mismatches
- **Subscription Plans:** 4 plans preserved (Monthly 200, 3 Months 550, 6 Months 1000, Early Bird 100)
- **Settings:** 10 settings preserved (brand_name, whatsapp_*, prices, academic_year)
- **Security/Audit records:** `UserSession` SHA-256 hash, `PasswordResetToken` hash single-use, `TeacherApplication` email UNIQUE + status, `TeacherActivationToken` hash UNIQUE, `SecurityRateLimit` UNIQUE(bucket, identifier), `SecurityEvent` append-only, `AuditLog` — all migrate 1:1
- **Media metadata:** `MediaAsset` (EXTERNAL_URL/LOCAL_PRIVATE/S3, storageKey/externalUrl, sizeBytes), `SessionVideo` (batchId, lessonId, mediaAssetId, isPublished), `Material` (lessonId, kind, storageKey, mediaAssetId, trackScope), `QuizAttemptEvidence` (attemptId, storageKey, retainUntil)

**Also validate FK integrity:** `PRAGMA foreign_key_check` on SQLite before migration must be [] (empty), and PG battery checks orphans (every FK column scanned, 0 dangling) + duplicates (every UNIQUE+PK scanned, 0 duplicate groups) + lifecycle coherence (ACTIVATED ⇒ live TEACHER User, APPROVED ⇒ token minted, unused token ⇒ APPROVED, reviewers exist) + security tables (no NULL token hashes) + rate-limit probe (idempotent ensure + exact-limit claims + duplicate rejection rolled back).

### 6.4 Cutover (safe exact order)

```
1. P22 final verification (149/149 final-integration, 27 suites, 9 verifiers)
2. Backup SQLite (sqlite3 .backup + sha256) + media (migrate-media.mjs --check + manifest) — record pre-cleanup counts
3. Provision PostgreSQL (Neon Free: create project, db codemind, roles app/owner, connection string ?sslmode=require, pooling ?pgbouncer=true if needed)
4. Derive artifacts (make-postgres-schema.mjs + --check) — never hand-edit
5. Apply baseline on empty PG (psql -f postgres-baseline.sql)
6. Rehearse load on disposable copy (createdb rehearsal + baseline + loader --source copy + verify-postgres.mjs) — measure wall-clock for freeze window (rehearsal ×3 min 1h)
7. Freeze window opens: stop app, confirm no process holds SQLite file (fuser/lsof), SQLite snapshot (cp + sha256, verify opens)
8. Load LIVE SQLite (loader --source db/custom.db --target PG --manifest pg-load.json) — expects LOAD OK 55 tables
9. Validation on PG (verify-postgres.mjs --target PG → VERIFY_POSTGRES_OK) + manifest counts vs SQLite snapshot counts table-by-table
10. Migration-ledger baseline (if engines reachable): prisma migrate resolve --applied <each of 9 names> --schema schema.postgresql.prisma (else skip, baseline DDL + manifest ARE ledger until engines available)
11. Configure application: DATABASE_URL PG (secret manager, mode 0600), MEDIA_STORAGE_PATH durable volume (for VPS) or object storage (for Vercel), MEDIA_QUOTA_BYTES 80% volume, SECURITY_HASH_SECRET 64-hex, NEXT_PUBLIC_URL https, SMTP_*, etc.
12. Switch: start app, tail logs for Prisma connection errors
13. Smoke test each role (admin/teacher/student/parent): login, open session, start+submit quiz, download PDF, check notification, teacher-application admin page load read-only
14. First pg_dump backup immediately (backup-postgres.sh --out-dir --label post-cutover) — cutover not done until backup exists
15. Announce freeze window closed
```

### 6.5 Rollback

**Inside freeze window (before switch, SQLite untouched):**

```
Stop app → Restore DATABASE_URL to SQLite file (file:./db/custom.db) + MEDIA_STORAGE_PATH to pre-cutover tree → Start app → Smoke tests → Root-cause from loader manifest + battery output + app logs → PG left AS-IS for forensics (do not drop until post-mortem)
```

**Data-loss window rule:** Writes accepted on PG between switch and rollback decision are NOT in SQLite. If window accepted writes, ONLY fix-forward on PG is supported — rolling back to SQLite after PG accepted writes DISCARDS those writes. Smoke tests must run BEFORE announcing window closed; rollback decision point within first hour.

**Post-go-live disaster recovery (PG lost AFTER go-live):**

```
Restore latest verified backup into FRESH database (restore-postgres.sh --backup <dump> --target postgresql://.../codemind_restored — enforces empty-target + sha256 + battery) → verify-postgres.mjs → Switch DATABASE_URL → Smoke tests
RPO = last backup, RTO = restore + battery time (measured in rehearsal)
```

---

## 7. Media / Storage Architecture

### 7.1 Current Implementation (actual inspected)

| Media Type | Upload Path | Storage Location | Metadata | Access Control | Download / Stream | Signed URL | Cleanup | Migration |
|------------|-------------|------------------|----------|----------------|-------------------|------------|---------|-----------|
| **PDF** | `POST /api/admin/lessons/[id]/materials` (admin only) → `src/lib/session-materials.ts` validates MIME+magic+ext+size then `writePrivateFile` | `MEDIA_STORAGE_PATH` local FS `./storage/media` gitignored, random key `scope/timestamp-hex.pdf`, `MediaAsset` kind `DOCUMENT` storage `LOCAL_PRIVATE` | `Material` (lessonId, kind `ADMIN_UPLOADED`, title, storageKey, mediaAssetId, isActive, trackScope SHARED/ARABIC/LANGUAGE) + `MediaAsset` (id, kind DOCUMENT, storage LOCAL_PRIVATE, storageKey, originalName sanitized, mimeType `application/pdf`, sizeBytes, isPrivate true) | 10-check contract `authorizeMaterialDownload` in `session-materials.ts`: authenticated + role + enrolled + correct course + correct track (`canAccessTrackScope`) + session belongs to course + lifecycle PUBLISHED/available + progression unlocked + resource belongs to session + resource available (`isActive` + `isPrivate` + `LOCAL_PRIVATE`) + batch? (PDFs not batch-gated) — fails closed, non-oracle 404 for `MATERIAL_NOT_FOUND/ASSET_NOT_FOUND/MATERIAL_INACTIVE/TRACK_DENIED/LESSON_NOT_FOUND`, 403 for `NOT_ENROLLED/PREVIOUS_SESSION_INCOMPLETE/FORBIDDEN_ROLE` | `GET /api/materials/[id]` (student/parent/teacher/admin) → `readPrivateFile` + `privateFileStat` → strict Range parsing regex-anchored → 416 if out-of-range, `Accept-Ranges: bytes`, `Content-Disposition` inline vs `?download=1` attachment, `Cache-Control: private, no-store`, `Content-Type: application/pdf` | None currently — direct stream via authorized route (bytes never via public URL) | Replace/deactivate: refcounted, `Material` deactivated not deleted, asset delete only when unreferenced (row + bytes, bytes after commit, best-effort, next-run convergence) — same as session videos | `migrate-media.mjs --source old --dest new --manifest json` SHA-256 before+after, deterministic sorted inventory, symlinks skipped, never deletes source — operator deletes only after `--check` succeeds (two-person step) |
| **Video** | `POST /api/admin/session-videos` (admin) — upload or external URL → `writePrivateFile` | Same local FS, `MediaAsset` kind VIDEO, `SessionVideo` batchId + lessonId + mediaAssetId + isPublished + publishedAt | `SessionVideo` (id, batchId, lessonId, title, mediaAssetId, isPublished, publishedAt, duration) + `MediaAsset` (VIDEO, EXTERNAL_URL or LOCAL_PRIVATE, storageKey/externalUrl) + `SessionVideoView` (studentId, videoId, progress, completed) | `GET /api/media/[id]` (video) → batch membership (`student.batchId == video.batchId`? Actually via `Batch.schoolType` derived from `student.schoolType` server-side, never from URL batch id — sticky-batchId hole closed in P20) + track match + isPublished + enrollment + lifecycle; admin can see all; parent denied; quiz evidence ADMIN-only; DOCUMENT via this route refused for non-admins (must go via `/api/materials/[id]`) | Same Range handling, `Content-Type: video/mp4` etc., `Accept-Ranges`, `Content-Disposition`, `Cache-Control: private, no-store` | None — direct stream | Refcounted delete in `DELETE /api/admin/session-videos/[id]` | Same migrate-media |
| **Quiz Evidence** | `POST /api/quizzes/[id]/evidence` (student, open attempt) → `writePrivateFile` | Local FS, `MediaAsset` IMAGE, `QuizAttemptEvidence` (attemptId, storageKey, retainUntil = now + QUIZ_EVIDENCE_RETENTION_DAYS default 30, cameraStatus) | `QuizAttemptEvidence` + `MediaAsset` IMAGE | Student can only upload for own open attempt (`canAccessQuiz`), evidence GET `GET /api/quizzes/[id]/evidence` student own only, ADMIN review `GET /api/admin/quiz-evidence` ADMIN-only + audited `QUIZ_EVIDENCE_ACCESSED` | `GET /api/media/[id]` for evidence ADMIN-only | None | Purge job `purge-expired-evidence.ts` — dry-run default, `--live --yes` deletes expired `retainUntil <= now`, NULL/unparseable = keep forever, evidence rows delete in one transaction, unreferenced LOCAL_PRIVATE assets delete row+bytes, protected tables count-asserted unchanged | Same |
| **Other Uploads** | None — no avatar upload, no homework file upload (HomeworkSubmission.fileUrl exists but no upload path, text-only 4000 chars) | — | — | — | — | — | — | — |
| **Material** | Same as PDF | Same | Same | Same | Same | Same | Same | Same |
| **SessionVideoView** | `POST /api/students/me/session-videos/[id]/progress` + `POST /api/lessons/[id]/video-progress` | No bytes — progress only, `SessionVideoView` heartbeat wall-clock credited monotonic capped `MAX_CREDIT_PER_BEAT_SEC=60`, `videoPercent`, `videoCompleted` | `SessionVideoView` | Batch match + isPublished + enrollment + track | No download — progress endpoint | None | None | None |

**Key security properties already (must preserve on Vercel):**

- Private files never in `/public`, random unguessable keys, traversal-safe `resolveSafePath`
- Served ONLY through authorized routes that re-check role on every request
- No public bucket, no static directory serving
- MIME allow-list + magic bytes + extension + sanitized filename + size cap + no temp files (PDF)
- Range strict → 416 (previously NaN coerced to 0 produced bogus `bytes NaN-NaN/…` 206 — fixed in P20)
- `Accept-Ranges`, `Content-Disposition`, `Cache-Control: private, no-store`
- Cross-track/cross-course/unpublished/archived inherited from `canAccessLesson` + `authorizeMaterialDownload`
- Reference-counted delete, orphan handling, DB/file consistency via SHA-256 manifests

### 7.2 Vercel-Compatible Design (no ephemeral FS)

**Decision: filesystem volume is NOT viable on Vercel — must use object storage.**

Phase 21 chose filesystem volume because repo has no S3 client (only enum value) and single-VPS+Caddy is volume-native. For Vercel, we must implement S3 client behind same `MediaAsset` + authorized-route contract.

**Proposed adapter (preserves `MediaAsset`):**

```ts
// src/lib/media.ts — add S3 backend (keep LOCAL_PRIVATE for dev/VPS, add S3 for Vercel)
// ENV: STORAGE_BACKEND="local" | "s3" | "r2" | "vercel-blob" (default local for dev, s3 for Vercel)
// For S3/R2: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, S3_BUCKET, S3_ENDPOINT (R2 endpoint)
// For Vercel Blob: BLOB_READ_WRITE_TOKEN

export type StorageBackend = "LOCAL_PRIVATE" | "EXTERNAL_URL" | "S3"; // S3 covers R2/Blob via S3 compat

// New functions:
export async function writePrivateFileS3(key: string, data: Buffer, mime: string): Promise<string>
export async function readPrivateFileS3(key: string): Promise<Buffer> // or stream
export async function deletePrivateFileS3(key: string): Promise<void>
export async function getSignedUrlS3(key: string, expiresSec: number): Promise<string> // 15min

// Upload flow for Vercel (bypass 4.5MB limit):
// 1. Client POST /api/materials/presign { lessonId, title, trackScope, sizeBytes, mime, originalName } → server validates authz + size + mime allow-list + quota → returns presigned PUT URL (S3/R2) + storageKey
// 2. Client PUTs directly to presigned URL (bypasses Vercel function)
// 3. Client POST /api/materials/complete { storageKey, ... } → server downloads first 1KB, checks magic bytes, validates extension, creates MediaAsset + Material rows transactionally
// Alternative for small files (<4.5MB): direct multipart via Vercel function (existing flow) still works
```

**Per media type Vercel design:**

| Type | Upload Path | Storage Location | Metadata | Access Control | Download / Stream Mechanism | Signed URL Strategy | Cleanup Strategy | Migration Strategy |
|------|-------------|------------------|----------|----------------|----------------------------|---------------------|------------------|--------------------|
| **PDF** | Presigned PUT to R2/S3 (client→R2) + complete callback (server validates magic bytes by downloading header) | R2 private bucket `codemind-media`, key `pdf/<random>.pdf` | Same `Material` + `MediaAsset` (storage S3, storageKey = R2 key, sizeBytes, originalName sanitized, mime) | Same 10-check contract in `authorizeMaterialDownload` | `GET /api/materials/[id]` → `getSignedUrlS3` 15min + redirect OR stream via Vercel function (streaming uses function duration) — prefer redirect to signed URL for large files to avoid Vercel timeout | Short-lived 15min, `response-content-disposition` inline vs attachment via `?download=1`, `Cache-Control: private, no-store` | Same refcounted, but delete via S3 DeleteObject + DB row | `migrate-media.mjs` adapted to S3: list local files, upload to R2 with SHA-256 check, manifest, `--check` lists objects via S3 ListObjectsV2 + SHA-256 via HEAD + ETag or download header |
| **Video** | Same presigned flow, but video 512MB → must be multipart presigned (S3 multipart) | R2 `video/<random>.mp4` | `SessionVideo` + `MediaAsset` VIDEO S3 | Batch+track+published+enrollment+track | `GET /api/media/[id]` → signed URL redirect (R2 supports Range via signed URL) OR stream — prefer redirect for bandwidth (R2 free egress) | 15min signed URL, `Accept-Ranges` handled by R2, `Cache-Control: private` | Refcounted | Same |
| **Quiz Evidence** | Direct via Vercel function for small snapshots (<4.5MB) — image 5MB at limit, should use presigned too | R2 `evidence/<attemptId>/<random>.jpg` | `QuizAttemptEvidence` + `MediaAsset` IMAGE S3 | Student own open attempt, ADMIN-only review | ADMIN review via signed URL | 15min | Purge job adapted to S3: list objects with `retainUntil <= now` via DB query, delete S3 objects + DB rows in transaction, protected tables count-asserted | Same |

**Retention / Cleanup / Deletion / Orphan handling / DB/file consistency:**

- Retention: `retainUntil` rule unchanged (`src/lib/evidence-retention.ts`), purge job becomes `/api/cron/purge-evidence` with S3 delete
- Cleanup: nightly cron (Vercel Cron) dry-run first week, `--live` after
- Deletion: refcounted — check if `MediaAsset` referenced by any `SessionVideo`/`Material`/`QuizAttemptEvidence` before S3 delete
- Orphan handling: `verify-postgres.mjs` battery includes orphan scan (FK columns); media orphan scan: list S3 objects not referenced by any `MediaAsset` row → report, manual review, delete after 30d
- DB/file consistency: SHA-256 per file before+after copy, manifest JSON, `--check` audit mode, symlinks skipped — same contract for S3 (SHA-256 via streaming download or ETag)

---

## 8. Authentication & Account Provisioning

### 8.1 Current Implementation (actual inspected)

| Flow | Implementation | File Evidence | Vercel Compatibility |
|------|----------------|---------------|----------------------|
| **Student registration** | `POST /api/auth/[action]` role STUDENT, validates email lowercase+trim, name, Egyptian phone optional, `schoolType` via `requireSchoolType` accepting legacy aliases, creates `User` scrypt hash 8+ chars, `Student` row with `schoolType` nullable enum, `studentCode` unique, `groupId` optional, `batchId` via `reconcileStudentBatch()` (idempotent, prefers ACTIVE course-specific batch, clears wrong-track), creates `UserSession` SHA-256 hash + cookie `cm_session` httpOnly lax secure 7d | `src/app/api/auth/[action]/route.ts`, `src/lib/registration.ts`, `src/lib/school-type.ts`, `src/lib/auth.ts`, `src/lib/enrollment.ts` | Compatible — DB-backed, no local FS |
| **Parent registration** | Triple match (student nationalId + studentCode + parentPhone normalized) with identical 404 messages (no oracle), creates `User` + `Parent` + `ParentStudentLink` | Same + `parent-access.ts` | Compatible |
| **Admin login** | `POST /api/auth/login` → `getCurrentUserDetailed` → `User` role ADMIN, `isActive` + `status ACTIVE` check before session mint, dual-bucket throttling `login:id` + `login:ip`, `LOGIN_FAILED` audit, success clears `login:id` bucket, sets cookie | `auth/[action]/route.ts` login branch, `security.ts:checkRateLimit`, `auth.ts:createSession` | Compatible — DB-backed throttling multi-process safe |
| **Teacher Application** | Public `POST /api/auth/[action]` role TEACHER → `submitTeacherApplication` in `teacher-applications.ts`: validates name/email canonical, rate-limits per canonical email `teacherApply` 5/3600/3600 SHA-256 hashed `rl:teacherApply:<hash>`, creates `PENDING` `TeacherApplication` email UNIQUE (one identity forever), **never** `User`, never `role TEACHER`, never session, client `status`/`role` ignored, response `applied:true` only, every refusal same generic 409 `api.258` (no enumeration oracle whether existing account/pending/approved/activated) | `src/lib/teacher-applications.ts:submitTeacherApplication`, `src/app/api/auth/[action]/route.ts` TEACHER branch, `rate-limit.ts:teacherApply` | Compatible — DB-backed |
| **Admin Approval** | `POST /api/admin/teacher-applications/[id]/approve` ADMIN-only `requireRole ADMIN` first (401 anon/403 other role, IDOR-safe auth before existence so non-admin probing bogus id gets 403 not 404), uses server-derived `user.id` as `reviewedByUserId`, idempotent re-approve returns `alreadyApproved:true` no re-mint no re-email, auditable `TEACHER_APPLICATION_APPROVED` + `TEACHER_ACTIVATION_ISSUED` with masked destination, no User creation, no password assignment, no self-approval (applicant anonymous pre-activation) | `src/app/api/admin/teacher-applications/[id]/approve/route.ts`, `teacher-applications.ts:approveTeacherApplication` | Compatible |
| **Teacher Activation** | `POST /api/auth/teacher-activate` public `{token,password}`: lookup by `sha256(token)`, raw never persisted/logged, single-use `usedAt` stamped guarded `updateMany` inside same `$transaction` that creates `User(role TEACHER)` + `Teacher` + flips to `ACTIVATED`, expired rejected (72h from `TEACHER_ACTIVATION_TTL_HOURS` default), applicant sets own password min 8 via `hashPassword`, no default/hardcoded, no password in response, no auto-login response `{ok:true}`, token bound to `applicationId`, uniform 400 `api.261` for unknown/used/expired/wrong-app (indistinguishable), per-IP `teacheract:ip` 20/3600 and per-token `teacheract:token` 5/3600 rate limits, audit `TEACHER_ACTIVATION_COMPLETED/FAILED` no password/raw token | `src/app/api/auth/teacher-activate/route.ts`, `teacher-applications.ts:activateTeacherAccount`, `security.ts:sha256`, `auth.ts:hashPassword` | Compatible — transactional, portable |
| **Password Reset** | `POST /api/auth/password-reset/request` + `/confirm`: email only (no SMS), identical response for found/unknown/rate-limited (no enumeration), rate limit per email 3/15min + per IP 10/hr, cryptographically random secret SHA-256 stored, raw never logged/returned, new request invalidates previous unused, single-use `usedAt` stamped same transaction as password change, replay/expiry/attempt-limit 5 uniform error, scrypt hash, all sessions revoked via `revokeAllSessions`, audit masked destination, Gmail SMTP STARTTLS 587 `requireTLS` TLS≥1.2 | `src/app/api/auth/password-reset/request/route.ts`, `confirm/route.ts`, `security.ts`, `mailer.ts`, `delivery.ts` | Compatible — DB-backed |
| **Sessions** | `UserSession` SHA-256 hash UNIQUE, `deviceHash` UA family+OS family+ch-ua-mobile/platform hashed with `SECURITY_HASH_SECRET`, `ipHash` hashed, `expiresAt` 7d, `lastSeenAt` throttled 1min, `revokedAt`/`revokedReason`; `getCurrentUserDetailed` returns reason; `createSession` single-device conflict detection: live sessions `revokedAt null && expiresAt>now`, conflicting = different `deviceHash` && `now-lastSeenAt<30min` → revoke all + suspend `SUSPENDED_MULTI_DEVICE` + `isActive false` + audit; same-device supersede no suspension; `destroySession` deletes row + cookie; `revokeAllSessions` used after reset | `src/lib/auth.ts` | Compatible with config — needs PG pooling |
| **Cookies** | `cm_session` httpOnly sameSite lax secure in prod path `/`, 7d TTL, `SESSION_COOKIE_NAME` constant | `auth.ts:125` | Compatible — Vercel HTTPS so secure flag correct |
| **Authorization** | `requireUser`/`requireRole`/`requireAdmin` per request from session, never client-supplied role; `getStudentProfile`/`getParentProfile`/`getTeacherProfile` eager-load; `canAccessLesson` single definition for checks 3–8, `canAccessQuiz`/`canAccessHomework` reuse + trackScope gate, `authorizeMaterialDownload` full 10-check, `isParentLessonPreviewAllowed` lifecycle+not-archived+child track+enrolled course, `getEnrollment` active group→course sole gate | `src/lib/api.ts`, `session-progress.ts`, `track-scope.ts`, `parent-access.ts`, `enrollment.ts`, `session-materials.ts` | Compatible |
| **Role checks** | Every `/api/admin/*` calls `requireAdmin`, teacher routes `requireRole TEACHER` + course-ownership check, student routes `requireRole STUDENT` + `canAccessLesson`, parent routes `requireRole PARENT` + `Parent.children` links only | All route files | Compatible |

**Exact teacher lifecycle that MUST remain (DO NOT weaken):**

```
Teacher Application
→ PENDING (no User, no session, email UNIQUE, one row per canonical identity forever, re-apply reopens same row)
→ Admin Approval (ADMIN-only, server-derived reviewer id, idempotent, masked audit, token minted SHA-256 single-use 72h, no User created)
→ Secure Activation (public token, SHA-256 lookup, single-use guarded updateMany inside $transaction that creates User(role TEACHER)+Teacher+ACTIVATED, expired/replayed/wrong-app 400 indistinguishable, applicant sets own password 8+ via scrypt, no default/hardcoded, no password in response, no auto-login)
→ Applicant Password Setup (same step as activation)
→ Active TEACHER (User.role=TEACHER + Teacher row, login 200 + cm_session cookie + /me role TEACHER, cannot approve others)
```

**Vercel compatibility for:**

- **Session persistence:** DB-backed `UserSession` — works serverless, needs PG pooling (`?connection_limit=10` or Prisma Accelerate)
- **Cookies:** httpOnly lax secure — works, Vercel HTTPS
- **Secrets:** `SECURITY_HASH_SECRET` required 32+ chars, no placeholder, fail-fast build+runtime via `env.ts` + `instrumentation.ts` — Vercel env var
- **Token expiry:** `PasswordResetToken` 15min, `TeacherActivationToken` 72h — enforced server-side, DB-stored
- **Single-use tokens:** Guarded `updateMany` + `$transaction` — race-free, MVCC on PG, proven by 71/71 `verify-phase20-teacher.mjs` including replay/expired
- **Password reset:** Same, plus `revokeAllSessions`
- **Rate limiting:** DB-backed `SecurityRateLimit` — deterministic, multi-process safe, works serverless, but adds DB write per request (acceptable for MVP, monitor)
- **Concurrent requests:** `checkRateLimit` race-free via idempotent `upsert(update:{})` + guarded window reset + guarded claim — 40 concurrent against limit 10 admits exactly 10 (P20 verifier 42/42)
- **Database-backed state:** All state in PG, not memory — serverless safe

---

## 9. Security on Vercel

| Item | Current Implementation | Vercel Compatibility | Required Configuration | Required Code Change | Risk |
|------|------------------------|----------------------|------------------------|----------------------|------|
| **CSP** | `src/lib/content-security-policy.ts` pure, `decideCspHeader()` → `next.config.ts` `securityHeaders()` on all paths, prod: `default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `font-src 'self' data:`, `frame-src 'self' https: youtube/nocookie/vimeo`, `media-src 'self' blob: data: https:`, `connect-src 'self'`, `worker-src 'self' blob:`, `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`, no `unsafe-eval` in prod (dev only webpack HMR), `unsafe-inline` justified (Next.js RSC bootstrap + framer-motion/recharts inline styles), toggles `CSP_REPORT_ONLY=1` → report-only, `CSP_DISABLED=1` → remove | **Already correct** — Vercel respects `next.config.ts` headers | Set `CSP_REPORT_ONLY`/`CSP_DISABLED` via Vercel env if needed for rollout; keep defaults enforced | None, unless need to allow R2/Blob domains in `media-src`/`img-src` (add `https://*.r2.cloudflarestorage.com` or `https://*.public.blob.vercel-storage.com` to `media-src`/`img-src` when using object storage) | Low — CSP preserved |
| **Security headers** | `next.config.ts`: `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), microphone=(), geolocation=(), payment=(), usb=()`, `Strict-Transport-Security: max-age=15552000; includeSubDomains` (unless `HSTS_DISABLED=1`), `poweredByHeader: false` | **Already correct** — Vercel emits same | Keep; HSTS emitted unconditionally safe because browsers honor only on secure response; `preload` omitted deliberately (one-way door) | None | Low |
| **HTTPS** | Caddy auto TLS + `next.config.ts` HSTS | **Handled by Vercel** — Vercel auto-provisions Let's Encrypt, auto-renew, HTTP→HTTPS redirect | Set custom domain in Vercel dashboard, DNS A/AAAA or CNAME, enable HTTPS | Remove Caddyfile for Vercel path, keep for VPS fallback | Low |
| **Cookies secure/httpOnly/sameSite** | `auth.ts:125 secure: NODE_ENV=production`, httpOnly true, sameSite lax, path `/`, 7d | **Already correct** — Vercel prod is HTTPS | Ensure `NODE_ENV=production` on Vercel (default) | None | Low |
| **Rate limiting** | DB-backed `SecurityRateLimit`, policy `rate-limit.ts`, enforcement `api.ts:applyRateLimit`/`rateLimitedResponse`, 7 keys + login dual-bucket, identifiers hashed, 429 with `Retry-After` + `X-RateLimit-*`, audit `SecurityEvent` | **Already correct** — multi-process safe, survives restarts, works serverless | Set `RATE_LIMIT_*` env overrides via Vercel if needed (clamped, never disableable) | None, but consider adding Vercel's own rate limiting (Vercel Firewall) as defense-in-depth — VERIFY CURRENT PROVIDER LIMIT | Low — adds DB writes, monitor |
| **CSRF/origin** | No explicit Origin check; mitigated by `SameSite=Lax` (cross-site POST no cookie) + JSON-only mutations (HTML form cannot produce JSON) + CORS no wildcard, `redirects.ts` allow-list | **Already correct** — proven with `tough-cookie` + real `Set-Cookie` | Keep; optionally add Origin check for extra defense-in-depth, but not required per Gate R-1 accepted | None | Low — accepted risk R-1 |
| **Env secrets** | `env.ts` fails closed on missing/short/placeholder `SECURITY_HASH_SECRET`, `instrumentation.ts` fail-fast at server start, `next.config.ts` fail-fast at build, `.env` gitignored, `git ls-files` shows no `.env*` tracked except `.env.example`, tokens hashed before DB/event, SMTP password redacted | **Needs configuration** — Vercel secrets via dashboard, not `.env` file | Set `SECURITY_HASH_SECRET` (64-hex `openssl rand -hex 32`), `DATABASE_URL` PG, `SMTP_*` or `RESEND_API_KEY`, `CRON_SECRET`, etc. in Vercel Project → Settings → Environment Variables, Production + Preview, server-only (no `NEXT_PUBLIC_` prefix) | None | High if missing — server refuses to start (correct) |
| **DB credentials** | `DATABASE_URL` env, redacted in tool outputs | **Needs configuration** — Vercel env var, secret manager | Set PG URL with `?sslmode=require`, `?connection_limit=10`, pooling via Neon or Prisma Accelerate | None | High if leaked — never commit, mode 0600 |
| **Storage credentials** | `MEDIA_STORAGE_PATH` local, no S3 creds yet | **Needs architectural change** — S3 creds via Vercel env | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `S3_BUCKET`, `S3_ENDPOINT`, `AWS_REGION` or `BLOB_READ_WRITE_TOKEN` | Implement adapter | High if bucket public — must be private |
| **Passwords** | scrypt salt:hash, 8+ chars everywhere (Gate F-09), timingSafeEqual | **Already correct** | None | None | Low |
| **Tokens** | SHA-256 hash UNIQUE, single-use, short-lived, no raw token in DB/log/response | **Already correct** | None | None | Low |
| **Authorization** | Per-request re-derived from session, never client role, `requireAdmin` gates `/api/admin/*`, parent via `ParentStudentLink`, teacher via own courses, student via `Student.group→Group.courseId` + `schoolType` trackScope | **Already correct** | None | None | Low |
| **Error handling** | Structured `err(msg,status)` with stable machine code + localized message, no stack traces to client, login/reset/application uniform responses (no enumeration oracle), `maskEmail()` | **Already correct** | None | None | Low |
| **Logging** | `logSecurityEvent` hashed IP, truncated UA, never raw PII, never token value — verified in `verify-security-audit-gate.mjs` §12 | **Already correct** — Vercel logs must not contain secrets | Ensure `DELIVERY_DEV_LOG` unset in prod (must be false) | None | Low |
| **Sensitive data exposure** | `GET /api/groups` no longer serialises full `User` rows (P3 HIGH fix), `leaderboard` scoped to own course capped 200 (Gate F-06), media via authorized routes only | **Already correct** | None | None | Low |

**Caddy responsibilities → Vercel mapping:**

| Caddy Responsibility | Current | Vercel Equivalent | Classification |
|----------------------|---------|-------------------|----------------|
| HTTPS auto Let's Encrypt + renew | `Caddyfile` auto TLS | Vercel auto HTTPS (Let's Encrypt, auto-renew) | Handled by Vercel |
| HTTP→HTTPS redirect | Caddy automatic | Vercel automatic | Handled by Vercel |
| Security headers (X-Frame-Options etc.) | `next.config.ts` `securityHeaders()` | Same `next.config.ts` — Vercel respects `headers()` | Must move to application (already) |
| CSP | `next.config.ts` via `content-security-policy.ts` | Same | Must move to application (already) |
| `X-Real-IP` overwrite | `Caddyfile: header_up X-Real-IP {remote_host}` overwrites client value | Vercel sets `X-Forwarded-For` + `X-Real-IP`? VERIFY — Vercel sets `X-Forwarded-For` and `X-Vercel-Forwarded-For`; trust boundary must be updated to trust Vercel's headers as overwriting | Must move to Vercel configuration + code change `clientIpFromHeaders` to trust Vercel |
| Reverse proxy to `:3000` | `reverse_proxy localhost:3000` | Vercel serves directly, no reverse proxy needed | No longer needed |
| `XTransformPort` sidecars | `:81` with `query XTransformPort=*` → `localhost:{port}` | No equivalent on Vercel — sidecars must be separate projects or external | No longer needed (mini-services empty) |
| Static files `/public` | Caddy serves? Actually Next.js serves, Caddy proxies | Vercel CDN for static assets | Handled by Vercel |
| Compression | Caddy automatic | Vercel automatic (gzip/brotli) | Handled by Vercel |
| Custom domain + DNS | Manual A record to VPS IP | Vercel Domains dashboard + DNS | Must move to Vercel configuration |

---

## 10. Environment Variables

**Complete production inventory (from `.env.example` + source refs + `scripts/` + docs):**

| Name | Purpose | Required / Optional | Local Only / Production Only / Both | Provider-Specific | Client-Exposed? |
|------|---------|---------------------|-------------------------------------|-------------------|-----------------|
| `DATABASE_URL` | Prisma datasource — SQLite file or PG connection string | REQUIRED | Both | No (but format differs) | NO |
| `NEXT_PUBLIC_URL` | Public origin for referral links, email magic links, deep links | REQUIRED | Both | No | YES (NEXT_PUBLIC_) |
| `SECURITY_HASH_SECRET` | Keys IP hashes (audit/rate limit) and device fingerprints (single-device) — 32+ chars, 64-hex, `openssl rand -hex 32` — build+runtime fail-fast in prod, placeholder rejected | REQUIRED in prod | Both (dev fallback non-secret) | No | NO |
| `SKIP_PRODUCTION_ENV_CHECK` | Set 1 ONLY on CI build host that intentionally holds no prod secrets — skips build-time SECURITY_HASH_SECRET check, runtime still enforces | Optional | Production build only | No | NO |
| `MEDIA_STORAGE_PATH` | Private media volume path — persistent volume, outside web root, not served by proxy | REQUIRED in prod (VPS) / Optional for Vercel if using object storage | Both | No | NO |
| `MEDIA_MAX_VIDEO_BYTES` | Video upload ceiling bytes, default 512MB | Optional | Both | No | NO |
| `MEDIA_MAX_IMAGE_BYTES` | Image upload ceiling bytes, default 5MB | Optional | Both | No | NO |
| `MEDIA_MAX_PDF_BYTES` | PDF upload ceiling bytes, default 25MB (Phase 14) | Optional | Both | No | NO |
| `QUIZ_EVIDENCE_RETENTION_DAYS` | Camera snapshots retainUntil = now + days, default 30 — biometric personal data | Optional | Both | No | NO |
| `PASSWORD_RESET_TTL_MINUTES` | Email reset link lifetime minutes, default 15 | Optional | Both | No | NO |
| `SEED_ADMIN_PASSWORD` | Seeder admin@ password — when set used verbatim never echoed, unset+prod → seeder refuses exit 1, unset dev → random printed once | Optional (REQUIRED for prod seeding) | Both | No | NO |
| `SEED_DEMO_PASSWORD` | Seeder demo teacher/student/parent passwords — same contract | Optional | Both | No | NO |
| `TEACHER_ACTIVATION_TTL_HOURS` | Single-use teacher activation link lifetime hours, default 72 (Phase 20) | Optional | Both | No | NO |
| `RATE_LIMIT_HEARTBEAT` | `limit/windowSec/blockSec` for video playhead heartbeats (lesson+batch) default 300/60/60 | Optional | Both | No | NO |
| `RATE_LIMIT_PROGRESS` | Lesson progress writes default 120/60/60 | Optional | Both | No | NO |
| `RATE_LIMIT_OPEN` | Admin session-open ceremony default 20/60/300 | Optional | Both | No | NO |
| `RATE_LIMIT_NOTIFICATION` | Admin notification broadcast default 30/60/300 | Optional | Both | No | NO |
| `RATE_LIMIT_MATERIAL_DOWNLOAD` | Authorized PDF downloads default 120/60/60 | Optional | Both | No | NO |
| `RATE_LIMIT_PDF_UPLOAD` | Admin PDF uploads default 30/60/300 | Optional | Both | No | NO |
| `RATE_LIMIT_TEACHER_APPLY` | Public teacher applications per email default 5/3600/3600 | Optional | Both | No | NO |
| `CSP_REPORT_ONLY` | 1 → emit `Content-Security-Policy-Report-Only` instead of enforced (operator rollback without redeploy) | Optional | Both | No | NO |
| `CSP_DISABLED` | 1 → remove CSP header entirely (last-resort) | Optional | Both | No | NO |
| `HSTS_DISABLED` | 1 → remove HSTS header (kill-switch) | Optional | Both | No | NO |
| `SMTP_HOST` | Gmail SMTP host `smtp.gmail.com` | REQUIRED for email | Both | No | NO |
| `SMTP_PORT` | SMTP port 587 STARTTLS or 465 implicit TLS | REQUIRED for email | Both | No | NO |
| `SMTP_USER` | Gmail address sending from | REQUIRED for email | Both | No | NO |
| `SMTP_PASSWORD` | Gmail App Password 16 chars (NOT normal password) | REQUIRED for email | Both | No (secret) | NO |
| `EMAIL_FROM` | From header — Gmail only allows authenticated address, leave empty to default to SMTP_USER | Optional | Both | No | NO |
| `SMTP_SECURE` | 1 → implicit TLS on 465, else STARTTLS on 587 | Optional | Both | No | NO |
| `EMAIL_TEST_TO` | Recipient for `test:email` script | Optional | Local only | No | NO |
| `DELIVERY_DEV_LOG` | 1 → log REDACTED delivery record (masked dest only) diagnostic aid, ignored when NODE_ENV=prod, must be false in prod | Optional | Local only | No | NO |
| `POSTGRES_URL` | Alternative PG URL for migration scripts so app URL and migration URL can differ during freeze window | Optional | Production only | No | NO |
| `MEDIA_QUOTA_BYTES` | Total volume cap over MEDIA_STORAGE_PATH — unset/blank/0=unlimited (default), set=fail-closed 413 before write, human sizes `10GB`/`512 MB` | Optional | Both | No | NO |
| `BACKUP_PASSPHRASE` | AES-256 backup encryption passphrase for `backup-postgres.sh` — secret manager only, never commit, scripts print only whether on | Optional | Production only | No (secret) | NO |
| `NOTIFICATION_FANOUT_CHUNK_SIZE` | Fan-out chunk size default 500 env-clamped (from `notify.ts:272`) | Optional | Both | No | NO |
| `SERVER_LOG_FILE` | Override file for `start-production.mjs` tee, `0` to disable when systemd/PM2 captures output | Optional | Production VPS only | No | NO |
| `PORT` | Server listen port default 3000 | Optional | Both | No | NO |
| `NODE_ENV` | `production` triggers fail-fast checks | REQUIRED in prod | Both | No | NO |
| `CRON_SECRET` | **NEW for Vercel** — protects `/api/cron/*` routes, must be set on Vercel | REQUIRED for Vercel Cron | Production Vercel only | Vercel | NO |
| `AWS_ACCESS_KEY_ID` | **NEW for Vercel R2/S3** — S3 access key | REQUIRED for S3 backend | Production Vercel only | S3/R2 | NO |
| `AWS_SECRET_ACCESS_KEY` | S3 secret | REQUIRED for S3 | Production Vercel only | S3/R2 | NO |
| `AWS_REGION` | S3 region `auto` for R2 | REQUIRED for S3 | Production Vercel only | S3/R2 | NO |
| `S3_BUCKET` | Bucket name `codemind-media` | REQUIRED for S3 | Production Vercel only | S3/R2 | NO |
| `S3_ENDPOINT` | R2 endpoint `https://<accountid>.r2.cloudflarestorage.com` | REQUIRED for R2 | Production Vercel only | R2 | NO |
| `BLOB_READ_WRITE_TOKEN` | **Alternative** Vercel Blob token | REQUIRED for Blob | Production Vercel only | Vercel Blob | NO |
| `STORAGE_BACKEND` | **NEW** `local`|`s3`|`r2`|`vercel-blob` — selects adapter | Optional | Both | No | NO |
| `RESEND_API_KEY` | **NEW** Resend API key if using Resend instead of SMTP | Optional | Production Vercel only | Resend | NO |

**Server-only secrets (must never be client-exposed, no `NEXT_PUBLIC_` prefix):**

`DATABASE_URL`, `SECURITY_HASH_SECRET`, `SMTP_USER`, `SMTP_PASSWORD`, `BACKUP_PASSPHRASE`, `SEED_*_PASSWORD`, `AWS_*`, `S3_*`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `RESEND_API_KEY`

**Client-exposed:** Only `NEXT_PUBLIC_URL` (public origin). No secret uses `NEXT_PUBLIC_` prefix (verified via grep — `NEXT_PUBLIC_URL` only).

**Do NOT expose secret values** — this inventory lists names only.

**Do NOT invent variables** — all above from `.env.example` + source `process.env` grep + Phase docs + new Vercel needs.

---

## 11. Vercel Configuration

Based on actual repository:

| Item | Current | Vercel Recommendation | Status |
|------|---------|-----------------------|--------|
| **Framework** | Next.js 16.3.4 | Next.js (auto-detected) | Works unchanged |
| **Node version** | 22+ per `GO_LIVE_RUNBOOK.md` preflight, Next 16 requires >=18.17 | Set `engines.node = 22.x` in `package.json` or Vercel dashboard Node 22.x | Needs configuration |
| **Package manager** | Both `bun.lock` (221k) + `package-lock.json` (446k) present, `start` uses `bun`, build uses `prisma generate` + `next build` | Add `"packageManager": "bun@1.3.4"` to `package.json` to force Bun, or delete `package-lock.json` if Bun canonical; Vercel supports Bun; if using npm, ensure `npm ci` works | Needs configuration |
| **Install Command** | `bun install` (from `package.json` + `bun.lock`) | `bun install` or `npm ci` — Vercel auto-detects, but with dual locks may pick npm — set explicitly in Vercel dashboard: Install Command `bun install` if using Bun | Needs configuration |
| **Build Command** | `prisma generate && next build && node scripts/copy-standalone-assets.mjs` | Same, but `copy-standalone-assets` copies to `.next/standalone` which Vercel ignores — harmless but can be removed for Vercel; keep `prisma generate && next build`; set `SKIP_PRODUCTION_ENV_CHECK=1` during build if `SECURITY_HASH_SECRET` not available at build time (runtime still enforces) | Needs configuration (env var) |
| **Prisma Generate** | Already in build command | Vercel has network, so `prisma generate` will succeed (unlike offline sandbox); ensure `DATABASE_URL` set at build time OR use `SKIP_PRODUCTION_ENV_CHECK=1` to skip secret check at build | Needs configuration |
| **Runtime** | Node.js server (`standalone/server.js` via `start-production.mjs`) | Vercel Serverless Functions (Node 22) — no `start` script used; `output: standalone` ignored by Vercel but harmless | Works unchanged (Vercel ignores) |
| **Environment Variables** | `.env` gitignored, `.env.example` placeholder | Set in Vercel dashboard Project → Settings → Environment Variables: `DATABASE_URL` PG, `NEXT_PUBLIC_URL` https, `SECURITY_HASH_SECRET` 64-hex, `SMTP_*` or `RESEND_API_KEY`, `MEDIA_STORAGE_PATH` not needed if using object storage else ephemeral, `STORAGE_BACKEND=s3`, `S3_*` or `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `RATE_LIMIT_*`, `TEACHER_ACTIVATION_TTL_HOURS`, `MEDIA_MAX_*`, `QUIZ_EVIDENCE_RETENTION_DAYS`, `MEDIA_QUOTA_BYTES`, etc. — Production + Preview, server-only except `NEXT_PUBLIC_URL` | Needs configuration |
| **Functions** | 98 API routes, some long (ai-generate-quiz ~30s) | Add `export const maxDuration = 10` (Hobby) or 60 (Pro) in long routes; consider `export const runtime = 'nodejs'`; for 512MB uploads need presigned flow to bypass 4.5MB body limit | Needs modification before deployment (presigned uploads + maxDuration) |
| **Cron** | None (external scripts) | Add `vercel.json` with `crons`: `[{ "path": "/api/cron/purge-evidence", "schedule": "0 3 * * *" }]` (Hobby min 1h, 2 jobs max) — VERIFY CURRENT PROVIDER LIMIT | Needs configuration |
| **Preview Environment** | None specific | Vercel auto creates preview deploys per PR, with separate env vars (Preview) — use Neon branching or separate PG for preview, or same PG with caution; `NEXT_PUBLIC_URL` will be `https://<preview>.vercel.app` — ensure email links use `NEXT_PUBLIC_URL` (currently does) and not hardcoded | Needs configuration |
| **Production Environment** | VPS + Caddy + systemd | Vercel Production deployment from `main` branch, custom domain `codemind.academy` | Needs configuration |
| **Domain** | `codemind.academy` via Caddy | Add domain in Vercel dashboard Project → Settings → Domains, DNS CNAME or A record, auto HTTPS | Needs configuration |
| **Deployment configuration** | `Caddyfile`, `next.config.ts` headers, `output: standalone` | `vercel.json` optional for crons, headers already in `next.config.ts` (Vercel respects), `output` ignored | Needs configuration (vercel.json for cron) |

**Example `vercel.json` (minimal):**

```json
{
  "crons": [
    {
      "path": "/api/cron/purge-evidence",
      "schedule": "0 3 * * *"
    }
  ],
  "functions": {
    "src/app/api/admin/ai-generate-quiz/route.ts": {
      "maxDuration": 60
    }
  }
}
```

**Build config in Vercel dashboard:**

- Framework Preset: Next.js
- Node Version: 22.x
- Package Manager: Bun (if `packageManager` field set) or npm
- Install Command: `bun install` (or `npm ci`)
- Build Command: `prisma generate && next build` (or `bun run build` but ensure `SKIP_PRODUCTION_ENV_CHECK=1` if secrets not at build time)
- Output Directory: `.next` (default, Vercel auto)
- Environment Variables: as per §10

---

## 12. Cron / Background Jobs

Search entire repository for `cron`, `schedule`, `scheduled`, `job`, `worker`, `cleanup`, `retention`, `notification`, `reminder`, `background`, `queue`, `retry` — results: no `setInterval`/`setTimeout` in server code except UI, no workers, no queues.

| Job | Current Trigger | Current Execution Model | Required State | Duration | Idempotency | Storage Dependency | Vercel Compatibility | Recommendation |
|-----|-----------------|-------------------------|----------------|----------|-------------|--------------------|----------------------|----------------|
| **Quiz evidence purge** | Manual `npx tsx scripts/media/purge-expired-evidence.ts --live --yes --metrics json` intended for cron/systemd nightly per `GO_LIVE_RUNBOOK.md` | CLI script, dry-run default, reads `QuizAttemptEvidence` where `retainUntil <= now`, deletes rows in one transaction, unreferenced `MediaAsset` row+bytes, protected tables count-asserted unchanged, metrics JSON | `QuizAttemptEvidence.retainUntil`, `MediaAsset` | Seconds to minutes depending on expired rows | Idempotent (expired check, re-run converges) | Needs `MEDIA_STORAGE_PATH` local FS currently, needs PG | **COMPATIBLE WITH CONFIGURATION** — needs route wrapper + Vercel Cron | Expose as `POST /api/cron/purge-evidence` with `CRON_SECRET` check, `export const maxDuration=60`, use S3 adapter for file delete, keep dry-run default via query param `?dry=1`, log metrics to Vercel logs + optional external storage |
| **PostgreSQL backup** | Manual `scripts/db/backup-postgres.sh --out-dir --label nightly` intended for cron 3AM per runbook | Shell script `pg_dump --format=custom` + sha256 sidecar + manifest + retention 30d keep-7 + optional AES-256-CBC/PBKDF2 encryption via `BACKUP_PASSPHRASE` | PG connection, backup dir 0700/0600 | Minutes | Not idempotent (creates new artifact each run) but retention handles | Needs `pg_dump` binary, FS | **REQUIRES ARCHITECTURAL CHANGE** — no shell on Vercel | Use managed DB built-in backups (Neon PITR, Supabase daily) — free tier includes; plus optional GitHub Action with `pg_dump` for extra copy to R2/S3 |
| **Media migration** | Manual `node scripts/media/migrate-media.mjs --source --dest --manifest --check` one-off | CLI, SHA-256 per file, never deletes source | Source + dest FS | Minutes to hours | Idempotent (`--check` audit mode) | Local FS or S3 | **COMPATIBLE WITH CONFIGURATION** — one-off, not cron | Run once from local machine or GitHub Action, not Vercel function (too long); adapt to S3 destination |
| **Curriculum reconciliation** | Manual `npx tsx scripts/reconcile-curriculum.ts` one-off/idempotent, or `POST /api/admin/courses {action:reconcile-official}` | Idempotent, second run zero writes | Course/Part/Unit/Lesson tables | Seconds | Idempotent | PG/SQLite | **COMPATIBLE** — can be triggered via admin API, not cron | Keep as admin action, not cron |
| **Notification fan-out** | `POST /api/admin/lessons/[id]/open` triggers `src/lib/session-notifications.ts` fan-out chunked 500, deduped, counters `notifiedCount/notifiedAt` | Request-triggered, not cron, chunked sequential, per-chunk dedupe, mutex per lesson serializes parallel fan-outs | `SessionPublication`, `Notification`, `NotificationPreference`, eligible recipients via `getEligibleSessionRecipients` | 66ms for 1614 rows (from P22 rehearsal), chunked 500/500/500/114 | Idempotent (dedupe `(userId,type,link)`, `NO_OP_ALREADY_IN_STATE` on re-open) | DB only | **COMPATIBLE** — request-triggered, no worker needed, but must respect Vercel 10s limit — 1614 rows 66ms is fine, 5000+ may need longer maxDuration or background via QStash | Keep request-triggered, add `maxDuration` if needed, monitor |
| **Session open ceremony** | Same as notification | Same | Same | Same | Same | Same | Same | Same |

**No persistent workers exist on Vercel** — all jobs above are either one-off, request-triggered, or cron via Vercel Cron / external.

**Recommendation table:**

| Job | Vercel Cron | Database-driven scheduling | External scheduler | Request-triggered | Remove/Redesign |
|-----|-------------|----------------------------|--------------------|-------------------|-----------------|
| Evidence purge | ✅ Yes (Hobby 2 jobs, nightly 3AM) | No | GitHub Actions as fallback | No | No — keep, but as Cron route |
| Backup | ❌ No (needs pg_dump binary) | No | ✅ GitHub Actions + provider built-in | No | No |
| Media migration | ❌ No (one-off long) | No | ✅ Local machine or GH Action | No | No |
| Curriculum reconcile | No | No | No | ✅ Admin action | No |
| Notification fan-out | No | No | No (but QStash for huge fan-outs at scale) | ✅ Yes (on open) | No |

---

## 13. Email / Notifications

### 13.1 Transactional Email (actual inspected)

| Aspect | Current | Vercel Compatibility |
|--------|---------|----------------------|
| **Implementation** | `src/lib/mailer.ts` only place touching SMTP creds, server-only, `nodemailer` transport STARTTLS 587 `requireTLS` TLS≥1.2 timeouts 20s/20s/30s, `sanitizeError` redacts password+user, `sendMailViaSmtp` to/subject/text/html, `smtpDiagnostics` masked, `verifySmtpConnection`; `delivery.ts` `hasDeliveryProvider` + `sendTransactionalEmail` + `DELIVERY_DEV_LOG` redacted log only when not prod | Compatible — outbound TCP allowed on Vercel, but Gmail may block Vercel IPs; Resend API (HTTPS) more reliable serverless |
| **SMTP/provider assumptions** | Gmail SMTP `smtp.gmail.com:587` with App Password 16 chars, `SMTP_USER` Gmail address, `EMAIL_FROM` optional defaults to `SMTP_USER` (Gmail requires From = authenticated) | Gmail works but deliverability risk on Vercel; Resend/SendGrid API better |
| **Teacher activation** | Email sent on approval with activation link `https://<NEXT_PUBLIC_URL>/...?token=<secret>` (token 32 random bytes, SHA-256 stored, 72h TTL, single-use) via `delivery.ts` → `mailer.ts`, audit `TEACHER_ACTIVATION_ISSUED` masked dest, no secret in log | Compatible — link uses `NEXT_PUBLIC_URL` which must be https prod origin |
| **Password reset** | Same via `mailer.ts`, link 15min TTL, identical response for found/unknown/rate-limited (no enumeration), `PASSWORD_RESET_REQUESTED/COMPLETED/FAILED` audit masked | Compatible |
| **Session notifications** | In-app `Notification` rows + optional email? Currently emailEnabled false placeholder (NotificationPreference.emailEnabled default false) — only in-app, not email | Compatible — in-app is DB row, no external |
| **Notification records** | `Notification` table `userId,type,title,message,isRead,link,createdAt` index `[userId,isRead]`; `NotificationPreference` per-type flags + quiet hours; `createNotificationIfAllowed` checks prefs + quiet hours; `createNotificationsIfAllowed` sequential per-user loop (N pref reads + N creates) — P17 adds bulk path `partitionByNotificationPreferences` one bulk pref read + chunked `createMany` 500 + validated optional link + honest sent/skipped counts | Compatible — DB-backed, chunked, but sequential loop in old path could be slow for thousands — bulk path fixes |
| **Deep links** | `notification-links.ts` mints/validates ONLY `lesson:|video:|quiz:|homework:` scheme via one parser `parseDeepLink`, server-side tri-state validation, client navigates via `deep-link.ts` `setView`+`setNavParam`, every deep-linked fetch re-authorized server-side | Compatible — no external |
| **Retry behavior** | No retry — fan-out is chunked sequential, per-chunk `createMany`, if chunk fails, `EMITTED_PARTIAL` synthetic outcome, retry via re-open (idempotent, deduped) — no duplicate rows | Compatible — idempotent |
| **Idempotency** | Per-user dedupe `(type,link)` so count never exceeds one row per user per publication, retry either grows toward eligible set or leaves unchanged; `SessionPublication.notifiedCount/notifiedAt` DB-truth counters | Compatible |
| **Failure handling** | Open route emits only on live publication outcome (OK or NO_OP replay), never downgrades successful publication on notification problem (explicit `EMITTED_PARTIAL`), refusal paths emit nothing; parallel fan-outs serialize on per-lesson mutex (proven double-fire zero duplicates) | Compatible |

**Duplicate-send risk:** Low — dedupe + idempotency key `SessionPublication.lessonId UNIQUE` prevents double publication; notification dedupe prevents double notify on retry.

**Activation/reset URL behavior:** Uses `NEXT_PUBLIC_URL` env — must be real public origin https in production, otherwise email link points to `http://localhost:3000`. Preview env `NEXT_PUBLIC_URL` will be `https://<preview>.vercel.app` — ensure Vercel sets it correctly per environment (Production vs Preview).

**Production domain configuration:** `NEXT_PUBLIC_URL=https://codemind.academy` (or Vercel custom domain). Preview domain: auto `https://<project>-<hash>.vercel.app` — email links in preview will point to preview origin, which is okay for testing but should not be used for real teacher activation (use production for final).

**Notification persistence:** DB rows, not ephemeral.

**Vercel recommendation:**

- Keep `mailer.ts` abstraction, but add Resend adapter: `if (RESEND_API_KEY) use resend else use nodemailer`
- Resend free 100/day, 3000/month — sufficient for MVP (2 ADMIN +1 TEACHER + few students, password reset infrequent)
- Gmail SMTP still works as fallback, but set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` via Vercel env; test via `npm run test:email` from local with prod creds (script `send-test-email.ts` verifies STARTTLS + sends real test email)
- Ensure `DELIVERY_DEV_LOG` unset in production (must be false, otherwise tokens written to log — documented in `.env.example`)
- For teacher activation: email delivery is critical path — if SMTP not configured, flow cannot be completed by real person (documented in `.env.example` comment). Must have provider configured before go-live.

---

## 14. DNS / HTTPS / Caddy

### 14.1 Caddyfile (actual inspected)

```
:81 {
  @transform_port_query { query XTransformPort=* }
  handle @transform_port_query { reverse_proxy localhost:{query.XTransformPort} { header_up Host {host} X-Forwarded-For {remote_host} X-Forwarded-Proto {scheme} X-Real-IP {remote_host} } }
  handle { reverse_proxy localhost:3000 { header_up Host {host} X-Forwarded-For {remote_host} X-Forwarded-Proto {scheme} X-Real-IP {remote_host} } }
}
```

**What Caddy does:**

- Listens on `:81` (plain HTTP, not 80/443 — unusual, maybe sandbox gateway)
- If query `XTransformPort=*`, proxies to `localhost:{port}` (mini-services pattern)
- Else proxies to `localhost:3000` (Next.js standalone)
- Sets `Host`, `X-Forwarded-For`, `X-Forwarded-Proto`, `X-Real-IP` unconditionally (overwrites client-supplied values — important for IP trust)

### 14.2 Mapping to Vercel

| Caddy Responsibility | Classification | Vercel Handling | Action |
|----------------------|----------------|-----------------|--------|
| HTTPS auto Let's Encrypt + renew | **Handled by Vercel** | Vercel auto-provisions and renews Let's Encrypt for any domain pointed at it | Remove Caddy for Vercel path; keep for VPS fallback |
| HTTP→HTTPS redirect | **Handled by Vercel** | Vercel redirects HTTP→HTTPS automatically | No longer needed |
| Security headers (X-Frame-Options etc.) | **Must move to application** | Already in `next.config.ts` `securityHeaders()` — Vercel respects `headers()` | Already moved — keep |
| CSP | **Must move to application** | Same — `content-security-policy.ts` → `next.config.ts` | Already moved — keep, add R2/Blob domains to `media-src`/`img-src` if using object storage |
| `X-Real-IP` overwrite (trust) | **Must move to Vercel configuration + code** | Vercel sets `X-Forwarded-For` + `X-Vercel-Forwarded-For` + `X-Real-IP`? VERIFY CURRENT PROVIDER LIMIT — Vercel docs say `X-Forwarded-For` is client IP + proxies, `X-Real-IP` is client IP, both set by Vercel edge and trustworthy because Vercel edge overwrites client values (similar to Caddy) | Update `clientIpFromHeaders` to prefer `X-Real-IP` then `X-Vercel-Forwarded-For` then first XFF hop; document trust boundary; IP buckets are abuse throttles only, never authz |
| Reverse proxy to `:3000` | **No longer needed** | Vercel serves directly, no reverse proxy | No longer needed |
| `XTransformPort` sidecars | **No longer needed** | Vercel does not support raw TCP sidecars on same host; `mini-services/` is empty (`.gitkeep` only) | No longer needed — remove or move to separate Vercel projects |
| Static files `/public` | **Handled by Vercel** | Vercel CDN for static assets, edge cached | Handled |
| Compression (gzip/brotli) | **Handled by Vercel** | Vercel automatic | Handled |
| Custom domain + DNS | **Must remain external** or Vercel | Vercel Domains dashboard or Cloudflare Free DNS — A/AAAA or CNAME to `cname.vercel-dns.com` | Must move to Vercel configuration |
| Port 81 listener (plain HTTP) | **Must remain external / No longer needed** | Vercel listens on 80/443, not 81; `:81` was sandbox gateway specific | No longer needed for Vercel, but operator should retire `:81` or keep redirect-only per Gate R-2 (plain HTTP listener) |

**DNS / HTTPS checklist for Vercel:**

- Add custom domain `codemind.academy` + `www.codemind.academy` in Vercel dashboard
- DNS: if using Vercel DNS, set NS to Vercel; if using Cloudflare, CNAME `codemind.academy` → `cname.vercel-dns.com` or A record to Vercel IPs (76.76.21.21) — VERIFY CURRENT PROVIDER LIMIT for Vercel IPs
- Vercel auto-provisions TLS (Let's Encrypt), auto-renew, HTTP→HTTPS redirect
- HSTS already emitted by app (`max-age=15552000; includeSubDomains`, no preload) — browsers honor only on secure response, safe to emit unconditionally
- Ensure `NEXT_PUBLIC_URL=https://codemind.academy` matches custom domain

---

## 15. Free-Tier Risks

**Rule: Do NOT invent numeric limits — write VERIFY CURRENT PROVIDER LIMIT where uncertain.**

| Risk Area | Current Usage | Vercel Hobby Free Limit (VERIFY) | Classification | Mitigation |
|-----------|---------------|----------------------------------|----------------|------------|
| **Database storage** | 55 models, 23 lessons, 2 ADMIN+1 TEACHER baseline, ~816K SQLite file in P22 | Neon Free 0.5GB storage, 3GB transfer; Supabase Free 500MB; Vercel Postgres Hobby 256MB — VERIFY CURRENT PROVIDER LIMIT | **Can remain $0 initially** — baseline small, 0.5GB enough for thousands of students (each student row ~few KB, progress ~hundreds bytes per lesson) | Monitor storage via provider dashboard; archive old `SecurityEvent`/`AuditLog` if needed; set retention policy (Phase 22 says do not purge before review) |
| **Database connections** | Prisma singleton, no pooling config currently, `connection_limit` not set | Neon Free 100 concurrent connections, but serverless functions may open many connections quickly (each cold start opens pool) — VERIFY CURRENT PROVIDER LIMIT | **May become paid with moderate usage** — serverless without pooling can exhaust connections | Set `?connection_limit=10` in `DATABASE_URL`, use Neon built-in pooling (`?pgbouncer=true`) or Prisma Accelerate (free tier 10M queries?) — VERIFY; monitor `pg_stat_activity` |
| **Storage (PDF/video/evidence)** | PDF 25MB max, video 512MB max, image 5MB max, no quota by default | R2 Free 10GB storage, 10M Class A/B ops, free egress; Vercel Blob Hobby free tier (1GB? 100GB bandwidth?) — VERIFY CURRENT PROVIDER LIMIT | **Can remain $0 initially** — 10GB enough for hundreds of PDFs (25MB each → 400 PDFs) + videos (512MB each → 20 videos) — but video 512MB is large for free tier | Set `MEDIA_QUOTA_BYTES` to 80% of free tier (e.g. 8GB for R2), monitor via provider; implement presigned uploads to bypass Vercel body limit; compress videos externally before upload |
| **Video bandwidth** | Session videos streamed via authorized routes, Range support | Vercel Hobby 100GB bandwidth/month, R2 free egress unlimited — VERIFY | **May become paid with moderate usage** — video is bandwidth-heavy (1 student watching 10 videos 100MB each = 1GB) | Use R2 (free egress) not Vercel Blob for videos (Blob charges egress); signed URL redirect to R2 so bandwidth is R2 not Vercel; cache via Cloudflare CDN free |
| **PDF bandwidth** | PDFs 25MB, streamed via authorized routes | Same as video | **Can remain $0 initially** — PDFs smaller, less frequent | Same — R2 free egress, signed URLs |
| **Large uploads** | Video 512MB, PDF 25MB, image 5MB — all exceed Vercel 4.5MB body limit | Vercel Hobby body limit 4.5MB — VERIFY CURRENT PROVIDER LIMIT | **BLOCKER for direct upload** — must use presigned | Implement presigned PUT flow (client→R2 directly, bypass Vercel); server validates magic bytes after upload via HEAD or small download |
| **Serverless execution** | 98 API routes, some long (ai-generate-quiz ~30s), notification fan-out 66ms for 1614 rows | Vercel Hobby 10s function duration, 1000 GB-hours/month — VERIFY | **May become paid** — AI quiz 30s exceeds Hobby 10s, needs Pro 60s or background job | Add `maxDuration` export, or move AI quiz to background via QStash + callback, or use streaming; monitor duration via Vercel logs |
| **Function execution** | Each request is function invocation, DB read per session lookup + per rate limit | Vercel Hobby 100k invocations? Actually Hobby unlimited invocations but GB-hours limited — VERIFY | **Can remain $0 initially** — 2 ADMIN+1 TEACHER+ few students low traffic | Monitor via Vercel dashboard; optimize with edge caching for public routes (`/api/courses`, `/api/settings/public`) |
| **Cron** | 2 jobs needed (purge evidence, maybe backup trigger) | Vercel Hobby 2 cron jobs, min interval 1h — VERIFY | **Can remain $0 initially** — 2 jobs exactly Hobby limit | Use Vercel Cron for purge + health check; backup via provider built-in not cron |
| **Email** | Password reset, teacher activation — infrequent | Resend Free 100/day, 3000/month; Gmail SMTP free but deliverability risk | **Can remain $0 initially** — low volume | Use Resend for better deliverability; monitor quota |
| **Notifications** | In-app DB rows, fan-out chunked 500, 66ms for 1614 rows | DB writes per notification row — Neon free 3GB transfer, Supabase 2GB bandwidth | **Can remain $0 initially** — 1614 rows per publish is okay, but 5000+ may be heavy | Chunk size 500, monitor DB transfer; at scale use batch + QStash |
| **Builds** | `prisma generate && next build` — needs network, 1.3s compile + typecheck (but typecheck fails currently) | Vercel Hobby 100 builds/month? Actually 6000 build minutes? VERIFY | **Can remain $0 initially** — few builds | Fix type errors to make build pass; cache Prisma engines |
| **Monitoring** | Vercel logs + analytics free, no custom | Vercel Hobby logs 1h retention? 1 day? VERIFY | **Can remain $0 initially** | Use Vercel built-in, add Sentry Free for errors |
| **Logs** | `server.log` file currently, but Vercel uses its own logs | Vercel Hobby log retention limited — VERIFY | **Can remain $0 initially** | Use Vercel logs, no file |
| **Traffic spikes** | Enrollment, publish fan-out, quiz submit bursts | Vercel auto-scales serverless, but DB connections may spike | **May become paid** — spikes may exhaust DB connections or bandwidth | Implement connection pooling, rate limiting (already), CDN for static |
| **Concurrency** | Rate limit race-free via guarded updateMany, 40 concurrent against limit 10 admits exactly 10 | DB row-level locking on PG MVCC, but high concurrency may cause contention on `SecurityRateLimit` row | **Can remain $0 initially** — low concurrency MVP | Monitor via `verify-phase20-security.mjs` probe; at scale consider Redis rate limit (Upstash Redis Free) |

**Never promise unlimited free production operation** — free tier is for MVP, moderate usage will trigger paid.

---

## 16. Exact Deployment Sequence

Adapted from `GO_LIVE_RUNBOOK.md` §1-17 and `POSTGRES_CUTOVER_RUNBOOK.md`, translated for Vercel.

```
P22 final verification (149/149 final-integration, 27 suites, 9 verifiers, FK 0, backup SHA256, 2 ADMIN+1 TEACHER baseline, 23 lessons)
→ provider selection (Neon Free PG + Cloudflare R2 Free + Resend Free + Vercel Hobby — verify limits)
→ PostgreSQL provisioning (Neon: create project codemind, db codemind, roles, connection string ?sslmode=require&connection_limit=10&pgbouncer=true if needed, record in secret manager)
→ durable storage provisioning (R2: create bucket codemind-media private, API token with PutObject/GetObject/DeleteObject/ListBucket, endpoint, region auto, bucket name; Vercel Blob as fallback)
→ schema migration (derive artifacts: node scripts/db/make-postgres-schema.mjs + --check, apply baseline psql -f postgres-baseline.sql on empty PG)
→ data migration (loader: node scripts/db/migrate-sqlite-to-postgres.mjs --source db/custom.db --target $DATABASE_URL --manifest pg-load.json — one transaction, count+hash verified, _prisma_migrations excluded)
→ migration validation (verify-postgres.mjs --target $DATABASE_URL → VERIFY_POSTGRES_OK, manifest counts vs SQLite snapshot, orphan 0, duplicate 0, lifecycle D1-D4, security tables, rate-limit probe, app queries G1-G7)
→ storage/media migration (migrate-media.mjs --source ./storage/media --dest R2 via S3 adapter --manifest media.json --check, SHA-256 per file, never deletes source, two-person delete after second --check)
→ external service configuration (Resend API key + domain verification + from address, or Gmail SMTP App Password; set EMAIL_FROM; ensure DELIVERY_DEV_LOG unset in prod)
→ environment variables (Vercel dashboard: DATABASE_URL PG, NEXT_PUBLIC_URL https://codemind.academy, SECURITY_HASH_SECRET 64-hex, SMTP_* or RESEND_API_KEY, STORAGE_BACKEND=s3, S3_* or BLOB_READ_WRITE_TOKEN, CRON_SECRET random 32, RATE_LIMIT_*, TEACHER_ACTIVATION_TTL_HOURS, MEDIA_MAX_*_BYTES, QUIZ_EVIDENCE_RETENTION_DAYS, MEDIA_QUOTA_BYTES 8GB, etc. — Production + Preview, server-only except NEXT_PUBLIC_URL)
→ DNS/domain configuration (Vercel dashboard Domains: add codemind.academy + www, DNS CNAME to cname.vercel-dns.com or A to Vercel IPs, auto HTTPS, HSTS already via app)
→ Vercel configuration (vercel.json crons + functions maxDuration, packageManager bun, install command bun install, build command prisma generate && next build, Node 22.x, env vars, framework Next.js)
→ preview deployment (git push to arena branch → Vercel auto preview deploy, check build logs for prisma generate success + typecheck 0 errors — must fix 15 TS errors first)
→ preview verification (health GET /api/ → 200, public routes /api/courses, /api/settings/public, auth me 401 without cookie, login throttling 10×401→429, CSP header present no unsafe-eval object-src none frame-ancestors self, HSTS present, teacher application submit→PENDING no User, admin approval→APPROVED+email+token, activation→TEACHER+login 200+cookie, student register→enroll→open lesson→quiz→PDF download via signed URL, parent link→dashboard, teacher dashboard, admin dashboard, notification fan-out, evidence purge cron dry-run)
→ production deployment (merge to main → Vercel auto production deploy, or promote preview to production)
→ production migrations (if any pending: npx prisma migrate deploy --schema schema.postgresql.prisma, or baseline ledger prisma migrate resolve --applied)
→ health checks (curl -i https://codemind.academy/api/ → 200, curl -s https://codemind.academy/ | grep codemind, logs tail via Vercel dashboard)
→ authentication verification (student register 8+ chars, parent triple match, admin login, teacher application→approval→activation→login full chain 11 steps from GO_LIVE_RUNBOOK §9, negative cases blocked: rejection→REJECTED token rescinded, duplicate→409, unauthorized approval→401/403, self-approval→401, replay→400, expired→400, wrong-app→400, before approval→400, after rejection→400, public role escalation→blocked)
→ Teacher Application verification (see above)
→ Teacher Activation verification (same)
→ Student verification (register, enroll course→group→plan→payment wizard, see correct curriculum 23 lessons, locked-but-visible skeletons, open only eligible, video progress 95%, quiz freeze, homework submit, PDF download authorized, gamification, certificate 80%)
→ Parent verification (link via nationalId+studentCode+parentPhone identical 404, dashboard per-child universe, analytics per-child, weekly report, notification prefs)
→ Teacher verification (dashboard own courses, lessons dual-chain, quizzes POST no schoolType? Actually now schoolType tagged, homework create, analytics finished-only course-scoped, attendance, templates)
→ Admin verification (2 ADMIN preserved, students/teacher/groups/payments/subscriptions/coupons/question-bank/mock-exams/session-videos/quiz-review/notifications-center/settings/overview/export-progress/revenue, lesson CRUD, readiness checklist, open ceremony idempotent, recipient preview = fan-out query)
→ PDF verification (upload via presigned 25MB, magic bytes %PDF-, MIME application/pdf, extension .pdf sanitized, size cap, no temp files, served only via /api/materials/[id] authorized 10-check, Range strict 416, disposition inline vs download=1, no-store, refcounted delete)
→ video verification (upload via presigned 512MB multipart, batch+track+published gate, /api/media/[id] authorized, Range, no-store, progress heartbeat wall-clock monotonic capped, 95% threshold)
→ quiz verification (attempt freeze 3→4 not mutate open attempt, server grading, client score never read, sanitized selected, finished immutable, teacher analytics finished-only)
→ homework verification (POST student-side gated, SUBMITTED/LATE, graded immutable, upsert unique pair, teacher grade PATCH own courses)
→ notification verification (publish via open → targeted fan-out course×track×active at publish time, preference-aware bulk partition, deep-linked lesson:|video:|quiz:|homework: validated, idempotent dedupe, chunked 500, counters notifiedCount/notifiedAt, audit LESSON_PUBLICATION_NOTIFY, broadcast no longer bypasses prefs)
→ security verification (10-check contract matrix route×check, IDOR non-oracle 404 vs 403, cross-track/cross-course/premature/PDF-guess/link-bypass denied, rate limiting deterministic bounded observable race-free 40 concurrent→10 admit, CSP header no unsafe-eval object-src none frame-ancestors self, legacy session fallback removed provable precondition audit-legacy-sessions.mjs, HSTS, secure cookies httpOnly lax, proxy defense-in-depth)
→ monitoring verification (GET /api health, error logging Vercel logs, slow queries Prisma log error+warn + PG pg_stat_statements, DB health SELECT 1 + verify-postgres.mjs, backup status provider dashboard age <25h, media health df? Actually R2 dashboard + HEAD /api/media/[id] signed URL, notification metrics count+preference distribution+publication→notification linkage, storage usage R2 dashboard vs MEDIA_QUOTA_BYTES, quota alerts 413)
```

**Rollback checkpoints (after each major step):**

- After backup: rollback is re-point to SQLite snapshot (no data loss)
- After PG provisioning: drop PG, re-point to SQLite (no data loss)
- After schema migration: drop PG, re-apply baseline, re-load (no data loss if SQLite snapshot preserved)
- After data migration: if validation fails, STOP and roll back per §7 of POSTGRES_CUTOVER_RUNBOOK (SQLite untouched)
- After storage migration: keep source tree until second --check succeeds (two-person step)
- After Vercel config: revert env vars, re-deploy previous Vercel deployment (Promote to Production)
- After preview: no prod impact, delete preview
- After production deployment: Vercel rollback via dashboard → previous deployment → Promote to Production (immediate), plus DB rollback via re-point to SQLite if inside freeze window, else restore latest verified PG backup into fresh DB + re-point (RPO = last backup)

---

## 17. Production Verification Checklist

For every check define Test, Expected Result, Pass Condition.

| Area | Test | Expected Result | Pass Condition |
|------|------|-----------------|----------------|
| **Database** | `node scripts/db/verify-postgres.mjs --target $DATABASE_URL` | `VERIFY_POSTGRES_OK` 19 checks | Exit 0 + string `VERIFY_POSTGRES_OK` |
| **Curriculum** | `npx tsx scripts/reconcile-curriculum.ts` twice | First run 23 official lessons created or 0 if already, second run 0 created 0 updated 0 archived | Second run zero writes + 2 Parts/7 Units/23 Lessons 1-1…7-3 |
| **Parts** | Query `Part` count | 2 | Count 2, titles `Part One`/`Part Two` |
| **Units** | Query `Unit` count | 7 | Count 7, orders 1…7, part-linked |
| **Official Lessons** | Query `Lesson` where `curriculumStatus=OFFICIAL` | 23 | Count 23, `officialCode` unique 1-1…7-3, `unitId` valid, no archived in active universe |
| **Tracks** | `Student.schoolType` enum | ARABIC/LANGUAGE/NULL | NULL fails closed to SHARED-only, ARABIC sees SHARED+ARABIC, LANGUAGE sees SHARED+LANGUAGE |
| **Lifecycle** | `Lesson.status` + `SessionPublication` | DRAFT→READY→PUBLISHED, `lessonId UNIQUE` idempotency, `PUBLISHED_ARABIC` not a state | Transition table green, idempotent open returns `NO_OP_ALREADY_IN_STATE` 200 no duplicate notification |
| **Progression** | `getCourseSessionProgress` universe | Exactly 23 official lessons, track-filtered, ordered via `orderCourseLessons` Part→Unit→Topic→Lesson→id | Student sees only eligible + locked skeletons, not DRAFT/READY, prev/next via same order |
| **Authentication** | `POST /api/auth/login` 10× wrong password same email | 10×401 then 429 `RATE_LIMITED` + `Retry-After` + `X-RateLimit-*`, no existence oracle (unknown email same 401→429) | 429 shape correct, `SecurityEvent LOGIN_FAILED` rows written, success clears `login:id` bucket |
| **Authorization** | `requireRole` on `/api/admin/*` anon/student/teacher/parent | 401 anon, 403 other roles, 200 admin | All 98 routes either `requireUser`/`requireRole`/`requireAdmin` or deliberately public (login/register/teacher-apply/password-reset/teacher-activate/settings public) |
| **Sessions** | Login → `UserSession` row + `cm_session` cookie, then same-device re-login, then different-device login | First login 200 cookie, second same-device rotates token no suspension, third different-device within 30min → revoke all + suspend `SUSPENDED_MULTI_DEVICE` + `isActive false` + audit | Cookie httpOnly lax secure path `/` 7d, `lastSeenAt` throttled 1min, conflict detection accurate |
| **Password Reset** | Request for real + fake email | Identical 200 generic, no enumeration, rate limit per email 3/15min + IP 10/hr, token SHA-256 stored, raw never logged/returned, new request invalidates previous, single-use `usedAt` same transaction as password change, replay/expiry/attempt-limit 5 uniform error, scrypt hash, all sessions revoked | Email received with link `NEXT_PUBLIC_URL` https, 15min TTL, confirm sets new password 8+ chars, login with new works, old sessions 401 |
| **Teacher Application** | Public submit TEACHER role | 200 `applied:true`, DB `TeacherApplication` PENDING, no User, no session, duplicate/existing/ADMIN cases 409/400 generic no oracle | Rate limit `teacherApply` 5/3600/3600 per email hashed, audit `TEACHER_APPLICATION_SUBMITTED/BLOCKED` masked dest |
| **Teacher Activation** | Admin approve PENDING → email with link, then activate via token + password | Approve 200 `alreadyApproved:false`, email captured, `TeacherActivationToken` row `tokenHash==sha256(secret)`, idempotent re-approve no second email one live token, reject→REJECTED no account, re-apply reopens same row PENDING, activation→User TEACHER+Teacher+ACTIVATED+consumed token, replay→400 one account, expired→400 no account, login 401 before 200 after with `cm_session` cookie + `/me` role TEACHER, new teacher cannot approve others, 7 audit types no password/raw token | Full chain 11 steps from GO_LIVE_RUNBOOK §9 + negative cases blocked |
| **Admin** | Login as `mudiifathii@gmail.com` (first admin) | 200 + dashboard data, 2 ADMIN +1 TEACHER preserved, 0 STUDENT/PARENT initially, no demo users, no broken FKs | `phase22-final-integration.mjs` reports Before/After/Deleted/Preserved per category, `PRAGMA foreign_key_check` [] |
| **Teacher** | Login as `muhammedfathi2005@gmail.com` | Dashboard own courses, lessons dual-chain, quizzes POST schoolType tagged, homework create, analytics finished-only course-scoped | No cross-course leak, `attemptInQuizScope` |
| **Student** | Register STUDENT ARABIC + LANGUAGE, enroll | Course tree shows 23 official lessons, locked-but-visible skeletons, open only eligible, video progress 95% monotonic, quiz freeze, homework submit, PDF download authorized, gamification XP/levels/badges, certificate 80% | Unlock rule `video≥95% AND quiz AND assignment` sequential, redaction `videoUrl/pdfUrl/summary/description/quiz/homework` hidden for locked, `hasQuiz/hasAssignment` presence flags only |
| **Parent** | Register PARENT triple match, link child | Dashboard per-child universe, analytics per-child, weekly report per-child, notification prefs, link enumeration oracle closed identical 404 messages | `getParentCourseIds` via same `getEnrollment` rule, `isParentAuthorizedForCourse` 403 foreign, lesson/quiz 404 foreign, multi-child ARABIC 20 vs LANGUAGE 19 denominators |
| **PDF** | Upload PDF 25MB via presigned, download via `/api/materials/[id]` | MIME `application/pdf` only, magic `%PDF-` within 1024, extension `.pdf` sanitized, size cap, no temp files, authorized 10-check, Range strict 416, disposition inline vs download=1, no-store, refcounted | Cross-track/cross-course/locked/unpublished/archived denied non-oracle 404, `MATERIAL_ACCESSED` audit |
| **Video** | Upload video 512MB via presigned multipart, download via `/api/media/[id]` signed URL redirect | Batch+track+published gate, track derived server-side from own `schoolType` never URL batch id (sticky-batchId hole closed), Range, no-store, progress heartbeat wall-clock monotonic capped, 95% threshold, seeking to end not complete | Cross-batch 403, cross-track 404, unpublished 404, archived excluded |
| **Quiz** | Start quiz, add question mid-attempt, submit | Attempt frozen as `QuizAnswer` rows at start, refresh/navigation/logout-login byte-identical, questions added later only future attempts, server grading over own set, client score never read, sanitized selected, finished immutable retake new row | `@@unique([attemptId,questionId])`, no cross-write with `ExamAttempt` |
| **Homework** | Submit homework, grade | POST student-side gated `canAccessHomework`, `SUBMITTED/LATE`, graded immutable, upsert unique pair, teacher grade PATCH own courses | `maxMarks` honored, fileUrl not yet upload path (text-only) |
| **Notifications** | Open lesson via `POST /api/admin/lessons/[id]/open` | Targeted fan-out `(active student × enrolled course × trackScope)` at publish time, preference-aware bulk partition one bulk pref read + chunked `createMany` 500 + validated optional link + honest sent/skipped, deep-linked `lesson:<id>` validated server-side, idempotent dedupe `(userId,type,link)`, counters `notifiedCount/notifiedAt` DB-truth, audit `LESSON_PUBLICATION_NOTIFY`, broadcast no longer bypasses prefs, parallel fan-outs serialize on mutex zero duplicates | Load rehearsal 1/10/100/500/1000+ ⇒ 66ms at 1614 rows over chunks 500/500/500/114 zero duplicates, outcome codes `EMITTED/ALREADY_DELIVERED/SUPPRESSED_BY_PREFERENCES/EMITTED_PARTIAL/NO_RECIPIENTS` |
| **Audit** | Check `SecurityEvent` + `AuditLog` | All events present, IP hashed, UA truncated, no raw token/email/IP in `SecurityRateLimit`/`SecurityEvent`, no password/raw token in 7 teacher types | `verify-security-audit-gate.mjs` 71/71, `verify-security-audit-gate-browser.mjs` 43/43 |
| **Security** | 10-check contract matrix, IDOR, cross-track/cross-course/premature/PDF-guess/link-bypass, rate limiting, CSP, legacy fallback removal, HSTS, cookies | All green, non-oracle denials, 40 concurrent→10 admit exact, CSP no unsafe-eval object-src none frame-ancestors self, legacy `Setting:session:*` removed provable precondition `audit-legacy-sessions.mjs` STILL-VALID/expired/malformed, HSTS max-age 15552000 includeSubDomains | `security-hardening-phase20.test.js` 185/185, `verify-phase20-security.mjs` 42/42, `verify-phase20-http.mjs` 26/26 |
| **Arabic / RTL** | UI in Arabic mode | `dir=rtl`, `lang=ar`, Cairo font, `shell.027…038` nav keys not bare English, scheduler weekday headers `tr(d)` not raw keys, `translate()` never returns dotted key, `looksLikeDictKey/hasDictKey/dictSize` | No raw key leak `student.198…204`, month nav `dir=ltr` stable, dark-mode selected/today styles, touch targets, `role=grid` + localized aria-labels |
| **English / LTR** | UI in English mode | `dir=ltr`, `lang=en`, same but LTR | Same checks, DB-seed residue still Arabic under EN pre-existing known limitation |
| **Mobile** | Responsive 390/834/1440 | Draggable Kodgy clamped per-locale localStorage, responsive, light/dark, RTL/LTR, reduced-motion | Touch + mouse, viewport-clamped |
| **Desktop** | Same | Same | Same |

---

## 18. Rollback Plan

### 18.1 Application Deployment (Vercel)

**Trigger:** Build fails, typecheck fails, health check fails, smoke tests fail, security matrix fails, or any Critical/High blocker.

**Procedure:**

```
Vercel dashboard → Project → Deployments → Find previous working deployment → ... → Promote to Production (immediate)
```

- Vercel rollback is instant, no rebuild, previous artifact becomes live
- Preserve forensics: download build logs, function logs, check `vercel logs --since 1h`
- If env vars caused failure, revert env vars in dashboard → redeploy (or promote previous with correct env)
- No local filesystem reliance after deployment (Vercel ephemeral)

**RTO:** <1 minute (promote)

### 18.2 Database Schema Migration (PostgreSQL)

**Trigger:** `prisma migrate deploy` fails, `verify-postgres.mjs` fails, app errors implicate schema, `migrate status` shows drift.

**Procedure:**

- **If inside freeze window (SQLite snapshot preserved, PG not yet serving traffic):** Stop app → Drop PG database → Recreate empty → Re-apply baseline `postgres-baseline.sql` → Re-run loader from SQLite snapshot → Re-run battery → Switch `DATABASE_URL` back to SQLite if needed → Smoke tests
- **If post-go-live (PG serving):** DO NOT `migrate reset`/`db push --accept-data-loss`/`DROP DATABASE`/`TRUNCATE ALL`/`blind delete/reseed`/`destructive production seed` — all forbidden by production-safety principle. Instead: create new migration that reverts schema change (e.g. `DROP COLUMN` if added, or `ADD COLUMN` nullable if dropped) via `prisma migrate dev` on staging, test, then `prisma migrate deploy` on prod. If migration is destructive and cannot be reverted, restore latest verified backup into FRESH database + re-point (RPO = last backup) per `restore-postgres.sh` (enforces empty-target + sha256 + battery)

**Preserve:** Official curriculum, subscription plans, settings, security/audit records, media metadata, Teacher Applications — never delete generically.

### 18.3 Data Migration (SQLite→PG)

**Trigger:** Loader fails count+hash verification, battery fails orphan/duplicate/lifecycle/security, smoke tests fail.

**Procedure:**

- Loader is ONE transaction — on ANY failure it rolls back and exits non-zero, target remains empty — fix cause, re-empty target, re-run (no partial state)
- If validation fails after commit (should be impossible because verification inside transaction, but if battery after commit fails): STOP, do not switch traffic, root-cause from manifest + battery output + app logs, PG left AS-IS for forensics, rollback is re-point to SQLite file (`DATABASE_URL=file:./db/custom.db`) + media tree (`MEDIA_STORAGE_PATH=./storage/media`) → start app → smoke tests
- Data-loss window rule: writes accepted on PG between switch and rollback decision NOT in SQLite — if window accepted writes, ONLY fix-forward on PG supported — rolling back to SQLite after PG accepted writes DISCARDS those writes

**Rollback decision point:** Within first hour after switch, before announcing freeze window closed, smoke tests must run.

### 18.4 Media Migration

**Trigger:** `migrate-media.mjs --check` fails SHA-256, missing files, permission errors, S3 upload fails.

**Procedure:**

- Migration tool NEVER deletes source — source tree preserved until second successful `--check` (two-person step: one runs `--check`, one deletes)
- For local FS → R2: if upload fails, list objects via S3 ListObjectsV2, compare manifest, re-upload failed keys, re-run `--check`
- For R2 → local FS rollback (inside freeze window): re-point `MEDIA_STORAGE_PATH` to old tree or `STORAGE_BACKEND=local`, start app, spot-check one PDF + one video + one evidence via authorized routes
- Orphan handling: list S3 objects not referenced by `MediaAsset` → report, manual review, delete after 30d
- DB/file consistency: SHA-256 per file before+after, manifest JSON, deterministic sorted inventory, symlinks skipped

**RTO:** Minutes (re-point)

### 18.5 Environment / Configuration

**Trigger:** Wrong `NEXT_PUBLIC_URL` causes email links to localhost, `SECURITY_HASH_SECRET` missing causes fail-fast, `DATABASE_URL` wrong causes connection errors, `SMTP_*` missing causes no email delivery, `STORAGE_BACKEND` wrong causes upload fail, `CRON_SECRET` missing causes cron 401.

**Procedure:**

- Vercel dashboard → Settings → Environment Variables → Edit → Save → Redeploy (or promote previous deployment with correct env)
- For secrets: never commit, mode 0600, secret manager, redacted in logs
- For `SECURITY_HASH_SECRET`: generate `openssl rand -hex 32`, set in Vercel, runtime fail-fast via `instrumentation.ts` will surface 500 if missing — fix immediately
- For `DATABASE_URL`: set PG URL with `?sslmode=require&connection_limit=10`, test via `psql $DATABASE_URL -c "SELECT 1"`, then redeploy
- For `NEXT_PUBLIC_URL`: must be `https://codemind.academy` prod, `https://<preview>.vercel.app` preview — email links depend on it

**Rollback:** Revert env var to previous value in dashboard → redeploy or promote previous deployment.

### 18.6 DNS / Domain

**Trigger:** Custom domain not resolving, TLS not provisioning, `NEXT_PUBLIC_URL` mismatch, email links wrong origin.

**Procedure:**

- Vercel dashboard → Domains → Check DNS config, CNAME to `cname.vercel-dns.com` or A to Vercel IPs — VERIFY CURRENT PROVIDER LIMIT for IPs
- DNS propagation may take minutes to hours — wait, check via `dig codemind.academy` + `curl -i https://codemind.academy`
- If TLS fails, Vercel auto-retries Let's Encrypt — check dashboard for errors, ensure DNS correct, no CAA blocking
- If domain rollback needed: remove custom domain from Vercel, point DNS back to old VPS IP, start old Caddy + standalone server, verify health `GET /api/`

**RTO:** DNS TTL dependent (minutes to hours)

**Forensics preservation:** Before any destructive restore, preserve logs, manifests, DB snapshot, media backup.

---

## 19. Cost Model

**Target: $0/month initially**

| Provider | Purpose | Free-Tier Suitability | Possible Paid Trigger | Current Limits/Pricing That Require Verification |
|----------|---------|----------------------|----------------------|--------------------------------------------------|
| **Vercel Hobby** | Hosting Next.js 16 + API routes serverless, HTTPS, CDN, preview deploys, cron 2 jobs | **REQUIRED FOR MVP** — Hobby free generous for MVP: 100GB bandwidth, 1000 GB-hours, 100k? invocations — VERIFY CURRENT PROVIDER LIMIT | Bandwidth >100GB, GB-hours >1000, function duration >10s (Hobby) → needs Pro $20/month per seat — VERIFY | VERIFY CURRENT PROVIDER LIMIT: bandwidth, GB-hours, invocations, build minutes, cron jobs (2 Hobby), function duration (10s Hobby, 60s Pro, 900s Enterprise), body size limit (4.5MB Hobby) |
| **Neon Free PostgreSQL** | Replace SQLite, 55 models, 21 enums, FKs, durable | **REQUIRED FOR MVP** — Free 0.5GB storage, 3GB transfer, 100 concurrent connections, autosuspend, branching — VERIFY | Storage >0.5GB, transfer >3GB, connections >100, compute hours >100h/month → paid $19/month — VERIFY | VERIFY CURRENT PROVIDER LIMIT: storage, transfer, connections, compute hours, branching limits, pooling |
| **Cloudflare R2 Free** | Private PDFs, session videos, quiz evidence — replace local FS | **REQUIRED FOR MVP** — Free 10GB storage, 10M Class A ops, 10M Class B ops, free egress (key for video) — VERIFY | Storage >10GB, ops >10M → paid $0.015/GB storage + $0.36/M Class A + $0.36/M Class B — VERIFY | VERIFY CURRENT PROVIDER LIMIT: storage, Class A (writes), Class B (reads), egress (free), bucket count |
| **Resend Free** | Transactional email password reset + teacher activation | **REQUIRED FOR MVP** — Free 100 emails/day, 3000/month, 1 domain — VERIFY | Emails >100/day or >3000/month → paid $20/month — VERIFY | VERIFY CURRENT PROVIDER LIMIT: daily/monthly quota, domain verification, from address |
| **Vercel Cron** | Nightly evidence purge | **OPTIONAL initially** but REQUIRED for retention compliance — Hobby 2 cron jobs free | More than 2 cron jobs → needs Pro or external scheduler | VERIFY CURRENT PROVIDER LIMIT: cron jobs count (2 Hobby), min interval (1h Hobby?), maxDuration |
| **Vercel Analytics / Logs** | Monitoring error logging, slow queries, DB health, media health, notification metrics | **OPTIONAL** — Built-in free, logs retention limited (1h? 1d? VERIFY), analytics free | Log retention > free → paid, analytics events > free → paid | VERIFY CURRENT PROVIDER LIMIT: log retention, analytics events |
| **Cloudflare DNS Free** | Custom domain, DNS, CDN for R2 signed URLs | **REQUIRED for custom domain** — Free DNS, CDN, DDoS | None for DNS — free forever | VERIFY CURRENT PROVIDER LIMIT: DNS queries, CDN bandwidth |
| **GitHub Actions Free** | External cron for backup (pg_dump → R2), media migration one-off, CI | **OPTIONAL** — Free 2000 minutes/month, 500MB storage | Minutes >2000 → paid | VERIFY CURRENT PROVIDER LIMIT: minutes, storage, concurrent jobs |
| **Upstash Redis Free** | Optional rate limiting at scale (replace DB-backed with Redis for high concurrency) | **MAY BECOME PAID AT SCALE** — Free 10k commands/day, 256MB — VERIFY | Commands >10k/day → paid $10/month | VERIFY CURRENT PROVIDER LIMIT: commands, storage, bandwidth |
| **Upstash QStash Free** | Optional background jobs for huge notification fan-outs or AI quiz generation | **MAY BECOME PAID AT SCALE** — Free 500 messages/day — VERIFY | Messages >500/day → paid $10/month | VERIFY CURRENT PROVIDER LIMIT: messages, retries, DLQ |
| **Sentry Free** | Error monitoring | **OPTIONAL** — Free 5k errors/month | Errors >5k → paid $26/month | VERIFY CURRENT PROVIDER LIMIT: errors, transactions, replays |
| **Supabase Free** (fallback for PG+Storage) | Alternative to Neon+R2 — 500MB DB, 1GB storage, 2GB bandwidth, 50k MAU | **OPTIONAL fallback** — Good all-in-one free | DB >500MB, storage >1GB, bandwidth >2GB → paid $25/month | VERIFY CURRENT PROVIDER LIMIT: DB size, storage, bandwidth, MAU, connection pooling |

**Cost separation:**

- **REQUIRED FOR MVP ($0):** Vercel Hobby + Neon Free + R2 Free + Resend Free + Cloudflare DNS Free = $0/month (within free tiers for baseline 2 ADMIN+1 TEACHER+ few students)
- **OPTIONAL ($0 but recommended):** Vercel Cron (free 2 jobs) for purge, Vercel Analytics/Logs free, GitHub Actions free for backup
- **MAY BECOME PAID AT SCALE:** Vercel Pro $20/seat (if need 60s duration for AI quiz or >100GB bandwidth), Neon Pro $19/month (if >0.5GB storage or >3GB transfer), R2 paid (if >10GB storage), Resend paid (if >100/day), Upstash Redis/QStash (if high concurrency/fan-out), Sentry (if many errors)

**Never invent numbers** — all limits above marked VERIFY CURRENT PROVIDER LIMIT must be checked against current authoritative provider docs at deployment time.

---

## 20. Final Recommended Architecture

**Target $0/month MVP that preserves all security and production-safety principles:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Vercel Hobby (Free)                              │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Next.js 16.3.4 + React 19 + Tailwind 4 + Zustand SPA            │  │
│  │  src/proxy.ts (defense-in-depth cookie-presence 401)              │  │
│  │  next.config.ts securityHeaders() + CSP via content-security-    │  │
│  │  policy.ts (no unsafe-eval, unsafe-inline only for Next.js +     │  │
│  │  framer-motion/recharts) + HSTS                                   │  │
│  │  instrumentation.ts fail-fast SECURITY_HASH_SECRET                │  │
│  │  98 API routes: auth, admin, teacher, students/me, parents/me,    │  │
│  │  courses, lessons, quizzes, media, materials, notifications,      │  │
│  │  cron/purge-evidence (CRON_SECRET)                                │  │
│  │  src/lib: auth (scrypt, UserSession SHA-256, single-device),     │  │
│  │  security (sha256, hashIp, clientIpFromHeaders, checkRateLimit   │  │
│  │  race-free, logSecurityEvent), rate-limit (7 keys, clamped),     │  │
│  │  env (fail-fast), media (S3 adapter + local fallback + presigned │  │
│  │  upload flow + magic bytes validation), storage-quotas (S3       │  │
│  │  bucket quota), evidence-retention (retainUntil rule), session-  │  │
│  │  progress (single source enrollment+course+track+lifecycle+      │  │
│  │  progression), track-scope (canAccessTrackScope), parent-access, │  │
│  │  enrollment (Group→Course sole gate), teacher-applications       │  │
│  │  (PENDING→APPROVED→ACTIVATED), session-lifecycle (DRAFT/READY/   │  │
│  │  PUBLISHED, SessionPublication UNIQUE), session-materials (10-   │  │
│  │  check), session-notifications (targeted fan-out chunked 500,    │  │
│  │  deduped, counters), notify (bulk prefs partition), mailer (SMTP │  │
│  │  + Resend adapter), delivery (hasDeliveryProvider)               │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                    │                                    │
│                                    │ Prisma Client (pg driver,          │
│                                    │ connection_limit=10,               │
│                                    │ ?sslmode=require&pgbouncer=true)   │
│                                    ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Neon Free PostgreSQL (or Supabase Free / Vercel Postgres)       │  │
│  │  55 models, 21 enums, 73 FKs, 34 UNIQUEs, 67 indexes             │  │
│  │  Derived from prisma/schema.prisma via make-postgres-schema.mjs  │  │
│  │  Baseline postgres-baseline.sql 143 statements                   │  │
│  │  Loader migrate-sqlite-to-postgres.mjs one transaction verified   │  │
│  │  Battery verify-postgres.mjs 19 checks + G1-G7 app queries        │  │
│  │  Built-in PITR + daily backups (provider) + optional GH Action   │  │
│  │  pg_dump → R2                                                    │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                    │                                    │
│                                    │ S3 SDK (@aws-sdk/client-s3)        │
│                                    │ presigned PUT + GET 15min          │
│                                    ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Cloudflare R2 Free Private Bucket (codemind-media)              │  │
│  │  10GB storage, 10M ops, free egress                              │  │
│  │  Keys: pdf/<random>.pdf, video/<random>.mp4,                     │  │
│  │  evidence/<attemptId>/<random>.jpg                               │  │
│  │  Private, no public list, signed URLs short-lived 15min,         │  │
│  │  Cache-Control private no-store, Range via R2, disposition       │  │
│  │  inline vs download=1, refcounted delete, orphan scan            │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                    │                                    │
│                                    │ Resend API (or nodemailer Gmail)   │
│                                    ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  Resend Free (100/day, 3000/month) — transactional email         │  │
│  │  Password reset 15min TTL, teacher activation 72h TTL,           │  │
│  │  masked destination audit, no token in log, TLS 1.2+             │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                    │                                    │
│                                    │ Vercel Cron (Hobby 2 jobs)         │
│                                    ▼                                    │
│  ┌──────────────────────────────────────────────────────────────────┐  │
│  │  /api/cron/purge-evidence (CRON_SECRET, maxDuration 60)          │  │
│  │  Dry-run default, --live --yes deletes expired retainUntil,      │  │
│  │  protected tables count-asserted, metrics JSON, S3 delete        │  │
│  └──────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  DNS: Vercel or Cloudflare Free → codemind.academy, auto HTTPS, HSTS    │
│  Monitoring: Vercel Logs + Analytics free + optional Sentry Free        │
│  Build: prisma generate && next build (typecheck must pass 0 errors)    │
│  Package Manager: Bun (packageManager field) or npm, Node 22.x          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Why this fits CodeMind:**

1. **Reliability:** Neon serverless Postgres autosuspend + pooling + PITR; R2 free egress + 11 nines durability; Vercel edge network + CDN; all state in DB not memory.
2. **Security:** Preserves all invariants — scrypt, SHA-256 token hashes UNIQUE single-use, `SecurityRateLimit` race-free, `SECURITY_HASH_SECRET` fail-fast, CSP/HSTS via `next.config.ts`, authorized routes re-check role every request, private bucket signed URLs short-lived, no public list, `Cache-Control: private, no-store`, audit hashed IP, no PII in logs.
3. **Compatibility:** No raw SQL, JSON as TEXT, cuid() preserved, DateTime TIMESTAMPTZ, NULL-in-UNIQUE same, loader + battery proven, `MediaAsset` abstraction already separates storage location from authz, rate limiting DB-backed multi-process safe.
4. **Low cost:** $0/month MVP — Vercel Hobby + Neon Free + R2 Free + Resend Free + Cloudflare DNS Free all free within MVP usage (2 ADMIN+1 TEACHER+ few students).
5. **Operational simplicity:** Single Next.js deployment (frontend+API), no second system, no persistent workers, cron via Vercel Cron (2 jobs), backups via provider built-in + optional GH Action, media migration one-off via GH Action or local.
6. **Future scalability:** At scale, upgrade to Vercel Pro (60s duration, more bandwidth), Neon Pro (more storage/transfer), R2 paid (more storage), Resend paid (more emails), Upstash Redis for rate limiting, QStash for background fan-outs — all incremental, no redesign.

---

## 21. Implementation Checklist

**Before Vercel deployment — code changes required:**

- [ ] Fix 15 pre-existing TypeScript strict errors (from `PHASE_22_FINAL_REPORT.md` §2.1 Group B: `Set<unknown>→Set<string>` 3, `Property 'status'/'note' on '{}'` 2, `'student' vs 'studentId'` 1, `'{}'→string` 1, `'quizzes'/'homeworks'/'videoPercent'/'videoCompleted' on LessonChain/'{}'` 8) in `src/app/api/teacher/analytics`, `teacher/attendance`, `teacher/quizzes`, `src/lib/progress`, `src/lib/session-progress` — estimated <1h, no logic change, no migration — so `next build` exits 0 (currently fails typecheck even with network)
- [ ] Ensure `prisma generate` succeeds in CI with network (currently fails offline sandbox `binaries.prisma.sh` unreachable — Vercel has network so will succeed, but need to vendor engines or ensure network)
- [ ] Implement S3-compatible storage adapter behind `MediaAsset` contract: new `src/lib/media-s3.ts` or extend `media.ts` with `STORAGE_BACKEND` env switch (`local` for dev/VPS, `s3`/`r2`/`vercel-blob` for Vercel), functions `writePrivateFileS3`, `readPrivateFileS3`, `deletePrivateFileS3`, `getSignedUrlS3`, `getDirectoryBytesS3` or DB counter, keep `LOCAL_PRIVATE` for dev
- [ ] Implement presigned upload flow to bypass Vercel 4.5MB body limit: `POST /api/materials/presign` + `POST /api/materials/complete` + `POST /api/media/presign` + `POST /api/media/complete` + `POST /api/quizzes/[id]/evidence/presign` + complete, client PUTs directly to R2/S3, server validates magic bytes after upload (download header)
- [ ] Update `clientIpFromHeaders` in `security.ts` to trust Vercel's `X-Real-IP`/`X-Vercel-Forwarded-For` as overwriting (similar to Caddy's `X-Real-IP`), document trust boundary (IP buckets abuse throttles only, never authz)
- [ ] Add `STORAGE_BACKEND`, `S3_*`, `BLOB_READ_WRITE_TOKEN`, `CRON_SECRET`, `RESEND_API_KEY` env handling in `media.ts` + `storage-quotas.ts` + `mailer.ts`/`delivery.ts`
- [ ] Add `export const maxDuration = 60` (or 10 for Hobby) in long routes: `ai-generate-quiz` (30s), `purge-evidence` cron, maybe `session-videos` upload if not presigned, notification fan-out if large
- [ ] Add `/api/cron/purge-evidence` route protected by `CRON_SECRET` (check `Authorization: Bearer $CRON_SECRET` or `x-cron-secret` header), idempotent, dry-run via query param, metrics JSON, S3 delete
- [ ] Optionally add Resend adapter in `mailer.ts`: `if (RESEND_API_KEY) use resend else use nodemailer`, keep `isSmtpConfigured` + `hasDeliveryProvider` logic
- [ ] Update CSP in `content-security-policy.ts` to allow R2/Blob domains in `media-src`/`img-src` when `STORAGE_BACKEND=s3` (e.g. `https://*.r2.cloudflarestorage.com`, `https://*.public.blob.vercel-storage.com`, `https://<accountid>.r2.cloudflarestorage.com`)
- [ ] Add `vercel.json` with crons + functions maxDuration (see §11 example)
- [ ] Set `packageManager` field in `package.json` to `bun@1.3.4` if Bun canonical, or delete `package-lock.json` if npm canonical — so Vercel auto-detects correctly
- [ ] Set `engines.node = 22.x` in `package.json` or Vercel dashboard Node 22.x

**Configuration required (no code change):**

- [ ] Provision Neon Free PostgreSQL (or Supabase Free) — create project, db `codemind`, roles, connection string with `?sslmode=require&connection_limit=10&pgbouncer=true` if needed, record in secret manager
- [ ] Provision R2 Free bucket private `codemind-media`, API token with Put/Get/Delete/List, endpoint, region auto, bucket name
- [ ] Provision Resend Free (or keep Gmail SMTP) — domain verification, API key, from address, test via `npm run test:email`
- [ ] Set all env vars in Vercel dashboard Project → Settings → Environment Variables — Production + Preview, server-only except `NEXT_PUBLIC_URL` (see §10 inventory)
- [ ] Set `NEXT_PUBLIC_URL=https://codemind.academy` prod, preview auto `https://<preview>.vercel.app`
- [ ] Set `SECURITY_HASH_SECRET` 64-hex `openssl rand -hex 32` — never commit, never placeholder
- [ ] Set `SKIP_PRODUCTION_ENV_CHECK=1` during build if secrets not available at build time (runtime still enforces via `instrumentation.ts`)
- [ ] Configure Vercel project: Framework Next.js, Node 22.x, Package Manager Bun or npm, Install Command `bun install`, Build Command `prisma generate && next build`, Output `.next`, Domain `codemind.academy` + `www`
- [ ] DNS: add custom domain in Vercel dashboard, set CNAME to `cname.vercel-dns.com` or A to Vercel IPs — VERIFY CURRENT PROVIDER LIMIT, wait propagation, check TLS auto-provision
- [ ] Run data migration: derive artifacts `make-postgres-schema.mjs --check`, baseline `psql -f postgres-baseline.sql`, loader `migrate-sqlite-to-postgres.mjs --source db/custom.db --target PG --manifest`, battery `verify-postgres.mjs → VERIFY_POSTGRES_OK`
- [ ] Run media migration: `migrate-media.mjs --source ./storage/media --dest R2 --manifest --check` adapted to S3, SHA-256 per file, never deletes source, two-person delete after second --check
- [ ] Backup: ensure provider built-in backups enabled (Neon PITR), plus optional GH Action `pg_dump → R2` nightly, test restore drill quarterly into disposable DB `RESTORE_OK` via `restore-postgres.sh` (enforces empty-target + sha256 + battery)

**Verification required (see §17 checklist):**

- [ ] Database `VERIFY_POSTGRES_OK`, curriculum 2/7/23, parts 2 units 7 lessons 23, tracks ARABIC/LANGUAGE, lifecycle DRAFT→READY→PUBLISHED idempotent, progression 23 universe, auth dual-bucket throttling 10×401→429 no oracle, authorization 98 routes, sessions single-device, password reset identical 200 no enumeration 15min TTL, teacher application PENDING no User + approval + activation + login 11 steps + negative cases blocked, admin 2+1 preserved FK 0, teacher own courses, student 23 skeletons locked-but-visible + video 95% + quiz freeze + homework + PDF authorized, parent per-child, PDF 25MB magic bytes + Range 416 + 10-check, video 512MB batch+track+published + Range + progress monotonic, quiz freeze + server grading, homework POST gated, notifications targeted course×track×active preference-aware deep-linked idempotent chunked 500 66ms 1614 rows, audit hashed IP no PII, security 10-check matrix IDOR non-oracle cross-track/cross-course/premature/PDF-guess/link-bypass rate limiting 40→10 exact CSP no unsafe-eval HSTS secure cookies proxy, Arabic RTL no raw key leak, English LTR, mobile/desktop

---

## 22. Risks / Blockers / Open Decisions

| Item | Classification | Evidence | Impact | Required Action |
|------|----------------|----------|--------|-----------------|
| **SQLite provider `sqlite` + file `db/custom.db`** | **BLOCKER** | `prisma/schema.prisma:7 provider sqlite`, `DATABASE_URL=file:./db/custom.db`, `src/lib/db.ts` singleton | Vercel ephemeral FS — writes disappear, no persistence | Migrate to PostgreSQL via Phase 21 loader + battery + ledger baseline — REQUIRED before deployment |
| **Local filesystem media `MEDIA_STORAGE_PATH` + `fs` write/read** | **BLOCKER** | `src/lib/media.ts:19 MEDIA_ROOT`, `258 mkdir+writeFile`, `263 readFile`, `268 unlink`, `272 stat`, `storage-quotas.ts:128 readdir+stat` | Ephemeral FS — PDFs/videos/evidence lost after deploy/scale | Implement S3-compatible adapter (R2/Blob) behind `MediaAsset` contract + presigned upload flow to bypass 4.5MB limit — REQUIRED |
| **Large file upload 512MB video + 25MB PDF exceeds Vercel 4.5MB body limit** | **BLOCKER** | `MEDIA_MAX_VIDEO_BYTES=512MB`, `MEDIA_MAX_PDF_BYTES=25MB`, Vercel Hobby body limit 4.5MB — VERIFY CURRENT PROVIDER LIMIT | Direct upload via Vercel function will fail 413 | Implement presigned PUT (client→R2 directly) + complete callback that validates magic bytes — REQUIRED |
| **TypeScript strict errors 15 cause `next build` exit 1 even with network** | **BLOCKER** | `docs/PHASE_22_FINAL_REPORT.md` §2.1 Group B 15 errors in `teacher/analytics`, `teacher/attendance`, `teacher/quizzes`, `lib/progress`, `lib/session-progress` — `npx tsc --noEmit` 28 errors (13 missing client +15 strict) | Vercel build fails typecheck, no deployable artifact | Fix 15 errors (Set<string> casts, LessonChain type, status/note typing, student vs studentId) — <1h, no logic change — REQUIRED |
| **AI quiz generation ~30s exceeds Vercel Hobby 10s duration** | **HIGH** | `src/app/api/admin/ai-generate-quiz/route.ts` takes ~30s per doc (Phase 10 doc), Vercel Hobby 10s limit — VERIFY | Route times out 504 on Hobby | Add `maxDuration=60` + upgrade to Pro $20/month, or move to background job via QStash + callback, or stream — REQUIRED if using Hobby |
| **@sparticuz/chromium binary size may exceed Vercel 50MB function limit** | **HIGH** | `package.json` dep `@sparticuz/chromium 149.0.0` ~100MB, no import found in `src/` grep — may be unused or via `z-ai-web-dev-sdk` | Function size limit exceeded, deploy fails | Check usage, remove if unused, or use `puppeteer-core` + `excludeFiles` in `vercel.json`, or move to external service — REQUIRED to verify |
| **Prisma generate needs network `binaries.prisma.sh`** | **MEDIUM** | `PHASE_22_FINAL_REPORT.md` §2.2: `npm run build` fails at `prisma generate` offline `Error: request to https://binaries.prisma.sh/.../schema-engine.gz.sha256 failed` — same as Phases 6-21 | Build fails in offline sandbox, but Vercel has network so will succeed — still need to ensure network or vendor engines | Ensure Vercel build has network (default yes) + set `SKIP_PRODUCTION_ENV_CHECK=1` if secrets not at build time — verify |
| **X-Real-IP trust on Vercel** | **MEDIUM** | `Caddyfile` sets `X-Real-IP` unconditionally overwriting client value, `security.ts:clientIpFromHeaders` prefers X-Real-IP then first XFF hop — Vercel sets X-Forwarded-For + X-Vercel-Forwarded-For + X-Real-IP? VERIFY | On Vercel, X-Real-IP may be absent, falling back to XFF first hop which is spoofable — IP buckets weakened (but not authz) | Update `clientIpFromHeaders` to trust Vercel's headers as overwriting, document trust boundary — small code change |
| **Database connections exhaustion serverless** | **MEDIUM** | Prisma singleton, no `connection_limit`, serverless cold starts may open many connections quickly | `too many connections` error, 500s under spike | Set `?connection_limit=10` + `?pgbouncer=true` (Neon) or Prisma Accelerate, monitor `pg_stat_activity` |
| **Video bandwidth may exceed free tier** | **MEDIUM** | Session videos 512MB, 100GB Vercel Hobby bandwidth — VERIFY | Bandwidth overage → paid or throttled | Use R2 free egress + signed URL redirect so bandwidth is R2 not Vercel, Cloudflare CDN free |
| **Bun vs npm dual lockfiles** | **MEDIUM** | Both `bun.lock` + `package-lock.json` present | Vercel auto-detect may pick wrong package manager, install fails or uses stale deps | Add `packageManager` field or delete one lockfile, set Install Command explicitly in Vercel dashboard |
| **Caddyfile :81 plain-HTTP listener** | **MEDIUM** | `Caddyfile: :81` + Gate R-2 accepted risk — plain HTTP listener, HSTS now emitted at app but operator should retire :81 or redirect-only | Downgrade/strip-SSL window on first contact | For Vercel path, Caddy not used — no longer needed; for VPS fallback, retire :81 or make redirect-only |
| **Backup via pg_dump shell not possible on Vercel** | **MEDIUM** | `scripts/db/backup-postgres.sh` needs `pg_dump` binary + FS, no shell on Vercel | No custom backups on Vercel | Use provider built-in backups (Neon PITR, Supabase daily) + optional GH Action pg_dump → R2 |
| **Storage quota walk assumes local FS** | **MEDIUM** | `storage-quotas.ts:getDirectoryBytes` walks FS, skips symlinks | On S3, cannot walk local FS | Replace with bucket size API or DB counter `MediaAsset.sizeBytes` sum, keep per-file caps |
| **CSP needs R2/Blob domains** | **MEDIUM** | `content-security-policy.ts` `media-src 'self' blob: data: https:` — R2/Blob domains are https but may need explicit allow if strict | Video/PDF from R2 may be blocked by CSP if not in allow-list | Add `https://*.r2.cloudflarestorage.com` or `https://*.public.blob.vercel-storage.com` to `media-src`/`img-src` when using object storage |
| **z-ai-web-dev-sdk production credentials** | **OPEN DECISION** | `package.json` dep `z-ai-web-dev-sdk 0.0.18`, `.env.example` says auto-configured in sandbox, prod needs SDK host env per SDK docs — Kodgy itself scripted no AI, but `ai-generate-quiz` uses LLM | If credentials missing, AI quiz generation fails | Decide: keep `z-ai-web-dev-sdk` for prod (verify provider limits, cost, auth) or replace with OpenAI API directly (Resend-style) — VERIFY CURRENT PROVIDER LIMIT for LLM quota/cost |
| **Email provider choice: Gmail SMTP vs Resend API** | **OPEN DECISION** | `mailer.ts` uses nodemailer Gmail SMTP STARTTLS 587, timeouts 20s/20s/30s — works serverless but Gmail may block Vercel IPs; Resend API more reliable | Deliverability risk on Vercel | Choose Resend Free (100/day) for better deliverability, or keep Gmail as fallback — implement adapter that tries Resend if `RESEND_API_KEY` set else SMTP |
| **Object storage choice: R2 vs Vercel Blob vs S3 vs Supabase Storage** | **OPEN DECISION** | `MediaAsset` enum has `S3` reserved, no client — R2 free egress is key for video, Blob Hobby free but egress charged, S3 free 12mo only, Supabase Storage 1GB free | Cost, bandwidth, operational simplicity, future scalability | Primary R2 Free (10GB, free egress), fallback Vercel Blob Hobby (if already on Vercel) or Supabase Storage (if using Supabase PG) — VERIFY CURRENT PROVIDER LIMIT for each |
| **PostgreSQL provider choice: Neon vs Supabase vs Vercel Postgres vs Railway** | **OPEN DECISION** | Phase 21 proves PG compatibility, no raw SQL, loader + battery — Neon Free 0.5GB/3GB transfer/100 conns, Supabase Free 500MB/2GB/50k MAU, Vercel Postgres Hobby 256MB — VERIFY | Reliability, free-tier suitability, pooling, backup, branching | Primary Neon Free (serverless, autosuspend, pooling, branching, PITR), fallback Supabase Free (all-in-one DB+storage+auth) or Vercel Postgres (if already on Vercel) — VERIFY |
| **Vercel Hobby vs Pro for AI quiz 30s** | **OPEN DECISION** | AI quiz 30s exceeds Hobby 10s — needs Pro 60s or background job | Cost $20/month Pro vs complexity of QStash | If AI quiz is MVP required, upgrade to Pro or move to QStash; if not MVP, keep Hobby and document AI quiz as Pro-only or async — decide based on product priority |
| **Bun vs npm for Vercel** | **OPEN DECISION** | Both locks present, `start` uses Bun, build uses `prisma generate && next build` (works with both) | Build reproducibility, install speed | If team uses Bun locally, set `packageManager: bun@1.3.4` and Install `bun install`; if Vercel prefers npm, delete `bun.lock` and use `npm ci` — decide and document |
| **Presigned upload validation: download header vs webhook** | **OPEN DECISION** | Presigned PUT bypasses server, so MIME/magic validation must happen after upload — options: server downloads first 1KB and checks magic, or provider webhook triggers validation, or client sends hash | Security vs complexity, bandwidth | Simplest: server downloads first 1KB via S3 GetObject Range bytes=0-1023 and checks `%PDF-` magic — adds small S3 read per upload but secure; alternative: trust client MIME + extension + size pre-check and validate on download (lazy) — less secure |
| **Evidence retention purge: Vercel Cron vs GitHub Actions** | **OPEN DECISION** | Purge job dry-run default, needs `--live --yes`, protected tables count-asserted — Vercel Cron Hobby 2 jobs min 1h, GH Actions free 2000 min/month | Operational simplicity vs cost | Primary Vercel Cron (Hobby 2 jobs exactly enough for purge + health), fallback GH Actions if need more than 2 or need shell pg_dump |
| **Backup encryption: provider vs custom AES-256** | **OPEN DECISION** | `backup-postgres.sh` supports AES-256-CBC/PBKDF2 via `BACKUP_PASSPHRASE` from secret manager, but provider built-in backups may already be encrypted at rest | Security vs simplicity | If using provider built-in (Neon/Supabase), rely on provider encryption + file modes 0700/0600; if using GH Action pg_dump → R2, encrypt via `BACKUP_PASSPHRASE` — document choice in cutover log |

---

## 23. Final Recommendation

**Based on:**

- Current repository at `bd74ada9a4bdfeb0210c8b30007fd2a9c9a54f6f` — `prisma/schema.prisma` provider `sqlite`, `DATABASE_URL=file:./db/custom.db`, `MEDIA_STORAGE_PATH=./storage/media` local FS, `next.config.ts` `output: standalone`, `Caddyfile` `:81` + `X-Real-IP` overwrite, `package.json` build `prisma generate && next build && copy-standalone-assets`, `start` `bun scripts/start-production.mjs`, 55 models, 21 enums, 9 migrations, 98 API routes, 30 lib modules, no raw SQL, no background workers, no WebSockets, `sharp` + `@sparticuz/chromium` deps, `bun.lock` + `package-lock.json` dual locks, `.env.example` inventory, `src/lib/media.ts` `fs` write/read, `storage-quotas.ts` directory walk, `evidence-retention.ts` + `purge-expired-evidence.ts` manual, `backup-postgres.sh` shell, `mailer.ts` nodemailer Gmail SMTP, `delivery.ts` `hasDeliveryProvider`, `security.ts` `clientIpFromHeaders` + `checkRateLimit` race-free, `rate-limit.ts` 7 keys, `auth.ts` scrypt + `UserSession` SHA-256 + single-device, `teacher-applications.ts` secure lifecycle, `session-progress.ts` single source, `track-scope.ts` `canAccessTrackScope`, `session-lifecycle.ts` `DRAFT/READY/PUBLISHED` + `SessionPublication UNIQUE`, `session-materials.ts` 10-check + magic bytes, `session-notifications.ts` targeted fan-out chunked 500 deduped, `content-security-policy.ts` no unsafe-eval, `env.ts` fail-fast, `instrumentation.ts` `NEXT_RUNTIME` guard, `proxy.ts` cookie-presence 401
- Phase history P1-P22 + Security Audit Gate CONDITIONAL GO 0 Critical/High open + P21 PostgreSQL + durable media volume + P22 baseline 2 ADMIN+1 TEACHER+0 STUDENT/PARENT+23 lessons+subscription plans+settings+security infra+media preservation+FK integrity
- Current security model: role enforcement per request, authorization via `requireUser`/`requireRole`/`requireAdmin` + `canAccessLesson` single definition + `canAccessQuiz`/`canAccessHomework` + `authorizeMaterialDownload` + `isParentLessonPreviewAllowed`, account activation `isActive`+`status`, teacher lifecycle `PENDING→APPROVED→ACTIVATED` secure activation single-use 72h SHA-256 + password setup 8+ scrypt + no auto-login, password reset SHA-256 single-use 15min + `revokeAllSessions`, session management `UserSession` SHA-256 hash UNIQUE + deviceHash + ipHash + 7d TTL + throttled lastSeenAt + single-device conflict 30min grace + suspend `SUSPENDED_MULTI_DEVICE`, secure cookies httpOnly lax secure path `/`, rate limiting DB-backed `SecurityRateLimit` UNIQUE(bucket,identifier) + guarded upsert+updateMany + policy clamped never disableable + identifiers hashed + 429 `Retry-After`+`X-RateLimit-*`+`RATE_LIMITED`+audit, audit logs `SecurityEvent` hashed IP truncated UA no PII no token, secret handling `.env` gitignored no `.env*` tracked + `env.ts` fail-fast + tokens hashed + SMTP password redacted + URLs redacted, origin/CSRF `SameSite=Lax`+JSON-only+CORS no wildcard+allow-list redirects, protected resources via authorized routes re-check role every request + Range strict 416 + `Accept-Ranges`+`Content-Disposition`+`Cache-Control private no-store`, error handling structured code+localized no stack traces + uniform no enumeration oracle + `maskEmail`
- Production-safety: safe migration/reconciliation NOT destructive reset, no `migrate reset`/`db push --accept-data-loss`/`DROP DATABASE`/`TRUNCATE ALL`/`blind delete/reseed`/`destructive production seed`, P22 baseline preserved, selective cleanup auditable `phase22-final-integration.mjs`, curriculum reconciliation idempotent `reconcile-curriculum.ts` second run zero writes, backup/recovery `backup-postgres.sh` + `restore-postgres.sh` + `verify-postgres.mjs` battery + `migrate-media.mjs` SHA-256, protected data `SecurityEvent/AuditLog/TeacherApplication/TeacherActivationToken/UserSession/PasswordResetToken/SecurityRateLimit` + `QuizAttempt/Student/User` count-asserted unchanged on purge, media preservation via `MediaAsset` + `SessionVideo` + `Material`, SubscriptionPlan preservation, Setting preservation, FK integrity `PRAGMA foreign_key_check` 0, production cleanup order children-first `Restrict` last
- Storage architecture: PDF via `Material→MediaAsset DOCUMENT LOCAL_PRIVATE` magic bytes, Video via `SessionVideo→MediaAsset VIDEO EXTERNAL_URL/LOCAL_PRIVATE`, Quiz Evidence via `QuizAttemptEvidence→MediaAsset IMAGE`, metadata in DB, local FS random keys, access-control 10-check + batch+track+published, public vs private (private only via authorized routes, no public bucket), signed URLs none currently (direct stream), upload flow validated before write, large-file handling via `MAX_*_BYTES` caps 512MB/5MB/25MB, streaming via Range, retention via `retainUntil` + purge job, cleanup refcounted, deletion row+bytes after commit best-effort next-run convergence, orphan handling via manifest + `--check`, DB/file consistency via SHA-256 per file
- Background jobs: no `setInterval`, no workers, no queues — jobs are external scripts (evidence purge, backup, media migration, curriculum reconcile, notification fan-out request-triggered)
- Email: `mailer.ts` nodemailer Gmail SMTP STARTTLS 587, `delivery.ts` `hasDeliveryProvider`, teacher activation + password reset via email, deep links via `notification-links.ts` + `deep-link.ts`, retry via idempotent re-open, failure handling `EMITTED_PARTIAL`
- Deployment constraints: Caddy reverse proxy `:81` + `X-Real-IP` overwrite, `output: standalone` + `start-production.mjs`, dual lockfiles, Node 22+, Prisma generate needs network, build currently fails typecheck 28 errors (13 missing client +15 strict)
- Free-tier constraints: Vercel Hobby 10s duration 4.5MB body 100GB bandwidth 1000 GB-hours 2 cron jobs — VERIFY, Neon Free 0.5GB storage 3GB transfer 100 conns — VERIFY, R2 Free 10GB storage 10M ops free egress — VERIFY, Resend Free 100/day 3000/month — VERIFY
- Known issues: P22 typecheck 28 errors (13 env +15 strict) + lint 134 (96 require-in-tests +35 setState-in-effect) — pre-existing baseline not P22 regression, build fails typecheck even with network until 15 strict fixed, Prisma engines unreachable offline sandbox, AV not integrated (ADR-004 defense-in-depth only), CSP `unsafe-inline` for script/style required until nonce/hash migration future work, storage quota deferred to P21 (now implemented but FS-based)

**Decision:**

```
NOT COMPATIBLE WITH VERCEL FREE WITHOUT ARCHITECTURAL CHANGES
```

**Justification:**

- **BLOCKER 1:** SQLite is ephemeral on Vercel — must become PostgreSQL (Phase 21 loader + battery exists but needs execution + connection pooling config + ledger baseline)
- **BLOCKER 2:** Local filesystem media is ephemeral — must become S3-compatible object storage (R2/Blob) behind `MediaAsset` abstraction + presigned upload flow to bypass 4.5MB body limit (currently 512MB video +25MB PDF +5MB image all exceed)
- **BLOCKER 3:** TypeScript strict errors 15 cause `next build` exit 1 even with network — must be fixed (<1h)
- **HIGH:** AI quiz generation 30s exceeds Hobby 10s — needs Pro or background job
- **HIGH:** `@sparticuz/chromium` size may exceed 50MB function limit — needs verification/removal

These are **architectural changes** (DB provider, storage backend, upload flow), not just configuration. However they are **concrete, low-risk, and already partially implemented** (Phase 21 gives PG schema + loader + battery + media migration tool + quota + retention). The path to Vercel Free is clear and preserves all security and production-safety invariants.

**If the question is "can it be deployed to Vercel Free with free-tier external services after these changes?" — YES, with the $0/month architecture in §5 and §20, and the exact sequence in §16, and verification in §17, and rollback in §18.**

**If the question is "can the CURRENT architecture (as-is, SQLite + local FS) be deployed to Vercel Free?" — NO, not without the architectural changes above.**

Therefore the final recommendation is **NOT COMPATIBLE WITH VERCEL FREE WITHOUT ARCHITECTURAL CHANGES**, with a concrete plan to make it compatible that stays $0/month initially.

---

## Appendix — Evidence References (selected)

- `package.json: build = prisma generate && next build && copy-standalone-assets.mjs`, `start = bun scripts/start-production.mjs`, `sharp 0.35.4`, `@sparticuz/chromium 149.0.0`, `pg 8.23.0`, `@electric-sql/pglite 0.5.8`
- `prisma/schema.prisma:7 provider sqlite`, `prisma/schema.postgresql.prisma: provider postgresql` (derived), `scripts/db/postgres-baseline.sql: 143 statements`, `scripts/db/pg-lib.mjs` (parser+DDL+order+mapper+dump/restore)
- `src/lib/db.ts: globalForPrisma singleton`, `src/lib/env.ts: MIN_SECURITY_HASH_SECRET_LENGTH 32, DEV_FALLBACK_HASH_SECRET, REJECTED_PRODUCTION_SECRETS, getSecurityHashSecretProblem, assertProductionEnv`
- `src/lib/auth.ts: hashPassword scryptSync 16 salt 64 hash, verifyPassword timingSafeEqual, SESSION_COOKIE cm_session, SESSION_TTL 7d, IDLE_GRACE_MS 30min, LAST_SEEN_THROTTLE_MS 1min, createSession single-device conflict, deviceHashFromHeaders, getCurrentUserDetailed reason`
- `src/lib/security.ts: sha256, safeEqual timingSafeEqual, generateToken 32 randomBytes base64url, clientIpFromHeaders prefers X-Real-IP then first XFF, hashIp with SECURITY_HASH_SECRET, maskEmail, deviceHashFromHeaders browser+os+ch-ua-mobile/platform hashed, checkRateLimit upsert(update:{})+guarded window reset+guarded claim, resetRateLimit, logSecurityEvent, SecurityEventType 7 teacher types`
- `src/lib/rate-limit.ts: 7 keys, DEFAULT_RATE_LIMITS, RATE_LIMIT_ENV, RATE_LIMIT_BOUNDS, parseRateLimitOverride, clampRateLimitConfig, resolveRateLimitConfig, rateLimitIdentifier SHA-256 rl:key:userId, rateLimitBucket, rateLimitHeaders X-RateLimit-*, rateLimitedBody code RATE_LIMITED, enforceRateLimit`
- `src/lib/media.ts: MEDIA_ROOT env MEDIA_STORAGE_PATH || cwd/storage/media, MAX_*_BYTES env, ALLOWED_*_MIME, isAllowed*Mime, PDF_MAGIC %PDF-, hasPdfMagicBytes 0..1024 window, sanitizeOriginalFilename, hasPdfExtension, validatePdfUpload, isSafeExternalUrl blocks localhost/0.0.0.0/.local/127./10./192.168./172.16-31, makeStorageKey random, resolveSafePath traversal defense, writePrivateFile mkdir+writeFile, readPrivateFile, deletePrivateFile, privateFileStat, sha256Buffer, sha256PrivateFile streamed, extFromMime`
- `src/lib/storage-quotas.ts: parseBytesEnv 10GB/512 MB, resolveQuotaConfig MEDIA_QUOTA_BYTES, checkQuota, getDirectoryBytes readdir+stat skip symlinks, assertVolumeQuota zero I/O when unset 413 when set`
- `src/lib/evidence-retention.ts: retainUntil NOT NULL AND <= now, NULL=keep forever, resolveRetentionDays 1..3650 default 30`
- `src/lib/mailer.ts: only place SMTP creds, isSmtpConfigured 4 vars, getSmtpConfig SMTP_HOST/PORT/USER/PASSWORD/EMAIL_FROM, getMailTransport cache, nodemailer STARTTLS 587 requireTLS TLS≥1.2 timeouts 20s/20s/30s, sanitizeError redacts, sendMailViaSmtp, smtpDiagnostics masked, verifySmtpConnection`
- `src/lib/session-progress.ts: EXCLUDE_ARCHIVED_LESSON, lessonCourseChainOr, canAccessLesson single definition enrollment+course+track+lifecycle+progression, canAccessQuiz gateTrackedResource, denyProgression 404 vs 403+code`
- `src/lib/track-scope.ts: canAccessTrackScope, eligibleTrackScopes, trackScopeWhere, videoTrackFilter, eligibleQuestionFilter`
- `src/lib/session-lifecycle.ts: LessonStatus DRAFT/READY/PUBLISHED, LESS­ON_STUDENT_STATUS_FILTER, computeLessonReadiness pure, getLessonReadiness, ALLOWED_TRANSITIONS, canTransition, transitionLesson transactional conditional flip, markLessonReady/openLesson/unpublishLesson, lifecycleHttpStatus, publishedMirror`
- `src/lib/session-materials.ts: authorizeMaterialDownload 10-check, validatePdfUpload, writePrivateFile, QUOTA_EXCEEDED 413`
- `src/lib/session-notifications.ts: getEligibleSessionRecipients single derivation, localized templates api.230/231, chunked 500 env-clamped, dedupe (userId,type,link), outcome codes EMITTED/ALREADY_DELIVERED/SUPPRESSED_BY_PREFERENCES/EMITTED_PARTIAL/NO_RECIPIENTS, notifiedCount/notifiedAt counters, LESSON_PUBLICATION_NOTIFY audit, mutex per lesson`
- `src/lib/notify.ts: createNotificationIfAllowed checks NotificationPreference+quiet hours, partitionByNotificationPreferences bulk path one bulk pref read+chunked createMany+validated link+honest sent/skipped, NOTIFICATION_FANOUT_CHUNK_SIZE env`
- `src/lib/teacher-applications.ts: TEACHER_ACTIVATION_TTL_HOURS env 72, submit/approve/reject/activate, email UNIQUE, userId UNIQUE NULLABLE, tokenHash UNIQUE, guarded updateMany inside $transaction`
- `src/proxy.ts: defense-in-depth cookie-presence 401, matcher /api/:path*, decideApiAccess`
- `src/instrumentation.ts: NEXT_RUNTIME nodejs guard, assertProductionEnv, globalThis.process.exit indirection for Edge bundle`
- `next.config.ts: output standalone, poweredByHeader false, securityHeaders X-Frame-Options SAMEORIGIN, X-Content-Type-Options nosniff, Referrer-Policy strict-origin-when-cross-origin, Permissions-Policy camera=(self), HSTS max-age=15552000 includeSubDomains unless HSTS_DISABLED=1, CSP via decideCspHeader CSP_REPORT_ONLY/CSP_DISABLED toggles`
- `Caddyfile: :81, XTransformPort query → localhost:{port}, default → localhost:3000, header_up X-Real-IP {remote_host} overwrites client`
- `scripts/db: make-postgres-schema.mjs --check drift, postgres-baseline.sql 21 CREATE TYPE+55 CREATE TABLE+67 CREATE INDEX, migrate-sqlite-to-postgres.mjs --source --target --manifest one transaction count+hash, verify-postgres.mjs battery, pg-lib.mjs, backup-postgres.sh pg_dump custom+sha256+manifest+retention 30d keep-7 AES-256 option, restore-postgres.sh empty-target+sha256+battery`
- `scripts/media: migrate-media.mjs sorted deterministic SHA-256 before+after manifest --check, symlinks skipped, never deletes source, purge-expired-evidence.ts dry-run default --live --yes protected tables count-asserted`
- `scripts/start-production.mjs: portable launcher node/bun, NODE_ENV=production, tee server.log, SERVER_LOG_FILE, signal forwarding SIGINT/SIGTERM/SIGHUP, force-kill after 10s`
- `docs/PHASE_*.md` 20 files + `SECURITY_AUDIT_GATE_PRE_PHASE21.md` + `POSTGRES_CUTOVER_RUNBOOK.md` + `GO_LIVE_RUNBOOK.md` + `DATABASE_GUIDE.md` + `DEPLOYMENT_GUIDE.md` + `PROJECT_STATE.md` + `MASTER_PLATFORM_AUDIT_AND_ROADMAP.md` + `ARCHITECTURE.md`
- `tests/*.test.js` 27 suites + `final-integration-phase22.test.js` 149/149 + `verify-phase*.mjs` 9 verifiers all *_OK
- `worklog.md` 99915 bytes history (not inspected fully due to size, but phase docs are authoritative)
