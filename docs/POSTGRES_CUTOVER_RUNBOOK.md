# CodeMind Academy — PostgreSQL Cutover Runbook (Phase 21)

**Audience:** the operator performing the production cutover (SQLite file →
PostgreSQL) and any future disaster-recovery restore.
**Prerequisites:** Pre-P21 Security Audit Gate = GO; Phase 21 merged; this
runbook read end-to-end BEFORE the freeze window opens.
**Non-goals:** final production cleanup / allowlist (Phase 22); application
behavior changes (none — the app issues identical Prisma queries on both
providers).

Related: `docs/PHASE_21_PRODUCTION_DATABASE_STORAGE.md` (design + evidence),
`docs/DATABASE_GUIDE.md` (reference), `docs/DEPLOYMENT_GUIDE.md` (deployment).

---

## 0. Inventory — what you need in hand

| Item | Location / command |
|---|---|
| Source of truth schema | `prisma/schema.prisma` (SQLite, dev) |
| Derived PG schema | `prisma/postgres/schema.prisma` (regenerate: `node scripts/db/make-postgres-schema.mjs`; verify: `… --check`) |
| PG migrations | `prisma/postgres/migrations/` (`0_init` + timestamped, provider = postgresql) |
| SQLite migrations | `prisma/migrations/` (provider = sqlite — NEVER deploy these on PostgreSQL) |
| Baseline DDL | `scripts/db/postgres-baseline.sql` (same generator; reference/restore/verification artifact) |
| Read-only state checker | `node scripts/db/check-pg-migration-state.mjs --target <pg-url>` |
| Cutover loader | `node scripts/db/migrate-sqlite-to-postgres.mjs --source <sqlite> --target <pg-url> --manifest <path>` |
| Verification battery | `node scripts/db/verify-postgres.mjs --target <pg-url>` |
| Backup | `scripts/db/backup-postgres.sh --out-dir <dir>` |
| Restore | `scripts/db/restore-postgres.sh --backup <file> --target <pg-url>` |
| Media migration | `node scripts/media/migrate-media.mjs --source <old> --dest <new> --manifest <path>` |
| Evidence purge | `npx tsx scripts/media/purge-expired-evidence.ts --target <pg-url> [--live --yes]` |

Collect BEFORE the window: the SQLite file path, the PostgreSQL superuser URL
(creation) + the app-role URL (runtime), the backup directory (separate volume
from the database), the media source/dest paths, and the on-call contact.
Confirm `pg_dump`/`pg_restore`/`psql` client versions match the server major.

---

## 1. Pre-freeze (days before; no downtime)

1. **Provision PostgreSQL.** Managed Postgres (Neon / Supabase / RDS / bare
   `postgres:16+`) with automated snapshots enabled at the provider level (in
   addition to this runbook's logical backups). Create TWO roles:
   `codemind_app` (owns nothing, grants: CONNECT + ALL on schema public +
   default privileges) and `codemind_owner` (owns schema objects, used only for
   DDL/restore). The app NEVER runs as a superuser.
2. **Create the empty database** (`createdb -O codemind_owner codemind`) and
   provision the schema — the ONE supported path (engines available):
   `bunx prisma migrate deploy --schema prisma/postgres/schema.prisma`
   (applies `0_init` and everything after it — no baseline.sql, no
   `migrate resolve`, no manual steps).
   Engines unreachable / byte-reviewable fallback:
   `psql "$URL" -f scripts/db/postgres-baseline.sql` produces the same shape,
   but then baseline the ledger exactly as §5 describes BEFORE the next
   `migrate deploy`, or deploy will try to re-create the schema.
   Then: `node scripts/db/verify-postgres.mjs --target "$URL"` — expect A1–A5
   present with zero rows (B/C trivially pass, D1–D4 pass vacuously, F1 passes,
   G-queries return 0 rows — run WITHOUT `--expect-fixtures`).
3. **Migrate media FIRST** (it is the slowest step and needs no freeze):
   `node scripts/media/migrate-media.mjs --source "$MEDIA_STORAGE_PATH" --dest /mnt/codemind-media --manifest /var/backups/codemind/media-pre.json`
   then `--check`. Point a STAGING app at the new volume and spot-check one
   PDF + one video + one evidence image through the authorized routes. Do NOT
   delete the source tree yet (§8).
4. **Rehearse the load** on a disposable database (this is the drill from
   `scripts/verify-phase21-migration.mjs`, but with a REAL `pg` server and a
   COPY of production SQLite — never the live file):
   `createdb codemind_rehearsal && psql … -f scripts/db/postgres-baseline.sql &&`
   `node scripts/db/migrate-sqlite-to-postgres.mjs --source /copy/of/custom.db --target … --manifest /tmp/rehearsal.json &&`
   `node scripts/db/verify-postgres.mjs --target …`.
   Record the wall-clock time — that is your minimum freeze window plus margin.
5. **Schedule the freeze window** (rehearsal time × 3, minimum 1 hour) and
   announce it. Prepare the rollback decision point (§7): if ANY step below
   fails its verification, STOP and roll back — do not improvise forward.

## 2. Freeze window opens

1. Put the app in read-only/maintenance mode (stop the Next.js service; confirm
   no process holds the SQLite file: `fuser db/custom.db` / `lsof`).
2. **SQLite snapshot** (the rollback artifact — keep until §8):
   `cp db/custom.db "/var/backups/codemind/sqlite-pre-cutover-$(date -u +%Y%m%dT%H%M%SZ).db"`
   plus `sha256sum` recorded. Verify the copy opens and counts match
   (`SELECT COUNT(*) FROM "User";` etc. against the COPY).

## 3. Load

1. If the pre-freeze baseline database was dropped/recreated since §1, re-apply
   the baseline now (empty target required — the loader aborts otherwise).
2. Run the loader against the LIVE SQLite file (frozen, so stable):
   `node scripts/db/migrate-sqlite-to-postgres.mjs --source db/custom.db --target "$APP_URL" --manifest /var/backups/codemind/pg-load-<stamp>.json`
   The loader copies all 55 tables in dependency order inside ONE transaction
   and re-verifies counts + canonical row hashes before committing. On ANY
   failure it rolls back and exits non-zero — fix the cause, re-empty the
   target, re-run. The ONLY excluded table is `_prisma_migrations` (engine
   ledger; PostgreSQL gets its own in §5).
3. Expected output ends with `LOAD OK: <N> rows, 55 tables, manifest: …`.

## 4. Validation (on PostgreSQL, before switching traffic)

Run the battery (no fixtures flag — this is real data):
`node scripts/db/verify-postgres.mjs --target "$APP_URL"` → must end `VERIFY_POSTGRES_OK`.

What it checks (fail = stop, roll back per §7):
- **A. Presence** — 55 tables / 21 enums + exact values / 73 FKs / 34 UNIQUEs / 67 indexes.
- **B. Orphans** — every FK column scanned, 0 dangling rows.
- **C. Duplicates** — every UNIQUE + PK scanned, 0 duplicate groups.
- **D. Teacher lifecycle coherence** — ACTIVATED ⇒ live TEACHER User; APPROVED ⇒
  token minted; unused token ⇒ APPROVED application; reviewers exist.
- **E. Security tables** — sessions/tokens/rate-limits/events/audit present,
  no NULL token hashes.
- **F. Rate-limit foundation** — UNIQUE admits idempotent ensure + exact-limit
  guarded claims, rejects duplicates (rolled back, zero residue).
- **G. App-shaped queries** — enrollment join, PUBLISHED universe, activation
  lookup, session lookup, material authorization join, notifications.

Then compare the loader manifest counts against the SQLite snapshot counts
(table by table — the manifest JSON has per-table rows + sha256).

## 5. Migration architecture (provider-split) and the ledger baseline

**The rule (Phase 26D hotfix, 2026-09-15): each provider owns its own
migrations directory, because Prisma reads the migrations directory NEXT TO
the schema file.**

- `prisma/schema.prisma` (sqlite) → `prisma/migrations/` — 12 SQLite
  migrations. These contain SQLite-flavoured SQL (`DATETIME`, …) and MUST
  NEVER be deployed against PostgreSQL.
- `prisma/postgres/schema.prisma` (postgresql) → `prisma/postgres/migrations/`
  — `0_init` (the frozen pre-26D production schema) plus every PostgreSQL
  migration after it.

Before the hotfix, `prisma/schema.postgresql.prisma` lived directly in
`prisma/`, shared `prisma/migrations` with SQLite, and
`bunx prisma migrate deploy --schema prisma/schema.postgresql.prisma`
replayed the SQLite Phase 26D migration on Neon — it failed on the first DDL
statement with `type "datetime" does not exist` (42704). Recovery for THAT
incident is §11. The architecture is enforced by
`tests/migration-providers.test.js` (CI: `.github/workflows/migration-providers-postgres.yml`).

**Ledger state on the production database:** the cutover-era
`migrate resolve --applied` records (11 pre-26D SQLite-named rows) and — after
the §11 recovery — one `0_init` row, one rolled-back Phase 26D row and one
applied Phase 26D row. Rows whose names are not in the active directory are
inert history: `migrate deploy` ignores them, `migrate status` stays clean
(proven by the CI gate on a real PostgreSQL).

**Going forward:** every PostgreSQL schema change is a NEW timestamped
migration in `prisma/postgres/migrations/` (never an edit to an applied file —
its sha256 is recorded in every environment's `_prisma_migrations`), deployed
with:
`bunx prisma migrate deploy --schema prisma/postgres/schema.prisma`

**If a database was provisioned from `scripts/db/postgres-baseline.sql` (or
restored from a backup taken before `0_init` was recorded) and therefore has
no `0_init` ledger row:** run `bunx prisma migrate resolve --applied 0_init
--schema prisma/postgres/schema.prisma` once, after verifying with
`node scripts/db/check-pg-migration-state.mjs --target "$URL"` that the live
schema really matches `0_init`'s inventory. Otherwise the next deploy will
try to re-create the schema and fail (loudly) on duplicate objects.

## 6. Switch (DNS / connection)

1. Set the production `DATABASE_URL` to the PostgreSQL URL (secret manager /
   systemd `EnvironmentFile`, mode 0600 — never in Git, never in chat logs).
   Recommended: `?sslmode=require` (+ `&pgbouncer=true` ONLY if you actually
   run PgBouncer — Prisma needs the flag to disable prepared-statement
   assumptions; without a pooler, omit it).
2. Point `MEDIA_STORAGE_PATH` at the durable volume (§1.3) and set
   `MEDIA_QUOTA_BYTES` (e.g. 80% of the volume).
3. Start the app, tail the logs for Prisma connection errors.
4. **Smoke test as each role** (admin / teacher / student / parent): login,
   open one session, start + submit one quiz, download one PDF, check one
   notification. Exercise ONE teacher-application admin page load (read-only).
5. Schedule the FIRST `pg_dump` backup immediately (§9) — the cutover is not
   done until a backup exists.

## 7. Rollback (operationally realistic)

**Trigger:** ANY validation/smoke failure in §4/§6, or app errors within the
first hour that implicate the data layer.

**Procedure (SQLite is untouched — rollback is a re-point, not a restore):**
1. Stop the app.
2. Set `DATABASE_URL` back to the SQLite file (`file:./db/custom.db`) and
   `MEDIA_STORAGE_PATH` back to the pre-cutover tree.
3. Start the app, re-run the role smoke tests.
4. Root-cause from the loader manifest + battery output + app logs. The
   PostgreSQL database is left AS-IS for forensics (do not drop it until the
   post-mortem is written).

**Data-loss window:** writes accepted on PostgreSQL between §6.3 and the
rollback decision are NOT in SQLite. If the window accepted writes, the ONLY
supported forward path is fix-forward on PostgreSQL (§4 again) — rolling back
to SQLite after PostgreSQL accepted writes DISCARDS those writes. This is why
§6.4 smoke tests run BEFORE announcing the window closed, and why the rollback
decision point is "within the first hour". After the window closes normally,
SQLite is read-only history (kept per §8, never written again).

**Disaster rollback (PostgreSQL lost AFTER go-live):** there is no SQLite to
return to — restore the latest verified backup into a FRESH database with
`scripts/db/restore-postgres.sh` (it enforces empty-target + sha256 + the
battery), then re-point. RPO = last backup; RTO = restore + battery time
(measured in rehearsal — record both in the cutover log).

## 8. Post-cutover (first week)

1. Keep the SQLite snapshot + loader manifest for 30 days (rollback forensics),
   then archive per data policy.
2. Keep the pre-cutover media tree until the second successful `--check` of the
   durable volume (two-person step: one runs `--check`, one deletes).
3. Nightly `backup-postgres.sh` via cron/systemd timer (see §9); weekly restore
   drill into a disposable database (the drill script
   `scripts/verify-phase21-restore.mjs` proves the PROCEDURE; quarterly, run a
   REAL `pg_restore` from a REAL `pg_dump` artifact — `RESTORE_OK` from the
   shell script is the production proof).
4. Nightly evidence purge (dry-run first week, `--live --yes` after):
   `npx tsx scripts/media/purge-expired-evidence.ts --target "$APP_URL" --live --yes --metrics /var/log/codemind/purge-<date>.json`.
5. Watch: connection count (Prisma pool vs `max_connections`), slow queries
   (`pg_stat_statements` if available), volume usage vs `MEDIA_QUOTA_BYTES`.

## 9. Backup & retention reference

- **What:** full `pg_dump --format=custom` (schema + ALL data — curriculum,
  progress, Teacher Applications, provisioning state, security/audit tables,
  sessions/tokens). Nothing excluded.
- **Where:** a volume SEPARATE from the database host (plus provider snapshots
  as a second layer). Mode 0700 directory, 0600 files.
- **Encryption:** `BACKUP_PASSPHRASE` from the secret manager (AES-256-CBC /
  PBKDF2, 200k iterations). Without it, rely on volume encryption + file modes
  (document the choice in the cutover log).
- **Integrity:** `.sha256` sidecar written + re-verified at backup time;
  re-verified before every restore (mismatch = refuse).
- **Retention:** `--retain-days 30 --keep-min 7` defaults (never fewer than 7
  artifacts regardless of age).
- **Manifest:** per-backup JSON with pg version, byte size, per-table row
  counts — the restore battery compares against it.

## 10. Troubleshooting

| Symptom | Cause → fix |
|---|---|
| Loader: `target is not empty` | Baseline applied twice or a partial load committed (should be impossible — single transaction). Inspect, drop + recreate, re-run. |
| Loader: `source is missing N tables` | SQLite not at migration head. Apply pending migrations to SQLite FIRST (offline SQL path in `docs/DATABASE_MIGRATION.md`), re-snapshot, re-run. |
| Battery: orphan rows | Source SQLite had FK violations (possible if `PRAGMA foreign_keys` was off during an old write). Quarantine: list orphans, fix in SQLite, re-snapshot, re-load. NEVER `--allow-nonempty` over them. |
| Battery: D-rule failure | Provisioning incoherence in source (e.g. ACTIVATED without User — possible only via out-of-band writes, since the app writes them transactionally). Investigate as a data-integrity incident; do not hand-edit in PostgreSQL without recording it. |
| App: `too many connections` | Size Prisma `connection_limit` ≤ (Postgres `max_connections` − superuser_reserved − headroom) / instances. Single standalone instance: default is fine. |
| App: prepared-statement errors | Only behind PgBouncer in transaction mode → add `pgbouncer=true` to `DATABASE_URL`. Never set it without a pooler. |
| `prisma migrate` wants to recreate indexes | Cosmetic name drift between `postgres-baseline.sql` names and Prisma's generated names. Let the FIRST post-cutover migration reconcile them (review the diff — it must contain ONLY index renames). |
| `migrate deploy` fails with `type "datetime" does not exist` (42704) / P3018 | A SQLite-flavoured migration was deployed against PostgreSQL — the schema's migrations directory is shared with SQLite. Fixed by the Phase 26D provider split; if it recurs, a `.prisma` file for PostgreSQL is living directly in `prisma/` (the layout test `tests/migration-providers.test.js` guards this). See §5. |
| `migrate deploy`/`status` reports P3009 (failed migration) | A previous deploy failed and left a FAILED `_prisma_migrations` row. Diagnose read-only with `node scripts/db/check-pg-migration-state.mjs --target "$URL"`, then follow the §11 recovery sequence (resolve --rolled-back → resolve --applied 0_init → deploy). Never delete ledger rows by hand. |

## 11. Phase 26D failed-deploy recovery on Neon (2026-09-15 incident)

**What happened.** After Phase 26D merged, `bunx prisma migrate deploy
--schema prisma/schema.postgresql.prisma` was run against production Neon.
The (then-shared) migrations directory contained the SQLite-flavoured Phase
26D migration; it failed on its FIRST DDL statement with
`ERROR: type "datetime" does not exist` (SQLSTATE 42704, Prisma P3018 on the
deploy attempt; every later deploy/status reports P3009 “found failed
migrations”). `migrate status` shows
`Following migration have failed: 20260915180000_phase26d_quiz_attempt_architecture`.
No recovery command has been run since. The failure was on the first
statement and PostgreSQL DDL is transactional, so NOTHING from the migration
was created — but this MUST be verified, not assumed.

**What the fix changed.** The PostgreSQL schema now lives at
`prisma/postgres/schema.prisma` and owns `prisma/postgres/migrations/`
containing `0_init` (the frozen pre-26D production schema — exactly what Neon
has, modulo verification) and the PostgreSQL-native Phase 26D migration with
the same name and the same logical change (`TIMESTAMPTZ(3)` instead of
`DATETIME`, canonical constraint names). See §5.

> **RECOVERY HOLD — Group.trackScope drift investigation:** the original checker
> compares column types and object names, not full definitions, defaults or
> nullability, and does not enforce the exact ledger cardinalities listed below.
> Its exit 0 is NOT sufficient authorization to baseline or recover. Production
> has reported `Group.trackScope TEXT` where `0_init` claims `TrackScope`.
> Do not execute §11.2 until the investigation in
> `docs/GROUP_TRACK_SCOPE_RECOVERY_INVESTIGATION.md` is reviewed, the full
> read-only catalog comparison passes, and real PostgreSQL 17 recovery is proven.

### 11.1 Read-only verification (run FIRST — changes nothing)

```bash
node scripts/db/check-pg-migration-state.mjs --target "$PROD_DATABASE_URL"
```

The script issues SELECTs only (it succeeds even under a SELECT-only role —
proven in CI) and prints: every Phase 26D object it can find (all must be
ABSENT), the full `_prisma_migrations` ledger with states and checksums, and a
complete inventory diff of the live schema against `0_init`. It exits 0 ONLY
if the database is in the expected pre-recovery state:

- no `QuizRetryGrant` table;
- no `Quiz` blueprint columns (quizMode, questionCount, maxAttempts,
  shuffleOptions, difficultyPlan);
- no `QuizAttempt` attemptNumber / status / retryGrantId, no
  `QuizAttempt_quizId_studentId_attemptNumber_key`, no
  `QuizAttempt_retryGrantId_fkey`;
- no `QuizAnswer` snapshot columns (orderIndex … schoolTypeSnapshot);
- the schema otherwise matches `0_init` exactly;
- exactly one FAILED ledger row for
  `20260915180000_phase26d_quiz_attempt_architecture`
  (finished_at NULL, rolled_back_at NULL, applied_steps_count 0), 11 applied
  cutover-era rows, and no `0_init` row yet.

If it exits 1: STOP. Do not run anything below; investigate the printed diff
first. (If it reports the 26D row as already ROLLED-BACK, skip step 11.2.2.)

Equivalent manual psql checks (if you prefer to see the raw state):

```sql
SELECT to_regclass('public."QuizRetryGrant"') AS quizretrygrant;  -- expect NULL
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='Quiz'
   AND column_name IN ('quizMode','questionCount','maxAttempts','shuffleOptions','difficultyPlan');  -- expect 0 rows
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='QuizAttempt'
   AND column_name IN ('attemptNumber','status','retryGrantId');  -- expect 0 rows
SELECT column_name FROM information_schema.columns
 WHERE table_schema='public' AND table_name='QuizAnswer'
   AND column_name IN ('orderIndex','questionType','promptSnapshot','promptArSnapshot','optionsSnapshot',
                       'answerSnapshot','explanationSnapshot','difficultySnapshot','marksSnapshot','schoolTypeSnapshot');  -- expect 0 rows
SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace
  AND conname IN ('QuizAttempt_quizId_studentId_attemptNumber_key','QuizAttempt_retryGrantId_fkey');  -- expect 0 rows
SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
  FROM _prisma_migrations ORDER BY started_at;  -- one FAILED 26D row, 11 applied rows
```

### 11.2 Recovery (only after 11.1 exits 0 and you have approval)

Take a fresh backup first (`scripts/db/backup-postgres.sh`). Then, from the
repository root (engines available; all commands are additive — no DROP,
TRUNCATE or DELETE anywhere):

```bash
export DATABASE_URL="$PROD_DATABASE_URL"   # secret manager; never in the shell history you commit

# 1. Clear the failed record so deploy is willing to run again.
#    (Marks the row rolled_back_at; the row stays as an audit trail.)
bunx prisma migrate resolve --rolled-back 20260915180000_phase26d_quiz_attempt_architecture \
  --schema prisma/postgres/schema.prisma

# 2. Record that the pre-26D schema is already there (0_init == what 11.1 verified).
bunx prisma migrate resolve --applied 0_init \
  --schema prisma/postgres/schema.prisma

# 3. Apply the PostgreSQL-native Phase 26D migration (additive only).
bunx prisma migrate deploy --schema prisma/postgres/schema.prisma

# 4. Confirm.
bunx prisma migrate status --schema prisma/postgres/schema.prisma
# expect: "Database schema is up to date!"
```

Step 3 applies exactly: `CREATE TABLE QuizRetryGrant` (+ 3 indexes), 5 `Quiz`
columns, 3 `QuizAttempt` columns + named FK + unique constraint, 10
`QuizAnswer` columns, and the two documented backfills (attempt renumbering,
status projection). It contains no destructive statement.

### 11.3 Post-recovery checks

- `bunx prisma migrate status --schema prisma/postgres/schema.prisma` →
  “Database schema is up to date!” and a second
  `migrate deploy` → “No pending migrations”.
- `node scripts/db/verify-postgres.mjs --target "$URL"` still passes.
- App smoke test as each role; then one teacher→student quiz round-trip
  (blueprint select → attempt start → submit → frozen snapshot visible).
- The ledger now contains: 11 cutover-era rows (inert), one rolled-back 26D
  row (audit trail), one applied `0_init` row, one applied 26D row. That
  shape is expected and is asserted by the CI gate.

### 11.4 Restore-from-backup variant

A backup taken BEFORE the failed deploy has the same pre-26D schema and the
11 applied rows but NO failed 26D row: skip step 11.2.1 and run steps
11.2.2–11.2.4 unchanged. A backup taken AFTER the failed deploy is exactly
the §11.1 state. Both variants are exercised in
`tests/migration-providers.test.js`.
