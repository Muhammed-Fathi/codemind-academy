#!/usr/bin/env node
// CodeMind Academy — Phase 13 real-database verification & migration rehearsal.
//
// WHY THIS EXISTS
//   Phase 12 established the rule: a passing mock suite does not prove a
//   migration is safe, and "0 rows lost" in an empty database proves nothing.
//   Phase 13 therefore verifies its lifecycle migration against REAL SQLite
//   rows, and this script is the tool that does it.
//
// WHAT IT DOES
//   local       apply every pending migration to the real local dev database
//               (`prisma/db/custom.db` by default) and print the lifecycle
//               inventory the phase report must contain (status distribution,
//               isPublished parity, official/legacy/archived counts).
//   rehearsal   build a SCRATCH database from the migration history EXCLUDING
//               Phase 13, populate it with representative real rows (both
//               tracks, official + legacy + archived lessons, students,
//               batches, quizzes with/without questions, homework with
//               submissions, published and unpublished session videos, media
//               assets, progress/attempt/submission rows), snapshot it, apply
//               the Phase 13 migration, and assert preservation + backfill.
//   all         both, in that order (default).
//
// HONESTY ABOUT THE ENGINE
//   The SQL is executed by this script through `node:sqlite`, statement for
//   statement, in migration order, with the same `_prisma_migrations`
//   bookkeeping (real SHA-256 checksums) that `prisma migrate deploy` writes —
//   because the Prisma schema engine cannot be DOWNLOADED in this sandbox
//   (binaries.prisma.sh is unreachable), so `prisma migrate deploy|status`
//   cannot run here. That is an environment limitation, reported as such in
//   docs/PHASE_13_SESSION_LIFECYCLE.md; it is NOT a claim that the migration
//   was applied by Prisma. Everything the migration SQL *does* to real rows —
//   ADD COLUMN semantics, defaults, the backfill UPDATE, index creation, the
//   UNIQUE key, FK integrity — is exercised for real here.
//
// It never touches a database outside the paths it is given, and `local`
// refuses to run against a database that already contains student rows unless
// `--allow-data` is passed.

import crypto from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(HERE, "..");
const MIGRATIONS_DIR = path.join(REPO, "prisma", "migrations");
const PHASE13_MIGRATION = "20260909180000_phase13_session_lifecycle";
/** The one table Phase 13 creates, so it is absent from the base schema. */
const PHASE13_MIGRATION_TABLE = "SessionPublication";
const DEFAULT_LOCAL_DB = path.join(REPO, "prisma", "db", "custom.db");
const KNOWLEDGE_MODEL = path.join(REPO, "docs", "curriculum", "knowledge-model.json");

const args = process.argv.slice(2);
const MODE = args[0] && !args[0].startsWith("--") ? args[0] : "all";
const flag = (name) => args.includes(`--${name}`);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    console.error(`  FAIL ${label}`);
  }
};
const eq = (a, b, label) =>
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`
  );
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Migration application (the same order and bookkeeping `migrate deploy` uses)
// ---------------------------------------------------------------------------

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) => fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql")))
    .sort();
}

function ensureMigrationsTable(db) {
  // Prisma's own bookkeeping table (column set of Prisma 6 on SQLite).
  db.exec(`
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
  "file_project_id" TEXT
);`);
}

function appliedMigrations(db) {
  ensureMigrationsTable(db);
  return new Set(
    db
      .prepare(
        `SELECT "migration_name" AS n FROM "_prisma_migrations"
         WHERE "finished_at" IS NOT NULL AND "rolled_back_at" IS NULL`
      )
      .all()
      .map((r) => r.n)
  );
}

/**
 * Apply migration SQL exactly as `prisma migrate deploy` does: one file at a
 * time, in name order, each inside a transaction, then recorded with the real
 * SHA-256 checksum of the file.
 */
function applyMigrations(db, { upTo = null, label = "", withBaseSchema = false } = {}) {
  if (withBaseSchema) {
    // A brand-new scratch database: lay down the pre-migration base first,
    // exactly as the historical `db push` did, then run the files.
    for (const stmt of splitStatements(baseSchemaDdl())) db.exec(stmt);
  }
  ensureMigrationsTable(db);
  const done = appliedMigrations(db);
  const applied = [];
  for (const name of listMigrations()) {
    if (upTo && name > upTo) break;
    if (done.has(name)) continue;
    const file = path.join(MIGRATIONS_DIR, name, "migration.sql");
    const sql = fs.readFileSync(file, "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    const started = Date.now();
    db.exec("BEGIN");
    try {
      // node:sqlite's exec runs the whole script; Prisma splits per statement.
      // Splitting keeps the error message attributable to one statement.
      for (const stmt of splitStatements(sql)) {
        db.exec(stmt);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${e.message}`);
    }
    db.prepare(
      `INSERT INTO "_prisma_migrations"
       ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      crypto.randomUUID(),
      checksum,
      Date.now(),
      name,
      null,
      null,
      started,
      1
    );
    applied.push(name);
  }
  if (applied.length) console.log(`  ${label}applied: ${applied.join(", ")}`);
  else console.log(`  ${label}nothing pending (all migrations already applied)`);
  return applied;
}

// ---------------------------------------------------------------------------
// The pre-migration BASE schema, derived from `prisma/schema.prisma`
// ---------------------------------------------------------------------------
//
// The repository's migration history is intentionally NOT from-empty: the
// earliest migration ALTERs tables that predate it (they were created by
// `prisma db push` before migrations existed), so a scratch database has to be
// reconstructed the way `tests/migration-sql.test.js` reconstructs its
// sim-prod schema. Doing it by hand invites drift, so it is DERIVED:
//
//   every model in prisma/schema.prisma
//     minus the columns the migrations add (BASE_SKIP_COLUMNS)
//     minus the tables the migrations themselves create (BASE_SKIP_TABLES)
//
// and the resulting DDL is then taken through the REAL migration files, in
// order. `assertMatchesPrismaSchema` below proves the end state has exactly the
// columns the schema declares — so if this derivation were wrong in any table,
// the rehearsal would fail instead of quietly verifying nothing.
//
// Indexes are deliberately NOT created from the model `@@index` lines: the
// migration chain creates them itself (with Prisma's exact names), and unique
// columns are emitted as inline `UNIQUE` so SQLite auto-names them. Emitting
// named indexes here would collide with the migrations' own `CREATE INDEX`.

/** Columns that did not exist before the first migration. */
const BASE_SKIP_COLUMNS = {
  User: ["status"],
  Student: ["nationalId", "parentPhone", "schoolType", "studentCode", "batchId"],
  Course: ["trackId"],
  Lesson: ["unitId", "officialCode", "curriculumStatus", "trackScope", "status"],
  LessonProgress: [
    "videoDurationSec",
    "videoWatchedSec",
    "videoPercent",
    "videoCompleted",
    "videoCompletedAt",
    "lastHeartbeatAt",
  ],
  Question: ["schoolType"],
  QuizAttempt: ["cameraStatus"],
  ExamAttempt: ["schoolType", "mockExamId"],
  ExamQuestion: ["schoolType"],
  Quiz: ["trackScope"],
  Homework: ["trackScope"],
};

/** Tables created by a migration, so absent from the base. */
const BASE_SKIP_TABLES = new Set([
  "Batch",
  "MediaAsset",
  "SessionVideo",
  "SessionVideoView",
  "MockExam",
  "MockExamQuestion",
  "UserSession",
  "PasswordResetToken",
  "SecurityRateLimit",
  "SecurityEvent",
  "QuizAttemptEvidence",
  "Track",
  "Enrollment",
  "Material",
  PHASE13_MIGRATION_TABLE,
]);

const PRISMA_TO_SQLITE = {
  String: "TEXT",
  Int: "INTEGER",
  BigInt: "INTEGER",
  Float: "REAL",
  Boolean: "BOOLEAN",
  DateTime: "DATETIME",
  Json: "TEXT",
  Bytes: "BLOB",
};

/** Parse the scalar fields of every model in prisma/schema.prisma. */
function parsePrismaModels(schemaPath = path.join(REPO, "prisma/schema.prisma")) {
  const text = fs.readFileSync(schemaPath, "utf8");
  const models = new Map();
  const enumNames = new Set(
    [...text.matchAll(/^enum\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1])
  );
  const blocks = [...text.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\}/gm)];
  // Model names up front: a to-one BACK-relation (`publication
  // SessionPublication?`) carries no `@relation`, so "is the type a model" is
  // the only reliable way to tell it apart from a scalar column.
  const modelNames = new Set(blocks.map((b) => b[1]));
  for (const [, modelName, body] of blocks) {
    const fields = [];
    for (const rawLine of body.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("//") || line.startsWith("///")) continue;
      if (/^@@/.test(line)) {
        if (/^@@unique\(/.test(line)) {
          const cols = line
            .replace(/^@@unique\(\[/, "")
            .replace(/\]\).*$/, "")
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean);
          fields.push({ uniqueGroup: cols });
        }
        continue;
      }
      const m = /^(\w+)\s+([\w.]+)(\[\])?(\?)?\s*(.*)$/.exec(line);
      if (!m) continue;
      const [, name, type, list, optional, rest] = m;
      if (list) continue; // a relation to-many field: no column
      const isModel = modelNames.has(type) || /@relation/.test(rest);
      const isEnum = enumNames.has(type);
      if (!isEnum && !PRISMA_TO_SQLITE[type] && isModel) continue; // relation
      const col = { name, type, optional: !!optional, default: null };
      const def = /@default\(([^)]*)\)/.exec(rest);
      if (def) col.default = def[1].trim();
      if (/@id\b/.test(rest)) col.isId = true;
      if (/@unique\b/.test(rest)) col.unique = true;
      if (/@updatedAt\b/.test(rest)) col.updatedAt = true;
      fields.push(col);
    }
    models.set(modelName, fields);
  }
  return { models, enumNames };
}

function sqliteTypeOf(field, enumNames) {
  if (PRISMA_TO_SQLITE[field.type]) return PRISMA_TO_SQLITE[field.type];
  if (enumNames.has(field.type)) return "TEXT"; // Prisma maps enums to TEXT
  return "TEXT";
}

function sqlDefault(value, enumNames) {
  if (value === null || value === undefined) return null;
  if (value === "now()") return "CURRENT_TIMESTAMP";
  if (value === "true") return "1";
  if (value === "false") return "0";
  if (/^\d+$/.test(value)) return value;
  if (/^-?\d+\.\d+$/.test(value)) return value;
  const bare = value.replace(/^"|"$/g, "");
  if (enumNames.has(value) || /^[A-Z][A-Z0-9_]*$/.test(bare)) return `'${bare}'`;
  return `'${bare}'`;
}

function baseSchemaDdl() {
  const { models, enumNames } = parsePrismaModels();
  const statements = [];
  for (const [name, fields] of models) {
    if (BASE_SKIP_TABLES.has(name)) continue;
    const skip = new Set(BASE_SKIP_COLUMNS[name] || []);
    const cols = [];
    const idCols = fields.filter((f) => f.isId && !skip.has(f.name)).map((f) => f.name);
    for (const f of fields) {
      if (f.uniqueGroup || skip.has(f.name)) continue;
      let decl = `"${f.name}" ${sqliteTypeOf(f, enumNames)}`;
      if (!f.optional && !f.isId) decl += " NOT NULL";
      const dflt = sqlDefault(f.default, enumNames);
      if (dflt !== null) decl += ` DEFAULT ${dflt}`;
      if (!f.optional && dflt === null && !f.isId) {
        // `updatedAt` with no default: Prisma fills it client-side, so the
        // column is NOT NULL and every INSERT below supplies it.
        decl += "";
      }
      if (f.unique && idCols.length <= 1) decl += " UNIQUE";
      cols.push(decl);
    }
    if (idCols.length) cols.push(`PRIMARY KEY (${idCols.map((c) => `"${c}"`).join(", ")})`);
    for (const f of fields) {
      if (f.uniqueGroup && !f.uniqueGroup.some((c) => skip.has(c))) {
        cols.push(`UNIQUE (${f.uniqueGroup.map((c) => `"${c}"`).join(", ")})`);
      }
    }
    statements.push(`CREATE TABLE "${name}" (\n  ${cols.join(",\n  ")}\n);`);
  }
  return statements.join("\n");
}

/**
 * The rehearsal's strongest check: the database produced by
 * `base DDL + every real migration file` must expose EXACTLY the columns
 * `prisma/schema.prisma` declares for the tables the lifecycle touches. A
 * hand-written fixture that drifted from the schema would make every other
 * assertion vacuous, so drift is a hard failure.
 */
const LIFECYCLE_TABLES = [
  "User",
  "Student",
  "Course",
  "Part",
  "Unit",
  "Topic",
  "Lesson",
  "Group",
  "Quiz",
  "Question",
  "QuizAnswer",
  "QuizAttempt",
  "Homework",
  "HomeworkSubmission",
  "LessonProgress",
  "Batch",
  "MediaAsset",
  "SessionVideo",
  "SessionVideoView",
  "Material",
  "SessionPublication",
];

function assertMatchesPrismaSchema(db) {
  const { models } = parsePrismaModels();
  for (const table of LIFECYCLE_TABLES) {
    const fields = models.get(table);
    if (!fields) {
      ok(false, `schema declares model ${table}`);
      continue;
    }
    const expected = new Set(
      fields
        .filter((f) => !f.uniqueGroup && !/\[\]/.test(f.type))
        .map((f) => f.name)
    );
    const actual = new Set(
      db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name)
    );
    const missing = [...expected].filter((c) => !actual.has(c));
    const extra = [...actual].filter((c) => !expected.has(c));
    eq(
      { missing, extra },
      { missing: [], extra: [] },
      `${table}: columns match prisma/schema.prisma exactly`
    );
  }
}


/** Split on `;` while respecting string literals and comments. */
function splitStatements(sql) {
  const out = [];
  let cur = "";
  let inStr = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const n = sql[i + 1];
    if (inLineComment) {
      cur += c;
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      cur += c;
      if (c === "*" && n === "/") {
        cur += n;
        i++;
        inBlockComment = false;
      }
      continue;
    }
    if (inStr) {
      cur += c;
      if (c === "'") {
        if (n === "'") {
          cur += n;
          i++;
        } else inStr = false;
      }
      continue;
    }
    if (c === "-" && n === "-") {
      inLineComment = true;
      cur += c;
      continue;
    }
    if (c === "/" && n === "*") {
      inBlockComment = true;
      cur += c;
      continue;
    }
    if (c === "'") {
      inStr = true;
      cur += c;
      continue;
    }
    if (c === ";") {
      if (cur.trim()) out.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Representative data (the rehearsal's "real rows")
// ---------------------------------------------------------------------------

const now = () => Date.now();
const daysAgo = (d) => now() - d * 86400000;

function officialLessonsFromModel() {
  const model = JSON.parse(fs.readFileSync(KNOWLEDGE_MODEL, "utf8"));
  const rows = [];
  for (const part of model.parts) {
    for (const unit of part.units) {
      for (const lesson of unit.lessons) {
        rows.push({
          code: lesson.code,
          order: Number.isInteger(lesson.order) ? lesson.order : 0,
          title: lesson.title,
          titleAr: lesson.titleAr,
          partOrder: part.order,
          unitOrder: unit.order,
          partCode: part.code,
          unitCode: unit.code,
        });
      }
    }
  }
  return rows;
}

/**
 * Populate a PRE-Phase-13 database (schema of every migration except the
 * lifecycle one) with deliberately awkward, representative data:
 *
 *   - the full official curriculum (2 parts / 7 units / 23 lessons)
 *   - 3 legacy lessons of which one is ARCHIVED, and one orphan (no chain)
 *   - a mix of isPublished true/false so the backfill has BOTH branches
 *   - the seeded legacy placeholder `pdfUrl = "#"`, real-looking videoUrls,
 *     NULLs, and an `isLocked = true` row that must STAY irrelevant
 *   - two students (ARABIC + LANGUAGE), one with a legacy free-text
 *     schoolType that Phase 12 already normalised away
 *   - published and UNPUBLISHED session videos, media assets, quizzes with
 *     and without questions, homework with a graded submission, progress rows
 *
 * Ids are hand-made and stable so the rehearsal can prove they survive.
 */
function populate(db, { lessons }) {
  const courseId = "course-cm-2026";
  const dbRun = (sql, ...p) => db.prepare(sql).run(...p);

  dbRun(
    `INSERT INTO "Course" ("id","slug","name","nameAr","description","iconUrl","color","createdAt","updatedAt","trackId")
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    courseId,
    "programming-ai-2nd-sec",
    "Programming & AI",
    "البرمجة والذكاء الاصطناعي",
    "The official CodeMind curriculum",
    null,
    "#10b981",
    daysAgo(400),
    daysAgo(10),
    null
  );

  const partCodes = [...new Set(lessons.map((l) => l.partCode))];
  const partIds = new Map();
  partCodes.forEach((code, i) => {
    const id = `part-${code}`;
    partIds.set(code, id);
    dbRun(
      `INSERT INTO "Part" ("id","courseId","title","titleAr","order","description")
       VALUES (?,?,?,?,?,?)`,
      id,
      courseId,
      `Part ${code}`,
      `الجزء ${code}`,
      i + 1,
      null
    );
  });

  const unitCodes = [...new Set(lessons.map((l) => `${l.partCode}:${l.unitCode}`))];
  const unitIds = new Map();
  unitCodes.forEach((key, i) => {
    const [partCode, unitCode] = key.split(":");
    const id = `unit-${unitCode}`;
    unitIds.set(key, id);
    dbRun(
      `INSERT INTO "Unit" ("id","partId","title","titleAr","order","icon")
       VALUES (?,?,?,?,?,?)`,
      id,
      partIds.get(partCode),
      `Unit ${unitCode}`,
      `الوحدة ${unitCode}`,
      i + 1,
      null
    );
  });

  const lessonId = (code) => `lesson-${code}`;
  // Lifecycle-relevant variety: the last 5 official lessons are staged
  // (isPublished 0) and the rest are live, so the backfill must produce a
  // non-trivial split rather than one uniform value.
  lessons.forEach((l, i) => {
    const staged = i >= lessons.length - 5;
    dbRun(
      `INSERT INTO "Lesson"
        ("id","topicId","unitId","officialCode","curriculumStatus","title","titleAr","order",
         "description","summary","duration","isLocked","isPublished","videoUrl","pdfUrl",
         "createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      lessonId(l.code),
      null,
      unitIds.get(`${l.partCode}:${l.unitCode}`),
      l.code,
      "OFFICIAL",
      l.title,
      l.titleAr,
      l.order,
      `Official description for ${l.code}`,
      null,
      90,
      0,
      staged ? 0 : 1,
      i % 3 === 0 ? null : `https://cdn.example.test/video/${l.code}.mp4`,
      // the seeded legacy placeholder — deliberately NOT a usable document
      i % 4 === 0 ? "#" : null,
      daysAgo(200 - i),
      daysAgo(20)
    );
  });

  // Legacy lessons: one live, one published-but-locked flag, one archived, one
  // orphaned (attached to no unit and no topic).
  const legacy = [
    { id: "legacy-live", status: "LEGACY", published: 1, locked: 0, unit: null, topic: null },
    { id: "legacy-locked", status: "LEGACY", published: 1, locked: 1, unit: null, topic: null },
    { id: "legacy-archived", status: "ARCHIVED", published: 1, locked: 0, unit: null, topic: null },
    { id: "legacy-orphan", status: "LEGACY", published: 0, locked: 0, unit: null, topic: null },
  ];
  // A legacy topic-chain lesson (the pre-Phase-4 shape) plus its Topic row.
  dbRun(
    `INSERT INTO "Topic" ("id","unitId","title","titleAr","order") VALUES (?,?,?,?,?)`,
    "topic-legacy-1",
    unitIds.get("1:1.1") ?? [...unitIds.values()][0],
    "Legacy topic",
    "موضوع قديم",
    1
  );
  legacy.forEach((l, i) => {
    dbRun(
      `INSERT INTO "Lesson"
        ("id","topicId","unitId","officialCode","curriculumStatus","title","titleAr","order",
         "description","summary","duration","isLocked","isPublished","videoUrl","pdfUrl",
         "createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      l.id,
      i === 0 ? "topic-legacy-1" : null,
      null,
      null,
      l.status,
      `Legacy ${l.id}`,
      `درس قديم ${i + 1}`,
      i + 1,
      null,
      null,
      90,
      l.locked,
      l.published,
      null,
      "#",
      daysAgo(300 - i),
      daysAgo(30)
    );
  });

  // Batches (one per school type), groups, students.
  for (const [id, schoolType] of [
    ["batch-ar", "ARABIC"],
    ["batch-lang", "LANGUAGE"],
  ]) {
    dbRun(
      `INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?)`,
      id,
      `Batch ${schoolType}`,
      `دفعة ${schoolType}`,
      schoolType,
      courseId,
      1,
      daysAgo(100),
      daysAgo(100)
    );
  }
  dbRun(
    `INSERT INTO "Group" ("id","name","courseId","teacherId","capacity","schedule","isActive","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?)`,
    "group-1",
    "Group A",
    courseId,
    null,
    20,
    "Sat & Tue, 6:00 PM",
    1,
    daysAgo(100),
    daysAgo(100)
  );

  const students = [
    ["stu-ar", "ar@t.test", "Ali", "ARABIC", "batch-ar"],
    ["stu-lang", "lang@t.test", "Omar", "LANGUAGE", "batch-lang"],
    ["stu-none", "none@t.test", "Ziad", null, null],
  ];
  for (const [id, email, name, schoolType, batchId] of students) {
    dbRun(
      `INSERT INTO "User" ("id","email","password","name","phone","role","avatarUrl","isActive","status","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      `user-${id}`,
      email,
      "not-a-real-hash",
      name,
      null,
      "STUDENT",
      null,
      1,
      "ACTIVE",
      daysAgo(90),
      daysAgo(1)
    );
    dbRun(
      `INSERT INTO "Student"
        ("id","userId","grade","schoolName","schoolType","nationalId","parentPhone","studentCode",
         "groupId","batchId","enrolledAt","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      `user-${id}`,
      "2nd Secondary",
      null,
      schoolType,
      null,
      null,
      null,
      "group-1",
      batchId,
      daysAgo(90),
      daysAgo(90),
      daysAgo(2)
    );
  }

  // Quizzes: one full, one EMPTY (0 questions), one on an ARABIC-only lesson.
  const firstOfficial = lessons[0].code;
  const secondOfficial = lessons[1].code;
  const lastOfficial = lessons[lessons.length - 1].code;
  dbRun(
    `INSERT INTO "Quiz" ("id","lessonId","title","titleAr","description","passMark","timeLimit","order")
     VALUES (?,?,?,?,?,?,?,?)`,
    "quiz-full",
    lessonId(firstOfficial),
    "Session quiz",
    "اختبار الجلسة",
    null,
    60,
    20,
    0
  );
  for (const q of ["q1", "q2", "q3"]) {
    dbRun(
      `INSERT INTO "Question"
        ("id","quizId","type","prompt","promptAr","options","answer","explanation","difficulty","marks","schoolType","createdAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      q,
      "quiz-full",
      "MCQ",
      `Question ${q}`,
      `سؤال ${q}`,
      '["a","b"]',
      "a",
      null,
      "EASY",
      1,
      null,
      daysAgo(50)
    );
  }
  dbRun(
    `INSERT INTO "Quiz" ("id","lessonId","title","titleAr","description","passMark","timeLimit","order")
     VALUES (?,?,?,?,?,?,?,?)`,
    "quiz-empty",
    lessonId(secondOfficial),
    "Empty quiz",
    "اختبار فارغ",
    null,
    60,
    null,
    0
  );
  dbRun(
    `INSERT INTO "Quiz" ("id","lessonId","title","titleAr","description","passMark","timeLimit","order","trackScope")
     VALUES (?,?,?,?,?,?,?,?,?)`,
    "quiz-lang-on-shared",
    lessonId(firstOfficial),
    "Language-only quiz",
    "اختبار لغات",
    null,
    60,
    null,
    1,
    "LANGUAGE"
  );

  dbRun(
    `INSERT INTO "QuizAttempt" ("id","quizId","studentId","score","totalMarks","percentage","passed","startedAt","finishedAt","cameraStatus")
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    "attempt-1",
    "quiz-full",
    "stu-ar",
    3,
    3,
    100,
    1,
    daysAgo(5),
    daysAgo(5),
    "NOT_REQUESTED"
  );
  dbRun(
    `INSERT INTO "QuizAnswer" ("id","attemptId","questionId","selected","isCorrect")
     VALUES (?,?,?,?,?)`,
    "answer-1",
    "attempt-1",
    "q1",
    "a",
    1
  );

  dbRun(
    `INSERT INTO "Homework" ("id","lessonId","title","titleAr","instructions","deadline","maxMarks","createdAt","trackScope")
     VALUES (?,?,?,?,?,?,?,?,?)`,
    "hw-1",
    lessonId(firstOfficial),
    "Assignment",
    "واجب",
    "Build the thing",
    daysAgo(-7),
    10,
    daysAgo(20),
    "SHARED"
  );
  dbRun(
    `INSERT INTO "HomeworkSubmission" ("id","homeworkId","studentId","content","fileUrl","submittedAt","grade","feedback","status")
     VALUES (?,?,?,?,?,?,?,?,?)`,
    "sub-1",
    "hw-1",
    "stu-ar",
    "my work",
    null,
    daysAgo(3),
    9,
    "nice",
    "GRADED"
  );

  dbRun(
    `INSERT INTO "LessonProgress"
      ("id","studentId","lessonId","progress","isCompleted","lastViewedAt","videoDurationSec","videoWatchedSec","videoPercent","videoCompleted","videoCompletedAt","lastHeartbeatAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    "lp-1",
    "stu-ar",
    lessonId(firstOfficial),
    100,
    1,
    daysAgo(3),
    600,
    600,
    100,
    1,
    daysAgo(3),
    daysAgo(3)
  );

  // Media + session videos: one published ARABIC video, one published LANGUAGE
  // video sharing the SAME asset, one UNPUBLISHED video.
  dbRun(
    `INSERT INTO "MediaAsset"
      ("id","kind","storage","storageKey","externalUrl","mimeType","sizeBytes","durationSec","originalName","isPrivate","createdById","createdAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    "media-1",
    "VIDEO",
    "LOCAL_PRIVATE",
    "private/videos/v1.mp4",
    null,
    "video/mp4",
    1024,
    600,
    "v1.mp4",
    1,
    null,
    daysAgo(15)
  );
  dbRun(
    `INSERT INTO "MediaAsset"
      ("id","kind","storage","storageKey","externalUrl","mimeType","sizeBytes","durationSec","originalName","isPrivate","createdById","createdAt")
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    "media-2",
    "VIDEO",
    "EXTERNAL_URL",
    null,
    "https://cdn.example.test/v2.mp4",
    "video/mp4",
    null,
    590,
    "v2.mp4",
    0,
    null,
    daysAgo(14)
  );
  const videoRows = [
    ["vid-ar", "batch-ar", lessonId(firstOfficial), "media-1", 1],
    ["vid-lang", "batch-lang", lessonId(firstOfficial), "media-1", 1],
    ["vid-draft", "batch-ar", lessonId(lastOfficial), "media-2", 0],
  ];
  for (const [id, batchId, lessonRef, mediaId, published] of videoRows) {
    dbRun(
      `INSERT INTO "SessionVideo"
        ("id","batchId","lessonId","mediaAssetId","title","titleAr","description","requiredPercent","isPublished","publishedAt","createdAt","updatedAt")
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      batchId,
      lessonRef,
      mediaId,
      `Video ${id}`,
      `فيديو ${id}`,
      null,
      95,
      published,
      published ? daysAgo(6) : null,
      daysAgo(9),
      daysAgo(6)
    );
  }
  dbRun(
    `INSERT INTO "SessionVideoView" ("id","sessionVideoId","studentId","watchedSec","durationSec","percent","isCompleted","completedAt","lastHeartbeatAt")
     VALUES (?,?,?,?,?,?,?,?,?)`,
    "view-1",
    "vid-ar",
    "stu-ar",
    600,
    600,
    100,
    1,
    daysAgo(6),
    daysAgo(6)
  );

  return {
    courseId,
    officialIds: lessons.map((l) => lessonId(l.code)),
    firstOfficial,
    lastOfficial,
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

/** Count-style helper: every query passed to it aliases its scalar as `c`. */
const one = (db, sql, ...p) => db.prepare(sql).get(...p)?.c ?? null;
/** Raw first row of an arbitrary query (no `c` alias assumed). */
const row0 = (db, sql, ...p) => db.prepare(sql).get(...p) ?? null;

function assertStatusBackfill(db, label, isPublishedValue = "isPublished") {
  const bad = one(
    db,
    `SELECT COUNT(*) AS c FROM "Lesson"
     WHERE ("status" = 'PUBLISHED') <> (CASE WHEN COALESCE(CAST(${isPublishedValue} AS INTEGER),0) = 1 THEN 1 ELSE 0 END)`
  );
  ok(bad === 0, `${label}: every row's status matches its published mirror (${bad} mismatches)`);
  const illegal = one(
    db,
    `SELECT COUNT(*) AS c FROM "Lesson" WHERE "status" NOT IN ('DRAFT','READY','PUBLISHED')`
  );
  ok(illegal === 0, `${label}: no out-of-enum status value (${illegal})`);
}

function inventory(db) {
  // Tolerant of a database that predates Phase 13 (no `status` column yet) —
  // `runLocal` reads it BEFORE applying the pending migrations.
  const hasStatus =
    hasColumn(db, "Lesson", "status") && hasTable(db, "Lesson");
  const rows = hasStatus
    ? db
        .prepare(
          `SELECT "status", COUNT(*) AS n FROM "Lesson" GROUP BY "status" ORDER BY "status"`
        )
        .all()
    : [];
  const colOne = (table, col, cond, params = []) =>
    hasTable(db, table) && hasColumn(db, table, col)
      ? one(db, `SELECT COUNT(*) AS c FROM "${table}" WHERE ${cond}`, ...params)
      : null;
  const counts = {
    totalLessons: hasTable(db, "Lesson") ? one(db, `SELECT COUNT(*) AS c FROM "Lesson"`) : 0,
    byStatus: Object.fromEntries(rows.map((r) => [r.status, r.n])),
    publishedMirrorTrue: colOne(
      "Lesson",
      "isPublished",
      `"isPublished" IS NOT NULL AND COALESCE(CAST("isPublished" AS INTEGER),0)=1`
    ),
    official: colOne("Lesson", "curriculumStatus", `"curriculumStatus"='OFFICIAL'`),
    legacy: colOne("Lesson", "curriculumStatus", `"curriculumStatus"='LEGACY'`),
    archived: colOne("Lesson", "curriculumStatus", `"curriculumStatus"='ARCHIVED'`),
    duplicateCodes: hasColumn(db, "Lesson", "officialCode")
      ? one(
          db,
          `SELECT COUNT(*) AS c FROM (SELECT "officialCode" FROM "Lesson" WHERE "officialCode" IS NOT NULL GROUP BY "officialCode" HAVING COUNT(*) > 1)`
        )
      : null,
    parts: hasTable(db, "Part") ? one(db, `SELECT COUNT(*) AS c FROM "Part"`) : null,
    units: hasTable(db, "Unit") ? one(db, `SELECT COUNT(*) AS c FROM "Unit"`) : null,
    publications: hasTable(db, "SessionPublication")
      ? one(db, `SELECT COUNT(*) AS c FROM "SessionPublication"`)
      : null,
  };
  return counts;
}

function tableCounts(db) {
  const tables = [
    "Course",
    "Part",
    "Unit",
    "Topic",
    "Lesson",
    "Group",
    "Student",
    "User",
    "Batch",
    "Quiz",
    "Question",
    "QuizAttempt",
    "QuizAnswer",
    "Homework",
    "HomeworkSubmission",
    "LessonProgress",
    "SessionVideo",
    "SessionVideoView",
    "MediaAsset",
    "Material",
  ];
  const out = {};
  for (const t of tables) {
    const exists = one(
      db,
      `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`,
      t
    );
    out[t] = exists ? one(db, `SELECT COUNT(*) AS c FROM "${t}"`) : null;
  }
  return out;
}

function hasTable(db, table) {
  return !!one(db, `SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name=?`, table);
}

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .some((r) => r.name === column);
}

function indexNames(db, table) {
  return db
    .prepare(`SELECT name FROM pragma_index_list(?)`)
    .all(table)
    .map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

async function runLocal() {
  section("LOCAL DATABASE — apply pending migrations");
  const dbPath = opt("db", process.env.CM_VERIFY_DB || DEFAULT_LOCAL_DB);
  const fresh = !fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0;
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON;");
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
    .all()
    .map((r) => r.name);
  if (fresh && tables.length === 0) {
    // A fresh local dev database has no migration baseline of its own: the
    // history starts from a `db push`ed schema (see the base-schema note
    // above), so it is laid down here first.
    console.log(`  creating ${dbPath} from the pre-migration base schema`);
    for (const stmt of splitStatements(baseSchemaDdl())) db.exec(stmt);
  }
  const before = inventory(db);
  if (
    (before.totalLessons ?? 0) > 0 &&
    one(db, `SELECT COUNT(*) AS c FROM "Student"`) > 0 &&
    !flag("allow-data")
  ) {
    console.error(
      "  refusing to touch a populated database without --allow-data"
    );
    process.exitCode = 2;
    return null;
  }
  applyMigrations(db, { label: "local " });

  // Populate the real local database with the REAL Phase 11 reconciler. This is
  // the only supported way to get curriculum into the database in this sandbox:
  // `npx prisma db seed` / `npm run db:seed` cannot run because the Prisma
  // engine binary cannot be downloaded, and `scripts/reconcile-curriculum.ts` is
  // the script that both `db:seed` and `npm run curriculum:reconcile` use.
  section("LOCAL DATABASE — reconcile the official curriculum (real script logic)");
  const officialBefore = one(
    db,
    `SELECT COUNT(*) AS c FROM "Lesson" WHERE "curriculumStatus"='OFFICIAL'`
  );
  const { createSqlitePrisma } = require(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));
  const localClient = createSqlitePrisma({ db, schemaPath: path.join(REPO, "prisma/schema.prisma") });
  globalThis.__CM_DB_CLIENT__ = localClient;
  const compiled = compileRealCode();
  const localCode = loadRealCode(compiled.out);
  let reconcileReport = null;
  let reconcileError = null;
  try {
    reconcileReport = await localCode.reconciler.reconcileOfficialCurriculum(localClient);
    await localCode.reconciler.reconcileOfficialCurriculum(localClient);
  } catch (e) {
    reconcileError = e;
  }
  ok(
    !reconcileError,
    `reconcileOfficialCurriculum ran against ${path.relative(REPO, dbPath)}${
      reconcileError ? ` (${reconcileError.message})` : ""
    }`
  );
  eq(reconcileReport?.officialLessonCodes?.length, 23, "the real local database has 23 official lessons");
  eq(
    row0(db, `SELECT "status", COUNT(*) AS n FROM "Lesson" WHERE "curriculumStatus"='OFFICIAL' GROUP BY "status" HAVING "status"<>'DRAFT'`)?.n ??
      0,
    0,
    "reconciled rows are DRAFT locally — nothing was auto-published"
  );
  console.log(
    `  reconciler report: created=${reconcileReport?.lessonsCreated} updated=${reconcileReport?.lessonsUpdated} asDraft=${reconcileReport?.lessonsCreatedAsDraft} published=${reconcileReport?.lessonsPublished} awaitingOpen=${reconcileReport?.lessonsAwaitingOpen} (officialBefore=${officialBefore})`
  );
  localCode.restore();
  fs.rmSync(compiled.out, { recursive: true, force: true });

  const inv = inventory(db);
  assertMatchesPrismaSchema(db);
  section("LOCAL DATABASE — lifecycle inventory");
  console.log("  " + JSON.stringify(inv, null, 2).replace(/\n/g, "\n  "));
  if (hasColumn(db, "Lesson", "status")) assertStatusBackfill(db, "local");
  db.close();
  return inv;
}

function runRehearsal() {
  let dupError = null;
  section("REHEARSAL — real rows through the Phase 13 migration");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase13-"));
  const prePath = path.join(dir, "pre.db");
  const postPath = path.join(dir, "post.db");

  // 1. Build the PRE-migration database: every migration except Phase 13.
  const pre = new DatabaseSync(prePath);
  pre.exec("PRAGMA foreign_keys=ON;");
  const sorted = listMigrations();
  const lastBefore = sorted.filter((n) => n < PHASE13_MIGRATION).pop();
  applyMigrations(pre, { upTo: lastBefore, label: "pre-13 ", withBaseSchema: true });
  const lessons = officialLessonsFromModel();
  ok(lessons.length === 23, `knowledge model still defines 23 official lessons (${lessons.length})`);
  const seeded = populate(pre, { lessons });
  const countsBefore = tableCounts(pre);
  const idsBefore = pre
    .prepare(`SELECT "id" FROM "Lesson" ORDER BY "id"`)
    .all()
    .map((r) => r.id);
  const publishedBefore = one(
    pre,
    `SELECT COUNT(*) AS c FROM "Lesson" WHERE COALESCE(CAST("isPublished" AS INTEGER),0)=1`
  );
  const stagedBefore = countsBefore.Lesson - publishedBefore;
  const placeholderPdfBefore = one(pre, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "pdfUrl"='#'`);
  const lockedBefore = one(pre, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "isLocked"=1`);
  ok(
    publishedBefore > 0 && stagedBefore > 0,
    `fixture exercises BOTH backfill branches (published ${publishedBefore}, staged ${stagedBefore})`
  );
  ok(
    !hasColumn(pre, "Lesson", "status"),
    "pre-migration database genuinely has no status column"
  );
  pre.close();

  // 2. Copy it and apply ONLY the Phase 13 migration.
  fs.copyFileSync(prePath, postPath);
  const post = new DatabaseSync(postPath);
  applyMigrations(post, { label: "post-13 " });

  section("REHEARSAL — preservation");
  const countsAfter = tableCounts(post);
  eq(countsAfter, countsBefore, "every table's row count is unchanged");
  const idsAfter = post
    .prepare(`SELECT "id" FROM "Lesson" ORDER BY "id"`)
    .all()
    .map((r) => r.id);
  ok(
    JSON.stringify(idsBefore) === JSON.stringify(idsAfter),
    "lesson ids are identical and in the same order (no rebuild, no renumbering)"
  );
  eq(
    one(post, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "curriculumStatus"='OFFICIAL'`),
    23,
    "23 official lessons survive (Phase 11 intact)"
  );
  eq(
    one(post, `SELECT COUNT(*) AS c FROM "Part"`),
    countsBefore.Part,
    "part count unchanged"
  );
  const titleSample = row0(
    post,
    `SELECT "titleAr" FROM "Lesson" WHERE "id"=?`,
    `lesson-${lessons[7].code}`
  )?.titleAr;
  eq(titleSample, lessons[7].titleAr, "an arbitrary Arabic title is byte-identical");

  section("REHEARSAL — backfill correctness");
  assertStatusBackfill(post, "post-migration");
  eq(
    one(post, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "status"='PUBLISHED'`),
    publishedBefore,
    "PUBLISHED count == the rows that were published before"
  );
  eq(
    one(post, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "status"='DRAFT'`),
    stagedBefore,
    "DRAFT count == the rows that were invisible before"
  );
  eq(
    one(post, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "status"='READY'`),
    0,
    "no invented READY rows"
  );
  eq(
    one(
      post,
      `SELECT COUNT(*) AS c FROM "Lesson" WHERE "curriculumStatus"='ARCHIVED' AND "status"='READY'`
    ),
    0,
    "archived rows are not silently re-staged"
  );
  // The placeholder pdfUrl and the inert lock flag must still be there,
  // untouched: the migration must not "clean up" anything.
  eq(
    one(post, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "pdfUrl"='#'`),
    placeholderPdfBefore,
    "legacy `pdfUrl = \"#\"` placeholders are neither rewritten nor cleared"
  );
  eq(
    one(post, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "isLocked"=1`),
    lockedBefore,
    "`isLocked` values are untouched (retired, not revived, not deleted)"
  );

  section("REHEARSAL — schema shape");
  ok(hasColumn(post, "Lesson", "status"), "Lesson.status exists");
  const col = post
    .prepare(`PRAGMA table_info("Lesson")`)
    .all()
    .find((r) => r.name === "status");
  ok(!!col, "status column metadata is readable");
  eq(
    [col.type, col.notnull, col.dflt_value],
    ["TEXT", 1, "'DRAFT'"],
    "status is TEXT NOT NULL DEFAULT 'DRAFT' (SQLite enum representation, fail-closed default)"
  );
  ok(
    indexNames(post, "Lesson").includes("Lesson_status_idx"),
    "Lesson_status_idx created"
  );
  ok(
    hasColumn(post, "SessionPublication", "lessonId") &&
      hasColumn(post, "SessionPublication", "segment"),
    "SessionPublication exists with lessonId + segment"
  );
  const uniqueIdx = indexNames(post, "SessionPublication");
  ok(
    uniqueIdx.includes("SessionPublication_lessonId_key"),
    "SessionPublication.lessonId carries the UNIQUE idempotency index"
  );
  eq(one(post, `SELECT COUNT(*) AS c FROM "SessionPublication"`), 0, "log starts empty (backfill fabricates no publication rows)");

  section("REHEARSAL — relation integrity after migration");
  const fkViolations = post.prepare(`PRAGMA foreign_key_check`).all();
  eq(fkViolations.length, 0, `PRAGMA foreign_key_check is clean (${JSON.stringify(fkViolations.slice(0, 3))})`);
  eq(
    post.prepare(`PRAGMA integrity_check`).all().map((r) => Object.values(r)[0]),
    ["ok"],
    "PRAGMA integrity_check reports ok"
  );
  eq(
    one(
      post,
      `SELECT COUNT(*) AS c FROM "LessonProgress" lp
       LEFT JOIN "Lesson" l ON l."id" = lp."lessonId" WHERE l."id" IS NULL`
    ),
    0,
    "every LessonProgress row still resolves to a live lesson"
  );
  eq(
    one(
      post,
      `SELECT COUNT(*) AS c FROM "QuizAttempt" qa
       LEFT JOIN "Quiz" q ON q."id" = qa."quizId" WHERE q."id" IS NULL`
    ),
    0,
    "every QuizAttempt row still resolves to a live quiz"
  );
  eq(
    one(
      post,
      `SELECT COUNT(*) AS c FROM "HomeworkSubmission" hs
       LEFT JOIN "Homework" h ON h."id" = hs."homeworkId" WHERE h."id" IS NULL`
    ),
    0,
    "every HomeworkSubmission row still resolves to a live homework"
  );

  section("REHEARSAL — the idempotency key is real, not decorative");
  post.exec("BEGIN");
  try {
    post
      .prepare(
        `INSERT INTO "SessionPublication" ("id","lessonId","segment","publishedAt","publishedByUserId")
         VALUES ('pub-1', ?, 'SHARED', ?, 'user-rehearsal')`
      )
      .run(`lesson-${seeded.firstOfficial}`, now());
    post
      .prepare(
        `INSERT INTO "SessionPublication" ("id","lessonId","segment","publishedAt","publishedByUserId")
         VALUES ('pub-2', ?, 'SHARED', ?, 'user-rehearsal')`
      )
      .run(`lesson-${seeded.firstOfficial}`, now());
    dupError = null;
  } catch (e) {
    dupError = e;
  } finally {
    post.exec("ROLLBACK");
  }
  ok(
    !!dupError && /UNIQUE/i.test(String(dupError.message)),
    `a second publication row for the same lesson is rejected by the database (${
      dupError ? String(dupError.message).split("\n")[0] : "no error raised"
    })`
  );

  section("REHEARSAL — re-applying the backfill is a no-op (idempotent)");
  const beforeReplay = post
    .prepare(`SELECT "id","status" FROM "Lesson" ORDER BY "id"`)
    .all();
  post.exec(
    `UPDATE "Lesson" SET "status" = 'PUBLISHED'
     WHERE "status" = 'DRAFT'
       AND COALESCE(CAST("isPublished" AS INTEGER), 0) = 1`
  );
  eq(
    post.prepare(`SELECT "id","status" FROM "Lesson" ORDER BY "id"`).all(),
    beforeReplay,
    "replaying the backfill statement changes nothing"
  );
  // And a lesson an admin has UNPUBLISHED is not resurrected by a replay.
  // The unpublish is simulated the way `session-lifecycle.ts` performs it —
  // status AND mirror together — because the migration's rule is precisely
  // "mirror says published ⇒ PUBLISHED". A raw status-only write would be an
  // inconsistent row that no code path can produce, so asserting about it
  // would prove nothing.
  // (bound parameters need prepare().run(); `exec` takes SQL only)
  post
    .prepare(`UPDATE "Lesson" SET "status" = 'READY', "isPublished" = 0 WHERE "id" = ?`)
    .run(`lesson-${seeded.firstOfficial}`);
  post.exec(
    `UPDATE "Lesson" SET "status" = 'PUBLISHED'
     WHERE "status" = 'DRAFT'
       AND COALESCE(CAST("isPublished" AS INTEGER), 0) = 1`
  );
  eq(
    row0(post, `SELECT "status" FROM "Lesson" WHERE "id"=?`, `lesson-${seeded.firstOfficial}`)?.status,
    "READY",
    "a lesson an admin unpublished is never resurrected by a backfill replay"
  );
  assertStatusBackfill(post, "post-replay (mirror parity still holds)");

  post.close();
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n  (scratch databases removed: ${dir})`);
}

function runStudentUniverseCheck() {
  section("REHEARSAL — the student universe, evaluated on real rows");
  // The compiled lifecycle module's real filter constants are applied to the
  // rehearsal database as SQL, so what is asserted is the predicate the code
  // actually uses — not a hand-written copy of it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase13-u-"));
  const dbPath = path.join(dir, "u.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON;");
  const sorted = listMigrations();
  applyMigrations(db, {
    upTo: sorted.filter((n) => n < PHASE13_MIGRATION).pop(),
    withBaseSchema: true,
  });
  const lessons = officialLessonsFromModel();
  populate(db, { lessons });
  applyMigrations(db);
  assertMatchesPrismaSchema(db);

  const { statusFilter, archivedFilter } = readLifecycleFilters();
  const trackIn = ["SHARED", "ARABIC"]; // an ARABIC student's eligible scopes
  const sql = `
    SELECT l."id" AS id, l."officialCode" AS code, l."trackScope" AS track
    FROM "Lesson" l
    WHERE l."status" = ?
      AND l."curriculumStatus" <> ?
      AND l."trackScope" IN (${trackIn.map(() => "?").join(",")})
      AND (l."unitId" IS NOT NULL OR l."topicId" IS NOT NULL)
    ORDER BY l."officialCode"`;
  const rows = db.prepare(sql).all(statusFilter.status, archivedFilter.curriculumStatus.not, ...trackIn);
  // Independent second implementation of the same rule, evaluated in JS over
  // every lesson row: if the SQL predicate silently dropped or widened
  // something, the two answers disagree. This is what turns "the query ran"
  // into "the query selected the right rows".
  const all = db
    .prepare(
      `SELECT "id","status","curriculumStatus","trackScope","unitId","topicId" FROM "Lesson"`
    )
    .all();
  const expected = all
    .filter(
      (l) =>
        l.status === statusFilter.status &&
        String(l.curriculumStatus) !== archivedFilter.curriculumStatus.not &&
        trackIn.includes(l.trackScope) &&
        (l.unitId !== null || l.topicId !== null)
    )
    .map((l) => l.id)
    .sort();
  eq(
    rows.map((r) => r.id).sort(),
    expected,
    "the student universe is EXACTLY published ∧ ¬archived ∧ track-eligible ∧ chained"
  );
  ok(
    expected.length > 0 &&
      !rows.some((r) => String(r.code ?? "").length === 0 && r.id === "legacy-orphan"),
    "the orphaned (unchained) lesson is outside the universe"
  );
  const stagedInUniverse = rows.filter((r) =>
    ["legacy-orphan"].includes(r.id)
  ).length;
  eq(stagedInUniverse, 0, "no DRAFT/READY lesson can appear in the universe");
  eq(statusFilter.status, "PUBLISHED", "the source's student universe filter really is PUBLISHED");
  eq(archivedFilter.curriculumStatus.not, "ARCHIVED", "the source's archived exclusion really is ARCHIVED");
  ok(rows.length > 0, "the universe selects a non-empty set of real lessons");
  const drafts = one(db, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "status"='DRAFT'`);
  ok(drafts > 0, `the fixture keeps staged rows out of it (${drafts} DRAFT lessons are not curriculum)`);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

/**
 * Read the two exported filter constants out of the TypeScript sources —
 * literal-parsed, so this check fails if a source changes the predicate.
 */
function readLifecycleFilters() {
  const life = fs.readFileSync(
    path.join(REPO, "src/lib/session-lifecycle.ts"),
    "utf8"
  );
  const prog = fs.readFileSync(path.join(REPO, "src/lib/session-progress.ts"), "utf8");
  const status = /LESSON_STUDENT_STATUS_FILTER\s*=\s*\{\s*status:\s*"([A-Z]+)"/.exec(life);
  const archived = /EXCLUDE_ARCHIVED_LESSON\s*=\s*\{\s*curriculumStatus:\s*\{\s*not:\s*"([A-Z]+)"/.exec(prog);
  if (!status || !archived) {
    throw new Error(
      "could not read LESSON_STUDENT_STATUS_FILTER / EXCLUDE_ARCHIVED_LESSON from source"
    );
  }
  return {
    statusFilter: { status: status[1] },
    archivedFilter: { curriculumStatus: { not: archived[1] } },
  };
}

// ---------------------------------------------------------------------------
// REAL CODE against the real database
// ---------------------------------------------------------------------------
//
// Everything above proves the DATA layer. This proves the CODE layer, on the
// same real rows: the actual TypeScript modules of the platform —
// `official-curriculum.ts` (the Phase 11 reconciler), `session-lifecycle.ts`
// (the readiness computation and the OPEN ceremony), `session-progress.ts`
// (the progression engine), `enrollment.ts`, `parent-access.ts` — are compiled
// with `tsc` exactly as they ship and executed against a real SQLite database
// through a client that translates Prisma calls into real SQL
// (`scripts/lib/sqlite-prisma-lite.mjs`). No function body is reimplemented
// here, and the adapter refuses (rather than approximates) any query shape it
// does not understand, so a green line below means the shipped code produced
// that result on real rows.
//
// What it does NOT replace: `@prisma/client`'s own query engine. The engine
// binary cannot be downloaded in this sandbox, so the SQL translation is the
// adapter's. The consequence is spelled out in the phase doc (§"Verification"):
// constraints, defaults, uniqueness and row effects are the database's own;
// the mapping from a Prisma call to SQL is the adapter's.

const REAL_CODE_MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/progress.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/parent-access.ts",
  "src/lib/official-curriculum.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase13-real-"));
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
        files: REAL_CODE_MODULES.map((f) => path.join(REPO, f)),
      },
      null,
      2
    )
  );
  // Invoke the repository's own TypeScript compiler through the current Node
  // executable. Neither `npx` nor `npx.cmd` is a reliable `execFileSync`
  // target on Windows (`spawnSync npx ENOENT`, `spawnSync npx.cmd EINVAL`),
  // but `process.execPath` is always a real, spawnable executable, and
  // `require.resolve` pins the exact `typescript` this repo installed — no
  // `.cmd` shim is involved on any platform. Compiler args and cwd are
  // unchanged.
  const tscBin = require.resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], {
      cwd: REPO,
      stdio: "pipe",
    });
  } catch {
    /* type noise elsewhere in the graph is tolerated; the emitted files matter */
  }
  const emitted = REAL_CODE_MODULES.map((f) =>
    path.join(out, f.replace(/\.ts$/, ".js"))
  );
  for (const f of emitted) {
    if (!fs.existsSync(f)) {
      throw new Error(`tsc did not emit ${path.relative(REPO, f)}`);
    }
  }
  return { out, libDir: path.join(out, "src/lib") };
}

function loadRealCode(outDir) {
  const { Module } = require("module");
  // The db shim resolves to whatever client is installed on the global at the
  // time a query runs — so one compiled module graph can be pointed at any
  // scratch database without re-compiling.
  const shim = path.join(outDir, "__db-shim.js");
  fs.writeFileSync(
    shim,
    'module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n'
  );
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return shim;
    const m = /^@\/lib\/([\w-]+)$/.exec(request);
    if (m) {
      const compiled = path.join(outDir, "src/lib", `${m[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    const json = /knowledge-model\.json$/.exec(request);
    if (json) {
      const copied = path.join(outDir, "docs/curriculum/knowledge-model.json");
      if (fs.existsSync(copied)) return copied;
    }
    return originalResolve.call(this, request, ...rest);
  };
  const load = (name) => require(path.join(outDir, "src/lib", name));
  return {
    restore() {
      Module._resolveFilename = originalResolve;
    },
    lifecycle: load("session-lifecycle.js"),
    progression: load("session-progress.js"),
    reconciler: load("official-curriculum.js"),
    parentAccess: load("parent-access.js"),
    enrollment: load("enrollment.js"),
  };
}

async function runRealCode() {
  section("REAL CODE — the shipped modules, on real rows, over real SQLite");
  const { createSqlitePrisma } = require(
    path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs")
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase13-realrun-"));
  const dbPath = path.join(dir, "real.db");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys=ON;");
  const sorted = listMigrations();
  applyMigrations(db, {
    upTo: sorted.filter((n) => n < PHASE13_MIGRATION).pop(),
    withBaseSchema: true,
  });
  applyMigrations(db, {
    only: sorted.filter((n) => n >= PHASE13_MIGRATION),
    log: (m) => console.log(`  applied: ${m}`),
  });
  const client = createSqlitePrisma({ db, schemaPath: path.join(REPO, "prisma/schema.prisma") });
  globalThis.__CM_DB_CLIENT__ = client;

  const { out, libDir } = compileRealCode();
  const code = loadRealCode(out);
  const schemaPath = path.join(REPO, "prisma/schema.prisma");

  // ---- 1. the REAL Phase 11 reconciler, twice ----------------------------
  section("REAL CODE — Phase 11 reconciler still runs against the real DB");
  let report1 = null;
  let report2 = null;
  try {
    report1 = (await code.reconciler.reconcileOfficialCurriculum(client));
    report2 = (await code.reconciler.reconcileOfficialCurriculum(client));
  } catch (e) {
    console.log(String(e?.stack || e).split("\n").slice(0, 12).join("\n"));
    ok(false, `reconciler ran without throwing (${e?.message})`);
  }
  ok(!!report1, "reconcileOfficialCurriculum(client) completed against the real database");
  eq(report1?.officialLessonCodes?.length, 23, "23 official lessons reconciled");
  eq(report1?.lessonsCreated, 23, "all 23 created on the first run");
  eq(report1?.lessonsCreatedAsDraft, 23, "every created lesson started DRAFT (no accidental publish)");
  eq(report1?.lessonsPublished, 0, "reconciling published nothing — publishing is the ceremony's job");
  eq(report2?.lessonsCreated, 0, "second run created nothing");
  eq(report2?.lessonsUpdated, 0, "second run updated nothing (idempotent)");
  eq(report2?.archivedLessonIds?.length ?? 0, 0, "second run archived nothing");
  eq(
    one(db, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "curriculumStatus"='OFFICIAL'`),
    23,
    "the database holds exactly 23 OFFICIAL rows"
  );
  eq(
    one(db, `SELECT COUNT(*) AS c FROM (SELECT "officialCode" FROM "Lesson" GROUP BY "officialCode" HAVING COUNT(*)>1)`),
    0,
    "no duplicate officialCode"
  );
  eq(
    one(db, `SELECT COUNT(*) AS c FROM "Lesson" WHERE "status"<>'DRAFT'`),
    0,
    "every reconciled row is DRAFT in the real database"
  );

  // ---- 2. readiness + the ceremony, through the real functions -----------
  section("REAL CODE — readiness, OPEN ceremony, idempotency");
  const life = code.lifecycle;
  const L1 = db.prepare(`SELECT "id" FROM "Lesson" WHERE "officialCode"='1-1'`).get().id;
  const L2 = db.prepare(`SELECT "id" FROM "Lesson" WHERE "officialCode"='1-2'`).get().id;

  const r0 = (await life.getLessonReadiness(L1, client));
  ok(!!r0, "getLessonReadiness loaded the lesson from the real DB");
  eq(r0?.status, "DRAFT", "readiness reports the stored lifecycle state");
  eq(r0?.blocking, ["VIDEO_MISSING"], "a lesson with no video is blocked by VIDEO_MISSING");
  eq(r0?.items.find((i) => i.key === "PDF")?.state, "NOT_APPLICABLE", "PDF is NOT_APPLICABLE, never a fake requirement");
  ok(r0?.canBeReady === false, "not READY-able yet");

  const prematureOpen = (await life.openLesson({ lessonId: L1, actorUserId: null, client }));
  eq(prematureOpen.code, "ILLEGAL_TRANSITION", "DRAFT cannot be opened directly (READY cannot be bypassed)");
  const prematureMark = (await life.markLessonReady({ lessonId: L1, actorUserId: null, client }));
  eq(prematureMark.code, "READINESS_BLOCKED", "staging requires readiness");
  eq(prematureMark.readiness?.blocking, ["VIDEO_MISSING"], "the refusal names what is missing");
  eq(row0(db, `SELECT "status" FROM "Lesson" WHERE "id"=?`, L1)?.status, "DRAFT", "both refusals wrote nothing");

  // Stage the content for real: a legacy lesson video.
  db.prepare(`UPDATE "Lesson" SET "videoUrl"='https://cdn.test/1-1.mp4' WHERE "id"=?`).run(L1);
  const marked = (await life.markLessonReady({ lessonId: L1, actorUserId: null, client }));
  eq(marked.code, "OK", "DRAFT → READY once readiness holds");
  eq(marked.changed, true, "the transition wrote");
  eq(row0(db, `SELECT "status" FROM "Lesson" WHERE "id"=?`, L1)?.status, "READY", "the database row is READY");
  eq(row0(db, `SELECT "isPublished" FROM "Lesson" WHERE "id"=?`, L1)?.isPublished, 0, "the mirror stays false while READY (invisible)");
  const reMark = (await life.markLessonReady({ lessonId: L1, actorUserId: null, client }));
  eq(reMark.code, "NO_OP_ALREADY_IN_STATE", "mark-ready on READY is an idempotent no-op");

  const opened = (await life.openLesson({ lessonId: L1, actorUserId: null, client }));
  eq(opened.code, "OK", "READY → PUBLISHED through the ceremony");
  eq(row0(db, `SELECT "status" FROM "Lesson" WHERE "id"=?`, L1)?.status, "PUBLISHED", "row is PUBLISHED");
  eq(row0(db, `SELECT "isPublished" FROM "Lesson" WHERE "id"=?`, L1)?.isPublished, 1, "mirror re-synced to true by the ONLY writer");
  eq(one(db, `SELECT COUNT(*) AS c FROM "SessionPublication"`), 1, "exactly one publication row");
  eq(
    db.prepare(`SELECT "segment" FROM "SessionPublication" WHERE "lessonId"=?`).get(L1)?.segment,
    "SHARED",
    "the publication records the lesson's segment"
  );

  const openedAgain = (await life.openLesson({ lessonId: L1, actorUserId: null, client }));
  eq(openedAgain.code, "NO_OP_ALREADY_IN_STATE", "a second OPEN is a no-op");
  eq(openedAgain.changed, false, "no second semantic publish");
  eq(one(db, `SELECT COUNT(*) AS c FROM "SessionPublication"`), 1, "no duplicate publication row");
  eq(one(db, `SELECT COUNT(*) AS c FROM "Notification"`), 0, "NO notification was created by publishing");

  // Breaking readiness after publishing must not be able to retro-validate:
  // an un-staged second lesson cannot be opened even though a sibling can.
  const secondOpen = (await life.openLesson({ lessonId: L2, actorUserId: null, client }));
  eq(secondOpen.code, "ILLEGAL_TRANSITION", "another DRAFT lesson is still untouchable");

  section("REAL CODE — the lesson the ceremony published is the lesson students can reach");
  // Two students (one per track) in one group of the reconciled course.
  const courseId = db.prepare(`SELECT "id" FROM "Course" WHERE "slug"=?`).get("programming-ai-2nd-sec").id;
  await insert(client, "group", {
    id: "g-real",
    name: "Real group",
    courseId,
    capacity: 20,
    isActive: true,
  });
  await insert(client, "user", { id: "u-s-ar", email: "ar@t.test", password: "x", name: "AR", role: "STUDENT" });
  await insert(client, "user", { id: "u-s-lang", email: "lang@t.test", password: "x", name: "Lang", role: "STUDENT" });
  await insert(client, "student", { id: "s-ar", userId: "u-s-ar", grade: "2nd Secondary", schoolType: "ARABIC", groupId: "g-real" });
  eq(
    (await code.progression.getCourseSessionProgress("s-ar", courseId, "ARABIC")).sessions.map((s) => s.lessonId),
    [L1],
    "the universe contains the PUBLISHED lesson and NOTHING else (L2 is DRAFT)"
  );
  const access1 = (await code.progression.canAccessLesson("s-ar", L1));
  eq(access1.allowed, true, "the first published lesson is unlocked");
  const access2 = (await code.progression.canAccessLesson("s-ar", L2));
  eq(access2.reason, "LESSON_NOT_FOUND", "a DRAFT lesson answers 404, never 403 (no existence oracle)");

  // PUBLISHED + LOCKED: open L2 through the ceremony, and it must be in the
  // curriculum while its content stays gated by progression.
  db.prepare(`UPDATE "Lesson" SET "videoUrl"='https://cdn.test/1-2.mp4' WHERE "id"=?`).run(L2);
  (await life.markLessonReady({ lessonId: L2, actorUserId: null, client }));
  (await life.openLesson({ lessonId: L2, actorUserId: null, client }));
  const progressAfter = (await code.progression.getCourseSessionProgress("s-ar", courseId, "ARABIC"));
  eq(progressAfter.sessions.map((s) => s.lessonId), [L1, L2], "both published lessons are curriculum rows, in order");
  eq(progressAfter.sessions.map((s) => s.unlocked), [true, false], "PUBLISHED + LOCKED is a real, reachable state");
  const lockedAccess = (await code.progression.canAccessLesson("s-ar", L2));
  eq(lockedAccess.allowed, false, "a published but locked lesson is not openable");
  eq(lockedAccess.reason, "PREVIOUS_SESSION_INCOMPLETE", "with the progression reason, not a lifecycle one");
  eq(progressAfter.currentLessonId, L1, "and progression still points at the session to work on");

  section("REAL CODE — track isolation survives the lifecycle layer");
  const arOnly = await insert(client, "lesson", {
    id: "lesson-ar-only",
    title: "Arabic only",
    titleAr: "عربي فقط",
    order: 90,
    trackScope: "ARABIC",
    curriculumStatus: "LEGACY",
    unitId: db.prepare(`SELECT "id" FROM "Unit" ORDER BY "order" LIMIT 1`).get().id,
    videoUrl: "https://cdn.test/ar.mp4",
    status: "PUBLISHED",
    isPublished: true,
  });
  const lang = await insert(client, "student", { id: "s-lang", userId: "u-s-lang", grade: "2nd Secondary", schoolType: "LANGUAGE", groupId: "g-real" });
  const langAccess = (await code.progression.canAccessLesson("s-lang", arOnly.id));
  eq(langAccess.reason, "LESSON_NOT_FOUND", "a LANGUAGE student cannot reach a PUBLISHED ARABIC lesson");
  // The ARABIC student is NOT told "no such lesson" for the same row: the
  // refusal is a progression one, which is exactly the distinction between an
  // invisible (wrong-track) lesson and a visible-but-locked one.
  const arAccess = (await code.progression.canAccessLesson("s-ar", arOnly.id));
  eq(
    arAccess.reason,
    "PREVIOUS_SESSION_INCOMPLETE",
    "the ARABIC student sees the ARABIC lesson as locked, not as missing"
  );
  ok(arAccess.allowed === false, "and it stays unopenable until the earlier sessions are done");
  eq(
    (await code.progression.getCourseSessionProgress("s-lang", courseId, "LANGUAGE")).sessions.map((s) => s.lessonId),
    [L1, L2],
    "the other track's universe is unaffected by the ARABIC lesson"
  );

  section("REAL CODE — archived and orphan lessons can never be opened");
  const archived = await insert(client, "lesson", {
    id: "lesson-archived",
    title: "Retired",
    titleAr: "مؤرشف",
    order: 91,
    curriculumStatus: "ARCHIVED",
    status: "READY",
    unitId: db.prepare(`SELECT "id" FROM "Unit" ORDER BY "order" LIMIT 1`).get().id,
    videoUrl: "https://cdn.test/a.mp4",
  });
  eq((await life.openLesson({ lessonId: archived.id, actorUserId: null, client })).code, "LESSON_ARCHIVED", "OPEN refuses an ARCHIVED lesson");
  eq((await life.markLessonReady({ lessonId: archived.id, actorUserId: null, client })).code, "LESSON_ARCHIVED", "staging refuses it too");
  eq((await life.unpublishLesson({ lessonId: archived.id, actorUserId: null, client })).code, "LESSON_ARCHIVED", "and so does withdrawing it");
  eq(row0(db, `SELECT "status" FROM "Lesson" WHERE "id"=?`, archived.id)?.status, "READY", "the refusal wrote nothing");
  const orphan = await insert(client, "lesson", {
    id: "lesson-orphan",
    title: "Orphan",
    titleAr: "يتيم",
    order: 92,
    curriculumStatus: "LEGACY",
    status: "READY",
    videoUrl: "https://cdn.test/o.mp4",
  });
  eq((await life.openLesson({ lessonId: orphan.id, actorUserId: null, client })).code, "LESSON_NOT_IN_COURSE", "a lesson in no curriculum cannot be opened into one");
  eq(row0(db, `SELECT "status" FROM "Lesson" WHERE "id"=?`, orphan.id)?.status, "READY", "and that refusal wrote nothing either");
  eq((await life.openLesson({ lessonId: "does-not-exist", actorUserId: null, client })).code, "LESSON_NOT_FOUND", "an unknown id is LESSON_NOT_FOUND (404)");

  section("REAL CODE — PUBLISHED → READY withdraws the publication");
  const unpublish = (await life.unpublishLesson({ lessonId: L2, actorUserId: null, client }));
  eq(unpublish.code, "OK", "unpublish is an explicit, supported admin transition");
  eq(row0(db, `SELECT "status" FROM "Lesson" WHERE "id"=?`, L2)?.status, "READY", "row is READY again");
  eq(row0(db, `SELECT "isPublished" FROM "Lesson" WHERE "id"=?`, L2)?.isPublished, 0, "mirror follows, in the same transaction");
  eq(one(db, `SELECT COUNT(*) AS c FROM "SessionPublication" WHERE "lessonId"=?`, L2), 0, "the publication anchor is withdrawn (nothing left for Phase 17 to fan out for)");
  eq(
    (await code.progression.getCourseSessionProgress("s-ar", courseId, "ARABIC")).sessions.map((s) => s.lessonId),
    [L1, arOnly.id],
    "and it instantly leaves the student universe — while L1 stays put"
  );

  section("REAL CODE — the parent preview gate (Phase 12 finding closed)");
  await insert(client, "user", { id: "u-parent", email: "p@t.test", password: "x", name: "Parent", role: "PARENT" });
  await insert(client, "parent", { id: "parent-1", userId: "u-parent" });
  await insert(client, "parentStudentLink", { id: "link-1", parentId: "parent-1", studentId: "s-ar" });
  eq(
    (await code.parentAccess.isParentLessonPreviewAllowed(
      "u-parent",
      { status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "SHARED" },
      courseId
    )),
    true,
    "parent of an enrolled child may preview the PUBLISHED lesson"
  );
  eq(
    (await code.parentAccess.isParentLessonPreviewAllowed(
      "u-parent",
      { status: "READY", curriculumStatus: "OFFICIAL", trackScope: "SHARED" },
      courseId
    )),
    false,
    "…but NOT a READY one — the Phase 12 finding is closed in the shared helper"
  );
  eq(
    (await code.parentAccess.isParentLessonPreviewAllowed(
      "u-parent",
      { status: "DRAFT", curriculumStatus: "OFFICIAL", trackScope: "SHARED" },
      courseId
    )),
    false,
    "…and not a DRAFT one"
  );
  eq(
    (await code.parentAccess.isParentLessonPreviewAllowed(
      "u-parent",
      { status: "PUBLISHED", curriculumStatus: "ARCHIVED", trackScope: "SHARED" },
      courseId
    )),
    false,
    "…and not archived history"
  );
  eq(
    (await code.parentAccess.isParentLessonPreviewAllowed(
      "u-parent",
      { status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "LANGUAGE" },
      courseId
    )),
    false,
    "…and not the other track (Phase 12 still holds)"
  );
  eq(
    (await code.parentAccess.isParentLessonPreviewAllowed(
      "u-parent",
      { status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "SHARED" },
      "another-course"
    )),
    false,
    "…and not another course (Phase 7 still holds)"
  );

  section("REAL CODE — mutation controls (the protections are load-bearing)");
  {
    // Remove the lifecycle clause from a COPY of the engine and re-run the
    // universe check on the SAME database: if the filter were decorative, the
    // result would be unchanged.
    const src = fs.readFileSync(path.join(libDir, "session-progress.js"), "utf8");
    // Drop the clause itself (an empty object spread) rather than a comment, so
    // the variant is still valid JavaScript — otherwise this would prove
    // "the file does not parse", not "the filter is load-bearing".
    const neutered = src
      .replace(/[A-Za-z_$][\w$]*\.LESSON_STUDENT_STATUS_FILTER/g, "{}")
      .replace(/(?<![\w$.])LESSON_STUDENT_STATUS_FILTER/g, "{}");
    ok(neutered !== src, "the lifecycle clause is present in the compiled engine (so removing it is a real mutation)");
    const variant = path.join(libDir, "session-progress-neutered.js");
    fs.writeFileSync(variant, neutered);
    delete require.cache[variant];
    const neuteredEngine = require(variant);
    const leaked = (await 
      neuteredEngine.getCourseSessionProgress("s-ar", courseId, "ARABIC")
    ).sessions.map((s) => s.lessonId);
    ok(
      leaked.includes(L2),
      "without the lifecycle clause the unpublished lesson enters the universe (test is a real guard)"
    );
    const real = (await 
      code.progression.getCourseSessionProgress("s-ar", courseId, "ARABIC")
    ).sessions.map((s) => s.lessonId);
    ok(!real.includes(L2), "with it, the same database refuses the same lesson");
    fs.rmSync(variant, { force: true });
  }
  {
    const src = fs.readFileSync(path.join(libDir, "session-lifecycle.js"), "utf8");
    const noReadiness = src.replace(
      /if \(needsReadiness && !readiness\.canBeReady\)/,
      "if (false)"
    );
    ok(noReadiness !== src, "the readiness gate exists in the compiled ceremony");
    const variant = path.join(libDir, "session-lifecycle-no-readiness.js");
    fs.writeFileSync(variant, noReadiness);
    delete require.cache[variant];
    const mutated = require(variant);
    // L2 is READY-but-incomplete after being unpublished above: without the
    // gate it would be opened anyway.
    db.prepare(`UPDATE "Lesson" SET "videoUrl"=NULL WHERE "id"=?`).run(L2);
    const res = await mutated.openLesson({ lessonId: L2, actorUserId: null, client });
    ok(
      res.code === "OK" || res.code === "CONCURRENT_CHANGE",
      `without the readiness check an incomplete lesson is published (got ${res.code})`
    );
    // restore
    db.prepare(`UPDATE "Lesson" SET "status"='READY', "isPublished"=0 WHERE "id"=?`).run(L2);
    fs.rmSync(variant, { force: true });
  }

  code.restore();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(out, { recursive: true, force: true });
  void schemaPath;
}

function insert(client, model, data) {
  const name = model[0].toUpperCase() + model.slice(1);
  const delegate = client[model] ?? client[name];
  if (!delegate) throw new Error(`no delegate for ${model}`);
  return delegate.create({ data });
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

console.log("CodeMind Academy — Phase 13 real-database verification");
console.log(`migrations: ${listMigrations().join(", ")}`);
(async () => {
  try {
    if (MODE === "local") await runLocal();
    else if (MODE === "rehearsal") {
      runRehearsal();
      runStudentUniverseCheck();
    } else if (MODE === "realcode") {
      await runRealCode();
    } else {
      runRehearsal();
      runStudentUniverseCheck();
      await runRealCode();
      await runLocal();
    }
  } catch (e) {
    fail++;
    console.error(`\nEXCEPTION: ${e?.stack || e}`);
  }
  // The summary must run AFTER the awaited work, not merely after it is
  // scheduled — otherwise `local`/`realcode` would report "0 failures" for
  // assertions that had not been evaluated yet.
  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} assertions, ${fail} failures`);
  process.exit(fail === 0 ? 0 : 1);
})();

