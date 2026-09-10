// CodeMind Academy — Phase 15 real end-to-end admin workflow verification.
//
// Drives the SHIPPED admin session API (compiled from src/ with the repo's
// own tsc, exactly like scripts/verify-phase13-db.mjs does) against a REAL
// SQLite database built from the base DDL + every real migration.sql, with
// REAL media bytes on a scratch disk. It walks the whole Phase 15 workflow:
//
//   list → create → detail → stage video/PDF → readiness → mark-ready →
//   open → idempotent re-open → unpublish → archive → restore
//
// plus the auth matrix, every 400/404/409 branch the workflow depends on,
// video reuse (re-attach), PDF replace/deactivate + byte-level download,
// FIXED/RANDOM pin display, and the question-bank pool math.
//
// What is REAL here: the migration SQL, the schema, the compiled route
// handlers, the lifecycle/readiness/materials/progress libraries, the media
// bytes, the audit/publication rows. What is SHIMMED (and why):
//   * `@/lib/db`          → sqlite-prisma-lite over node:sqlite (the Prisma
//                            query engine binary is unreachable from this
//                            sandbox; the adapter executes real SQL and throws
//                            UnsupportedQuery instead of approximating).
//   * `@/lib/auth`         → script-controlled current user (no cookie stack
//                            in a script; requireRole still runs for real).
//   * `next/server`        → minimal NextResponse (status/headers/json/bytes).
//     NOTE: the shim returns LIVE objects (Date stays Date); production
//     serialises to JSON. Assertions therefore never depend on serialisation.
//   * `next/headers`       → no locale cookie (server falls back to `ar`).
//
// Exit code 0 + `0 failed` iff every assertion holds. Section Q of
// tests/admin-publishing-phase15.test.js executes this file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

// Media env MUST be set before the compiled media.js module loads (it reads
// these at import time, exactly like production).
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase15-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_DIR;
process.env.MEDIA_MAX_VIDEO_BYTES = String(4096); // small on purpose: 413 test

const { DatabaseSync } = require("node:sqlite");
const mig = require("./lib/migrate-sqlite.mjs");
const { createSqlitePrisma } = require("./lib/sqlite-prisma-lite.mjs");

// ---------------------------------------------------------------------------
// assertion plumbing
// ---------------------------------------------------------------------------

let passed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL - ${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
}
function eq(a, b, label) {
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`
  );
}

// ---------------------------------------------------------------------------
// A. scratch database: base DDL + every real migration
// ---------------------------------------------------------------------------

const SCHEMA_TABLES = [
  "User",
  "Course",
  "Part",
  "Unit",
  "Topic",
  "Lesson",
  "Quiz",
  "Question",
  "Homework",
  "Batch",
  "MediaAsset",
  "SessionVideo",
  "Material",
  "SessionPublication",
  "AuditLog",
  "MockExam",
  "MockExamQuestion",
  "Track",
  "Enrollment",
];

const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase15: " });
for (const d of mig.assertColumnsMatchSchema(rawDb, SCHEMA_TABLES)) {
  ok(
    d.declared && d.missing.length === 0 && d.extra.length === 0,
    `A: ${d.table} columns match prisma/schema.prisma`,
    JSON.stringify({ missing: d.missing, extra: d.extra })
  );
}

const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// B. compile the shipped TypeScript with the repo's own tsc; load with shims
// ---------------------------------------------------------------------------

const REAL_CODE_MODULES = [
  // libraries (dependency order does not matter to tsc, listed for humans)
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/media.ts",
  "src/lib/enrollment.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/parent-access.ts",
  "src/lib/session-materials.ts",
  "src/lib/admin-sessions.ts",
  "src/lib/api.ts",
  // route handlers under test
  "src/app/api/admin/lessons/route.ts",
  "src/app/api/admin/lessons/[id]/route.ts",
  "src/app/api/admin/lessons/[id]/readiness/route.ts",
  "src/app/api/admin/lessons/[id]/mark-ready/route.ts",
  "src/app/api/admin/lessons/[id]/open/route.ts",
  "src/app/api/admin/lessons/[id]/unpublish/route.ts",
  "src/app/api/admin/lessons/[id]/archive/route.ts",
  "src/app/api/admin/lessons/[id]/materials/route.ts",
  "src/app/api/materials/[id]/route.ts",
  "src/app/api/admin/session-videos/route.ts",
  "src/app/api/admin/session-videos/[id]/route.ts",
  "src/app/api/admin/mock-exams/route.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase15-real-"));
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
  const tscBin = require.resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], {
      cwd: REPO,
      stdio: "pipe",
    });
  } catch {
    /* type noise elsewhere in the graph is tolerated; the emitted files matter */
  }
  for (const f of REAL_CODE_MODULES) {
    const emitted = path.join(out, f.replace(/\.ts$/, ".js"));
    if (!fs.existsSync(emitted)) {
      throw new Error(`tsc did not emit ${f}`);
    }
  }
  return out;
}

const NEXT_SERVER_SHIM = `
class NextResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this._headers = new Map();
    const h = init.headers || {};
    for (const [k, v] of Object.entries(h)) this._headers.set(String(k).toLowerCase(), String(v));
    this._body = body;
    this._json = undefined;
  }
  static json(data, init = {}) {
    const r = new NextResponse(JSON.stringify(data), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
    r._json = data;
    return r;
  }
  get headers() {
    const m = this._headers;
    return { get: (k) => m.get(String(k).toLowerCase()) ?? null };
  }
  async json() {
    if (this._json !== undefined) return this._json;
    return JSON.parse(Buffer.from(this._body || []).toString("utf8"));
  }
  async arrayBuffer() {
    const b = Buffer.isBuffer(this._body) ? this._body : Buffer.from(this._body ?? []);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}
class NextRequest {}
module.exports = { NextResponse, NextRequest };
`;

const NEXT_HEADERS_SHIM = `
module.exports = { cookies: async () => ({ get: () => undefined }) };
`;

const AUTH_SHIM = `
module.exports = { getCurrentUser: async () => globalThis.__CM_USER__ ?? null };
`;

const DB_SHIM = `
module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };
`;

function loadRealCode(outDir) {
  const { Module } = require("module");
  const files = {
    db: path.join(outDir, "__db-shim.js"),
    auth: path.join(outDir, "__auth-shim.js"),
    nextServer: path.join(outDir, "__next-server-shim.js"),
    nextHeaders: path.join(outDir, "__next-headers-shim.js"),
  };
  fs.writeFileSync(files.db, DB_SHIM);
  fs.writeFileSync(files.auth, AUTH_SHIM);
  fs.writeFileSync(files.nextServer, NEXT_SERVER_SHIM);
  fs.writeFileSync(files.nextHeaders, NEXT_HEADERS_SHIM);
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return files.db;
    if (request === "@/lib/auth") return files.auth;
    if (request === "next/server") return files.nextServer;
    if (request === "next/headers") return files.nextHeaders;
    const m = /^@\/lib\/([\w-]+)$/.exec(request);
    if (m) {
      const compiled = path.join(outDir, "src/lib", `${m[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    return originalResolve.call(this, request, ...rest);
  };
  const route = (p) => require(path.join(outDir, "src/app/api", p));
  return {
    restore() {
      Module._resolveFilename = originalResolve;
    },
    lessons: route("admin/lessons/route.js"),
    lessonById: route("admin/lessons/[id]/route.js"),
    readiness: route("admin/lessons/[id]/readiness/route.js"),
    markReady: route("admin/lessons/[id]/mark-ready/route.js"),
    open: route("admin/lessons/[id]/open/route.js"),
    unpublish: route("admin/lessons/[id]/unpublish/route.js"),
    archive: route("admin/lessons/[id]/archive/route.js"),
    lessonMaterials: route("admin/lessons/[id]/materials/route.js"),
    materialDownload: route("materials/[id]/route.js"),
    videos: route("admin/session-videos/route.js"),
    videoById: route("admin/session-videos/[id]/route.js"),
    mockExams: route("admin/mock-exams/route.js"),
  };
}

// ---------------------------------------------------------------------------
// HTTP-lite driver
// ---------------------------------------------------------------------------

function jsonReq(url, body) {
  return {
    url,
    method: "GET",
    headers: {
      get: (k) =>
        String(k).toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => body,
    formData: async () => {
      throw new Error("no form body");
    },
  };
}

function formReq(url, form) {
  return {
    url,
    method: "POST",
    headers: {
      get: (k) =>
        String(k).toLowerCase() === "content-type"
          ? "multipart/form-data; boundary=----cmtest"
          : null,
    },
    json: async () => ({}),
    formData: async () => form,
  };
}

function asUser(u) {
  globalThis.__CM_USER__ = u
    ? { id: u.id, email: u.email, name: u.name, role: u.role }
    : null;
}

async function call(handler, req, params) {
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  const ct = res.headers?.get?.("content-type") || "";
  if (ct.includes("application/json")) {
    return { status: res.status, json: await res.json(), headers: res.headers };
  }
  return {
    status: res.status,
    bytes: Buffer.from(await res.arrayBuffer()),
    headers: res.headers,
  };
}

const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);
const PATCH_JSON = (r, url, body, params) =>
  call(r.PATCH, jsonReq(url, body), params);
const POST_FORM = (r, url, form, params) => call(r.POST, formReq(url, form), params);
const DELETE = (r, url, params) => call(r.DELETE, jsonReq(url), params);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const outDir = compileRealCode();
  ok(true, "B: shipped TS compiled with the repo tsc");
  const R = loadRealCode(outDir);
  ok(true, "B: route handlers loaded with db/auth/next shims");

  // ---- C. seed ------------------------------------------------------------
  const admin = await client.user.create({
    data: { email: "admin@cm.test", password: "x", name: "Admin", role: "ADMIN" },
  });
  const teacher = await client.user.create({
    data: { email: "teacher@cm.test", password: "x", name: "Teacher", role: "TEACHER" },
  });
  const student = await client.user.create({
    data: { email: "student@cm.test", password: "x", name: "Student", role: "STUDENT" },
  });

  const course = await client.course.create({
    data: { slug: "p15", name: "P15", nameAr: "P15", description: "phase 15" },
  });
  const part1 = await client.part.create({
    data: { courseId: course.id, title: "P1", titleAr: "P1", order: 1 },
  });
  const part2 = await client.part.create({
    data: { courseId: course.id, title: "P2", titleAr: "P2", order: 2 },
  });
  const unitU = await client.unit.create({
    data: { partId: part1.id, title: "U", titleAr: "U", order: 1 },
  });
  const unitU2 = await client.unit.create({
    data: { partId: part2.id, title: "U2", titleAr: "U2", order: 1 },
  });
  const topicT = await client.topic.create({
    data: { unitId: unitU.id, title: "T", titleAr: "T", order: 1 },
  });

  // The lifecycle mirror for a DRAFT is isPublished=false (the ceremony owns
  // the mirror; hand seeds spell the steady state explicitly).
  const LA = await client.lesson.create({
    data: {
      unitId: unitU.id, title: "Arabic session", titleAr: "حصة عربي",
      order: 1, trackScope: "ARABIC", isPublished: false,
    },
  });
  const LS = await client.lesson.create({
    data: {
      unitId: unitU.id, title: "Shared session", titleAr: "حصة مشتركة",
      order: 2, trackScope: "SHARED", isPublished: false,
    },
  });
  const LE = await client.lesson.create({
    data: {
      unitId: unitU2.id, title: "Empty session", titleAr: "حصة فارغة",
      order: 1, trackScope: "SHARED", isPublished: false,
    },
  });
  const LL = await client.lesson.create({
    data: {
      unitId: null, topicId: topicT.id, title: "Legacy chain", titleAr: "سلسلة قديمة",
      order: 1, trackScope: "SHARED", isPublished: false,
    },
  });

  const batchAr = await client.batch.create({
    data: { name: "Batch AR", nameAr: "دفعة عربي", schoolType: "ARABIC" },
  });
  const batchLang = await client.batch.create({
    data: { name: "Batch LANG", nameAr: "دفعة لغات", schoolType: "LANGUAGE" },
  });

  const quiz1 = await client.quiz.create({
    data: { lessonId: LA.id, title: "Q1", titleAr: "Q1", trackScope: "SHARED" },
  });
  await client.question.create({
    data: { quizId: quiz1.id, prompt: "p1", options: '["a","b"]', answer: "a" },
  });
  await client.question.create({
    data: { quizId: quiz1.id, prompt: "p2", options: '["a","b"]', answer: "b" },
  });
  await client.homework.create({
    data: {
      lessonId: LA.id, title: "H1", titleAr: "H1", trackScope: "SHARED",
      instructions: "Solve exercises 1-5 and show your work.",
      deadline: new Date(Date.now() + 7 * 864e5),
    },
  });

  // LE carries the two INVALID-but-informative attachments: an empty quiz and
  // a homework row without instructions.
  await client.quiz.create({
    data: { lessonId: LE.id, title: "QE", titleAr: "QE", trackScope: "SHARED" },
  });
  await client.homework.create({
    data: {
      lessonId: LE.id, title: "HE", titleAr: "HE", trackScope: "SHARED",
      instructions: null, deadline: new Date(Date.now() + 7 * 864e5),
    },
  });

  // Question bank: 4 ARABIC + 3 LANGUAGE standalone rows. questionBankFilter
  // counts `{ schoolType } OR NULL`, so the two null-schoolType quiz questions
  // above join BOTH pools: ARABIC 4+2=6, LANGUAGE 3+2=5.
  const bankAr = [];
  for (let i = 0; i < 4; i++) {
    bankAr.push(
      await client.question.create({
        data: {
          prompt: `bank-ar-${i}`, options: '["a","b"]', answer: "a",
          schoolType: "ARABIC",
        },
      })
    );
  }
  for (let i = 0; i < 3; i++) {
    await client.question.create({
      data: {
        prompt: `bank-lang-${i}`, options: '["a","b"]', answer: "a",
        schoolType: "LANGUAGE",
      },
    });
  }
  const mxFixed = await client.mockExam.create({
    data: {
      title: "Fixed exam", titleAr: "امتحان ثابت", schoolType: "ARABIC",
      selectionMode: "FIXED",
    },
  });
  for (let i = 0; i < 3; i++) {
    await client.mockExamQuestion.create({
      data: { mockExamId: mxFixed.id, questionId: bankAr[i].id, order: i + 1 },
    });
  }
  await client.mockExam.create({
    data: {
      title: "Random exam", titleAr: "امتحان عشوائي", schoolType: "LANGUAGE",
      selectionMode: "RANDOM",
    },
  });
  ok(true, "C: seeded users, chain, lessons, batches, quiz, homework, bank, mocks");

  asUser(admin);

  // ---- Q01-Q06: list --------------------------------------------------------
  {
    const r = await GET(R.lessons, "http://t/api/admin/lessons");
    eq(r.status, 200, "Q01: list 200");
    eq(r.json.lessons.map((l) => l.id), [LA.id, LS.id, LE.id, LL.id], "Q01: canonical+legacy order");
    eq(
      r.json.pagination,
      { page: 1, pageSize: 50, total: 4, totalPages: 1, hasMore: false },
      "Q01: pagination"
    );
    const first = r.json.lessons[0];
    ok(
      first.counts && first.legacy && first.identity && first.identity.course.id === course.id,
      "Q01: rows carry counts, legacy flags, resolved identity"
    );
    eq(first.identity.unit.id, unitU.id, "Q01: canonical chain wins for LA");
    eq(
      r.json.lessons[3].identity.unit.id,
      unitU.id,
      "Q01: legacy chain resolves through topic for LL"
    );
  }
  {
    const r = await GET(R.lessons, "http://t/api/admin/lessons?trackScope=ARABIC");
    eq(r.status, 200, "Q02: trackScope filter 200");
    eq(r.json.lessons.map((l) => l.id), [LA.id], "Q02: only ARABIC");
    const bad = await GET(R.lessons, "http://t/api/admin/lessons?trackScope=BOGUS");
    eq(bad.status, 400, "Q03: bad trackScope 400");
    eq(bad.json.error, "INVALID_TRACK_SCOPE:trackScope", "Q03: exact code");
    const st = await GET(R.lessons, "http://t/api/admin/lessons?status=DRAFT");
    eq(st.json.pagination.total, 4, "Q04: status=DRAFT matches all");
    const stBad = await GET(R.lessons, "http://t/api/admin/lessons?status=BOGUS");
    eq(stBad.status, 400, "Q04: bad status 400");
    eq(stBad.json.error, "INVALID_STATUS:status", "Q04: exact code");
    const q = await GET(
      R.lessons,
      `http://t/api/admin/lessons?q=${encodeURIComponent("عربي")}`
    );
    eq(q.json.lessons.map((l) => l.id), [LA.id], "Q05: Arabic title search");
    const p2 = await GET(R.lessons, "http://t/api/admin/lessons?page=2&pageSize=2");
    eq(p2.json.lessons.map((l) => l.id), [LE.id, LL.id], "Q05: page 2");
    eq(p2.json.pagination.hasMore, false, "Q05: hasMore false at end");
    const big = await GET(R.lessons, "http://t/api/admin/lessons?pageSize=500");
    eq(big.status, 200, "Q05: oversize pageSize clamped, not rejected");
    eq(big.json.pagination.pageSize, 200, "Q05: clamped to max 200");
    const zero = await GET(R.lessons, "http://t/api/admin/lessons?pageSize=0");
    eq(zero.status, 400, "Q05: zero pageSize 400");
    eq(zero.json.error, "INVALID_PAGE_SIZE:pageSize", "Q05: exact code");
  }
  {
    const r = await GET(R.lessons, "http://t/api/admin/lessons?includeReadiness=1");
    eq(r.status, 200, "Q06: includeReadiness 200");
    const la = r.json.lessons.find((l) => l.id === LA.id);
    eq(la.readiness.canBeReady, false, "Q06: LA not ready before staging");
    eq(la.readiness.blocking, ["VIDEO_MISSING"], "Q06: only VIDEO_MISSING blocks LA");
    eq(la.readiness.publication, null, "Q06: no publication yet");
  }
  {
    asUser(teacher);
    const t = await GET(R.lessons, "http://t/api/admin/lessons");
    eq(t.status, 403, "Q06b: teacher forbidden on admin list");
    asUser(student);
    const s = await GET(R.lessons, "http://t/api/admin/lessons");
    eq(s.status, 403, "Q06b: student forbidden on admin list");
    asUser(null);
    const anon = await GET(R.lessons, "http://t/api/admin/lessons");
    eq(anon.status, 401, "Q06b: anonymous 401 on admin list");
    asUser(admin);
  }

  // ---- Q07-Q12: create ------------------------------------------------------
  let LC;
  {
    const r = await POST_JSON(R.lessons, "http://t/api/admin/lessons", {
      title: "Created session",
      titleAr: "حصة منشأة",
      unitId: unitU.id,
      trackScope: "LANGUAGE",
    });
    eq(r.status, 201, "Q07: create 201");
    LC = r.json.lesson;
    eq(LC.status, "DRAFT", "Q07: DRAFT");
    eq(LC.curriculumStatus, "LEGACY", "Q07: LEGACY standing");
    eq(LC.officialCode, null, "Q07: no officialCode");
    eq(LC.unitId, unitU.id, "Q07: canonical chain");
    const row = await client.lesson.findUnique({ where: { id: LC.id } });
    eq(row.topicId, null, "Q07: never topic-linked");
    eq(row.isPublished, false, "Q07: mirror synchronised to DRAFT");
    const audit = await client.auditLog.findFirst({
      where: { action: "LESSON_CREATE", entityId: LC.id },
    });
    ok(!!audit && audit.userId === admin.id, "Q07: LESSON_CREATE audit");
  }
  {
    const noTitle = await POST_JSON(R.lessons, "http://t/api/admin/lessons", {
      titleAr: "x",
      unitId: unitU.id,
    });
    eq(noTitle.status, 400, "Q08: missing title 400");
    ok(
      String(noTitle.json.error).includes("TITLE_REQUIRED"),
      "Q08: TITLE_REQUIRED code"
    );
    const badScope = await POST_JSON(R.lessons, "http://t/api/admin/lessons", {
      title: "x",
      titleAr: "x",
      unitId: unitU.id,
      trackScope: "KLINGON",
    });
    eq(badScope.status, 400, "Q09: bad trackScope 400");
    ok(
      String(badScope.json.error).includes("INVALID_TRACK_SCOPE"),
      "Q09: exact code"
    );
    const forbidden = await POST_JSON(R.lessons, "http://t/api/admin/lessons", {
      title: "x",
      titleAr: "x",
      unitId: unitU.id,
      status: "PUBLISHED",
    });
    eq(forbidden.status, 400, "Q09: forbidden field 400");
    eq(forbidden.json.error, "FORBIDDEN_FIELD:status", "Q09: exact code");
    const noUnit = await POST_JSON(R.lessons, "http://t/api/admin/lessons", {
      title: "x",
      titleAr: "x",
      unitId: "unit-does-not-exist",
    });
    eq(noUnit.status, 404, "Q09: unknown unit 404");
    eq(noUnit.json.error, "UNIT_NOT_FOUND", "Q09: exact code");
  }
  {
    const before = await client.lesson.aggregate({
      where: { unitId: unitU.id },
      _max: { order: true },
    });
    const r = await POST_JSON(R.lessons, "http://t/api/admin/lessons", {
      title: "Auto order",
      titleAr: "ترتيب تلقائي",
      unitId: unitU.id,
    });
    eq(r.status, 201, "Q10: auto-order create 201");
    eq(r.json.lesson.order, (before._max.order ?? 0) + 1, "Q10: max+1 assigned");
    asUser(teacher);
    const t = await POST_JSON(R.lessons, "http://t/api/admin/lessons", {
      title: "x",
      titleAr: "x",
      unitId: unitU.id,
    });
    eq(t.status, 403, "Q11: teacher cannot create");
    asUser(null);
    const anon = await POST_JSON(R.lessons, "http://t/api/admin/lessons", {
      title: "x",
      titleAr: "x",
      unitId: unitU.id,
    });
    eq(anon.status, 401, "Q11: anonymous cannot create");
    asUser(admin);
  }

  // ---- Q13-Q17: detail + patch ----------------------------------------------
  {
    const r = await GET(R.lessonById, `http://t/api/admin/lessons/${LA.id}`, {
      id: LA.id,
    });
    eq(r.status, 200, "Q13: detail 200");
    eq(r.json.quizzes.length, 1, "Q13: one quiz");
    eq(r.json.quizzes[0].questionCount, 2, "Q13: questionCount 2");
    eq(r.json.homeworks.length, 1, "Q13: one homework");
    eq(r.json.homeworks[0].hasInstructions, true, "Q13: hasInstructions");
    eq(
      r.json.homeworks[0].instructions,
      "Solve exercises 1-5 and show your work.",
      "Q13: instructions text"
    );
    eq(r.json.sessionVideos, [], "Q13: no videos yet");
    eq(r.json.materials, [], "Q13: no materials yet");
    eq(r.json.readiness.blocking, ["VIDEO_MISSING"], "Q13: readiness agrees");
    eq(r.json.publication, null, "Q13: no publication");
    const missing = await GET(R.lessonById, "http://t/api/admin/lessons/nope", {
      id: "nope",
    });
    eq(missing.status, 404, "Q14: unknown lesson 404");
  }
  {
    const r = await GET(R.lessonById, `http://t/api/admin/lessons/${LE.id}`, {
      id: LE.id,
    });
    eq(
      [...r.json.readiness.blocking].sort(),
      ["HOMEWORK_INSTRUCTIONS_EMPTY", "QUIZ_EMPTY", "VIDEO_MISSING"].sort(),
      "Q15: empty quiz + missing instructions block"
    );
  }
  {
    const r = await PATCH_JSON(
      R.lessonById,
      `http://t/api/admin/lessons/${LA.id}`,
      { title: "Arabic session v2", trackScope: "SHARED" },
      { id: LA.id }
    );
    eq(r.status, 200, "Q16: patch 200");
    eq(r.json.touched.sort(), ["title", "trackScope"].sort(), "Q16: touched keys");
    eq(r.json.lesson.title, "Arabic session v2", "Q16: title applied");
    eq(r.json.lesson.trackScope, "SHARED", "Q16: scope applied");
    eq(r.json.lesson.status, "DRAFT", "Q16: status untouched");
    // LA becomes SHARED here, so the single ARABIC video staged later leaves
    // the LANGUAGE batch uncovered — the verdict below proves the rule.
    const back = await PATCH_JSON(
      R.lessonById,
      `http://t/api/admin/lessons/${LA.id}`,
      { trackScope: "ARABIC" },
      { id: LA.id }
    );
    eq(back.json.lesson.trackScope, "ARABIC", "Q16: scope restored for ceremony");
    const bad = await PATCH_JSON(
      R.lessonById,
      `http://t/api/admin/lessons/${LA.id}`,
      { status: "PUBLISHED" },
      { id: LA.id }
    );
    eq(bad.status, 400, "Q17: status write refused");
    eq(bad.json.error, "FORBIDDEN_FIELD:status", "Q17: exact code");
    const empty = await PATCH_JSON(
      R.lessonById,
      `http://t/api/admin/lessons/${LA.id}`,
      {},
      { id: LA.id }
    );
    eq(empty.status, 400, "Q17: empty patch 400");
    eq(empty.json.error, "NOTHING_TO_UPDATE", "Q17: exact code");
    const missing = await PATCH_JSON(
      R.lessonById,
      "http://t/api/admin/lessons/nope",
      { title: "x" },
      { id: "nope" }
    );
    eq(missing.status, 404, "Q17: unknown lesson 404");
  }

  // ---- Q18-Q21: PDF staging + download --------------------------------------
  const PDF_BYTES = Buffer.from(
    "%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
    "utf8"
  );
  let matId;
  {
    const form = new FormData();
    form.set("file", new File([PDF_BYTES], "notes.pdf", { type: "application/pdf" }));
    form.set("title", "Session notes");
    const r = await POST_FORM(
      R.lessonMaterials,
      `http://t/api/admin/lessons/${LA.id}/materials`,
      form,
      { id: LA.id }
    );
    eq(r.status, 200, "Q18: PDF upload 200");
    eq(r.json.material.kind, "ADMIN_UPLOADED", "Q18: kind");
    eq(r.json.material.trackScope, "ARABIC", "Q18: scope inherited from lesson");
    eq(r.json.pdfUrlWritten, false, "Q18: contract marker");
    matId = r.json.material.id;
    const row = await client.material.findUnique({ where: { id: matId } });
    ok(!!row && row.isActive, "Q18: material row active");
    const asset = await client.mediaAsset.findUnique({
      where: { id: row.mediaAssetId },
    });
    eq(asset.storage, "LOCAL_PRIVATE", "Q18: private storage");
    ok(
      fs.existsSync(path.join(MEDIA_DIR, asset.storageKey)),
      "Q18: bytes on scratch disk"
    );
    const lesson = await client.lesson.findUnique({ where: { id: LA.id } });
    eq(lesson.pdfUrl, null, "Q18: Lesson.pdfUrl never written");
  }
  {
    const badForm = new FormData();
    badForm.set(
      "file",
      new File(["this is not a pdf"], "notes.pdf", { type: "application/pdf" })
    );
    const bad = await POST_FORM(
      R.lessonMaterials,
      `http://t/api/admin/lessons/${LA.id}/materials`,
      badForm,
      { id: LA.id }
    );
    eq(bad.status, 415, "Q19: non-PDF bytes rejected");
    const emptyForm = new FormData();
    const missing = await POST_FORM(
      R.lessonMaterials,
      `http://t/api/admin/lessons/${LA.id}/materials`,
      emptyForm,
      { id: LA.id }
    );
    eq(missing.status, 400, "Q19: missing file 400");
    const scopeForm = new FormData();
    scopeForm.set("file", new File([PDF_BYTES], "n.pdf", { type: "application/pdf" }));
    scopeForm.set("trackScope", "KLINGON");
    const scopeBad = await POST_FORM(
      R.lessonMaterials,
      `http://t/api/admin/lessons/${LA.id}/materials`,
      scopeForm,
      { id: LA.id }
    );
    eq(scopeBad.status, 400, "Q19: bad trackScope 400");
  }
  {
    const r = await GET(
      R.lessonMaterials,
      `http://t/api/admin/lessons/${LA.id}/materials`,
      { id: LA.id }
    );
    eq(r.status, 200, "Q20: materials list 200");
    eq(r.json.materials.length, 1, "Q20: one material");
    eq(
      r.json.materials[0].downloadUrl,
      `/api/materials/${matId}`,
      "Q20: downloadUrl"
    );
    ok(!("storageKey" in r.json.materials[0]), "Q20: no storageKey in object");
    ok(!JSON.stringify(r.json).includes("storageKey"), "Q20: no storageKey in payload");
  }
  {
    const r = await GET(R.materialDownload, `http://t/api/materials/${matId}`, {
      id: matId,
    });
    eq(r.status, 200, "Q21: admin download 200");
    ok(r.bytes.equals(PDF_BYTES), "Q21: bytes identical");
    eq(r.headers.get("content-type"), "application/pdf", "Q21: content type");
    ok(
      String(r.headers.get("content-disposition")).startsWith("inline"),
      "Q21: inline disposition"
    );
    const dl = await GET(R.materialDownload, `http://t/api/materials/${matId}?download=1`, {
      id: matId,
    });
    ok(
      String(dl.headers.get("content-disposition")).startsWith("attachment"),
      "Q21: attachment on ?download=1"
    );
    asUser(null);
    const anon = await GET(R.materialDownload, `http://t/api/materials/${matId}`, {
      id: matId,
    });
    eq(anon.status, 401, "Q21: anonymous download 401");
    asUser(admin);
    const missing = await GET(R.materialDownload, "http://t/api/materials/nope", {
      id: "nope",
    });
    eq(missing.status, 404, "Q21: unknown material 404");
  }

  // ---- Q22-Q24: video staging + reuse ----------------------------------------
  const MP4_BYTES = Buffer.from([
    0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d,
  ]);
  let videoId;
  let videoAssetId;
  {
    const form = new FormData();
    form.set("batchId", batchAr.id);
    form.set("lessonId", LA.id);
    form.set("title", "Session recording");
    form.set("publish", "true");
    form.set("file", new File([MP4_BYTES], "clip.mp4", { type: "video/mp4" }));
    const r = await POST_FORM(R.videos, "http://t/api/admin/session-videos", form);
    eq(r.status, 200, "Q22: video upload 200");
    eq(r.json.video.isPublished, true, "Q22: published flag");
    ok(!!r.json.video.publishedAt, "Q22: publishedAt stamped");
    eq(r.json.video.lessonId, LA.id, "Q22: attached to LA");
    videoId = r.json.video.id;
    videoAssetId = r.json.video.mediaAssetId;
    const asset = await client.mediaAsset.findUnique({ where: { id: videoAssetId } });
    eq(asset.kind, "VIDEO", "Q22: asset kind");
    ok(
      fs.existsSync(path.join(MEDIA_DIR, asset.storageKey)),
      "Q22: video bytes on scratch disk"
    );
  }
  {
    const badBatch = await POST_JSON(R.videos, "http://t/api/admin/session-videos", {
      batchId: "nope",
      title: "x",
      videoUrl: "https://example.com/v.mp4",
    });
    eq(badBatch.status, 404, "Q23: unknown batch 404");
    const noTitle = await POST_JSON(R.videos, "http://t/api/admin/session-videos", {
      batchId: batchAr.id,
      videoUrl: "https://example.com/v.mp4",
    });
    eq(noTitle.status, 400, "Q23: missing title 400");
    const bigForm = new FormData();
    bigForm.set("batchId", batchAr.id);
    bigForm.set("title", "big");
    bigForm.set(
      "file",
      new File([Buffer.alloc(5000)], "big.mp4", { type: "video/mp4" })
    );
    const big = await POST_FORM(R.videos, "http://t/api/admin/session-videos", bigForm);
    eq(big.status, 413, "Q23: oversize video 413");
  }
  {
    // Reuse = re-attach the ONE published row to another lesson; no bytes move.
    const moved = await PATCH_JSON(
      R.videoById,
      `http://t/api/admin/session-videos/${videoId}`,
      { lessonId: LS.id },
      { id: videoId }
    );
    eq(moved.status, 200, "Q24: reuse PATCH 200");
    eq(moved.json.video.lessonId, LS.id, "Q24: now attached to LS");
    const laReady = await GET(
      R.readiness,
      `http://t/api/admin/lessons/${LA.id}/readiness`,
      { id: LA.id }
    );
    eq(laReady.json.readiness.blocking, ["VIDEO_MISSING"], "Q24: LA lost its video");
    const lsReady = await GET(
      R.readiness,
      `http://t/api/admin/lessons/${LS.id}/readiness`,
      { id: LS.id }
    );
    ok(
      lsReady.json.readiness.blocking.includes("VIDEO_TRACK_INCOMPLETE"),
      "Q24: SHARED lesson needs both batches"
    );
    ok(
      lsReady.json.readiness.notes.includes("SHARED_VIDEO_MISSING_BATCH:LANGUAGE"),
      "Q24: missing-batch note names LANGUAGE"
    );
    const back = await PATCH_JSON(
      R.videoById,
      `http://t/api/admin/session-videos/${videoId}`,
      { lessonId: LA.id },
      { id: videoId }
    );
    eq(back.json.video.lessonId, LA.id, "Q24: video restored to LA");
    const laReady2 = await GET(
      R.readiness,
      `http://t/api/admin/lessons/${LA.id}/readiness`,
      { id: LA.id }
    );
    eq(laReady2.json.readiness.blocking, [], "Q24: LA fully ready");
    eq(laReady2.json.readiness.canBeReady, true, "Q24: canBeReady true");
    const codes = Object.fromEntries(
      laReady2.json.readiness.items.map((i) => [i.key, i.code])
    );
    eq(
      codes,
      {
        VIDEO: "VIDEO_OK",
        PDF: "PDF_PRESENT_NOT_REQUIRED",
        QUIZ: "QUIZ_OK",
        HOMEWORK: "HOMEWORK_OK",
      },
      "Q24: item codes"
    );
  }

  // ---- Q25-Q32: the ceremony --------------------------------------------------
  {
    const r = await POST_JSON(
      R.markReady,
      `http://t/api/admin/lessons/${LA.id}/mark-ready`,
      {},
      { id: LA.id }
    );
    eq(r.status, 200, "Q25: mark-ready 200");
    eq(r.json.code, "OK", "Q25: code OK");
    eq([r.json.from, r.json.to], ["DRAFT", "READY"], "Q25: DRAFT→READY");
    eq(r.json.readiness.canBeReady, true, "Q25: checklist travels with verdict");
    const row = await client.lesson.findUnique({ where: { id: LA.id } });
    eq(row.status, "READY", "Q25: DB status READY");
    eq(row.isPublished, false, "Q25: mirror stays false");
    const auditsAfterFirst = await client.auditLog.count({ where: { entityId: LA.id } });
    const ceremonyAudit = await client.auditLog.findFirst({
      where: { entityId: LA.id, action: "LESSON_MARK_READY" },
    });
    ok(!!ceremonyAudit, "Q25: LESSON_MARK_READY audit written");
    const again = await POST_JSON(
      R.markReady,
      `http://t/api/admin/lessons/${LA.id}/mark-ready`,
      {},
      { id: LA.id }
    );
    eq(again.status, 200, "Q26: replay 200");
    eq(again.json.code, "NO_OP_ALREADY_IN_STATE", "Q26: idempotent code");
    eq(again.json.changed, false, "Q26: changed false");
    const auditsAfter = await client.auditLog.count({ where: { entityId: LA.id } });
    eq(auditsAfter, auditsAfterFirst, "Q26: replay writes nothing");
  }
  {
    const r = await POST_JSON(
      R.markReady,
      `http://t/api/admin/lessons/${LE.id}/mark-ready`,
      {},
      { id: LE.id }
    );
    eq(r.status, 409, "Q27: blocked mark-ready 409");
    eq(r.json.code, "READINESS_BLOCKED", "Q27: exact code");
    eq(
      [...r.json.readiness.blocking].sort(),
      ["HOMEWORK_INSTRUCTIONS_EMPTY", "QUIZ_EMPTY", "VIDEO_MISSING"].sort(),
      "Q27: refusal names every blocker"
    );
    const row = await client.lesson.findUnique({ where: { id: LE.id } });
    eq(row.status, "DRAFT", "Q27: failed ceremony writes nothing");
  }
  {
    // Readiness is re-evaluated from LIVE rows at OPEN: regress the video
    // after mark-ready and the ceremony refuses with the fresh checklist.
    const off = await PATCH_JSON(
      R.videoById,
      `http://t/api/admin/session-videos/${videoId}`,
      { isPublished: false },
      { id: videoId }
    );
    eq(off.json.video.isPublished, false, "Q28b: video unpublished");
    const refused = await POST_JSON(
      R.open,
      `http://t/api/admin/lessons/${LA.id}/open`,
      {},
      { id: LA.id }
    );
    eq(refused.status, 409, "Q28b: OPEN re-checks readiness live");
    eq(refused.json.code, "READINESS_BLOCKED", "Q28b: exact code");
    eq(refused.json.readiness.blocking, ["VIDEO_MISSING"], "Q28b: fresh blocker");
    const on = await PATCH_JSON(
      R.videoById,
      `http://t/api/admin/session-videos/${videoId}`,
      { isPublished: true },
      { id: videoId }
    );
    eq(on.json.video.isPublished, true, "Q28b: video re-published");
  }
  {
    const r = await POST_JSON(R.open, `http://t/api/admin/lessons/${LA.id}/open`, {}, {
      id: LA.id,
    });
    eq(r.status, 200, "Q28: open 200");
    eq(r.json.code, "OK", "Q28: code OK");
    eq([r.json.from, r.json.to], ["READY", "PUBLISHED"], "Q28: READY→PUBLISHED");
    ok(!!r.json.publication && !!r.json.publication.id, "Q28: publication minted");
    const row = await client.lesson.findUnique({ where: { id: LA.id } });
    eq(row.status, "PUBLISHED", "Q28: DB status PUBLISHED");
    eq(row.isPublished, true, "Q28: mirror flipped true");
    const pub = await client.sessionPublication.findMany({
      where: { lessonId: LA.id },
    });
    eq(pub.length, 1, "Q28: exactly one publication row");
    const again = await POST_JSON(
      R.open,
      `http://t/api/admin/lessons/${LA.id}/open`,
      {},
      { id: LA.id }
    );
    eq(again.status, 200, "Q29: double open 200");
    eq(again.json.code, "NO_OP_ALREADY_IN_STATE", "Q29: idempotent code");
    eq(again.json.publication.id, r.json.publication.id, "Q29: same publication id");
    const pubs = await client.sessionPublication.findMany({
      where: { lessonId: LA.id },
    });
    eq(pubs.length, 1, "Q29: still exactly one row");
    // OPEN from DRAFT is ILLEGAL_TRANSITION even when the lesson is also
    // blocked: the state machine is checked before readiness, which is what
    // makes "READY cannot be bypassed" structural rather than advisory.
    const draft = await POST_JSON(
      R.open,
      `http://t/api/admin/lessons/${LE.id}/open`,
      {},
      { id: LE.id }
    );
    eq(draft.status, 409, "Q30: opening a DRAFT 409");
    eq(draft.json.code, "ILLEGAL_TRANSITION", "Q30: exact code");
  }
  {
    const r = await POST_JSON(
      R.unpublish,
      `http://t/api/admin/lessons/${LA.id}/unpublish`,
      {},
      { id: LA.id }
    );
    eq(r.status, 200, "Q31: unpublish 200");
    eq([r.json.from, r.json.to], ["PUBLISHED", "READY"], "Q31: PUBLISHED→READY");
    const row = await client.lesson.findUnique({ where: { id: LA.id } });
    eq(row.status, "READY", "Q31: DB status READY");
    eq(row.isPublished, false, "Q31: mirror flipped back");
    const again = await POST_JSON(
      R.unpublish,
      `http://t/api/admin/lessons/${LA.id}/unpublish`,
      {},
      { id: LA.id }
    );
    eq(again.json.code, "NO_OP_ALREADY_IN_STATE", "Q31: second unpublish no-op");
    asUser(teacher);
    const t = await POST_JSON(
      R.markReady,
      `http://t/api/admin/lessons/${LA.id}/mark-ready`,
      {},
      { id: LA.id }
    );
    eq(t.status, 403, "Q32: teacher cannot mark-ready");
    const t2 = await POST_JSON(
      R.open,
      `http://t/api/admin/lessons/${LA.id}/open`,
      {},
      { id: LA.id }
    );
    eq(t2.status, 403, "Q32: teacher cannot open");
    asUser(null);
    const anon = await POST_JSON(
      R.open,
      `http://t/api/admin/lessons/${LA.id}/open`,
      {},
      { id: LA.id }
    );
    eq(anon.status, 401, "Q32: anonymous cannot open");
    asUser(admin);
  }

  // ---- Q33-Q36: archive / restore ----------------------------------------------
  {
    // READY lessons archive directly; PUBLISHED ones must unpublish first.
    const r = await POST_JSON(
      R.archive,
      `http://t/api/admin/lessons/${LA.id}/archive`,
      { action: "ARCHIVE" },
      { id: LA.id }
    );
    eq(r.status, 200, "Q33: archive 200");
    eq(r.json.code, "OK", "Q33: code OK");
    eq(r.json.curriculumStatus, "ARCHIVED", "Q33: archived");
    eq(r.json.status, "READY", "Q33: status untouched");
    const again = await POST_JSON(
      R.archive,
      `http://t/api/admin/lessons/${LA.id}/archive`,
      { action: "ARCHIVE" },
      { id: LA.id }
    );
    eq(again.json.code, "NO_OP_ALREADY_ARCHIVED", "Q33: archive idempotent");
  }
  {
    const patch = await PATCH_JSON(
      R.lessonById,
      `http://t/api/admin/lessons/${LA.id}`,
      { title: "mutate history" },
      { id: LA.id }
    );
    eq(patch.status, 409, "Q34: archived PATCH 409");
    eq(patch.json.error, "LESSON_ARCHIVED", "Q34: exact code");
    const mr = await POST_JSON(
      R.markReady,
      `http://t/api/admin/lessons/${LA.id}/mark-ready`,
      {},
      { id: LA.id }
    );
    eq(mr.status, 409, "Q34: archived mark-ready 409");
    eq(mr.json.code, "LESSON_ARCHIVED", "Q34: exact code");
    const ready = await GET(
      R.readiness,
      `http://t/api/admin/lessons/${LA.id}/readiness`,
      { id: LA.id }
    );
    ok(
      ready.json.readiness.blocking.includes("CURRICULUM_ARCHIVED"),
      "Q34: checklist names the archive"
    );
  }
  {
    const r = await POST_JSON(
      R.archive,
      `http://t/api/admin/lessons/${LA.id}/archive`,
      { action: "RESTORE" },
      { id: LA.id }
    );
    eq(r.status, 200, "Q35: restore 200");
    eq(r.json.curriculumStatus, "LEGACY", "Q35: standing re-derived (no code)");
    const patch = await PATCH_JSON(
      R.lessonById,
      `http://t/api/admin/lessons/${LA.id}`,
      { title: "Arabic session v3" },
      { id: LA.id }
    );
    eq(patch.status, 200, "Q35: PATCH works after restore");
    const bad = await POST_JSON(
      R.archive,
      `http://t/api/admin/lessons/${LA.id}/archive`,
      { action: "DELETE" },
      { id: LA.id }
    );
    eq(bad.status, 400, "Q36: bad archive action 400");
    eq(bad.json.error, "INVALID_ARCHIVE_ACTION", "Q36: exact code");
    const missing = await POST_JSON(
      R.archive,
      "http://t/api/admin/lessons/nope/archive",
      { action: "ARCHIVE" },
      { id: "nope" }
    );
    eq(missing.status, 404, "Q36: unknown lesson 404");
  }

  // ---- Q37-Q40: mock-exam pins, pools, video list/delete -------------------------
  {
    const r = await GET(R.mockExams, "http://t/api/admin/mock-exams");
    eq(r.status, 200, "Q37: mock-exams 200");
    const byId = Object.fromEntries(r.json.exams.map((e) => [e.id, e]));
    eq(byId[mxFixed.id].pinnedQuestions, 3, "Q37: FIXED shows 3 pins");
    eq(byId[mxFixed.id].selectionMode, "FIXED", "Q37: FIXED mode echoed");
    const random = r.json.exams.find((e) => e.selectionMode === "RANDOM");
    eq(random.pinnedQuestions, 0, "Q37: RANDOM shows 0 pins");
    eq(r.json.pools, { ARABIC: 6, LANGUAGE: 5 }, "Q37: pool math (null joins both)");
    const ar = await GET(R.mockExams, "http://t/api/admin/mock-exams?schoolType=ARABIC");
    eq(ar.json.exams.map((e) => e.id), [mxFixed.id], "Q38: schoolType filter");
  }
  {
    const r = await GET(
      R.videos,
      `http://t/api/admin/session-videos?batchId=${batchAr.id}`
    );
    eq(r.status, 200, "Q39: videos list 200");
    eq(r.json.videos.map((v) => v.id), [videoId], "Q39: batch filter");
    eq(r.json.videos[0].lesson.id, LA.id, "Q39: lesson join");
    const ext = await POST_JSON(R.videos, "http://t/api/admin/session-videos", {
      batchId: batchLang.id,
      lessonId: LE.id,
      title: "External",
      videoUrl: "https://cdn.example.com/v.mp4",
      publish: false,
    });
    eq(ext.status, 200, "Q40: external-url video 200");
    eq(ext.json.video.isPublished, false, "Q40: unpublished by default");
    const extAssetId = ext.json.video.mediaAssetId;
    const del = await DELETE(
      R.videoById,
      `http://t/api/admin/session-videos/${ext.json.video.id}`,
      { id: ext.json.video.id }
    );
    eq(del.status, 200, "Q40: delete 200");
    const gone = await client.sessionVideo.findUnique({
      where: { id: ext.json.video.id },
    });
    eq(gone, null, "Q40: video row gone");
    const assetGone = await client.mediaAsset.findUnique({
      where: { id: extAssetId },
    });
    eq(assetGone, null, "Q40: unreferenced asset row cleaned");
    const kept = await client.mediaAsset.findUnique({ where: { id: videoAssetId } });
    ok(!!kept, "Q40: still-referenced asset kept");
  }

  // ---- F1-F3: database-level final state --------------------------------------
  {
    // Q28 asserted the one row minted at OPEN; unpublish WITHDRAWS it so
    // Phase 17 can never fan out for a session that left the universe.
    const pubs = await client.sessionPublication.findMany({
      where: { lessonId: LA.id },
    });
    eq(pubs.length, 0, "F1: unpublish withdrew the publication row");
    const audits = await client.auditLog.findMany({ where: { entityId: LA.id } });
    const actions = audits.map((a) => a.action).sort();
    for (const a of ["LESSON_ARCHIVE", "LESSON_MARK_READY", "LESSON_OPEN", "LESSON_RESTORE", "LESSON_UNPUBLISH", "LESSON_UPDATE"]) {
      ok(actions.includes(a), `F2: audit trail contains ${a}`);
    }
    // The upload audit is keyed by the MATERIAL row, not the lesson.
    const uploadAudit = await client.auditLog.findFirst({
      where: { entityId: matId, action: "LESSON_MATERIAL_UPLOAD" },
    });
    ok(!!uploadAudit, "F2: audit trail contains LESSON_MATERIAL_UPLOAD");
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(MEDIA_DIR);
    eq(files.length, 2, "F3: exactly the PDF + the mp4 on disk");
    const blobs = files.map((f) => fs.readFileSync(f));
    ok(blobs.some((b) => b.equals(PDF_BYTES)), "F3: PDF bytes on disk");
    ok(blobs.some((b) => b.equals(MP4_BYTES)), "F3: mp4 bytes on disk");
  }

  R.restore();
}

main()
  .then(() => {
    console.log(`\nphase15 admin e2e: ${passed} passed, ${failures.length} failed`);
    if (failures.length) {
      for (const f of failures) console.log(`  FAILED: ${f}`);
      process.exitCode = 1;
    }
  })
  .catch((e) => {
    console.error("phase15 admin e2e crashed:", e);
    process.exitCode = 1;
  });
