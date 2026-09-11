// CodeMind Academy — Phase 21: deterministic SQLite -> PostgreSQL cutover load.
//
//   DATABASE_URL=postgresql://… node scripts/db/migrate-sqlite-to-postgres.mjs \
//       --source db/custom.db --target "$DATABASE_URL" --manifest /var/backups/p21-load.json
//
// WHAT IT DOES
//   Copies EVERY table (migration order, parents before children) from a SQLite
//   file at migration head into an EMPTY PostgreSQL database that already has
//   the Phase 21 baseline (scripts/db/postgres-baseline.sql, or `prisma db push`
//   from prisma/schema.postgresql.prisma). IDs, relationships, timestamps and
//   opaque String blobs are preserved verbatim; the ONLY excluded table is the
//   engine ledger `_prisma_migrations` (see pg-lib MIGRATION_EXCLUDED_TABLES).
//
// FAIL-CLOSED RULES (the script aborts instead of guessing)
//   * Source must contain ALL 55 schema tables (else: migrate SQLite to head first).
//   * Target must contain ALL 55 schema tables (else: apply the baseline first).
//   * Target must be EMPTY (every table COUNT(*) = 0) unless --allow-nonempty.
//   * The whole load runs in ONE transaction: any error rolls everything back.
//   * Post-load verification re-reads every target table: counts AND canonical
//     row hashes must match the source (override: --skip-hash-verify, not
//     recommended — the runbook requires hashes).
//
// EXIT CODES: 0 = loaded + verified; 1 = usage error; 2 = preflight failure;
// 3 = load failure (rolled back); 4 = post-verify mismatch (rolled back).

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import pg from "pg";
import {
  parseSchema,
  scalarFields,
  migrationOrder,
  sqliteValueToPg,
  canonicalTableHash,
  copyTableToPg,
  redactDatabaseUrl,
  MIGRATION_EXCLUDED_TABLES,
} from "./pg-lib.mjs";

const { Pool } = pg;

function usage(exit = 1) {
  console.error(`usage: node scripts/db/migrate-sqlite-to-postgres.mjs --source <sqlite-file> --target <postgres-url> [options]

options:
  --manifest <path>     write the JSON load manifest (default: <source>.pg-load.json)
  --batch-size <n>      rows per INSERT (default 500)
  --allow-nonempty      load into a non-empty target (NOT recommended)
  --skip-hash-verify    skip canonical hash re-read (NOT recommended)
  --dry-run             preflight + plan only; copy nothing
  -h, --help            this text`);
  process.exit(exit);
}

function args() {
  const out = { batchSize: 500, allowNonempty: false, skipHash: false, dryRun: false };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--source") out.source = argv[++i];
    else if (a === "--target") out.target = argv[++i];
    else if (a === "--manifest") out.manifest = argv[++i];
    else if (a === "--batch-size") out.batchSize = Number(argv[++i]);
    else if (a === "--allow-nonempty") out.allowNonempty = true;
    else if (a === "--skip-hash-verify") out.skipHash = true;
    else if (a === "--dry-run") out.dryRun = true;
    else if (a === "-h" || a === "--help") usage(0);
    else { console.error(`unknown argument: ${a}`); usage(1); }
  }
  if (!out.source || !out.target) usage(1);
  if (!Number.isInteger(out.batchSize) || out.batchSize < 1 || out.batchSize > 5000) {
    console.error("--batch-size must be an integer 1..5000");
    process.exit(1);
  }
  return out;
}

async function main() {
  const o = args();
  const startedAt = new Date().toISOString();
  const parsed = parseSchema();
  const order = migrationOrder(parsed);
  console.log(`Phase 21 cutover load: ${order.length} tables, batch=${o.batchSize}${o.dryRun ? " (DRY RUN)" : ""}`);

  // ---- preflight: source ----
  if (!fs.existsSync(o.source)) {
    console.error(`source not found: ${o.source}`);
    process.exit(2);
  }
  const srcStat = fs.statSync(o.source);
  const src = new DatabaseSync(o.source, { open: true, readOnly: true });
  try {
    const have = new Set(
      src.prepare(`SELECT name AS n FROM sqlite_master WHERE type='table'`).all().map((r) => r.n)
    );
    const missing = order.filter((t) => !have.has(t));
    if (missing.length) {
      console.error(`source is missing ${missing.length} table(s) — migrate SQLite to head first:`);
      for (const t of missing) console.error(`  - ${t}`);
      process.exit(2);
    }
    const sourceCounts = {};
    const sourceHashes = {};
    const pkOf = {};
    for (const t of order) {
      const model = parsed.models.get(t);
      const cols = scalarFields(model);
      const pk = cols.find((c) => c.isId).name;
      pkOf[t] = pk;
      const rows = src.prepare(`SELECT * FROM "${t}" ORDER BY "${pk}"`).all();
      sourceCounts[t] = rows.length;
      sourceHashes[t] = canonicalTableHash(rows, cols, [pk]);
    }
    const totalRows = Object.values(sourceCounts).reduce((a, b) => a + b, 0);
    console.log(`source: ${o.source} (${srcStat.size} bytes, ${totalRows} rows)`);

    // ---- preflight: target ----
    const pool = new Pool({ connectionString: o.target });
    const query = (text, params) => pool.query(text, params || []);
    try {
      const rt = await query(
        `SELECT tablename AS n FROM pg_tables WHERE schemaname = 'public'`
      );
      const targetHave = new Set(rt.rows.map((r) => r.n));
      const targetMissing = order.filter((t) => !targetHave.has(t));
      if (targetMissing.length) {
        console.error(`target is missing ${targetMissing.length} table(s) — apply the baseline first (docs/POSTGRES_CUTOVER_RUNBOOK.md):`);
        for (const t of targetMissing.slice(0, 10)) console.error(`  - ${t}`);
        if (targetMissing.length > 10) console.error(`  … and ${targetMissing.length - 10} more`);
        process.exit(2);
      }
      if (!o.allowNonempty) {
        const nonempty = [];
        for (const t of order) {
          const r = await query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
          if (r.rows[0].n > 0) nonempty.push(`${t} (${r.rows[0].n})`);
        }
        if (nonempty.length) {
          console.error(`target is not empty (${nonempty.length} table(s) have rows) — refusing to load:`);
          for (const t of nonempty.slice(0, 10)) console.error(`  - ${t}`);
          console.error(`Load into a fresh baseline database, or pass --allow-nonempty (not recommended).`);
          process.exit(2);
        }
        console.log("target: empty baseline confirmed");
      } else {
        console.log("WARNING: --allow-nonempty: loading into a non-empty target");
      }

      if (o.dryRun) {
        console.log("DRY RUN: preflight passed; load plan:");
        for (const t of order) console.log(`  ${t}: ${sourceCounts[t]} rows`);
        console.log(`DRY RUN OK: ${totalRows} rows would be copied`);
        return;
      }

      // ---- load (one transaction) ----
      console.log(`loading into ${redactDatabaseUrl(o.target)} …`);
      await query("BEGIN");
      try {
        for (const t of order) {
          const model = parsed.models.get(t);
          const cols = scalarFields(model);
          const byName = new Map(cols.map((f) => [f.name, f]));
          const colNames = cols.map((c) => c.name);
          const rows = src.prepare(`SELECT * FROM "${t}" ORDER BY "${pkOf[t]}"`).all();
          let done = 0;
          for (let i = 0; i < rows.length; i += o.batchSize) {
            const batch = rows.slice(i, i + o.batchSize);
            const params = [];
            const tuples = batch.map((r) => {
              const ph = colNames.map((c) => {
                params.push(sqliteValueToPg(byName.get(c), r[c] ?? null));
                return `$${params.length}`;
              });
              return `(${ph.join(", ")})`;
            });
            await query(
              `INSERT INTO "${t}" (${colNames.map((c) => `"${c}"`).join(", ")}) VALUES ${tuples.join(", ")}`,
              params
            );
            done += batch.length;
          }
          console.log(`  ${t}: ${done} rows`);
        }

        // ---- post-verify inside the same transaction (mismatch => rollback) ----
        let mismatches = 0;
        for (const t of order) {
          const model = parsed.models.get(t);
          const cols = scalarFields(model);
          const r = await query(`SELECT COUNT(*)::int AS n FROM "${t}"`);
          if (r.rows[0].n !== sourceCounts[t]) {
            console.error(`COUNT MISMATCH ${t}: source=${sourceCounts[t]} target=${r.rows[0].n}`);
            mismatches++;
          }
        }
        if (!o.skipHash) {
          for (const t of order) {
            if (sourceCounts[t] === 0) continue;
            const model = parsed.models.get(t);
            const cols = scalarFields(model);
            const r = await query(
              `SELECT ${cols.map((c) => `"${c.name}"`).join(", ")} FROM "${t}" ORDER BY "${pkOf[t]}"`
            );
            // pg returns Date for timestamptz, boolean for bool — canonicalValue
            // normalizes driver shapes, so this compares VALUES not encodings.
            const got = canonicalTableHash(
              r.rows.map((row) => {
                const rec = {};
                for (const c of cols) rec[c.name] = row[c.name] ?? null;
                return rec;
              }),
              cols,
              [pkOf[t]]
            );
            if (got !== sourceHashes[t]) {
              console.error(`HASH MISMATCH ${t}: source=${sourceHashes[t]} target=${got}`);
              mismatches++;
            }
          }
        } else {
          console.log("WARNING: --skip-hash-verify: row CONTENT was not re-verified");
        }
        if (mismatches) {
          console.error(`post-verify FAILED (${mismatches} table(s)) — rolling back`);
          await query("ROLLBACK");
          process.exit(4);
        }
        await query("COMMIT");
      } catch (e) {
        try { await query("ROLLBACK"); } catch { /* already failed */ }
        console.error(`load FAILED (rolled back): ${e.message}`);
        process.exit(3);
      }

      const finishedAt = new Date().toISOString();
      const manifest = {
        tool: "migrate-sqlite-to-postgres.mjs (Phase 21)",
        startedAt,
        finishedAt,
        source: { path: o.source, bytes: srcStat.size },
        target: redactDatabaseUrl(o.target),
        excludedTables: [...MIGRATION_EXCLUDED_TABLES],
        batchSize: o.batchSize,
        hashVerified: !o.skipHash,
        tables: Object.fromEntries(
          order.map((t) => [t, { rows: sourceCounts[t], sha256: sourceHashes[t] }])
        ),
        totalRows,
        ok: true,
      };
      const manifestPath = o.manifest || `${o.source}.pg-load.json`;
      fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      console.log(`LOAD OK: ${totalRows} rows, ${order.length} tables, manifest: ${manifestPath}`);
    } finally {
      await pool.end().catch(() => {});
    }
  } finally {
    src.close();
  }
}

main().catch((e) => {
  console.error(`fatal: ${e?.message || e}`);
  process.exit(3);
});
