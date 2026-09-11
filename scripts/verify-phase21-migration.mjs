// CodeMind Academy — Phase 21 rehearsal: SQLite source clone -> PostgreSQL clone.
//
//   node scripts/verify-phase21-migration.mjs
//
// WHAT IT DOES (all scratch/disposable — never the real database)
//   1. Builds a scratch SQLite source at the CURRENT migration head + the
//      production-shaped fixture row set (scripts/db/fixtures-phase21.mjs).
//   2. Creates a disposable PostgreSQL database (PGlite — the real PostgreSQL
//      engine, same SQL dialect and constraint enforcement as server PG) and
//      applies the committed baseline (scripts/db/postgres-baseline.sql).
//   3. Copies every table in migration order with the SAME pg-lib primitives
//      the operator CLI uses (parameterized INSERTs, IDs preserved verbatim).
//   4. Proves: row counts match per table; canonical row hashes match per
//      table (IDs, relationships, timestamps, opaque blobs byte-identical);
//      all verify-postgres checks pass with exact fixture expectations.
//
// EXIT: 0 + PHASE21_MIGRATION_OK, else 1.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import {
  parseSchema,
  scalarFields,
  migrationOrder,
  canonicalTableHash,
  copyTableToPg,
  splitSqlStatements,
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

async function main() {
  const parsed = parseSchema();
  const order = migrationOrder(parsed);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p21-mig-"));
  console.log(`scratch: ${tmp}`);

  // ---- 1. SQLite source clone ----
  console.log("\n[1/4] building SQLite source clone (migration head + fixtures) …");
  const { file: srcFile, counts: srcCounts } = buildFixtureSqlite(path.join(tmp, "source.db"));
  const srcTotal = Object.values(srcCounts).reduce((a, b) => a + b, 0);
  ok(srcTotal > 0 && Object.keys(srcCounts).length === 55, `source has 55 tables / ${srcTotal} rows`);
  const srcEmpty = Object.entries(srcCounts).filter(([, n]) => n === 0).map(([t]) => t);
  ok(srcEmpty.length === 0, "every source table has ≥1 row", srcEmpty.join(","));

  // ---- 2. disposable PostgreSQL + baseline ----
  console.log("\n[2/4] creating disposable PostgreSQL + applying committed baseline …");
  const pgdir = path.join(tmp, "pg-target");
  const pg = new PGlite(pgdir);
  const backend = pgliteBackend(pg);
  const q = backend.query;
  const ddl = fs.readFileSync(BASELINE_SQL_PATH, "utf8");
  for (const s of splitSqlStatements(ddl)) await q(s);
  const v = (await q("SELECT version() AS v")).rows[0].v;
  console.log(`engine: ${String(v).slice(0, 52)}`);
  ok(/PostgreSQL/.test(v), "target is a real PostgreSQL engine");

  // ---- 3. copy (same primitives as the operator CLI) ----
  console.log("\n[3/4] copying 55 tables in migration order …");
  const src = new DatabaseSync(srcFile, { open: true, readOnly: true });
  const srcHashes = {};
  try {
    await q("BEGIN");
    try {
      for (const t of order) {
        const model = parsed.models.get(t);
        const cols = scalarFields(model);
        const pk = cols.find((c) => c.isId).name;
        const rows = src.prepare(`SELECT * FROM "${t}" ORDER BY "${pk}"`).all();
        srcHashes[t] = canonicalTableHash(rows, cols, [pk]);
        const n = await copyTableToPg(q, model, rows);
        if (n !== rows.length) throw new Error(`short copy on ${t}`);
      }
      await q("COMMIT");
    } catch (e) {
      await q("ROLLBACK");
      throw e;
    }

    // ---- 4. prove identity + integrity ----
    console.log("\n[4/4] verifying counts, hashes, constraints, lifecycle …");
    let countBad = 0;
    let hashBad = 0;
    for (const t of order) {
      const model = parsed.models.get(t);
      const cols = scalarFields(model);
      const pk = cols.find((c) => c.isId).name;
      const n = (await q(`SELECT COUNT(*)::int AS n FROM "${t}"`)).rows[0].n;
      if (n !== srcCounts[t]) {
        countBad++;
        console.error(`COUNT MISMATCH ${t}: sqlite=${srcCounts[t]} pg=${n}`);
        continue;
      }
      if (n === 0) continue;
      const colList = cols.map((c) => `"${c.name}"`).join(", ");
      const rows = (await q(`SELECT ${colList} FROM "${t}" ORDER BY "${pk}"`)).rows;
      const got = canonicalTableHash(rows, cols, [pk]);
      if (got !== srcHashes[t]) {
        hashBad++;
        console.error(`HASH MISMATCH ${t}: sqlite=${srcHashes[t]} pg=${got}`);
      }
    }
    ok(countBad === 0, `row counts preserved on all 55 tables (${srcTotal} rows)`);
    ok(hashBad === 0, "canonical row hashes identical (IDs/relations/timestamps/blobs)");

    // Spot-proof the tolerant encodings survived as the right INSTANTS.
    const naive = (await q(`SELECT "createdAt" AS c FROM "AuditLog" WHERE "id" = 'p21-al1'`)).rows[0].c;
    const msrow = (await q(`SELECT "createdAt" AS c FROM "SecurityEvent" WHERE "id" = 'p21-se5'`)).rows[0].c;
    ok(new Date(naive).toISOString() === "2026-09-01T09:00:00.000Z", "naive SQLite datetime migrated as UTC instant");
    ok(new Date(msrow).toISOString() === new Date(Date.parse("2026-08-15T12:30:00.000Z")).toISOString(), "ms-epoch SQLite datetime migrated as UTC instant");

    // Full constraint + lifecycle + regression battery.
    const results = await runChecks(q, parsed, { expectFixtures: true });
    for (const r of results) ok(r.ok, `${r.id} ${r.label}`, r.detail);
  } finally {
    src.close();
    await backend.close();
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`migration rehearsal: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
  console.log("PHASE21_MIGRATION_OK");
}

main().catch((e) => {
  console.error(`fatal: ${e?.message || e}`);
  process.exit(1);
});
