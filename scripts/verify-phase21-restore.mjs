// CodeMind Academy — Phase 21 restore drill: backup -> disposable PostgreSQL.
//
//   node scripts/verify-phase21-restore.mjs
//
// WHAT IT DOES (all scratch/disposable — never the real database)
//   1. Builds the fixture SQLite source and loads a disposable PostgreSQL (A)
//      exactly like the migration rehearsal (baseline + ordered copy).
//   2. Takes a logical backup of A (pg-lib dump: deterministic INSERTs +
//      manifest with per-table counts + canonical sha256 + whole-file sha256).
//   3. Restores the backup into a SECOND disposable PostgreSQL (B) that has
//      only the empty baseline — proving the backup is SELF-SUFFICIENT.
//   4. Proves on B: counts + canonical hashes equal A; the full
//      verify-postgres battery passes; teacher + security data coherent.
//   5. Proves integrity verification is NON-VACUOUS: a tampered copy of the
//      backup fails the sha256 check (a backup that "verifies" no matter what
//      proves nothing).
//
// NOTE: production backups use pg_dump (custom format) via
// scripts/db/backup-postgres.sh; this drill proves the RESTORE PROCEDURE
// (empty baseline + logical load + verification battery), which is identical
// for both artifact formats. The runbook requires the same battery after a
// pg_restore.
//
// EXIT: 0 + PHASE21_RESTORE_OK, else 1.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import {
  parseSchema,
  scalarFields,
  migrationOrder,
  canonicalTableHash,
  copyTableToPg,
  splitSqlStatements,
  dumpPostgresToSql,
  parseDumpManifest,
  restoreSqlDump,
  pgliteBackend,
  BASELINE_SQL_PATH,
} from "./db/pg-lib.mjs";
import { buildFixtureSqlite } from "./db/fixtures-phase21.mjs";
import { runChecks } from "./db/verify-postgres.mjs";

let pass = 0;
let fail = 0;
const ok = (cond, label, detail = "") => {
  if (cond) { pass++; console.log(`PASS ${label}`); }
  else { fail++; console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`); }
};

async function freshBaseline(pgdir) {
  const pg = new PGlite(pgdir);
  const backend = pgliteBackend(pg);
  const ddl = fs.readFileSync(BASELINE_SQL_PATH, "utf8");
  for (const s of splitSqlStatements(ddl)) await backend.query(s);
  return backend;
}

async function main() {
  const parsed = parseSchema();
  const order = migrationOrder(parsed);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p21-restore-"));
  console.log(`scratch: ${tmp}`);

  // ---- 1. source of truth: PG-A loaded from fixtures ----
  console.log("\n[1/5] loading disposable PostgreSQL (A) from fixtures …");
  const { file: srcFile, counts: srcCounts } = buildFixtureSqlite(path.join(tmp, "source.db"));
  const backendA = await freshBaseline(path.join(tmp, "pg-a"));
  const src = new DatabaseSync(srcFile, { open: true, readOnly: true });
  try {
    await backendA.query("BEGIN");
    try {
      for (const t of order) {
        const model = parsed.models.get(t);
        const cols = scalarFields(model);
        const pk = cols.find((c) => c.isId).name;
        await copyTableToPg(backendA.query, model, src.prepare(`SELECT * FROM "${t}" ORDER BY "${pk}"`).all());
      }
      await backendA.query("COMMIT");
    } catch (e) {
      await backendA.query("ROLLBACK");
      throw e;
    }

    // ---- 2. backup A ----
    console.log("\n[2/5] taking logical backup of A …");
    const { sql, manifest } = await dumpPostgresToSql(backendA.query, parsed, order);
    const backupPath = path.join(tmp, "backup.sql");
    fs.writeFileSync(backupPath, sql);
    const fileBytes = fs.statSync(backupPath).size;
    ok(fileBytes > 0, `backup artifact written (${fileBytes} bytes)`);
    const manifestCountsOk = order.every((t) => manifest.tables[t]?.count === srcCounts[t]);
    ok(manifestCountsOk, "manifest counts match the source of truth");
    const totalManifest = Object.values(manifest.tables).reduce((a, b) => a + b.count, 0);
    const totalSrc = Object.values(srcCounts).reduce((a, b) => a + b, 0);
    ok(totalManifest === totalSrc, `manifest total ${totalManifest} rows`);
    // The manifest must cover security + provisioning tables explicitly.
    for (const t of ["TeacherApplication", "TeacherActivationToken", "SecurityEvent", "SecurityRateLimit", "UserSession", "PasswordResetToken", "AuditLog"]) {
      ok(manifest.tables[t] !== undefined && manifest.tables[t].count > 0, `backup covers ${t} (${manifest.tables[t]?.count || 0} rows)`);
    }
    const reparsed = parseDumpManifest(sql);
    ok(JSON.stringify({ ...reparsed, sha256: null }) === JSON.stringify({ ...manifest, sha256: null }), "manifest header round-trips");

    // ---- 3. restore into disposable PG-B (empty baseline only) ----
    console.log("\n[3/5] restoring into disposable PostgreSQL (B) …");
    const backendB = await freshBaseline(path.join(tmp, "pg-b"));
    try {
      const empty = (await backendB.query(`SELECT COUNT(*)::int AS n FROM "User"`)).rows[0].n;
      ok(empty === 0, "B starts empty (restore target is disposable)");
      const stmts = await restoreSqlDump(backendB.query, sql);
      ok(stmts > 0, `restore executed (${stmts} statements, one transaction)`);

      // ---- 4. prove B == A (counts, hashes, full battery) ----
      console.log("\n[4/5] verifying B against A …");
      let bad = 0;
      for (const t of order) {
        const model = parsed.models.get(t);
        const cols = scalarFields(model);
        const pk = cols.find((c) => c.isId).name;
        const colList = cols.map((c) => `"${c.name}"`).join(", ");
        const [ra, rb] = await Promise.all([
          backendA.query(`SELECT ${colList} FROM "${t}" ORDER BY "${pk}"`),
          backendB.query(`SELECT ${colList} FROM "${t}" ORDER BY "${pk}"`),
        ]);
        if (ra.rows.length !== rb.rows.length) {
          bad++;
          console.error(`COUNT MISMATCH ${t}: A=${ra.rows.length} B=${rb.rows.length}`);
          continue;
        }
        if (canonicalTableHash(ra.rows, cols, [pk]) !== canonicalTableHash(rb.rows, cols, [pk])) {
          bad++;
          console.error(`HASH MISMATCH ${t}`);
        }
      }
      ok(bad === 0, "B is identical to A (counts + canonical hashes, 55 tables)");

      // The application connects and core queries work on the RESTORED copy.
      const results = await runChecks(backendB.query, parsed, { expectFixtures: true });
      for (const r of results) ok(r.ok, `${r.id} ${r.label} [on restored B]`, r.detail);

      // Teacher + security data explicitly present and coherent on B.
      const apps = (await backendB.query(
        `SELECT "status" AS s, COUNT(*)::int AS n FROM "TeacherApplication" GROUP BY 1 ORDER BY 1`
      )).rows;
      const statuses = Object.fromEntries(apps.map((r) => [r.s, r.n]));
      ok(statuses.PENDING === 1 && statuses.REJECTED === 1 && statuses.APPROVED === 1 && statuses.ACTIVATED === 1,
        "all four application states survived the restore", JSON.stringify(statuses));
      const sev = (await backendB.query(`SELECT COUNT(*)::int AS n FROM "SecurityEvent"`)).rows[0].n;
      ok(sev === 5, `security/audit history survived (${sev} events)`);
    } finally {
      await backendB.close();
    }

    // ---- 5. integrity check is non-vacuous ----
    console.log("\n[5/5] proving tamper detection …");
    const tampered = sql.replace("pending@example.com", "pending2@example.com");
    ok(tampered !== sql, "tampered copy differs");
    const tamperedHash = crypto.createHash("sha256").update(tampered).digest("hex");
    ok(tamperedHash !== manifest.sha256, "sha256 detects the tamper (integrity check is real)");
    // And a tampered backup restores DIFFERENT data — the battery would catch
    // it via hash comparison against the manifest (prove the mechanism).
    const backendC = await freshBaseline(path.join(tmp, "pg-c"));
    try {
      await restoreSqlDump(backendC.query, tampered);
      const cols = scalarFields(parsed.models.get("TeacherApplication"));
      const colList = cols.map((c) => `"${c.name}"`).join(", ");
      const rows = (await backendC.query(`SELECT ${colList} FROM "TeacherApplication" ORDER BY "id"`)).rows;
      const got = canonicalTableHash(rows, cols, ["id"]);
      ok(got !== manifest.tables.TeacherApplication.sha256, "manifest table-hash catches tampered content");
    } finally {
      await backendC.close();
    }
  } finally {
    src.close();
    await backendA.close();
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`restore drill: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log("PHASE21_RESTORE_OK");
}

main().catch((e) => {
  console.error(`fatal: ${e?.message || e}`);
  process.exit(1);
});
