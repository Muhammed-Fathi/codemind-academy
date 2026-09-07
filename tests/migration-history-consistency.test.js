// CodeMind Academy — Phase 3 correction: migration-history consistency proof.
//
// Offline (no Prisma engines, no network). Verifies, using Node >= 22.5's
// built-in node:sqlite against SCRATCH databases in the OS temp dir:
//
//   A. REPLAY — a clean database can execute the full migration history in
//      order: baseline → student identity → platform upgrade → phase 3 domain
//      → phase 3 FK reconciliation, with zero SQL errors. This is the exact
//      path that previously failed with P3006 on the shadow database.
//   B. NO-DRIFT — the resulting database description (tables, columns,
//      nullability, defaults, primary keys, UNIQUE indexes, plain indexes,
//      foreign keys incl. ON DELETE/UPDATE actions) matches prisma/schema.prisma
//      exactly, so `prisma migrate dev` finds no drift after replay.
//   C. REGRESSION — replaying the pre-correction history (without the new
//      baseline) still fails on ALTER "Student", proving the baseline is the
//      fix for P3006.
//   D. EXISTING-DB FLAVOR 1 (manual-SQL / FK-absent, as produced by
//      docs/DATABASE_MIGRATION.md §2 Option B): sentinel data is preserved
//      byte-identical by the FK reconciliation migration and the schema
//      converges to the same expected description.
//   E. EXISTING-DB FLAVOR 2 (db push / FK-present): re-running the FK
//      reconciliation on a database that already has the FKs is a harmless
//      no-op — same sentinel rows preserved, same final description.
//   F. FK ENFORCEMENT — after reconciliation, an orphaned batchId is rejected
//      with PRAGMA foreign_keys = ON.
//
// Run: node tests/migration-history-consistency.test.js
// Exit code: 0 = all pass, 1 = failure.

const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..");
const MIGRATIONS_DIR = path.join(REPO, "prisma", "migrations");
const SCHEMA_PATH = path.join(REPO, "prisma", "schema.prisma");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
};

// ---------------------------------------------------------------------------
// Migration discovery (same lexicographic order Prisma uses)
// ---------------------------------------------------------------------------
const migrationDirs = fs
  .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)
  .sort();
const migrations = migrationDirs.map((name) => ({
  name,
  sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name, "migration.sql"), "utf8"),
}));

ok(migrations[0].name.startsWith("20260901000000_baseline"), "baseline is the first migration in replay order");
ok(
  migrations.map((m) => m.name).join() ===
    [
      "20260901000000_baseline_core_schema",
      "20260904090608_add_student_identity_fields",
      "20260906120000_platform_upgrade_2026",
      "20260907100000_phase3_domain_foundation",
      "20260907130000_phase3_fk_reconciliation",
    ].join(),
  "migration chain is exactly baseline → student identity → platform upgrade → phase 3 → FK reconciliation"
);

// Record the sha256 checksums `prisma migrate` records in _prisma_migrations
console.log("\nMigration checksums (sha256, as stored by prisma migrate):");
for (const m of migrations) {
  console.log(`  ${crypto.createHash("sha256").update(m.sql, "utf8").digest("hex")}  ${m.name}`);
}
console.log("");

const newScratchDb = (label) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), `cm-hist-${label}-`)), "scratch.db");
  return new DatabaseSync(file);
};

// ---------------------------------------------------------------------------
// prisma/schema.prisma → expected database description
// ---------------------------------------------------------------------------
const TYPE_MAP = { String: "TEXT", Int: "INTEGER", Float: "REAL", Boolean: "BOOLEAN", DateTime: "DATETIME" };

function parseSchema(src) {
  const models = {};
  const enums = new Set([...src.matchAll(/enum\s+(\w+)\s*{/g)].map((m) => m[1]));
  const typeOf = (t) => (enums.has(t) ? "TEXT" : TYPE_MAP[t]);
  for (const mm of src.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)) {
    const [, name, body] = mm;
    const model = { columns: {}, fks: [], indexes: [] };
    for (const raw of body.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("//") || line.startsWith("///")) continue;
      const block = line.match(/^@@(unique|index)\(\[([\w,\s]+)\]\)/);
      if (block) {
        const cols = block[2].split(",").map((c) => c.trim());
        model.indexes.push({
          name: `${name}_${cols.join("_")}_${block[1] === "unique" ? "key" : "idx"}`,
          unique: block[1] === "unique",
          cols,
        });
        continue;
      }
      if (line.startsWith("@@")) continue;
      const fm = line.match(/^(\w+)\s+(\w+)(\?)?(\[\])?\s*(.*)$/);
      if (!fm) continue;
      const [, fname, ftype, opt, isList, attrs] = fm;
      if (isList) continue; // relation list, no SQL column
      const rm = attrs.match(/@relation\((?:"[^"]*"\s*,\s*)?fields:\s*\[(\w+)\]\s*,\s*references:\s*\[(\w+)\](?:\s*,\s*onDelete:\s*(\w+))?/);
      if (rm) {
        // object relation: the FK constraint lives on this field's model
        const onDelete = rm[3] || (opt ? "SetNull" : "Restrict");
        model.fks.push({ col: rm[1], refTable: ftype, refCol: rm[2], onDelete, onUpdate: "Cascade" });
        continue;
      }
      const columnType = typeOf(ftype);
      if (!columnType) continue; // relation back-reference without fields/references
      const col = { name: fname, type: columnType, notnull: !opt, pk: /@id\b/.test(attrs), default: null };
      const dm = attrs.match(/@default\((.+)\)/);
      if (dm) {
        let v = dm[1].trim();
        if (v === "now()") v = "CURRENT_TIMESTAMP";
        else if (v === "true" || v === "false") v = v;
        else if (/^[a-z]/.test(v)) v = null; // cuid()/autoincrement() → no SQL default
        else if (v.startsWith('"')) v = `'${v.slice(1, -1)}'`;
        else if (/^[A-Z][A-Z0-9_]*$/.test(v)) v = `'${v}'`; // enum constant → stored quoted
        col.default = v;
      }
      model.columns[fname] = col;
      if (/@unique\b/.test(attrs) && !col.pk) {
        model.indexes.push({ name: `${name}_${fname}_key`, unique: true, cols: [fname] });
      }
    }
    models[name] = model;
  }
  return models;
}

// ---------------------------------------------------------------------------
// live SQLite database → description (same shape)
// ---------------------------------------------------------------------------
function describeDb(db) {
  const tables = {};
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  for (const { name } of rows) {
    const model = { columns: {}, fks: [], indexes: [] };
    for (const c of db.prepare(`PRAGMA table_info("${name}")`).all()) {
      let dflt = c.dflt_value;
      if (dflt !== null && dflt !== undefined) {
        dflt = String(dflt).trim();
        if (/^true$/i.test(dflt) || dflt === "1") dflt = c.type === "BOOLEAN" ? "true" : dflt;
        else if (/^false$/i.test(dflt) || dflt === "0") dflt = c.type === "BOOLEAN" ? "false" : dflt;
        if (/^["'].*["']$/.test(dflt)) dflt = `'${dflt.slice(1, -1)}'`;
        if (/^CURRENT_TIMESTAMP$/i.test(dflt)) dflt = "CURRENT_TIMESTAMP";
      }
      model.columns[c.name] = { name: c.name, type: c.type.toUpperCase(), notnull: !!c.notnull || !!c.pk, pk: !!c.pk, default: dflt ?? null };
    }
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) {
      model.fks.push({
        col: fk.from,
        refTable: fk.table,
        refCol: fk.to,
        onDelete: fk.on_delete.replace(/\s+/g, ""),
        onUpdate: fk.on_update.replace(/\s+/g, ""),
      });
    }
    for (const ix of db.prepare(`PRAGMA index_list("${name}")`).all()) {
      if (ix.origin === "pk") continue;
      model.indexes.push({
        name: ix.name,
        unique: !!ix.unique,
        cols: db.prepare(`PRAGMA index_info("${ix.name}")`).all().map((c) => c.name),
      });
    }
    tables[name] = model;
  }
  return tables;
}

const actionMap = { SetNull: "SETNULL", Restrict: "RESTRICT", Cascade: "CASCADE", NoAction: "NOACTION" };

function compareDescriptions(expected, actual, tableFilter) {
  const names = Object.keys(expected);
  for (const t of names) {
    if (tableFilter && !tableFilter.includes(t)) continue;
    const e = expected[t];
    const a = actual[t];
    ok(!!a, `table ${t} exists after replay`);
    if (!a) continue;
    for (const [cn, ec] of Object.entries(e.columns)) {
      const ac = a.columns[cn];
      ok(!!ac, `${t}.${cn} exists`);
      if (!ac) continue;
      ok(ac.type === ec.type, `${t}.${cn} type ${ec.type} (got ${ac.type})`);
      ok(ac.notnull === ec.notnull, `${t}.${cn} nullability notnull=${ec.notnull} (got ${ac.notnull})`);
      ok(ac.default === ec.default, `${t}.${cn} default ${ec.default} (got ${ac.default})`);
      ok(ac.pk === ec.pk, `${t}.${cn} primary-key flag matches`);
    }
    ok(
      Object.keys(a.columns).length === Object.keys(e.columns).length,
      `${t} has exactly ${Object.keys(e.columns).length} columns (got ${Object.keys(a.columns).length}: ${Object.keys(a.columns).join(",")})`
    );
    const fkKey = (f) => `${f.col}→${f.refTable}.${f.refCol}/${actionMap[f.onDelete] || f.onDelete.toUpperCase()}/${(actionMap[f.onUpdate] || f.onUpdate.toUpperCase())}`;
    ok(
      JSON.stringify(e.fks.map(fkKey).sort()) === JSON.stringify(a.fks.map(fkKey).sort()),
      `${t} foreign keys match (expected ${JSON.stringify(e.fks.map(fkKey).sort())}, got ${JSON.stringify(a.fks.map(fkKey).sort())})`
    );
    const ixKey = (i) => `${i.name}|${i.unique ? 1 : 0}|${i.cols.join(",")}`;
    ok(
      JSON.stringify(e.indexes.map(ixKey).sort()) === JSON.stringify(a.indexes.map(ixKey).sort()),
      `${t} indexes match (expected ${JSON.stringify(e.indexes.map(ixKey).sort())},\n    got ${JSON.stringify(a.indexes.map(ixKey).sort())})`
    );
  }
}

const expected = parseSchema(fs.readFileSync(SCHEMA_PATH, "utf8"));
ok(Object.keys(expected).length === 52, `schema parser found all 52 models (got ${Object.keys(expected).length})`);

const applyAll = (db, list) => {
  for (const m of list) db.exec(m.sql);
};

// ---------------------------------------------------------------------------
// A+B. Fresh replay ≡ schema.prisma
// ---------------------------------------------------------------------------
{
  const db = newScratchDb("fresh");
  let err = null;
  try {
    applyAll(db, migrations);
  } catch (e) {
    err = e;
  }
  ok(!err, `A) clean replay applies every migration without error${err ? " — " + err.message : ""}`);
  const actual = describeDb(db);
  compareDescriptions(expected, actual);
  ok(
    db.prepare("SELECT COUNT(*) v FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().v ===
      Object.keys(expected).length,
    "B) no extra tables beyond schema.prisma"
  );
  db.close();
}

// ---------------------------------------------------------------------------
// C. Regression: pre-correction history (no baseline) still fails like P3006
// ---------------------------------------------------------------------------
{
  const db = newScratchDb("repro");
  let err = null;
  try {
    db.exec(migrations.find((m) => m.name.includes("student_identity")).sql);
  } catch (e) {
    err = e;
  }
  ok(!!err && /Student/i.test(err.message), `C) without baseline, first ALTER fails on missing Student table (P3006 reproduced: "${err && err.message}")`);
  db.close();
}

// ---------------------------------------------------------------------------
// Sentinel data shared by D & E
// ---------------------------------------------------------------------------
const REDEFINED = ["Student", "ExamAttempt", "Course", "Lesson"];
const SENTINEL_SQL = `
INSERT INTO "User" ("id","email","password","name","role","isActive","createdAt","updatedAt")
VALUES ('u-admin','admin@local','h','Admin','ADMIN',true,'2026-01-01','2026-01-01'),
       ('u-stud','s@local','h','Student One','STUDENT',true,'2026-01-01','2026-01-01');
INSERT INTO "Track" ("id","code","name","nameAr","createdAt","updatedAt") VALUES ('t1','GEN','General','عام','2026-01-01','2026-01-01');
INSERT INTO "Course" ("id","slug","name","nameAr","description","trackId","createdAt","updatedAt")
VALUES ('c1','prog-ai','Programming & AI','البرمجة والذكاء الاصطناعي','desc','t1','2026-01-01','2026-01-01');
INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","createdAt","updatedAt")
VALUES ('b1','Batch AR','دفعة','ARABIC','c1','2026-01-01','2026-01-01');
INSERT INTO "Group" ("id","name","courseId","createdAt","updatedAt") VALUES ('g1','Sat Group','c1','2026-01-01','2026-01-01');
INSERT INTO "Student" ("id","userId","grade","schoolType","studentCode","groupId","batchId","createdAt","updatedAt")
VALUES ('s1','u-stud','2nd Secondary','ARABIC','CM-000001','g1','b1','2026-01-01','2026-01-01');
INSERT INTO "Part" ("id","courseId","title","titleAr","order") VALUES ('p1','c1','Part 1','الجزء ١',1);
INSERT INTO "Unit" ("id","partId","title","titleAr","order") VALUES ('un1','p1','Unit 1','الوحدة ١',1);
INSERT INTO "Topic" ("id","unitId","title","titleAr","order") VALUES ('top1','un1','Topic 1','الموضوع ١',1);
INSERT INTO "Lesson" ("id","topicId","unitId","officialCode","title","titleAr","order","createdAt","updatedAt")
VALUES ('l1','top1','un1','lesson-1-1','Lesson 1','الدرس ١',1,'2026-01-01','2026-01-01');
INSERT INTO "MockExam" ("id","title","titleAr","schoolType","courseId","createdAt","updatedAt")
VALUES ('me1','Mock','تجريبي','ARABIC','c1','2026-01-01','2026-01-01');
INSERT INTO "ExamAttempt" ("id","studentId","mockExamId","schoolType","questionCount","durationMin","score","totalMarks","percentage","passed","answers","startedAt")
VALUES ('ea1','s1','me1','ARABIC',10,30,21,30,70,true,'[{"q":"q1"}]','2026-02-01');
INSERT INTO "Setting" ("id","key","value","updatedAt") VALUES ('set1','brand_name','CodeMind Academy','2026-01-01');
`;
// SELECT with a sorted, explicit column list: table redefinition may change
// column order; row VALUES must survive, column order is not data.
const sortedSelect = (db, t) => {
  const cols = db
    .prepare(`PRAGMA table_info("${t}")`)
    .all()
    .map((c) => c.name)
    .sort();
  return db
    .prepare(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM "${t}" ORDER BY "id"`)
    .all();
};
const snapshot = (db) =>
  JSON.stringify(Object.fromEntries(REDEFINED.concat(["Setting"]).map((t) => [t, sortedSelect(db, t)])));
const fkReconcile = migrations.find((m) => m.name === "20260907130000_phase3_fk_reconciliation");
const beforeReconcile = migrations.filter((m) => m.name !== "20260907130000_phase3_fk_reconciliation");

// ---------------------------------------------------------------------------
// D. Existing DB, flavor 1: manual-SQL (FK-absent) + data → reconcile
// ---------------------------------------------------------------------------
{
  const db = newScratchDb("prod-fk-absent");
  applyAll(db, beforeReconcile); // what the sqlite3 Option-B procedure produced
  const absent = describeDb(db);
  ok(!absent.Student.fks.some((f) => f.col === "batchId"), "D) pre-condition: manual-SQL flavor lacks Student.batchId FK");
  db.exec(SENTINEL_SQL);
  const before = snapshot(db);
  let err = null;
  try {
    db.exec(fkReconcile.sql);
  } catch (e) {
    err = e;
  }
  ok(!err, `D) FK reconciliation applies on populated DB${err ? " — " + err.message : ""}`);
  ok(snapshot(db) === before, "D) every sentinel row in redefined tables + Setting preserved byte-identical");
  ok(db.prepare("PRAGMA foreign_key_check").all().length === 0, "D) PRAGMA foreign_key_check is clean");
  const after = describeDb(db);
  ok(after.Student.fks.some((f) => f.col === "batchId" && f.refTable === "Batch" && f.onDelete === "SETNULL"),
    "D) Student.batchId → Batch(id) SET NULL FK now exists");
  compareDescriptions(expected, after);
  db.close();
}

// ---------------------------------------------------------------------------
// E. Existing DB, flavor 2: db push (FK-present) + data → reconcile is a no-op
// ---------------------------------------------------------------------------
{
  const db = newScratchDb("prod-fk-present");
  applyAll(db, migrations); // what db push produced: full schema incl. FKs
  db.exec(SENTINEL_SQL);
  const before = snapshot(db);
  let err = null;
  try {
    db.exec(fkReconcile.sql);
  } catch (e) {
    err = e;
  }
  ok(!err, `E) FK reconciliation re-applies safely when FKs already exist${err ? " — " + err.message : ""}`);
  ok(snapshot(db) === before, "E) db-push flavor data preserved byte-identical");
  ok(db.prepare("PRAGMA foreign_key_check").all().length === 0, "E) PRAGMA foreign_key_check is clean");
  compareDescriptions(expected, describeDb(db));
  db.close();
}

// ---------------------------------------------------------------------------
// F. FK enforcement after reconciliation
// ---------------------------------------------------------------------------
{
  const db = newScratchDb("enforce");
  applyAll(db, migrations);
  db.exec("PRAGMA foreign_keys = ON");
  let rejected = false;
  try {
    db.exec(`
      INSERT INTO "User" ("id","email","password","name","role","createdAt","updatedAt") VALUES ('u-x','x@local','h','X','STUDENT','2026-01-01','2026-01-01');
      INSERT INTO "Student" ("id","userId","batchId","createdAt","updatedAt") VALUES ('s-orphan','u-x','no-such-batch','2026-01-01','2026-01-01');
    `);
  } catch {
    rejected = true;
  }
  ok(rejected, "F) orphaned Student.batchId is rejected once FK is enforced");
  db.close();
}

console.log(`\nmigration-history consistency: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
