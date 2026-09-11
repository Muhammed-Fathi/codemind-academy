# Phase 21 — Production Database & Storage

**Status:** implemented, verified, awaiting pre-merge audit (STOP BEFORE MERGE).
**Scope:** PostgreSQL cutover, durable media, backups, restore, retention,
quotas, production setup. No application-semantics change; no Phase 20 rework;
no Phase 22 work.
**Runbook (operator):** `docs/POSTGRES_CUTOVER_RUNBOOK.md`.

---

## 0. Pre-P21 Security Audit Gate → GO

| Gate item | Verdict |
|---|---|
| Report | `docs/SECURITY_AUDIT_GATE_PRE_PHASE21.md` (8 findings, all remediated in-tree) |
| Critical open | **0** (F-01, F-02 fixed + verified) |
| High open | **0** (F-03, F-04, F-06 fixed + verified) |
| Medium open | 0 fixed-open; R-1…R-7 accepted/documented posture risks (no code action) |
| Final verdict | **CONDITIONAL GO — MEDIUM RISKS DOCUMENTED** |
| Consumed by P21 | R-5 explicitly defers durability/retention/backup to Phase 21 (this phase); F-09's 8-char floor enforced in `setup-production.ts`; no gate regression touched |

Phase 21 was therefore NOT blocked. The gate was consumed, not redone: no new
security phase, no auth redesign, no dependency churn for security reasons.

## 1. Discovery (what the data layer actually is)

Source of truth was the code, not stale docs:

- **Schema:** `prisma/schema.prisma` — 55 models, 21 enums, 73 FK relations,
  34 UNIQUE constraints, 67 `@@index`es. Dead-but-kept schema (`Track`,
  `Enrollment`, `Course.trackId`) per the Phase 12 verdict — preserved 1:1,
  never backfilled.
- **No raw SQL in `src/`** (zero `$queryRaw`/`$executeRaw`) and no
  SQLite-only SQL functions — every query is a Prisma Client call, so the
  provider switch changes no application query. Verified by sweep in
  `tests/production-storage-phase21.test.js` §3.
- **JSON is opaque String** (`Question.options`, `ExamQuestion.options`,
  `ExamAttempt.answers`, `LessonPlanTemplate.objectives/materials/activities`,
  `AuditLog.details`) — never filtered in SQL, so it stays TEXT on PostgreSQL
  (no JSONB conversion; byte-identity is the requirement).
- **DateTime** is connector-managed (Prisma writes UTC); the repo's own
  adapter already tolerates TEXT-ISO, naive `"YYYY-MM-DD HH:MM:SS"` and
  INTEGER-ms encodings in SQLite — the migrator matches that tolerance.
- **Security persistence (Phase 20, unchanged):** `UserSession` (SHA-256
  tokenHash, UNIQUE), `PasswordResetToken` (hash, UNIQUE, single-use),
  `TeacherApplication` (unique email, PENDING default, nullable unique
  userId) + `TeacherActivationToken` (hash UNIQUE, guarded consume in
  `$transaction`), `SecurityRateLimit` (UNIQUE(bucket, identifier), guarded
  `upsert(update:{})` + `updateMany` claims), `SecurityEvent` (append-only
  audit). All portable Prisma calls (`findUnique`/`updateMany`/`upsert`/
  `$transaction`) — no provider-specific behavior.
- **Media:** `MediaAsset` (EXTERNAL_URL / LOCAL_PRIVATE / S3) + `SessionVideo`
  + `Material` + `QuizAttemptEvidence`; bytes live under `MEDIA_STORAGE_PATH`
  (default `./storage/media`, gitignored) behind traversal-safe keys, served
  only through authorized routes. `S3` exists as an enum value but no S3 client
  exists — LOCAL_PRIVATE is the only upload backend.
- **Retention before P21:** `retainUntil` was STAMPED at capture but never
  PURGED (no cleanup job existed). `QUIZ_EVIDENCE_RETENTION_DAYS` default 30.
- **Quotas before P21:** per-file caps only (`MAX_*_BYTES`); no volume quota
  (explicitly deferred to P21 by the Phase 20 AV/quota decision).
- **setup-production.ts before P21:** reset script covering the ORIGINAL
  tables only — left MockExam/SessionVideo/MediaAsset/Batch/security/evidence
  rows behind, and deleted `Group` before `Student` (unsafe on PostgreSQL,
  where `Student.groupId` has NO database cascade).

## 2. PostgreSQL Design (one schema, derived artifacts)

There is exactly ONE schema source of truth: `prisma/schema.prisma`.

| Artifact | How produced | Role |
|---|---|---|
| `prisma/schema.postgresql.prisma` | `node scripts/db/make-postgres-schema.mjs` (byte-copy, ONLY `provider` swapped + header) | What the operator points Prisma at on the production host |
| `scripts/db/postgres-baseline.sql` | same generator, via `pg-lib.emitPostgresDdl` (21 `CREATE TYPE` + 55 `CREATE TABLE` + 67 `CREATE INDEX` = 143 statements) | Byte-reviewable baseline when engines are unreachable; disaster-recovery DDL |
| `scripts/db/pg-lib.mjs` | hand-written, tested | ONE parser + DDL emitter + migration order + value mapper + dump/restore shared by every tool |

Drift is impossible by construction: `make-postgres-schema.mjs --check` (run
by the offline suite on every run) fails if either committed artifact differs
from what the CURRENT schema generates. Old SQLite migrations are preserved
untouched and NEVER replayed on PostgreSQL (the runbook baselines the ledger
with `prisma migrate resolve --applied`).

Connection strategy: stock Prisma PostgreSQL datasource (`DATABASE_URL`).
No PgBouncer assumption (documented flag only if a pooler is actually used);
no `directUrl` games; credentials via environment/secret manager, redacted in
every tool's output.

## 3. Schema Compatibility (PostgreSQL)

- **Types:** String→TEXT, Int→INTEGER, Float→DOUBLE PRECISION,
  Boolean→BOOLEAN, DateTime→TIMESTAMPTZ(3), enums→native `CREATE TYPE ENUM`.
  No Bytes/Json/Decimal/BigInt/autoincrement/`@db.*`/`dbgenerated()` anywhere
  (asserted by the suite).
- **Defaults:** `now()`→`CURRENT_TIMESTAMP`, booleans/ints→literals,
  enums→`'V'`, strings→escaped literals; `cuid()`/`@updatedAt` stay
  client-generated (no DB default) exactly as Prisma does.
- **Constraints:** 55 PKs, 34 UNIQUEs, 73 FKs (declared `ON DELETE` honored;
  the 9 edges without one become NO ACTION on both providers — identical
  semantics), 67 secondary indexes. All names deterministic and ≤63 bytes.
- **NULL-in-UNIQUE:** SQLite and PostgreSQL agree (NULLs distinct), so
  `Student.nationalId`, `Batch(schoolType,courseId)`, `MockExamQuestion`
  pairs etc. migrate with identical duplicate semantics (proven: the duplicate
  scan in the drill finds 0 groups on both sides).
- **FK actions:** Prisma's `ON UPDATE CASCADE` emitted on every FK (matches
  the connector, keeps the first post-cutover `migrate diff` clean).
- **Rate-limit primitive:** `upsert(update:{})` (INSERT…ON CONFLICT DO NOTHING)
  + guarded `UPDATE…WHERE count < limit` are fully supported on PostgreSQL;
  the drill's probe (F1) proves idempotent-ensure + exact-limit claims +
  duplicate rejection against the real UNIQUE constraint, rolled back.
- **Activation primitive:** single-use consume via guarded `updateMany` inside
  `$transaction` is provider-agnostic; the drill proves the underlying UNIQUE
  (tokenHash) + FK + status coherence on PostgreSQL.

## 4. Teacher Application Persistence

The Phase 20 lifecycle (`PENDING → APPROVED → ACTIVATED`, or `→ REJECTED`;
re-apply re-opens the SAME row) is persisted WITHOUT redesign:

- Uniqueness: `email UNIQUE` (one identity forever), `userId UNIQUE NULLABLE`
  (set only at activation), `tokenHash UNIQUE` (single-use).
- Idempotent approval: guarded `updateMany(PENDING→APPROVED)` — exactly one
  concurrent approver wins on PostgreSQL (MVCC row lock), retries report
  `alreadyApproved`.
- Safe rejection: status flip + live-token rescind (`usedAt` set).
- Non-replayable activation: token consumed by guarded `updateMany(id, usedAt
  NULL)` inside `$transaction` with the User+Teacher+ACTIVATED writes.
- Referential integrity: token→application FK `ON DELETE CASCADE`;
  application→User links (`userId`, `reviewedByUserId`) are
  application-maintained (no DB FK — deliberate, Phase 20 design) and verified
  by coherence rules D1–D4 in `scripts/db/verify-postgres.mjs`.
- Auditability: full history preserved (status transitions via `reviewedAt`/
  `adminNote`; token rows retained with `usedAt`; `SecurityEvent` +
  `AuditLog` rows migrated 1:1).

Fixtures cover all four states (PENDING/REJECTED/APPROVED/ACTIVATED) plus
live/used/expired tokens; the rehearsal + restore drills assert all four
survive with coherence intact.

## 5. Data Migration

`node scripts/db/migrate-sqlite-to-postgres.mjs --source <sqlite> --target <pg-url>`:

- Copies ALL 55 tables in topological order (parents first; cycle = loud
  error) as parameterized multi-row INSERTs (default 500/batch).
- Preserves IDs, relationships, timestamps (tolerant UTC parsing of all three
  SQLite DateTime encodings — ISO, naive, ms-epoch), and opaque blobs
  verbatim.
- The ONLY exclusion is `_prisma_migrations` (engine ledger). There is NO
  "demo security data" carve-out — sessions, tokens, rate limits, security
  events and audit rows migrate 1:1 (Phase 22 owns production cleanup).
- Fail-closed: source must have all 55 tables (else: migrate SQLite to head
  first); target must have the baseline AND be empty (else: abort); the whole
  load is ONE transaction; post-load count + canonical-hash verification runs
  INSIDE the transaction (mismatch = rollback, exit 4).
- Emits a JSON load manifest (per-table rows + sha256, redacted target, tool
  version) — the cutover's auditable receipt.

## 6. Rehearsal

`node scripts/verify-phase21-migration.mjs` → `PHASE21_MIGRATION_OK` (28/28):

- Scratch SQLite at migration head (base DDL + all 9 REAL migrations) +
  97-row production-shaped fixture set (every table ≥1 row; official
  curriculum + legacy row; both school types; all teacher states; security
  history; expired/live evidence).
- Disposable PostgreSQL (PGlite — the real PostgreSQL 18 engine, same dialect
  and constraint enforcement as server PG) + committed baseline.
- Same pg-lib copy primitives as the operator CLI → counts match on all 55
  tables, canonical hashes identical, naive/ms DateTimes land on the right
  UTC instants, and the full battery (A–G: presence, orphans, duplicates,
  lifecycle, security, rate-limit probe, 7 app-shaped regression queries)
  passes with exact fixture expectations.

## 7. Backups

Production: `scripts/db/backup-postgres.sh` — full `pg_dump --format=custom`
(schema + ALL data, nothing excluded) + `.sha256` sidecar (write-time
re-verified) + JSON manifest (pg version, bytes, per-table counts) + optional
AES-256-CBC/PBKDF2 encryption (`BACKUP_PASSPHRASE` from secret manager only) +
retention (`--retain-days 30 --keep-min 7`: age-based purge that ALWAYS keeps
the 7 newest). Credentials redacted; exit `BACKUP_OK`.

The drill's logical dump (`pg-lib.dumpPostgresToSql`: deterministic INSERTs +
manifest with per-table sha256 + whole-file sha256) proves the RESTORE
PROCEDURE identically for both artifact formats; the runbook requires a
quarterly REAL `pg_restore`-from-`pg_dump` drill as the production proof.

## 8. Restore Drill

`node scripts/verify-phase21-restore.mjs` → `PHASE21_RESTORE_OK` (40/40):

- Backup of disposable PG-A → restore into disposable PG-B (empty baseline
  only — proves self-sufficiency, one transaction) → B identical to A
  (counts + hashes, 55 tables) → FULL battery passes ON B (the application
  connects; enrollment/progression/activation/session/material/notification
  queries work) → all four application states + 5 security events present →
  tamper check: a 1-byte-modified backup FAILS sha256 AND the manifest
  table-hash (integrity verification is non-vacuous).
- Production restores use `scripts/db/restore-postgres.sh`: sidecar verify →
  decrypt-to-shredded-scratch → empty-target preflight → `pg_restore
  --no-owner` → REQUIRED `verify-postgres.mjs` battery (`RESTORE_OK` only if
  the battery passes). A backup is never called "verified" without the battery.

## 9. Durable Media

Decision: **filesystem volume** (`MEDIA_STORAGE_PATH` → persistent mount),
NOT object storage — the repo has no S3 client (only the enum value), the
single-VPS + Caddy deployment is volume-native, and `MediaAsset` already
provides the storage separation (no new abstraction introduced, per spec).
The `S3` enum value stays reserved for a future backend that must sit behind
the same `MediaAsset` + authorized-route contract.

`node scripts/media/migrate-media.mjs`: sorted deterministic inventory,
per-file SHA-256 before+after copy, JSON manifest, `--check` audit mode,
symlinks skipped-and-listed, and it NEVER deletes the source (operator deletes
only after a successful `--check`; the runbook makes it a two-person step).

## 10. Evidence Retention

- Policy: `src/lib/evidence-retention.ts` (canonical rule — expired iff
  `retainUntil NOT NULL AND <= now`; NULL/unparseable = keep forever;
  `QUIZ_EVIDENCE_RETENTION_DAYS` validated 1..3650, default 30).
- Job: `npx tsx scripts/media/purge-expired-evidence.ts` — dry-run BY DEFAULT
  (read-only SQLite handle / SELECTs only on PG); deletion needs BOTH `--live`
  AND `--yes`. Evidence rows delete in one transaction; unreferenced
  LOCAL_PRIVATE assets delete (row + bytes, bytes after commit, per-file
  best-effort with recorded failures + next-run convergence); referenced
  metadata (attempts, students, audit) untouched; protected-table counts
  snapshotted before/after with FAIL on any move
  (`SecurityEvent/AuditLog/TeacherApplication/TeacherActivationToken/UserSession/PasswordResetToken/SecurityRateLimit`
  + QuizAttempt/Student/User). Metrics JSON per run for cron auditability.
- Proven: dry-run finds exactly the expired row and changes nothing; live
  deletes exactly it; a shared asset is retained (refcount); a detached asset
  loses row + file; protected counts byte-identical.

Security/audit retention itself is NOT implemented here (a Phase 22 policy
decision) — this phase only guarantees evidence cleanup CANNOT touch it.

## 11. Quotas

- Per-file caps (unchanged): `MEDIA_MAX_VIDEO_BYTES` (512MB),
  `MEDIA_MAX_IMAGE_BYTES` (5MB), `MEDIA_MAX_PDF_BYTES` (25MB).
- NEW volume quota: `MEDIA_QUOTA_BYTES` (unset/0 = unlimited = byte-identical
  behavior to before; set = fail-closed 413 `QUOTA_EXCEEDED` BEFORE any byte
  is written or any DB row created). Human sizes accepted (`10GB`, `512 MB`);
  garbage throws (never silent-unlimited). No shell-outs, no symlink
  following, no filesystem-type assumptions.
- Wired into all three upload paths (PDF materials incl. a new
  `QUOTA_EXCEEDED` result code → 413, session videos, quiz evidence).
- Pure policy in `src/lib/storage-quotas.ts` (tested without I/O + with
  scratch dirs).

## 12. Setup Production

`scripts/setup-production.ts` rewritten for the full model set: provider-aware
(provider + redacted URL + per-table counts before confirmation), `--dry-run`,
PostgreSQL-safe deletion order (explicit children-first incl. all NO-cascade
edges; `MediaAsset` last due to `Restrict`), covers videos/mock
exams/enrollments/materials/publications/Teacher Applications/activation
tokens/sessions/reset tokens/rate limits/security events/evidence, preserves
Settings + SubscriptionPlans, still creates exactly ONE interactive admin
(8-char floor), creates NO teacher (Phase 20 flow only — asserted), and
verifies zero leftover rows including provisioning/security tables. NOT run
against production in this phase (Phase 22 owns the final cleanup).

## 13. Rollback

Documented in `docs/POSTGRES_CUTOVER_RUNBOOK.md` §7: SQLite is untouched by
the cutover, so rollback inside the window is a re-point (stop app → restore
`DATABASE_URL`/`MEDIA_STORAGE_PATH` → smoke tests), with an explicit
data-loss-window rule (writes accepted on PG after the switch cannot roll back
to SQLite — that forces fix-forward). Post-go-live disaster recovery is
restore-into-fresh-DB + re-point (RPO = last backup). Decision triggers and
forensics preservation are specified.

## 14. Tests

`tests/production-storage-phase21.test.js` (offline, no credentials):
gate-GO prerequisite; single-source derivation (`--check` + byte-identity);
portability (55/21/73/34/67, every column mappable, order total/deterministic,
143-statement baseline, no JSONB, no raw SQL in `src/`);
teacher-persistence invariants; CLI fail-closed behavior (exits 2, helpful
errors); shell-script syntax + safety invariants; behavioral media migration
(copy/verify/tamper/determinism); behavioral retention (rule harness via tsx +
dry-run/live/refcount/file-deletion through the real purge script); quota
wiring on all 3 paths; setup-production completeness + no-teacher proof; BOTH
live drills as subprocesses; docs/env/ignore/secret-sweep. Plus the two drill
scripts (28 + 40 checks on disposable PostgreSQL) and `verify-postgres.mjs`
(19 checks, reusable by operators on ANY PostgreSQL).

## 15. Security

- No credentials committed (swept); URLs redacted in every tool; backup
  passphrase from secret manager only; backup dir 0700/0600; volumes never
  public (bytes only via authorized routes — unchanged).
- Activation/reset/session/token persistence UNCHANGED from the Phase 20
  design (hashes only, single-use, short-lived) — this phase only proves the
  PostgreSQL layer enforces the same constraints (UNIQUE/FK/transactional).
- No security invariant weakened: quota is additive-reject, retention deletes
  only expired evidence, migration preserves audit history, setup creates no
  privileged account beyond the interactive admin.
- No full-repo re-audit performed (out of scope; the gate stands).

## 16. Regression

No application behavior changed (only additive-reject quota checks that are
off by default + additive tooling/docs). Regression evidence:
- App-shaped queries G1–G7 pass on PostgreSQL with exact expectations
  (enrollment, progression universe `1-1,1-2`, activation lookup, session
  lookup, material authorization, notifications, track-scope data).
- Authorization/track-isolation/lifecycle/ownership logic untouched (no
  `src/` query changed; quota checks run before writes and return new codes
  only when the operator enables them).
- Full offline suite (`tests/*.test.js`) + typecheck/lint baselines: see
  PROJECT_STATE / final report.

## 17. Typecheck / Lint / Build

- `tsc --noEmit` / `eslint .`: compared against the pre-change baseline
  (gate-recorded: 27 TS errors / 134 lint problems, all pre-existing and
  environmental — Prisma engines unreachable). No NEW findings in Phase 21
  files (see final report §18–§19).
- `next build`: CANNOT run in this sandbox (`prisma generate` needs
  binaries.prisma.sh — same environmental block as Phases 6–20, documented).
  The production build must be re-run where engines are reachable; no Phase 21
  change affects the build graph except two additive lib modules + quota
  call-sites (typechecked).

## 18. Files Changed

New: `scripts/db/pg-lib.mjs`, `scripts/db/make-postgres-schema.mjs`,
`scripts/db/postgres-baseline.sql`, `scripts/db/migrate-sqlite-to-postgres.mjs`,
`scripts/db/verify-postgres.mjs`, `scripts/db/fixtures-phase21.mjs`,
`scripts/db/backup-postgres.sh`, `scripts/db/restore-postgres.sh`,
`scripts/media/migrate-media.mjs`, `scripts/media/purge-expired-evidence.ts`,
`scripts/verify-phase21-migration.mjs`, `scripts/verify-phase21-restore.mjs`,
`src/lib/storage-quotas.ts`, `src/lib/evidence-retention.ts`,
`prisma/schema.postgresql.prisma`, `tests/production-storage-phase21.test.js`,
`docs/PHASE_21_PRODUCTION_DATABASE_STORAGE.md`,
`docs/POSTGRES_CUTOVER_RUNBOOK.md`.
Modified: `src/lib/media.ts` (checksums), `src/lib/session-materials.ts`
(+`QUOTA_EXCEEDED`), 3 upload routes (quota wiring), `scripts/setup-production.ts`
(full rewrite per §12), `.env.example`, `.gitignore`, `package.json` +
`package-lock.json` (`pg` + `@electric-sql/pglite` + `@types/pg`),
`docs/DATABASE_GUIDE.md`, `docs/DEPLOYMENT_GUIDE.md`, `docs/PROJECT_STATE.md`.
Untouched: `prisma/migrations/*` (all 9), every `src/` query, every lifecycle.

## 19. Remaining Limitations

1. `next build` / `prisma generate` / `prisma migrate` unverifiable here
   (binaries.prisma.sh blocked) — must be re-run where reachable; the
   `postgres-baseline.sql` path exists precisely for engine-less hosts.
2. No live-server (TCP) PostgreSQL in this sandbox — drills ran on PGlite
   (real PG 18 engine, same dialect/constraints); the operator CLI path
   (`pg` driver) is code-reviewed + shares pg-lib primitives but needs one
   real-server rehearsal during the pre-freeze (§1.4 of the runbook).
3. `bun.lock` not refreshed (bun unavailable here; `pg`/`pglite` added via
   npm) — run `bun install` once where bun exists.
4. PGlite is a devDependency used ONLY by drills/tests — never imported by
   the app or by production scripts (asserted by import sweep).
5. First post-cutover `prisma migrate` may reconcile index names (cosmetic;
   runbook §10 covers it).
