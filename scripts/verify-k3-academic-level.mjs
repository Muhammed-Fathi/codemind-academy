// CodeMind Academy — Phase K3 verification (final academic-level constraints).
//
// Run: node scripts/verify-k3-academic-level.mjs
// Exit: 0 = all pass · 1 = verification failure
//
// WHAT IT PROVES (docs/MULTI_LEVEL_FINAL_CONTRACT.md, K3 checkpoint)
//   1. FULL CHAIN — the repo's own SQLite harness applies base DDL + all 21
//      migrations; K3 is the 21st; Course/Student/Lesson.academicLevel and
//      MockExam.courseId are NOT NULL; the old global Lesson_officialCode_key
//      is gone; Lesson_academicLevel_officialCode_key exists and is UNIQUE;
//      MockExam.courseId FK is ON DELETE RESTRICT and indexed.
//   2. PRODUCTION-SHAPED REHEARSAL — a scratch database is built through the
//      first 20 migrations (K2 checkpoint = K1 schema), populated with the
//      REAL scripts/seed.ts (via the repo's Prisma→SQL adapter, exactly as the
//      K1 verifier does), then topped up with rows of every data class K3
//      must preserve (quiz attempt, homework submission, payment,
//      subscription, SessionVideo, Phase H override, MockExam + question,
//      legacy Topic-chain lesson, enrollment, material, notification). The
//      whole database is snapshotted byte-for-byte, then ONLY the K3
//      migration file is applied through the same harness.
//   3. GUARDS FAIL LOUDLY — each of the seven pre-flight proofs (G1–G7) is
//      exercised on its own copy of the pre-K3 database: one offending row is
//      planted, K3 is applied, the migration must abort naming that guard,
//      the ledger must NOT record K3, and NOT ONE application row may change
//      (no silent overwrite, no partial rebuild).
//   After applying K3 to the clean rehearsal database:
//        A. the three academicLevel columns + MockExam.courseId are NOT NULL
//           and a NULL insert into each is refused by the database
//        B. every grouped Student level == Group.course.academicLevel
//        C. every Lesson level == chain-derived Course level (canonical
//           Unit chain and legacy Topic chain both present and both checked)
//        D. composite uniqueness: FIRST '1-1' beside SECOND '1-1' is ACCEPTED
//           (rolled back), a second SECOND '1-1' is REJECTED
//        E. no global officialCode uniqueness remains (no index on
//           officialCode alone; the composite is the only unique on the pair)
//        F. Second Secondary curriculum preserved exactly: 2 Parts / 7 Units /
//           23 official lessons, identical codes, identical lesson ids/order
//        G. zero FIRST_SECONDARY rows anywhere (the D probe ran inside a
//           rolled-back transaction and left nothing behind)
//        H. MockExam.courseId required, FK valid (foreign_key_check clean),
//           no orphan, RESTRICT blocks deleting an owning course, and the
//           automatic pool for a NULL course is empty (K2 fail-closed intact)
//        I. preservation — every table byte-identical pre/post (all columns,
//           all rows, all ids), FK check clean, parent links / progression /
//           payments / quiz attempts / homework / SessionVideo / overrides /
//           notifications counted and unchanged; rebuilt tables keep every
//           column (assertColumnsMatchSchema) and every index/FK.
//
// Requires Node >= 22.5 (built-in node:sqlite). Scratch databases live in the
// OS temp dir — never the real database, never seeded with production data.
// Windows-safe: every ESM path load goes through pathToFileURL(...).href.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const { applyMigrations, listMigrations, assertColumnsMatchSchema } = await import(
  pathToFileURL(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs")).href
);

const K1 = "20260923100000_k1_academic_level_capability";
const K3 = "20260923180000_k3_academic_level_constraints";
const FULL_CHAIN_LENGTH = 21;
const PRE_K3_LENGTH = 20;
const REBUILT = ["Course", "Student", "Lesson", "MockExam"];

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
const count = (db, sql, ...args) => Number(db.prepare(sql).get(...args).c);
const NOW = Date.now();

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cm-k3-verify-"));

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------
function tableNames(db) {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_prisma%' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .all()
    .map((r) => r.name);
}
function snapshotTable(db, table) {
  // Column order is not data: a rebuilt table lists its columns in schema
  // order while ALTER TABLE ADD COLUMN appended them — compare sorted.
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name).sort();
  const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM "${table}" ORDER BY ${cols.includes("id") ? '"id"' : "rowid"}`).all();
  return JSON.stringify(rows);
}
function fullSnapshot(db) {
  const snap = {};
  for (const t of tableNames(db)) snap[t] = snapshotTable(db, t);
  return snap;
}
function indexShape(db, table) {
  // Structural: (unique?, column list) for every index incl. inline
  // sqlite_autoindex_* uniques, so a rename autoindex→canonical name or a
  // whitespace difference in the DDL is not a "change".
  return db
    .prepare(`PRAGMA index_list("${table}")`)
    .all()
    .filter((i) => i.origin !== "pk")
    .map((i) => `${i.unique ? "UNIQUE" : "INDEX"}(${db.prepare(`PRAGMA index_info("${i.name}")`).all().map((c) => c.name).join(",")})`)
    .sort();
}
function fkShape(db, table) {
  return db
    .prepare(`PRAGMA foreign_key_list("${table}")`)
    .all()
    .map((r) => `${r.from}->${r.table}.${r.to} upd=${r.on_update} del=${r.on_delete}`)
    .sort();
}
function colShape(db, table) {
  // Order-insensitive; defaults normalised (0/false, 1/true, and the
  // harness base-DDL artefacts 'cuid('/'now(' which a real Prisma-created
  // database never carries — there they are no default / CURRENT_TIMESTAMP).
  const norm = (d) => {
    if (d == null || d === "'cuid('") return "-";
    if (d === "'now('") return "CURRENT_TIMESTAMP";
    if (d === "0" || d === "false") return "false";
    if (d === "1" || d === "true") return "true";
    return String(d);
  };
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((r) => `${r.name}:${r.type}:nn=${r.notnull || r.pk ? 1 : 0}:def=${norm(r.dflt_value)}:pk=${r.pk}`)
    .sort();
}
function notNull(db, table, col) {
  return Number(db.prepare(`PRAGMA table_info("${table}")`).all().find((r) => r.name === col)?.notnull) === 1;
}
function rejects(db, sql, ...args) {
  db.exec("SAVEPOINT probe");
  let msg = null;
  try {
    db.prepare(sql).run(...args);
  } catch (e) {
    msg = e.message;
  }
  db.exec("ROLLBACK TO probe");
  db.exec("RELEASE probe");
  return msg;
}

// ---------------------------------------------------------------------------
// 1. FULL CHAIN on an empty database
// ---------------------------------------------------------------------------
section("1. FULL CHAIN — base DDL + all migrations (repo harness)");
{
  const db = new DatabaseSync(path.join(WORK, "fresh.db"));
  const applied = applyMigrations(db, { withBaseSchema: true, label: "fresh " });
  ok(applied.length === FULL_CHAIN_LENGTH, `full chain applies ${FULL_CHAIN_LENGTH} migrations (got ${applied.length})`);
  ok(applied[applied.length - 1] === K3, `the last applied migration is K3 (got ${applied[applied.length - 1]})`);
  ok(listMigrations().length === FULL_CHAIN_LENGTH, `repository chain length is ${FULL_CHAIN_LENGTH}`);
  for (const [t, c] of [["Course", "academicLevel"], ["Student", "academicLevel"], ["Lesson", "academicLevel"], ["MockExam", "courseId"]]) {
    ok(notNull(db, t, c), `fresh schema: ${t}.${c} is NOT NULL`);
  }
  const idx = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='Lesson'`).all();
  ok(!idx.some((i) => i.name === "Lesson_officialCode_key"), "fresh schema: old global Lesson_officialCode_key is gone");
  const comp = idx.find((i) => i.name === "Lesson_academicLevel_officialCode_key");
  ok(!!comp && /UNIQUE INDEX/i.test(comp.sql) && /"academicLevel",\s*"officialCode"/.test(comp.sql), "fresh schema: Lesson_academicLevel_officialCode_key is UNIQUE (academicLevel, officialCode)");
  const fk = db.prepare(`PRAGMA foreign_key_list("MockExam")`).all().find((r) => r.from === "courseId");
  ok(fk?.table === "Course" && fk?.on_delete === "RESTRICT" && fk?.on_update === "CASCADE", `fresh schema: MockExam.courseId FK → Course ON DELETE RESTRICT (got ${fk?.on_delete})`);
  ok(!!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='MockExam_courseId_idx'`).get(), "fresh schema: MockExam_courseId_idx exists");
  assertColumnsMatchSchema(db, REBUILT);
  ok(true, "fresh schema: rebuilt tables carry exactly the schema.prisma column set (assertColumnsMatchSchema)");
  db.close();
}

// ---------------------------------------------------------------------------
// 2. REHEARSAL — pre-K3 database with the REAL seed + preserved-class fixtures
// ---------------------------------------------------------------------------
section("2. REHEARSAL — pre-K3 database (first 20 migrations) + real scripts/seed.ts");
const PRE_PATH = path.join(WORK, "pre.db");
{
  const pre = new DatabaseSync(PRE_PATH);
  applyMigrations(pre, { upTo: K1, withBaseSchema: true, label: "pre-K3 " });
  ok(count(pre, `SELECT COUNT(*) AS c FROM "_prisma_migrations"`) === PRE_K3_LENGTH, `pre-K3 ledger carries exactly ${PRE_K3_LENGTH} migrations`);
  ok(!notNull(pre, "Course", "academicLevel") && !notNull(pre, "MockExam", "courseId"), "pre-K3 database is genuinely nullable (K3 not applied)");
  pre.close();
}
{
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-k3-seed-"));
  const tscBin = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
  fs.writeFileSync(
    path.join(out, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2020", module: "commonjs", moduleResolution: "node", strict: false, skipLibCheck: true,
        esModuleInterop: true, resolveJsonModule: true, allowJs: false, types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")], baseUrl: REPO, paths: { "@/*": ["src/*"] },
        rootDir: REPO, outDir: out,
      },
      files: [path.join(REPO, "scripts", "seed.ts")],
    }, null, 2)
  );
  const tsc = spawnSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], { cwd: REPO, encoding: "utf8" });
  const seedOut = path.join(out, "scripts", "seed.js");
  ok(fs.existsSync(seedOut), `repo tsc compiled scripts/seed.ts${fs.existsSync(seedOut) ? "" : ` (${(tsc.stderr || "").slice(0, 300)})`}`);
  fs.writeFileSync(path.join(out, "__db-shim.js"), "module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n");
  const nextStub = path.join(out, "__next-headers-stub.js");
  fs.writeFileSync(
    nextStub,
    'const throwIfUsed = (n) => () => { throw new Error(`next/headers: ${n} is not available in offline K3 verification`); };\n' +
      'module.exports = { cookies: throwIfUsed("cookies"), headers: throwIfUsed("headers") };\n'
  );
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
let seedSettled = false;
const seedDone = new Promise((res) => {
  const orig = client.$disconnect.bind(client);
  client.$disconnect = async (...args) => { await orig(...args); if (!seedSettled) { seedSettled = true; res(); } };
});
globalThis.__CM_DB_CLIENT__ = client;
const nextStub = path.join(outDir, "__next-headers-stub.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return shim;
  if (request === "next/headers") return nextStub;
  const m = /^@\\/lib\\/([\\w-]+)$/.exec(request);
  if (m) { const compiled = path.join(outDir, "src", "lib", m[1] + ".js"); if (fs.existsSync(compiled)) return compiled; }
  if (/knowledge-model\\.json$/.test(request)) { const copied = path.join(outDir, "docs", "curriculum", "knowledge-model.json"); if (fs.existsSync(copied)) return copied; }
  const resolved = originalResolve.call(this, request, ...rest);
  if (/[/\\\\]src[/\\\\]lib[/\\\\]db\\.(ts|js)$/.test(resolved)) return shim;
  return resolved;
};
try {
  await import(pathToFileURL(path.join(outDir, "scripts", "seed.js")).href);
  await Promise.race([seedDone, new Promise((_, rej) => setTimeout(() => rej(new Error("seed did not complete within 90s")), 90000))]);
} finally { Module._resolveFilename = originalResolve; db.close(); }
process.exit(0);
`
  );
  const seedRes = spawnSync(process.execPath, [path.join(out, "run-seed.mjs"), PRE_PATH], {
    cwd: REPO,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_ENV: "development",
      NODE_PATH: path.join(REPO, "node_modules"),
      SEED_ADMIN_PASSWORD: "k3-verify-disposable-admin-password",
      SEED_DEMO_PASSWORD: "k3-verify-disposable-demo-password",
    },
  });
  ok(seedRes.status === 0, `real scripts/seed.ts populates the pre-K3 database${seedRes.status === 0 ? "" : ` (exit ${seedRes.status})`}`,
    (seedRes.stderr || seedRes.stdout || "").slice(-500));
  fs.rmSync(out, { recursive: true, force: true });
}

// Top-up fixtures: one row of every class K3 must carry across untouched,
// plus a legacy Topic-chain lesson (Lesson→Topic→Unit→Part→Course) so both
// derivation chains are exercised, plus a MockExam bound to the seeded course.
const pre = new DatabaseSync(PRE_PATH);
pre.exec("PRAGMA foreign_keys=ON");
const seededCourse = pre.prepare(`SELECT "id","academicLevel" FROM "Course" ORDER BY "createdAt" LIMIT 1`).get();
const seededStudent = pre.prepare(`SELECT "id","userId","groupId","batchId" FROM "Student" WHERE "groupId" IS NOT NULL LIMIT 1`).get();
const seededLesson = pre.prepare(`SELECT "id","unitId" FROM "Lesson" WHERE "officialCode"='1-1' AND "academicLevel"='SECOND_SECONDARY'`).get();
const seededQuiz = pre.prepare(`SELECT "id" FROM "Quiz" LIMIT 1`).get();
const seededHomework = pre.prepare(`SELECT "id" FROM "Homework" LIMIT 1`).get();
const seededPlan = pre.prepare(`SELECT "id" FROM "SubscriptionPlan" LIMIT 1`).get();
const seededQuestion = pre.prepare(`SELECT "id" FROM "Question" LIMIT 1`).get();
ok(!!seededCourse && !!seededStudent && !!seededLesson && !!seededQuiz && !!seededHomework && !!seededPlan && !!seededQuestion,
  "seed produced course / grouped student / lesson 1-1 / quiz / homework / plan / question rows to build on");
const seededBatchId = seededStudent?.batchId ?? pre.prepare(`SELECT "id" FROM "Batch" LIMIT 1`).get()?.id ?? null;
pre.exec("BEGIN");
try {
  // Legacy Topic-chain lesson (no unitId; Topic → seeded Unit)
  pre.prepare(`INSERT INTO "Topic" ("id","unitId","title","titleAr","order") VALUES ('k3-topic','${seededLesson.unitId}','Legacy topic','موضوع قديم',99)`).run();
  pre.prepare(`INSERT INTO "Lesson" ("id","topicId","unitId","officialCode","academicLevel","curriculumStatus","status","title","titleAr","order","createdAt","updatedAt")
     VALUES ('k3-legacy-lesson','k3-topic',NULL,NULL,'SECOND_SECONDARY','LEGACY','ARCHIVED','Legacy lesson','حصة قديمة',999,?,?)`).run(NOW, NOW);
  // Quiz attempt + homework submission
  pre.prepare(`INSERT INTO "QuizAttempt" ("id","quizId","studentId","score","totalMarks","percentage","passed","startedAt","finishedAt","attemptNumber","status")
     VALUES ('k3-attempt','${seededQuiz.id}','${seededStudent.id}',7,10,70,1,?,?,1,'SUBMITTED')`).run(NOW - 1000, NOW);
  pre.prepare(`INSERT INTO "HomeworkSubmission" ("id","homeworkId","studentId","content","submittedAt","status")
     VALUES ('k3-hw-sub','${seededHomework.id}','${seededStudent.id}','answer',?,'SUBMITTED')`).run(NOW);
  // Subscription + payment
  pre.prepare(`INSERT INTO "Subscription" ("id","studentId","planId","status","createdAt","updatedAt") VALUES ('k3-sub','${seededStudent.id}','${seededPlan.id}','ACTIVE',?,?)`).run(NOW, NOW);
  pre.prepare(`INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","createdAt","updatedAt","requestedGroupId","requestedPlanId")
     VALUES ('k3-payment','${seededStudent.userId}','k3-sub',250,'VODAFONE_CASH','APPROVED',?,?,'${seededStudent.groupId}','${seededPlan.id}')`).run(NOW, NOW);
  // Enrollment (needs a Track)
  const track = pre.prepare(`SELECT "id" FROM "Track" LIMIT 1`).get()?.id;
  const trackId = track ?? "k3-track";
  if (!track) pre.prepare(`INSERT INTO "Track" ("id","code","name","nameAr") VALUES ('k3-track','K3','K3 track','مسار')`).run();
  pre.prepare(`INSERT INTO "Enrollment" ("id","studentId","courseId","trackId") VALUES ('k3-enrollment','${seededStudent.id}','${seededCourse.id}','${trackId}')`).run();
  // Material + notification
  pre.prepare(`INSERT INTO "Material" ("id","lessonId","title") VALUES ('k3-material','${seededLesson.id}','Sheet')`).run();
  pre.prepare(`INSERT INTO "Notification" ("userId","type","title","message") VALUES ('${seededStudent.userId}','SYSTEM','K3','probe')`).run();
  // SessionVideo (MediaAsset → SessionVideo → seeded lesson) + Phase H override
  if (seededBatchId) {
    pre.prepare(`INSERT INTO "MediaAsset" ("id") VALUES ('k3-media')`).run();
    pre.prepare(`INSERT INTO "SessionVideo" ("id","batchId","lessonId","mediaAssetId","title","titleAr","createdAt","updatedAt")
       VALUES ('k3-video','${seededBatchId}','${seededLesson.id}','k3-media','Video','فيديو',?,?)`).run(NOW, NOW);
  }
  const adminUser = pre.prepare(`SELECT "id" FROM "User" WHERE "role"='ADMIN' LIMIT 1`).get()?.id ?? seededStudent.userId;
  pre.prepare(`INSERT INTO "ProgressionOverride" ("id","studentId","lessonId","reason","createdByUserId","createdAt")
     VALUES ('k3-override','${seededStudent.id}','${seededLesson.id}','K3 rehearsal','${adminUser}',?)`).run(NOW);
  // MockExam bound to the seeded course + one question
  pre.prepare(`INSERT INTO "MockExam" ("id","title","titleAr","schoolType","courseId","questionCount","durationMin","passMark","difficulty","selectionMode","isPublished","createdAt","updatedAt")
     VALUES ('k3-mock','Mock','تجريبي','ARABIC','${seededCourse.id}',1,30,60,'MIXED','FIXED',0,?,?)`).run(NOW, NOW);
  pre.prepare(`INSERT INTO "MockExamQuestion" ("id","mockExamId","questionId","order") VALUES ('k3-mock-q','k3-mock','${seededQuestion.id}',0)`).run();
  pre.exec("COMMIT");
  ok(true, "preserved-class fixtures inserted (legacy Topic lesson, attempt, submission, subscription, payment, enrollment, material, notification, SessionVideo, override, MockExam+question)");
} catch (e) {
  pre.exec("ROLLBACK");
  ok(false, "preserved-class fixtures inserted", e.message);
}
ok(pre.prepare("PRAGMA foreign_key_check").all().length === 0, "pre-K3 rehearsal database passes foreign_key_check");
const preCounts = {
  Part: count(pre, `SELECT COUNT(*) AS c FROM "Part"`),
  Unit: count(pre, `SELECT COUNT(*) AS c FROM "Unit"`),
  Official: count(pre, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "curriculumStatus"='OFFICIAL'`),
};
ok(preCounts.Part === 2 && preCounts.Unit === 7 && preCounts.Official === 23,
  `pre-K3 curriculum is 2 Parts / 7 Units / 23 official lessons (got ${preCounts.Part}/${preCounts.Unit}/${preCounts.Official})`);
ok(count(pre, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "unitId" IS NULL AND "topicId" IS NOT NULL`) === 1, "pre-K3 has exactly one legacy Topic-chain lesson (both derivation chains present)");
pre.close();

// Keep a pristine copy for the guard experiments (section 3) before touching PRE_PATH.
const PRISTINE = path.join(WORK, "pristine.db");
fs.copyFileSync(PRE_PATH, PRISTINE);

// ---------------------------------------------------------------------------
// 3. GUARDS — each proof aborts K3 loudly and changes nothing
// ---------------------------------------------------------------------------
section("3. GUARDS — every pre-flight proof aborts K3 without touching a row");
const GUARDS = [
  ["K3_G1_course_academicLevel_null", (db) => db.exec(`INSERT INTO "Course" ("id","slug","academicLevel","name","nameAr","description","createdAt","updatedAt") VALUES ('g1','g1',NULL,'g1','g1','g1',${NOW},${NOW})`)],
  ["K3_G2_student_academicLevel_null", (db) => {
    db.exec(`INSERT INTO "User" ("id","email","password","name","role","createdAt","updatedAt") VALUES ('g2u','g2@x','x','g2','STUDENT',${NOW},${NOW})`);
    db.exec(`INSERT INTO "Student" ("id","userId","academicLevel","createdAt","updatedAt") VALUES ('g2','g2u',NULL,${NOW},${NOW})`);
  }],
  ["K3_G3_lesson_academicLevel_null", (db) => db.exec(`INSERT INTO "Lesson" ("id","academicLevel","title","titleAr","order","createdAt","updatedAt") VALUES ('g3',NULL,'g3','g3',9001,${NOW},${NOW})`)],
  ["K3_G4_lesson_level_chain_mismatch", (db) => {
    const unitId = db.prepare(`SELECT "unitId" FROM "Lesson" WHERE "officialCode"='1-1'`).get().unitId;
    db.exec(`INSERT INTO "Lesson" ("id","unitId","academicLevel","title","titleAr","order","createdAt","updatedAt") VALUES ('g4','${unitId}','FIRST_SECONDARY','g4','g4',9002,${NOW},${NOW})`);
  }],
  ["K3_G5_grouped_student_level_mismatch", (db) => {
    const groupId = db.prepare(`SELECT "id" FROM "Group" LIMIT 1`).get().id;
    db.exec(`INSERT INTO "User" ("id","email","password","name","role","createdAt","updatedAt") VALUES ('g5u','g5@x','x','g5','STUDENT',${NOW},${NOW})`);
    db.exec(`INSERT INTO "Student" ("id","userId","academicLevel","groupId","createdAt","updatedAt") VALUES ('g5','g5u','FIRST_SECONDARY','${groupId}',${NOW},${NOW})`);
  }],
  ["K3_G6_mockexam_courseId_null", (db) => db.exec(`INSERT INTO "MockExam" ("id","title","titleAr","schoolType","courseId","createdAt","updatedAt") VALUES ('g6','g6','g6','ARABIC',NULL,${NOW},${NOW})`)],
  ["K3_G7_lesson_level_code_duplicate", (db) => {
    // A duplicate (level, code) pair cannot exist under the K1 global unique
    // either — so the guard is proven by relaxing the GLOBAL unique the way a
    // hand-edited database could: drop it, insert the dup, run K3.
    db.exec(`DROP INDEX "Lesson_officialCode_key"`);
    const unitId = db.prepare(`SELECT "unitId" FROM "Lesson" WHERE "officialCode"='1-1'`).get().unitId;
    db.exec(`INSERT INTO "Lesson" ("id","unitId","officialCode","academicLevel","title","titleAr","order","createdAt","updatedAt") VALUES ('g7','${unitId}','1-1','SECOND_SECONDARY','g7','g7',9003,${NOW},${NOW})`);
  }],
];
for (const [guard, plant] of GUARDS) {
  const file = path.join(WORK, `${guard}.db`);
  fs.copyFileSync(PRISTINE, file);
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys=ON");
  plant(db);
  const before = fullSnapshot(db);
  let err = null;
  try {
    applyMigrations(db, { label: `${guard} ` });
  } catch (e) {
    err = e.message;
  }
  const after = fullSnapshot(db);
  const drift = Object.keys(before).filter((t) => before[t] !== after[t]);
  ok(err !== null && err.includes(guard), `${guard}: K3 aborts naming the guard`, err ? err.slice(0, 160) : "applied cleanly");
  ok(count(db, `SELECT COUNT(*) AS c FROM "_prisma_migrations" WHERE "migration_name"=?`, K3) === 0, `${guard}: K3 is NOT recorded in the ledger`);
  ok(drift.length === 0, `${guard}: zero rows changed in any table (no silent repair)`, drift.join(","));
  db.close();
}

// ---------------------------------------------------------------------------
// 4. Apply K3 to the clean rehearsal database
// ---------------------------------------------------------------------------
section("4. Apply K3 migration");
const db = new DatabaseSync(PRE_PATH);
db.exec("PRAGMA foreign_keys=ON");
const before = fullSnapshot(db);
const beforeShapes = Object.fromEntries(REBUILT.map((t) => [t, { cols: colShape(db, t), fks: fkShape(db, t), idx: indexShape(db, t) }]));
const preCodes = db.prepare(`SELECT "id","officialCode","order","unitId" FROM "Lesson" WHERE "officialCode" IS NOT NULL ORDER BY "officialCode"`).all();
const appliedK3 = applyMigrations(db, { label: "K3 " });
ok(appliedK3.length === 1 && appliedK3[0] === K3, `only the K3 migration is applied at this step (got ${JSON.stringify(appliedK3)})`);
ok(
  db.prepare(`SELECT checksum FROM "_prisma_migrations" WHERE migration_name=?`).get(K3)?.checksum ===
    sha256(fs.readFileSync(path.join(REPO, "prisma", "migrations", K3, "migration.sql"), "utf8").replace(/\r\n/g, "\n")),
  "K3 ledger row carries the canonical file checksum"
);
ok(count(db, `SELECT COUNT(*) AS c FROM "_prisma_migrations"`) === FULL_CHAIN_LENGTH, `ledger now carries ${FULL_CHAIN_LENGTH} migrations`);
ok(db.prepare("PRAGMA foreign_keys").get().foreign_keys === 1, "foreign key enforcement is back ON after the rebuild");

// ---------------------------------------------------------------------------
// 5. Checks A–I
// ---------------------------------------------------------------------------
section("5. Checks A–I");

// A — nullability, enforced by the database
for (const [t, c] of [["Course", "academicLevel"], ["Student", "academicLevel"], ["Lesson", "academicLevel"], ["MockExam", "courseId"]]) {
  ok(notNull(db, t, c), `A. ${t}.${c} is NOT NULL`);
  ok(count(db, `SELECT COUNT(*) AS c FROM "${t}" WHERE "${c}" IS NULL`) === 0, `A. ${t}.${c} has zero NULL rows`);
}
ok(/NOT NULL/.test(rejects(db, `INSERT INTO "Course" ("id","slug","academicLevel","name","nameAr","description","createdAt","updatedAt") VALUES ('a1','a1',NULL,'a','a','a',?,?)`, NOW, NOW) ?? ""), "A. NULL Course.academicLevel insert is refused by the DB");
ok(/NOT NULL/.test(rejects(db, `INSERT INTO "Student" ("id","userId","academicLevel","createdAt","updatedAt") VALUES ('a2',?,NULL,?,?)`, seededStudent.userId, NOW, NOW) ?? ""), "A. NULL Student.academicLevel insert is refused by the DB");
ok(/NOT NULL/.test(rejects(db, `INSERT INTO "Lesson" ("id","academicLevel","title","titleAr","order","createdAt","updatedAt") VALUES ('a3',NULL,'a','a',9100,?,?)`, NOW, NOW) ?? ""), "A. NULL Lesson.academicLevel insert is refused by the DB");
ok(/NOT NULL/.test(rejects(db, `INSERT INTO "MockExam" ("id","title","titleAr","schoolType","courseId","createdAt","updatedAt") VALUES ('a4','a','a','ARABIC',NULL,?,?)`, NOW, NOW) ?? ""), "A. NULL MockExam.courseId insert is refused by the DB");

// B — grouped student invariant
{
  const grouped = count(db, `SELECT COUNT(*) AS c FROM "Student" WHERE "groupId" IS NOT NULL`);
  const bad = count(db, `SELECT COUNT(*) AS c FROM "Student" s JOIN "Group" g ON g."id"=s."groupId" JOIN "Course" c ON c."id"=g."courseId" WHERE s."academicLevel" IS NOT c."academicLevel"`);
  ok(grouped > 0 && bad === 0, `B. every grouped Student level == Group.course.academicLevel (${grouped} grouped, ${bad} mismatched)`);
}

// C — lesson derivation, both chains
{
  const rows = db.prepare(`SELECT l."id", l."academicLevel" AS lvl, l."unitId", l."topicId",
      (SELECT c."academicLevel" FROM "Unit" u JOIN "Part" p ON p."id"=u."partId" JOIN "Course" c ON c."id"=p."courseId" WHERE u."id"=l."unitId") AS viaUnit,
      (SELECT c."academicLevel" FROM "Topic" t JOIN "Unit" u ON u."id"=t."unitId" JOIN "Part" p ON p."id"=u."partId" JOIN "Course" c ON c."id"=p."courseId" WHERE t."id"=l."topicId") AS viaTopic
    FROM "Lesson" l`).all();
  const canonical = rows.filter((r) => r.unitId);
  const legacy = rows.filter((r) => !r.unitId && r.topicId);
  const orphans = rows.filter((r) => !r.unitId && !r.topicId);
  ok(canonical.length > 0 && canonical.every((r) => r.viaUnit === r.lvl), `C. canonical chain: ${canonical.length} lessons, level == Unit→Part→Course level`);
  ok(legacy.length === 1 && legacy.every((r) => r.viaTopic === r.lvl), `C. legacy chain: ${legacy.length} lesson, level == Topic→Unit→Part→Course level`);
  ok(orphans.length === 0, `C. no orphan lesson (${orphans.length})`);
}

// D — composite uniqueness
{
  const cross = rejects(db, `INSERT INTO "Lesson" ("id","officialCode","academicLevel","title","titleAr","order","createdAt","updatedAt") VALUES ('d1','1-1','FIRST_SECONDARY','d','d',9200,?,?)`, NOW, NOW);
  ok(cross === null, "D. FIRST_SECONDARY '1-1' beside SECOND_SECONDARY '1-1' is ACCEPTED (cross-level duplicate allowed; rolled back)", cross ?? "");
  const same = rejects(db, `INSERT INTO "Lesson" ("id","officialCode","academicLevel","title","titleAr","order","createdAt","updatedAt") VALUES ('d2','1-1','SECOND_SECONDARY','d','d',9201,?,?)`, NOW, NOW);
  ok(same !== null && /UNIQUE/.test(same) && /academicLevel/.test(same) && /officialCode/.test(same), `D. a second SECOND_SECONDARY '1-1' is REJECTED by the composite unique (${same})`);
  const nulls = rejects(db, `INSERT INTO "Lesson" ("id","officialCode","academicLevel","title","titleAr","order","createdAt","updatedAt") VALUES ('d3',NULL,'SECOND_SECONDARY','d','d',9202,?,?)`, NOW, NOW);
  ok(nulls === null, "D. NULL officialCode rows are not constrained by the composite (custom lessons keep working)");
}

// E — no global uniqueness remains
{
  const lessonIdx = db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='Lesson'`).all();
  const lists = lessonIdx.map((i) => db.prepare(`PRAGMA index_info("${i.name}")`).all().map((c) => c.name));
  const globalOnCode = lessonIdx.filter((i, k) => lists[k].length === 1 && lists[k][0] === "officialCode" && db.prepare(`PRAGMA index_list("Lesson")`).all().find((x) => x.name === i.name)?.unique === 1);
  ok(globalOnCode.length === 0, "E. no UNIQUE index on Lesson(officialCode) alone remains");
  ok(!lessonIdx.some((i) => i.name === "Lesson_officialCode_key"), "E. Lesson_officialCode_key does not exist");
  const uniques = db.prepare(`PRAGMA index_list("Lesson")`).all().filter((x) => x.unique === 1 && x.origin === "c").map((x) => x.name);
  ok(uniques.length === 1 && uniques[0] === "Lesson_academicLevel_officialCode_key", `E. the only explicit unique on Lesson is the composite (${uniques.join(",")})`);
}

// F — Second Secondary preserved exactly
{
  const p = count(db, `SELECT COUNT(*) AS c FROM "Part"`);
  const u = count(db, `SELECT COUNT(*) AS c FROM "Unit"`);
  const o = count(db, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "curriculumStatus"='OFFICIAL'`);
  ok(p === 2 && u === 7 && o === 23, `F. curriculum still 2 Parts / 7 Units / 23 official lessons (got ${p}/${u}/${o})`);
  const postCodes = db.prepare(`SELECT "id","officialCode","order","unitId" FROM "Lesson" WHERE "officialCode" IS NOT NULL ORDER BY "officialCode"`).all();
  ok(JSON.stringify(postCodes) === JSON.stringify(preCodes), `F. the ${preCodes.length} official codes, lesson ids, order and unit links are identical`);
  ok(count(db, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "officialCode" IS NOT NULL AND "academicLevel"='SECOND_SECONDARY'`) === preCodes.length, "F. every coded lesson is SECOND_SECONDARY");
}

// G — zero First Secondary rows
{
  const g = ["Course", "Student", "Lesson"].map((t) => count(db, `SELECT COUNT(*) AS c FROM "${t}" WHERE "academicLevel"='FIRST_SECONDARY'`)).reduce((a, b) => a + b, 0);
  ok(g === 0, "G. zero FIRST_SECONDARY rows in Course/Student/Lesson (the D probe was rolled back; K3 imports nothing)");
  ok(count(db, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "id" IN ('d1','d2','d3')`) === 0, "G. no probe row survived");
}

// H — MockExam.courseId required, FK valid, RESTRICT, pool fail-closed
{
  ok(count(db, `SELECT COUNT(*) AS c FROM "MockExam" m LEFT JOIN "Course" c ON c."id"=m."courseId" WHERE c."id" IS NULL`) === 0, "H. no MockExam orphan (every courseId resolves)");
  const fk = db.prepare(`PRAGMA foreign_key_list("MockExam")`).all().find((r) => r.from === "courseId");
  ok(fk?.table === "Course" && fk?.on_delete === "RESTRICT", `H. MockExam.courseId FK → Course ON DELETE RESTRICT (${fk?.on_delete})`);
  const badFk = rejects(db, `INSERT INTO "MockExam" ("id","title","titleAr","schoolType","courseId","createdAt","updatedAt") VALUES ('h1','h','h','ARABIC','no-such-course',?,?)`, NOW, NOW);
  ok(badFk !== null && /FOREIGN KEY/.test(badFk), "H. an unknown courseId is refused by the FK");
  // RESTRICT: deleting the owning course while an exam exists must fail.
  const del = rejects(db, `DELETE FROM "Course" WHERE "id"=?`, seededCourse.id);
  ok(del !== null && /FOREIGN KEY/.test(del), "H. deleting a course that still owns a MockExam is blocked (RESTRICT)");
  ok(count(db, `SELECT COUNT(*) AS c FROM "MockExamQuestion" WHERE "mockExamId"='k3-mock'`) === 1, "H. MockExamQuestion rows of the rebuilt exam survived (CASCADE child preserved)");
  ok(!!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='MockExam_courseId_idx'`).get(), "H. MockExam_courseId_idx present after rebuild");
  // Pool isolation contract (K2): the shipped helper is a pure function.
  const src = fs.readFileSync(path.join(REPO, "src", "lib", "mock-exam-pool.ts"), "utf8");
  const fn = src.slice(src.indexOf("export function mockExamLessonWhere("), src.indexOf("export async function loadMockExamLessonIds("));
  ok(/if \(courseId\)/.test(fn) && /return \{ \.\.\.LESSON_STUDENT_STATUS_FILTER, id: \{ in: \[\] \} \};/.test(fn) && !/courseId: undefined|every course/.test(fn.replace(/\/\/[^\n]*/g, "")),
    "H. mockExamLessonWhere(null) still matches NO lesson (fail-closed pool, K2 contract)");
}

// I — preservation
{
  const after = fullSnapshot(db);
  const drifted = Object.keys(before).filter((t) => before[t] !== after[t]);
  const gone = Object.keys(before).filter((t) => !(t in after));
  const added = Object.keys(after).filter((t) => !(t in before));
  ok(drifted.length === 0, `I. all ${Object.keys(before).length} tables are byte-identical pre/post K3 (drifted: ${drifted.join(",") || "none"})`);
  ok(gone.length === 0 && added.length === 0, `I. no table appeared or disappeared (gone: ${gone.join(",") || "none"}; added: ${added.join(",") || "none"})`);
  ok(db.prepare("PRAGMA foreign_key_check").all().length === 0, "I. foreign_key_check is clean after the rebuild");
  ok(db.prepare("PRAGMA integrity_check").get().integrity_check === "ok", "I. integrity_check ok");
  for (const t of REBUILT) {
    const s = beforeShapes[t];
    const cols = colShape(db, t);
    const expectCols = s.cols.map((c) =>
      (t !== "MockExam" && c.startsWith("academicLevel:")) || (t === "MockExam" && c.startsWith("courseId:")) ? c.replace(":nn=0:", ":nn=1:") : c
    );
    ok(JSON.stringify(cols) === JSON.stringify(expectCols), `I. ${t}: every column/type/default/pk preserved (only the intended NOT NULL changed)`, `${JSON.stringify(cols)} vs ${JSON.stringify(expectCols)}`);
    const fks = fkShape(db, t);
    const expectFks = t === "MockExam" ? s.fks.map((f) => f.replace("del=SET NULL", "del=RESTRICT")) : s.fks;
    ok(JSON.stringify(fks) === JSON.stringify(expectFks), `I. ${t}: foreign keys preserved${t === "MockExam" ? " (courseId SET NULL → RESTRICT is the one intended change)" : ""}`);
    const idx = indexShape(db, t);
    const expectIdx = t === "Lesson"
      ? s.idx.filter((n) => n !== "UNIQUE(officialCode)").concat("UNIQUE(academicLevel,officialCode)").sort()
      : t === "MockExam"
        ? s.idx.concat("INDEX(courseId)").sort()
        : s.idx;
    ok(JSON.stringify(idx) === JSON.stringify(expectIdx), `I. ${t}: indexes/uniques preserved structurally (${idx.length})${t === "Lesson" ? " — only UNIQUE(officialCode) → UNIQUE(academicLevel,officialCode)" : t === "MockExam" ? " + INDEX(courseId)" : ""}`, `${JSON.stringify(idx)} vs ${JSON.stringify(expectIdx)}`);
    for (const name of t === "Lesson" ? ["Lesson_academicLevel_officialCode_key"] : t === "MockExam" ? ["MockExam_courseId_idx"] : [])
      ok(!!db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`).get(name), `I. ${t}: canonical index name ${name}`);
  }
  assertColumnsMatchSchema(db, REBUILT);
  ok(true, "I. rebuilt tables match schema.prisma columns exactly (assertColumnsMatchSchema)");
  const counts = {
    ParentStudentLink: count(db, `SELECT COUNT(*) AS c FROM "ParentStudentLink"`),
    QuizAttempt: count(db, `SELECT COUNT(*) AS c FROM "QuizAttempt" WHERE "id"='k3-attempt'`),
    HomeworkSubmission: count(db, `SELECT COUNT(*) AS c FROM "HomeworkSubmission" WHERE "id"='k3-hw-sub'`),
    Payment: count(db, `SELECT COUNT(*) AS c FROM "Payment" WHERE "id"='k3-payment' AND "status"='APPROVED'`),
    Subscription: count(db, `SELECT COUNT(*) AS c FROM "Subscription" WHERE "id"='k3-sub'`),
    Enrollment: count(db, `SELECT COUNT(*) AS c FROM "Enrollment" WHERE "id"='k3-enrollment'`),
    Material: count(db, `SELECT COUNT(*) AS c FROM "Material" WHERE "id"='k3-material' AND "lessonId"=?`, seededLesson.id),
    SessionVideo: seededBatchId ? count(db, `SELECT COUNT(*) AS c FROM "SessionVideo" WHERE "id"='k3-video' AND "lessonId"=?`, seededLesson.id) : 1,
    ProgressionOverride: count(db, `SELECT COUNT(*) AS c FROM "ProgressionOverride" WHERE "id"='k3-override' AND "lessonId"=?`, seededLesson.id),
    Notification: count(db, `SELECT COUNT(*) AS c FROM "Notification"`),
    GroupedStudents: count(db, `SELECT COUNT(*) AS c FROM "Student" WHERE "groupId" IS NOT NULL`),
    Quiz: count(db, `SELECT COUNT(*) AS c FROM "Quiz" WHERE "lessonId"=?`, seededLesson.id),
    Homework: count(db, `SELECT COUNT(*) AS c FROM "Homework" WHERE "lessonId"=?`, seededLesson.id),
  };
  for (const [k, v] of Object.entries(counts)) ok(v > 0, `I. ${k} preserved and still linked (${v})`);
}

// ---------------------------------------------------------------------------
db.close();
fs.rmSync(WORK, { recursive: true, force: true });
console.log(`\nverify-k3-academic-level: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error(`  FAIL: ${f}`);
  process.exit(1);
}
console.log(`PHASE_K3_ACADEMIC_LEVEL_OK — ${pass} assertions passed`);
process.exit(0);
