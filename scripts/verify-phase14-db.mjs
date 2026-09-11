#!/usr/bin/env node
// CodeMind Academy — Phase 14 real-database + real-file verification.
//
// Builds a scratch SQLite DB from the same base-schema + migration chain the
// Phase 13 verifier uses, applies Phase 14, then exercises the SHIPPED
// session-materials / media modules against real rows and real PDF bytes.
//
// Prints PHASE14_VERIFY_OK on success. Never touches the developer's real DB.
//
// Prisma engine note (same as Phase 13): binaries.prisma.sh is unreachable in
// this sandbox, so SQL is applied via node:sqlite and the Prisma surface is
// scripts/lib/sqlite-prisma-lite.mjs. Constraints/defaults/uniques are real.

import crypto from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import Module from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(HERE, "..");
const MIGRATIONS_DIR = path.join(REPO, "prisma", "migrations");
const PHASE14 = "20260910120000_phase14_session_materials";
const SCHEMA = path.join(REPO, "prisma", "schema.prisma");

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

// ---------------------------------------------------------------------------
// Base schema + migration application (same derivation as Phase 13)
// ---------------------------------------------------------------------------

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
  // Phase 14 column is added by its migration, so base has no trackScope.
  Material: ["trackScope"],
};

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

function parsePrismaModels(schemaPath = SCHEMA) {
  const text = fs.readFileSync(schemaPath, "utf8");
  const models = new Map();
  const enumNames = new Set(
    [...text.matchAll(/^enum\s+([A-Za-z0-9_]+)/gm)].map((m) => m[1])
  );
  const blocks = [
    ...text.matchAll(/^model\s+([A-Za-z0-9_]+)\s*\{([\s\S]*?)^\}/gm),
  ];
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
      if (list) continue;
      const isModel = modelNames.has(type) || /@relation/.test(rest);
      const isEnum = enumNames.has(type);
      if (!isEnum && !PRISMA_TO_SQLITE[type] && isModel) continue;
      const col = { name, type, optional: !!optional, default: null };
      const def = /@default\(([^)]*)\)/.exec(rest);
      if (def) col.default = def[1].trim();
      if (/@id\b/.test(rest)) col.isId = true;
      if (/@unique\b/.test(rest)) col.unique = true;
      fields.push(col);
    }
    models.set(modelName, fields);
  }
  return { models, enumNames };
}

function sqliteTypeOf(field, enumNames) {
  if (PRISMA_TO_SQLITE[field.type]) return PRISMA_TO_SQLITE[field.type];
  if (enumNames.has(field.type)) return "TEXT";
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
    const idCols = fields
      .filter((f) => f.isId && !skip.has(f.name))
      .map((f) => f.name);
    for (const f of fields) {
      if (f.uniqueGroup || skip.has(f.name)) continue;
      let decl = `"${f.name}" ${sqliteTypeOf(f, enumNames)}`;
      if (!f.optional && !f.isId) decl += " NOT NULL";
      const dflt = sqlDefault(f.default, enumNames);
      if (dflt !== null) decl += ` DEFAULT ${dflt}`;
      if (f.unique && idCols.length <= 1) decl += " UNIQUE";
      cols.push(decl);
    }
    if (idCols.length)
      cols.push(`PRIMARY KEY (${idCols.map((c) => `"${c}"`).join(", ")})`);
    for (const f of fields) {
      if (f.uniqueGroup && !f.uniqueGroup.some((c) => skip.has(c))) {
        cols.push(
          `UNIQUE (${f.uniqueGroup.map((c) => `"${c}"`).join(", ")})`
        );
      }
    }
    statements.push(`CREATE TABLE "${name}" (\n  ${cols.join(",\n  ")}\n);`);
  }
  return statements.join("\n");
}

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

function listMigrations() {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((d) =>
      fs.existsSync(path.join(MIGRATIONS_DIR, d, "migration.sql"))
    )
    .sort();
}

function ensureMigrationsTable(db) {
  db.exec(`
CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "checksum" TEXT NOT NULL,
  "finished_at" DATETIME,
  "migration_name" TEXT NOT NULL,
  "logs" TEXT,
  "rolled_back_at" DATETIME,
  "started_at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_steps_count" INTEGER NOT NULL DEFAULT 0
);`);
}

function applyMigrations(db) {
  for (const stmt of splitStatements(baseSchemaDdl())) db.exec(stmt);
  ensureMigrationsTable(db);
  for (const name of listMigrations()) {
    const file = path.join(MIGRATIONS_DIR, name, "migration.sql");
    const sql = fs.readFileSync(file, "utf8");
    const checksum = crypto.createHash("sha256").update(sql).digest("hex");
    db.exec("BEGIN");
    try {
      for (const stmt of splitStatements(sql)) db.exec(stmt);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${name} failed: ${e.message}`);
    }
    db.prepare(
      `INSERT INTO "_prisma_migrations"
       ("id","checksum","finished_at","migration_name","logs","rolled_back_at","started_at","applied_steps_count")
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(crypto.randomUUID(), checksum, Date.now(), name, null, null, Date.now(), 1);
    console.log(`  applied ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Build DB
// ---------------------------------------------------------------------------
console.log("CodeMind Academy — Phase 14 real DB/file verification");
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase14-"));
const DB_PATH = path.join(WORK, "phase14.db");
const MEDIA_ROOT = path.join(WORK, "media");
fs.mkdirSync(MEDIA_ROOT, { recursive: true });
process.env.MEDIA_STORAGE_PATH = MEDIA_ROOT;

const sqlite = new DatabaseSync(DB_PATH);
sqlite.exec("PRAGMA foreign_keys=ON;");
applyMigrations(sqlite);

// Phase 14 column + index
const matCols = sqlite
  .prepare(`PRAGMA table_info("Material")`)
  .all()
  .map((c) => c.name);
ok(matCols.includes("trackScope"), "Material.trackScope column exists after migration");
const idxs = sqlite
  .prepare(`SELECT name FROM pragma_index_list('Material')`)
  .all()
  .map((r) => r.name);
ok(
  idxs.includes("Material_lessonId_trackScope_isActive_idx"),
  "Material trackScope index exists"
);

// ---------------------------------------------------------------------------
// Prisma-lite client + seed
// ---------------------------------------------------------------------------
const { createSqlitePrisma } = require(
  path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs")
);
const client = createSqlitePrisma({ db: sqlite, schemaPath: SCHEMA });
globalThis.__CM_DB_CLIENT__ = client;

const now = new Date();
const course = await client.course.create({
  data: {
    id: "c1",
    slug: "test-course",
    name: "Test",
    nameAr: "اختبار",
    description: "d",
    color: "#10b981",
  },
});
const part = await client.part.create({
  data: { id: "p1", courseId: course.id, title: "P1", titleAr: "ج1", order: 1 },
});
const unit = await client.unit.create({
  data: { id: "u1", partId: part.id, title: "U1", titleAr: "و1", order: 1 },
});
const group = await client.group.create({
  data: {
    id: "g1",
    name: "G1",
    courseId: course.id,
    capacity: 20,
    schedule: "Sat",
    isActive: true,
  },
});
await client.batch.create({
  data: {
    id: "b-ar",
    name: "AR",
    nameAr: "عربي",
    schoolType: "ARABIC",
    courseId: course.id,
    isActive: true,
  },
});
await client.batch.create({
  data: {
    id: "b-lang",
    name: "LANG",
    nameAr: "لغات",
    schoolType: "LANGUAGE",
    courseId: course.id,
    isActive: true,
  },
});

await client.user.create({
  data: {
    id: "u-admin",
    email: "admin@t.test",
    password: "x",
    name: "Admin",
    role: "ADMIN",
  },
});
await client.user.create({
  data: {
    id: "u-ar",
    email: "ar@t.test",
    password: "x",
    name: "AR",
    role: "STUDENT",
  },
});
await client.user.create({
  data: {
    id: "u-lang",
    email: "lang@t.test",
    password: "x",
    name: "LANG",
    role: "STUDENT",
  },
});
await client.user.create({
  data: {
    id: "u-parent",
    email: "p@t.test",
    password: "x",
    name: "Parent",
    role: "PARENT",
  },
});
await client.student.create({
  data: {
    id: "s-ar",
    userId: "u-ar",
    grade: "2nd",
    schoolType: "ARABIC",
    groupId: group.id,
    batchId: "b-ar",
  },
});
await client.student.create({
  data: {
    id: "s-lang",
    userId: "u-lang",
    grade: "2nd",
    schoolType: "LANGUAGE",
    groupId: group.id,
    batchId: "b-lang",
  },
});
await client.parent.create({ data: { id: "par1", userId: "u-parent" } });
await client.parentStudentLink.create({
  data: { id: "psl1", parentId: "par1", studentId: "s-ar" },
});

async function mkLesson(id, order, extra = {}) {
  return client.lesson.create({
    data: {
      id,
      unitId: unit.id,
      title: `L ${id}`,
      titleAr: `د ${id}`,
      order,
      duration: 90,
      trackScope: "SHARED",
      status: "PUBLISHED",
      isPublished: true,
      curriculumStatus: "OFFICIAL",
      videoUrl: "https://cdn.example/v.mp4",
      pdfUrl: null,
      ...extra,
    },
  });
}

await mkLesson("les-shared", 1, { trackScope: "SHARED" });
await mkLesson("les-ar", 2, { trackScope: "ARABIC" });
await mkLesson("les-lang", 3, { trackScope: "LANGUAGE" });
await mkLesson("les-draft", 4, {
  trackScope: "SHARED",
  status: "DRAFT",
  isPublished: false,
});
await mkLesson("les-second", 5, { trackScope: "SHARED" });

console.log("  seed complete");

// ---------------------------------------------------------------------------
// Compile shipped modules
// ---------------------------------------------------------------------------
const OUT = path.join(WORK, "emit");
fs.mkdirSync(OUT, { recursive: true });
const MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/media.ts",
  "src/lib/session-materials.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/parent-access.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      moduleResolution: "node",
      strict: false,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      rootDir: REPO,
      outDir: OUT,
    },
    files: MODULES.map((f) => path.join(REPO, f)),
  })
);
const tscBin = require.resolve("typescript/bin/tsc");
try {
  execFileSync(process.execPath, [tscBin, "-p", path.join(OUT, "tsconfig.json")], {
    cwd: REPO,
    stdio: "pipe",
  });
} catch {
  /* tolerate */
}
const EMIT = path.join(OUT, "src", "lib");
for (const f of ["media.js", "session-materials.js"]) {
  if (!fs.existsSync(path.join(EMIT, f))) {
    throw new Error(`tsc did not emit ${f}`);
  }
}

const shim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(
  shim,
  'module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n'
);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return shim;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...rest);
};

const Media = require(path.join(EMIT, "media.js"));
const SM = require(path.join(EMIT, "session-materials.js"));

// ---------------------------------------------------------------------------
// Real PDF upload
// ---------------------------------------------------------------------------
console.log("\n-- real file upload --");
const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
);

const upload1 = await SM.uploadLessonPdfMaterial(
  {
    lessonId: "les-shared",
    buffer: PDF_BYTES,
    claimedMime: "application/pdf",
    originalName: "shared-unit1.pdf",
    title: "Shared Unit 1 PDF",
    trackScope: "SHARED",
    actorUserId: "u-admin",
  },
  client
);
ok(upload1.ok === true, `first upload succeeds (${upload1.ok ? "ok" : upload1.code + ": " + upload1.message})`);
if (!upload1.ok) {
  console.error(upload1);
  finish();
}

ok(!!upload1.material?.id, "material id assigned");
ok(!!upload1.material?.mediaAssetId, "media asset id assigned");
eq(upload1.material.trackScope, "SHARED", "trackScope SHARED");
eq(upload1.material.mimeType, "application/pdf", "mime application/pdf");

const assetRow = await client.mediaAsset.findUnique({
  where: { id: upload1.material.mediaAssetId },
});
ok(!!assetRow, "MediaAsset row exists");
eq(assetRow.kind, "DOCUMENT", "kind=DOCUMENT");
eq(assetRow.storage, "LOCAL_PRIVATE", "storage=LOCAL_PRIVATE");
ok(assetRow.isPrivate === true || assetRow.isPrivate === 1, "isPrivate=true");
ok(!!assetRow.storageKey, "storageKey set");
ok(!String(assetRow.storageKey).includes(".."), "storageKey has no traversal");

const storedPath = path.join(MEDIA_ROOT, assetRow.storageKey);
ok(fs.existsSync(storedPath), "private file exists on disk");
ok(
  !storedPath.includes(`${path.sep}public${path.sep}`),
  "file is NOT under public/"
);
const storedBytes = fs.readFileSync(storedPath);
ok(
  storedBytes.slice(0, 5).equals(Buffer.from("%PDF-")),
  "stored bytes begin with %PDF-"
);

const lessonAfter = await client.lesson.findUnique({
  where: { id: "les-shared" },
  select: { pdfUrl: true },
});
eq(lessonAfter.pdfUrl, null, "new pdfUrl writes = 0 (still null)");

const matRow = await client.material.findUnique({
  where: { id: upload1.material.id },
});
ok(matRow.isActive === true || matRow.isActive === 1, "material active");
eq(matRow.kind, "ADMIN_UPLOADED", "kind ADMIN_UPLOADED");
eq(matRow.trackScope, "SHARED", "material trackScope SHARED");

// ---------------------------------------------------------------------------
// Track-specific
// ---------------------------------------------------------------------------
console.log("\n-- track-specific uploads --");
const uploadAr = await SM.uploadLessonPdfMaterial(
  {
    lessonId: "les-ar",
    buffer: PDF_BYTES,
    claimedMime: "application/pdf",
    originalName: "ar.pdf",
    trackScope: "ARABIC",
    actorUserId: "u-admin",
  },
  client
);
ok(uploadAr.ok === true, "AR material uploaded");

const uploadLang = await SM.uploadLessonPdfMaterial(
  {
    lessonId: "les-lang",
    buffer: PDF_BYTES,
    claimedMime: "application/pdf",
    originalName: "lang.pdf",
    trackScope: "LANGUAGE",
    actorUserId: "u-admin",
  },
  client
);
ok(uploadLang.ok === true, "LANG material uploaded");

// ---------------------------------------------------------------------------
// Authorization
// ---------------------------------------------------------------------------
console.log("\n-- authorization matrix --");

const arShared = await SM.authorizeMaterialDownload({
  materialId: upload1.material.id,
  user: { id: "u-ar", role: "STUDENT" },
  client,
});
ok(
  arShared.allowed === true,
  `AR student may download SHARED material (${arShared.allowed ? "ok" : arShared.reason})`
);

const arLang = await SM.authorizeMaterialDownload({
  materialId: uploadLang.material.id,
  user: { id: "u-ar", role: "STUDENT" },
  client,
});
ok(arLang.allowed === false, "AR student denied LANG material");
ok(
  arLang.reason === "TRACK_DENIED" || arLang.reason === "LESSON_NOT_FOUND",
  `AR→LANG fail-closed (${arLang.reason})`
);

const langAr = await SM.authorizeMaterialDownload({
  materialId: uploadAr.material.id,
  user: { id: "u-lang", role: "STUDENT" },
  client,
});
ok(langAr.allowed === false, "LANG student denied AR material");

const langLang = await SM.authorizeMaterialDownload({
  materialId: uploadLang.material.id,
  user: { id: "u-lang", role: "STUDENT" },
  client,
});
ok(
  langLang.allowed === false,
  "LANG student cannot download later-session material before completing prior"
);

const fake = await SM.authorizeMaterialDownload({
  materialId: "does-not-exist",
  user: { id: "u-ar", role: "STUDENT" },
  client,
});
eq(fake.reason, "MATERIAL_NOT_FOUND", "fake material id → MATERIAL_NOT_FOUND");

const unauth = await SM.authorizeMaterialDownload({
  materialId: upload1.material.id,
  user: null,
  client,
});
eq(unauth.reason, "UNAUTHORIZED", "null user → UNAUTHORIZED");

const parentOk = await SM.authorizeMaterialDownload({
  materialId: upload1.material.id,
  user: { id: "u-parent", role: "PARENT" },
  client,
});
ok(
  parentOk.allowed === true,
  `parent of AR child may download SHARED (${parentOk.allowed ? "ok" : parentOk.reason})`
);

const parentLang = await SM.authorizeMaterialDownload({
  materialId: uploadLang.material.id,
  user: { id: "u-parent", role: "PARENT" },
  client,
});
ok(parentLang.allowed === false, "parent of AR child denied LANG material");

const uploadDraft = await SM.uploadLessonPdfMaterial(
  {
    lessonId: "les-draft",
    buffer: PDF_BYTES,
    claimedMime: "application/pdf",
    originalName: "draft.pdf",
    trackScope: "SHARED",
  },
  client
);
ok(uploadDraft.ok === true, "draft lesson can receive material (admin staging)");
const studentDraft = await SM.authorizeMaterialDownload({
  materialId: uploadDraft.material.id,
  user: { id: "u-ar", role: "STUDENT" },
  client,
});
ok(studentDraft.allowed === false, "student denied draft-lesson material");
const parentDraft = await SM.authorizeMaterialDownload({
  materialId: uploadDraft.material.id,
  user: { id: "u-parent", role: "PARENT" },
  client,
});
ok(parentDraft.allowed === false, "parent denied draft-lesson material");
const adminDraft = await SM.authorizeMaterialDownload({
  materialId: uploadDraft.material.id,
  user: { id: "u-admin", role: "ADMIN" },
  client,
});
ok(adminDraft.allowed === true, "admin may review draft-lesson material");

// ---------------------------------------------------------------------------
// Authorized byte read + headers
// ---------------------------------------------------------------------------
console.log("\n-- authorized byte read --");
if (arShared.allowed) {
  const buf = await Media.readPrivateFile(arShared.asset.storageKey);
  ok(buf.slice(0, 5).equals(Buffer.from("%PDF-")), "authorized read returns PDF bytes");
  ok(
    SM.materialContentDisposition(arShared.asset.originalName, false).startsWith(
      "inline"
    ),
    "inline disposition"
  );
  ok(
    SM.materialContentDisposition(arShared.asset.originalName, true).startsWith(
      "attachment"
    ),
    "attachment disposition"
  );
}

// ---------------------------------------------------------------------------
// Replace + refcount
// ---------------------------------------------------------------------------
console.log("\n-- replace + refcount cleanup --");
const oldAssetId = upload1.material.mediaAssetId;
const oldPath = storedPath;

const upload2 = await SM.uploadLessonPdfMaterial(
  {
    lessonId: "les-shared",
    buffer: Buffer.from("%PDF-1.7\n% replace\n%%EOF\n"),
    claimedMime: "application/pdf",
    originalName: "shared-unit1-v2.pdf",
    trackScope: "SHARED",
    actorUserId: "u-admin",
  },
  client
);
ok(upload2.ok === true, "replace upload succeeds");
ok(upload2.replaced.length >= 1, "prior material recorded as replaced");
ok(
  upload2.cleanedUpAssets.includes(oldAssetId),
  "old unreferenced asset cleaned up"
);

const oldMat = await client.material.findUnique({
  where: { id: upload1.material.id },
});
ok(
  oldMat.isActive === false || oldMat.isActive === 0,
  "prior material deactivated"
);

const oldAssetGone = await client.mediaAsset.findUnique({
  where: { id: oldAssetId },
});
ok(!oldAssetGone, "old MediaAsset row deleted");
ok(!fs.existsSync(oldPath), "old private file deleted from disk");

const newAsset = await client.mediaAsset.findUnique({
  where: { id: upload2.material.mediaAssetId },
});
ok(!!newAsset, "new MediaAsset exists");
ok(
  fs.existsSync(path.join(MEDIA_ROOT, newAsset.storageKey)),
  "new file on disk"
);

eq(
  (
    await client.lesson.findUnique({
      where: { id: "les-shared" },
      select: { pdfUrl: true },
    })
  ).pdfUrl,
  null,
  "pdfUrl still null after replace"
);

// Shared asset retention
const sharedAssetId = upload2.material.mediaAssetId;
await client.material.create({
  data: {
    id: "mat-extra-ref",
    lessonId: "les-second",
    kind: "ADMIN_UPLOADED",
    title: "extra ref",
    mediaAssetId: sharedAssetId,
    isActive: true,
    trackScope: "SHARED",
  },
});
const deact = await SM.deactivateMaterial(upload2.material.id, client);
ok(deact.ok === true, "deactivate ok");
const stillThere = await client.mediaAsset.findUnique({
  where: { id: sharedAssetId },
});
ok(!!stillThere, "asset retained while another Material references it");
ok(
  fs.existsSync(path.join(MEDIA_ROOT, stillThere.storageKey)),
  "bytes retained while referenced"
);

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------
console.log("\n-- validation failures --");
const html = await SM.uploadLessonPdfMaterial(
  {
    lessonId: "les-shared",
    buffer: Buffer.from("<!doctype html><html>nope</html>"),
    claimedMime: "application/pdf",
    originalName: "fake.pdf",
  },
  client
);
ok(
  html.ok === false && html.code === "VALIDATION_FAILED",
  "HTML-as-PDF rejected"
);

const empty = await SM.uploadLessonPdfMaterial(
  {
    lessonId: "les-shared",
    buffer: Buffer.alloc(0),
    claimedMime: "application/pdf",
    originalName: "empty.pdf",
  },
  client
);
ok(empty.ok === false, "empty file rejected");

const traversal = await SM.uploadLessonPdfMaterial(
  {
    lessonId: "les-shared",
    buffer: PDF_BYTES,
    claimedMime: "application/pdf",
    originalName: "../../etc/passwd.pdf",
  },
  client
);
if (traversal.ok) {
  const a = await client.mediaAsset.findUnique({
    where: { id: traversal.material.mediaAssetId },
  });
  ok(!a.storageKey.includes(".."), "traversal filename did not escape storage");
  ok(
    a.storageKey.startsWith("session-pdfs/"),
    "storage key still under session-pdfs/"
  );
} else {
  ok(true, "traversal name rejected at validation (also acceptable)");
}

const inactiveAuth = await SM.authorizeMaterialDownload({
  materialId: upload1.material.id,
  user: { id: "u-ar", role: "STUDENT" },
  client,
});
ok(inactiveAuth.allowed === false, "deactivated material denied");
eq(inactiveAuth.reason, "MATERIAL_INACTIVE", "reason MATERIAL_INACTIVE");

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------
console.log("\n-- inventory --");
const matCount = sqlite.prepare(`SELECT COUNT(*) AS c FROM "Material"`).get().c;
const assetCount = sqlite
  .prepare(`SELECT COUNT(*) AS c FROM "MediaAsset"`)
  .get().c;
const activeMats = sqlite
  .prepare(`SELECT COUNT(*) AS c FROM "Material" WHERE isActive = 1`)
  .get().c;
console.log(`  materials total=${matCount} active=${activeMats}`);
console.log(`  media assets=${assetCount}`);
const pdfUrlNonNull = sqlite
  .prepare(
    `SELECT COUNT(*) AS c FROM "Lesson" WHERE pdfUrl IS NOT NULL AND pdfUrl != ''`
  )
  .get().c;
eq(pdfUrlNonNull, 0, "zero lessons with pdfUrl written by this phase");
ok(
  listMigrations().includes(PHASE14),
  "Phase 14 migration is in the migrations directory"
);

finish();

function finish() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Phase 14 DB/file verify: ${pass} passed, ${fail} failed`);
  if (fail === 0) {
    console.log("PHASE14_VERIFY_OK");
    process.exit(0);
  }
  console.log("PHASE14_VERIFY_FAILED");
  process.exit(1);
}
