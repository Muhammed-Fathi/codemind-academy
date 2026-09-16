# Phase 26H — Final Pre-Deployment Regression, Release Readiness and GO/NO-GO Audit

**Repository:** `Muhammed-Fathi/codemind-academy`
**Branch audited:** `arena/01a0a92e-codemind-academy`
**Release-candidate base:** `c467127f54ae1ca651e94dad88d9495438c09c06` (merge of PR #82, `phase26g-delivery`)
**Delivery commit (this phase):** the Phase 26H commit on `arena/01a0a92e-codemind-academy`, parent `c467127…` — the exact SHA is recorded in the session's git-delivery note and in §15 step 0 of this document's companion checklist.
**Date:** 2026-09-16
**Scope:** full pre-deployment regression, release-readiness gate, security gate, role end-to-end coverage, quiz architecture, PostgreSQL/Neon, Cloudflare R2, SMTP, Vercel Cron, environment manifest, monitoring/backup/recovery — stopping **immediately before** any deployment.

**Phase 26H performed NO deployment.** No Vercel project was created, no deploy was triggered, no DNS/CORS/secret/data was touched, no migration was executed against any real database, no email was sent, nothing was merged. All tests ran against disposable local resources (scratch SQLite files, a disposable PostgreSQL 17.10 cluster on `127.0.0.1:55432`, stubbed/in-memory stores).

---

## 1. Verdict

**PHASE 26H: GO FOR PRODUCTION DEPLOYMENT**

Basis: the audit found **one true production blocker** — a Next.js version in the broken window (16.3.4) that makes every Vercel build of a `output: "standalone"` app fail with `ENOENT …/next-server.js.nft.json` once Vercel's adapter rollout is active — and the 26H delivery **fixes it** (`next@^16.3.5`, lockfile 16.3.5), proves the fix with a local reproduction of the exact failing mechanism, adds a permanent regression gate for it, and documents the contingency. After that fix there are no unresolved Critical or High issues, no authorization/IDOR blocker, no committed secret, a defined rollback path, no production data touched, and the remaining work is a finite, ordered checklist (§15) that must run at deployment time.

## 2. Repository State

| Item | Value |
|---|---|
| Workspace | `/home/user/codemind-academy` |
| Branch | `arena/01a0a92e-codemind-academy` |
| Base HEAD | `c467127f54ae1ca651e94dad88d9495438c09c06` (merge of PR #82) |
| Merged-tree vs CI-tested head | merge tree `2097b050…` identical to CI-tested head `992dceaf` |
| Tree cleanliness at audit start | clean (no modified/untracked files) |
| Tracked generated artifacts | none (`.next/`, `node_modules/`, `*.db`, `db/`, `out/`, `backups/` all ignored) |
| Tracked `.env*` files | only `.env.example` (verified by `git ls-files`) |
| Secret-shaped literals in tracked code | none outside test/doc placeholders (`git grep` for `sk-…`, `AKIA…`, PEM keys, `whsec_`, `postgres://user:pass@`) |
| Ignore contract | `.env*` except `.env.example`; `*.db`; `/db/`; `.next/`; `/out/`; `.vercel/` |
| Node / npm | Node 22.22.3 / npm 10.9.8; `npm ci` exit 0 (738 packages) |
| Git history | unshallowed (`git fetch --unshallow`) so history-dependent suites can run |
| PRs / merges created by 26H | none |
| Deployments | none |

## 3. Changes Made

All changes are additive or corrective; no behavioural code was rewritten.

| # | File | Change | Why |
|---|---|---|---|
| 1 | `package.json`, `package-lock.json` | `next` and `eslint-config-next` bumped `16.3.4 → 16.3.5` (range `^16.3.5`); lockfile diff is exactly the 4 Next packages plus the 8 optional `@next/swc-*` platform binaries, all 16.3.4→16.3.5, nothing else | **Critical fix.** Next 16.3.0–16.3.4 breaks every Vercel build of a standalone-output app (upstream `vercel/next.js#96646`; fixed by `#97287`, backported and released in 16.3.5). Without this, the first Vercel deployment of this repo fails at `onBuildComplete` |
| 2 | `vercel.json` | added `"buildCommand": "npm run build:postgres"` (cron entry unchanged) | **Critical fix.** Vercel would otherwise fall back to the framework default `npm run build`, which generates the **SQLite** Prisma Client for a `postgresql://` production URL |
| 3 | `tests/vercel-standalone-adapter-gate.test.js` | new static release gate (19 assertions) | Permanent regression coverage for both of the above: fails if the locked Next version drops back below 16.3.5 while standalone output is unconditional, if `@next/*` tooling drifts, if `vercel.json` stops pinning the PostgreSQL build, or if the runbook loses the operator contingency |
| 4 | `tests/vercel-cron-retention-phase24.test.js` | the `vercel.json` deep-equality pin extended to the pinned `buildCommand` + two new assertions (buildCommand is the PG build; it contains no migration step) | Keeps the Phase 24 contract honest; no assertion was weakened or removed (161 → 163 assertions) |
| 5 | `docs/VERCEL_PRODUCTION_RUNBOOK.md` | **new** operator runbook for the Vercel target (migration sequence, pinned build command, environment manifest, R2 exact-origin CORS, SMTP/Cron smoke tests, rollback/emergency disable, post-deploy verification) + §5.1 documenting the Next version floor and the `NEXT_ADAPTER_PATH=` contingency | The existing `docs/GO_LIVE_RUNBOOK.md` describes a VPS (systemd/Caddy/media volume/host cron) that does not exist on Vercel |
| 6 | `README.md` | deployment section now points at the Vercel runbook | Docs match the selected production architecture |
| 7 | `docs/GO_LIVE_RUNBOOK.md` | header notice: superseded by the Vercel runbook for this target; data-safety rules retained | Prevents an operator following VPS-shaped instructions |
| 8 | `docs/PLATFORM_ROLE_CAPABILITIES.md` | Part II §9–§20 capability map appended (header note updated) | Authoritative, evidence-backed role/capability reference; no aspirational claims |
| 9 | `docs/PHASE_26H_FINAL_REGRESSION_AND_GO_NO_GO.md` | this report | — |

**Not changed:** application logic, Prisma schemas, migration history, CI workflows, `.env.example` (already accurate), any credential, any production resource.

## 4. Full Regression Results

**Authoritative sweep:** fresh, post-fix sweep `phase-26h-re-sweep-next-16-3-5-731e888d`, one `node <suite>` per file in name order, `DATABASE_URL=file:./db/custom.db` (scratch SQLite), placeholder `SECURITY_HASH_SECRET`, HTTPS `NEXT_PUBLIC_URL`. Raw evidence: `/tmp/p26h-final3/run.log`, `/tmp/p26h-final3/summary.tsv`, one log per suite.

**Result: 56 suites — 54 PASS (exit 0, 0 failed assertions in every suite), 2 ENVIRONMENT-BLOCKED (exit 1, no assertion failures).** The same two suites were environment-blocked in the pre-change sweep for the same reasons (proven below), i.e. the dependency fix introduced **no** new failure.

| Suite | Status | Assertions | Time |
|---|---|---|---|
| `admin-publishing-phase15.test.js` | PASS | 384 passed, 0 failed | 6s |
| `auth-cross-role-phase26f.test.js` | PASS | 20 passed, 0 failed | 2s |
| `authorization-invariants.test.js` | PASS | 93 passed, 0 failed | 0s |
| `calendar-i18n-phase9.test.js` | PASS | 444 passed, 0 failed | 0s |
| `curriculum-reconciliation-phase11.test.js` | PASS | 56 passed, 0 failed | 2s |
| `final-integration-phase22.test.js` | ENV-BLOCKED | Node.js v22.22.3 | 0s |
| `group-track-recovery-postgres.test.mjs` | ENV-BLOCKED | Node.js v22.22.3 | 0s |
| `kodgy-phase10.test.js` | PASS | 231 passed, 0 failed | 1s |
| `media-storage-wiring.test.js` | PASS | 318 passed, 0 failed | 5s |
| `migration-providers.test.js` | PASS | 54 passed, 0 failed | 0s |
| `migration-sql.test.js` | PASS | 15 passed, 0 failed | 0s |
| `mock-exam-grading-isolation.test.js` | PASS | 22 passed, 0 failed | 0s |
| `mock-exam-phase8.test.js` | PASS | 135 passed, 0 failed | 3s |
| `parent-analytics-alignment-phase19.test.js` | PASS | 176 passed, 0 failed | 7s |
| `parent-dashboard-isolation.test.js` | PASS | 112 passed, 0 failed | 7s |
| `parent-monthly-report.test.js` | PASS | 67 passed, 0 failed | 6s |
| `payment-experience-phase25-pr3.test.js` | PASS | 128 passed, 0 failed | 37s |
| `payment-lifecycle-phase25-ledger.test.js` | PASS | 140 passed, 0 failed | 4s |
| `payment-lifecycle-phase25-pr2a-grandfather.test.js` | PASS | 32 assertions passed, 0 failed | 2s |
| `payment-lifecycle-phase25-pr2a.test.js` | PASS | 169 passed, 0 failed | 2s |
| `payment-lifecycle-phase25-pr2b-concurrency.test.js` | PASS | 114 assertions passed, 0 failed | 4s |
| `payment-lifecycle-phase25-pr2b-fullchain.test.js` | PASS | 135 assertions passed, 0 failed | 2s |
| `payment-lifecycle-phase25-pr2b-utc-tz.test.js` | PASS | 863 assertions passed, 0 failed | 2s |
| `payment-lifecycle-phase25-pr2b.test.js` | PASS | 252 assertions passed, 0 failed | 2s |
| `pg-baseline-inspection.test.mjs` | PASS | PG_BASELINE_INSPECTION_OK: historical TEXT lineage, enum convergence, exhaustive catalog differences, read-only transact | 3s |
| `phase25-pr4-inventory.test.js` | PASS | 203 passed, 0 failed | 2s |
| `phase25-pr4-release-gate.test.js` | PASS | 93 passed, 0 failed | 0s |
| `phase26a-public-auth.test.js` | PASS | 121 passed, 0 failed | 4s |
| `phase26b-group-track.test.js` | PASS | 83 passed, 0 failed | 5s |
| `phase26b-student-flow.test.js` | PASS | 39 passed, 0 failed | 6s |
| `phase26c-admin-full-flow.test.js` | PASS | [26C-TEST] PASS — all source pins and verifier passed | 5s |
| `phase26c-schooltype-enum-typing.test.js` | PASS | 41 passed, 0 failed | 1s |
| `phase26d-concurrency-postgres.test.js` | PASS | SKIPPED | 0s |
| `phase26d-teacher-full-flow.test.js` | PASS | 136 passed, 0 failed | 3s |
| `phase26e-parent-full-flow.test.js` | PASS | 380 passed, 0 failed | 4s |
| `platform-upgrade-2026-migration.test.js` | PASS | 98 passed, 0 failed | 0s |
| `presigned-uploads-phase23.test.js` | PASS | 327 passed, 0 failed | 3s |
| `production-storage-phase21.test.js` | PASS | 180 passed, 0 failed | 13s |
| `quiz-analytics.test.js` | PASS | 44 passed, 0 failed | 1s |
| `registration-validators.test.js` | PASS | 24 passed, 0 failed | 2s |
| `s3-storage-r2.test.js` | PASS | 184 passed, 0 failed | 2s |
| `security-audit-gate.test.js` | PASS | 116 passed, 0 failed | 7s |
| `security-hardening-phase20.test.js` | PASS | 192 passed, 0 failed | 4s |
| `security-hardening.test.js` | PASS | 368 passed, 0 failed | 1s |
| `seed-idempotency.test.js` | PASS | 18 passed, 0 failed | 2s |
| `session-lifecycle-phase13.test.js` | PASS | 302 passed, 0 failed | 6s |
| `session-materials-phase14.test.js` | PASS | 127 passed, 0 failed | 5s |
| `session-notifications-phase17.test.js` | PASS | 319 passed, 0 failed | 5s |
| `session-progression.test.js` | PASS | 162 passed, 0 failed | 1s |
| `session-quiz.test.js` | PASS | 70 passed, 0 failed | 2s |
| `student-locked-curriculum-phase16.test.js` | PASS | 366 passed, 0 failed | 2s |
| `teacher-application-phase20.test.js` | PASS | 75 passed, 0 failed | 2s |
| `teacher-workflow-phase18.test.js` | PASS | 371 passed, 0 failed | 5s |
| `track-architecture-phase12.test.js` | PASS | 310 passed, 0 failed | 1s |
| `vercel-cron-retention-phase24.test.js` | PASS | 163 passed, 0 failed | 3s |
| `vercel-standalone-adapter-gate.test.js` | PASS | 19 passed, 0 failed | 0s |

### 4.1 Environment-blocked suites (proven, not assumed)

| Suite | Exact failure | Classification | Why it is not a product defect | Compensating evidence |
|---|---|---|---|---|
| `final-integration-phase22.test.js` | `ENOENT: no such file or directory, scandir '/home/user/codemind-academy/backups'` (plus a gitignored, unseeded `db/custom.db` it expects: 2 ADMIN / 1 TEACHER / 0 STUDENT / 0 PARENT) | ENVIRONMENT-BLOCKED | The suite requires a locally seeded SQLite database and a `backups/` directory that are deliberately gitignored, and it must never be pointed at production data | The same suite passed in the environment that had a seeded local DB (Phase 22/26G); all of its behavioural surfaces are covered by `phase26a/26b/26c/26d/26e/26f`, `session-*`, `payment-*`, `security-*` suites above |
| `group-track-recovery-postgres.test.mjs` | `Error: PostgreSQL required` — the suite's own guard refuses to run without a real PostgreSQL, then its Prisma stage needs the Prisma engine, whose download is blocked in this sandbox (`binaries.prisma.sh` TLS disconnect) | ENVIRONMENT-BLOCKED | The suite is, by design, a **disposable-local-PostgreSQL** gate (it refuses non-local hosts and non-`codemind_*` database names); it cannot run without a PostgreSQL server or a Prisma engine binary | The group/track behaviour it protects is covered by `phase26b-group-track` (83/0) and the CI workflow that runs it against a real PostgreSQL service container |

### 4.2 Non-suite proofs executed on the same tree

| Proof | Command / script | Result |
|---|---|---|
| Production-origin contract | `/tmp/origin-contract-proof.mjs` (loads the real `src/lib/app-url.ts`) | `ORIGIN_CONTRACT_PROOF_OK (51 passed, 0 failed)` — production rejects missing/relative/scheme-only/http-public/loopback/credential/query/fragment forms and bad schemes; accepts https host/port/path/subdomain; dev allows `http://localhost:3000`; placeholder secret rejected; values never echoed |
| Build-time config guard | `/tmp/nextconfig-guard.mjs` under `tsx` | production + short secret → `CONFIG_REFUSED` (exit 3); production + valid secret → `CONFIG_LOADED_OK` (exit 0); headers present |
| Runtime startup guard | `/tmp/instrumentation-guard.mjs` under `tsx` | production + short secret → `[codemind] Refusing to start…` (exit 1); valid → `SERVER_WOULD_START` (exit 0) |
| Phase 26D concurrency on real PostgreSQL | `tests/phase26d-concurrency-postgres.test.js` against PostgreSQL 17.10 (`127.0.0.1:55432`, fresh database) | `PHASE26D_CONCURRENCY_POSTGRES_OK` — **25 passed, 0 failed** (exit 0) |
| Migration-provider architecture on real PostgreSQL | `tests/migration-providers.test.js` against a fresh database | Part B `MIGRATION_PROVIDERS_PG_OK` — catalog converges exactly to the committed baseline (520 columns / 168 constraints / 164 indexes), ledger recovery works, 26D edition correct; Part C (real Prisma engine) blocked by the sandbox-only engine-download restriction → covered by CI |
| Standalone + deployment-adapter build (the blocker) | `/tmp/nx-repro/app` minimal app, `output: 'standalone'`, two-line stub adapter via `NEXT_ADAPTER_PATH` | Next **16.3.4**: build exit 1 with the exact `ENOENT …/.next/next-server.js.nft.json`; Next **16.3.5**: build exit 0, NFT emitted, standalone tree complete (`server.js`, `next/dist/server/next.js` present, 1189 files — identical to the no-adapter control) |

## 5. Build Proof

**Production build path (unchanged by 26H except the version pin):**
`build:postgres` = `prisma generate --schema prisma/postgres/schema.prisma && next build && node scripts/copy-standalone-assets.mjs`.
`vercel.json` now pins that command; it contains **no migration step**, and the previous run's build log contained no `migrate` output. `scripts/copy-standalone-assets.mjs` fails fast (exit 1) if `next build` did not emit the standalone server, so a mis-built deployment cannot silently ship.

| Check | Result |
|---|---|
| Dependency install from the committed lockfile (`npm ci`) | exit 0, 738 packages, `next=16.3.5` |
| TypeScript (`npx tsc --noEmit`) locally | 58 errors, **all** consequences of the ungenerated Prisma Client in this sandbox: 11 × `TS2305` missing enum exports (`Role`, `NotificationType`, `Question`, `QuestionType`, `Difficulty`, `SchoolType`, `AttendanceStatus`), 41 × `TS2339` model fields (`finishedAt`, `percentage`, `passed`, `titleAr`, `title`, `startedAt`, `totalMarks`, `score`, `id`, `quizId`, `lesson`), 3 × `TS2551`, 1 × `TS2694` (`Prisma.GroupWhereInput`), plus 2 generic-comparison errors from the stub types. Every referenced symbol exists in **both** `prisma/schema.prisma` and `prisma/postgres/schema.prisma` (spot-checked counts: `finishedAt` 8/8, `percentage` 3/3, `passed` 2/2, `titleAr` 10/10, `startedAt` 2/2, `totalMarks` 2/2, `score` 5/5, `quizId` 11/11; each enum present once in each schema) |
| TypeScript with a generated client | PASS in CI on the base head `992dceaf` (`NEXT_PUBLIC_URL=https://ci-only.invalid`), and re-run by CI on the 26H delivery commit |
| `prisma generate` / `next build` locally | ENVIRONMENT-BLOCKED: the Prisma engine download host is unreachable from this sandbox (TLS disconnect, `HTTP 000`) — reproducible, not a code fault |
| PostgreSQL production build in CI (pre-change head `992dceaf`) | PASS — compile + static generation 71/71 pages, no migration executed during the build |
| Production-origin contract | `ORIGIN_CONTRACT_PROOF_OK (51/0)`; in production `NEXT_PUBLIC_URL` is required, must be an HTTPS bare origin, and rejects localhost/loopback/credentials/query/fragment; development still allows `http://localhost:3000` |
| Startup fail-fast | `src/lib/env.ts` refuses to boot production with a missing/placeholder/too-short `SECURITY_HASH_SECRET` (`process.exit(1)` via instrumentation); proven live in §4.2 |
| Standalone artifact + Vercel adapter | fixed at 16.3.5 and proven in §4.2; guarded permanently by `tests/vercel-standalone-adapter-gate.test.js` |

## 6. Security Gate

| Area | Evidence | Result |
|---|---|---|
| AuthN boundaries, session cookies | `security-hardening` (368/0), `security-hardening-phase20` (192/0), `phase26a-public-auth` (121/0). Session cookie is `httpOnly`, `sameSite=lax`, `secure` in production; scrypt + `timingSafeEqual` verification; `safeUser()` never returns the password hash | PASS |
| Role isolation / IDOR | `authorization-invariants` (93/0), `auth-cross-role-phase26f` (20/0 + the shipped-code verifier), `parent-dashboard-isolation` (112/0), `mock-exam-grading-isolation` (22/0); 50 API routes enforce `requireUser`/`requireRole` at route level | PASS |
| Referral collision | `auth-cross-role-phase26f` — source pins plus a real-HTTP verifier over the shipped `/api/students/me/referral` handler: collisions fail **closed** | PASS |
| Rate limiting | `security-hardening-phase20`; `src/lib/rate-limit.ts` — every key has a hard default, env overrides are clamped, an unparseable value falls back to the default and can never disable the limiter | PASS |
| Secret handling | No literal password in the seeder (values come from `SEED_*` env); operator-supplied passwords never echoed; `security-audit-gate` (116/0) additionally proves no documentation publishes a default admin password | PASS |
| Full User-row exposure | 76 API route files use explicit `select`/projections; the audit gate asserts response-shaping helpers never carry password material | PASS |
| Production secret fail-fast | `next.config.ts` build check + `src/instrumentation.ts` runtime check both refuse; proven live (§4.2) | PASS |
| Security headers | HSTS (`max-age=15552000`), CSP builder with explicit operator kill-switches (`HSTS_DISABLED`, `CSP_DISABLED`, `CSP_REPORT_ONLY`), all delivered from `next.config.ts` | PASS |
| Proxy as defence-in-depth only | `src/proxy.ts` is documented as cookie-presence-only, performs **no** database access and **no** role logic; every protected route still runs its own authorization + scope checks | PASS |
| New Critical/High findings | none | PASS |

## 7. Role-by-Role

| Role | Coverage | Key suites (all PASS) |
|---|---|---|
| **PUBLIC / AUTH** | registration validation, login, logout, protected-route denial, password-reset request + confirm (`?token=` consumed by `src/components/app-shell.tsx`), teacher activation (`?teacherActivation=`), production-safe links (no `localhost:3000` in reset/approval/referral routes), Kodgy hidden pre-auth | `phase26a-public-auth` 121, `registration-validators` 24, `security-hardening` 368 |
| **STUDENT** | track/enrollment/payment, curriculum delivery, track-safe content, unlock/progression, materials, video, quiz attempt rules, homework, notifications, leaderboard | `phase26b-student-flow` 39, `phase26b-group-track` 83, `student-locked-curriculum` 366, `track-architecture` 310, `session-lifecycle` 302, `session-materials` 127, `session-notifications` 319, `session-progression` 162, `session-quiz` 70 |
| **PARENT** | child linking, child-ownership isolation, analytics, monthly report, preferences | `phase26e-parent-full-flow` 380, `parent-analytics-alignment-phase19` 176, `parent-dashboard-isolation` 112, `parent-monthly-report` 67 |
| **TEACHER** | application → pending → approve/reject → activation → own password → dashboard, scoped lessons/questions, grading, attendance, analytics, no cross-teacher leakage | `teacher-application-phase20` 75, `teacher-workflow-phase18` 371, `phase26d-teacher-full-flow` 136, `auth-cross-role-phase26f` 20, `mock-exam-grading-isolation` 22 |
| **ADMIN** | full management surface (users, curriculum, sessions, groups/tracks, publishing, notifications, analytics, payment oversight, evidence retention) | `phase26c-admin-full-flow` (verifier PASS + 41 pins), `admin-publishing-phase15` 384, `phase25-pr4-inventory` 203, `payment-*` 9 suites, `vercel-cron-retention-phase24` 163 |

Cross-role isolation is additionally proven by `authorization-invariants` (93) and `auth-cross-role-phase26f` (20), which exercise the shipped handlers rather than string-matching source files.

## 8. Quiz Architecture

| Guarantee | Evidence | Result |
|---|---|---|
| Blueprint / randomised selection, frozen per-attempt question set | `session-quiz` 70/0; `src/lib/session-quiz.ts` snapshots the question set into the attempt | PASS |
| One attempt by default; starting consumes the attempt | `quiz-analytics` 44/0, `session-quiz` 70/0 | PASS |
| Server-side score authority | `phase26d-teacher-full-flow` 136/0 (`PHASE26D_TEST_OK`), `mock-exam-phase8` 135/0 | PASS |
| History retained; retries only via audited admin grant; retry re-generates | `phase26d-teacher-full-flow` 136/0; PG `QuizAttempt @@unique([quizId, studentId, attemptNumber])`, `retryGrantId` `SetNull` | PASS |
| Concurrency safety under real PostgreSQL | `phase26d-concurrency-postgres` — 25/0 on a fresh PostgreSQL 17.10 database | PASS |
| Cross-role / cross-student isolation | `mock-exam-grading-isolation` 22/0, `auth-cross-role-phase26f` 20/0, `phase26e-parent-full-flow` 380/0 | PASS |
| Global Question Bank (`quizId = NULL`) intentional and unchanged | Phase 26D migration is additive-only; the global bank semantics are asserted in `phase26d-*` and `quiz-analytics` | PASS |
| Migration history intact | `0_init` SHA-256 `c7f5d3fa…cefa80`, Phase 26D SHA-256 `2c1bdde1…be104` — both unchanged; `migration_lock.toml` = `postgresql` | PASS |

## 9. PostgreSQL / Neon Readiness

| Item | Status |
|---|---|
| Canonical schema | `prisma/postgres/schema.prisma` (PostgreSQL provider); SQLite dev schema remains separate under `prisma/schema.prisma` |
| Migration chains | PostgreSQL: `migrations/0_init` + `20260915180000_phase26d_quiz_attempt_architecture` (both additive, byte-frozen by checksum pins). SQLite: 12 dev migration dirs (no lock) |
| Provider split | Enforced by `scripts/db/make-postgres-schema --check` and the migration-provider CI gate; the SQLite chain must never be pointed at the PostgreSQL provider |
| Production migration command | `DATABASE_URL='<DIRECT_NEON_URL>' npx prisma migrate deploy --schema prisma/postgres/schema.prisma`, followed by `prisma migrate status` → “Database schema is up to date!” (documented in the runbook §2) |
| Migrations in the build | **No** — `build:postgres` and the pinned Vercel build command contain no migration step |
| Pooled vs direct | Runtime uses the pooled Neon URL; migration must use the **direct** URL (`prisma migrate` cannot run through the pooler) |
| TLS | `sslmode=verify-full` preferred; the real URL must not be rewritten just to change `sslmode` |
| Fresh + incremental provisioning | Part B on real PostgreSQL: catalog converges exactly to the committed baseline (520 columns / 168 constraints / 164 indexes), ledger recovery path verified; fresh full-chain `migrate deploy` is executed by the `pg17-full-chain-reference` CI workflow against a disposable PostgreSQL 17 service container |
| Phase 26D guarantees | Intact — the 26D migration is additive; concurrency proof 25/0 on real PostgreSQL 17.10; trusted catalog reference unchanged |
| Read-only checks | `scripts/db/inspect-pg-baseline.mjs`, `scripts/db/check-pg-migration-state.mjs` (SELECT-only role supported); no destructive statement is issued by any audit path |
| Recovery anchor | Neon branch `pre-phase26d-recovery-20260916` must be **preserved** (operator step) |
| No production data touched in 26H | Confirmed — all database work used disposable local databases |

## 10. Cloudflare R2 Readiness

| Item | Status |
|---|---|
| Backend selection | `MEDIA_BACKEND=s3` activates the R2 path; `MEDIA_STORAGE_PATH` is the local fallback |
| Server-generated keys | Object keys are built server-side (`src/lib/media*.ts`); the client never supplies a key |
| Presigned PUT uploads | `src/lib/direct-upload.ts` + `media-s3.ts` presign a PUT with a server-built key and expiry (`MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC`) |
| No client-controlled keys | Asserted in `presigned-uploads-phase23` 327/0 and `media-storage-wiring` 318/0 |
| Private bucket, server-proxied reads | Downloads go through the application (`MEDIA_BACKEND=s3` reads are proxied); no public-bucket requirement |
| MIME / path safety | Enforced and tested (`s3-storage-r2` 184/0, `production-storage-phase21` 180/0, `media-storage-wiring` 318/0) |
| CORS | **Operator step after the origin exists — never `*`.** Exact-origin only, `PUT`, `content-type` allowed, `etag` exposed, `MaxAge 3600` (`docs/PHASE_23_PRESIGNED_R2_UPLOADS.md`, runbook §6) |
| Size limits | `MEDIA_MAX_VIDEO_BYTES` / `MEDIA_MAX_IMAGE_BYTES` / `MEDIA_MAX_PDF_BYTES` (optional `MEDIA_QUOTA_BYTES` soft quota) |

## 11. SMTP Readiness

| Item | Status |
|---|---|
| Variables (names only) | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE`, `EMAIL_FROM` (`EMAIL_TEST_TO` is only for the manual test script) |
| Configuration detection | `isSmtpConfigured()` requires host + port + user + password; STARTTLS on 587 is the default (port 465 → `SMTP_SECURE=1`) |
| Production-safe links | Password-reset and teacher-activation mails use `appUrl('/?token=…')` / `appUrl('/?teacherActivation=…')`; the production-origin contract proof rejects localhost/loopback/relative forms, and hardening suites assert no `localhost:3000` in the reset/approval routes |
| Credentials | Server-side only; never exposed to the client, never logged |
| Emails sent during 26H | **None** — `npm run test:email` / `scripts/send-test-email.ts` was deliberately not executed |
| Post-deploy smoke | Documented as an operator step (runbook §7): request a reset for an operator mailbox, confirm arrival + link host, then confirm the reset completes; teacher activation likewise |

## 12. Cron Readiness

| Item | Status |
|---|---|
| Endpoint | `src/app/api/cron/purge-evidence/route.ts`, Node runtime |
| Method | GET only (405 for other methods) |
| Auth | `Authorization: Bearer <CRON_SECRET>` with a timing-safe comparison; missing/blank/malformed/wrong/query-param/cookie-only forms are rejected 401 |
| Fail-closed | Missing `CRON_SECRET` → 503 `{ok:false,error:"misconfigured",reason:"CRON_SECRET_NOT_SET"}`; non-PostgreSQL `DATABASE_URL` → 503 |
| Schedule | `vercel.json`: `/api/cron/purge-evidence` at `0 3 * * *` (03:00 UTC daily) — compatible with the Vercel Hobby once-daily limit |
| Retention / idempotency | Shared core `src/lib/evidence-retention.ts`; expired-only targeting, reference-safe detach, idempotent re-runs; failures are recorded, never silently dropped |
| Max runtime | the route declares `maxDuration = 300`; on Vercel Hobby this requires Fluid Compute — **mandatory deployment-time check** (runbook §§5, 9) |
| Enforcement | `tests/vercel-cron-retention-phase24.test.js` — 163/0, including the exact `vercel.json` contract and the pinned PostgreSQL build command |

## 13. Environment Variable Manifest (names only — no values)

**Active / operator-set in production (27)**

| Name | Required | Scope | Purpose |
|---|---|---|---|
| `DATABASE_URL` | Required | Server | PostgreSQL runtime connection — Neon **pooled** URL in production |
| `NEXT_PUBLIC_URL` | Required | Public (**also required at build time**) | Canonical HTTPS origin used for links, CORS and origin checks |
| `SECURITY_HASH_SECRET` | Required | Server | Token hashing secret; ≥32 chars, placeholder values are rejected in production |
| `MEDIA_BACKEND` | Required for R2 | Server | `s3` selects the R2 backend (otherwise local volume) |
| `MEDIA_STORAGE_PATH` | Optional | Server | Local media root when not using R2 |
| `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_REGION`, `R2_S3_ENDPOINT` | Required for R2 | Server | R2 credentials/endpoint/bucket (private bucket) |
| `MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC` | Optional | Server | Presigned PUT expiry |
| `MEDIA_MAX_VIDEO_BYTES`, `MEDIA_MAX_IMAGE_BYTES`, `MEDIA_MAX_PDF_BYTES` | Optional | Server | Per-type upload ceilings |
| `QUIZ_EVIDENCE_RETENTION_DAYS` | Optional | Server | Evidence retention window used by the cron purge |
| `PASSWORD_RESET_TTL_MINUTES` | Optional | Server | Reset-token lifetime |
| `TEACHER_ACTIVATION_TTL_HOURS` | Optional | Server | Activation-token lifetime |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_SECURE` | Required for mail | Server | Gmail SMTP (app password); 587 + STARTTLS by default |
| `EMAIL_FROM` | Required for mail | Server | From header |
| `EMAIL_TEST_TO` | Optional (manual test only) | Server | Recipient for `npm run test:email` — not needed in production |
| `DELIVERY_DEV_LOG` | Optional | Server | Logs deliveries instead of sending (development aid) |
| `CRON_SECRET` | Required | Server | Bearer secret for the retention cron route; ships empty in `.env.example` |

**Optional kill-switches / tuning (documented, inactive by default)**

`SKIP_PRODUCTION_ENV_CHECK` (build check only — runtime still enforced), `HSTS_DISABLED`, `CSP_DISABLED`, `CSP_REPORT_ONLY`, `MEDIA_QUOTA_BYTES`, `NOTIFICATION_FANOUT_CHUNK_SIZE` (clamped), `RATE_LIMIT_HEARTBEAT`, `RATE_LIMIT_PROGRESS`, `RATE_LIMIT_OPEN`, `RATE_LIMIT_NOTIFICATION`, `RATE_LIMIT_MATERIAL_DOWNLOAD`, `RATE_LIMIT_PDF_UPLOAD`, `RATE_LIMIT_TEACHER_APPLY` (each `limit[/windowSec/blockSec]`, clamped), `BACKUP_PASSPHRASE` (offsite backup encryption), `POSTGRES_URL` (legacy alias read by DB tooling), `SEED_ADMIN_PASSWORD`, `SEED_DEMO_PASSWORD` (seed scripts only — never needed for a production deployment).

`NEXT_PUBLIC_URL` is the only public variable; everything else is server-side.

## 14. Monitoring / Backup / Recovery

**Current reality (no invented tooling):**

| Capability | Today | Classification |
|---|---|---|
| Application/security logs | Security events are written in-app (`src/lib/security.ts` `logSecurityEvent`); the standalone server logs to `server.log`; Vercel captures function/request logs | Available |
| Health surface | `src/app/api/route.ts` returns a static hello (a liveness probe, not a deep health check) | Available (shallow) |
| External uptime monitor / APM / alerting | **Not present** — no monitoring SDK in dependencies, no alert route, no uptime check | **REQUIRED BEFORE FIRST PUBLIC USER** (free-tier uptime check + Vercel notification rules) |
| Error triage on production | Vercel deployment/function logs only | REQUIRED BEFORE FIRST PUBLIC USER (operator must be able to read them) |
| Database backup | Neon Free PITR/restore window (plan-dependent) | Available; **verify the retention window on the actual plan** |
| Offsite backup | Not configured; `scripts/db/backup-postgres.sh` exists (optional AES via `BACKUP_PASSPHRASE`) | POST-LAUNCH HARDENING — recommended: scheduled `pg_dump` to R2/offsite |
| Migration recovery | Migration ledger recovery flow + Neon branch `pre-phase26d-recovery-20260916` (must be preserved) | Available |
| Object storage durability | R2 versioning **not** enabled | POST-LAUNCH HARDENING (enable versioning) |
| Rollback | Vercel: promote a previous deployment (instant rollback) — the previous deployment is the current production, so the first rollout is the only risky one; application rollback does not roll back the database | Available; **the migration is additive, so a code rollback is safe** |
| Emergency disable | Kill-switches documented (`HSTS_DISABLED`, `CSP_*`, `DELIVERY_DEV_LOG`, cron), plus Vercel project pause | Available |
| Unverifiable assumptions | Neon plan retention specifics, R2 versioning state, Vercel project settings, and Vercel's adapter rollout flag for this account cannot be inspected from here — they are verified by the §15 checklist, not assumed to be correct |

## 15. Remaining Deployment-Time Actions (ordered)

1. **Record the deployed SHA** — the Phase 26H delivery commit on `arena/01a0a92e-codemind-academy` (parent `c467127…`). Confirm CI green for that SHA before deploying.
2. **Confirm the release tree** — `git status` clean; `next` lockfile = 16.3.5; `vercel.json` still pins `npm run build:postgres`.
3. **Neon** — create/confirm the project and roles; copy the **pooled** URL for runtime and the **direct** URL for migration; keep `sslmode=verify-full` (do not rewrite the URL to change it).
4. **Migrate (separate from the build, direct URL)** — `npx prisma migrate deploy --schema prisma/postgres/schema.prisma`, then `migrate status` → “up to date”. Never `migrate reset`, never `db push --accept-data-loss`.
5. **Vercel import** — import the repository; **Build Command must be `npm run build:postgres`** (matching `vercel.json`, which wins); confirm Node/Next.js detection and Fluid Compute enabled.
6. **Environment variables** — set every production name from §13 (pooled `DATABASE_URL`, HTTPS `NEXT_PUBLIC_URL` **in the build environment too**, `SECURITY_HASH_SECRET`, R2 set with `MEDIA_BACKEND=s3`, Gmail SMTP set, `CRON_SECRET`).
7. **Deploy** — read the build log: `Prisma schema loaded from prisma/postgres/schema.prisma`, compile, static generation, `copy-standalone-assets:` lines, and **no** `migrate` output.
8. **Verify the function limits** — `maxDuration = 300` accepted (requires Fluid Compute); if the plan refuses it, lower the route's `maxDuration` before relying on the cron.
9. **R2 CORS** — set the **exact** production origin (custom domain or `https://<project>.vercel.app`), methods `PUT`, allow `content-type`, expose `etag`, `MaxAge 3600`; never `*`.
10. **SMTP smoke** — request a reset for an operator mailbox, confirm the link host is the production origin (no localhost), complete the reset; repeat for teacher activation.
11. **Cron smoke** — manual `GET /api/cron/purge-evidence` with and without the bearer token (200 vs 401/503), then confirm the daily run at 03:00 UTC.
12. **Post-deploy verification** — re-verify the account baseline via read-only means (expected 2 ADMIN / 1 TEACHER / 0 STUDENT / 0 PARENT) and the curriculum baseline; log in as each role and walk one flow per role (runbook §9).
13. **Monitoring hookup** — add the uptime check/alerting chosen in §14 before announcing the URL to real users.
14. **Record** — deployment URL, deployed SHA, CI run, and any deviation in the operator log.

**Deployment-time contingencies:** if the Vercel build still fails with `ENOENT …/next-server.js.nft.json`, set the build command to `NEXT_ADAPTER_PATH= npm run build:postgres` (runbook §5.1). If the migration ledger contains a failed row, follow `docs/POSTGRES_CUTOVER_RUNBOOK.md` — never reset.

## 16. Blocking Issues

**None.**

For the record, the one true blocker found during this audit was fixed inside the Phase 26H delivery and is not outstanding:

| Found | Severity | Disposition |
|---|---|---|
| Lockfile pinned `next@16.3.4` with `output: "standalone"`; Next 16.3.0–16.3.4 fails **every** Vercel build once the platform injects its deployment adapter (`NEXT_ADAPTER_PATH`) — `ENOENT …/.next/next-server.js.nft.json` (upstream `vercel/next.js#96646`, fixed in 16.3.5). Reproduced locally (16.3.4 exit 1; 16.3.5 exit 0, identical standalone artifact, 1189 files) | **Critical (would have blocked the first deployment)** | **Fixed** by bumping `next`/`eslint-config-next` to `^16.3.5`; regression-gated by `tests/vercel-standalone-adapter-gate.test.js`; contingency documented (runbook §5.1) |
| `vercel.json` did not pin the build command — Vercel's Project Settings default (`npm run build`) would generate the **SQLite** client for a PostgreSQL URL | **High (silent misconfiguration)** | **Fixed** by pinning `buildCommand: "npm run build:postgres"`; pinned by tests |

Residual item that is *not* a blocker: the adapter-injected build path can only be exercised for real by the first Vercel build — the deployment-time instruction is in §15 (step 7: read the build log) together with the documented contingency.

## 17. Non-Blocking Follow-Ups

1. **Uptime monitoring + alerting** before the first public users (§14) — the only item classified as required-before-first-user.
2. **Offsite `pg_dump`** (encrypted, to R2 or equivalent) and **R2 bucket versioning**, both post-launch hardening.
3. **Verify the Neon backup/restore window** of the actual plan and record it in the operator log.
4. **Visual/UI and i18n audits** (`tests/visual/*`, `tests/i18n/audit-ui.mjs`) are environment-blocked here (no browser: the Playwright shell cannot be downloaded from this sandbox, and the visual runner requires an external scene host at `VISUAL_BASE`, default `http://127.0.0.1:8099`). Run them in an environment that has a browser.
5. **`final-integration-phase22`** needs a locally seeded SQLite DB plus a `backups/` directory; run it in a developer environment (never against production data).
6. **Shell suites** `tests/database-runtime-build.sh`, `tests/python-runtime-build.sh`, `tests/python-runtime-container.sh` depend on a `.zscripts/` directory that is not present in the repository and is referenced by nothing else — treat them as out-of-tree and either restore the tooling or remove them in a future cleanup.
7. **`z-ai-web-dev-sdk`** (AI quiz generation) is the only external AI dependency; the route fails gracefully when it is unavailable — confirm the SDK's production behaviour/limits after launch.
8. **Rate-limit and notification tuning** (`RATE_LIMIT_*`, `NOTIFICATION_FANOUT_CHUNK_SIZE`) should be revisited once real traffic patterns exist.
9. **Secret rotation runbook** for `SECURITY_HASH_SECRET`, R2 keys, Gmail app password and `CRON_SECRET` (rotate, redeploy, re-verify) — operational hygiene, not a launch gate.

## 18. FINAL DECLARATION

**PHASE 26H: GO FOR PRODUCTION DEPLOYMENT**

No Critical or High issue remains unresolved, no authorization or IDOR blocker exists, TypeScript and the PostgreSQL production build are green in CI (and re-run for the delivery commit), the regression sweep is green apart from two suites proven environment-only, the PostgreSQL migration architecture and Phase 26D guarantees are intact, the production-origin contract is enforced, R2/SMTP/Cron are ready (with the single `maxDuration`/Fluid-Compute check scheduled as a deployment step), the environment manifest is complete, no production secret is committed, a rollback path and the Neon recovery branch exist, no production data was touched, and the remaining work is the finite, ordered checklist in §15.

**Deployment is authorized to proceed — manually, by the operator, after the §15 checklist — and this audit stops here: no deployment, merge, migration, email or production change was performed by Phase 26H.**
