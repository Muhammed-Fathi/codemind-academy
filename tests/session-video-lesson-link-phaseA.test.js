// CodeMind Academy — Academic session workflow Phase A: the Lesson is the
// canonical academic Session for video linking.
//
// Every NEW SessionVideo created through the Admin flows (presigned direct
// upload, buffered fallback, external URL) MUST carry a validated lessonId:
//
//   1. lessonId present                → LESSON_REQUIRED   (400)
//   2. the Lesson exists               → LESSON_NOT_FOUND  (404)
//   3. the Lesson is not ARCHIVED      → LESSON_ARCHIVED   (409)
//   4. the Batch exists                → BATCH_NOT_FOUND   (404)
//   5. batch declares a course →  COURSE_MISMATCH   (400)
//      it must be THE same one (pool batches — the school-type audience the
//      readiness engine counts — declare none and bind no course)
//   6. track fits the batch's school   → TRACK_MISMATCH    (400)
//
// The SAME shared validator (src/lib/session-video-link.ts) guards all three
// creation paths; the presigned flow additionally signs the validated
// (batch, lesson) identity into the upload-intent token so completion cannot
// be swapped. Legacy rows with lessonId = null stay readable and deletable
// and are NEVER migrated.
//
// What is REAL here: the compiled shipped route handlers, the SQLite database
// built from the real migration SQL, the readiness engine, the media bytes,
// the presigned intent token (HMAC, version, identity binding), the real
// S3StorageBackend code against an in-memory bucket. What is SHIMMED: the
// Prisma engine (sqlite-prisma-lite over node:sqlite, same as the Phase 15
// e2e), auth (script-controlled user), next/server, the S3 client (fake).
//
// Run: node --test tests/session-video-lesson-link-phaseA.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync, execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { test } = require("node:test");
const assert = require("node:assert");

const REPO = path.resolve(__dirname, "..");
const BASE_SHA = "3513b517978c9158bafd8d956eefb1e7e5cfcc9a";

// Media env MUST be set before the compiled media.js module loads (it reads
// these at import time, exactly like production).
const MEDIA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseA-media-"));
const SECRET = "a".repeat(64);
process.env.MEDIA_STORAGE_PATH = MEDIA_DIR;
process.env.MEDIA_MAX_VIDEO_BYTES = String(1024 * 1024);
process.env.MEDIA_MAX_PDF_BYTES = String(2048);
process.env.SECURITY_HASH_SECRET = SECRET;
process.env.MEDIA_BACKEND = "local"; // buffered route path; toggled for s3 legs

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`phase A test made a network connection attempt: ${JSON.stringify(args[0])}`);
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
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// Scratch database: base DDL + every real migration (same as Phase 15 e2e).
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phaseA: " });
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
  "src/lib/media-s3.ts",
  "src/lib/storage-quotas.ts",
  "src/lib/enrollment.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/parent-access.ts",
  "src/lib/session-materials.ts",
  "src/lib/session-video-link.ts",
  "src/lib/session-video-picker.ts",
  "src/lib/media-upload.ts",
  "src/lib/db-serialization.ts",
  "src/lib/admin-sessions.ts",
  "src/lib/api.ts",
  // route handlers under test
  "src/app/api/admin/session-videos/route.ts",
  "src/app/api/admin/session-videos/[id]/route.ts",
  "src/app/api/admin/lessons/[id]/readiness/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseA-compile-"));
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
// Same convention as the Phase 15 e2e: with this minimal program (strict off,
// no generated Prisma types) tsc reports type NOISE — including on
// pre-existing patterns (discriminated-union narrowing needs strictNullChecks)
// — but still emits the JS. The emitted files are what run.
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
    // Normal resolution FIRST (the AWS SDK resolves through the requiring
    // chain); the fallback below only serves bare specifiers required from the
    // temp emit dir (Phase 23 convention).
    return originalResolve.call(this, request, ...rest);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};
const route = (p) => require(path.join(OUT, "src/app/api", p));
const R = {
  videos: route("admin/session-videos/route.js"),
  videoById: route("admin/session-videos/[id]/route.js"),
  readiness: route("admin/lessons/[id]/readiness/route.js"),
};
const MediaS3 = require(path.join(EMIT, "lib", "media-s3.js"));
const Uploads = require(path.join(EMIT, "lib", "media-upload.js"));
const Link = require(path.join(EMIT, "lib", "session-video-link.js"));
const Picker = require(path.join(EMIT, "lib", "session-video-picker.js"));

// ---------------------------------------------------------------------------
// In-memory private bucket + real S3StorageBackend (Phase 23 pattern).
// ---------------------------------------------------------------------------
function s3NotFound(name = "NotFound", status = 404) {
  const e = new Error(`fake R2 ${name}`);
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
}
function makeFakeS3() {
  const store = new Map(); // key -> { body, contentType, lastModified }
  const commands = [];
  const client = {
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      commands.push({ name, key: input.Key });
      switch (name) {
        case "PutObjectCommand": {
          store.set(input.Key, {
            body: Buffer.from(input.Body),
            contentType: input.ContentType ?? null,
            lastModified: new Date(),
          });
          return { ETag: '"fake"' };
        }
        case "HeadObjectCommand": {
          const obj = store.get(input.Key);
          if (!obj) throw s3NotFound("NotFound");
          return {
            ContentLength: obj.body.length,
            LastModified: obj.lastModified,
            ContentType: obj.contentType,
          };
        }
        case "GetObjectCommand": {
          const obj = store.get(input.Key);
          if (!obj) throw s3NotFound("NoSuchKey");
          let body = obj.body;
          if (input.Range) {
            const m = /^bytes=(\d+)-(\d+)$/.exec(input.Range);
            if (!m) throw new Error(`fake: bad Range header ${input.Range}`);
            body = body.subarray(Number(m[1]), Number(m[2]) + 1);
          }
          return { Body: Readable.from([Buffer.from(body)]), ContentLength: body.length };
        }
        case "DeleteObjectCommand": {
          store.delete(input.Key);
          return {};
        }
        default:
          throw new Error(`fake: unexpected command ${name}`);
      }
    },
  };
  return { client, store, commands };
}
function makeFakeSigner() {
  const calls = [];
  const signer = async (_client, command, { expiresInSec }) => {
    calls.push({ commandName: command.constructor.name, input: { ...command.input }, expiresInSec });
    return `https://127.0.0.1:9/${command.input.Key}?X-Amz-Expires=${expiresInSec}`;
  };
  return { signer, calls };
}
const BUCKET = "codemind-test-bucket";
const s3Bundle = makeFakeS3();
const signerBundle = makeFakeSigner();
const realBackend = new MediaS3.S3StorageBackend({ client: s3Bundle.client, bucket: BUCKET });
const presignBackend = Object.create(realBackend, {
  createPresignedPutUrl: {
    value: (input) => realBackend.createPresignedPutUrl(input, signerBundle.signer),
  },
});
/** Simulate the browser leg: PUT the bytes into the (fake) bucket. */
function browserPut(key, body, contentType) {
  return realBackend.write(key, body, { mimeType: contentType });
}

// ---------------------------------------------------------------------------
// HTTP-lite driver (same shape as the Phase 15 e2e).
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
const PATCH_JSON = (r, url, body, params) => call(r.PATCH, jsonReq(url, body), params);
const POST_FORM = (r, url, form, params) => call(r.POST, formReq(url, form), params);
const DEL = (r, url, params) => call(r.DELETE, jsonReq(url), params);

// ---------------------------------------------------------------------------
test("Phase A: Lesson is the canonical academic session for video linking", async () => {
  // ---- seed ----------------------------------------------------------------
  const admin = await client.user.create({
    data: { email: "admin@pa.test", password: "x", name: "A", role: "ADMIN" },
  });
  await client.user.create({
    data: { email: "teacher@pa.test", password: "x", name: "T", role: "TEACHER" },
  });
  asUser(admin);

  const course = await client.course.create({
    data: { slug: "pa1", name: "PA1", nameAr: "PA1", description: "phase A", academicLevel: "SECOND_SECONDARY" },
  });
  const otherCourse = await client.course.create({
    data: { slug: "pa2", name: "PA2", nameAr: "PA2", description: "other", academicLevel: "SECOND_SECONDARY" },
  });
  const part1 = await client.part.create({
    data: { courseId: course.id, title: "P1", titleAr: "P1", order: 1 },
  });
  const part2 = await client.part.create({
    data: { courseId: course.id, title: "P2", titleAr: "P2", order: 2 },
  });
  const partOther = await client.part.create({
    data: { courseId: otherCourse.id, title: "PO", titleAr: "PO", order: 1 },
  });
  const unit1 = await client.unit.create({
    data: { partId: part1.id, title: "U1", titleAr: "الوحدة الأولى", order: 1 },
  });
  const unit2 = await client.unit.create({
    data: { partId: part2.id, title: "U2", titleAr: "الوحدة الثانية", order: 2 },
  });
  const unitOther = await client.unit.create({
    data: { partId: partOther.id, title: "UO", titleAr: "UO", order: 1 },
  });

  // officialCode models the "1-1" style code the Admin UI shows.
  const L_AR = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unit1.id, officialCode: "1-1",
      title: "Arabic lesson", titleAr: "حصة عربية",
      order: 1, trackScope: "ARABIC", isPublished: false,
    },
  });
  const L_LANG = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unit2.id, officialCode: "2-1",
      title: "Language lesson", titleAr: "حصة لغة",
      order: 1, trackScope: "LANGUAGE", isPublished: false,
    },
  });
  const L_SHARED = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unit1.id, officialCode: "1-2",
      title: "Shared lesson", titleAr: "حصة مشتركة",
      order: 2, trackScope: "SHARED", isPublished: false,
    },
  });
  const L_ARCHIVED = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unit1.id, officialCode: "1-3",
      title: "Archived lesson", titleAr: "حصة مؤرشفة",
      order: 3, trackScope: "SHARED", isPublished: false,
      curriculumStatus: "ARCHIVED",
    },
  });
  const L_OTHER = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unitOther.id, officialCode: "0-1",
      title: "Other course lesson", titleAr: "حصة كورس تاني",
      order: 1, trackScope: "SHARED", isPublished: false,
    },
  });

  const batchAr = await client.batch.create({
    data: { name: "Batch AR", nameAr: "دفعة عربي", schoolType: "ARABIC", courseId: course.id },
  });
  const batchLang = await client.batch.create({
    data: { name: "Batch LANG", nameAr: "دفعة لغات", schoolType: "LANGUAGE", courseId: course.id },
  });

  // A LEGACY video (pre-Phase A): no lesson, unpublished — must stay readable
  // and deletable.
  const legacyAsset = await client.mediaAsset.create({
    data: {
      kind: "VIDEO", storage: "LOCAL_PRIVATE", storageKey: "legacy/seed.mp4",
      mimeType: "video/mp4", sizeBytes: 16, originalName: "legacy.mp4",
      isPrivate: true, createdById: admin.id,
    },
  });
  const legacyVideo = await client.sessionVideo.create({
    data: {
      batchId: batchAr.id, lessonId: null, mediaAssetId: legacyAsset.id,
      title: "Legacy recording", titleAr: "تسجيل قديم", isPublished: false,
    },
  });

  const MP4_BYTES = Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]),
    Buffer.from("0".repeat(56)),
  ]);
  const mp4File = () => new File([MP4_BYTES], "clip.mp4", { type: "video/mp4" });

  // ===========================================================================
  // 1-2. VALID creation — every path produces the SAME lessonId+batchId pair.
  // ===========================================================================
  // (a) buffered file upload (MEDIA_BACKEND=local default path).
  const formA = new FormData();
  formA.set("batchId", batchAr.id);
  formA.set("lessonId", L_AR.id);
  formA.set("title", "Arabic recording");
  formA.set("publish", "true");
  formA.set("file", mp4File());
  const buffered = await POST_FORM(R.videos, "http://t/api/admin/session-videos", formA);
  eq(buffered.status, 200, "1a: buffered upload with valid lesson 200");
  eq(buffered.json.video.lessonId, L_AR.id, "1a: buffered response carries the lessonId");
  eq(buffered.json.video.batchId, batchAr.id, "1a: buffered response carries the batchId");
  const bufferedRow = await client.sessionVideo.findUnique({ where: { id: buffered.json.video.id } });
  eq(bufferedRow.lessonId, L_AR.id, "1a: the PERSISTED row has lessonId (not null)");

  // (b) external URL.
  const ext = await POST_JSON(R.videos, "http://t/api/admin/session-videos", {
    batchId: batchLang.id,
    lessonId: L_SHARED.id,
    title: "External shared",
    videoUrl: "https://cdn.example.com/s.mp4",
    publish: true,
  });
  eq(ext.status, 200, "2a: external URL with valid lesson 200");
  eq(ext.json.video.lessonId, L_SHARED.id, "2a: external row carries the lessonId");
  eq(ext.json.video.batchId, batchLang.id, "2a: external row carries the batchId");

  // (c) presigned flow — the direct-upload capability needs the s3 backend
  //     name (read at call time); the S3 CLIENT itself is the fake bucket.
  process.env.MEDIA_BACKEND = "s3";
  const presignedInit = await Uploads.initPresignedUpload(
    {
      purpose: "SESSION_VIDEO",
      actorUserId: admin.id,
      sizeBytes: MP4_BYTES.length,
      contentType: "video/mp4",
      fileName: "clip.mp4",
      batchId: batchAr.id,
      lessonId: L_AR.id,
    },
    { backend: presignBackend, hmacSecret: SECRET, db: client }
  );
  process.env.MEDIA_BACKEND = "local";
  ok(presignedInit.ok === true, "2b: presigned init for a valid pair succeeds");
  let presignedKey = null;
  if (presignedInit.ok) {
    const tokenPayload = JSON.parse(
      Buffer.from(presignedInit.init.token.split(".")[0], "base64url").toString("utf8")
    );
    eq(tokenPayload.batchId, batchAr.id, "9: init signs the batch identity into the token");
    eq(tokenPayload.lessonId, L_AR.id, "9: init signs the lesson identity into the token");
    eq(tokenPayload.v, 2, "9: the intent is version 2 (identity-bearing)");
    presignedKey = tokenPayload.key;
    await browserPut(presignedKey, MP4_BYTES, "video/mp4");
  }

  // ===========================================================================
  // 3-7. INVALID pairs — the shared contract refuses, with exact codes.
  // ===========================================================================
  const external = (body) =>
    POST_JSON(R.videos, "http://t/api/admin/session-videos", {
      videoUrl: "https://cdn.example.com/v.mp4",
      ...body,
    });

  const missing = await external({ batchId: batchAr.id, title: "no lesson" });
  eq(missing.status, 400, "3: missing lessonId → 400");
  eq(missing.json.code, "LESSON_REQUIRED", "3: machine code LESSON_REQUIRED");
  ok(typeof missing.json.error === "string" && missing.json.error.length > 0,
    "3: admin-facing message present");

  const unknown = await external({ batchId: batchAr.id, lessonId: "nope-123", title: "x" });
  eq(unknown.status, 404, "4: unknown lesson → 404");
  eq(unknown.json.code, "LESSON_NOT_FOUND", "4: machine code LESSON_NOT_FOUND");

  const archived = await external({ batchId: batchAr.id, lessonId: L_ARCHIVED.id, title: "x" });
  eq(archived.status, 409, "5: archived lesson → 409");
  eq(archived.json.code, "LESSON_ARCHIVED", "5: machine code LESSON_ARCHIVED");

  const noBatch = await external({ batchId: "no-batch", lessonId: L_AR.id, title: "x" });
  eq(noBatch.status, 404, "6a: unknown batch → 404");
  eq(noBatch.json.code, "BATCH_NOT_FOUND", "6a: machine code BATCH_NOT_FOUND");

  const crossCourse = await external({ batchId: batchAr.id, lessonId: L_OTHER.id, title: "x" });
  eq(crossCourse.status, 400, "6b: cross-course pair → 400");
  eq(crossCourse.json.code, "COURSE_MISMATCH", "6b: machine code COURSE_MISMATCH");

  const trackMismatch = await external({ batchId: batchLang.id, lessonId: L_AR.id, title: "x" });
  eq(trackMismatch.status, 400, "7: ARABIC lesson → LANGUAGE batch → 400");
  eq(trackMismatch.json.code, "TRACK_MISMATCH", "7: machine code TRACK_MISMATCH");
  const trackMismatch2 = await external({ batchId: batchAr.id, lessonId: L_LANG.id, title: "x" });
  eq(trackMismatch2.status, 400, "7b: LANGUAGE lesson → ARABIC batch → 400");
  eq(trackMismatch2.json.code, "TRACK_MISMATCH", "7b: machine code TRACK_MISMATCH");

  // No partial media: a rejected link must not have written media rows
  // (only the buffered upload, the external-URL asset from 2a and the
  // seeded legacy row exist so far).
  const assetsAfterRejections = (
    await client.mediaAsset.findMany({ where: { kind: "VIDEO" } })
  ).filter((a) => a.storage !== "EXTERNAL_URL");
  eq(assetsAfterRejections.length, 2, "3-7: rejected links wrote zero managed video assets (buffered + legacy only)");

  // ===========================================================================
  // 8-10. SHARED lessons fit BOTH batches; one-sided coverage is the
  //        readiness engine's business (unchanged policy).
  // ===========================================================================
  const sharedAr = await POST_JSON(R.videos, "http://t/api/admin/session-videos", {
    batchId: batchAr.id,
    lessonId: L_SHARED.id,
    title: "Shared on AR",
    videoUrl: "https://cdn.example.com/sa.mp4",
    publish: true,
  });
  eq(sharedAr.status, 200, "8: SHARED lesson + ARABIC batch → 200");
  const sharedLang = await POST_JSON(R.videos, "http://t/api/admin/session-videos", {
    batchId: batchLang.id,
    lessonId: L_SHARED.id,
    title: "Shared on LANG",
    videoUrl: "https://cdn.example.com/sl.mp4",
    publish: true,
  });
  eq(sharedLang.status, 200, "10: SHARED lesson + LANGUAGE batch → 200");

  // ===========================================================================
  // 11-12. LIST: human labels (lesson code + title + unit), legacy rows
  //        readable with lesson = null.
  // ===========================================================================
  const listAr = await GET(R.videos, `http://t/api/admin/session-videos?batchId=${batchAr.id}`);
  eq(listAr.status, 200, "11: list 200");
  const arRows = listAr.json.videos;
  const bufferedRowView = arRows.find((v) => v.id === bufferedRow.id);
  ok(!!bufferedRowView, "11: buffered video in the list");
  eq(bufferedRowView.lesson?.id, L_AR.id, "11: row exposes the lesson");
  eq(bufferedRowView.lesson?.officialCode, "1-1", "11: row exposes the lesson code");
  eq(bufferedRowView.lesson?.unit?.title, "U1", "11: row exposes the unit");
  const legacyView = arRows.find((v) => v.id === legacyVideo.id);
  ok(!!legacyView, "11: legacy (lesson-less) row is still READABLE");
  eq(legacyView.lesson, null, "11: legacy row has lesson = null");

  // ===========================================================================
  // 13. READINESS recognizes correctly-created published videos — engine
  //     untouched. LA (ARABIC, one ARABIC video) has no video blocker;
  //     L_SHARED clears its video blocker only when BOTH batches are covered;
  //     L_LANG (no LANGUAGE video) still blocks.
  // ===========================================================================
  const laReady = await GET(R.readiness, `http://t/api/admin/lessons/${L_AR.id}/readiness`, {
    id: L_AR.id,
  });
  eq(laReady.status, 200, "13: readiness 200");
  ok(!laReady.json.readiness.blocking.includes("VIDEO_MISSING"),
    "13: LA's published linked video clears VIDEO_MISSING");
  const sharedReady = await GET(R.readiness, `http://t/api/admin/lessons/${L_SHARED.id}/readiness`, {
    id: L_SHARED.id,
  });
  ok(
    !sharedReady.json.readiness.blocking.includes("VIDEO_MISSING") &&
      !sharedReady.json.readiness.blocking.includes("VIDEO_TRACK_INCOMPLETE"),
    "13b: both-batch SHARED coverage clears every video blocker"
  );
  const halfShared = await GET(R.readiness, `http://t/api/admin/lessons/${L_LANG.id}/readiness`, {
    id: L_LANG.id,
  });
  ok(halfShared.json.readiness.blocking.includes("VIDEO_MISSING"),
    "13c: one-sided (no LANGUAGE video) still blocks VIDEO_MISSING");

  // ===========================================================================
  // 14-16. PATCH — explicit re-link is validated; null unlinks (management).
  // ===========================================================================
  const moved = await PATCH_JSON(
    R.videoById,
    `http://t/api/admin/session-videos/${ext.json.video.id}`,
    { lessonId: L_SHARED.id },
    { id: ext.json.video.id }
  );
  eq(moved.status, 200, "14: valid re-link 200");
  eq(moved.json.video.lessonId, L_SHARED.id, "14: re-linked to the new lesson");

  const movedBad = await PATCH_JSON(
    R.videoById,
    `http://t/api/admin/session-videos/${ext.json.video.id}`,
    { lessonId: L_AR.id }, // ARABIC lesson → the row's LANGUAGE batch
    { id: ext.json.video.id }
  );
  eq(movedBad.status, 400, "15: track-incompatible re-link 400");
  eq(movedBad.json.code, "TRACK_MISMATCH", "15: exact machine code");
  const stillShared = await client.sessionVideo.findUnique({ where: { id: ext.json.video.id } });
  eq(stillShared.lessonId, L_SHARED.id, "15: the refused re-link changed nothing");

  const crossRe = await PATCH_JSON(
    R.videoById,
    `http://t/api/admin/session-videos/${ext.json.video.id}`,
    { lessonId: L_OTHER.id }, // other course
    { id: ext.json.video.id }
  );
  eq(crossRe.status, 400, "15b: cross-course re-link 400");
  eq(crossRe.json.code, "COURSE_MISMATCH", "15b: exact machine code");

  const unlink = await PATCH_JSON(
    R.videoById,
    `http://t/api/admin/session-videos/${ext.json.video.id}`,
    { lessonId: null },
    { id: ext.json.video.id }
  );
  eq(unlink.status, 200, "16: explicit null unlinks (legacy management)");
  eq(unlink.json.video.lessonId, null, "16: row now has lessonId = null");

  // ===========================================================================
  // 17. PRESIGNED anti-swap: completion uses the TOKEN identity, never the
  //     request body. A body claiming different ids cannot move the video.
  // ===========================================================================
  if (presignedInit.ok) {
    process.env.MEDIA_BACKEND = "s3";
    const swap = await Uploads.completePresignedUpload(
      {
        token: presignedInit.init.token,
        actorUserId: admin.id,
        // The client claims a DIFFERENT identity — must be ignored:
        batchId: batchLang.id,
        lessonId: L_SHARED.id,
        title: "swapped",
        titleAr: "swapped",
        publish: false,
      },
      { backend: presignBackend, hmacSecret: SECRET, db: client }
    );
    process.env.MEDIA_BACKEND = "local";
    ok(swap.ok === true, "17: completion succeeds for the token's identity");
    if (swap.ok) {
      const row = await client.sessionVideo.findUnique({ where: { mediaAssetId: swap.mediaAssetId } });
      eq(row?.lessonId, L_AR.id, "17: the row kept the TOKEN's lesson (body swap ignored)");
      eq(row?.batchId, batchAr.id, "17: the row kept the TOKEN's batch (body swap ignored)");
      eq(row?.title, "swapped", "17: content fields still come from the body");
    }
  }

  // 17b. A v1 token (no identity, valid MAC) is rejected — unbound completions
  // are impossible by construction.
  const v1Payload = {
    v: 1,
    jti: crypto.randomBytes(16).toString("base64url"),
    sub: admin.id,
    purpose: "SESSION_VIDEO",
    kind: "VIDEO",
    key: "session-videos/legacy-1.mp4",
    contentType: "video/mp4",
    maxBytes: 1024,
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  // The MAC covers `codemind.upload-intent.v1.<base64url body>` (the exact
  // construction signUploadIntent uses), so this v1 token passes signature +
  // expiry + bearer checks and is refused solely by the version/shape gate.
  const v1Body = Buffer.from(JSON.stringify(v1Payload), "utf8").toString("base64url");
  const v1Mac = crypto
    .createHmac("sha256", SECRET)
    .update(`codemind.upload-intent.v1.${v1Body}`)
    .digest("base64url");
  const v1Token = `${v1Body}.${v1Mac}`;
  const v1 = await Uploads.completePresignedUpload(
    { token: v1Token, actorUserId: admin.id, batchId: batchAr.id, lessonId: L_AR.id, title: "t" },
    { backend: presignBackend, hmacSecret: SECRET, db: client }
  );
  eq(v1.ok, false, "17b: v1 token rejected at completion");
  eq(v1.code, "INTENT_INVALID", "17b: code INTENT_INVALID (never a silent accept)");

  // 17c. A presigned INIT without a lesson is refused before any grant.
  {
    process.env.MEDIA_BACKEND = "s3";
    const noLessonInit = await Uploads.initPresignedUpload(
      {
        purpose: "SESSION_VIDEO",
        actorUserId: admin.id,
        sizeBytes: MP4_BYTES.length,
        contentType: "video/mp4",
        fileName: "clip.mp4",
        batchId: batchAr.id,
      },
      { backend: presignBackend, hmacSecret: SECRET, db: client }
    );
    process.env.MEDIA_BACKEND = "local";
    eq(noLessonInit.ok, false, "17c: presigned init without lesson fails");
    eq(noLessonInit.code, "LESSON_REQUIRED", "17c: exact machine code");
    eq(signerBundle.calls.length, 1, "17c: no grant was ever presigned");
  }

  // ===========================================================================
  // 18. LEGACY: the seeded lesson-less row is DELETABLE end-to-end (media
  //      row cleaned up with it).
  // ===========================================================================
  const del = await DEL(R.videoById, `http://t/api/admin/session-videos/${legacyVideo.id}`, {
    id: legacyVideo.id,
  });
  eq(del.status, 200, "18: legacy video deletes 200");
  const goneRow = await client.sessionVideo.findUnique({ where: { id: legacyVideo.id } });
  eq(goneRow, null, "18: legacy row gone");
  const goneAsset = await client.mediaAsset.findUnique({ where: { id: legacyAsset.id } });
  eq(goneAsset, null, "18: legacy media asset cleaned up");

  // ===========================================================================
  // 19. Shared validator unit matrix (the one function every path calls).
  // ===========================================================================
  const v = (lessonId, batchId) =>
    Link.validateSessionVideoLink(client, { lessonId, batchId });
  eq((await v(L_AR.id, batchAr.id)).ok, true, "19: ARABIC×ARABIC valid");
  eq((await v(L_LANG.id, batchLang.id)).ok, true, "19: LANGUAGE×LANGUAGE valid");
  eq((await v(L_SHARED.id, batchAr.id)).ok, true, "19: SHARED×ARABIC valid");
  eq((await v(L_SHARED.id, batchLang.id)).ok, true, "19: SHARED×LANGUAGE valid");
  eq((await v(null, batchAr.id)).code, "LESSON_REQUIRED", "19: null lesson refused");
  eq((await v("  ", batchAr.id)).code, "LESSON_REQUIRED", "19: blank lesson refused");
  eq((await v(L_AR.id, null)).code, "BATCH_NOT_FOUND", "19: null batch refused");
  eq((await v("missing", batchAr.id)).code, "LESSON_NOT_FOUND", "19: missing lesson refused");
  eq((await v(L_ARCHIVED.id, batchAr.id)).code, "LESSON_ARCHIVED", "19: archived refused");
  eq((await v(L_OTHER.id, batchAr.id)).code, "COURSE_MISMATCH", "19: cross-course refused");
  eq((await v(L_AR.id, batchLang.id)).code, "TRACK_MISMATCH", "19: track mismatch refused");

  // Pool batches (courseId = null) — the batches the Admin batch UI actually
  // creates (created here, after every e2e flow, so nothing above sees them).
  // Audience = the school type, exactly what readiness counts, so the course
  // constraint binds only when the batch DECLARES a course.
  const poolAr = await client.batch.create({
    data: { name: "Pool AR", nameAr: "قاعدة عربي", schoolType: "ARABIC", courseId: null },
  });
  const poolLang = await client.batch.create({
    data: { name: "Pool LANG", nameAr: "قاعدة لغات", schoolType: "LANGUAGE", courseId: null },
  });
  eq((await v(L_SHARED.id, poolAr.id)).ok, true, "19: SHARED × ARABIC pool valid");
  eq((await v(L_SHARED.id, poolLang.id)).ok, true, "19: SHARED × LANGUAGE pool valid");
  eq((await v(L_AR.id, poolAr.id)).ok, true, "19: ARABIC × ARABIC pool valid");
  eq((await v(L_AR.id, poolLang.id)).code, "TRACK_MISMATCH", "19: ARABIC × LANGUAGE pool still refused");
  eq((await v(L_OTHER.id, poolAr.id)).ok, true, "19: pool batch spans courses (other-course lesson valid)");

  // The acceptance repro's exact shape: an OFFICIAL lesson in the DRAFT
  // lifecycle (like "Lesson 1-1") is a valid staging target — DRAFT is not
  // ARCHIVED and the contract never demanded PUBLISHED/READY for Admin.
  const L_DRAFT_OFFICIAL = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      unitId: unit1.id, officialCode: "1-9",
      title: "Draft official shared", titleAr: "رسمية مشتركة مسودة",
      order: 9, trackScope: "SHARED", isPublished: false,
      status: "DRAFT", curriculumStatus: "OFFICIAL",
    },
  });
  eq((await v(L_DRAFT_OFFICIAL.id, poolAr.id)).ok, true,
    "19: SHARED DRAFT OFFICIAL × ARABIC pool valid (acceptance repro)");
  eq((await v(L_DRAFT_OFFICIAL.id, poolLang.id)).ok, true,
    "19: SHARED DRAFT OFFICIAL × LANGUAGE pool valid");

  // A lesson whose course cannot be proven (no unit/topic chain): refused by
  // a course-declaring batch, accepted by a pool batch (no course declared).
  const L_NO_COURSE = await client.lesson.create({
    data: {
      academicLevel: "SECOND_SECONDARY",
      title: "Orphan lesson", titleAr: "حصة يتيمة",
      order: 10, trackScope: "SHARED", isPublished: false,
    },
  });
  eq((await v(L_NO_COURSE.id, batchAr.id)).code, "COURSE_MISMATCH",
    "19: unprovable course × course-bound batch refused");
  eq((await v(L_NO_COURSE.id, poolAr.id)).ok, true,
    "19: unprovable course × pool batch valid");
  // The client-side mirror agrees (the picker filter is this predicate).
  ok(Link.lessonFitsBatch("SHARED", "ARABIC") === true, "19: mirror — SHARED fits ARABIC");
  ok(Link.lessonFitsBatch("SHARED", "LANGUAGE") === true, "19: mirror — SHARED fits LANGUAGE");
  ok(Link.lessonFitsBatch("ARABIC", "LANGUAGE") === false, "19: mirror — ARABIC ≠ LANGUAGE");
  ok(Link.lessonFitsBatch("LANGUAGE", "ARABIC") === false, "19: mirror — LANGUAGE ≠ ARABIC");
  ok(Link.lessonFitsBatch(null, "ARABIC") === false, "19: mirror — null scope never fits");

  // ===========================================================================
  // 19b. The PURE picker module (what the Admin UI offers, per batch model):
  //      pool batches span courses, course-bound batches are scoped, track
  //      fit + non-archived always apply, and the deep link lands correctly.
  // ===========================================================================
  {
    // A two-course tree exercising both chains (canonical unit + legacy topic).
    const TREE = [
      {
        id: "cA", name: "Course A", nameAr: "كورس أ",
        parts: [
          {
            id: "pA1",
            units: [
              {
                id: "uA1", order: 1,
                lessons: [
                  { id: "lShared", title: "Shared", titleAr: "مشتركة", officialCode: "1-1", trackScope: "SHARED", curriculumStatus: "OFFICIAL", status: "DRAFT" },
                  { id: "lArabic", title: "Arabic", titleAr: "عربي", officialCode: null, trackScope: "ARABIC", curriculumStatus: "OFFICIAL" },
                  { id: "lArch", title: "Archived", titleAr: "مؤرشفة", officialCode: null, trackScope: "SHARED", curriculumStatus: "ARCHIVED" },
                ],
                topics: [
                  { id: "tA1", lessons: [
                    // Same id as the unit-chain SHARED lesson (dual-chained):
                    // must appear exactly once per unit group.
                    { id: "lShared", title: "Shared", titleAr: "مشتركة", officialCode: "1-1", trackScope: "SHARED", curriculumStatus: "OFFICIAL" },
                    { id: "lTopic", title: "Topic lesson", titleAr: "حصة توبيك", officialCode: "1-T", trackScope: "SHARED", curriculumStatus: "OFFICIAL" },
                  ] },
                ],
              },
              {
                id: "uA2", order: 2,
                lessons: [
                  { id: "lLang", title: "Language", titleAr: "لغة", officialCode: null, trackScope: "LANGUAGE", curriculumStatus: "OFFICIAL" },
                ],
                topics: [],
              },
            ],
          },
        ],
      },
      {
        id: "cB", name: "Course B", nameAr: "كورس ب",
        parts: [
          {
            id: "pB1",
            units: [
              { id: "uB1", order: 1,
                lessons: [
                  { id: "lB", title: "B shared", titleAr: "ب مشتركة", officialCode: "2-1", trackScope: "SHARED", curriculumStatus: "OFFICIAL" },
                ],
                topics: [] },
            ],
          },
        ],
      },
    ];

    // Pool ARABIC batch: spans BOTH courses, SHARED + ARABIC lessons only.
    const poolGroups = Picker.buildLessonGroups(TREE, { id: "poolAr", schoolType: "ARABIC", course: null });
    const poolIds = Picker.flattenEligibleLessonIds(poolGroups);
    eq(poolGroups.length, 2, "19b: pool ARABIC — one group per course-with-eligible-units");
    ok(poolIds.has("lShared"), "19b: SHARED lesson offered to the ARABIC pool");
    ok(poolIds.has("lArabic"), "19b: ARABIC lesson offered to the ARABIC pool");
    ok(poolIds.has("lTopic"), "19b: legacy topic-chain lesson offered");
    ok(poolIds.has("lB"), "19b: second course's lesson offered to the pool batch");
    ok(!poolIds.has("lArch"), "19b: archived lesson never offered");
    ok(!poolIds.has("lLang"), "19b: LANGUAGE lesson not offered to the ARABIC pool");
    const gShared = poolGroups.find((g) => g.lessons.some((l) => l.id === "lShared"));
    eq(gShared.lessons.length, 3, "19b: dual-chained lesson deduped (unit: SHARED+ARABIC+topic lesson)");
    eq(gShared.courseName, "كورس أ", "19b: pool groups carry the Arabic-first course name");
    eq(gShared.unitOrder, 1, "19b: group carries its unit order");

    // Course-bound ARABIC batch for course B: sees ONLY course B's lessons.
    const bGroups = Picker.buildLessonGroups(TREE, { id: "bB", schoolType: "ARABIC", course: { id: "cB" } });
    const bIds = Picker.flattenEligibleLessonIds(bGroups);
    ok(bIds.has("lB"), "19b: course-bound batch sees its own course");
    ok(!bIds.has("lShared"), "19b: course-bound batch does not leak other courses");

    // Pool LANGUAGE batch: SHARED lessons + the LANGUAGE lesson.
    const langIds = Picker.flattenEligibleLessonIds(
      Picker.buildLessonGroups(TREE, { id: "poolLang", schoolType: "LANGUAGE", course: null })
    );
    ok(langIds.has("lShared") && langIds.has("lTopic") && langIds.has("lLang") && langIds.has("lB"),
      "19b: LANGUAGE pool offers SHARED (both courses) + LANGUAGE lessons");
    ok(!langIds.has("lArabic"), "19b: ARABIC lesson not offered to the LANGUAGE pool");

    // Deep link: SHARED keeps the active batch; track-specific switches to
    // its own track; a track with no batch has no legal home (not consumed).
    const batches = [
      { id: "bAr", schoolType: "ARABIC" },
      { id: "bLang", schoolType: "LANGUAGE" },
    ];
    const dShared = Picker.deepLinkTargetBatch("SHARED", batches, "bAr");
    ok(dShared && dShared.switchTo === null, "19b: SHARED deep link keeps the active batch");
    const dSwitch = Picker.deepLinkTargetBatch("LANGUAGE", batches, "bAr");
    ok(dSwitch && dSwitch.switchTo === "bLang", "19b: LANGUAGE deep link switches to the LANGUAGE batch");
    const dKeep = Picker.deepLinkTargetBatch("ARABIC", batches, "bAr");
    ok(dKeep && dKeep.switchTo === null, "19b: ARABIC deep link with the ARABIC batch active keeps it");
    const dNoHome = Picker.deepLinkTargetBatch("LANGUAGE", [batches[0]], "bAr");
    eq(dNoHome, null, "19b: track with no batch = no legal home (deep link not consumed)");
    eq(Picker.deepLinkTargetBatch(null, batches, "bAr"), null, "19b: unknown scope = no legal home");
  }


  // ===========================================================================
  // 20. Source + dictionary + scope pins.
  // ===========================================================================
  {
    const post = read("src/app/api/admin/session-videos/route.ts");
    ok(post.includes("validateSessionVideoLink"), "20: POST route calls the shared validator");
    ok(post.includes("link.batchId") && post.includes("link.lessonId"),
      "20: POST persists exactly the validated pair");
    // lastIndexOf = the buffered-branch CALL (the import sits at the top).
    const linkIdx = post.indexOf("validateSessionVideoLink(");
    const writeIdx = post.lastIndexOf("writePrivateFile");
    ok(linkIdx !== -1 && writeIdx !== -1 && linkIdx < writeIdx,
      "20: the link is validated BEFORE any media is written");

    const patch = read("src/app/api/admin/session-videos/[id]/route.ts");
    ok(patch.includes("validateSessionVideoLink"), "20: PATCH re-link uses the shared validator");

    const service = read("src/lib/media-upload.ts");
    ok(service.includes("payload.batchId") && service.includes("payload.lessonId"),
      "20: presigned completion re-authorizes the SIGNED identity");
    // Scope the pin to the COMPLETE function: init legitimately reads the
    // request body's identity; complete must not.
    const completeStart = service.indexOf("export async function completePresignedUpload");
    const completeSrc =
      completeStart !== -1
        ? service.slice(completeStart, service.indexOf("\nexport ", completeStart + 10) === -1
            ? service.length
            : service.indexOf("\nexport ", completeStart + 10))
        : "";
    ok(completeSrc.length > 0, "20: completePresignedUpload is present");
    ok(/validateUploadTarget\(\s*client,\s*payload\.purpose,\s*payload\.batchId,\s*payload\.lessonId/.test(completeSrc),
      "20: presigned completion re-authorizes ONLY the token's signed identity");
    ok(!/input\.batchId|input\.lessonId/.test(completeSrc),
      "20: presigned completion never reads the request body's identity");
    ok(/INTENT_VERSION = 2/.test(service), "20: the intent is version 2");

    const ui = read("src/components/admin/session-videos-view.tsx");
    // The track predicate itself lives in the pure picker module (which the
    // suite exercises directly in 19b); the view delegates to it.
    ok(ui.includes('from "@/lib/session-video-picker"'),
      "20: UI picker filters with the shared track predicate (via the pure module)");
    ok(ui.includes("initFields: { batchId: batch.id, lessonId }"),
      "20: presigned init fields carry the lesson");
    ok(/form\.set\("lessonId", lessonId\)/.test(ui), "20: buffered fallback carries the lesson");
    ok(/toast\.error\(tr\("admin\.583"\)\)/.test(ui), "20: the UI requires a lesson before publishing");
    ok(ui.includes('tr("admin.591")'), "20: legacy rows are labelled, not hidden");

    // Dictionary: every new key exists in BOTH locales, codes are mapped, and
    // no key was duplicated.
    const dictSrc = read("src/lib/i18n-dict-2026.ts");
    const keys = [...dictSrc.matchAll(/"((?:api|admin)\.\d+)":/g)].map((m) => m[1]);
    const dupes = keys.filter((k, i) => keys.indexOf(k) !== i);
    eq(dupes, [], "20: no duplicated dictionary keys");
    for (const k of [
      "api.313", "api.314", "api.315", "api.316", "api.317",
      "admin.583", "admin.584", "admin.585",
      "admin.586", "admin.587", "admin.588", "admin.589", "admin.590",
      "admin.591", "admin.593", "admin.594",
    ]) {
      ok(keys.includes(k), `20: dictionary key ${k} exists`);
    }
    const errMap = read("src/lib/upload-error-text.ts");
    ok(errMap.includes('LESSON_REQUIRED: "admin.583"'), "20: LESSON_REQUIRED mapped to its UI reason");
    ok(errMap.includes('COURSE_MISMATCH: "admin.584"'), "20: COURSE_MISMATCH mapped");
    ok(errMap.includes('TRACK_MISMATCH: "admin.585"'), "20: TRACK_MISMATCH mapped");

    // The validator map agrees with the response statuses the routes emit.
    const linkSrc = read("src/lib/session-video-link.ts");
    ok(linkSrc.includes("LESSON_REQUIRED: { status: 400"), "20: LESSON_REQUIRED → 400");
    ok(linkSrc.includes("LESSON_ARCHIVED: { status: 409"), "20: LESSON_ARCHIVED → 409");
    // The course rule binds ONLY when the batch declares a course (pool
    // batches — the kind the Admin UI creates — impose no course constraint).
    ok(
      linkSrc.includes("batchCourseId !== null && lessonCourseId !== batchCourseId"),
      "20: course rule binds only for course-declaring batches"
    );

    // The Admin UI flow: the lesson page hands its identity over, the videos
    // view consumes it through the pure picker module, the preselect lands
    // only where the lesson is actually offered, and a batch switch clears
    // only genuinely ineligible selections.
    const detailSrc = read("src/components/admin/session-detail-view.tsx");
    ok(
      detailSrc.includes('setView("admin-session-videos")') &&
        detailSrc.includes("setNavParam(lessonId)"),
      "20: lesson detail page hands its lesson identity to the videos view"
    );
    const viewSrc = read("src/components/admin/session-videos-view.tsx");
    ok(
      viewSrc.includes('from "@/lib/session-video-picker"'),
      "20: the picker runs on the pure, tested selection module"
    );
    ok(viewSrc.includes("findLessonInTree(courseTree, navParam)"),
      "20: the view consumes the handed-over lesson identity");
    ok(viewSrc.includes("deepLinkTargetBatch("),
      "20: deep link routes through the pure batch resolver");
    ok(viewSrc.includes("eligibleLessonIds.has(initialLessonId)"),
      "20: preselect lands only where the lesson is offered");
    ok(viewSrc.includes("eligibleLessonIds.has(prev)"),
      "20: batch switch clears only ineligible selections");
    ok(
      !viewSrc.includes("if (!courseTree || !activeBatch?.course) return [];"),
      "20: the old course-bound-only picker gate is gone"
    );
  }
  {
    // Phase A scope: NO schema, migration or seed change — the data model was
    // already Lesson-ready (SessionVideo.lessonId has existed since the
    // original schema).
    let changed = "";
    try {
      changed = execSync(
        `git diff --name-only ${BASE_SHA} -- prisma/ scripts/seed.ts`,
        { cwd: REPO, encoding: "utf8" }
      ).trim();
    } catch {
      changed = "";
    }
    eq(changed, "", "20: zero schema/migration/seed changes vs the base commit");
  }

  // ---- report --------------------------------------------------------------
  console.log(`\nPhase A suite: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    for (const f of failures) console.error("  -", f);
    assert.fail(`${fail} assertion(s) failed`);
  }
});
