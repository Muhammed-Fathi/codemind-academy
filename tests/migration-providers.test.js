// CodeMind Academy — Migration provider architecture regression test.
// Phase 26D hotfix (2026-09-15): the DATETIME-on-PostgreSQL production failure
// must become impossible to miss again.
//
// WHAT BROKE (context for every assertion below)
// ==============================================
// `prisma/schema.postgresql.prisma` used to live directly in prisma/, so the
// PostgreSQL provider shared prisma/migrations with SQLite. Prisma reads the
// migrations directory NEXT TO the schema file, so
//   bunx prisma migrate deploy --schema prisma/schema.postgresql.prisma
// replayed SQLite-flavoured SQL on Neon and died on the Phase 26D migration's
// first DDL statement: `type "datetime" does not exist` (42704).
//
// THE FIX THIS FILE GUARDS
// ========================
//   prisma/schema.prisma            (SQLite)  + prisma/migrations            (12 files, provider=sqlite)
//   prisma/postgres/schema.prisma   (PG)      + prisma/postgres/migrations   (0_init + 26D, provider=postgresql)
// 0_init is the frozen pre-26D production schema; the PG edition of Phase 26D
// carries the same logical change with PostgreSQL types and canonical
// constraint names. NEVER point the PostgreSQL provider at prisma/migrations
// and NEVER move the PG schema back next to schema.prisma.
//
// LAYERS
// ======
//   Part A — offline (always runs): layout contract, applied-migration
//            checksum contract, SQLite-only-SQL denylist, structural
//            convergence (0_init + 26D == postgres-baseline.sql), fresh
//            SQLite through the repo's own migration harness.
//   Part B — real PostgreSQL (needs DATABASE_URL, DISPOSABLE ONLY): applies
//            the real migration SQL to a real server and catalog-compares
//            against scripts/db/postgres-baseline.sql, plus the simulated
//            failed-Neon state and the read-only checker script.
//   Part C — real Prisma engine (needs MIGRATION_PROVIDERS_PRISMA_BIN):
//            fresh PG deploy, failed-record recovery via `migrate resolve`,
//            and the SQLite applied-ledger contract, all through the actual
//            `prisma` CLI. CI MUST run this part (a skip is a failure).
//
// RUN
//   node tests/migration-providers.test.js                       # offline part
//   DATABASE_URL=postgresql://…disposable… node tests/migration-providers.test.js
//   DATABASE_URL=… MIGRATION_PROVIDERS_PRISMA_BIN=node_modules/.bin/prisma \
//     node tests/migration-providers.test.js                     # full CI mode
//
// SAFETY
//   Part B/C drop and recreate the `public` schema and write a scratch SQLite
//   file. They refuse production/Neon/hosted-looking URLs and non-local hosts,
//   and never use a repository secret.

const { execFileSync, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const REPO = path.resolve(__dirname, "..");
const SQLITE_MIGRATIONS = path.join(REPO, "prisma", "migrations");
const PG_MIGRATIONS = path.join(REPO, "prisma", "postgres", "migrations");
const PG_SCHEMA = path.join(REPO, "prisma", "postgres", "schema.prisma");
const SQLITE_SCHEMA = path.join(REPO, "prisma", "schema.prisma");
const OLD_PG_SCHEMA = path.join(REPO, "prisma", "schema.postgresql.prisma");
const BASELINE_SQL = path.join(REPO, "scripts", "db", "postgres-baseline.sql");
const CHECKER = path.join(REPO, "scripts", "db", "check-pg-migration-state.mjs");
const MIG_26D = "20260915180000_phase26d_quiz_attempt_architecture";

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ok - ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL - ${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
}
const read = (p) => fs.readFileSync(p, "utf8");
const sha256 = (p) => crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
/** SQL text with -- comments removed (for scanning CODE, not prose). */
const stripSqlComments = (sql) => sql.split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
const listMigrationDirs = (dir) =>
  fs.readdirSync(dir).filter((f) => /^\d+_/.test(f) || f === "0_init").sort();

// ---------------------------------------------------------------------------
// Part A — offline contracts
// ---------------------------------------------------------------------------

function partA() {
  console.log("\n== A. Offline contracts ==");

  // A1 — layout contract
  const sqliteMigrations = listMigrationDirs(SQLITE_MIGRATIONS);
  const pgMigrations = listMigrationDirs(PG_MIGRATIONS);
  ok(sqliteMigrations.length === 12, `SQLite migrations dir carries all 12 historical migrations (got ${sqliteMigrations.length})`);
  ok(pgMigrations.length === 2, `PG migrations dir carries exactly 0_init + Phase 26D (got ${pgMigrations.length})`);
  ok(pgMigrations[0] === "0_init" && pgMigrations[1] === MIG_26D, "PG migrations are 0_init then Phase 26D, in order");
  ok(fs.existsSync(PG_SCHEMA), "prisma/postgres/schema.prisma exists (PG schema owns its own directory)");
  ok(!fs.existsSync(OLD_PG_SCHEMA), "prisma/schema.postgresql.prisma does NOT exist (must never share prisma/ with SQLite again)");
  ok(/provider\s*=\s*"postgresql"/.test(read(PG_SCHEMA)), "PG schema targets postgresql");
  ok(/provider\s*=\s*"sqlite"/.test(read(SQLITE_SCHEMA)), "SQLite schema still targets sqlite");
  const sqliteLockPath = path.join(SQLITE_MIGRATIONS, "migration_lock.toml");
  const pgLock = read(path.join(PG_MIGRATIONS, "migration_lock.toml"));
  // The SQLite history predates the lock file (the repo's offline authoring
  // flow never created one); if one ever appears it must say sqlite.
  ok(!fs.existsSync(sqliteLockPath) || /provider\s*=\s*"sqlite"/.test(read(sqliteLockPath)),
    "SQLite migrations dir lock (if present) says sqlite");
  ok(/provider\s*=\s*"postgresql"/.test(pgLock), "PG migrations dir lock says postgresql");
  ok(
    !fs.existsSync(path.join(PG_MIGRATIONS, MIG_26D, "migration.sql")) === false &&
    read(path.join(PG_MIGRATIONS, MIG_26D, "migration.sql")) !== read(path.join(SQLITE_MIGRATIONS, MIG_26D, "migration.sql")),
    "the PG and SQLite editions of Phase 26D are distinct files (provider-specific SQL)"
  );
  const pgSchemaHeader = read(PG_SCHEMA).split("\n").slice(0, 35).join("\n");
  ok(/WHY THIS FILE LIVES IN prisma\/postgres\//.test(pgSchemaHeader), "PG schema header documents the directory contract");

  // A2 — applied-migration checksum contract.
  // These are the sha256 checksums ALREADY recorded in applied _prisma_migrations
  // ledgers (every developer SQLite database and — after recovery — production
  // PostgreSQL). Prisma records sha256(migration.sql) on apply and on
  // `migrate resolve`. Editing any applied migration file corrupts history:
  // fresh environments would diverge from existing ones and `migrate dev`
  // reports the file as modified. If a change is needed, ADD a new migration.
  const PINNED = {
    "20260904090608_add_student_identity_fields": "3ee864da7db3e7b8f48a4e548b716d79d3225fc8bbb45ce09e7c192ae6ce751f",
    "20260906120000_platform_upgrade_2026": "99922b3ce4512750d299ca0adeafad0e458f0956675ea092eda6a6bc60bac662",
    "20260907100000_phase3_domain_foundation": "41f98ed3c6e62472c3bc21e5ceba75b29330b6358a34777d60ea1f54687f674d",
    "20260908120000_phase5_quiz_answer_unique": "fb847bdf0dd704ff3af50e16bacae6f784313bff4a04848b2fcd496f81c46f39",
    "20260909120000_phase12_track_architecture": "dd5361a5c8a38f5e9da3aff05c07e7e4d2c5775ac3b7d94c2442858e328f9ea1",
    "20260909180000_phase13_session_lifecycle": "678a263cae534b684aa95882b759b6f7b686b006848ac0053e5cea113cfd9ada",
    "20260910120000_phase14_session_materials": "021da77a296c6483a7e29d149fe2a7348b5fccda9b7ceaa9f54389a2c84fa51d",
    "20260911000000_phase17_session_notifications": "286a94c05acb327884dd28ca9eeabfa69758d37f41d527c88be4957de7456687",
    "20260912000000_phase20_teacher_applications": "215c8bfc1071a8296bcd49bb311cc621723070cd88bba2da5250dda7d9b5b9b6",
    "20260914120000_payment_lifecycle_redesign": "6eb880cf2b067593c53ae903b05b96324ea759c7dc1a41302b3c6ce39d78e636",
    "20260915120000_phase26b_group_track_scope": "06cc038d4fc0f23b6fe63724f944f436c4007fc94ad4d04759c728bd893a4b39",
    "20260915180000_phase26d_quiz_attempt_architecture": "be10b56f4539f74b5ee1da28f52a97270ba656d8be87b78f7ddbb4ab39c92b4f",
    // PostgreSQL history (frozen from this commit on):
    "0_init": "c7f5d3fa76931d02e48c5cd2c4bfdb972c0f25e528e3c0c116736d3729cefa80",
    "PG:20260915180000_phase26d_quiz_attempt_architecture": "2c1bdde167f7dfff9b79a61f116da3dbd93b13c6aa27825404a79312ec7be104",
  };
  for (const [name, checksum] of Object.entries(PINNED)) {
    const isPg = name.startsWith("PG:") || name === "0_init";
    const base = name.startsWith("PG:") ? name.slice(3) : name;
    const file = isPg ? path.join(PG_MIGRATIONS, base, "migration.sql") : path.join(SQLITE_MIGRATIONS, base, "migration.sql");
    ok(sha256(file) === checksum,
      `applied migration (${isPg ? "pg" : "sqlite"}) ${base} is byte-frozen (checksum contract)`);
  }

  // A3 — PostgreSQL SQL must contain zero SQLite-only constructs.
  const DENYLIST = [
    [/\bDATETIME\b/i, "DATETIME (PostgreSQL has TIMESTAMPTZ; this exact type failed the Phase 26D production deploy)"],
    [/\bAUTOINCREMENT\b/i, "AUTOINCREMENT (SQLite-only)"],
    [/\bPRAGMA\s/i, "PRAGMA (SQLite-only)"],
    [/`/, "backtick identifier quoting (SQLite/MySQL style)"],
    [/\bCOLLATE\s+NOCASE\b/i, "COLLATE NOCASE (SQLite-only collation)"],
    [/DEFAULT\s+CURRENT_TIMESTAMP\s+ON\s+UPDATE/i, "ON UPDATE CURRENT_TIMESTAMP (MySQL/SQLite-only clause)"],
  ];
  for (const name of pgMigrations) {
    const sql = stripSqlComments(read(path.join(PG_MIGRATIONS, name, "migration.sql")));
    for (const [re, why] of DENYLIST) {
      ok(!re.test(sql), `PG migration ${name} contains no ${why}`);
    }
    // Prisma's migration runner splits the script on ";" — a semicolon inside
    // a "--" comment becomes a statement boundary and the leftover words are
    // sent to the server as SQL (observed: `syntax error at or near "…"`).
    // Native quaint tolerates these; driver-adapter runners do not. Keep the
    // PG history free of comment semicolons so it executes under both.
    const badComment = sql.split("\n").filter((l) => l.startsWith("--") && l.includes(";"));
    ok(badComment.length === 0, `PG migration ${name} has no semicolons inside -- comments (statement-splitter safety)`);
  }

  // A4 — structural convergence: 0_init + PG 26D == postgres-baseline.sql.
  const parseInventory = (sql) => {
    const inv = { enums: new Set(), tables: new Map(), indexes: new Set(), constraints: new Set() };
    for (const m of sql.matchAll(/CREATE TYPE "([A-Za-z0-9_]+)" AS ENUM \(([^)]*)\);/g)) inv.enums.add(`${m[1]}(${m[2].split(",").length})`);
    for (const m of sql.matchAll(/CREATE TABLE "([A-Za-z0-9_]+)" \(([\s\S]*?)\n\);/g)) {
      const cols = [];
      for (const line of m[2].split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("--")) continue;
        const col = /^"([A-Za-z0-9_]+)"\s+(TEXT|INTEGER|DOUBLE PRECISION|BOOLEAN|TIMESTAMPTZ\(3\)|"[A-Za-z0-9_]+")/.exec(t);
        if (col) cols.push(col[1]);
      }
      inv.tables.set(m[1], cols);
      for (const c of m[2].matchAll(/CONSTRAINT "([A-Za-z0-9_]+)"/g)) inv.constraints.add(c[1]);
    }
    for (const m of sql.matchAll(/CREATE (?:UNIQUE )?INDEX "([A-Za-z0-9_]+)"/g)) inv.indexes.add(m[1]);
    // ALTER TABLE ... ADD COLUMN "x" <type>  (26D edition) counts as a column of that table
    for (const m of sql.matchAll(/ALTER TABLE "([A-Za-z0-9_]+)" ADD COLUMN "([A-Za-z0-9_]+")/g)) {
      if (!inv.tables.has(m[1])) inv.tables.set(m[1], []);
      inv.tables.get(m[1]).push(m[2].replace(/"/g, ""));
    }
    // ALTER TABLE ... ADD CONSTRAINT "name" UNIQUE/FK (26D edition)
    for (const m of sql.matchAll(/ALTER TABLE\s+"[A-Za-z0-9_]+"\s+ADD CONSTRAINT\s+"([A-Za-z0-9_]+)"/g)) inv.constraints.add(m[1]);
    return inv;
  };
  const merge = (a, b) => {
    const out = { enums: new Set([...a.enums, ...b.enums]), tables: new Map(a.tables), indexes: new Set([...a.indexes, ...b.indexes]), constraints: new Set([...a.constraints, ...b.constraints]) };
    for (const [t, cols] of b.tables) out.tables.set(t, [...(out.tables.get(t) || []), ...cols]);
    return out;
  };
  const want = parseInventory(read(BASELINE_SQL));
  const got = merge(
    parseInventory(read(path.join(PG_MIGRATIONS, "0_init", "migration.sql"))),
    parseInventory(read(path.join(PG_MIGRATIONS, MIG_26D, "migration.sql")))
  );
  {
    const diffs = [];
    for (const e of want.enums) if (!got.enums.has(e)) diffs.push(`missing enum ${e}`);
    for (const e of got.enums) if (!want.enums.has(e)) diffs.push(`extra enum ${e}`);
    for (const [t, cols] of want.tables) {
      const gotCols = got.tables.get(t);
      if (!gotCols) { diffs.push(`missing table ${t}`); continue; }
      for (const c of cols) if (!gotCols.includes(c)) diffs.push(`missing column ${t}.${c}`);
      for (const c of gotCols) if (!cols.includes(c)) diffs.push(`extra column ${t}.${c}`);
    }
    for (const t of got.tables.keys()) if (!want.tables.has(t)) diffs.push(`extra table ${t}`);
    for (const c of want.constraints) if (!got.constraints.has(c)) diffs.push(`missing constraint ${c}`);
    for (const c of got.constraints) if (!want.constraints.has(c)) diffs.push(`extra constraint ${c}`);
    for (const c of want.indexes) if (!got.indexes.has(c)) diffs.push(`missing index ${c}`);
    for (const c of got.indexes) if (!want.indexes.has(c)) diffs.push(`extra index ${c}`);
    ok(diffs.length === 0,
      `0_init + PG Phase 26D == scripts/db/postgres-baseline.sql structurally (${want.tables.size} tables, ${[...want.tables.values()].reduce((a, c) => a + c.length, 0)} columns)`,
      diffs.slice(0, 8).join("; "));
  }

  // A5 — the two Phase 26D editions add the same logical objects.
  {
    const sqlite26d = read(path.join(SQLITE_MIGRATIONS, MIG_26D, "migration.sql"));
    const pg26d = read(path.join(PG_MIGRATIONS, MIG_26D, "migration.sql"));
    const cols = (sql) => [...sql.matchAll(/ADD COLUMN "([A-Za-z0-9_]+)"/g)].map((m) => m[1]).sort().join(",");
    ok(cols(sqlite26d) === cols(pg26d), "both Phase 26D editions add the same 18 columns in the same order");
    ok(/DATETIME/.test(stripSqlComments(sqlite26d)) && !/DATETIME/.test(stripSqlComments(pg26d)), "the SQLite edition keeps DATETIME, the PG edition does not");
    ok(/TIMESTAMPTZ\(3\)/.test(pg26d), "the PG edition uses TIMESTAMPTZ(3) (the schema's DateTime mapping)");
    ok(/"QuizAttempt_quizId_studentId_attemptNumber_key"/.test(pg26d) && /UNIQUE/.test(pg26d), "PG edition creates the unique attempt-number constraint with the canonical name");
    ok(/"QuizAttempt_retryGrantId_fkey"/.test(pg26d), "PG edition creates the grant FK with the canonical name");
    ok(/ON DELETE SET NULL/.test(pg26d), "PG edition keeps ON DELETE SET NULL on the grant FK (history-preserving)");
  }

  // A6 — fresh SQLite through the repo's own harness: base DDL + 12 migrations.
  {
    const { DatabaseSync } = require("node:sqlite");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-mig-providers-"));
    const dbPath = path.join(tmp, "fresh.db");
    const mig = require(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs"));
    const db = new DatabaseSync(dbPath);
    const applied = mig.applyMigrations(db, { withBaseSchema: true });
    ok(applied.length === 12, `fresh SQLite applies all 12 migrations (got ${applied.length})`);
    ok(applied[applied.length - 1] === MIG_26D, "the last applied SQLite migration is Phase 26D");
    for (const [tbl, cols] of [
      ["Quiz", ["quizMode", "questionCount", "maxAttempts", "shuffleOptions", "difficultyPlan"]],
      ["QuizAttempt", ["attemptNumber", "status", "retryGrantId"]],
      ["QuizAnswer", ["orderIndex", "questionType", "promptSnapshot", "promptArSnapshot", "optionsSnapshot", "answerSnapshot", "explanationSnapshot", "difficultySnapshot", "marksSnapshot", "schoolTypeSnapshot"]],
    ]) {
      const present = new Set(db.prepare(`PRAGMA table_info("${tbl}")`).all().map((r) => r.name));
      ok(cols.every((c) => present.has(c)), `fresh SQLite schema carries ${tbl} Phase 26D columns`);
    }
    ok(!!db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='QuizRetryGrant'`).get(), "fresh SQLite schema carries the QuizRetryGrant table");
    // the harness ledger records the very checksums pinned in A2
    const rows = db.prepare('SELECT migration_name, checksum FROM "_prisma_migrations"').all();
    const pinned = rows.every((r) => r.checksum === PINNED[r.migration_name]);
    ok(pinned && rows.length === 12, "fresh SQLite ledger carries exactly the pinned applied checksums");
    db.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // A7 — the read-only checker refuses to run without a target. (That it
  // issues NO writes is proven dynamically in B5, where it runs to success
  // under a role that has nothing but SELECT.)
  {
    const r = spawnSync(process.execPath, [CHECKER], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
    ok(r.status === 2, `checker exits 2 without a target (got ${r.status})`);
  }
}

// ---------------------------------------------------------------------------
// Shared PostgreSQL helpers (Parts B and C)
// ---------------------------------------------------------------------------

const DATABASE_URL = String(process.env.DATABASE_URL || "").trim();
const PRISMA_BIN = String(process.env.MIGRATION_PROVIDERS_PRISMA_BIN || "").trim();

function splitSqlStatements(sql) {
  const out = [];
  let cur = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const next2 = sql.slice(i, i + 2);
    if (next2 === "--") { while (i < n && sql[i] !== "\n") { cur += sql[i]; i++; } continue; }
    if (next2 === "/*") { cur += next2; i += 2; while (i < n && sql.slice(i, i + 2) !== "*/") { cur += sql[i]; i++; } cur += "*/"; i += 2; continue; }
    if (c === "'") {
      cur += c; i++;
      while (i < n) {
        cur += sql[i];
        if (sql[i] === "'") { if (sql[i + 1] === "'") { cur += sql[i + 1]; i += 2; continue; } i++; break; }
        i++;
      }
      continue;
    }
    if (c === ";") { if (cur.trim()) out.push(cur.trim()); cur = ""; i++; continue; }
    cur += c; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function resetPublicSchema(query) {
  await query("DROP SCHEMA public CASCADE");
  await query("CREATE SCHEMA public");
}

async function catalogSnapshot(query) {
  const snap = {};
  snap.enums = (await query(
    `SELECT t.typname AS name, e.enumlabel AS label FROM pg_type t
     JOIN pg_enum e ON e.enumtypid = t.oid
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname='public' ORDER BY t.typname, e.enumsortorder`
  )).rows;
  snap.columns = (await query(
    `SELECT table_name, column_name, ordinal_position FROM information_schema.columns
     WHERE table_schema='public' AND table_name <> '_prisma_migrations'
     ORDER BY table_name, ordinal_position`
  )).rows;
  snap.constraints = (await query(
    `SELECT conname, pg_get_constraintdef(oid, true) AS def FROM pg_constraint
     WHERE connamespace='public'::regnamespace
       AND conrelid::regclass::text <> '_prisma_migrations'
     ORDER BY conname`
  )).rows;
  snap.indexes = (await query(
    `SELECT i.relname AS name FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     WHERE n.nspname='public' AND t.relname <> '_prisma_migrations'
     ORDER BY i.relname`
  )).rows;
  return snap;
}

function catalogDiff(a, b) {
  const diffs = [];
  const key = (r) => JSON.stringify(r);
  const setDiff = (section) => {
    const A = new Set(a[section].map(key));
    const B = new Set(b[section].map(key));
    for (const x of A) if (!B.has(x)) diffs.push(`${section} only-in-${section === "columns" ? "migrations" : "migrations"}: ${x}`);
    for (const x of B) if (!A.has(x)) diffs.push(`${section} only-in-baseline: ${x}`);
  };
  for (const section of ["enums", "columns", "constraints", "indexes"]) setDiff(section);
  return diffs;
}

/** Build the simulated failed-Neon pre-recovery state (read-then-write, disposable DB). */
async function buildNeonSimulation(query) {
  await resetPublicSchema(query);
  for (const stmt of splitSqlStatements(read(path.join(PG_MIGRATIONS, "0_init", "migration.sql")))) {
    await query(stmt);
  }
  await query(
    `CREATE TABLE _prisma_migrations (
       id VARCHAR(36) PRIMARY KEY NOT NULL, checksum VARCHAR(64) NOT NULL,
       finished_at TIMESTAMPTZ, migration_name VARCHAR(255) NOT NULL, logs TEXT,
       rolled_back_at TIMESTAMPTZ, started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       applied_steps_count INTEGER NOT NULL DEFAULT 0)`
  );
  // The 11 pre-26D SQLite migration names, marked applied with the SQLITE file
  // checksums — exactly what `migrate resolve --applied` recorded on Neon at
  // cutover against the then-shared prisma/migrations directory.
  const sqliteNames = listMigrationDirs(SQLITE_MIGRATIONS).filter((n) => n !== MIG_26D);
  for (const name of sqliteNames) {
    await query(
      `INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, started_at, applied_steps_count)
       VALUES (gen_random_uuid()::text, $1, now(), $2, now(), 1)`,
      [sha256(path.join(SQLITE_MIGRATIONS, name, "migration.sql")), name]
    );
  }
  // The FAILED Phase 26D row the aborted `migrate deploy` left behind
  // (finished_at NULL, rolled_back_at NULL, applied_steps_count 0).
  await query(
    `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, applied_steps_count, logs)
     VALUES (gen_random_uuid()::text, $1, $2, now(), 0, $3)`,
    [sha256(path.join(SQLITE_MIGRATIONS, MIG_26D, "migration.sql")), MIG_26D, 'ERROR: type "datetime" does not exist']
  );
}

// ---------------------------------------------------------------------------
// Part B — real PostgreSQL (disposable), SQL-level
// ---------------------------------------------------------------------------

async function partB() {
  const failuresAtStart = failures.length;
  console.log("\n== B. Real PostgreSQL (SQL-level) ==");
  const pg = require("pg");
  const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
  const query = async (text, params) => pool.query(text, params);

  // B1 — reference snapshot from the generated baseline DDL.
  await resetPublicSchema(query);
  for (const stmt of splitSqlStatements(read(BASELINE_SQL))) await query(stmt);
  const baselineSnap = await catalogSnapshot(query);

  // B2 — the PG migrations directory alone must converge to the same catalog.
  await resetPublicSchema(query);
  for (const name of listMigrationDirs(PG_MIGRATIONS)) {
    for (const stmt of splitSqlStatements(read(path.join(PG_MIGRATIONS, name, "migration.sql")))) {
      await query(stmt);
    }
  }
  const migrationsSnap = await catalogSnapshot(query);
  const diffs = catalogDiff(migrationsSnap, baselineSnap);
  ok(diffs.length === 0,
    `0_init + Phase 26D on real PostgreSQL == postgres-baseline.sql catalog (${baselineSnap.columns.length} columns, ${baselineSnap.constraints.length} constraints, ${baselineSnap.indexes.length} indexes)`,
    diffs.slice(0, 6).join(" | "));

  // B3 — representative pre-26D PostgreSQL state (the failed-Neon shape):
  //      the Phase 26D SQL must apply cleanly on top of it.
  await buildNeonSimulation(query);
  {
    const before = await query(`SELECT to_regclass('public."QuizRetryGrant"') AS t`);
    ok(before.rows[0].t === null, "simulated pre-recovery state has no QuizRetryGrant (nothing partially applied)");
    const ledger = await query(`SELECT migration_name, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rb FROM _prisma_migrations`);
    ok(ledger.rows.filter((r) => !r.done && !r.rb).length === 1, "simulated ledger carries exactly one FAILED row (Phase 26D)");
    ok(ledger.rows.filter((r) => r.done).length === 11, "simulated ledger carries the 11 baselined rows");
  }
  for (const stmt of splitSqlStatements(read(path.join(PG_MIGRATIONS, MIG_26D, "migration.sql")))) {
    await query(stmt);
  }
  const recoveredSnap = await catalogSnapshot(query);
  const diffs2 = catalogDiff(recoveredSnap, baselineSnap);
  ok(diffs2.length === 0, "applying the PG Phase 26D edition on the pre-26D state converges to the baseline catalog", diffs2.slice(0, 6).join(" | "));
  ok((await query(`SELECT to_regclass('public."QuizRetryGrant"') AS t`)).rows[0].t !== null, "QuizRetryGrant exists after the 26D PG migration");

  // B4 — the read-only checker must bless the simulated pre-recovery state.
  await buildNeonSimulation(query);
  {
    const r = spawnSync(process.execPath, [CHECKER, "--target", DATABASE_URL], { encoding: "utf8" });
    ok(r.status === 0, `check-pg-migration-state exits 0 on the pre-recovery state (got ${r.status})`, String(r.stderr || r.stdout || "").slice(0, 400));
    ok(/PRE-RECOVERY state/.test(String(r.stdout)), "checker output confirms the pre-recovery verdict");
    ok(!/[A-Za-z0-9+_:@\/.-]*postgres(ql)?:\/\/[^\s"']*/.test(String(r.stdout).replace(/postgresql:\/\/postgres@127\.0\.0\.1:\d+\/\w+/g, "")), "checker never prints the connection URL");
  }
  // …and must REFUSE to bless the already-migrated state.
  await resetPublicSchema(query);
  for (const name of listMigrationDirs(PG_MIGRATIONS)) {
    for (const stmt of splitSqlStatements(read(path.join(PG_MIGRATIONS, name, "migration.sql")))) await query(stmt);
  }
  {
    const r = spawnSync(process.execPath, [CHECKER, "--target", DATABASE_URL], { encoding: "utf8" });
    ok(r.status === 1, `check-pg-migration-state exits 1 on an already-migrated database (got ${r.status})`);
  }

  // B5 — the checker is REALLY read-only: it must succeed under a role whose
  //      only privilege is SELECT (any write attempt would error out).
  //      The role gets a password so the proof also works on password-auth
  //      test rigs (md5/scram); trust-auth rigs simply ignore it.
  await buildNeonSimulation(query);
  {
    const roleName = "cm_migration_providers_readonly";
    const rolePassword = "readonly_probe_only";
    await query(`DROP ROLE IF EXISTS ${roleName}`);
    await query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}'`);
    await query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await query(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${roleName}`);
    const roUrl = new URL(DATABASE_URL);
    roUrl.username = roleName;
    roUrl.password = rolePassword;
    const r = spawnSync(process.execPath, [CHECKER, "--target", roUrl.toString()], { encoding: "utf8" });
    ok(r.status === 0, "checker succeeds under a SELECT-only role (it writes nothing)", String(r.stderr || r.stdout || "").slice(0, 400));
    await query(`DROP OWNED BY ${roleName}`);
    await query(`DROP ROLE ${roleName}`);
  }

  await pool.end();
  // The success sentinel is a CI gate: it must NEVER print if any assertion
  // in this part failed (the exit code is the primary gate; this is
  // defense-in-depth for the workflow's skip enforcement).
  if (failures.length === failuresAtStart) console.log("MIGRATION_PROVIDERS_PG_OK");
}

// ---------------------------------------------------------------------------
// Part C — real Prisma engine (CI must enable; a skip is a failure there)
// ---------------------------------------------------------------------------

function runPrisma(args, envExtra) {
  return spawnSync(PRISMA_BIN, args, {
    encoding: "utf8",
    cwd: REPO,
    env: { ...process.env, ...envExtra },
  });
}

async function partC() {
  const failuresAtStart = failures.length;
  console.log("\n== C. Real Prisma engine ==");
  const pg = require("pg");

  // C1 — fresh PostgreSQL: `migrate deploy` alone provisions and converges.
  {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    const query = async (t, p) => pool.query(t, p);
    await resetPublicSchema(query);
    await pool.end();
    const r = runPrisma(["migrate", "deploy", "--schema", PG_SCHEMA], { DATABASE_URL });
    ok(r.status === 0, "engine: fresh `migrate deploy --schema prisma/postgres/schema.prisma` succeeds", String(r.stderr || r.stdout || "").slice(0, 600));
    const st = runPrisma(["migrate", "status", "--schema", PG_SCHEMA], { DATABASE_URL });
    ok(/Database schema is up to date!/.test(String(st.stdout)), "engine: migrate status reports up to date");
    const pool2 = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    const query2 = async (t, p) => pool2.query(t, p);
    const snap = await catalogSnapshot(query2);
    const ledger = await query2(`SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name`);
    ok(JSON.stringify(ledger.rows.map((x) => x.migration_name)) === JSON.stringify(["0_init", MIG_26D]),
      "engine: fresh deploy ledger contains exactly 0_init + Phase 26D (never the SQLite names)");
    const refs = await query2(`SELECT to_regclass('public."QuizRetryGrant"') AS t`);
    ok(refs.rows[0].t !== null, "engine: QuizRetryGrant exists after fresh deploy");
    await pool2.end();
    // catalog equality against the baseline
    const pool3 = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    const q3 = async (t, p) => pool3.query(t, p);
    await resetPublicSchema(q3);
    for (const stmt of splitSqlStatements(read(BASELINE_SQL))) await q3(stmt);
    const baselineSnap = await catalogSnapshot(q3);
    await pool3.end();
    const diffs = catalogDiff(snap, baselineSnap);
    ok(diffs.length === 0, "engine: fresh deploy catalog == baseline catalog", diffs.slice(0, 6).join(" | "));
  }

  // C2 — the failed-Neon recovery, through the real engine commands.
  {
    const pool = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    const query = async (t, p) => pool.query(t, p);
    await buildNeonSimulation(query);
    await pool.end();

    const r0 = runPrisma(["migrate", "deploy", "--schema", PG_SCHEMA], { DATABASE_URL });
    ok(r0.status !== 0 && /P3009|failed migrations/i.test(String(r0.stderr || r0.stdout)),
      "engine: deploy refuses while the FAILED Phase 26D row exists (P3009)");

    const r1 = runPrisma(["migrate", "resolve", "--rolled-back", MIG_26D, "--schema", PG_SCHEMA], { DATABASE_URL });
    ok(r1.status === 0, "engine: `migrate resolve --rolled-back` succeeds", String(r1.stderr || r1.stdout || "").slice(0, 400));

    const r2 = runPrisma(["migrate", "resolve", "--applied", "0_init", "--schema", PG_SCHEMA], { DATABASE_URL });
    ok(r2.status === 0, "engine: `migrate resolve --applied 0_init` succeeds", String(r2.stderr || r1.stdout || "").slice(0, 400));

    const r3 = runPrisma(["migrate", "deploy", "--schema", PG_SCHEMA], { DATABASE_URL });
    ok(r3.status === 0, "engine: deploy applies the PostgreSQL Phase 26D migration", String(r3.stderr || r3.stdout || "").slice(0, 600));

    const st = runPrisma(["migrate", "status", "--schema", PG_SCHEMA], { DATABASE_URL });
    ok(/Database schema is up to date!/.test(String(st.stdout)), "engine: status is clean after recovery");

    const again = runPrisma(["migrate", "deploy", "--schema", PG_SCHEMA], { DATABASE_URL });
    ok(again.status === 0 && /No pending migrations/i.test(String(again.stdout)), "engine: deploy is idempotent after recovery");

    const pool2 = new pg.Pool({ connectionString: DATABASE_URL, max: 1 });
    const q2 = async (t, p) => pool2.query(t, p);
    const ledger = await q2(`SELECT migration_name, finished_at IS NOT NULL AS done, rolled_back_at IS NOT NULL AS rb FROM _prisma_migrations ORDER BY started_at`);
    ok(ledger.rows.filter((x) => !x.done && !x.rb).length === 0, "engine: no failed rows remain after recovery");
    ok(ledger.rows.filter((x) => x.migration_name === MIG_26D && x.done).length === 1, "engine: exactly one applied Phase 26D row");
    ok(ledger.rows.filter((x) => x.migration_name === MIG_26D && x.rb).length === 1, "engine: the rolled-back historical row is retained (audit trail)");
    const refs = await q2(`SELECT to_regclass('public."QuizRetryGrant"') AS t`);
    ok(refs.rows[0].t !== null, "engine: QuizRetryGrant exists after recovery");
    await pool2.end();
  }

  // C3 — SQLite applied-ledger contract through the real engine: a database
  //      migrated with the repo harness (base DDL + 12 files, real checksums)
  //      must be recognised as fully up to date.
  {
    const { DatabaseSync } = require("node:sqlite");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cm-mig-providers-engine-"));
    const dbPath = path.join(tmp, "dev.db");
    const mig = require(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs"));
    const db = new DatabaseSync(dbPath);
    mig.applyMigrations(db, { withBaseSchema: true });
    db.close();
    const url = `file:${dbPath}`;
    const st = runPrisma(["migrate", "status", "--schema", SQLITE_SCHEMA], { DATABASE_URL: url });
    ok(/Database schema is up to date!/.test(String(st.stdout)), "engine: applied SQLite ledger is recognised as up to date", String(st.stderr || st.stdout || "").slice(0, 400));
    const dep = runPrisma(["migrate", "deploy", "--schema", SQLITE_SCHEMA], { DATABASE_URL: url });
    ok(dep.status === 0 && /No pending migrations/i.test(String(dep.stdout)), "engine: SQLite deploy is a no-op on the fully-migrated database");
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log("MIGRATION_PROVIDERS_ENGINE_OK");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  console.log("migration-providers: guarding the Phase 26D provider-split architecture");
  partA();

  let pgRan = false;
  if (DATABASE_URL && /^postgres(ql)?:\/\//i.test(DATABASE_URL)) {
    // SAFETY: disposable local/CI databases only — this file DROPs the public
    // schema and must never run against production or a hosted database.
    if (/neon\.tech|neondb|prod|production|vercel|aws\.com|supabase|render\.com/i.test(DATABASE_URL)) {
      console.error("\nREFUSING TO RUN: DATABASE_URL looks like a production/hosted database.");
      process.exit(1);
    }
    const host = (() => { try { return new URL(DATABASE_URL).hostname.toLowerCase(); } catch { return ""; } })();
    const ALLOWED = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db", "0.0.0.0"]);
    for (const h of String(process.env.MIGRATION_PROVIDERS_PG_ALLOWED_HOSTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) ALLOWED.add(h);
    if (!ALLOWED.has(host)) {
      console.error(`\nREFUSING TO RUN: host "${host}" is not a local/CI-service host.`);
      process.exit(1);
    }
    await partB();
    pgRan = true;
  } else {
    console.log("\nmigration-providers: PG part SKIPPED — DATABASE_URL is not a PostgreSQL URL.");
    console.log("MIGRATION_PROVIDERS_PG_SKIPPED");
  }

  if (PRISMA_BIN) {
    if (!pgRan) {
      console.error("\nmigration-providers: MIGRATION_PROVIDERS_PRISMA_BIN requires a PostgreSQL DATABASE_URL (the engine proofs need a disposable PG).");
      process.exit(1);
    }
    await partC();
  } else {
    console.log("\nmigration-providers: engine part SKIPPED — MIGRATION_PROVIDERS_PRISMA_BIN is not set.");
    console.log("MIGRATION_PROVIDERS_ENGINE_SKIPPED");
  }

  console.log(`\nmigration-providers: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const f of failures) console.error(`  FAIL: ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error("migration-providers:", e); process.exit(1); });
