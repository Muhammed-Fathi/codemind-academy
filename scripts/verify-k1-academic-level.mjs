// CodeMind Academy — Phase K1 verification (AcademicLevel capability + backfill).
//
// Run: node scripts/verify-k1-academic-level.mjs
// Exit: 0 = all pass · 1 = verification failure · 2 = K1 STOP CONDITION
//       (orphan lesson or a stop-condition check failed — do not continue to K2).
//
// WHAT IT PROVES (docs/MULTI_LEVEL_FINAL_CONTRACT.md §8/§9, K1 checkpoint)
//   1. K1 CHECKPOINT CHAIN — the repo's own SQLite harness applies base DDL +
//      the first 20 migrations (`upTo: K1`); K1 is the 20th; the three
//      academicLevel columns exist and are NULLABLE at that checkpoint; the
//      global Lesson.officialCode unique is UNCHANGED at that checkpoint.
//      (Phase K3 later tightens all of this — see
//      scripts/verify-k3-academic-level.mjs; the full chain is now 21.)
//   2. PRODUCTION-SHAPED REHEARSAL — a scratch database is built through the
//      first 19 migrations (the pre-K1 state) and populated with the output
//      of the REAL `scripts/seed.ts` (settings, users, student, parent link,
//      course, quizzes/homework, group, live sessions + the real Phase 11
//      reconciler: 2 Parts / 7 Units / 23 official lessons), snapshotted
//      byte-for-byte, then the K1 migration file is applied through the same
//      harness. Since Phase K2 the seed itself writes `academicLevel` (it
//      cannot run against a schema without the column), so the seed runs on
//      a K1-state scratch database and its rows are TRANSPLANTED table by
//      table into the pre-K1 database, dropping ONLY the `academicLevel`
//      column — exactly the value the K1 backfill must re-derive (check D
//      proves the derivation reproduces it). Nothing else is altered.
//      The seed is executed exactly the way the repo's own verify-* scripts
//      execute real application code in this sandbox: compiled with the repo
//      tsc, `src/lib/db` shimmed to `scripts/lib/sqlite-prisma-lite.mjs`
//      (Prisma calls → real SQL on node:sqlite), in a child process.
//      The engine binaries are not downloadable in this sandbox — the SQL
//      translation is the adapter's, the data effects are the database's own.
//      In CI/production the equivalent rehearsal runs through `prisma migrate
//      deploy` + `prisma db seed`.
//   After applying K1:
//        A. every Course.academicLevel     = SECOND_SECONDARY (0 NULL)
//        B. every Student.academicLevel    = SECOND_SECONDARY (0 NULL)
//        C. every attributed Lesson        = SECOND_SECONDARY (0 NULL)
//        D. every Lesson level == its chain-derived Course level (0 mismatch)
//        E. orphan lessons (no Unit AND no Topic) = 0  [STOP CONDITION if >0,
//           orphan ids/titles are reported]
//        F. the Second Secondary official curriculum is still 2/7/23 with the
//           exact same official codes and the same lesson IDs as pre-K1
//        G. no FIRST_SECONDARY row exists anywhere (K1 creates no First data)
//        H. no identity is regenerated: Course/Student/Lesson/Group/Batch/User
//           id sets are identical pre/post
//        I. the global officialCode uniqueness still rejects a duplicate
//        + every non-academicLevel column of every table is byte-identical
//          pre/post (no progress, attempt, submission, attendance, absence,
//          parent link, notification, subscription, payment, session, batch,
//          group or media reference changed; no student lost Group/Batch).
//
// Requires Node >= 22.5 (built-in node:sqlite). Scratch databases live in the
// OS temp dir — never the real database, never seeded with production data.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
// ESM import() rejects raw Windows paths (ERR_UNSUPPORTED_ESM_URL_SCHEME,
// protocol "e:"). Filesystem paths must be file:// URLs.
const { applyMigrations, listMigrations } = await import(
  pathToFileURL(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs")).href
);

const K1 = "20260923100000_k1_academic_level_capability";
const LAST_BEFORE_K1 = "20260922090000_readiness_reminder_recipients";
const K1_CHAIN_LENGTH = 20;

let pass = 0;
const failures = [];
const ok = (cond, label, extra) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${extra !== undefined ? ` (${extra})` : ""}`);
  }
};
const section = (t) => console.log(`\n== ${t} ==`);
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cm-k1-verify-"));

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

function tableNames(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_prisma%' ORDER BY name`)
    .all()
    .map((r) => r.name);
}

/** Full ordered row set of a table, optionally with a column projected out. */
function snapshotTable(db, table, dropColumns = []) {
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY "id"`).all();
  if (dropColumns.length) {
    for (const r of rows) for (const c of dropColumns) delete r[c];
  }
  return JSON.stringify(rows);
}

function idSet(db, table) {
  return db.prepare(`SELECT "id" FROM "${table}" ORDER BY "id"`).all().map((r) => r.id).join(",");
}

function fullSnapshot(db, dropColumns = []) {
  const snap = {};
  for (const t of tableNames(db)) snap[t] = snapshotTable(db, t, dropColumns);
  return snap;
}

// ---------------------------------------------------------------------------
// 1. K1 CHECKPOINT CHAIN (base DDL + the first 20 migrations, up to K1)
// ---------------------------------------------------------------------------

section("1. K1 CHECKPOINT CHAIN — base DDL + migrations up to K1 (repo harness)");
{
  const db = new DatabaseSync(path.join(WORK, "fresh.db"));
  const applied = applyMigrations(db, { withBaseSchema: true, upTo: K1, label: "fresh " });
  ok(applied.length === K1_CHAIN_LENGTH, `chain up to K1 applies ${K1_CHAIN_LENGTH} migrations (got ${applied.length})`);
  ok(applied[applied.length - 1] === K1, `the ${K1_CHAIN_LENGTH}th applied migration is K1 (got ${applied[applied.length - 1]})`);
  ok(listMigrations().length > K1_CHAIN_LENGTH && listMigrations()[K1_CHAIN_LENGTH - 1] === K1,
    `the repository chain continues past K1 (${listMigrations().length} migrations; K1 at position ${K1_CHAIN_LENGTH})`);
  for (const tbl of ["Course", "Student", "Lesson"]) {
    const col = db.prepare(`PRAGMA table_info("${tbl}")`).all().find((r) => r.name === "academicLevel");
    ok(!!col, `fresh schema carries ${tbl}.academicLevel`);
    if (col) ok(Number(col.notnull) === 0, `${tbl}.academicLevel is nullable in K1 (required-ness is K3)`);
  }
  ok(
    !!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='Lesson_officialCode_key'`).get(),
    "global Lesson.officialCode unique is UNCHANGED at the K1 checkpoint (composite uniqueness is K3)"
  );
  // A fresh (empty) chain has no rows — nothing to backfill, nothing to orphan.
  ok(db.prepare(`SELECT COUNT(*) AS c FROM "Lesson"`).get().c === 0, "fresh chain carries no curriculum rows (empty platform)");
  db.close();
}

// ---------------------------------------------------------------------------
// 2. REHEARSAL — pre-K1 database
// ---------------------------------------------------------------------------

section("2. REHEARSAL — pre-K1 database (base DDL + first 19 migrations)");
const PRE_PATH = path.join(WORK, "pre.db");
const pre = new DatabaseSync(PRE_PATH);
applyMigrations(pre, { upTo: LAST_BEFORE_K1, withBaseSchema: true, label: "pre-K1 " });
ok(pre.prepare(`SELECT COUNT(*) AS c FROM "_prisma_migrations"`).get().c === 19, "pre-K1 ledger carries exactly 19 migrations");
ok(
  !pre.prepare(`PRAGMA table_info("Course")`).all().some((r) => r.name === "academicLevel"),
  "pre-K1 database genuinely has no academicLevel column"
);

// ---------------------------------------------------------------------------
// 3. Populate the pre-K1 database with the REAL scripts/seed.ts
//    (compiled with the repo tsc; db shimmed to sqlite-prisma-lite; child process)
// ---------------------------------------------------------------------------

section("3. REAL SEED — scripts/seed.ts on a K1-state database, transplanted into pre-K1");
// The seed runs against a K1-state scratch database (the earliest schema the
// K2+ seed can populate); its rows are then copied into the pre-K1 database
// minus the `academicLevel` column (see header).
const SEED_PATH = path.join(WORK, "seed-k1-state.db");
{
  const seedDb = new DatabaseSync(SEED_PATH);
  applyMigrations(seedDb, { upTo: K1, withBaseSchema: true, label: "seed-K1 " });
  ok(seedDb.prepare(`SELECT COUNT(*) AS c FROM "_prisma_migrations"`).get().c === K1_CHAIN_LENGTH, "seed scratch database is at the K1 checkpoint (20 migrations)");
  seedDb.close();
}
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-k1-seed-"));
  const tscBin = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
  fs.writeFileSync(
    path.join(out, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2020",
          module: "commonjs",
          moduleResolution: "node",
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          allowJs: false,
          types: ["node"],
          typeRoots: [path.join(REPO, "node_modules/@types")],
          baseUrl: REPO,
          paths: { "@/*": ["src/*"] },
          rootDir: REPO,
          outDir: out,
        },
        files: [path.join(REPO, "scripts", "seed.ts")],
      },
      null,
      2
    )
  );
  const tsc = spawnSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], {
    cwd: REPO,
    encoding: "utf8",
  });
  const seedOut = path.join(out, "scripts", "seed.js");
  ok(fs.existsSync(seedOut), `repo tsc compiled scripts/seed.ts${fs.existsSync(seedOut) ? "" : ` (${(tsc.stderr || "").slice(0, 300)})`}`);

  fs.writeFileSync(
    path.join(out, "__db-shim.js"),
    'module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n'
  );
  // auth.ts imports next/headers at module top level; the seed path never
  // touches request cookies, so a throwing stub keeps the graph hermetic
  // (no Next.js runtime, no request-context trap).
  const nextStub = path.join(out, "__next-headers-stub.js");
  fs.writeFileSync(
    nextStub,
    'const throwIfUsed = (n) => { const f = () => { throw new Error(`next/headers: ${n} is not available in offline K1 verification`); }; return f; };\n' +
      'module.exports = { cookies: throwIfUsed("cookies"), headers: throwIfUsed("headers") };\n'
  );
  // ESM runner: installs the db shim, points the compiled seed at the scratch
  // database through the repo's own Prisma→SQL adapter, then imports the seed
  // (which runs its main() on import, exactly like `tsx scripts/seed.ts`).
  fs.writeFileSync(
    path.join(out, "run-seed.mjs"),
    `import { DatabaseSync } from "node:sqlite";
import { Module } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createSqlitePrisma } from ${JSON.stringify(pathToFileURL(path.join(REPO, "scripts", "lib", "sqlite-prisma-lite.mjs")).href)};

const dbPath = process.argv[2];
const outDir = ${JSON.stringify(out)};
const shim = path.join(outDir, "__db-shim.js");

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA foreign_keys=ON;");
const client = createSqlitePrisma({ db, schemaPath: ${JSON.stringify(path.join(REPO, "prisma", "schema.prisma"))} });
// scripts/seed.ts calls db.$disconnect() exactly when its main() finishes;
// that is the completion signal this runner waits on before exiting (the
// seed's top-level main() call is fire-and-forget).
let seedSettled = false;
const seedDone = new Promise((res) => {
  const orig = client.$disconnect.bind(client);
  client.$disconnect = async (...args) => {
    await orig(...args);
    if (!seedSettled) {
      seedSettled = true;
      res();
    }
  };
});
globalThis.__CM_DB_CLIENT__ = client;

const nextStub = path.join(outDir, "__next-headers-stub.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return shim;
  if (request === "next/headers") return nextStub;
  const m = /^@\\/lib\\/([\\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(outDir, "src", "lib", m[1] + ".js");
    if (fs.existsSync(compiled)) return compiled;
  }
  const json = /knowledge-model\\.json$/.exec(request);
  if (json) {
    const copied = path.join(outDir, "docs", "curriculum", "knowledge-model.json");
    if (fs.existsSync(copied)) return copied;
  }
  const resolved = originalResolve.call(this, request, ...rest);
  if (/[/\\\\]src[/\\\\]lib[/\\\\]db\\.(ts|js)$/.test(resolved)) return shim;
  return resolved;
};

try {
  await import(pathToFileURL(path.join(outDir, "scripts", "seed.js")).href);
  await Promise.race([
    seedDone,
    new Promise((_, rej) => setTimeout(() => rej(new Error("seed did not complete within 90s")), 90000)),
  ]);
} finally {
  Module._resolveFilename = originalResolve;
  db.close();
}
process.exit(0);
`
  );

  const seedRes = spawnSync(process.execPath, [path.join(out, "run-seed.mjs"), SEED_PATH], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "development",
      // The compiled tree lives in a temp dir; bare specifiers
      // (@prisma/client, ...) resolve through the repo's node_modules.
      NODE_PATH: path.join(REPO, "node_modules"),
      SEED_ADMIN_PASSWORD: "k1-verify-disposable-admin-password",
      SEED_DEMO_PASSWORD: "k1-verify-disposable-demo-password",
    },
  });
  ok(seedRes.status === 0, `real scripts/seed.ts populates the K1-state database${seedRes.status === 0 ? "" : ` (exit ${seedRes.status})`}`,
    (seedRes.stderr || seedRes.stdout || "").slice(-500));
  fs.rmSync(out, { recursive: true, force: true });
}
// Transplant: every application table, every row, every column EXCEPT
// academicLevel (which does not exist pre-K1). Row order and ids are kept.
{
  const seedDb = new DatabaseSync(SEED_PATH);
  let tables = 0;
  let rows = 0;
  pre.exec("PRAGMA foreign_keys=OFF");
  pre.exec("BEGIN");
  for (const t of tableNames(seedDb)) {
    const cols = pre.prepare(`PRAGMA table_info("${t}")`).all().map((r) => r.name).filter((c) => c !== "academicLevel");
    const data = seedDb.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM "${t}" ORDER BY rowid`).all();
    if (!data.length) continue;
    const ins = pre.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
    for (const r of data) ins.run(...cols.map((c) => r[c]));
    tables += 1;
    rows += data.length;
  }
  pre.exec("COMMIT");
  pre.exec("PRAGMA foreign_keys=ON");
  const fkViolations = pre.prepare("PRAGMA foreign_key_check").all().length;
  ok(rows > 0 && fkViolations === 0, `seeded rows transplanted into the pre-K1 schema (${tables} tables, ${rows} rows, ${fkViolations} FK violations)`);
  ok(
    !pre.prepare(`PRAGMA table_info("Lesson")`).all().some((r) => r.name === "academicLevel"),
    "the pre-K1 database still has no academicLevel column after the transplant (K1 must derive it)"
  );
  seedDb.close();
}

// Pre-K1 shape: the reconciled official curriculum is 2 Parts / 7 Units / 23 lessons.
const preParts = pre.prepare(`SELECT COUNT(*) AS c FROM "Part"`).get().c;
const preUnits = pre.prepare(`SELECT COUNT(*) AS c FROM "Unit"`).get().c;
const preOfficial = pre.prepare(`SELECT COUNT(*) AS c FROM "Lesson" WHERE "curriculumStatus"='OFFICIAL'`).get().c;
ok(preParts === 2 && preUnits === 7 && preOfficial === 23,
  `pre-K1 curriculum is 2 Parts / 7 Units / 23 official lessons (got ${preParts}/${preUnits}/${preOfficial})`);
ok(pre.prepare(`SELECT COUNT(*) AS c FROM "Student"`).get().c > 0, "seed created students");
ok(pre.prepare(`SELECT COUNT(*) AS c FROM "Student" WHERE "groupId" IS NOT NULL`).get().c > 0, "seed assigned at least one student to a group");

// Byte snapshot of EVERYTHING (all columns; academicLevel does not exist yet).
const before = fullSnapshot(pre);
const preIds = {
  Course: idSet(pre, "Course"),
  Student: idSet(pre, "Student"),
  Lesson: idSet(pre, "Lesson"),
  Group: idSet(pre, "Group"),
  Batch: idSet(pre, "Batch"),
  User: idSet(pre, "User"),
};
const preOfficialCodes = pre
  .prepare(`SELECT "officialCode" FROM "Lesson" WHERE "officialCode" IS NOT NULL ORDER BY "officialCode"`)
  .all()
  .map((r) => r.officialCode);

// ---------------------------------------------------------------------------
// 4. Apply the K1 migration through the repo harness (records the real checksum)
// ---------------------------------------------------------------------------

section("4. Apply K1 migration");
const appliedK1 = applyMigrations(pre, { upTo: K1, label: "K1 " });
ok(appliedK1.length === 1 && appliedK1[0] === K1, `only the K1 migration is applied at this step (got ${JSON.stringify(appliedK1)})`);
ok(
  pre.prepare(`SELECT checksum FROM "_prisma_migrations" WHERE migration_name=?`).get(K1)?.checksum ===
    sha256(fs.readFileSync(path.join(REPO, "prisma", "migrations", K1, "migration.sql"), "utf8").replace(/\r\n/g, "\n")),
  "K1 ledger row carries the canonical file checksum"
);

// ---------------------------------------------------------------------------
// 5. Integrity checks A–I
// ---------------------------------------------------------------------------

section("5. Integrity checks A–I");

// A/B — every Course / Student is SECOND_SECONDARY, zero NULL.
for (const tbl of ["Course", "Student"]) {
  const nulls = pre.prepare(`SELECT COUNT(*) AS c FROM "${tbl}" WHERE "academicLevel" IS NULL`).get().c;
  const wrong = pre.prepare(`SELECT COUNT(*) AS c FROM "${tbl}" WHERE "academicLevel" IS NOT 'SECOND_SECONDARY'`).get().c;
  const total = pre.prepare(`SELECT COUNT(*) AS c FROM "${tbl}"`).get().c;
  ok(nulls === 0 && wrong === 0, `${tbl === "Course" ? "A" : "B"}. every ${tbl} has academicLevel = SECOND_SECONDARY (${total} rows, ${nulls} NULL, ${wrong} wrong)`);
}

// E — orphan lessons (no canonical unit AND no legacy topic link): STOP CONDITION.
const orphans = pre
  .prepare(`SELECT "id", "title" FROM "Lesson" WHERE "unitId" IS NULL AND "topicId" IS NULL ORDER BY "id"`)
  .all();
if (orphans.length > 0) {
  console.error(`\n  K1 STOP CONDITION: ${orphans.length} orphan lesson(s) — id / title:`);
  for (const o of orphans) console.error(`    ${o.id}  ${o.title}`);
  console.error("  Attribute them to a Unit (or archive them) and re-run. Do NOT continue to K2.\n");
  process.exit(2);
}
ok(orphans.length === 0, "E. orphan lessons = 0 (no lesson without a Unit or Topic chain)");

// C — every attributed lesson is SECOND_SECONDARY (all lessons are attributed here).
const lessonTotal = pre.prepare(`SELECT COUNT(*) AS c FROM "Lesson"`).get().c;
const lessonNulls = pre.prepare(`SELECT COUNT(*) AS c FROM "Lesson" WHERE "academicLevel" IS NULL`).get().c;
const lessonWrong = pre.prepare(`SELECT COUNT(*) AS c FROM "Lesson" WHERE "academicLevel" IS NOT 'SECOND_SECONDARY'`).get().c;
ok(lessonNulls === 0 && lessonWrong === 0, `C. every attributed Lesson has academicLevel = SECOND_SECONDARY (${lessonTotal} rows, ${lessonNulls} NULL, ${lessonWrong} wrong)`);

// D — stored level == chain-derived Course level (canonical wins, legacy fallback).
{
  const courses = new Map(pre.prepare(`SELECT "id", "academicLevel" FROM "Course"`).all().map((r) => [r.id, r.academicLevel]));
  const parts = new Map(pre.prepare(`SELECT "id", "courseId" FROM "Part"`).all().map((r) => [r.id, r.courseId]));
  const units = new Map(pre.prepare(`SELECT "id", "partId" FROM "Unit"`).all().map((r) => [r.id, r.partId]));
  const topics = new Map(pre.prepare(`SELECT "id", "unitId" FROM "Topic"`).all().map((r) => [r.id, r.unitId]));
  const derived = (l) => {
    const unitId = l.unitId ?? (l.topicId ? topics.get(l.topicId) : null);
    if (!unitId) return null;
    const partId = units.get(unitId);
    const courseId = partId ? parts.get(partId) : null;
    return courseId ? courses.get(courseId) ?? null : null;
  };
  const lessons = pre.prepare(`SELECT "id", "unitId", "topicId", "academicLevel" FROM "Lesson"`).all();
  let mismatch = 0;
  for (const l of lessons) if (derived(l) !== null && derived(l) !== l.academicLevel) mismatch += 1;
  ok(mismatch === 0, `D. Lesson level == chain-derived Course level for all ${lessons.length} lessons (mismatches: ${mismatch})`);
}

// F — Second Secondary official curriculum: 2/7/23, exact codes, same lesson IDs.
{
  const afterOfficial = pre.prepare(`SELECT COUNT(*) AS c FROM "Lesson" WHERE "curriculumStatus"='OFFICIAL'`).get().c;
  const afterParts = pre.prepare(`SELECT COUNT(*) AS c FROM "Part"`).get().c;
  const afterUnits = pre.prepare(`SELECT COUNT(*) AS c FROM "Unit"`).get().c;
  const afterCodes = pre
    .prepare(`SELECT "officialCode" FROM "Lesson" WHERE "officialCode" IS NOT NULL ORDER BY "officialCode"`)
    .all()
    .map((r) => r.officialCode);
  ok(afterParts === 2 && afterUnits === 7 && afterOfficial === 23, `F. curriculum still 2 Parts / 7 Units / 23 official lessons (got ${afterParts}/${afterUnits}/${afterOfficial})`);
  ok(JSON.stringify(afterCodes) === JSON.stringify(preOfficialCodes), `F. the exact ${preOfficialCodes.length} official codes are unchanged`);
}

// G — no First Secondary rows anywhere.
{
  const g = ["Course", "Student", "Lesson"]
    .map((t) => pre.prepare(`SELECT COUNT(*) AS c FROM "${t}" WHERE "academicLevel" = 'FIRST_SECONDARY'`).get().c)
    .reduce((a, b) => a + b, 0);
  ok(g === 0, "G. zero FIRST_SECONDARY rows in Course/Student/Lesson (K1 imports no First Secondary data)");
}

// H — no identity regenerated.
for (const tbl of Object.keys(preIds)) {
  ok(idSet(pre, tbl) === preIds[tbl], `H. ${tbl} id set is identical pre/post K1 (${preIds[tbl].split(",").length} ids)`);
}

// I — global officialCode uniqueness still enforced.
{
  const code = preOfficialCodes[0];
  let rejected = false;
  pre.exec("BEGIN");
  try {
    pre.prepare(`INSERT INTO "Lesson" ("id","title","titleAr","order","officialCode","status") VALUES ('k1-dup-probe','probe','probe',9999,?,'DRAFT')`).run(code);
  } catch {
    rejected = true;
  }
  pre.exec("ROLLBACK");
  ok(rejected, `I. inserting a duplicate officialCode ('${code}') is still rejected by the global unique at the K1 checkpoint`);
  ok(pre.prepare(`SELECT COUNT(*) AS c FROM "Lesson" WHERE "id"='k1-dup-probe'`).get().c === 0, "I. the probe row left no trace (rolled back)");
}

// ---------------------------------------------------------------------------
// 6. Preservation — every non-academicLevel column of every table is byte-identical
// ---------------------------------------------------------------------------

section("6. Preservation (byte-identical outside the new columns)");
{
  const after = fullSnapshot(pre, ["academicLevel"]);
  let diffs = 0;
  for (const t of Object.keys(before)) {
    if (after[t] !== before[t]) {
      diffs += 1;
      console.error(`  TABLE DRIFT: ${t}`);
    }
  }
  ok(diffs === 0, `all ${Object.keys(before).length} tables are byte-identical outside academicLevel (drifted: ${diffs})`);
  // Explicit relational checks the snapshot already covers, stated for the record.
  const grouped = pre.prepare(`SELECT COUNT(*) AS c FROM "Student" WHERE "groupId" IS NOT NULL`).get().c;
  ok(grouped > 0, "no student lost their Group (grouped students still grouped)");
  ok(pre.prepare(`SELECT COUNT(*) AS c FROM "ParentStudentLink"`).get().c > 0, "parent links preserved");
}

// ---------------------------------------------------------------------------

pre.close();
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\nverify-k1-academic-level: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
console.log("K1 VERIFICATION OK");
process.exit(0);
