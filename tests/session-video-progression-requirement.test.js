// CodeMind Academy — SessionVideo progression requirement (REQUIRED-vs-OPTIONAL).
//
// The Phase B M2 revision: an OPTIONAL recording is never a progression input
// (the preserved M2 behaviour); a REQUIRED one gates its lesson with its OWN
// threshold, satisfied by LIVE server-recorded watch percent. UNTRACKABLE
// (external) sources can neither accrue percent nor be required — the
// `course.227` promise ("نسبة المشاهدة غير متاحة") made whole.
//
// PINNED BEHAVIOR (A–N):
//   A. admin create: required persists (upload), defaults false/95, external+
//      required → 422, boundaries 50/95/100 accepted, out-of-range +
//      non-numeric → 422 (NEVER clamped), nothing written on refusal.
//   B. admin edit: flag/percent edits persist independently, external flip
//      refused (row unchanged), admin list serialises the flags.
//   C. fixture setup for the multi/threshold/isolation legs (no pins).
//   D. student list payload: isRequiredForProgression + trackable +
//      requiredPercent + progress.satisfied; locked lessons yield no videos.
//   E. heartbeat: managed accrues (first beat credits zero — the no-spoof
//      rule), external → 409 + nothing stored, cross-batch → 403.
//   F. engine via the lesson route: required/unmet shape (counts + items +
//      VIDEO_INCOMPLETE), claim refused, then satisfied → claim completes.
//   G. multi-video: counts name 1 of 2, custom threshold honored, retroactive
//      raise unmeets the frozen row WITHOUT rewriting it.
//   H. batch isolation: another batch's required row is invisible in items
//      and cannot ungate a completed lesson.
//   I. optional-only lesson: no requirement, NO_COMPLETION_REQUIREMENTS
//      boundary, claim refused, nothing written.
//   J. fail-closed: a required-but-untrackable row (reachable only by direct
//      seeding — every write path refuses it) gates with percent-passing yet
//      unmet.
//   K. legacy: Lesson.videoUrl still requires/satisfies alone, with the exact
//      historical payload shape (no counts/items keys).
//   L. direct-URL/media: a required video streams like any other (owner 200
//      exact bytes, cross-batch 403, unpublished 403).
//   M. no-spoof restatement (explicit label on E1's facts).
//   N. source/UI pins: engine rule, adapter delegation, presigned
//      passthrough, admin toggle + edit form, student badges + beat guard,
//      lesson trichotomy, exact Arabic copy.
//
// What is REAL here: the compiled shipped route handlers, the SQLite database
// built from the real migration SQL, the progression engine, the enrollment /
// entitlement / track modules. What is SHIMMED: the Prisma engine
// (sqlite-prisma-lite over node:sqlite), auth (script-controlled user),
// next/server, next/headers.
//
// Run: node --test tests/session-video-progression-requirement.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const assert = require("node:assert");

const REPO = path.resolve(__dirname, "..");

// Media env MUST be set before the compiled media.js module loads (it reads
// these at import time, exactly like production).
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-svreq-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_DIR;
process.env.MEDIA_BACKEND = "local";
process.env.MEDIA_MAX_VIDEO_BYTES = String(1024 * 1024);
process.env.SECURITY_HASH_SECRET = "s".repeat(64);

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`svreq test made a network connection attempt: ${JSON.stringify(args[0])}`);
  };
  process.on("exit", () => {
    net.Socket.prototype.connect = realConnect;
  });
}

const { DatabaseSync } = require("node:sqlite");
const mig = require(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts", "lib", "sqlite-prisma-lite.mjs"));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
}
function eq(got, want, label) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label} (got ${a}, want ${b})`);
}
const ids = (rows) => rows.map((r) => r.id);
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// Scratch database: base DDL + every real migration (same as the Phase A e2e).
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "svreq: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// Compile the shipped TypeScript with the repo's own tsc; load with shims.
// ---------------------------------------------------------------------------
const REAL_CODE_MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/media.ts",
  "src/lib/video-url.ts",
  "src/lib/session-video-link.ts",
  "src/lib/storage-quotas.ts",
  "src/lib/subscription-entitlement.ts",
  "src/lib/enrollment.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/curriculum-visibility.ts",
  "src/lib/parent-access.ts",
  "src/lib/session-materials.ts",
  "src/lib/session-quiz.ts",
  "src/lib/quiz-blueprint.ts",
  "src/lib/rate-limit.ts",
  "src/lib/api.ts",
  // route handlers under test
  "src/app/api/admin/session-videos/route.ts",
  "src/app/api/admin/session-videos/[id]/route.ts",
  "src/app/api/students/me/session-videos/route.ts",
  "src/app/api/students/me/session-videos/[id]/progress/route.ts",
  "src/app/api/media/[id]/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/lessons/[id]/progress/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-svreq-compile-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
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
        outDir: OUT,
      },
      files: REAL_CODE_MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
try {
  execFileSync(
    process.execPath,
    [path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch {
  /* type noise tolerated — the emitted files matter */
}
for (const f of REAL_CODE_MODULES) {
  const emitted = path.join(OUT, f.replace(/\.ts$/, ".js"));
  assert.ok(fs.existsSync(emitted), `tsc emitted ${f}`);
}
const EMIT = path.join(OUT, "src");

// ---------------------------------------------------------------------------
// Shims: db → the real sqlite client, auth → script-controlled user.
// ---------------------------------------------------------------------------
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
const SHIM_FILES = {
  "__db-shim.js": `module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };`,
  "__auth-shim.js": `module.exports = { getCurrentUser: async () => globalThis.__CM_USER__ ?? null };`,
  "__next-server-shim.js": NEXT_SERVER_SHIM,
  "__next-headers-shim.js": `module.exports = { cookies: async () => ({ get: () => undefined }) };`,
};
for (const [name, code] of Object.entries(SHIM_FILES)) {
  fs.writeFileSync(path.join(OUT, name), code);
}
const Module = require("node:module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "__db-shim.js");
  if (request === "@/lib/auth") return path.join(OUT, "__auth-shim.js");
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  try {
    return originalResolve.call(this, request, ...rest);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};
const route = (p) => require(path.join(OUT, "src/app/api", p));
const R = {
  adminVideos: route("admin/session-videos/route.js"),
  adminVideo: route("admin/session-videos/[id]/route.js"),
  videos: route("students/me/session-videos/route.js"),
  videoProgress: route("students/me/session-videos/[id]/progress/route.js"),
  media: route("media/[id]/route.js"),
  lesson: route("lessons/[id]/route.js"),
  lessonProgress: route("lessons/[id]/progress/route.js"),
};

// ---------------------------------------------------------------------------
// HTTP-lite driver (same shape as the Phase A/B e2e).
// ---------------------------------------------------------------------------
function jsonReq(url, body) {
  return {
    url,
    method: "GET",
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
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
          ? "multipart/form-data; boundary=----cma"
          : null,
    },
    json: async () => ({}),
    formData: async () => form,
  };
}
function asUser(u) {
  globalThis.__CM_USER__ = u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}
async function call(handler, req, params) {
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  const ct = res.headers?.get?.("content-type") || "";
  if (ct.includes("application/json")) {
    return { status: res.status, json: await res.json() };
  }
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
}
const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);
const POST_FORM = (r, url, form, params) => call(r.POST, formReq(url, form), params);
const PATCH_JSON = (r, url, body, params) => call(r.PATCH, jsonReq(url, body), params);

// ---------------------------------------------------------------------------
test("SessionVideo progression requirement (REQUIRED-vs-OPTIONAL)", async () => {
  // ===========================================================================
  // Seed — one course, two batches (ARABIC + LANGUAGE), two students, five lessons:
  //   Lreq   (order 1) — one REQUIRED recording (admin-created in A1)
  //   Lmulti (order 2) — two REQUIRED recordings (95 + custom 60)
  //   Lleg   (order 3) — LEGACY videoUrl only
  //   Lopt   (order 4) — OPTIONAL recordings only (empty until section J)
  //   Lbound (order 5) — threshold-boundary target: admin-validation rows only,
  //     chain-locked behind uncompletable Lopt, never in a student flow
  // ===========================================================================
  const course = await client.course.create({
    data: { slug: "svreq-a", name: "Course A", nameAr: "كورس أ", description: "svreq" },
  });
  const partA = await client.part.create({
    data: { courseId: course.id, title: "P1", titleAr: "P1", order: 1 },
  });
  const unitA = await client.unit.create({
    data: { partId: partA.id, title: "U1", titleAr: "U1", order: 1 },
  });
  const mkLesson = (over) =>
    client.lesson.create({
      data: {
        unitId: unitA.id,
        trackScope: "SHARED",
        status: "PUBLISHED",
        curriculumStatus: "OFFICIAL",
        isPublished: true,
        ...over,
      },
    });
  const Lreq = await mkLesson({ order: 1, officialCode: "1-1", title: "Required session", titleAr: "حصة مطلوبة" });
  const Lmulti = await mkLesson({ order: 2, officialCode: "1-2", title: "Multi session", titleAr: "حصة متعددة" });
  const Lleg = await mkLesson({
    order: 3, officialCode: "1-3", title: "Legacy session", titleAr: "حصة قديمة",
    videoUrl: "https://www.youtube.com/watch?v=legacySvreq",
  });
  const Lopt = await mkLesson({ order: 4, officialCode: "1-4", title: "Optional session", titleAr: "حصة إضافية" });
  const Lbound = await mkLesson({ order: 5, officialCode: "1-5", title: "Boundary session", titleAr: "حصة الحدود" });

  const batchAr = await client.batch.create({
    data: { name: "Batch AR", nameAr: "دفعة عربي", schoolType: "ARABIC", courseId: course.id },
  });
  // Batch @@unique([schoolType, courseId]): the second batch is LANGUAGE.
  const batchAr2 = await client.batch.create({
    data: { name: "Batch LANG", nameAr: "دفعة لغات", schoolType: "LANGUAGE", courseId: course.id },
  });
  const groupA = await client.group.create({
    data: { name: "Group A", courseId: course.id, isActive: true },
  });
  const mkStudent = async (tag, { batchId, schoolType }) => {
    const u = await client.user.create({
      data: { email: `${tag}@svreq.test`, password: "x", name: tag, role: "STUDENT" },
    });
    const s = await client.student.create({
      data: { userId: u.id, schoolType, groupId: groupA.id, batchId },
    });
    return { user: u, student: s };
  };
  // No Subscription rows → legacy grandfathered access: an ACTIVE group bound
  // to a course is enough.
  const s1 = await mkStudent("s-one", { batchId: batchAr.id, schoolType: "ARABIC" });
  const s2 = await mkStudent("s-two", { batchId: batchAr2.id, schoolType: "LANGUAGE" });
  const admin = await client.user.create({
    data: { email: "admin@svreq.test", password: "x", name: "A", role: "ADMIN" },
  });

  const MP4_BYTES = Buffer.from(`cm-svreq-mp4-${"x".repeat(1024)}`);
  const mp4File = () => new File([MP4_BYTES], "clip.mp4", { type: "video/mp4" });
  const uploadForm = ({ lessonId, required, percent, publish = true }) => {
    const f = new FormData();
    f.set("batchId", batchAr.id);
    f.set("lessonId", lessonId);
    f.set("title", `Recording ${lessonId}`);
    f.set("publish", publish ? "true" : "false");
    f.set("file", mp4File());
    if (required !== undefined) f.set("isRequiredForProgression", required);
    if (percent !== undefined) f.set("requiredPercent", percent);
    return f;
  };

  // ===========================================================================
  // A. Admin create — the upload flow persists the requirement; the external
  //    flow refuses REQUIRED; boundaries 50/95/100 accepted exactly;
  //    out-of-range + non-numeric refused (422, NEVER clamped); refusals
  //    write nothing.
  // ===========================================================================
  asUser(admin);
  const a1 = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: Lreq.id, required: "true", percent: "80" })
  );
  eq(a1.status, 200, "A1: upload + required:true + 80 → 200");
  eq(a1.json.video.isRequiredForProgression, true, "A1: the response carries required=true");
  eq(a1.json.video.requiredPercent, 80, "A1: the response carries the custom 80% threshold");
  const a1row = await client.sessionVideo.findUnique({ where: { id: a1.json.video.id } });
  eq(a1row.isRequiredForProgression, true, "A1: the PERSISTED row is required");
  eq(a1row.requiredPercent, 80, "A1: the PERSISTED row keeps 80%");

  const a2 = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: Lopt.id })
  );
  eq(a2.status, 200, "A2: upload without requirement fields → 200");
  eq(a2.json.video.isRequiredForProgression, false, "A2: the default is OPTIONAL");
  eq(a2.json.video.requiredPercent, 95, "A2: the default threshold is 95");
  const a2row = await client.sessionVideo.findUnique({ where: { id: a2.json.video.id } });
  eq(a2row.isRequiredForProgression, false, "A2: the PERSISTED default is OPTIONAL");

  const videosBefore = await client.sessionVideo.count({});
  const mediaBefore = await client.mediaAsset.count({});
  const a3 = await POST_JSON(R.adminVideos, "http://t/api/admin/session-videos", {
    batchId: batchAr.id,
    lessonId: Lopt.id,
    title: "External required attempt",
    videoUrl: "https://cdn.example.com/refused.mp4",
    publish: true,
    isRequiredForProgression: true,
    requiredPercent: 80,
  });
  eq(a3.status, 422, "A3: external + required → 422");
  eq(a3.json.code, "EXTERNAL_CANNOT_BE_REQUIRED", "A3: the machine code names the contract");
  eq(a3.json.error, "لا يمكن جعل فيديو خارجي مطلوبًا لإكمال الدرس", "A3: the Arabic message is exact (api.360)");
  eq(await client.sessionVideo.count({}), videosBefore, "A3: the refused create wrote NO video row");
  eq(await client.mediaAsset.count({}), mediaBefore, "A3: the refused create wrote NO media row");

  // Threshold boundaries: omitted → 95; 50/95/100 accepted EXACTLY (uploads
  // on the validation-only Lbound lesson — REQUIRED rows must be managed).
  const a4omit = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: Lbound.id, required: "true" })
  );
  eq(a4omit.status, 200, "A4: omitted threshold + required → 200");
  eq(a4omit.json.video.requiredPercent, 95, "A4: the omitted threshold defaults to 95");
  for (const [tag, pct] of [["floor", "50"], ["mid", "95"], ["cap", "100"]]) {
    const r = await POST_FORM(
      R.adminVideos, "http://t/api/admin/session-videos",
      uploadForm({ lessonId: Lbound.id, required: "true", percent: pct })
    );
    eq(r.status, 200, `A4: required + ${pct}% → 200 (${tag} boundary)`);
    eq(r.json.video.requiredPercent, Number(pct), `A4: ${pct}% persists EXACTLY (no clamp, no rewrite)`);
    const row = await client.sessionVideo.findUnique({ where: { id: r.json.video.id } });
    eq(row.requiredPercent, Number(pct), `A4: the PERSISTED row keeps ${pct}%`);
    eq(row.isRequiredForProgression, true, `A4: the PERSISTED row is required`);
  }

  const a5 = await POST_JSON(R.adminVideos, "http://t/api/admin/session-videos", {
    batchId: batchAr.id,
    lessonId: Lopt.id,
    title: "External optional",
    videoUrl: "https://cdn.example.com/optional.mp4",
    publish: true,
  });
  eq(a5.status, 200, "A5: external + optional → 200 (untrackable is servable, just never required)");
  eq(a5.json.video.isRequiredForProgression, false, "A5: external rows stay OPTIONAL");

  // Out-of-range + non-numeric: 422, zero writes. The range rule is
  // flag-independent — even an OPTIONAL row must not store a threshold the
  // platform would never honor (a later flip to REQUIRED would inherit it).
  const beforeRefusals = await client.sessionVideo.count({});
  const beforeRefusalsMedia = await client.mediaAsset.count({});
  const a6a = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: Lbound.id, required: "true", percent: "49" })
  );
  eq(a6a.status, 422, "A6: required + 49% → 422 (below the floor, not clamped to 50)");
  eq(a6a.json.code, "INVALID_REQUIRED_PERCENT", "A6: the machine code names the contract");
  eq(a6a.json.error, "نسبة الإكمال يجب أن تكون رقمًا بين 50 و 100", "A6: the Arabic message is exact (api.361)");
  const a6b = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: Lbound.id, required: "true", percent: "101" })
  );
  eq(a6b.status, 422, "A6: required + 101% → 422 (above the cap, not clamped to 100)");
  eq(a6b.json.code, "INVALID_REQUIRED_PERCENT", "A6: the 101 refusal names the contract");
  const a6c = await POST_JSON(R.adminVideos, "http://t/api/admin/session-videos", {
    batchId: batchAr.id,
    lessonId: Lopt.id,
    title: "Optional thirty",
    videoUrl: "https://cdn.example.com/thirty.mp4",
    publish: true,
    isRequiredForProgression: false,
    requiredPercent: 30,
  });
  eq(a6c.status, 422, "A6: optional + 30% → 422 (the no-clamp rule covers every write)");
  const a6d = await POST_FORM(
    R.adminVideos, "http://t/api/admin/session-videos",
    uploadForm({ lessonId: Lbound.id, required: "true", percent: "xyz" })
  );
  eq(a6d.status, 422, "A6: required + non-numeric → 422");
  eq(a6d.json.code, "INVALID_REQUIRED_PERCENT", "A6: the garbage refusal names the contract");
  eq(await client.sessionVideo.count({}), beforeRefusals, "A6: the four refused creates wrote NO video rows");
  eq(await client.mediaAsset.count({}), beforeRefusalsMedia, "A6: the refused creates wrote NO media rows");

  const a7 = await POST_JSON(R.adminVideos, "http://t/api/admin/session-videos", {
    batchId: batchAr.id,
    lessonId: Lopt.id,
    title: "Garbage percent",
    videoUrl: "https://cdn.example.com/garbage.mp4",
    publish: true,
    requiredPercent: "abc",
  });
  eq(a7.status, 422, "A7: a non-numeric percent (external path) → 422");
  eq(a7.json.code, "INVALID_REQUIRED_PERCENT", "A7: the machine code names the contract");
  eq(a7.json.error, "نسبة الإكمال يجب أن تكون رقمًا بين 50 و 100", "A7: the Arabic message is exact (api.361)");
  eq(await client.sessionVideo.count({}), videosBefore + 5, "A7: only the five accepted creates persisted (A4×4 + A5)");

  // ===========================================================================
  // B. Admin edit — flag and percent persist independently; the external flip
  //    is refused with the row untouched; the list serialises the flags.
  // ===========================================================================
  const b1 = await PATCH_JSON(
    R.adminVideo, `http://t/api/admin/session-videos/${a1.json.video.id}`,
    { requiredPercent: 90 }, { id: a1.json.video.id }
  );
  eq(b1.status, 200, "B1: percent-only edit → 200");
  eq(b1.json.video.requiredPercent, 90, "B1: the threshold moves to 90");
  eq(b1.json.video.isRequiredForProgression, true, "B1: a percent-only edit keeps requiredness");
  const b2 = await PATCH_JSON(
    R.adminVideo, `http://t/api/admin/session-videos/${a2.json.video.id}`,
    { isRequiredForProgression: true }, { id: a2.json.video.id }
  );
  eq(b2.status, 200, "B2: a managed video flips to REQUIRED → 200");
  eq(b2.json.video.isRequiredForProgression, true, "B2: the flip persists");
  eq(b2.json.video.requiredPercent, 95, "B2: a flag-only edit keeps the stored threshold");
  // Lopt must stay the optional-only boundary for sections D/I — flip it back.
  const b2back = await PATCH_JSON(
    R.adminVideo, `http://t/api/admin/session-videos/${a2.json.video.id}`,
    { isRequiredForProgression: false }, { id: a2.json.video.id }
  );
  eq(b2back.json.video.isRequiredForProgression, false, "B2: REQUIRED flips back to OPTIONAL");
  const b3 = await PATCH_JSON(
    R.adminVideo, `http://t/api/admin/session-videos/${a5.json.video.id}`,
    { isRequiredForProgression: true }, { id: a5.json.video.id }
  );
  eq(b3.status, 422, "B3: flipping an EXTERNAL video to required → 422");
  eq(b3.json.code, "EXTERNAL_CANNOT_BE_REQUIRED", "B3: the machine code names the contract");
  const b3row = await client.sessionVideo.findUnique({ where: { id: a5.json.video.id } });
  eq(b3row.isRequiredForProgression, false, "B3: the refused edit left the row OPTIONAL");
  const b4 = await PATCH_JSON(
    R.adminVideo, `http://t/api/admin/session-videos/${a1.json.video.id}`,
    { requiredPercent: "abc" }, { id: a1.json.video.id }
  );
  eq(b4.status, 422, "B4: a garbage percent edit → 422");
  eq(b4.json.code, "INVALID_REQUIRED_PERCENT", "B4: the machine code names the contract");
  const b4row = await client.sessionVideo.findUnique({ where: { id: a1.json.video.id } });
  eq(b4row.requiredPercent, 90, "B4: the refused edit left the threshold at 90");
  eq(b4row.isRequiredForProgression, true, "B4: the refused edit left requiredness untouched");
  const b4b = await PATCH_JSON(
    R.adminVideo, `http://t/api/admin/session-videos/${a1.json.video.id}`,
    { requiredPercent: 49 }, { id: a1.json.video.id }
  );
  eq(b4b.status, 422, "B4: an out-of-range percent edit → 422");
  const b4brow = await client.sessionVideo.findUnique({ where: { id: a1.json.video.id } });
  eq(
    { p: b4brow.requiredPercent, r: b4brow.isRequiredForProgression },
    { p: 90, r: true },
    "B4: the invalid edit left the requirement fields byte-for-byte unchanged"
  );
  const b5 = await GET(R.adminVideos, `http://t/api/admin/session-videos?batchId=${batchAr.id}`, {});
  eq(b5.status, 200, "B5: the admin list 200s");
  const b5a1 = b5.json.videos.find((v) => v.id === a1.json.video.id);
  eq(b5a1.isRequiredForProgression, true, "B5: the list serialises required=true");
  eq(b5a1.requiredPercent, 90, "B5: the list serialises the 90% threshold");

  // ===========================================================================
  // C. Fixture setup for the multi / threshold / isolation / media legs.
  // ===========================================================================
  const BYTES = (tag) => Buffer.from(`cm-svreq-bytes-${tag}-${"x".repeat(64)}`);
  const mkPrivateVideo = async (tag, { batchId, lessonId, published = true, at = null, key, required = false, percent = 95 }) => {
    const file = path.join(MEDIA_DIR, key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, BYTES(tag));
    const asset = await client.mediaAsset.create({
      data: {
        kind: "VIDEO", storage: "LOCAL_PRIVATE", storageKey: key,
        mimeType: "video/mp4", sizeBytes: BYTES(tag).length, isPrivate: true,
      },
    });
    return {
      asset,
      video: await client.sessionVideo.create({
        data: {
          batchId, lessonId, mediaAssetId: asset.id,
          title: `Video ${tag}`, titleAr: `تسجيل ${tag}`,
          isPublished: published, publishedAt: published ? (at ?? new Date()) : null,
          isRequiredForProgression: required, requiredPercent: percent,
        },
      }),
    };
  };
  const D = (h) => new Date(Date.UTC(2026, 8, 1, h, 0, 0));
  const mA = await mkPrivateVideo("multi-a", {
    batchId: batchAr.id, lessonId: Lmulti.id, at: D(2), key: "svreq/multi-a.mp4", required: true, percent: 95,
  });
  const mB = await mkPrivateVideo("multi-b", {
    batchId: batchAr.id, lessonId: Lmulti.id, at: D(3), key: "svreq/multi-b.mp4", required: true, percent: 60,
  });
  const s2vid = await mkPrivateVideo("s2-own", {
    batchId: batchAr2.id, lessonId: Lreq.id, at: D(4), key: "svreq/s2-own.mp4", required: true, percent: 95,
  });
  const mUnpub = await mkPrivateVideo("unpub", {
    batchId: batchAr.id, lessonId: Lreq.id, published: false, key: "svreq/unpub.mp4",
  });

  // ===========================================================================
  // D. Student list payload — the requirement flags ride the authorized list;
  //    locked lessons yield no videos (the progression gate, not an oracle).
  // ===========================================================================
  asUser(s1.user);
  const d1 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${Lreq.id}`);
  const d1a1 = d1.json.videos.find((v) => v.id === a1.json.video.id);
  ok(!!d1a1, "D1: the required recording is listed for its lesson");
  eq(d1a1.isRequiredForProgression, true, "D1: the list names it REQUIRED");
  eq(d1a1.trackable, true, "D1: the managed upload is trackable");
  eq(d1a1.requiredPercent, 90, "D1: the list carries its own 90% threshold");
  eq(d1a1.progress.satisfied, false, "D1: unwatched → not satisfied (live rule)");
  eq(d1a1.progress.percent, 0, "D1: unwatched → 0%");
  ok(!ids(d1.json.videos).includes(mUnpub.video.id), "D1: the unpublished recording is absent");
  ok(!ids(d1.json.videos).includes(s2vid.video.id), "D1: the other batch's recording is absent (list isolation)");
  // (D2's Lopt list pins live after section K: Lopt is chain-locked until
  // the chain completes, so its list is empty here by the progression gate.)
  const d3 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${Lmulti.id}`);
  eq(d3.json.videos, [], "D3: the LOCKED lesson yields no videos (progression gate)");

  // ===========================================================================
  // E. Heartbeat — managed accrues (first beat credits ZERO: the client
  //    position is a cap, never a fact); external → 409 + nothing stored;
  //    cross-batch → 403 + nothing stored.
  // ===========================================================================
  const e1 = await POST_JSON(
    R.videoProgress, `http://t/api/students/me/session-videos/${a1.json.video.id}/progress`,
    { positionSec: 100, durationSec: 100 }, { id: a1.json.video.id }
  );
  eq(e1.status, 200, "E1: the managed required heartbeat succeeds");
  eq(e1.json.percent, 0, "E1/M: positionSec=100 on the first beat yields 0% (no-spoof: elapsed-only credit)");
  eq(e1.json.isCompleted, false, "E1: the first beat never completes");
  eq(e1.json.satisfied, false, "E1: the live verdict rides the heartbeat response");
  eq(e1.json.requiredPercent, 90, "E1: the response names the video's own threshold");
  const e1row = await client.sessionVideoView.findFirst({
    where: { sessionVideoId: a1.json.video.id, studentId: s1.student.id },
  });
  ok(!!e1row, "E1: the authorized heartbeat stored its (zero-credit) row");
  // (E2's untrackable heartbeat lives after section K: while Lopt is
  // chain-locked the lesson gate (403) precedes trackability (409) — the
  // preserved K1/K2/K3/K5 verdict order.)
  const e3 = await POST_JSON(
    R.videoProgress, `http://t/api/students/me/session-videos/${s2vid.video.id}/progress`,
    { positionSec: 10, durationSec: 100 }, { id: s2vid.video.id }
  );
  eq(e3.status, 403, "E3: heartbeat on another batch's recording → 403");
  const e3row = await client.sessionVideoView.findFirst({
    where: { sessionVideoId: s2vid.video.id, studentId: s1.student.id },
  });
  eq(e3row, null, "E3: the denied heartbeat stored NOTHING");
  asUser(s2.user);
  const e4 = await POST_JSON(
    R.videoProgress, `http://t/api/students/me/session-videos/${s2vid.video.id}/progress`,
    { positionSec: 10, durationSec: 100 }, { id: s2vid.video.id }
  );
  eq(e4.status, 200, "E4: the owner batch's heartbeat succeeds (isolation positive)");
  asUser(s1.user);
  // ===========================================================================
  // F. Engine via the lesson route — the required/unmet shape (counts +
  //    items + VIDEO_INCOMPLETE), the refused claim, then satisfaction.
  // ===========================================================================
  const kinds = (rows) => (rows ?? []).map((u) => u.kind);
  const f1 = await GET(R.lesson, `http://t/api/lessons/${Lreq.id}`, { id: Lreq.id });
  eq(f1.status, 200, "F1: the gated lesson opens (UNLOCKED, unmet)");
  const f1v = f1.json.requirements.video;
  eq(f1v.required, true, "F1: the required recording creates a video requirement");
  eq(f1v.done, false, "F1: unwatched → unmet");
  eq(f1v.value, 0, "F1: the bottleneck value is 0%");
  eq(f1v.requiredCount, 1, "F1: counts name 1 required");
  eq(f1v.completedCount, 0, "F1: counts name 0 complete");
  eq(f1v.items.length, 1, "F1: exactly one item (own batch, published, required)");
  eq(f1v.items[0].id, a1.json.video.id, "F1: the item carries the recording identity");
  eq(f1v.items[0].trackable, true, "F1: the item carries trackable");
  eq(f1v.items[0].requiredPercent, 90, "F1: the item carries its own threshold");
  eq(f1v.items[0].currentPercent, 0, "F1: the item carries the LIVE percent");
  eq(f1v.items[0].completed, false, "F1: the item carries its live verdict");
  ok(!!f1v.items[0].title, "F1: the item carries a human title");
  ok(kinds(f1.json.requirements.unmet).includes("VIDEO_INCOMPLETE"), "F1: unmet names VIDEO_INCOMPLETE");
  eq(f1.json.requirements.reasonCode, "VIDEO_INCOMPLETE", "F1: the reasonCode is the video gap");
  eq(f1.json.requirements.state, "UNLOCKED", "F1: open-but-unmet is UNLOCKED");
  const f2 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lreq.id}/progress`, { completed: true }, { id: Lreq.id });
  eq(f2.status, 403, "F2: completion with an unmet required recording → 403");
  eq(f2.json.code, "REQUIREMENTS_UNMET", "F2: the refusal keeps the structured shape");
  eq(f2.json.reasonCode, "VIDEO_INCOMPLETE", "F2: the refusal names the video gap");
  ok(kinds(f2.json.unmet).includes("VIDEO_INCOMPLETE"), "F2: the refusal lists the video code");
  await client.sessionVideoView.upsert({
    where: { sessionVideoId_studentId: { sessionVideoId: a1.json.video.id, studentId: s1.student.id } },
    create: {
      sessionVideoId: a1.json.video.id, studentId: s1.student.id,
      watchedSec: 100, durationSec: 100, percent: 100,
      isCompleted: true, completedAt: new Date(),
    },
    update: {
      watchedSec: 100, durationSec: 100, percent: 100,
      isCompleted: true, completedAt: new Date(),
    },
  });
  const f3 = await GET(R.lesson, `http://t/api/lessons/${Lreq.id}`, { id: Lreq.id });
  eq(f3.json.requirements.video.done, true, "F3: a 100% server row satisfies the 90% threshold");
  eq(f3.json.requirements.video.completedCount, 1, "F3: counts flip to 1 of 1");
  eq(f3.json.requirements.video.items[0].completed, true, "F3: the item flips to complete");
  eq(f3.json.requirements.video.items[0].currentPercent, 100, "F3: the item shows the live 100%");
  const f4 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lreq.id}/progress`, { completed: true }, { id: Lreq.id });
  eq(f4.status, 200, "F3: the satisfied claim completes");
  eq(f4.json.isCompleted, true, "F3: the legacy marker is written on success");
  eq(f4.json.completed, true, "F3: the canonical derivation agrees");

  // ===========================================================================
  // G. Multi-video — counts name 1 of 2; the custom 60% threshold is honored
  //    with its own comparison; a retroactive raise unmeets the frozen row
  //    WITHOUT rewriting it (live rule + retroactive safety).
  // ===========================================================================
  await client.sessionVideoView.upsert({
    where: { sessionVideoId_studentId: { sessionVideoId: mA.video.id, studentId: s1.student.id } },
    create: {
      sessionVideoId: mA.video.id, studentId: s1.student.id,
      watchedSec: 100, durationSec: 100, percent: 100,
      isCompleted: true, completedAt: new Date(),
    },
    update: { watchedSec: 100, durationSec: 100, percent: 100, isCompleted: true, completedAt: new Date() },
  });
  const g1 = await GET(R.lesson, `http://t/api/lessons/${Lmulti.id}`, { id: Lmulti.id });
  eq(g1.status, 200, "G1: Lmulti opens once Lreq completes (chain)");
  eq(g1.json.requirements.video.required, true, "G1: two required recordings → required");
  eq(g1.json.requirements.video.done, false, "G1: one of two watched → unmet (ALL must satisfy)");
  eq(g1.json.requirements.video.requiredCount, 2, "G1: counts name 2 required");
  eq(g1.json.requirements.video.completedCount, 1, "G1: counts name 1 complete (1 من 2)");
  eq(ids(g1.json.requirements.video.items).sort(), [mA.video.id, mB.video.id].sort(), "G1: both items ride, in deterministic order");
  const g1b = g1.json.requirements.video.items.find((it) => it.id === mB.video.id);
  eq(g1b.completed, false, "G1: the unwatched item is pending");
  const g1claim = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lmulti.id}/progress`, { completed: true }, { id: Lmulti.id });
  eq(g1claim.status, 403, "G1: completion with 1 of 2 → 403");
  ok(kinds(g1claim.json.unmet).includes("VIDEO_INCOMPLETE"), "G1: the refusal names VIDEO_INCOMPLETE");
  // A frozen sticky flag ABOVE the custom threshold: satisfaction must come
  // from the live percent (65 >= 60), not from the flag.
  await client.sessionVideoView.upsert({
    where: { sessionVideoId_studentId: { sessionVideoId: mB.video.id, studentId: s1.student.id } },
    create: {
      sessionVideoId: mB.video.id, studentId: s1.student.id,
      watchedSec: 65, durationSec: 100, percent: 65,
      isCompleted: true, completedAt: new Date(),
    },
    update: { watchedSec: 65, durationSec: 100, percent: 65, isCompleted: true, completedAt: new Date() },
  });
  const g2 = await GET(R.lesson, `http://t/api/lessons/${Lmulti.id}`, { id: Lmulti.id });
  eq(g2.json.requirements.video.done, true, "G2: 65% satisfies the custom 60% threshold");
  eq(g2.json.requirements.video.items.find((it) => it.id === mB.video.id).completed, true, "G2: the custom-threshold item completes");
  const g2claim = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lmulti.id}/progress`, { completed: true }, { id: Lmulti.id });
  eq(g2claim.status, 200, "G2: the fully satisfied claim completes");
  // Retroactive raise: the SAME 65% row no longer satisfies 90%.
  asUser(admin);
  const g3patch = await PATCH_JSON(
    R.adminVideo, `http://t/api/admin/session-videos/${mB.video.id}`,
    { requiredPercent: 90 }, { id: mB.video.id }
  );
  eq(g3patch.status, 200, "G3: the threshold raise persists");
  asUser(s1.user);
  const g3 = await GET(R.lesson, `http://t/api/lessons/${Lmulti.id}`, { id: Lmulti.id });
  const g3b = g3.json.requirements.video.items.find((it) => it.id === mB.video.id);
  eq(g3.json.requirements.video.done, false, "G3: raising to 90% unmeets the frozen 65% row (live rule)");
  eq(g3b.completed, false, "G3: the item verdict flips with the live comparison");
  eq(g3b.currentPercent, 65, "G3: the item still reports the frozen 65%");
  const g3row = await client.sessionVideoView.findFirst({
    where: { sessionVideoId: mB.video.id, studentId: s1.student.id },
  });
  eq(g3row.percent, 65, "G3: the raise rewrote NO watch row (retroactive safety)");
  eq(g3row.isCompleted, true, "G3: the sticky flag is untouched history");
  const g3lp = await client.lessonProgress.findFirst({
    where: { studentId: s1.student.id, lessonId: Lmulti.id },
  });
  eq(g3lp.isCompleted, true, "G3: the completed lesson marker is NEVER rewritten (retroactive safety)");
  // Restore the satisfiable world for the chain below.
  asUser(admin);
  await PATCH_JSON(
    R.adminVideo, `http://t/api/admin/session-videos/${mB.video.id}`,
    { requiredPercent: 60 }, { id: mB.video.id }
  );
  asUser(s1.user);
  const g4 = await GET(R.lesson, `http://t/api/lessons/${Lmulti.id}`, { id: Lmulti.id });
  eq(g4.json.requirements.video.done, true, "G4: restoring 60% re-satisfies the live rule");

  // ===========================================================================
  // H. Batch isolation — another batch's required row is invisible in items
  //    and cannot ungate a completed lesson; it gates its own batch.
  // ===========================================================================
  const h1 = await GET(R.lesson, `http://t/api/lessons/${Lreq.id}`, { id: Lreq.id });
  ok(h1.json.requirements.video.items.every((it) => it.id === a1.json.video.id), "H1: s1's items name ONLY the own-batch recording");
  asUser(s2.user);
  const h2 = await GET(R.lesson, `http://t/api/lessons/${Lreq.id}`, { id: Lreq.id });
  eq(h2.json.requirements.video.required, true, "H2: s2's own-batch required recording gates s2");
  eq(h2.json.requirements.video.done, false, "H2: s2's recording is unmet (0% live)");
  ok(h2.json.requirements.video.items.every((it) => it.id === s2vid.video.id), "H2: s2's items name ONLY s2's recording");
  asUser(s1.user);
  const h3 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lreq.id}/progress`, { completed: true }, { id: Lreq.id });
  eq(h3.status, 200, "H3: s1's completed claim still succeeds (the foreign row cannot ungate)");
  // ===========================================================================
  // K. Legacy — Lesson.videoUrl still requires/satisfies alone, with the
  //    exact historical payload shape (no counts/items keys).
  // ===========================================================================
  const k1 = await GET(R.lesson, `http://t/api/lessons/${Lleg.id}`, { id: Lleg.id });
  eq(k1.status, 200, "K1: the legacy lesson opens once the chain reaches it");
  eq(k1.json.requirements.video.required, true, "K1: the legacy column still requires");
  eq(k1.json.requirements.video.done, false, "K1: unwatched legacy → unmet");
  eq(k1.json.requirements.video.value, 0, "K1: the legacy value is 0%");
  eq("requiredCount" in k1.json.requirements.video, false, "K1: legacy-only keeps NO counts keys");
  eq("items" in k1.json.requirements.video, false, "K1: legacy-only keeps NO items key");
  const k2 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lleg.id}/progress`, { completed: true }, { id: Lleg.id });
  eq(k2.status, 403, "K2: the unwatched legacy claim → 403");
  eq(k2.json.reasonCode, "VIDEO_INCOMPLETE", "K2: the legacy gap names the SAME video code");
  await client.lessonProgress.upsert({
    where: { studentId_lessonId: { studentId: s1.student.id, lessonId: Lleg.id } },
    create: {
      studentId: s1.student.id, lessonId: Lleg.id, progress: 0, isCompleted: false,
      videoDurationSec: 100, videoWatchedSec: 100, videoPercent: 100, videoCompleted: true,
    },
    update: { videoDurationSec: 100, videoWatchedSec: 100, videoPercent: 100, videoCompleted: true },
  });
  const k3 = await GET(R.lesson, `http://t/api/lessons/${Lleg.id}`, { id: Lleg.id });
  eq(k3.json.requirements.video.done, true, "K3: the legacy 100% row satisfies");
  eq(k3.json.requirements.video.value, 100, "K3: the legacy value is 100%");
  const k4 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lleg.id}/progress`, { completed: true }, { id: Lleg.id });
  eq(k4.status, 200, "K3: the satisfied legacy claim completes");

  // ===========================================================================
  // D2/E2 (deferred) — Lopt is unlocked now that the chain completed: the
  // optional list payload + the untrackable heartbeat refusal.
  // ===========================================================================
  const d2 = await GET(R.videos, `http://t/api/students/me/session-videos?lessonId=${Lopt.id}`);
  const d2a2 = d2.json.videos.find((v) => v.id === a2.json.video.id);
  eq(d2a2.isRequiredForProgression, false, "D2: the optional upload is listed as OPTIONAL");
  eq(d2a2.trackable, true, "D2: the optional upload is still trackable");
  const d2ext = d2.json.videos.find((v) => v.id === a5.json.video.id);
  eq(d2ext.trackable, false, "D2: the external row is untrackable");
  eq(d2ext.isExternal, true, "D2: the external row is flagged external");
  eq(d2ext.src, "https://cdn.example.com/optional.mp4", "D2: the external row serves its URL, not a path");
  const e2 = await POST_JSON(
    R.videoProgress, `http://t/api/students/me/session-videos/${a5.json.video.id}/progress`,
    { positionSec: 10, durationSec: 100 }, { id: a5.json.video.id }
  );
  eq(e2.status, 409, "E2: heartbeat on an untrackable recording → 409");
  eq(e2.json.error, "الفيديو ده بيشتغل من مصدر خارجي، فمش بيتسجل منه نسبة مشاهدة.", "E2: the refusal carries the course.227 message");
  const e2row = await client.sessionVideoView.findFirst({
    where: { sessionVideoId: a5.json.video.id, studentId: s1.student.id },
  });
  eq(e2row, null, "E2: the refused heartbeat stored NOTHING");
  // ===========================================================================
  // I. Optional-only lesson — no requirement, the NO_COMPLETION_REQUIREMENTS
  //    boundary, the refused claim, nothing written.
  // ===========================================================================
  const i1 = await GET(R.lesson, `http://t/api/lessons/${Lopt.id}`, { id: Lopt.id });
  eq(i1.status, 200, "I1: the optional-only lesson opens");
  eq(i1.json.requirements.video.required, false, "I1: OPTIONAL recordings create NO requirement (M2 preserved)");
  eq(i1.json.requirements.video.done, true, "I1: not-required is vacuously done");
  eq("requiredCount" in i1.json.requirements.video, false, "I1: no decomposition rides without required rows");
  eq(i1.json.requirements.reasonCode, "NO_COMPLETION_REQUIREMENTS", "I1: the boundary reason is named");
  eq(kinds(i1.json.requirements.unmet), ["NO_COMPLETION_REQUIREMENTS"], "I1: the ONLY blocker is the boundary");
  eq(i1.json.requirements.state, "UNLOCKED", "I1: the boundary lesson is open, never done");
  // The lesson GET above already maintains its skeletal view row — the pin
  // is that the REFUSED claim changes nothing (no marker, no progress).
  const i2before = await client.lessonProgress.findFirst({
    where: { studentId: s1.student.id, lessonId: Lopt.id },
  });
  const i2 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lopt.id}/progress`, { completed: true }, { id: Lopt.id });
  eq(i2.status, 403, "I2: completion of the empty lesson → 403");
  eq(i2.json.code, "REQUIREMENTS_UNMET", "I2: the refusal keeps the structured shape");
  eq(i2.json.reasonCode, "NO_COMPLETION_REQUIREMENTS", "I2: the refusal names the boundary (no fabricated video rule)");
  const i2row = await client.lessonProgress.findFirst({
    where: { studentId: s1.student.id, lessonId: Lopt.id },
  });
  eq(
    i2row ? { isCompleted: i2row.isCompleted, progress: i2row.progress } : null,
    i2before ? { isCompleted: i2before.isCompleted, progress: i2before.progress } : null,
    "I2: the refused claim changed NO completion fact"
  );

  // ===========================================================================
  // J. Fail-closed — a required-but-untrackable row (reachable ONLY by direct
  //    seeding: every write path refuses it — section A3/B3) gates with a
  //    percent-passing yet UNMET verdict, even against a frozen sticky flag.
  // ===========================================================================
  const jAsset = await client.mediaAsset.create({
    data: {
      kind: "VIDEO", storage: "EXTERNAL_URL",
      externalUrl: "https://cdn.example.com/legacy-required.mp4",
      mimeType: "video/mp4", isPrivate: true,
    },
  });
  const jVid = await client.sessionVideo.create({
    data: {
      batchId: batchAr.id, lessonId: Lopt.id, mediaAssetId: jAsset.id,
      title: "Legacy required external", titleAr: "مطلوب خارجي قديم",
      isPublished: true, publishedAt: new Date(),
      isRequiredForProgression: true, requiredPercent: 80,
    },
  });
  await client.sessionVideoView.create({
    data: {
      sessionVideoId: jVid.id, studentId: s1.student.id,
      watchedSec: 85, durationSec: 100, percent: 85,
      isCompleted: true, completedAt: new Date(),
    },
  });
  const j1 = await GET(R.lesson, `http://t/api/lessons/${Lopt.id}`, { id: Lopt.id });
  eq(j1.json.requirements.video.required, true, "J1: the seeded row creates a requirement (fail-closed, not silent)");
  eq(j1.json.requirements.video.done, false, "J1: 85% against 80% is UNMET while untrackable");
  eq(j1.json.requirements.video.items[0].trackable, false, "J1: the item names untrackable");
  eq(j1.json.requirements.video.items[0].currentPercent, 85, "J1: the item reports the frozen 85%");
  eq(j1.json.requirements.video.items[0].completed, false, "J1: the item verdict is unmet despite the passing percent");
  eq(j1.json.requirements.reasonCode, "VIDEO_INCOMPLETE", "J1: the blocker is the video gap");
  const j2 = await POST_JSON(R.lessonProgress, `http://t/api/lessons/${Lopt.id}/progress`, { completed: true }, { id: Lopt.id });
  eq(j2.status, 403, "J2: the fail-closed claim → 403");
  ok(kinds(j2.json.unmet).includes("VIDEO_INCOMPLETE"), "J2: the refusal names VIDEO_INCOMPLETE");

  // ===========================================================================
  // L. Direct-URL/media — a required video streams like any other: the owner
  //    gets exact bytes, cross-batch and unpublished get 403.
  // ===========================================================================
  const l1 = await GET(R.media, `http://t/api/media/${mA.asset.id}`, { id: mA.asset.id });
  eq(l1.status, 200, "L1: the owner streams the required video's bytes");
  eq(l1.bytes.equals(BYTES("multi-a")), true, "L1: the bytes are EXACT (no wrong-asset leak)");
  asUser(s2.user);
  const l2 = await GET(R.media, `http://t/api/media/${mA.asset.id}`, { id: mA.asset.id });
  eq(l2.status, 403, "L2: cross-batch byte delivery → 403");
  asUser(s1.user);
  const l3 = await GET(R.media, `http://t/api/media/${mUnpub.asset.id}`, { id: mUnpub.asset.id });
  eq(l3.status, 403, "L3: unpublished byte delivery → 403");

  // ===========================================================================
  // N. Source/UI pins — the rule in code, the toggle in the admin UI, the
  //    badges + beat guard in the student UI, the trichotomy in the lesson
  //    card, the exact Arabic copy in the catalogue.
  // ===========================================================================
  const engine = read("src/lib/progression.ts");
  ok(engine.includes("const videoRequired = lesson.hasLegacyVideo || requiredVideos.length > 0;"), "N1: the engine rule is legacy-OR-required-recordings");
  ok(engine.includes("(v) => v.trackable && (watchPercent?.get(v.id) ?? 0) >= v.requiredPercent"), "N1: satisfaction needs trackable AND the live percent");
  ok(engine.includes("completed: v.trackable && currentPercent >= v.requiredPercent,"), "N1: items fail closed on untrackable");
  ok(/isRequiredForProgression: true/.test(engine), "N1: only REQUIRED rows are engine inputs");
  ok(!/db\.question\b/.test(engine), "N1: pools stay non-inputs");
  const adapter = read("src/lib/session-progress.ts");
  ok(adapter.includes("video: { ...evaluation.video },"), "N2: the adapter re-serialises the engine verdict (delegation only)");
  ok(!/const videoRequired/.test(adapter), "N2: the adapter owns no video rule");
  const completeLib = read("src/lib/media-upload.ts");
  ok(/parseSessionVideoRequirement/.test(completeLib), "N3: the presigned completion validates through the shared contract");
  ok(/INVALID_VIDEO_REQUIREMENT/.test(completeLib), "N3: the presigned completion refuses garbage requirements");
  const completeRoute = read("src/app/api/admin/media-uploads/complete/route.ts");
  ok(completeRoute.includes("isRequiredForProgression: body.isRequiredForProgression,"), "N3: the complete route passes the flag through");
  ok(completeRoute.includes('if (result.code === "INVALID_VIDEO_REQUIREMENT") {'), "N3: the complete route special-cases the threshold refusal");
  ok(completeRoute.includes('{ error: tApi("api.361"), code: result.code }'), "N3: the presigned refusal speaks api.361 Arabic (never the English validator text)");
  ok(/INVALID_VIDEO_REQUIREMENT[\s\S]{0,200}\{ status: 422 \}/.test(completeRoute), "N3: the presigned threshold refusal is a 422");
  // The shared link/requirement validator ships to the BROWSER through
  // session-video-picker — it must never import the node-only @/lib/media
  // (fs/crypto), only the client-safe predicate module. The production build
  // caught this once (module-not-found in the client bundle); the pins keep
  // it caught.
  const linkSrc = read("src/lib/session-video-link.ts");
  ok(linkSrc.includes('from "@/lib/media-storage"'), "N3: the validator imports the client-safe storage predicates");
  ok(!linkSrc.includes('from "@/lib/media"'), "N3: the validator never imports the node-only media backend");
  const storagePreds = read("src/lib/media-storage.ts");
  ok(!/from "(fs|path|crypto|stream)"|from '\.\/media'/.test(storagePreds), "N3: the predicate module has zero node/backend imports");
  const adminView = read("src/components/admin/session-videos-view.tsx");
  ok(adminView.includes("const [isRequired, setIsRequired] = React.useState(false);"), "N4: the Required toggle defaults OFF");
  ok(adminView.includes('const [requiredPercent, setRequiredPercent] = React.useState("95");'), "N4: the threshold defaults to 95");
  ok((adminView.match(/min=\{50\}/g) || []).length === 2, "N4: BOTH threshold inputs carry min=50 (create + edit)");
  ok((adminView.match(/max=\{100\}/g) || []).length === 2, "N4: BOTH threshold inputs carry max=100 (create + edit)");
  ok(!/Math\.min\(100, Math\.max\(50/.test(adminView), "N4: the UI never clamps a threshold (server authoritative)");
  ok(adminView.includes("const threshold = requiredPercent;"), "N4: create sends the RAW typed value");
  ok(adminView.includes("const threshold = percent;"), "N4: edit sends the RAW typed value");
  ok(adminView.includes('disabled={busy || method !== "UPLOAD"}'), "N4: the toggle is disabled for external URLs");
  ok(adminView.includes('const requiredForProgression = method === "UPLOAD" && isRequired;'), "N4: the payload forces OPTIONAL for URLs");
  ok(adminView.includes('tr("admin.625")') && adminView.includes('tr("admin.626")'), "N4: the toggle + threshold labels are localised");
  ok(adminView.includes('tr("admin.627")') && adminView.includes('tr("admin.628")'), "N4: the range hint + external explainer are localised");
  ok(adminView.includes("EditVideoForm") && adminView.includes('tr("admin.629")'), "N4: the edit form ships with localised actions");
  ok(adminView.includes("{v.isRequiredForProgression && ("), "N4: required rows carry their badge");
  const studentView = read("src/components/course/session-videos-view.tsx");
  ok(studentView.includes('tr("course.243")'), "N5: the untrackable note is localised");
  ok(studentView.includes('tr("course.244")') && studentView.includes('tr("course.245")'), "N5: the required/optional badges are localised");
  ok(studentView.includes("if (!video.trackable) return;"), "N5: the player sends NO beats for untrackable sources");
  ok(studentView.includes("onProgress(d.percent, Boolean(d.isCompleted), Boolean(d.satisfied));"), "N5: the player reports percent + sticky + live verdict");
  const lessonView = read("src/components/course/student-lesson.tsx");
  ok(lessonView.includes("videoRequirementDetail"), "N6: the VIDEO row derives its detail canonically");
  ok(lessonView.includes("detail={videoRequirementDetail(data.requirements.video, t)}"), "N6: the VIDEO card row wires the canonical detail");
  ok(lessonView.includes('t("course.246", { p1: req.completedCount ?? 0, p2: req.requiredCount })'), "N6: multi-video counts render «1 من 2 فيديو مكتمل»");
  ok(lessonView.includes("if (!req.required) return undefined;"), "N6: not-required renders NO detail (the badge shows instead)");
  ok(/!req\.required\s*\?\s*"absent"/.test(lessonView), "N6: the card trichotomy branches on required FIRST");
  const dict = read("src/lib/i18n-dict-2026.ts");
  ok(dict.includes('"course.243": { ar: "نسبة المشاهدة غير متاحة", en: "Watch percentage is not available" }'), "N7: course.243 copy is exact");
  ok(dict.includes('"course.244": { ar: "مطلوب لإكمال الدرس", en: "Required to complete the lesson" }'), "N7: course.244 copy is exact");
  ok(dict.includes('"course.245": { ar: "فيديو إضافي", en: "Extra video" }'), "N7: course.245 copy is exact");
  ok(dict.includes('"course.246": { ar: "{p1} من {p2} فيديو مكتمل", en: "{p1} of {p2} videos completed" }'), "N7: course.246 copy is exact");
  ok(dict.includes('"admin.625": { ar: "مطلوب لإكمال الدرس", en: "Required to complete the lesson" }'), "N7: admin.625 copy is exact");
  ok(dict.includes('"admin.626": { ar: "نسبة المشاهدة المطلوبة (%)", en: "Required watch percent (%)" }'), "N7: admin.626 copy is exact");
  ok(dict.includes('"admin.632": { ar: "مطلوب", en: "Required" }'), "N7: admin.632 copy is exact");
  ok(dict.includes("لا يمكن جعل فيديو خارجي مطلوبًا لإكمال الدرس"), "N7: api.360 Arabic ships");
  ok(dict.includes("نسبة الإكمال يجب أن تكون رقمًا بين 50 و 100"), "N7: api.361 Arabic ships");
  const listRoute = read("src/app/api/students/me/session-videos/route.ts");
  ok(listRoute.includes("satisfied: trackable && percent >= v.requiredPercent,"), "N8: the list computes the LIVE verdict per video");
  const beatRoute = read("src/app/api/students/me/session-videos/[id]/progress/route.ts");
  ok(beatRoute.includes("if (!isManagedPrivateStorage(video.media?.storage)) {"), "N8: the heartbeat gates on managed storage");
  ok(/, 409\);/.test(beatRoute), "N8: the untrackable refusal is a 409");

  console.log(`\nSVREQ suite: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    for (const f of failures) console.error(" -", f);
    assert.fail(`${fail} SVREQ assertions failed`);
  }
});
