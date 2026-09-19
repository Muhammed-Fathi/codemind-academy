// CodeMind Academy — Phase F: provider-parity proof for the Phase F migration.
//
//   node scripts/db/verify-phase-f-pg-parity.mjs
//
// EXIT: 0 + PHASE_F_PG_CATALOG_IDENTICAL_OK, else 1 with the differing objects.
//
// WHAT IT PROVES (catalog = source of truth, not the migration text)
//   The PostgreSQL database produced by
//       prisma/postgres/migrations/0_init
//     + 20260915180000_phase26d_quiz_attempt_architecture
//     + 20260919120000_phase_f_live_session_lifecycle
//   is catalog-identical — every column (+ type, nullability, default), every
//   enum value in order, every index and every constraint — to the database
//   produced by the generated baseline `scripts/db/postgres-baseline.sql`,
//   which is derived from the ONE schema source (prisma/schema.prisma).
//
//   It runs on PGlite (a real PostgreSQL engine, WASM) so the proof is
//   available offline; the CI workflow runs the same comparison on a real
//   PostgreSQL service container through tests/migration-providers.test.js.
//
// WHY THIS EXISTS
//   The hand-authored PostgreSQL edition of a migration can silently diverge
//   from the derived baseline (a forgotten FK, a UNIQUE written as an index
//   instead of a constraint, an appended enum value landing in the wrong
//   order). This script closes that gap without a database server.
//
// NOTE (pre-existing finding, fixed additively in Phase F)
//   `Attendance` has declared `@@index([sessionId])` since Phase 13, but the
//   frozen PostgreSQL baseline (0_init) never created it. Phase F adds it with
//   `CREATE INDEX IF NOT EXISTS` so the migration chain can reproduce the
//   schema; without it this script reports exactly one missing index and
//   nothing else.

import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { splitSqlStatements, BASELINE_SQL_PATH, REPO } from "./pg-lib.mjs";

const PG_MIG = path.join(REPO, "prisma", "postgres", "migrations");
const CHAIN = [
  "0_init",
  "20260915180000_phase26d_quiz_attempt_architecture",
  "20260919120000_phase_f_live_session_lifecycle",
];
const read = (p) => fs.readFileSync(p, "utf8");
const stmts = (p) => splitSqlStatements(read(p));

async function fresh() {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "cm-pf-parity-"));
  const pg = new PGlite(dir);
  await pg.waitReady;
  return pg;
}

async function snap(pg) {
  const q = (text) => pg.query(text).then((r) => r.rows);
  const cols = (await q(`SELECT table_name||'.'||column_name||' :: '||coalesce(udt_name,'')||' null='||is_nullable||' def='||coalesce(column_default,'-') AS s
                         FROM information_schema.columns WHERE table_schema='public' ORDER BY 1`)).map((r) => r.s);
  const enums = (await q(`SELECT t.typname||'['||e.enumsortorder||']='||e.enumlabel AS s
                          FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid JOIN pg_namespace n ON n.oid=t.typnamespace
                          WHERE n.nspname='public' ORDER BY 1`)).map((r) => r.s);
  const idx = (await q(`SELECT indexname||' :: '||indexdef AS s FROM pg_indexes WHERE schemaname='public' ORDER BY 1`)).map((r) => r.s);
  const cons = (await q(`SELECT conname||' :: '||pg_get_constraintdef(c.oid) AS s FROM pg_constraint c
                         JOIN pg_class r ON r.oid=c.conrelid JOIN pg_namespace n ON n.oid=r.relnamespace
                         WHERE n.nspname='public' ORDER BY 1`)).map((r) => r.s);
  return { cols, enums, idx, cons };
}

const A = await fresh();
for (const s of stmts(BASELINE_SQL_PATH)) await A.query(s);
const baseline = await snap(A);

const B = await fresh();
for (const name of CHAIN) for (const s of stmts(path.join(PG_MIG, name, "migration.sql"))) await B.query(s);
const chain = await snap(B);

let bad = 0;
for (const key of ["cols", "enums", "idx", "cons"]) {
  const setA = new Set(baseline[key]);
  const setB = new Set(chain[key]);
  const missing = baseline[key].filter((x) => !setB.has(x));
  const extra = chain[key].filter((x) => !setA.has(x));
  console.log(`${key}: baseline=${baseline[key].length} chain=${chain[key].length} missing=${missing.length} extra=${extra.length}`);
  for (const m of missing.slice(0, 8)) console.log("  - missing:", m);
  for (const e of extra.slice(0, 8)) console.log("  + extra:  ", e);
  bad += missing.length + extra.length;
}
console.log(bad === 0 ? "PHASE_F_PG_CATALOG_IDENTICAL_OK" : `PHASE_F_PG_CATALOG_DIFF=${bad}`);
process.exit(bad === 0 ? 0 : 1);
