// CodeMind Academy — shared SQLite migration runner for real-DB verification.
//
// This module is extracted VERBATIM (logic-identical) from the proven helpers
// in scripts/verify-phase13-db.mjs so later verification scripts
// (Phase 15 admin workflow, …) can build the same scratch database —
// pre-migration base DDL derived from prisma/schema.prisma, then every real
// migration.sql in name order — without importing that 1900-line script (which
// executes on load) and without duplicating the derivation in every consumer.
//
// Extraction, not re-implementation: the derivation rules, skip lists and
// checksum recording below are the Phase 13 rehearsal's, character for
// character in behaviour. If the migration history grows, update the skip
// lists here exactly as verify-phase13-db.mjs would.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = path.join(REPO, "prisma", "migrations");

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(path.join(MIGRATIONS_DIR, n, "migration.sql")))
    .sort();
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

function ensureMigrationsTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
    "id" TEXT PRIMARY KEY,
    "checksum" TEXT NOT NULL,
    "finished_at" DATETIME,
    "migration_name" TEXT NOT NULL,
    "logs" TEXT,
    "rolled_back_at" DATETIME,
    "started_at" DATETIME NOT NULL,
    "applied_steps_count" INTEGER NOT NULL
  );`);
}

function appliedMigrations(db) {
  return new Set(
    db
      .prepare('SELECT "migration_name" AS n FROM "_prisma_migrations"')
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
// order. `assertColumnsMatchSchema` proves the end state has exactly the
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
  "SessionPublication",
  "TeacherApplication",
  "TeacherActivationToken",
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
 * Compare `base DDL + every real migration file` against
 * `prisma/schema.prisma` for the given tables. Returns an array of
 * `{ table, missing, extra, declared }` — the CALLER decides how to assert,
 * so this module stays free of any test-harness coupling.
 */
function assertColumnsMatchSchema(db, tables) {
  const { models } = parsePrismaModels();
  return tables.map((table) => {
    const fields = models.get(table);
    if (!fields) return { table, missing: null, extra: null, declared: false };
    const expected = new Set(
      fields
        .filter((f) => !f.uniqueGroup && !/\[\]/.test(f.type))
        .map((f) => f.name)
    );
    const actual = new Set(
      db.prepare(`PRAGMA table_info("${table}")`).all().map((r) => r.name)
    );
    return {
      table,
      declared: true,
      missing: [...expected].filter((c) => !actual.has(c)),
      extra: [...actual].filter((c) => !expected.has(c)),
    };
  });
}

export {
  REPO,
  MIGRATIONS_DIR,
  listMigrations,
  splitStatements,
  applyMigrations,
  parsePrismaModels,
  baseSchemaDdl,
  assertColumnsMatchSchema,
};
