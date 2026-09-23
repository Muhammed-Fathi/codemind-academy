// CodeMind Academy — Phase E real end-to-end Teacher Session Workspace verification.
//
// Drives the SHIPPED Phase E teacher API (compiled from src/ with the repo's
// own tsc, exactly like scripts/verify-phase18-teacher.mjs and
// scripts/verify-phase15-admin.mjs do) against a REAL SQLite database built
// from the base DDL + every real migration. It walks the whole Phase E
// contract against the REAL route handlers:
//
//   session list (scoped to Group.courseId; unreadiness visible)
//     → session workspace (overview / READ-ONLY video / materials /
//       quizzes / homework / the ONE readiness snapshot)
//     → material upload (manage-own replacement; foreign-active refusal;
//       track containment; ownership; archived refusal)
//     → material deactivate (own-only; admin-owned proof required)
//     → quiz metadata PATCH (bounded fields; frozen-audience scope refusal;
//       question-containment guard on scope moves)
//     → homework DELETE (submission-preservation refusal; cleanup otherwise)
//     → readiness authority LIVE-reaction sequence (READY only when the
//       real PDF/quiz/homework rows exist through the readiness loader)
//     → cross-scope fail-closed denials (teacher B; student; no-auth)
//     → Phase K teacher presigned legs (K-a..L-iv): teacher-safe init/complete
//       routes (PRESIGNED_UNSUPPORTED fallback contract on the local backend;
//       forged/replayed/cross-scope intent tokens refused) + the shared
//       finalize's manage-own partition matrix over a fake presigning backend
//       (foreign-active refusal vs permitted own-replace; idempotent replay)
//     → homework dialog manual-QA source contract: readable date/time deadline
//       UI (design-system Calendar + Popover + native time input + locale
//       summary), Homework-specific save copy, edit hydration, IDENTICAL
//       create/edit ISO payload semantics, and untouched Quiz/API surfaces
//
// What is REAL here: the migration SQL, the schema, the compiled route
// handlers, the manage-own gates, the readiness recomputation, the media
// bytes on disk, the frozen attempt protection. What is SHIMMED (and why):
//   * `@/lib/db`     → sqlite-prisma-lite over node:sqlite (the Prisma query
//                      engine binary is unreachable from this sandbox).
//   * `@/lib/auth`   → script-controlled current user (requireUser still
//                      runs for real).
//   * `next/server`  → minimal NextResponse (status/headers/json/bytes).
//   * `next/headers` → no locale cookie (server falls back to `ar`).
//
// Exit code 0 + `0 failed` iff every assertion holds. Section M of
// tests/teacher-session-workspace-phaseE.test.js executes this file.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID, createHash } from "node:crypto";
import { Readable } from "node:stream";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

// Media env MUST be set before the compiled media.js module loads (it reads
// these at import time, exactly like production).
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseE-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_DIR;

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
  "Group",
  "Teacher",
  "Student",
  "Material",
  "MediaAsset",
  "SessionVideo",
  "Quiz",
  "Question",
  "QuizAttempt",
  "Homework",
  "HomeworkSubmission",
  "AuditLog",
  "Batch",
];

const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phaseE: " });
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
  // libraries (tsc follows their imports)
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/security.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/session-materials.ts",
  // Phase K — the shared presigned service carries the additive manage-own
  // completion path the teacher route threads into; compile it for real so
  // the forged/service-level scenarios exercise the SHIPPED code.
  "src/lib/media-upload.ts",
  "src/lib/media.ts",
  "src/lib/storage-quotas.ts",
  "src/lib/teacher-content.ts",
  "src/lib/teacher-sessions.ts",
  "src/lib/api.ts",
  // the Phase E routes under test
  "src/app/api/teacher/sessions/route.ts",
  "src/app/api/teacher/sessions/[id]/route.ts",
  "src/app/api/teacher/sessions/[id]/materials/route.ts",
  // Phase K — teacher presigned legs (additive to the Phase 23 architecture)
  "src/app/api/teacher/media-uploads/init/route.ts",
  "src/app/api/teacher/media-uploads/complete/route.ts",
  // the extended Phase 18 surfaces (additive PATCH / DELETE)
  "src/app/api/teacher/quizzes/route.ts",
  "src/app/api/teacher/quizzes/[id]/route.ts",
  "src/app/api/teacher/homework/route.ts",
  "src/app/api/teacher/homework/[id]/route.ts",
  // the Phase 14 download authorization a workspace row links to
  "src/app/api/materials/[id]/route.ts",
  // the ADMIN ceremony routes that must keep denying TEACHER identities
  // (they are exercised here as guard probes, never by teacher writes)
  "src/app/api/admin/lessons/[id]/mark-ready/route.ts",
  "src/app/api/admin/lessons/[id]/open/route.ts",
  "src/app/api/admin/lessons/[id]/open-override/route.ts",
  "src/app/api/admin/lessons/[id]/unpublish/route.ts",
  "src/app/api/admin/lessons/[id]/materials/route.ts",
  "src/app/api/admin/session-videos/[id]/route.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseE-real-"));
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
  async _readAll() {
    const body = this._body;
    if (body === null || body === undefined) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === "string") return Buffer.from(body);
    if (typeof body.getReader === "function") {
      const reader = body.getReader();
      const chunks = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength));
      }
      return Buffer.concat(chunks);
    }
    return Buffer.from(body);
  }
  async json() {
    if (this._json !== undefined) return this._json;
    return JSON.parse((await this._readAll()).toString("utf8"));
  }
  async arrayBuffer() {
    const b = await this._readAll();
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
  const lib = (p) => require(path.join(outDir, "src/lib", p));
  return {
    restore() {
      Module._resolveFilename = originalResolve;
    },
    teacherSessions: route("teacher/sessions/route.js"),
    teacherSessionById: route("teacher/sessions/[id]/route.js"),
    teacherSessionMaterials: route("teacher/sessions/[id]/materials/route.js"),
    // Phase K — teacher presigned legs
    teacherMediaInit: route("teacher/media-uploads/init/route.js"),
    teacherMediaComplete: route("teacher/media-uploads/complete/route.js"),
    quizById: route("teacher/quizzes/[id]/route.js"),
    homeworkById: route("teacher/homework/[id]/route.js"),
    materialDownload: route("materials/[id]/route.js"),
    teacherSessionsLib: lib("teacher-sessions.js"),
    mediaUploadLib: lib("media-upload.js"),
  };
}

// ---------------------------------------------------------------------------
// HTTP-lite driver (same shape as the Phase 15/18 verifiers)
// ---------------------------------------------------------------------------

function forgeIntentToken(R, payload) {
  // Intent tokens carry an HMAC: without SECURITY_HASH_SECRET set the shipped
  // code falls back to its deterministic DEV secret, so the REAL
  // signUploadIntent (compiled from src/) produces tokens the REAL
  // verifyUploadIntent accepts. Only used to build hostile-but-valid tokens.
  return R.mediaUploadLib.signUploadIntent(payload);
}

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
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}

const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);
const POST_FORM = (r, url, form, params) => call(r.POST, formReq(url, form), params);
const PATCH_JSON = (r, url, body, params) => call(r.PATCH, jsonReq(url, body), params);
const DELETE = (r, url, params) => call(r.DELETE, jsonReq(url), params);

const PDF_BYTES = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<<>>\n%%EOF\n"
);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const outDir = compileRealCode();
  ok(true, "B: shipped TS compiled with the repo tsc");
  const R = loadRealCode(outDir);
  ok(true, "B: route handlers loaded with db/auth/next shims");

  // ---- C. seed ------------------------------------------------------------
  const adminUser = await client.user.create({
    data: { email: "admin-e@cm.test", password: "x", name: "Admin", role: "ADMIN" },
  });
  const teacherUserA = await client.user.create({
    data: { email: "ta-e@cm.test", password: "x", name: "Teacher A", role: "TEACHER" },
  });
  const teacherUserB = await client.user.create({
    data: { email: "tb-e@cm.test", password: "x", name: "Teacher B", role: "TEACHER" },
  });
  const studentUser = await client.user.create({
    data: { email: "stu-e@cm.test", password: "x", name: "Student", role: "STUDENT" },
  });

  const teacherA = await client.teacher.create({ data: { userId: teacherUserA.id } });
  const teacherB = await client.teacher.create({ data: { userId: teacherUserB.id } });

  const courseA = await client.course.create({
    data: { academicLevel: "SECOND_SECONDARY", slug: "phaseE-a", name: "Phase E A", nameAr: "مرحلة ئ أ", description: "d" },
  });
  const courseB = await client.course.create({
    data: { academicLevel: "SECOND_SECONDARY", slug: "phaseE-b", name: "Phase E B", nameAr: "مرحلة ئ ب", description: "d" },
  });
  const partA = await client.part.create({
    data: { courseId: courseA.id, title: "Part A", titleAr: "جزء أ", order: 1 },
  });
  const partB = await client.part.create({
    data: { courseId: courseB.id, title: "Part B", titleAr: "جزء ب", order: 1 },
  });
  const unitA = await client.unit.create({
    data: { partId: partA.id, title: "Unit A", titleAr: "وحدة أ", order: 1 },
  });
  const unitB = await client.unit.create({
    data: { partId: partB.id, title: "Unit B", titleAr: "وحدة ب", order: 1 },
  });

  const groupA = await client.group.create({
    data: { name: "Group A", courseId: courseA.id, teacherId: teacherA.id, isActive: true },
  });
  const groupB = await client.group.create({
    data: { name: "Group B", courseId: courseB.id, teacherId: teacherB.id, isActive: true },
  });

  const student = await client.student.create({
    data: { academicLevel: "SECOND_SECONDARY", userId: studentUser.id, groupId: groupA.id, schoolType: "ARABIC" },
  });
  ok(true, "C: teachers, groups, courses, chain and a student seeded");

  const L = {};
  // The session the workflow completes (all four readiness items satisfied).
  L.complete = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unitA.id, officialCode: "PE-01", title: "Complete session", titleAr: "حصة كاملة",
      order: 1, trackScope: "SHARED", status: "DRAFT", curriculumStatus: "OFFICIAL",
    },
  });
  // Same course — an ARCHIVED session must be visible but not writeable.
  L.archived = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unitA.id, officialCode: "PE-02", title: "Archived session", titleAr: "حصة مؤرشفة",
      order: 2, trackScope: "SHARED", status: "ARCHIVED", curriculumStatus: "ARCHIVED",
    },
  });
  // A track-specific session for the containment material/quiz matrix.
  L.ar = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unitA.id, officialCode: "PE-03", title: "Arabic session", titleAr: "حصة عربي",
      order: 3, trackScope: "ARABIC", status: "DRAFT", curriculumStatus: "OFFICIAL",
    },
  });
  // The OTHER teacher's session — cross-scope must fail closed everywhere.
  L.foreign = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unitB.id, officialCode: "PE-B1", title: "Foreign session", titleAr: "حصة غير مملوكة",
      order: 1, trackScope: "SHARED", status: "DRAFT", curriculumStatus: "OFFICIAL",
    },
  });

  // Readiness VIDEO input — the shared lesson's audience is BOTH tracks and
  // Phase D requires one published video per audience track, derived from
  // SessionVideo.batch.schoolType. Seed two real Batch rows + two videos.
  const videoAsset = await client.mediaAsset.create({
    data: {
      kind: "VIDEO", storage: "EXTERNAL_URL",
      externalUrl: "https://www.youtube-nocookie.com/embed/pe-e",
      isPrivate: false, createdById: adminUser.id,
    },
  });
  const batchAr = await client.batch.create({
    data: { name: "Batch AR", nameAr: "دفعة عربي", schoolType: "ARABIC", courseId: courseA.id },
  });
  const batchLang = await client.batch.create({
    data: { name: "Batch LANG", nameAr: "دفعة لغات", schoolType: "LANGUAGE", courseId: courseA.id },
  });
  await client.sessionVideo.create({
    data: {
      lessonId: L.complete.id, batchId: batchAr.id, mediaAssetId: videoAsset.id,
      title: "Video AR", titleAr: "فيديو عربي", isPublished: true, requiredPercent: 95,
    },
  });
  await client.sessionVideo.create({
    data: {
      lessonId: L.complete.id, batchId: batchLang.id, mediaAssetId: videoAsset.id,
      title: "Video LANG", titleAr: "فيديو لغات", isPublished: true, requiredPercent: 95,
    },
  });
  ok(true, "C: published SessionVideos staged for the readiness VIDEO item");

  // ---- H. security — auth + scope ----------------------------------------
  // H-a..H-c: list
  asUser(null);
  const listNoAuth = await GET(R.teacherSessions, "http://t/api/teacher/sessions");
  eq(listNoAuth.status, 401, "H-a: sessions list without auth → 401");

  asUser(studentUser);
  const listStudent = await GET(R.teacherSessions, "http://t/api/teacher/sessions");
  ok(listStudent.status === 401 || listStudent.status === 403,
    "H-b: sessions list as STUDENT → 401/403", String(listStudent.status));

  asUser(teacherUserA);
  const listA = await GET(R.teacherSessions, "http://t/api/teacher/sessions");
  eq(listA.status, 200, "H-c: sessions list as Teacher A → 200");
  const listIds = (listA.json.sessions ?? []).map((s) => s.id);
  ok(listIds.includes(L.complete.id), "H-c: own SHARED session is listed");
  ok(listIds.includes(L.ar.id), "H-c: own ARABIC session is listed");
  ok(listIds.includes(L.archived.id), "H-c: archived session is listed (read-only)");
  ok(!listIds.includes(L.foreign.id), "H-c: the other teacher's session is NEVER listed");

  // H-d: the list exposes NO raw storage internals
  const serializedList = JSON.stringify(listA.json);
  ok(!/storageKey|r2\.dev|bucket/i.test(serializedList),
    "H-d: list payload carries no storage keys", serializedList.slice(0, 200));

  // H-e..H-h: workspace scoping
  asUser(null);
  const wsNoAuth = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.complete.id });
  eq(wsNoAuth.status, 401, "H-e: workspace without auth → 401");

  asUser(teacherUserB);
  const wsForeign = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.complete.id });
  eq(wsForeign.status, 403, "H-g: workspace of another teacher's course → 403");

  asUser(teacherUserA);
  const wsForeignB = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.foreign.id });
  eq(wsForeignB.status, 403, "H-h: Teacher A on Teacher B's session → 403");
  const wsMissing = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: "missing-id" });
  eq(wsMissing.status, 404, "H-h: missing session → 404");

  // H-i..H-l: admin ceremony / video mutation routes stay denied to TEACHERs.
  // These handlers are pinned by the Phase 13/14/A suites; Phase E re-asserts
  // the denial from the teacher identity by loading the SHIPPED sources and
  // driving them only when their guards are invoked through requireUser's
  // role check (the routes' FIRST role branch is the admin one).
  const guardProbe = async (routePath, exportName, args = []) => {
    const mod = require(path.join(outDir, routePath));
    const handler = mod[exportName];
    asUser(teacherUserA);
    const res = await handler(...args);
    return res.status;
  };
  // mark-ready
  {
    const mod = require(path.join(outDir, "src/app/api/admin/lessons/[id]/mark-ready/route.js"));
    asUser(teacherUserA);
    const res = await mod.POST(jsonReq("http://t/x", {}), { params: Promise.resolve({ id: L.complete.id }) });
    ok(res.status === 401 || res.status === 403, "H-i: admin mark-ready denies TEACHER", String(res.status));
  }
  // open
  {
    const mod = require(path.join(outDir, "src/app/api/admin/lessons/[id]/open/route.js"));
    asUser(teacherUserA);
    const res = await mod.POST(jsonReq("http://t/x", {}), { params: Promise.resolve({ id: L.complete.id }) });
    ok(res.status === 401 || res.status === 403, "H-j: admin open denies TEACHER", String(res.status));
  }
  // open-override
  {
    const mod = require(path.join(outDir, "src/app/api/admin/lessons/[id]/open-override/route.js"));
    asUser(teacherUserA);
    const res = await mod.POST(jsonReq("http://t/x", { approverId: adminUser.id }), { params: Promise.resolve({ id: L.complete.id }) });
    ok(res.status === 401 || res.status === 403, "H-k: admin open-override denies TEACHER", String(res.status));
  }
  // unpublish
  {
    const mod = require(path.join(outDir, "src/app/api/admin/lessons/[id]/unpublish/route.js"));
    asUser(teacherUserA);
    const res = await mod.POST(jsonReq("http://t/x", {}), { params: Promise.resolve({ id: L.complete.id }) });
    ok(res.status === 401 || res.status === 403, "H-l: admin unpublish denies TEACHER", String(res.status));
  }
  // session-video mutation (publish/unpublish PATCH)
  {
    const mod = require(path.join(outDir, "src/app/api/admin/session-videos/[id]/route.js"));
    asUser(teacherUserA);
    const res = await mod.PATCH(jsonReq("http://t/x", { isPublished: true }), { params: Promise.resolve({ id: "any" }) });
    ok(res.status === 401 || res.status === 403, "H-m: admin session-video mutation denies TEACHER", String(res.status));
  }
  // admin materials upload route
  {
    const mod = require(path.join(outDir, "src/app/api/admin/lessons/[id]/materials/route.js"));
    asUser(teacherUserA);
    const form = new FormData();
    form.set("file", new File([PDF_BYTES], "x.pdf", { type: "application/pdf" }));
    const res = await mod.POST(formReq("http://t/x", form), { params: Promise.resolve({ id: L.complete.id }) });
    ok(res.status === 401 || res.status === 403, "H-n: admin materials upload denies TEACHER (never the teacher path)", String(res.status));
  }

  // ---- D+E. Session list + workspace on an UNREADY session ----------------
  asUser(teacherUserA);
  const ws = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.complete.id });
  eq(ws.status, 200, "D: workspace load → 200");
  const w = ws.json;
  ok(w.lesson?.id === L.complete.id, "D: workspace lesson is the requested session");
  ok(w.video && typeof w.video.publishedCount === "number", "F5: READ-ONLY video status is present");
  eq(w.video.publishedCount, 2, "F5: video counts come from the real SessionVideo rows");
  ok(Array.isArray(w.readiness?.items), "F6: readiness snapshot is the single Phase D authority");
  const itemOf = (k) => w.readiness.items.find((i) => i.key === k);
  eq(itemOf("VIDEO").state, "OK", "G-seq: VIDEO is OK from the staged videos");

  // Readiness starts with PDF / QUIZ / HOMEWORK missing.
  eq(itemOf("PDF").state, "MISSING", "G-seq: PDF starts MISSING");
  eq(itemOf("QUIZ").state, "MISSING", "G-seq: QUIZ starts MISSING");
  eq(itemOf("HOMEWORK").state, "MISSING", "G-seq: HOMEWORK starts MISSING");
  eq(w.readiness.canBeReady, false, "G-seq: canBeReady false until all four valid");
  ok(Array.isArray(w.materials) && w.materials.length === 0, "E: materials start empty");
  ok(Array.isArray(w.quizzes) && Array.isArray(w.homework), "E: quiz + homework sections present");
  ok(!("storageKey" in (w.materials?.[0] ?? {})) && !JSON.stringify(w).includes(MEDIA_DIR),
    "F7: workspace payload leaks no storage path");

  // ---- E1..E3. Material upload: validation + track containment ------------
  const matUrl = "http://t/api/teacher/sessions/x/materials";
  const matParams = { id: L.complete.id };

  const badMime = new FormData();
  badMime.set("file", new File(["nope not pdf"], "n.pdf", { type: "application/pdf" }));
  const v1 = await POST_FORM(R.teacherSessionMaterials, matUrl, badMime, matParams);
  eq(v1.status, 415, "E2: non-PDF magic → 415");

  const badScope = new FormData();
  badScope.set("file", new File([PDF_BYTES], "n.pdf", { type: "application/pdf" }));
  badScope.set("trackScope", "KOREAN");
  const v2 = await POST_FORM(R.teacherSessionMaterials, matUrl, badScope, matParams);
  eq(v2.status, 400, "E1: unknown trackScope → 400 (api.228 family)");

  // Containment: the ARABIC session must NOT take a LANGUAGE material.
  const badContain = new FormData();
  badContain.set("file", new File([PDF_BYTES], "n.pdf", { type: "application/pdf" }));
  badContain.set("trackScope", "LANGUAGE");
  const v3 = await POST_FORM(R.teacherSessionMaterials, matUrl, badContain, { id: L.ar.id });
  eq(v3.status, 400, "E9: LANGUAGE material on an ARABIC lesson → 400 api.243");
  const v3b = await POST_FORM(R.teacherSessionMaterials, matUrl, new FormData(), { id: L.ar.id });
  ok(v3b.status === 400, "E9: missing file → 400", String(v3b.status));

  // An upload to an ARCHIVED session is refused before any write.
  const archivedForm = new FormData();
  archivedForm.set("file", new File([PDF_BYTES], "n.pdf", { type: "application/pdf" }));
  const v4 = await POST_FORM(R.teacherSessionMaterials, matUrl, archivedForm, { id: L.archived.id });
  eq(v4.status, 409, "E4: upload on ARCHIVED session → 409 (api.242)");

  // Cross-scope material upload fails closed.
  asUser(teacherUserB);
  const crossForm = new FormData();
  crossForm.set("file", new File([PDF_BYTES], "n.pdf", { type: "application/pdf" }));
  const v5 = await POST_FORM(R.teacherSessionMaterials, matUrl, crossForm, matParams);
  eq(v5.status, 403, "H-p: cross-course material upload → 403");
  asUser(teacherUserA);

  // E6: the upload itself (lesson-scope SHARED, inherited by omission).
  const upForm = new FormData();
  upForm.set("file", new File([PDF_BYTES], "حصة-١.pdf", { type: "application/pdf" }));
  const up = await POST_FORM(R.teacherSessionMaterials, matUrl, upForm, matParams);
  eq(up.status, 200, "E6: teacher material upload → 200");
  ok(up.json?.material?.mediaAssetId === undefined, "F7: upload response withholds mediaAssetId");
  const materialId = up.json?.material?.id;
  ok(typeof materialId === "string" && materialId.length > 5, "E6: material id returned");
  const uploadedAssetRow = await client.material
    .findUnique({ where: { id: materialId }, select: { media: { select: { createdById: true } } } })
    .then((m) => m?.media ?? null);
  eq(uploadedAssetRow?.createdById, teacherUserA.id, "E6: MediaAsset.createdById proves teacher ownership");

  // E7: second upload replaces ONLY the teacher's own prior active.
  const up2Form = new FormData();
  up2Form.set("file", new File([PDF_BYTES], "v2.pdf", { type: "application/pdf" }));
  const up2 = await POST_FORM(R.teacherSessionMaterials, matUrl, up2Form, matParams);
  eq(up2.status, 200, "E7: own-scope re-upload → 200 (replacement)");
  const matsAfterTwo = await client.material.findMany({ where: { lessonId: L.complete.id } });
  const activeOfTwo = matsAfterTwo.filter((m) => m.isActive);
  eq(activeOfTwo.length, 1, "E7: exactly one ACTIVE material after replacement");
  eq(matsAfterTwo.filter((m) => !m.isActive).length, 1, "E7: prior upload deactivated (soft)");

  // E5: an ADMIN-owned active material of the same scope blocks the teacher.
  // Its bytes must exist on the private volume exactly like a real admin
  // upload — the download probe below reads through the Phase 14 route.
  fs.writeFileSync(path.join(MEDIA_DIR, "admin-fixed.pdf"), PDF_BYTES);
  const adminAsset = await client.mediaAsset.create({
    data: {
      kind: "DOCUMENT", storage: "LOCAL_PRIVATE", storageKey: "admin-fixed.pdf",
      mimeType: "application/pdf", sizeBytes: PDF_BYTES.length, originalName: "admin.pdf",
      isPrivate: true, createdById: adminUser.id,
    },
  });
  const adminMaterial = await client.material.create({
    data: {
      lessonId: L.complete.id, kind: "ADMIN_UPLOADED", title: "Admin file",
      trackScope: "SHARED", isActive: true, mediaAssetId: adminAsset.id,
    },
  });
  // Note: our teacher v2 upload is still ACTIVE for SHARED too — the admin
  // row above creates the "foreign active" situation explicitly for the gate.
  const conflForm = new FormData();
  conflForm.set("file", new File([PDF_BYTES], "v3.pdf", { type: "application/pdf" }));
  const confl = await POST_FORM(R.teacherSessionMaterials, matUrl, conflForm, matParams);
  eq(confl.status, 409, "E5: upload with a FOREIGN active material of same scope → 409 (api.318)");
  ok(String(confl.json?.error ?? "").length > 0, "E5: refusal carries the translated message");

  // The foreign active row was untouched.
  const adminMatAfter = await client.material.findUnique({ where: { id: adminMaterial.id } });
  eq(adminMatAfter.isActive, true, "E5: admin material remains ACTIVE (never silently replaced)");

  // E8: deactivate — a teacher may only deactivate their OWN upload.
  const delForeign = await DELETE(
    R.teacherSessionMaterials,
    `${matUrl}?materialId=${adminMaterial.id}`,
    matParams
  );
  eq(delForeign.status, 403, "E8: deactivate of the admin's material → 403 (api.319)");

  const teacherActive = matsAfterTwo.find((m) => m.isActive);
  ok(!!teacherActive, "E8: the teacher's own active row is still present");
  const delOwn = await DELETE(
    R.teacherSessionMaterials,
    `${matUrl}?materialId=${teacherActive.id}`,
    matParams
  );
  eq(delOwn.status, 200, "E8: deactivate of the teacher's own material → 200");
  const ownAfter = await client.material.findUnique({ where: { id: teacherActive.id } });
  eq(ownAfter.isActive, false, "E8: own material deactivated (soft, never erased)");
  eq(delOwn.json?.deleted, undefined, "E8: response does not claim a hard delete");

  // Pairing check: a material id of ANOTHER lesson can never be deactivated
  // through this session's endpoint.
  const foreignMat = await client.material.create({
    data: {
      lessonId: L.foreign.id, kind: "ADMIN_UPLOADED", title: "X",
      trackScope: "SHARED", isActive: true, mediaAssetId: adminAsset.id,
    },
  });
  const delMis = await DELETE(
    R.teacherSessionMaterials,
    `${matUrl}?materialId=${foreignMat.id}`,
    matParams
  );
  eq(delMis.status, 404, "H-r: lessonId↔material mismatch → 404 (no cross-lesson deactivation)");
  const delMissingId = await DELETE(R.teacherSessionMaterials, matUrl, matParams);
  eq(delMissingId.status, 400, "H-q: deactivate without materialId → 400");

  // Workspace reflects materials deterministically after the mutations.
  const wsAfterMat = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.complete.id });
  const matItems = wsAfterMat.json.materials;
  ok(matItems.length >= 2, "E: workspace lists materials post-mutations");
  const adminMatInWs = matItems.find((m) => m.id === adminMaterial.id);
  eq(adminMatInWs.own, false, "E: admin material flags own=false for this teacher");
  const teacherMatInWs = matItems.find((m) => m.own);
  ok(!teacherMatInWs || teacherMatInWs.isActive === false ||
    matItems.every((m) => !(m.own && m.isActive)),
    "E: no active own material remains after the deactivate");

  // ---- F. Quiz PATCH (Phase E extension of the Phase 18 quiz route) -------
  // Create a quiz through the SHIPPED create route so blueprint semantics are
  // exactly the product's.
  const quizzesRoute = require(path.join(outDir, "src/app/api/teacher/quizzes/route.js"));
  const createQuiz = await POST_JSON(
    quizzesRoute,
    "http://t/api/teacher/quizzes",
    {
      lessonId: L.complete.id,
      title: "Session quiz",
      titleAr: "اختبار الحصة",
      description: "d",
      passMark: 60,
      trackScope: "",
      questions: [
        {
          type: "MCQ",
          prompt: "2+2?",
          promptAr: "2+2؟",
          options: ["3", "4"],
          answer: "1",
          explanation: "",
          difficulty: "EASY",
          marks: 1,
          schoolType: undefined,
        },
      ],
    }
  );
  eq(createQuiz.status, 200, "F1: quiz create through Phase 18 route → 200 (Phase 18 convention)");
  const quizId = createQuiz.json?.quiz?.id;
  ok(typeof quizId === "string", "F1: quiz id returned");

  // Readiness QUIZ reacts through the SAME authority.
  const wsAfterQuiz = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.complete.id });
  eq(wsAfterQuiz.json.readiness.items.find((i) => i.key === "QUIZ").state, "OK",
    "G-seq: QUIZ flips OK once a quiz with a valid question exists");

  // PATCH metadata (title/paraMark).
  const emptyPatch = await PATCH_JSON(R.quizById, "http://t/quiz", {}, { id: quizId });
  eq(emptyPatch.status, 400, "F3: empty PATCH → 400 (api.320)");

  const metaPatch = await PATCH_JSON(
    R.quizById,
    "http://t/quiz",
    { title: "Session quiz v2", passMark: 70, timeLimit: 15 },
    { id: quizId }
  );
  eq(metaPatch.status, 200, "F2: metadata PATCH → 200");
  const quizAfterMeta = await client.quiz.findUnique({ where: { id: quizId } });
  eq(quizAfterMeta.title, "Session quiz v2", "F2: title persisted");
  eq(quizAfterMeta.passMark, 70, "F2: passMark persisted");
  eq(quizAfterMeta.timeLimit, 15, "F2: timeLimit persisted");

  const badPass = await PATCH_JSON(R.quizById, "http://t/quiz", { passMark: 700 }, { id: quizId });
  eq(badPass.status, 400, "F2: bounded passMark refused");

  // Scope move: SHARED → ARABIC keeps every existing question (question has
  // no schoolType ⇒ every audience must fit).
  const widen = await PATCH_JSON(R.quizById, "http://t/quiz", { trackScope: "ARABIC" }, { id: quizId });
  eq(widen.status, 200, "F4: pre-attempt scope move allowed when questions fit");
  const quizMoved = await client.quiz.findUnique({ where: { id: quizId } });
  eq(quizMoved.trackScope, "ARABIC", "F4: scope move persisted");

  // Questions that CANNOT fit the new scope must block the move: add an
  // ARABIC-tagged question, then try to move the quiz to LANGUAGE.
  await client.question.create({
    data: {
      quizId, prompt: "AR only", options: '["a","b"]', answer: "0", schoolType: "ARABIC",
    },
  });
  const blockedMove = await PATCH_JSON(R.quizById, "http://t/quiz", { trackScope: "LANGUAGE" }, { id: quizId });
  eq(blockedMove.status, 409, "F4: scope move blocked when an existing question is out of scope (api.322)");
  const stillArabic = await client.quiz.findUnique({ where: { id: quizId } });
  eq(stillArabic.trackScope, "ARABIC", "F4: the quiz scope is unchanged after the refusal");

  // Frozen-audience: an attempt now exists → trackScope moves must refuse.
  const attempt = await client.quizAttempt.create({
    data: {
      quizId, studentId: student.id, status: "SUBMITTED",
      score: 1, totalMarks: 1, percentage: 100, passed: true,
      finishedAt: new Date(),
    },
  }).catch((e) => { console.log("attempt seed note:", e.message?.slice(0, 120)); return null; });
  if (attempt) {
    const frozenMove = await PATCH_JSON(R.quizById, "http://t/quiz", { trackScope: "SHARED" }, { id: quizId });
    eq(frozenMove.status, 409, "F4: scope move refused once attempts exist (api.321)");
    // Metadata still editable under frozen audience.
    const metaUnderFrozen = await PATCH_JSON(R.quizById, "http://t/quiz", { description: "later" }, { id: quizId });
    eq(metaUnderFrozen.status, 200, "F2: metadata PATCH still allowed with attempts");
  } else {
    ok(false, "F4: frozen-attempt seed (QuizAttempt) failed", "create returned null");
  }

  // Cross-scope PATCH fails closed.
  asUser(teacherUserB);
  const xMeta = await PATCH_JSON(R.quizById, "http://t/quiz", { title: "hijack" }, { id: quizId });
  eq(xMeta.status, 403, "H-o: cross-course quiz PATCH → 403");
  asUser(teacherUserA);
  const titleAfterX = await client.quiz.findUnique({ where: { id: quizId } });
  eq(titleAfterX.title, "Session quiz v2", "H-o: refused PATCH never wrote");

  // ---- G. Homework DELETE (Phase E extension) ------------------------------
  const hwRoute = require(path.join(outDir, "src/app/api/teacher/homework/route.js"));
  const createHw = await POST_JSON(
    hwRoute,
    "http://t/api/teacher/homework",
    {
      lessonId: L.complete.id,
      title: "HW 1", titleAr: "واجب ١",
      instructions: "solve page 4",
      deadline: "2099-01-01T00:00:00.000Z",
      maxMarks: 10,
      trackScope: "",
    }
  );
  eq(createHw.status, 200, "G1: homework create → 200 (Phase 18 convention)");
  const hwId = createHw.json?.homework?.id;
  ok(typeof hwId === "string", "G1: homework id returned");

  const wsAfterHw = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.complete.id });
  eq(wsAfterHw.json.readiness.items.find((i) => i.key === "HOMEWORK").state, "OK",
    "G-seq: HOMEWORK flips OK with a non-empty-instructions homework");

  // Missing-instructions homework does NOT satisfy readiness (invalid input
  // surfaces as INVALID through the same authority, never client-side).
  const emptyHw = await client.homework.create({
    data: {
      lessonId: L.ar.id, title: "Empty", titleAr: "فارغ",
      instructions: "", deadline: new Date("2099-01-01"), maxMarks: 5, trackScope: "ARABIC",
    },
  });
  const wsAr = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.ar.id });
  eq(wsAr.json.readiness.items.find((i) => i.key === "HOMEWORK").state, "INVALID",
    "G-seq: instructions-less homework surfaces as INVALID, never as a satisfied item");

  // Delete with submissions → refused.
  await client.homeworkSubmission.create({
    data: {
      homeworkId: hwId, studentId: student.id,
      content: "done", status: "SUBMITTED", submittedAt: new Date(),
    },
  });
  const delWithSubs = await DELETE(R.homeworkById, "http://t/hw", { id: hwId });
  eq(delWithSubs.status, 409, "G3: homework DELETE with submissions → 409 (api.323)");
  const hwStillThere = await client.homework.findUnique({ where: { id: hwId } });
  ok(!!hwStillThere, "G3: refused DELETE left the homework intact");

  // Cross-scope DELETE fails closed.
  asUser(teacherUserB);
  const xDel = await DELETE(R.homeworkById, "http://t/hw", { id: emptyHw.id });
  eq(xDel.status, 403, "H-o: cross-course homework DELETE → 403");
  asUser(teacherUserA);
  const emptyStill = await client.homework.findUnique({ where: { id: emptyHw.id } });
  ok(!!emptyStill, "H-o: refused homework DELETE left the row intact");

  // Clean DELETE (no submissions).
  const delClean = await DELETE(R.homeworkById, "http://t/hw", { id: emptyHw.id });
  eq(delClean.status, 200, "G2: homework DELETE without submissions → 200");
  const emptyGone = await client.homework.findUnique({ where: { id: emptyHw.id } });
  eq(emptyGone === null, true, "G2: homework row is gone");

  // Missing homework → 404.
  const delGone = await DELETE(R.homeworkById, "http://t/hw", { id: emptyHw.id });
  eq(delGone.status, 404, "G2: double DELETE → 404 (api.238)");

  // ---- K. Quiz DELETE stays guarded by frozen attempts ---------------------
  // The Phase 18 DELETE is pinned by its own suite; Phase E re-asserts the
  // attempt guard from the new workspace journey (delete refused while the
  // attempt exists).
  const delFrozenQuiz = await DELETE(R.quizById, "http://t/quiz", { id: quizId });
  eq(delFrozenQuiz.status, 409, "K: quiz DELETE with attempts → 409 (Phase 18 guard intact)");

  // A fresh quiz with zero attempts deletes cleanly.
  const createQuiz2 = await POST_JSON(
    quizzesRoute,
    "http://t/api/teacher/quizzes",
    {
      lessonId: L.ar.id,
      title: "AR quiz", titleAr: "اختبار",
      passMark: 50, trackScope: "",
      questions: [{ type: "TRUE_FALSE", prompt: "T?", options: ["True", "False"], answer: "0", difficulty: "EASY", marks: 1 }],
    }
  );
  eq(createQuiz2.status, 200, "K: second quiz create → 200");
  const quiz2Id = createQuiz2.json?.quiz?.id;
  const delCleanQuiz = await DELETE(R.quizById, "http://t/quiz", { id: quiz2Id });
  eq(delCleanQuiz.status, 200, "K: quiz DELETE without attempts → 200");

  // ---- Material download authorization from a workspace row ---------------
  // The Phase 14 download route is the ONLY path materials ever leave through;
  // the teacher is staff there, the student needs entitlement.
  const activeRow = await client.material.findFirst({
    where: { lessonId: L.complete.id, isActive: true },
  });
  ok(activeRow && activeRow.id === adminMaterial.id,
    "E: the remaining ACTIVE material is the admin one");

  asUser(teacherUserA);
  const dlTeacher = await GET(R.materialDownload, `http://t/api/materials/${adminMaterial.id}`, { id: adminMaterial.id });
  ok([200].includes(dlTeacher.status),
    "E: teacher may download the material via the Phase 14 route", String(dlTeacher.status));
  asUser(studentUser);
  const dlStudent = await GET(R.materialDownload, `http://t/api/materials/${adminMaterial.id}`, { id: adminMaterial.id });
  ok([403, 404].includes(dlStudent.status),
    "E: student download of a DRAFT-session material is DENIED by the Phase 14 gate",
    String(dlStudent.status));
  ok(!dlStudent.bytes?.toString("utf8", 0, 60)?.includes(MEDIA_DIR),
    "F7: download bytes never echo the storage path");
  asUser(teacherUserA);

  // ---- final readiness sequence -------------------------------------------
  // The SHARED quiz was moved to ARABIC in F4 — Phase D requires quiz
  // coverage for EVERY audience track, so add a LANGUAGE quiz (pre-attempt,
  // untagged question ⇒ fits) to complete the coverage through the SAME
  // create route.
  const createQuizLang = await POST_JSON(
    quizzesRoute,
    "http://t/api/teacher/quizzes",
    {
      lessonId: L.complete.id,
      title: "LANG quiz", titleAr: "اختبار لغات",
      passMark: 50, trackScope: "LANGUAGE",
      questions: [{ type: "TRUE_FALSE", prompt: "T?", options: ["True", "False"], answer: "0", difficulty: "EASY", marks: 1 }],
    }
  );
  eq(createQuizLang.status, 200, "G-seq: LANGUAGE quiz create for full audience coverage → 200");

  const wsFinal = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.complete.id });
  const fin = wsFinal.json.readiness;
  const finItem = (k) => fin.items.find((i) => i.key === k);
  // After: admin PDF active + quiz with questions + homework with instructions.
  eq(finItem("PDF").state, "OK", "G-seq: PDF OK (the admin file is active)");
  eq(finItem("QUIZ").state, "OK", "G-seq: QUIZ OK");
  eq(finItem("HOMEWORK").state, "OK", "G-seq: HOMEWORK OK");
  eq(finItem("VIDEO").state, "OK", "G-seq: VIDEO OK");
  eq(fin.canBeReady, true, "G-seq: canBeReady TRUE only when all four are valid");
  eq(wsFinal.json.lesson.status, "DRAFT",
    "G-seq: the lesson stays DRAFT — Mark Ready is the ADMIN ceremony, never the workspace");

  // Archive interaction: workspace readable, writes refused.
  const wsArchived = await GET(R.teacherSessionById, "http://t/api/teacher/sessions/x", { id: L.archived.id });
  eq(wsArchived.status, 200, "E: archived session workspace remains READABLE");
  const patchArchived = await PATCH_JSON(R.quizById, "http://t/quiz", { title: "x" }, { id: "nope" });
  eq(patchArchived.status, 404, "F3: PATCH of a missing quiz → 404 (api.248 boundary)");

  // ---------------------------------------------------------------------------
  // K. Teacher presigned legs — additive Phase 23 architecture, Phase E scope.
  //    MEDIA_BACKEND is still the verifier default (local volume): the routes
  //    must fail closed with the exact fallback contract the UI keys on
  //    (PRESIGNED_UNSUPPORTED/409), must reject everything outside the
  //    teacher scope BEFORE any grant is issued, and complete() must reject
  //    forged/intent-mismatch tokens locally — no grant, no finalize, no rows.
  // ---------------------------------------------------------------------------

  const initUrl = "http://t/api/teacher/media-uploads/init";
  const completeUrl = "http://t/api/teacher/media-uploads/complete";

  asUser(null);
  const kInitNoAuth = await POST_JSON(R.teacherMediaInit, initUrl, {
    lessonId: L.complete.id, sizeBytes: 4096, contentType: "application/pdf",
  });
  eq(kInitNoAuth.status, 401, "K-a: teacher media init without auth → 401");
  const kCompleteNoAuth = await POST_JSON(R.teacherMediaComplete, completeUrl, { token: "x.y" });
  eq(kCompleteNoAuth.status, 401, "K-b: teacher media complete without auth → 401");

  const kMaterialsBeforeForged = (
    (await client.material.findMany({ where: { lessonId: L.complete.id } })) ?? []
  ).length;
  const kAssetsBeforeForged = (
    (await client.mediaAsset.findMany({ where: { kind: "DOCUMENT" } })) ?? []
  ).length;
  const kNow = Math.floor(Date.now() / 1000);
  const forgedVideoToken = forgeIntentToken(R, {
    v: 2,
    jti: crypto.randomUUID(),
    sub: teacherUserA.id,
    purpose: "SESSION_VIDEO",
    kind: "VIDEO",
    key: `media-uploads/videos/${crypto.randomUUID()}.mp4`,
    contentType: "video/mp4",
    maxBytes: 4096,
    batchId: batchAr.id,
    lessonId: L.complete.id,
    iat: kNow - 60,
    exp: kNow + 600,
  });
  asUser(teacherUserA);
  const kCompleteForgedVideo = await POST_JSON(R.teacherMediaComplete, completeUrl, {
    token: forgedVideoToken,
    lessonId: L.complete.id,
  });
  ok(
    kCompleteForgedVideo.status === 403,
    "K-c: a forged SESSION_VIDEO intent token at the teacher complete → 403",
    String(kCompleteForgedVideo.status)
  );
  // Nothing was finalized: still the same material/asset rows as before.
  const kMaterialsAfterForged = (
    (await client.material.findMany({ where: { lessonId: L.complete.id } })) ?? []
  ).length;
  const kAssetsAfterForged = (
    (await client.mediaAsset.findMany({ where: { kind: "DOCUMENT" } })) ?? []
  ).length;
  eq(
    kMaterialsAfterForged,
    kMaterialsBeforeForged,
    "K-c: forged intent finalizes nothing (no material rows appear)"
  );
  eq(
    kAssetsAfterForged,
    kAssetsBeforeForged,
    "K-c: forged intent writes no MediaAsset rows either"
  );

  asUser(studentUser);
  const kInitStudent = await POST_JSON(R.teacherMediaInit, initUrl, {
    lessonId: L.complete.id, sizeBytes: 4096, contentType: "application/pdf",
  });
  ok(
    kInitStudent.status === 401 || kInitStudent.status === 403,
    "K-d: init as STUDENT → 401/403",
    String(kInitStudent.status)
  );
  const kCompleteStudent = await POST_JSON(R.teacherMediaComplete, completeUrl, {
    token: "x.y",
  });
  ok(
    kCompleteStudent.status === 401 || kCompleteStudent.status === 403,
    "K-d: complete as STUDENT → 401/403",
    String(kCompleteStudent.status)
  );

  asUser(teacherUserB);
  const kInitForeign = await POST_JSON(R.teacherMediaInit, initUrl, {
    lessonId: L.complete.id, sizeBytes: 4096, contentType: "application/pdf",
  });
  eq(
    kInitForeign.status,
    403,
    "K-e: init for a lesson outside the teacher's Group.courseId scope → 403"
  );
  // Attack shape: teacher B presents a forged LESSON_PDF intent whose SIGNED
  // payload targets teacher A's lesson; the body even names B's OWN lesson
  // to look innocent. The route must authorize the SIGNED lessonId, never
  // the request body.
  const kCompleteForeign = await POST_JSON(R.teacherMediaComplete, completeUrl, {
    token: forgeIntentToken(R, {
      v: 2,
      jti: randomUUID(),
      sub: teacherUserB.id,
      purpose: "LESSON_PDF",
      kind: "DOCUMENT",
      key: `media-uploads/pdfs/${randomUUID()}.pdf`,
      contentType: "application/pdf",
      maxBytes: 4096,
      batchId: null,
      lessonId: L.complete.id,
      iat: kNow - 60,
      exp: kNow + 600,
    }),
    lessonId: L.foreign.id,
  });
  eq(
    kCompleteForeign.status,
    403,
    "K-e: complete with a payload lessonId outside the signed user's scope → 403 (never trusts the request body)"
  );

  asUser(teacherUserA);
  const kInitOwn = await POST_JSON(R.teacherMediaInit, initUrl, {
    lessonId: L.complete.id, sizeBytes: 4096, contentType: "application/pdf",
  });
  eq(kInitOwn.status, 409, "K-f: in-scope init on the local backend → 409 (no presigning possible)");
  eq(
    kInitOwn.json?.code,
    "PRESIGNED_UNSUPPORTED",
    "K-f: the machine code is exactly the code the client fallback keys on"
  );

  // On the local-backend leg every valid init collapses to the same
  // PRESIGNED_UNSUPPORTED contract — so garbage sizes/content-types can never
  // reach a grant: they fail closed with the same 409 (and no token); the
  // size/type ceilings themselves are pinned in the Phase-23 presigned suite.
  const kInitBadSize = await POST_JSON(R.teacherMediaInit, initUrl, {
    lessonId: L.complete.id, sizeBytes: -5, contentType: "application/pdf",
  });
  eq(
    kInitBadSize.status,
    409,
    "K-g: a nonsensical size still fails closed (409, no grant possible)"
  );
  eq(
    kInitBadSize.json?.code,
    "PRESIGNED_UNSUPPORTED",
    "K-g: even refusal is the documented machine contract, never a silent 200"
  );
  const kInitBadType = await POST_JSON(R.teacherMediaInit, initUrl, {
    lessonId: L.complete.id, sizeBytes: 4096, contentType: "video/mp4",
  });
  eq(
    kInitBadType.status,
    409,
    "K-g: a video content-type at the pdf-pinned teacher init → 409, no grant"
  );

  asUser(null);

  // Cross-scope full list checks — restore the teacher B session first.
  asUser(teacherUserB);
  const listB = await GET(R.teacherSessions, "http://t/api/teacher/sessions");
  const listBIds = (listB.json.sessions ?? []).map((s) => s.id);
  ok(listBIds.includes(L.foreign.id) && !listBIds.includes(L.complete.id),
    "H: teacher B sees exactly the B-course sessions");
  asUser(teacherUserA);

  // ---------------------------------------------------------------------------
  // L. Service-level manage-own completion matrix (Phase K core). Switches
  //    MEDIA_BACKEND to "s3" so the REAL compiled initPresignedUpload /
  //    completePresignedUpload run with a deterministic in-memory presigning
  //    backend injected via deps — exercising the SAME primary path that
  //    production runs (presign → PUT → complete → finalize), with the
  //    ownership partition evaluated by finalizeLessonPdfMaterial inside the
  //    transaction. MUST run last: it mutates process.env.
  // ---------------------------------------------------------------------------

  const prevMediaBackend = process.env.MEDIA_BACKEND;
  process.env.MEDIA_BACKEND = "s3";
  const fakeStore = new Map();
  const fakeBackend = {
    name: "s3",
    async write(key, data) { fakeStore.set(key, Buffer.from(data)); return key; },
    async read(key) {
      if (!fakeStore.has(key)) throw new Error("fake-s3: object not found");
      return fakeStore.get(key);
    },
    async delete(key) { fakeStore.delete(key); },
    async stat(key) {
      const d = fakeStore.get(key);
      if (!d) return null;
      return { size: d.length, lastModified: new Date(), contentType: "application/pdf" };
    },
    async sha256(key) {
      const d = fakeStore.get(key);
      if (!d) throw new Error("fake-s3: object not found");
      return createHash("sha256").update(d).digest("hex");
    },
    async readStream(key, range = {}) {
      const d = fakeStore.get(key);
      if (!d) return null;
      const start = range.start ?? 0;
      const end = Math.min(range.end ?? d.length - 1, d.length - 1);
      const bytes = d.subarray(start, Math.max(start, end + 1));
      return {
        stream: Readable.from(bytes),
        size: d.length,
        start,
        end,
        contentLength: bytes.length,
      };
    },
  };
  const svcNow = () => Math.floor(Date.now() / 1000);
  const svcSecret = "phaseK-test-hmac";
  const mkPdfIntent = (sub, lessonId, key, over = {}) =>
    R.mediaUploadLib.signUploadIntent(
      {
        v: 2,
        jti: randomUUID(),
        sub,
        purpose: "LESSON_PDF",
        kind: "DOCUMENT",
        key,
        contentType: "application/pdf",
        maxBytes: 64 * 1024 * 1024,
        batchId: null,
        lessonId,
        iat: svcNow() - 60,
        exp: svcNow() + 600,
        ...over,
      },
      svcSecret
    );
  const svcDeps = { db: client, backend: fakeBackend, nowSec: svcNow, hmacSecret: svcSecret };

  // Isolated lesson for this matrix: teacher A owns it, nothing else touches
  // it, so the assertions can be exact about rows and bytes.
  const svcLesson = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unitA.id, officialCode: "PE-K1", title: "Presigned manage-own session",
      titleAr: "حصة ادارة-الملكية", order: 90, trackScope: "SHARED",
      status: "DRAFT", curriculumStatus: "OFFICIAL",
    },
  });

  // (i) An ADMIN-owned active material of the same lesson × scope exists: the
  //     manage-own teacher completion must fail closed — FOREIGN_ACTIVE — and
  //     the admin's row + bytes must remain exactly as they were.
  const svcPdfAdm = Buffer.concat([PDF_BYTES, Buffer.from(" admin-bytes")]);
  const svcAdminAsset = await client.mediaAsset.create({
    data: {
      kind: "DOCUMENT", storage: "LOCAL_PRIVATE",
      storageKey: `svc/admin-${randomUUID().slice(0, 8)}.pdf`,
      sizeBytes: svcPdfAdm.length, mimeType: "application/pdf",
      originalName: "admin-managed.pdf", isPrivate: true,
      createdById: adminUser.id,
    },
  });
  const svcAdminMaterial = await client.material.create({
    data: {
      lessonId: svcLesson.id, title: "إدارة PDF", kind: "ADMIN_UPLOADED",
      trackScope: "SHARED", mediaAssetId: svcAdminAsset.id, isActive: true,
    },
  });
  const k1Key = `media-uploads/pdfs/${randomUUID()}.pdf`;
  fakeStore.set(k1Key, Buffer.concat([PDF_BYTES, Buffer.from(" k1-bytes")]));
  const k1Token = mkPdfIntent(teacherUserA.id, svcLesson.id, k1Key);
  const k1Complete = await R.mediaUploadLib.completePresignedUpload(
    {
      token: k1Token,
      actorUserId: teacherUserA.id,
      manageOwn: { userId: teacherUserA.id },
      title: "ملف المعلم",
      originalName: "t.pdf",
    },
    svcDeps
  );
  eq(k1Complete.ok, false, "L-i: foreign ACTIVE material → manage-own completion refused");
  eq(
    k1Complete.code,
    "FOREIGN_ACTIVE",
    "L-i: the refusal is the machine code FOREIGN_ACTIVE (409, replace-request flow)"
  );
  const k1AdminRow = await client.material.findUnique({ where: { id: svcAdminMaterial.id } });
  eq(k1AdminRow.isActive, true, "L-i: the admin material row stays ACTIVE — untouched");
  const k1AllRows = await client.material.findMany({ where: { lessonId: svcLesson.id } });
  eq(k1AllRows.length, 1, "L-i: NO material rows were created or deactivated by the refusal");
  eq(
    fakeStore.has(k1Key),
    false,
    "L-i: the refusal deleted the teacher's freshly uploaded bytes from the bucket"
  );

  // (ii) With only the teacher's OWN prior active in place (a FRESH lesson,
  //      so the refusal scenario above cannot interfere), the same completion
  //      replaces it: new row ACTIVE, old row deactivated.
  const svcLesson2 = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unitA.id, officialCode: "PE-K2", title: "Presigned manage-own replace session",
      titleAr: "حصة استبدال-الملكية", order: 91, trackScope: "SHARED",
      status: "DRAFT", curriculumStatus: "OFFICIAL",
    },
  });
  const svcPdfOwn = Buffer.concat([PDF_BYTES, Buffer.from(" own-old-bytes")]);
  const svcOwnAsset = await client.mediaAsset.create({
    data: {
      kind: "DOCUMENT", storage: "LOCAL_PRIVATE",
      storageKey: `svc/own-${randomUUID().slice(0, 8)}.pdf`,
      sizeBytes: svcPdfOwn.length, mimeType: "application/pdf",
      originalName: "old-own.pdf", isPrivate: true,
      createdById: teacherUserA.id,
    },
  });
  const svcOwnMaterial = await client.material.create({
    data: {
      lessonId: svcLesson2.id, title: "قابل للاستبدال PDF", kind: "ADMIN_UPLOADED",
      trackScope: "SHARED", mediaAssetId: svcOwnAsset.id, isActive: true,
    },
  });
  const k2Key = `media-uploads/pdfs/${randomUUID()}.pdf`;
  fakeStore.set(k2Key, Buffer.concat([PDF_BYTES, Buffer.from(" k2-bytes")]));
  const k2Token = mkPdfIntent(teacherUserA.id, svcLesson2.id, k2Key);
  const k2Complete = await R.mediaUploadLib.completePresignedUpload(
    {
      token: k2Token,
      actorUserId: teacherUserA.id,
      manageOwn: { userId: teacherUserA.id },
      title: "الجديد",
      originalName: "new.pdf",
    },
    svcDeps
  );
  ok(
    k2Complete.ok === true,
    "L-ii: own-prior manage-own completion succeeds",
    JSON.stringify(k2Complete)
  );
  const k2OldRow = await client.material.findUnique({ where: { id: svcOwnMaterial.id } });
  eq(k2OldRow.isActive, false, "L-ii: the teacher's OWN prior active was deactivated");
  eq(
    k2Complete.replaced?.some?.(
      (r) => r.materialId === svcOwnMaterial.id
    ) ?? false,
    true,
    "L-ii: the completion REPORTS the deactivation of the teacher's own prior row"
  );
  const k2Actives = await client.material.findMany({
    where: { lessonId: svcLesson2.id, isActive: true },
  });
  eq(k2Actives.length, 1, "L-ii: exactly ONE active material for the lesson");
  const k2NewAsset = await client.mediaAsset.findUnique({
    where: { id: k2Actives[0].mediaAssetId },
  });
  eq(k2NewAsset.createdById, teacherUserA.id, "L-ii: the new Asset records the teacher as its uploader");
  eq(k2Actives[0].title, "الجديد", "L-ii: manage-own completion honored the teacher's title");
  eq(fakeStore.has(k2Key), true, "L-ii: the completed bytes stayed in the bucket (referenced now)");

  // (iii) Idempotency: replaying the same token is a clean no-op — no new rows.
  const k3RowsBefore = (await client.material.findMany({
    where: { lessonId: svcLesson2.id },
  })).length;
  const k3Replay = await R.mediaUploadLib.completePresignedUpload(
    {
      token: k2Token,
      actorUserId: teacherUserA.id,
      manageOwn: { userId: teacherUserA.id },
      title: "الجديد",
      originalName: "new.pdf",
    },
    svcDeps
  );
  eq(k3Replay.ok, true, "L-iii: completing the SAME intent token again → replay OK");
  eq(k3Replay.replay === true, true, "L-iii: the replay reports itself as a replay");
  const k3RowsAfter = (await client.material.findMany({
    where: { lessonId: svcLesson2.id },
  })).length;
  eq(k3RowsAfter, k3RowsBefore, "L-iii: replay creates no rows");

  // (iv) A second teacher's upload for the SAME lesson fails closed again now
  //      that the ACTIVE row belongs to teacher A — cross-user manage-own
  //      boundaries are enforced for BOTH directions.
  const k4Key = `media-uploads/pdfs/${randomUUID()}.pdf`;
  fakeStore.set(k4Key, Buffer.concat([PDF_BYTES, Buffer.from(" k4-bytes")]));
  const k4Token = mkPdfIntent(teacherUserB.id, svcLesson2.id, k4Key);
  const k4Complete = await R.mediaUploadLib.completePresignedUpload(
    {
      token: k4Token,
      actorUserId: teacherUserB.id,
      manageOwn: { userId: teacherUserB.id },
      title: "b.pdf",
    },
    svcDeps
  );
  eq(k4Complete.ok, false, "L-iv: another teacher's completion vs A's active → refused");
  eq(k4Complete.code, "FOREIGN_ACTIVE", "L-iv: refused with FOREIGN_ACTIVE (teacher-teacher boundary)");
  const k4Actives = await client.material.findMany({
    where: { lessonId: svcLesson2.id, isActive: true },
  });
  eq(
    k4Actives.length === 1 && k4Actives[0].title === "الجديد",
    true,
    "L-iv: teacher A's active row survived the refused completion"
  );

  // Restore the verifier-default backend — the local-volume path is what the
  // teacher E2E legs above were pinned against.
  if (prevMediaBackend === undefined) {
    delete process.env.MEDIA_BACKEND;
  } else {
    process.env.MEDIA_BACKEND = prevMediaBackend;
  }

  // ---------------------------------------------------------------------------
  // M. Homework dialog — manual-QA source contract (readable deadline + own copy)
  //
  // Two dialogue defects were reported by manual QA on the Phase E workspace:
  // (i) the deadline `datetime-local` input was clipped inside the 3-column
  //     grid and unreadable, and (ii) the save button showing the QUIZ copy
  //     "احفظ الـQuiz" (teacher.089). The fix introduces a DeadlineField that
  //     composes the design system's Calendar + Popover with a native time
  //     input while preserving the EXACT stored value/payload semantics.
  // ---------------------------------------------------------------------------
  {
    const { execFileSync: git } = require("child_process");
    const readF = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
    const authoring = readF("src/components/teacher/teacher-authoring.tsx");
    const dict2026 = readF("src/lib/i18n-dict-2026.ts");
    // The HomeworkDialog body spans from its declaration to the next
    // component declaration after its DialogContent close (question manager).
    const hwDialogIdx = authoring.indexOf("export function HomeworkDialog");
    const qmDialogIdx = authoring.indexOf("export function QuestionManagerDialog");
    const hwDialog = authoring.slice(hwDialogIdx, qmDialogIdx);
    ok(hwDialogIdx > 0 && qmDialogIdx > hwDialogIdx, "M0: HomeworkDialog region isolated in teacher-authoring.tsx");

    // M1 — no Quiz wording inside the Homework dialog: the Quiz save copy
    // (teacher.089) must not appear anywhere in the HomeworkDialog region and
    // the create/edit buttons are Homework-specific dict keys gated on editing.
    ok(!hwDialog.includes('tr("teacher.089")'), "M1a: Homework dialog no longer uses the Quiz save copy (teacher.089)");
    ok(
      hwDialog.includes('editing ? tr("teacher.307") : tr("teacher.306")'),
      "M1b: Homework save button = create/edit Homework copy gated on `editing`"
    );
    ok(
      dict2026.includes('"teacher.306": { ar: "إنشاء الواجب"') &&
        dict2026.includes('"teacher.307": { ar: "حفظ التعديلات"'),
      "M1c: teacher.306 (create) + teacher.307 (edit) Homework copy exist in the 2026 dict"
    );

    // M2 — separate, readable date/time UI: the clipped datetime-local input is
    // gone from the authoring surface; a DeadlineField composes the design
    // system's Calendar inside a Popover with an explicit type=time input and
    // a locale-formatted summary (Intl.DateTimeFormat via useLocale).
    ok(!authoring.includes('type="datetime-local"'), "M2a: clipped datetime-local input removed from teacher authoring");
    ok(
      authoring.includes("function DeadlineField") &&
        authoring.includes('from "@/components/ui/calendar"') &&
        authoring.includes('from "@/components/ui/popover"'),
      "M2b: DeadlineField composes the design-system Calendar + Popover (no parallel date system)"
    );
    ok(
      authoring.includes('type="time"'),
      "M2c: the clock is a separate native time input"
    );
    ok(
      authoring.includes("Intl.DateTimeFormat") && authoring.includes("useLocale"),
      "M2d: Arabic/English summary is locale-formatted (Intl.DateTimeFormat + useLocale)"
    );

    // M3 — edit hydration: state is seeded from the saved deadline and the
    // DeadlineField both displays and edits that single source of truth.
    ok(
      authoring.includes("toLocalInput(homework?.deadline)") &&
        hwDialog.includes("<DeadlineField value={deadline} onChange={setDeadline} />"),
      "M3: edit mode hydrates the saved deadline through toLocalInput into DeadlineField"
    );

    // M4/M5 — payload shape is IDENTICAL for create (POST) and edit (PATCH):
    // the single mutationFn still sends `new Date(deadline).toISOString()`.
    ok(
      hwDialog.includes("deadline: deadline ? new Date(deadline).toISOString() : \"\""),
      "M4: homework payload still serializes deadline via new Date(...).toISOString()"
    );
    ok(
      hwDialog.includes('"/api/teacher/homework"') &&
        hwDialog.includes("`/api/teacher/homework/${homework!.id}`") &&
        hwDialog.includes('editing\n        ? `/api/teacher/homework/${homework!.id}`') &&
        hwDialog.includes('method: editing ? "PATCH" : "POST",'),
      "M5: same payload feeds both POST (create) and PATCH (edit) endpoints"
    );

    // M6 — Homework API semantics untouched (create + edit + delete routes are
    // byte-identical to the committed Phase E handoff).
    let apiClean = true;
    try {
      git("git", ["diff", "--exit-code", "HEAD", "--",
        "src/app/api/teacher/homework/route.ts",
        "src/app/api/teacher/homework/[id]/route.ts",
      ], { cwd: REPO, stdio: "pipe" });
    } catch { apiClean = false; }
    ok(apiClean, "M6: teacher homework API routes are byte-identical to HEAD (semantics unchanged)");

    // M7 — the Quiz dialog/legacy teacher dashboard was NOT touched by this fix.
    let quizClean = true;
    try {
      git("git", ["diff", "--exit-code", "HEAD", "--",
        "src/components/teacher/teacher-dashboard.tsx",
      ], { cwd: REPO, stdio: "pipe" });
    } catch { quizClean = false; }
    ok(quizClean, "M7: legacy Quiz dialog (teacher-dashboard.tsx) untouched by the Homework fix");
  }

  // ---- summary --------------------------------------------------------------
  console.log(`\nPHASE-E-TEACHER-SESSIONS: ${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("verifier crashed:", e);
  process.exitCode = 1;
});
