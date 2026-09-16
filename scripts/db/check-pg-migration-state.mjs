#!/usr/bin/env node
// CodeMind Academy — READ-ONLY PostgreSQL migration-state checker.
// Phase 26D hotfix (2026-09-15): run this against the production database
// BEFORE any recovery command. It changes nothing — every statement is a
// SELECT against pg_catalog/information_schema or a table read.
//
//   node scripts/db/check-pg-migration-state.mjs --target "<postgresql-url>"
//     (or set DATABASE_URL)
//
// WHAT IT REPORTS
//   1. Whether ANY Phase 26D object exists (they must ALL be absent on a
//      database whose 26D deploy failed — the migration died on its first
//      DDL statement, and PostgreSQL DDL is transactional).
//   2. The _prisma_migrations ledger: every row with its state
//      (applied / failed / rolled-back), names and checksums — specifically
//      the failed `20260915180000_phase26d_quiz_attempt_architecture` row.
//   3. A full inventory diff of the live schema against
//      prisma/postgres/migrations/0_init — the exact pre-26D state that
//      `prisma migrate resolve --applied 0_init` claims. If ANY difference
//      is reported, DO NOT run the recovery: the database is not in the
//      state this runbook assumes.
//
// EXIT CODES
//   0 = database is in the expected PRE-RECOVERY state (26D absent, schema
//       == 0_init, failed 26D ledger row present) — additional catalog verification and review still required.
//   1 = it is not (see the printed diff); STOP and investigate.
//   2 = could not run (connection/env problem).
//
// SAFETY
//   * The script contains no INSERT/UPDATE/DELETE/DDL. It runs happily under
//     a read-only role or a replica. Prefer a read-only role for running it.
//   * It never prints the connection URL or any credential.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// `pg` is imported lazily so that a bare environment (no node_modules) still
// gets the documented exit 2 + a friendly message instead of a module-load
// crash. "Could not run" must be exit 2 no matter WHY it could not run.
let pg = null;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const INIT_SQL = path.join(REPO, "prisma", "postgres", "migrations", "0_init", "migration.sql");
const MIG_26D = "20260915180000_phase26d_quiz_attempt_architecture";

function targetUrl() {
  const args = process.argv.slice(2);
  let url = process.env.DATABASE_URL || "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && args[i + 1]) url = args[i + 1];
  }
  return url.trim();
}

// ---------------------------------------------------------------------------
// Expected inventories
// ---------------------------------------------------------------------------

// The Phase 26D object contract (the objects the failed migration would have
// created). Every one of them must be ABSENT before recovery.
const OBJECTS_26D = {
  table: ["QuizRetryGrant"],
  "Quiz columns": ["quizMode", "questionCount", "maxAttempts", "shuffleOptions", "difficultyPlan"],
  "QuizAttempt columns": ["attemptNumber", "status", "retryGrantId"],
  "QuizAnswer columns": [
    "orderIndex", "questionType", "promptSnapshot", "promptArSnapshot",
    "optionsSnapshot", "answerSnapshot", "explanationSnapshot",
    "difficultySnapshot", "marksSnapshot", "schoolTypeSnapshot",
  ],
  constraints: ["QuizAttempt_quizId_studentId_attemptNumber_key", "QuizAttempt_retryGrantId_fkey"],
};

// Parse 0_init's expected schema inventory (the emitter's DDL is regular).
function parseInitInventory() {
  const sql = fs.readFileSync(INIT_SQL, "utf8");
  const inv = { enums: new Map(), tables: new Map(), indexes: new Set(), constraints: new Set() };
  for (const m of sql.matchAll(/CREATE TYPE "([A-Za-z0-9_]+)" AS ENUM \(([^)]*)\);/g)) {
    inv.enums.set(m[1], m[2].split(",").map((s) => s.trim().replace(/^'|'$/g, "")));
  }
  for (const m of sql.matchAll(/CREATE TABLE "([A-Za-z0-9_]+)" \(([\s\S]*?)\n\);/g)) {
    const cols = new Map();
    const body = m[2];
    for (const line of body.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("--")) continue;
      const col = /^"([A-Za-z0-9_]+)"\s+(TEXT|INTEGER|DOUBLE PRECISION|BOOLEAN|TIMESTAMPTZ(?:\(\d+\))?|"[A-Za-z0-9_]+")/.exec(t);
      if (col) cols.set(col[1], col[2]);
    }
    inv.tables.set(m[1], cols);
    for (const c of body.matchAll(/CONSTRAINT "([A-Za-z0-9_]+)"/g)) inv.constraints.add(c[1]);
  }
  for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX "([A-Za-z0-9_]+)"/g)) inv.indexes.add(m[1]);
  return inv;
}

// ---------------------------------------------------------------------------
// Read-only queries
// ---------------------------------------------------------------------------

const Q = {
  objects26d: `
    SELECT
      (SELECT to_regclass('public."QuizRetryGrant"') IS NOT NULL) AS quizretrygrant_table,
      (SELECT COALESCE(array_to_json(array_agg(column_name)), '[]') FROM information_schema.columns
        WHERE table_schema='public' AND table_name='Quiz'
          AND column_name = ANY(ARRAY['quizMode','questionCount','maxAttempts','shuffleOptions','difficultyPlan'])) AS quiz_cols,
      (SELECT COALESCE(array_to_json(array_agg(column_name)), '[]') FROM information_schema.columns
        WHERE table_schema='public' AND table_name='QuizAttempt'
          AND column_name = ANY(ARRAY['attemptNumber','status','retryGrantId'])) AS quizattempt_cols,
      (SELECT COALESCE(array_to_json(array_agg(column_name)), '[]') FROM information_schema.columns
        WHERE table_schema='public' AND table_name='QuizAnswer'
          AND column_name = ANY(ARRAY['orderIndex','questionType','promptSnapshot','promptArSnapshot','optionsSnapshot','answerSnapshot','explanationSnapshot','difficultySnapshot','marksSnapshot','schoolTypeSnapshot'])) AS quizanswer_cols,
      (SELECT COALESCE(array_to_json(array_agg(conname)), '[]') FROM pg_constraint
        WHERE connamespace='public'::regnamespace
          AND conname = ANY(ARRAY['QuizAttempt_quizId_studentId_attemptNumber_key','QuizAttempt_retryGrantId_fkey'])) AS constraints26d`,
  ledger: `
    SELECT migration_name,
           finished_at IS NOT NULL AS applied,
           rolled_back_at IS NOT NULL AS rolled_back,
           applied_steps_count,
           checksum,
           started_at
    FROM _prisma_migrations
    ORDER BY started_at`,
  liveEnums: `
    SELECT t.typname AS name, e.enumlabel AS label, e.enumsortorder AS ord
    FROM pg_type t
    JOIN pg_enum e ON e.enumtypid = t.oid
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname='public'
    ORDER BY t.typname, e.enumsortorder`,
  liveColumns: `
    SELECT table_name, column_name, data_type, udt_name,
           COALESCE(datetime_precision::text,'') AS prec
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name <> '_prisma_migrations'
    ORDER BY table_name, ordinal_position`,
  liveConstraints: `
    SELECT conname FROM pg_constraint WHERE connamespace='public'::regnamespace`,
  liveIndexes: `
    SELECT i.relname AS name FROM pg_index ix
    JOIN pg_class i ON i.oid = ix.indexrelid
    JOIN pg_class t ON t.oid = ix.indrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname='public' AND t.relname <> '_prisma_migrations'`,
};

const TYPE_MAP = {
  "TEXT": "text", "INTEGER": "integer", "DOUBLE PRECISION": "double precision",
  "BOOLEAN": "boolean",
};

function initColType(t) {
  if (t.startsWith("TIMESTAMPTZ")) return `timestamp with time zone${t.includes("(3)") ? "(3)" : ""}`.replace(" (3)", "(3)");
  if (t.startsWith('"')) return t.replace(/"/g, ""); // enum type
  return TYPE_MAP[t] || t;
}

async function main() {
  console.warn('RECOVERY HOLD: this legacy inventory does not compare nullability, defaults, or constraint/index definitions. Exit 0 is NOT recovery authorization. Run inspect-pg-baseline.mjs and review GROUP_TRACK_SCOPE_RECOVERY_INVESTIGATION.md.');
  const url = targetUrl();
  if (!url || !/^postgres(ql)?:\/\//i.test(url)) {
    console.error("check-pg-migration-state: --target <postgresql-url> (or DATABASE_URL) is required");
    process.exit(2);
  }
  try {
    ({ default: pg } = await import("pg"));
  } catch {
    console.error("check-pg-migration-state: the 'pg' package is not installed in this environment (run npm ci).");
    process.exit(2);
  }
  const client = new pg.Client({ connectionString: url });
  try {
    await client.connect();
  } catch (e) {
    console.error("check-pg-migration-state: cannot connect:", e.message);
    process.exit(2);
  }

  const problems = [];
  const notes = [];

  // --- 1. Phase 26D objects must be absent ---------------------------------
  const o = (await client.query(Q.objects26d)).rows[0];
  const arr = (v) => (Array.isArray(v) ? v : typeof v === "string" ? JSON.parse(v) : []);
  const present = [
    ...(o.quizretrygrant_table ? ["TABLE QuizRetryGrant"] : []),
    ...arr(o.quiz_cols).map((c) => `Quiz.${c}`),
    ...arr(o.quizattempt_cols).map((c) => `QuizAttempt.${c}`),
    ...arr(o.quizanswer_cols).map((c) => `QuizAnswer.${c}`),
    ...arr(o.constraints26d).map((c) => `CONSTRAINT ${c}`),
  ];
  if (present.length) {
    problems.push(`Phase 26D objects PRESENT (unexpected): ${present.join(", ")}`);
  } else {
    notes.push("Phase 26D objects: ALL ABSENT (expected — the failed migration created nothing)");
  }

  // --- 2. ledger ------------------------------------------------------------
  let ledger;
  try {
    ledger = (await client.query(Q.ledger)).rows;
  } catch (e) {
    problems.push(`_prisma_migrations unreadable: ${e.message}`);
    ledger = [];
  }
  const failed = ledger.filter((r) => !r.applied && !r.rolled_back);
  const rolledBack = ledger.filter((r) => r.rolled_back);
  const applied = ledger.filter((r) => r.applied);
  console.log("\n== _prisma_migrations ledger ==");
  for (const r of ledger) {
    const state = r.applied ? "APPLIED   " : r.rolled_back ? "ROLLED-BACK" : "FAILED    ";
    console.log(`  ${state}  ${r.migration_name}  (checksum ${r.checksum.slice(0, 12)}…, steps ${r.applied_steps_count})`);
  }
  const failed26d = failed.find((r) => r.migration_name === MIG_26D);
  if (failed26d) {
    notes.push(`failed ${MIG_26D} row present (expected after the failed deploy)`);
  } else if (rolledBack.some((r) => r.migration_name === MIG_26D)) {
    notes.push(`${MIG_26D} already marked ROLLED-BACK (recovery step 2 may be skipped)`);
  } else {
    problems.push(`no failed or rolled-back row for ${MIG_26D} — this tool cannot see the expected incident state`);
  }
  const unknownApplied = applied.filter((r) => r.migration_name === "0_init" || !/^\d{8}/.test(r.migration_name));
  if (unknownApplied.length) notes.push(`non-timestamped applied rows: ${unknownApplied.map((r) => r.migration_name).join(", ")}`);
  if (applied.some((r) => r.migration_name === MIG_26D)) {
    problems.push(`${MIG_26D} is marked APPLIED — the 26D objects should then exist; re-run and investigate before ANY command`);
  }

  // --- 3. schema inventory vs 0_init ---------------------------------------
  const inv = parseInitInventory();
  const liveEnums = await client.query(Q.liveEnums);
  const liveCols = await client.query(Q.liveColumns);
  const liveCons = await client.query(Q.liveConstraints);
  const liveIdx = await client.query(Q.liveIndexes);
  const liveEnumMap = new Map();
  for (const r of liveEnums.rows) {
    if (!liveEnumMap.has(r.name)) liveEnumMap.set(r.name, []);
    liveEnumMap.get(r.name).push(r.label);
  }
  const liveColMap = new Map();
  for (const r of liveCols.rows) {
    if (!liveColMap.has(r.table_name)) liveColMap.set(r.table_name, new Map());
    // Enum columns report data_type USER-DEFINED; udt_name carries the enum name.
    const type = r.data_type === "USER-DEFINED" ? r.udt_name : r.data_type;
    liveColMap.get(r.table_name).set(r.column_name, `${type}${r.prec && r.data_type.includes("time") ? `(${r.prec})` : ""}`);
  }
  const liveConsSet = new Set(liveCons.rows.map((r) => r.conname));
  const liveIdxSet = new Set(liveIdx.rows.map((r) => r.name));

  const diffs = [];
  for (const [name, labels] of inv.enums) {
    const live = liveEnumMap.get(name);
    if (!live) diffs.push(`missing enum ${name}`);
    else if (live.join(",") !== labels.join(",")) diffs.push(`enum ${name} labels differ: live=(${live.join(",")}) expected=(${labels.join(",")})`);
  }
  for (const [name, labels] of liveEnumMap) if (!inv.enums.has(name)) diffs.push(`extra enum ${name}`);
  for (const [t, cols] of inv.tables) {
    const live = liveColMap.get(t);
    if (!live) { diffs.push(`missing table ${t}`); continue; }
    for (const [c, type] of cols) {
      if (!live.has(c)) diffs.push(`missing column ${t}.${c}`);
      else {
        const lt = live.get(c);
        const want = initColType(type);
        if (lt !== want) diffs.push(`column ${t}.${c} type differs: live=${lt} expected=${want}`);
      }
    }
    for (const c of live.keys()) if (!cols.has(c)) diffs.push(`extra column ${t}.${c}`);
  }
  for (const t of liveColMap.keys()) if (!inv.tables.has(t)) diffs.push(`extra table ${t}`);
  for (const c of inv.constraints) if (!liveConsSet.has(c)) diffs.push(`missing constraint ${c}`);
  for (const c of inv.indexes) if (!liveIdxSet.has(c)) diffs.push(`missing index ${c}`);

  console.log("\n== Schema vs prisma/postgres/migrations/0_init ==");
  if (diffs.length) {
    for (const d of diffs) { console.log(`  DIFF ${d}`); problems.push(`0_init mismatch: ${d}`); }
  } else {
    console.log(`  legacy type/name match (${inv.tables.size} tables, ${[...inv.tables.values()].reduce((a, m) => a + m.size, 0)} columns, ${inv.enums.size} enums, ${inv.constraints.size} constraints, ${inv.indexes.size} indexes)`);
    notes.push("legacy type/name inventory matches only; full catalog verification remains mandatory");
  }

  console.log("\n== Verdict ==");
  for (const n of notes) console.log(`  note: ${n}`);
  if (problems.length) {
    for (const p of problems) console.log(`  PROBLEM: ${p}`);
    console.log("\ncheck-pg-migration-state: NOT in the expected pre-recovery state — DO NOT run the recovery commands. Investigate first.");
    process.exit(1);
  }
  console.log("\ncheck-pg-migration-state: database is in the expected PRE-RECOVERY state.");
  await client.end();
  process.exit(0);
}

main().catch((e) => { console.error("check-pg-migration-state:", e.message); process.exit(2); });
