// CodeMind Academy — Phase G: provider-parity proof for the FULL PG chain
// (the canonical parity verifier from Phase G onward).
//
//   node scripts/db/verify-phase-g-pg-parity.mjs
//
// EXIT: 0 + PHASE_G_PG_CATALOG_IDENTICAL_OK, else 1 with the differing objects.
//
// WHAT IT PROVES (catalog = source of truth, not the migration text)
//   The PostgreSQL database produced by
//       prisma/postgres/migrations/0_init
//     + 20260915180000_phase26d_quiz_attempt_architecture
//     + 20260919120000_phase_f_live_session_lifecycle
//     + 20260919180000_phase_g_quiz_homework_workflow
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
// PORTABILITY (Windows / Linux / CI / sandbox — identical behaviour)
//   * The scratch directory comes from `os.tmpdir()`, NOT from `TMPDIR`. On
//     Windows `TMPDIR` is normally unset (Windows uses `TEMP`/`TMP`) and the
//     old `process.env.TMPDIR || "/tmp"` fallback resolved to `\tmp` on the
//     current drive, which does not exist: `ENOENT … mkdtemp
//     '\tmp\cm-pg-parity-XXXXXX'`. `os.tmpdir()` is the platform-independent
//     API and reads `TMPDIR`/`TEMP`/`TMP` as appropriate.
//   * Every path is composed with `path.join` (never string-concatenated with
//     a `/`), so no Unix separator is assumed.
//   * No shell is invoked anywhere: this file has no `child_process` import,
//     no `grep`/`sed`/`bash` dependency and no shell-only syntax.
//   * The exit status is set with `process.exitCode` instead of
//     `process.exit()`: on Windows, `process.exit()` can truncate stdout that
//     is still being flushed into a pipe, which would swallow the verdict
//     line CI greps for. `process.exitCode` lets Node drain and exit on its
//     own.
//   * Scratch directories are removed afterwards, best-effort (a Windows
//     handle may still be held open; cleanup never affects the verdict).
//
// NOTE (pre-existing finding, fixed additively in Phase F)
//   `Attendance` has declared `@@index([sessionId])` since Phase 13, but the
//   frozen PostgreSQL baseline (0_init) never created it. Phase F adds it with
//   `CREATE INDEX IF NOT EXISTS` so the migration chain can reproduce the
//   schema; without it this script reports exactly one missing index and
//   nothing else.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { splitSqlStatements, BASELINE_SQL_PATH, REPO } from "./pg-lib.mjs";

const PG_MIG = path.join(REPO, "prisma", "postgres", "migrations");
const CHAIN = [
  "0_init",
  "20260915180000_phase26d_quiz_attempt_architecture",
  "20260919120000_phase_f_live_session_lifecycle",
  // Phase G — the parity proof is CUMULATIVE: the baseline is derived from the
  // current schema source, so every later migration must join this chain or the
  // comparison would report the newer columns as missing. scripts/db/verify-phase-g-pg-parity.mjs
  // is the canonical full-chain proof from Phase G onward.
  "20260919180000_phase_g_quiz_homework_workflow",
  "20260919190000_phase_g_camera_policy",
];
const read = (p) => fs.readFileSync(p, "utf8");
const stmts = (p) => splitSqlStatements(read(p));

/** Every scratch directory this run created (for best-effort cleanup). */
const scratchDirs = [];

/** A pristine PostgreSQL engine on a private directory under os.tmpdir(). */
async function fresh() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cm-pg-parity-"));
  scratchDirs.push(root);
  const pg = new PGlite(path.join(root, "pgdata"));
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
await A.close();

const B = await fresh();
for (const name of CHAIN) for (const s of stmts(path.join(PG_MIG, name, "migration.sql"))) await B.query(s);
const chain = await snap(B);
await B.close();

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
console.log(bad === 0 ? "PHASE_G_PG_CATALOG_IDENTICAL_OK" : `PHASE_G_PG_CATALOG_DIFF=${bad}`);
process.exitCode = bad === 0 ? 0 : 1;

// Best-effort scratch cleanup: never allowed to change the verdict (on Windows
// a directory handle can still be held briefly after close()).
for (const dir of scratchDirs) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* leave the scratch directory behind rather than fail the verification */
  }
}
