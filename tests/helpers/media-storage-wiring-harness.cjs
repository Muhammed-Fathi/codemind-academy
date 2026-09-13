/* eslint-disable @typescript-eslint/no-require-imports -- plain-node harness, same convention as the other suites */
// CodeMind Academy — R2 application-wiring harness (OFFLINE).
//
// Run by tests/media-storage-wiring.test.js as a child process:
//
//   CM_EMIT=<compiled src dir> CM_LOCAL_ROOT=<scratch volume> \
//   CM_SCENARIO=local|s3 MEDIA_BACKEND=… node tests/helpers/media-storage-wiring-harness.cjs
//
// It loads the SHIPPED TypeScript (compiled unmodified by the suite) and
// replaces exactly three things:
//   1. `@/lib/db` (and `@/lib/api` / `@/lib/security` / `@/lib/i18n-server`)
//      — an in-memory Prisma-shaped fake that records EVERY call in order, so
//      delete-ordering can be asserted rather than assumed;
//   2. the S3 boundary — `createS3StorageBackendFromEnv` is replaced by a
//      factory that builds the REAL `S3StorageBackend` around an in-memory
//      fake S3 client (the same `S3ClientLike` boundary tests/s3-storage-r2
//      .test.js uses). No R2_* env var is ever set here, so if the injection
//      ever failed the shipped factory would throw "missing env vars" instead
//      of contacting a real bucket;
//   3. nothing else. Bytes, gates, headers, statuses and authorization are the
//      shipped code paths.
//
// GUARANTEES
//   * ZERO network: `net.Socket.prototype.connect` throws, and any attempt is
//     reported in the result as `networkAttempts`.
//   * ZERO credentials: no R2_*/AWS_* variable is read or set.
//   * Deterministic: fixed bytes, fixed ids, fixed clock-free assertions.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const Module = require("module");
const { Readable } = require("stream");

const REPO = process.env.CM_REPO || path.resolve(__dirname, "..", "..");
const EMIT = process.env.CM_EMIT; // compiled `<out>/src`
const LOCAL_ROOT = process.env.CM_LOCAL_ROOT;
const SCENARIO = process.env.CM_SCENARIO || "local";
if (!EMIT || !LOCAL_ROOT) {
  console.error("harness: CM_EMIT and CM_LOCAL_ROOT are required");
  process.exit(1);
}
fs.mkdirSync(LOCAL_ROOT, { recursive: true });
// The local backend captures MEDIA_ROOT at module load — set it BEFORE any
// compiled module is required.
process.env.MEDIA_STORAGE_PATH = LOCAL_ROOT;
// No credential is ever provided to this harness: if the S3 injection below
// ever failed, the shipped factory would fail closed on these missing vars
// instead of contacting a real bucket.
for (const v of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_REGION", "R2_S3_ENDPOINT"]) {
  delete process.env[v];
}

// --- ZERO-NETWORK guard -----------------------------------------------------
const networkAttempts = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  networkAttempts.push(JSON.stringify(args[0]));
  throw new Error("media-wiring harness attempted a network connection");
};
process.on("exit", () => {
  net.Socket.prototype.connect = realConnect;
});

// --- ordered op log + in-memory S3 bucket ----------------------------------
const ops = [];
const bucket = new Map(); // key -> { body, contentType }
let failNext = null;
function s3Error(name, status) {
  const e = new Error("fake R2 " + name);
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
}
const fakeClient = {
  failWith(err) {
    failNext = err;
  },
  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    ops.push(
      "s3:" + name + (input.Range ? "[" + input.Range + "]" : "") + " " + input.Key
    );
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    switch (name) {
      case "PutObjectCommand":
        bucket.set(input.Key, {
          body: Buffer.from(input.Body),
          contentType: input.ContentType === undefined ? null : input.ContentType,
        });
        return { ETag: '"fake"' };
      case "GetObjectCommand": {
        const obj = bucket.get(input.Key);
        if (!obj) throw s3Error("NoSuchKey", 404);
        let body = obj.body;
        if (input.Range) {
          const m = /^bytes=(\d+)-(\d+)$/.exec(input.Range);
          if (!m) throw new Error("fake: bad Range header " + input.Range);
          body = body.subarray(Number(m[1]), Number(m[2]) + 1);
        }
        return {
          Body: Readable.from([Buffer.from(body)]),
          ContentLength: body.length,
        };
      }
      case "HeadObjectCommand": {
        const obj = bucket.get(input.Key);
        if (!obj) throw s3Error("NotFound", 404);
        return { ContentLength: obj.body.length, LastModified: new Date() };
      }
      case "DeleteObjectCommand":
        bucket.delete(input.Key);
        return {};
      default:
        throw new Error("fake: unexpected command " + name);
    }
  },
};

// --- stub modules -----------------------------------------------------------
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-wiring-stubs-"));
function stub(name, source) {
  const p = path.join(STUB_DIR, name);
  fs.writeFileSync(p, source);
  return p;
}
const STUBS = {
  "@/lib/db": stub(
    "db.js",
    "module.exports = { get db() { return globalThis.__CM_DB__; } };\n"
  ),
  "@/lib/api": stub(
    "api.js",
    [
      'const { NextResponse } = require("next/server");',
      "module.exports = {",
      "  ok: async (data, init) => NextResponse.json(data, init),",
      '  err: async (message, status = 400) => NextResponse.json({ error: message }, { status }),',
      "  requireUser: async () => globalThis.__CM_USER__ || null,",
      "  requireRole: async (...roles) => {",
      "    const u = globalThis.__CM_USER__ || null;",
      '    if (!u) return { user: null, error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };',
      '    if (!roles.includes(u.role)) return { user: null, error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) };',
      "    return { user: u, error: null };",
      "  },",
      "  applyRateLimit: async () => ({ allowed: true, headers: {}, config: {} }),",
      '  rateLimitedResponse: () => NextResponse.json({ error: "Too many requests" }, { status: 429 }),',
      '  denyProgression: async (reason) => NextResponse.json({ error: "Not found", code: reason }, { status: 403 }),',
      "};",
    ].join("\n")
  ),
  "@/lib/security": stub(
    "security.js",
    [
      "module.exports = {",
      "  logSecurityEvent: async (e) => {",
      '    (globalThis.__CM_OPS__ || []).push("security:" + e.type);',
      "    return {};",
      "  },",
      "  checkRateLimit: async () => ({ allowed: true, remaining: 1, limit: 1, resetAt: 0 }),",
      "};",
    ].join("\n")
  ),
  "@/lib/i18n-server": stub(
    "i18n-server.js",
    "module.exports = { getServerT: async () => (key) => key };\n"
  ),
};
globalThis.__CM_OPS__ = ops;

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (STUBS[request]) return STUBS[request];
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", m[1] + ".js");
    if (fs.existsSync(compiled)) return compiled;
  }
  try {
    return originalResolve.call(this, request, ...args);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};

// --- inject the fake S3 client at the shipped boundary ----------------------
const mediaS3Path = path.join(EMIT, "lib", "media-s3.js");
const realMediaS3 = require(mediaS3Path);
const BUCKET = "codemind-wiring-test-bucket";
require.cache[require.resolve(mediaS3Path)].exports = Object.assign({}, realMediaS3, {
  // The REAL backend class, the FAKE client. No credentials, no endpoint, no
  // network: exactly the boundary the R2 backend suite already verifies.
  createS3StorageBackendFromEnv: () =>
    new realMediaS3.S3StorageBackend({ client: fakeClient, bucket: BUCKET }),
});

const Media = require(path.join(EMIT, "lib", "media.js"));
const SM = require(path.join(EMIT, "lib", "session-materials.js"));

// --- fake Prisma client ----------------------------------------------------
function makeFakeDb(tables) {
  let seq = 0;
  const matches = (row, where) => {
    if (!where) return true;
    for (const [field, cond] of Object.entries(where)) {
      if (cond && typeof cond === "object" && "in" in cond) {
        if (!cond.in.includes(row[field])) return false;
      } else if (typeof row[field] === "boolean" || typeof cond === "boolean") {
        if (!!row[field] !== !!cond) return false;
      } else if (row[field] !== cond) return false;
    }
    return true;
  };
  const model = (name) => ({
    async findUnique(args) {
      const { where, select, include } = args || {};
      ops.push("db." + name + ".findUnique");
      const id = where && where.id;
      const row = (tables[name] && id && tables[name][id]) || null;
      if (!row) return null;
      const out = Object.assign({}, row);
      const wants = (rel) => (!!select && rel in select) || (!!include && rel in include);
      const all = (t) => Object.values(tables[t] || {});
      if (wants("media")) {
        out.media = row.mediaAssetId
          ? (tables.mediaAsset || {})[row.mediaAssetId] || null
          : null;
      }
      if (wants("lesson")) {
        out.lesson = row.lessonId ? (tables.lesson || {})[row.lessonId] || null : null;
      }
      if (wants("batch")) {
        out.batch = row.batchId ? (tables.batch || {})[row.batchId] || null : null;
      }
      if (wants("sessionVideos")) {
        out.sessionVideos = all("sessionVideo")
          .filter((v) => v.mediaAssetId === row.id)
          .map((v) =>
            Object.assign({}, v, { batch: (tables.batch || {})[v.batchId] || null })
          );
      }
      if (wants("quizEvidence")) {
        out.quizEvidence = all("quizAttemptEvidence").filter((e) => e.mediaAssetId === row.id);
      }
      if (wants("materials")) {
        out.materials = all("material").filter((m) => m.mediaAssetId === row.id);
      }
      if (wants("user")) {
        out.user = row.userId ? (tables.user || {})[row.userId] || null : null;
      }
      return out;
    },
    async findMany(args) {
      const { where } = args || {};
      ops.push("db." + name + ".findMany");
      return Object.values(tables[name] || {}).filter((r) => matches(r, where));
    },
    async count(args) {
      const { where } = args || {};
      ops.push("db." + name + ".count");
      return Object.values(tables[name] || {}).filter((r) => matches(r, where)).length;
    },
    async create(args) {
      const data = (args && args.data) || {};
      ops.push("db." + name + ".create");
      const id = data.id || name + "-" + ++seq;
      const row = Object.assign({ id }, data);
      tables[name] = tables[name] || {};
      tables[name][id] = row;
      return row;
    },
    async update(args) {
      const { where, data } = args || {};
      ops.push("db." + name + ".update");
      const row = tables[name][where.id];
      Object.assign(row, data);
      return row;
    },
    async updateMany(args) {
      const { where, data } = args || {};
      ops.push("db." + name + ".updateMany");
      const rows = Object.values(tables[name] || {}).filter((r) => matches(r, where));
      for (const r of rows) Object.assign(r, data);
      return { count: rows.length };
    },
    async delete(args) {
      const { where } = args || {};
      ops.push("db." + name + ".delete");
      const row = (tables[name] || {})[where.id];
      delete tables[name][where.id];
      return row;
    },
  });
  const client = {};
  for (const n of [
    "mediaAsset",
    "material",
    "lesson",
    "sessionVideo",
    "sessionVideoView",
    "quizAttemptEvidence",
    "quizAttempt",
    "student",
    "batch",
    "user",
    "auditLog",
  ]) {
    client[n] = model(n);
  }
  client.$transaction = async (fn) => fn(client);
  return client;
}

const tables = {};
globalThis.__CM_TABLES__ = tables;
globalThis.__CM_DB__ = makeFakeDb(tables);

// --- fixtures --------------------------------------------------------------
const PDF_BYTES = Buffer.from(
  "%PDF-1.7\n%\xe2\xe3\xcf\xd3\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n"
);
const VIDEO_BYTES = Buffer.concat([
  Buffer.from("\x00\x00\x00\x18ftypmp42"),
  Buffer.alloc(4096, 7),
]);

function seed() {
  tables.lesson = {
    "les-1": {
      id: "les-1",
      title: "Session 1",
      titleAr: "الحصة 1",
      trackScope: "SHARED",
      curriculumStatus: "ACTIVE",
      status: "PUBLISHED",
      unit: null,
      topic: null,
    },
  };
  tables.material = {};
  tables.mediaAsset = {};
  tables.sessionVideo = {};
  tables.quizAttemptEvidence = {};
  tables.student = {};
  tables.batch = { "batch-ar": { id: "batch-ar", schoolType: "ARABIC" } };
  tables.user = {};
}

const req = (url, headers) => new Request(url, { headers: headers || {} });
async function call(handler, url, id, headers) {
  const res = await handler(req(url, headers), { params: Promise.resolve({ id }) });
  const buf = Buffer.from(await res.arrayBuffer());
  const h = {};
  res.headers.forEach((v, k) => {
    h[k] = v;
  });
  return { status: res.status, headers: h, body: buf, text: buf.toString("utf8") };
}

// --- scenarios -------------------------------------------------------------
async function scenarioLocal() {
  const r = { scenario: "local", backend: process.env.MEDIA_BACKEND || "(unset)" };
  seed();
  const materialsRoute = require(path.join(EMIT, "app/api/materials/[id]/route.js"));
  const videoRoute = require(path.join(EMIT, "app/api/admin/session-videos/[id]/route.js"));

  // 1. Upload records LOCAL_PRIVATE and writes to the private volume.
  ops.length = 0;
  const up = await SM.uploadLessonPdfMaterial({
    lessonId: "les-1",
    buffer: PDF_BYTES,
    claimedMime: "application/pdf",
    originalName: "unit-1.pdf",
    title: "Unit 1",
    trackScope: "SHARED",
    actorUserId: "u-admin",
  });
  const assetId = up.ok ? up.material.mediaAssetId : null;
  const row = assetId ? tables.mediaAsset[assetId] : null;
  r.upload = {
    ok: up.ok,
    code: up.ok ? null : up.code,
    storage: row && row.storage,
    kind: row && row.kind,
    isPrivate: row && row.isPrivate,
    keyScope: row ? String(row.storageKey).split("/")[0] : null,
    mimeType: row && row.mimeType,
    sizeBytes: row && row.sizeBytes,
    originalName: row && row.originalName,
    materialStorageKey: tables.material[up.ok ? up.material.id : ""]
      ? tables.material[up.ok ? up.material.id : ""].storageKey
      : "missing",
    fileOnVolume: row ? fs.existsSync(path.join(LOCAL_ROOT, row.storageKey)) : false,
    bucketSize: bucket.size,
    s3Calls: ops.filter((o) => o.startsWith("s3:")).length,
  };

  // 2. Read gate accepts LOCAL_PRIVATE and still refuses everything else.
  const asAdmin = { id: "u-admin", role: "ADMIN" };
  const gate = async (user, materialId) => {
    const a = await SM.authorizeMaterialDownload({
      materialId: materialId || up.material.id,
      user,
    });
    return a.allowed
      ? { allowed: true, storage: a.asset.storage, key: a.asset.storageKey }
      : { allowed: false, reason: a.reason, status: SM.materialAccessHttpStatus(a.reason) };
  };
  r.gates = {
    admin: await gate(asAdmin),
    anonymous: await gate(null),
    studentWithoutProfile: await gate({ id: "u-s", role: "STUDENT" }),
    parentWithoutChildren: await gate({ id: "u-p", role: "PARENT" }),
    unknownRole: await gate({ id: "u-x", role: "GUEST" }),
    missingMaterial: await gate(asAdmin, "nope"),
  };

  // Non-managed / mis-tagged assets must still be refused by check #10.
  const mkMaterial = (id, assetOverrides, materialOverrides) => {
    const aid = "asset-" + id;
    tables.mediaAsset[aid] = Object.assign(
      {
        id: aid,
        kind: "DOCUMENT",
        storage: "LOCAL_PRIVATE",
        storageKey: "session-pdfs/" + id + ".pdf",
        mimeType: "application/pdf",
        sizeBytes: PDF_BYTES.length,
        originalName: id + ".pdf",
        isPrivate: true,
      },
      assetOverrides || {}
    );
    tables.material[id] = Object.assign(
      {
        id,
        lessonId: "les-1",
        title: "t",
        kind: "ADMIN_UPLOADED",
        trackScope: "SHARED",
        isActive: true,
        mediaAssetId: aid,
      },
      materialOverrides || {}
    );
    return id;
  };
  r.gates.externalUrl = await gate(asAdmin, mkMaterial("m-ext", { storage: "EXTERNAL_URL", storageKey: null, externalUrl: "https://cdn.example/x.pdf", isPrivate: false }));
  r.gates.notPrivate = await gate(asAdmin, mkMaterial("m-pub", { isPrivate: false }));
  r.gates.noKey = await gate(asAdmin, mkMaterial("m-nokey", { storageKey: null }));
  r.gates.unknownStorage = await gate(asAdmin, mkMaterial("m-junk", { storage: "SOMETHING_ELSE" }));
  r.gates.inactive = await gate(asAdmin, mkMaterial("m-off", {}, { isActive: false }));
  r.gates.s3AssetAccepted = await gate(
    asAdmin,
    mkMaterial("m-s3", { storage: "S3", storageKey: "session-pdfs/m-s3.pdf" })
  );

  // 3. Download route: statuses, headers, Range/416 — bytes from the volume.
  globalThis.__CM_USER__ = asAdmin;
  const mid = up.material.id;
  const base = "http://codemind.test/api/materials/" + mid;
  ops.length = 0;
  r.download = {
    full: await call(materialsRoute.GET, base, mid),
    range: await call(materialsRoute.GET, base, mid, { range: "bytes=0-4" }),
    openEnded: await call(materialsRoute.GET, base, mid, { range: "bytes=5-" }),
    endPastEof: await call(materialsRoute.GET, base, mid, { range: "bytes=0-999999" }),
    startPastEof: await call(materialsRoute.GET, base, mid, { range: "bytes=9999-10000" }),
    inverted: await call(materialsRoute.GET, base, mid, { range: "bytes=10-2" }),
    unparseable: await call(materialsRoute.GET, base, mid, { range: "bytes=abc-def" }),
    downloadFlag: await call(materialsRoute.GET, base + "?download=1", mid),
    unknownId: await call(materialsRoute.GET, "http://codemind.test/api/materials/nope", "nope"),
    s3CallsForFullRead: ops.filter((o) => o.startsWith("s3:")).length,
  };
  globalThis.__CM_USER__ = null;
  r.download.anonymous = await call(materialsRoute.GET, base, mid);
  globalThis.__CM_USER__ = { id: "u-s", role: "STUDENT" };
  r.download.studentWithoutProfile = await call(materialsRoute.GET, base, mid);
  globalThis.__CM_USER__ = asAdmin;

  // 4. Cross-backend addressing: an object recorded as S3 is served through the
  //    S3 backend even while MEDIA_BACKEND=local (and never touches the volume).
  const s3Backend = await Media.getStorageBackend("s3");
  await s3Backend.write("session-videos/cross.mp4", VIDEO_BYTES, { mimeType: "video/mp4" });
  ops.length = 0;
  const crossBytes = await Media.readPrivateFile("session-videos/cross.mp4", "S3");
  const crossStat = await Media.privateFileStat("session-videos/cross.mp4", "S3");
  const crossRange = await Media.readPrivateFileStream(
    "session-videos/cross.mp4",
    { start: 4, end: 9 },
    "S3"
  );
  const crossRangeBytes = [];
  for await (const c of crossRange.stream) crossRangeBytes.push(c);
  r.crossBackend = {
    readLength: crossBytes.length,
    statSize: crossStat.size,
    rangeStart: crossRange.start,
    rangeEnd: crossRange.end,
    rangeContentLength: crossRange.contentLength,
    rangeTotal: crossRange.size,
    rangeBytes: Buffer.concat(crossRangeBytes).length,
    onLocalVolume: fs.existsSync(path.join(LOCAL_ROOT, "session-videos/cross.mp4")),
    s3Ops: ops.filter((o) => o.startsWith("s3:")).length,
  };
  await Media.deletePrivateFile("session-videos/cross.mp4", "S3");
  r.crossBackend.deletedFromBucket = !bucket.has("session-videos/cross.mp4");
  r.crossBackend.localVolumeUntouched = !fs.existsSync(
    path.join(LOCAL_ROOT, "session-videos/cross.mp4")
  );

  // 5. Delete gate: object first, row second; EXTERNAL_URL moves no bytes.
  tables.mediaAsset["ma-local"] = {
    id: "ma-local",
    kind: "VIDEO",
    storage: "LOCAL_PRIVATE",
    storageKey: "session-videos/local.mp4",
    isPrivate: true,
  };
  await Media.writePrivateFile("session-videos/local.mp4", VIDEO_BYTES);
  ops.length = 0;
  const removedLocal = await SM.cleanupUnreferencedMediaAsset("ma-local");
  r.deleteLocal = {
    removed: removedLocal,
    fileGone: !fs.existsSync(path.join(LOCAL_ROOT, "session-videos/local.mp4")),
    rowGone: !tables.mediaAsset["ma-local"],
    s3Calls: ops.filter((o) => o.startsWith("s3:")).length,
    ops: ops.slice(),
  };

  tables.mediaAsset["ma-ext"] = {
    id: "ma-ext",
    kind: "VIDEO",
    storage: "EXTERNAL_URL",
    externalUrl: "https://cdn.example/v.mp4",
    storageKey: null,
    isPrivate: false,
  };
  ops.length = 0;
  r.deleteExternal = {
    removed: await SM.cleanupUnreferencedMediaAsset("ma-ext"),
    rowGone: !tables.mediaAsset["ma-ext"],
    s3Calls: ops.filter((o) => o.startsWith("s3:")).length,
  };

  // A referenced asset is never deleted (refcount preserved).
  tables.mediaAsset["ma-shared"] = {
    id: "ma-shared",
    kind: "DOCUMENT",
    storage: "LOCAL_PRIVATE",
    storageKey: "session-pdfs/shared.pdf",
    isPrivate: true,
  };
  await Media.writePrivateFile("session-pdfs/shared.pdf", PDF_BYTES);
  tables.material["m-shared"] = {
    id: "m-shared",
    lessonId: "les-1",
    kind: "ADMIN_UPLOADED",
    trackScope: "SHARED",
    isActive: false,
    mediaAssetId: "ma-shared",
  };
  r.deleteReferenced = {
    removed: await SM.cleanupUnreferencedMediaAsset("ma-shared"),
    rowSurvives: !!tables.mediaAsset["ma-shared"],
    bytesSurvive: fs.existsSync(path.join(LOCAL_ROOT, "session-pdfs/shared.pdf")),
  };

  // 6. Session-video DELETE route (ADMIN) — local bytes + row.
  tables.mediaAsset["ma-sv"] = {
    id: "ma-sv",
    kind: "VIDEO",
    storage: "LOCAL_PRIVATE",
    storageKey: "session-videos/sv.mp4",
    mimeType: "video/mp4",
    isPrivate: true,
  };
  await Media.writePrivateFile("session-videos/sv.mp4", VIDEO_BYTES);
  tables.sessionVideo["sv-1"] = {
    id: "sv-1",
    batchId: "batch-ar",
    mediaAssetId: "ma-sv",
    title: "recording",
  };
  globalThis.__CM_USER__ = asAdmin;
  ops.length = 0;
  const svRes = await call(videoRoute.DELETE, "http://codemind.test/api/admin/session-videos/sv-1", "sv-1");
  r.videoDelete = {
    status: svRes.status,
    fileGone: !fs.existsSync(path.join(LOCAL_ROOT, "session-videos/sv.mp4")),
    rowGone: !tables.mediaAsset["ma-sv"],
    videoRowGone: !tables.sessionVideo["sv-1"],
    ops: ops.slice(),
  };
  globalThis.__CM_USER__ = { id: "u-t", role: "TEACHER" };
  r.videoDelete.teacherStatus = (
    await call(videoRoute.DELETE, "http://codemind.test/api/admin/session-videos/sv-1", "sv-1")
  ).status;
  globalThis.__CM_USER__ = asAdmin;

  // 7. Non-managed storage values never reach a backend (fail closed).
  let refused = null;
  try {
    await Media.deletePrivateFile("session-videos/x.mp4", "EXTERNAL_URL");
  } catch (e) {
    refused = String(e.message);
  }
  r.nonManagedRefused = refused;

  r.networkAttempts = networkAttempts;
  r.bucketKeys = [...bucket.keys()];
  return r;
}

async function scenarioS3() {
  const r = { scenario: "s3", backend: process.env.MEDIA_BACKEND || "(unset)" };
  seed();
  const materialsRoute = require(path.join(EMIT, "app/api/materials/[id]/route.js"));
  const mediaRoute = require(path.join(EMIT, "app/api/media/[id]/route.js"));
  const videoRoute = require(path.join(EMIT, "app/api/admin/session-videos/[id]/route.js"));
  const asAdmin = { id: "u-admin", role: "ADMIN" };

  // 1. Upload records S3 and puts the object in the bucket (nothing on disk).
  ops.length = 0;
  const up = await SM.uploadLessonPdfMaterial({
    lessonId: "les-1",
    buffer: PDF_BYTES,
    claimedMime: "application/pdf",
    originalName: "unit-1.pdf",
    title: "Unit 1",
    trackScope: "SHARED",
    actorUserId: "u-admin",
  });
  const assetId = up.ok ? up.material.mediaAssetId : null;
  const row = assetId ? tables.mediaAsset[assetId] : null;
  const stored = row ? bucket.get(row.storageKey) : null;
  r.upload = {
    ok: up.ok,
    code: up.ok ? null : up.code,
    storage: row && row.storage,
    kind: row && row.kind,
    isPrivate: row && row.isPrivate,
    keyScope: row ? String(row.storageKey).split("/")[0] : null,
    objectInBucket: !!stored,
    bucketBytes: stored ? stored.body.length : 0,
    bucketContentType: stored ? stored.contentType : null,
    bytesMatch: stored ? stored.body.equals(PDF_BYTES) : false,
    onLocalVolume: row ? fs.existsSync(path.join(LOCAL_ROOT, row.storageKey)) : false,
    putCalls: ops.filter((o) => o.startsWith("s3:PutObjectCommand")).length,
  };

  // 2. Read gate accepts the S3 asset (same 10-check contract).
  const gate = async (user, materialId) => {
    const a = await SM.authorizeMaterialDownload({
      materialId: materialId || up.material.id,
      user,
    });
    return a.allowed
      ? { allowed: true, storage: a.asset.storage, isPrivate: a.asset.isPrivate }
      : { allowed: false, reason: a.reason, status: SM.materialAccessHttpStatus(a.reason) };
  };
  r.gates = {
    admin: await gate(asAdmin),
    anonymous: await gate(null),
    studentWithoutProfile: await gate({ id: "u-s", role: "STUDENT" }),
    parentWithoutChildren: await gate({ id: "u-p", role: "PARENT" }),
  };
  tables.mediaAsset["asset-ext"] = {
    id: "asset-ext",
    kind: "DOCUMENT",
    storage: "EXTERNAL_URL",
    externalUrl: "https://cdn.example/x.pdf",
    storageKey: null,
    isPrivate: false,
  };
  tables.material["m-ext"] = {
    id: "m-ext",
    lessonId: "les-1",
    kind: "ADMIN_UPLOADED",
    trackScope: "SHARED",
    isActive: true,
    mediaAssetId: "asset-ext",
  };
  r.gates.externalUrl = await gate(asAdmin, "m-ext");

  // 3. Download route over S3: statuses, headers, ranged GETs (not buffering).
  globalThis.__CM_USER__ = asAdmin;
  const mid = up.material.id;
  const base = "http://codemind.test/api/materials/" + mid;
  ops.length = 0;
  r.download = {
    full: await call(materialsRoute.GET, base, mid),
    range: await call(materialsRoute.GET, base, mid, { range: "bytes=0-4" }),
    openEnded: await call(materialsRoute.GET, base, mid, { range: "bytes=5-" }),
    endPastEof: await call(materialsRoute.GET, base, mid, { range: "bytes=0-999999" }),
    startPastEof: await call(materialsRoute.GET, base, mid, { range: "bytes=9999-10000" }),
    inverted: await call(materialsRoute.GET, base, mid, { range: "bytes=10-2" }),
    unparseable: await call(materialsRoute.GET, base, mid, { range: "bytes=abc-def" }),
    downloadFlag: await call(materialsRoute.GET, base + "?download=1", mid),
    unknownId: await call(materialsRoute.GET, "http://codemind.test/api/materials/nope", "nope"),
    ops: ops.slice(),
    rangedGets: ops.filter((o) => o.startsWith("s3:GetObjectCommand[bytes=")).length,
    fullGets: ops.filter((o) => /^s3:GetObjectCommand /.test(o)).length,
  };
  globalThis.__CM_USER__ = null;
  r.download.anonymous = await call(materialsRoute.GET, base, mid);
  globalThis.__CM_USER__ = { id: "u-s", role: "STUDENT" };
  r.download.studentWithoutProfile = await call(materialsRoute.GET, base, mid);
  globalThis.__CM_USER__ = { id: "u-p", role: "PARENT" };
  r.download.parent = await call(materialsRoute.GET, base, mid);
  globalThis.__CM_USER__ = asAdmin;

  // 4. Streaming media route over S3 (session video) — Range → ranged GET.
  tables.mediaAsset["ma-video"] = {
    id: "ma-video",
    kind: "VIDEO",
    storage: "S3",
    storageKey: "session-videos/recording.mp4",
    mimeType: "video/mp4",
    sizeBytes: VIDEO_BYTES.length,
    isPrivate: true,
  };
  await Media.getStorageBackend("s3").then((b) =>
    b.write("session-videos/recording.mp4", VIDEO_BYTES, { mimeType: "video/mp4" })
  );
  tables.sessionVideo["sv-1"] = {
    id: "sv-1",
    batchId: "batch-ar",
    mediaAssetId: "ma-video",
    isPublished: true,
    title: "recording",
  };
  const mbase = "http://codemind.test/api/media/ma-video";
  ops.length = 0;
  r.media = {
    full: await call(mediaRoute.GET, mbase, "ma-video"),
    range: await call(mediaRoute.GET, mbase, "ma-video", { range: "bytes=100-199" }),
    openEnded: await call(mediaRoute.GET, mbase, "ma-video", { range: "bytes=4000-" }),
    startPastEof: await call(mediaRoute.GET, mbase, "ma-video", { range: "bytes=99999-" }),
    endPastEof: await call(mediaRoute.GET, mbase, "ma-video", { range: "bytes=0-99999" }),
    inverted: await call(mediaRoute.GET, mbase, "ma-video", { range: "bytes=200-100" }),
    malformed: await call(mediaRoute.GET, mbase, "ma-video", { range: "bytes=NaN-NaN" }),
    ops: ops.slice(),
    rangedGets: ops.filter((o) => o.startsWith("s3:GetObjectCommand[bytes=")).length,
  };
  // A student of ANOTHER batch/track is refused; a parent is refused; anon 401.
  globalThis.__CM_USER__ = { id: "u-s", role: "STUDENT" };
  tables.student["stu-1"] = { id: "stu-1", userId: "u-s", batchId: "other-batch", schoolType: "LANGUAGE", user: { isActive: true } };
  r.media.otherBatchStudent = await call(mediaRoute.GET, mbase, "ma-video");
  globalThis.__CM_USER__ = { id: "u-p", role: "PARENT" };
  r.media.parent = await call(mediaRoute.GET, mbase, "ma-video");
  globalThis.__CM_USER__ = null;
  r.media.anonymous = await call(mediaRoute.GET, mbase, "ma-video");
  globalThis.__CM_USER__ = asAdmin;
  r.media.unknownId = await call(mediaRoute.GET, "http://codemind.test/api/media/nope", "nope");

  // Quiz evidence stays ADMIN-only and audited.
  tables.mediaAsset["ma-evidence"] = {
    id: "ma-evidence",
    kind: "IMAGE",
    storage: "S3",
    storageKey: "quiz-evidence/snap.jpg",
    mimeType: "image/jpeg",
    sizeBytes: 8,
    isPrivate: true,
  };
  await Media.getStorageBackend("s3").then((b) =>
    b.write("quiz-evidence/snap.jpg", Buffer.alloc(8, 1), { mimeType: "image/jpeg" })
  );
  tables.quizAttemptEvidence["ev-1"] = { id: "ev-1", mediaAssetId: "ma-evidence", kind: "SNAPSHOT" };
  ops.length = 0;
  r.media.evidenceAdmin = await call(mediaRoute.GET, "http://codemind.test/api/media/ma-evidence", "ma-evidence");
  r.media.evidenceSecurityEvent = ops.filter((o) => o === "security:QUIZ_EVIDENCE_ACCESSED").length;
  globalThis.__CM_USER__ = { id: "u-t", role: "TEACHER" };
  r.media.evidenceTeacher = await call(mediaRoute.GET, "http://codemind.test/api/media/ma-evidence", "ma-evidence");
  globalThis.__CM_USER__ = asAdmin;

  // 5. Session-video DELETE route over S3: object deleted BEFORE the row.
  ops.length = 0;
  r.videoDelete = {
    status: (await call(videoRoute.DELETE, "http://codemind.test/api/admin/session-videos/sv-1", "sv-1")).status,
    objectGone: !bucket.has("session-videos/recording.mp4"),
    rowGone: !tables.mediaAsset["ma-video"],
    videoRowGone: !tables.sessionVideo["sv-1"],
    ops: ops.slice(),
  };
  const deleteIndex = r.videoDelete.ops.indexOf("s3:DeleteObjectCommand session-videos/recording.mp4");
  const rowDeleteIndex = r.videoDelete.ops.indexOf("db.mediaAsset.delete");
  r.videoDelete.objectDeletedBeforeRow =
    deleteIndex !== -1 && rowDeleteIndex !== -1 && deleteIndex < rowDeleteIndex;

  // A second video still referencing the asset blocks deletion (refcount).
  await Media.getStorageBackend("s3").then((b) =>
    b.write("session-videos/shared.mp4", VIDEO_BYTES, { mimeType: "video/mp4" })
  );
  tables.mediaAsset["ma-shared"] = {
    id: "ma-shared",
    kind: "VIDEO",
    storage: "S3",
    storageKey: "session-videos/shared.mp4",
    isPrivate: true,
  };
  tables.sessionVideo["sv-a"] = { id: "sv-a", batchId: "batch-ar", mediaAssetId: "ma-shared", isPublished: true };
  tables.sessionVideo["sv-b"] = { id: "sv-b", batchId: "batch-ar", mediaAssetId: "ma-shared", isPublished: true };
  ops.length = 0;
  await call(videoRoute.DELETE, "http://codemind.test/api/admin/session-videos/sv-a", "sv-a");
  r.videoDeleteShared = {
    objectSurvives: bucket.has("session-videos/shared.mp4"),
    rowSurvives: !!tables.mediaAsset["ma-shared"],
    deleteCalls: ops.filter((o) => o.startsWith("s3:DeleteObjectCommand")).length,
  };

  // 6. Delete-order safety: a failing object delete must NOT remove the row.
  tables.mediaAsset["ma-fail"] = {
    id: "ma-fail",
    kind: "VIDEO",
    storage: "S3",
    storageKey: "session-videos/doomed.mp4",
    isPrivate: true,
  };
  await Media.getStorageBackend("s3").then((b) =>
    b.write("session-videos/doomed.mp4", VIDEO_BYTES, { mimeType: "video/mp4" })
  );
  fakeClient.failWith(
    Object.assign(new Error("fake R2 InternalError"), {
      name: "InternalError",
      $metadata: { httpStatusCode: 500 },
    })
  );
  let threw = null;
  try {
    await SM.cleanupUnreferencedMediaAsset("ma-fail");
  } catch (e) {
    threw = String(e.message);
  }
  r.deleteFailure = {
    threw: threw !== null,
    rowSurvives: !!tables.mediaAsset["ma-fail"],
    objectSurvives: bucket.has("session-videos/doomed.mp4"),
  };
  // Retry converges once the service recovers.
  r.deleteFailure.retryRemoved = await SM.cleanupUnreferencedMediaAsset("ma-fail");
  r.deleteFailure.retryRowGone = !tables.mediaAsset["ma-fail"];
  r.deleteFailure.retryObjectGone = !bucket.has("session-videos/doomed.mp4");

  // 7. Missing object → the same non-oracle 404 the local backend produces.
  tables.mediaAsset["ma-ghost"] = {
    id: "ma-ghost",
    kind: "VIDEO",
    storage: "S3",
    storageKey: "session-videos/ghost.mp4",
    mimeType: "video/mp4",
    isPrivate: true,
    sessionVideos: [],
  };
  tables.sessionVideo["sv-ghost"] = { id: "sv-ghost", batchId: "batch-ar", mediaAssetId: "ma-ghost", isPublished: true };
  r.media.missingObject = await call(mediaRoute.GET, "http://codemind.test/api/media/ma-ghost", "ma-ghost");

  // 8. Nothing in ANY response may leak the bucket, a key, or a credential.
  const leaks = [];
  const scan = (label, res) => {
    if (!res) return;
    const hay = JSON.stringify(res.headers) + "\n" + res.text;
    for (const needle of [
      BUCKET,
      "r2.cloudflarestorage.com",
      "X-Amz-",
      "AWSAccessKeyId",
      "session-videos/recording.mp4",
      "session-pdfs/",
    ]) {
      if (hay.includes(needle)) leaks.push(label + " leaked " + needle);
    }
  };
  for (const [group, entries] of Object.entries({ download: r.download, media: r.media })) {
    for (const [label, res] of Object.entries(entries)) scan(group + "." + label, res);
  }
  r.leaks = leaks;

  r.networkAttempts = networkAttempts;
  return r;
}

(async () => {
  const result = SCENARIO === "s3" ? await scenarioS3() : await scenarioLocal();
  result.networkAttempts = networkAttempts;
  console.log("RESULT_JSON " + JSON.stringify(result));
})().catch((e) => {
  console.error("HARNESS_ERROR " + (e && e.stack ? e.stack : String(e)));
  process.exit(1);
});
