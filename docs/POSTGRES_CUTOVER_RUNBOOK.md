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
| Derived PG schema | `prisma/schema.postgresql.prisma` (regenerate: `node scripts/db/make-postgres-schema.mjs`; verify: `… --check`) |
| Baseline DDL | `scripts/db/postgres-baseline.sql` (same generator) |
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
   apply the baseline — pick ONE:
   - Engines available: `prisma db push --schema prisma/schema.postgresql.prisma`
     (or `migrate deploy` after `migrate resolve --applied`, §5), or
   - Engines unreachable / byte-reviewable path: `psql "$URL" -f scripts/db/postgres-baseline.sql`.
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

## 5. Migration-ledger baseline (engines available only)

PostgreSQL must never replay the 9 SQLite migrations. After the load validates:
`prisma migrate resolve --applied "<each of the 9 names>" --schema prisma/schema.postgresql.prisma`
(or mark the latest as applied per Prisma's baseline docs for your version).
Future schema changes then flow through normal `prisma migrate` on the
postgresql schema. If engines are unreachable, SKIP this step — the baseline
DDL + loader manifest ARE the ledger until engines are available (record that
decision in the cutover log).

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
