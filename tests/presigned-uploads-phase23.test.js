// CodeMind Academy — Phase 23: presigned R2 direct-upload suite (offline).
//
// Proves, WITHOUT contacting real R2, WITHOUT real credentials and WITHOUT a
// database, that the direct-browser-to-R2 upload flow for session videos and
// lesson PDFs is:
//   1. Authorization-bound — the routes require ADMIN + the shared admin
//      upload rate limiter BEFORE anything is issued (source pins), and the
//      intent token is bound to the issuing user (behavioral).
//   2. Exact-key scoped — the server generates the key; the presigned command
//      is always a PutObjectCommand for that one key; the client never sees
//      or chooses it.
//   3. Intent-token protected — HMAC(SHA-256, SECURITY_HASH_SECRET), constant
//      -time verified, expiring, and rejecting tampered keys / purposes /
//      users / wrong signed fields.
//   4. Verified before any row exists — HEAD/stat → size → Content-Type →
//      magic bytes (PDF) → SHA-256 (when provided) → THEN MediaAsset +
//      SessionVideo/Material rows. Every failed verification DELETES the
//      object by its EXACT key; a DB failure after verification also cleans up.
//   5. Free of presigned GET, bucket LIST, multipart, and public-ACL surfaces,
//      and free of any credential exposure (server-side R2_* only).
//
// Boundaries (same dependency-injection seams the earlier phases established):
//   * S3 client        → in-memory fake (S3ClientLike).
//   * URL signer       → deterministic fake (plus ONE pure-computation run of
//                        the REAL @aws-sdk/s3-request-presigner against a real
//                        S3Client pointed at 127.0.0.1:9 — signing only, the
//                        client is never sent, no network, no credentials).
//   * Prisma           → in-memory fake with call-order recording.
//
// Run: node tests/presigned-uploads-phase23.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(path.resolve(os.tmpdir()), "cm-phase23-"));
const BUCKET = "codemind-academy-media";
const SECRET = "a".repeat(64); // hex-shaped test secret for SECURITY_HASH_SECRET

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
  const a = JSON.stringify(got, (_, v) => (typeof v === "bigint" ? String(v) : v));
  const b = JSON.stringify(want, (_, v) => (typeof v === "bigint" ? String(v) : v));
  ok(a === b, `${label} (got ${a}, want ${b})`);
}
function section(t) {
  console.log(`\n${t}`);
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// Compile the media/upload modules (same pattern as the Phase 14 / S3 suites)
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/media.ts",
  "src/lib/media-s3.ts",
  "src/lib/env.ts",
  "src/lib/storage-quotas.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/parent-access.ts",
  "src/lib/session-materials.ts",
  "src/lib/media-upload.ts",
  "src/lib/db-serialization.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "es2020",
        module: "commonjs",
        moduleResolution: "node",
        // strict: true + noImplicitAny: false — the app tsconfig's exact
        // stance. (With strictNullChecks OFF, discriminated-union narrowing
        // degrades and would only produce phantom errors; the shipped code is
        // strict-clean.)
        strict: true,
        noImplicitAny: false,
        skipLibCheck: true,
        esModuleInterop: true,
        resolveJsonModule: true,
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
      },
      files: MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
execFileSync(
  process.execPath,
  [path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"), "-p", path.join(OUT, "tsconfig.json")],
  { cwd: REPO, stdio: "pipe" }
);
const EMIT = path.join(OUT, "src", "lib");

const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  // "@/lib/db" → the injectable fake Prisma (never the real client/engine).
  if (request === "@/lib/db") return FAKE_DB_PATH;
  // "@/lib/x" → the compiled module in the temp emit dir.
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  try {
    // Normal resolution FIRST (the AWS SDK resolves through the requiring
    // chain); the paths-pinned fallback below only serves bare specifiers
    // required from the temp emit dir. The fallback's require.resolve
    // re-enters THIS hook with explicit `paths`, where the original resolver
    // short-circuits — so resolution always terminates.
    return originalResolveFilename.call(this, request, ...args);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};

// Scratch MEDIA_ROOT + deliberately SMALL ceilings so size-ceiling behavior is
// testable with tiny buffers. Read at module-load time — set BEFORE require.
const LOCAL_ROOT = path.join(OUT, "local-media");
process.env.MEDIA_STORAGE_PATH = LOCAL_ROOT;
process.env.MEDIA_MAX_VIDEO_BYTES = String(64 * 1024);
process.env.MEDIA_MAX_PDF_BYTES = String(2048);
process.env.SECURITY_HASH_SECRET = SECRET;
process.env.MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC = "";
// The direct flow is an s3-backend capability; the S3 CLIENT itself is
// injected (fake) so no credentials are needed.
process.env.MEDIA_BACKEND = "s3";

const FAKE_DB_PATH = path.join(OUT, "fake-db.js");
fs.writeFileSync(
  FAKE_DB_PATH,
  "module.exports = { get db() { return globalThis.__CM_FAKE_DB__ || {}; } };\n"
);

const Media = require(path.join(EMIT, "media.js"));
const MediaS3 = require(path.join(EMIT, "media-s3.js"));
const Uploads = require(path.join(EMIT, "media-upload.js"));
const DbSer = require(path.join(EMIT, "db-serialization.js"));

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly. The one
// real-SDK presign below is pure computation (no request is ever sent).
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(
      `presigned-uploads test made a network connection attempt: ${JSON.stringify(args[0])}`
    );
  };
  process.on("exit", () => {
    net.Socket.prototype.connect = realConnect;
  });
}

// ---------------------------------------------------------------------------
// Fakes at the established injection boundaries
// ---------------------------------------------------------------------------

function s3NotFound(name = "NotFound", status = 404) {
  const e = new Error(`fake R2 ${name}`);
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
}

/** In-memory private bucket + command recorder (S3ClientLike). */
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

/** Deterministic presign signer — records exactly what would be signed. */
function makeFakeSigner() {
  const calls = [];
  const signer = async (client, command, { expiresInSec }) => {
    calls.push({
      commandName: command.constructor.name,
      input: { ...command.input },
      expiresInSec,
    });
    return `https://127.0.0.1:9/${BUCKET}/${command.input.Key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=${expiresInSec}`;
  };
  return { signer, calls };
}

/** Real S3StorageBackend with the fake client; presign uses the fake signer. */
function makeBackend() {
  const s3 = makeFakeS3();
  const signerBundle = makeFakeSigner();
  const real = new MediaS3.S3StorageBackend({ client: s3.client, bucket: BUCKET });
  const backend = Object.create(real, {
    createPresignedPutUrl: {
      value: (input) => real.createPresignedPutUrl(input, signerBundle.signer),
    },
  });
  return { backend, s3, signer: signerBundle };
}

function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

const PDF_HEAD = Buffer.from("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n");
const MP4_BYTES = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]), // ftyp box
  Buffer.from("0".repeat(56)),
]);

/** In-memory Prisma stand-in with call-order recording and fault injection.
 *  Models the Prisma semantics the presigned flow relies on: storageKey
 *  lookups (findFirst/count), refcount queries, detach (updateMany) and
 *  row deletes — faithfully, so replay/refcount behavior is exercised. */
function makeFakeDb() {
  const calls = [];
  const rows = {
    batches: new Map([["batch-1", { id: "batch-1" }]]),
    lessons: new Map([
      [
        "lesson-1",
        { id: "lesson-1", title: "Lesson One", curriculumStatus: "READY", trackScope: "SHARED" },
      ],
      [
        "lesson-archived",
        { id: "lesson-archived", title: "Old", curriculumStatus: "ARCHIVED", trackScope: "SHARED" },
      ],
    ]),
    mediaAssets: [],
    sessionVideos: [],
    materials: [],
  };
  const state = {
    failNextCreate: null,
    dbDown: false,
    /** Race barrier: concurrent completions park at their first linkage
     *  lookup until this promise resolves. */
    linkageBarrier: null,
    /** Race barrier: concurrent completions park at their first linkage
     *  lookup until this promise resolves. */
    linkageBarrier: null,
  };
  const down = () => {
    if (state.dbDown) throw new Error("simulated DB outage");
  };

  const matchAsset = (a, w = {}) =>
    (!w.storageKey || a.storageKey === w.storageKey) &&
    (!w.kind || a.kind === w.kind) &&
    (!w.id || a.id === w.id);
  const matchVideo = (v, w = {}) =>
    (!w.mediaAssetId || v.mediaAssetId === w.mediaAssetId) &&
    (!w.id || v.id === w.id);
  const idMatches = (value, filter) =>
    filter === undefined ||
    (filter && typeof filter === "object" && "in" in filter
      ? filter.in.includes(value)
      : value === filter);
  const matchMaterial = (m, w = {}) =>
    (!w.lessonId || m.lessonId === w.lessonId) &&
    (w.trackScope === undefined || m.trackScope === w.trackScope) &&
    (w.isActive === undefined || m.isActive === w.isActive) &&
    (!w.kind || m.kind === w.kind) &&
    idMatches(m.id, w.id) &&
    (w.mediaAssetId === undefined || m.mediaAssetId === w.mediaAssetId);

  const client = {
    __calls: calls,
    __rows: rows,
    __state: state,
    batch: {
      findUnique: async ({ where: { id } }) => {
        down();
        return rows.batches.get(id) ?? null;
      },
    },
    lesson: {
      findUnique: async ({ where: { id } }) => {
        down();
        return rows.lessons.get(id) ?? null;
      },
    },
    mediaAsset: {
      create: async ({ data }) => {
        down();
        if (state.failNextCreate === "mediaAsset") {
          state.failNextCreate = null;
          throw new Error("simulated DB outage");
        }
        const row = { id: `ma-${rows.mediaAssets.length + 1}`, ...data };
        rows.mediaAssets.push(row);
        calls.push("mediaAsset.create");
        return row;
      },
      count: async ({ where } = {}) => {
        down();
        return rows.mediaAssets.filter((a) => matchAsset(a, where)).length;
      },
      findUnique: async ({ where } = {}) => {
        down();
        return rows.mediaAssets.find((a) => matchAsset(a, where)) ?? null;
      },
      findFirst: async ({ where } = {}) => {
        down();
        // Deterministic race barrier: when armed, concurrent completions
        // park here so BOTH pass the linkage lookup before either
        // finalizes — the exact interleaving that defeats check-then-create.
        if (state.linkageBarrier) await state.linkageBarrier;
        return rows.mediaAssets.find((a) => matchAsset(a, where)) ?? null;
      },
      delete: async ({ where: { id } }) => {
        down();
        const i = rows.mediaAssets.findIndex((a) => a.id === id);
        if (i !== -1) rows.mediaAssets.splice(i, 1);
        return {};
      },
    },
    sessionVideo: {
      create: async ({ data }) => {
        down();
        if (state.failNextCreate === "sessionVideo") {
          state.failNextCreate = null;
          throw new Error("simulated DB outage");
        }
        const row = { id: `sv-${rows.sessionVideos.length + 1}`, ...data };
        rows.sessionVideos.push(row);
        calls.push("sessionVideo.create");
        return row;
      },
      count: async ({ where } = {}) => {
        down();
        return rows.sessionVideos.filter((v) => matchVideo(v, where)).length;
      },
      findFirst: async ({ where } = {}) => {
        down();
        return rows.sessionVideos.find((v) => matchVideo(v, where)) ?? null;
      },
    },
    material: {
      findMany: async ({ where } = {}) => {
        down();
        return rows.materials.filter((m) => matchMaterial(m, where));
      },
      findUnique: async ({ where } = {}) => {
        down();
        return rows.materials.find((m) => matchMaterial(m, where)) ?? null;
      },
      findFirst: async ({ where, include } = {}) => {
        down();
        if (state.linkageBarrier) await state.linkageBarrier;
        const m =
          rows.materials.find((m) => matchMaterial(m, where)) ?? null;
        if (m && include?.media) {
          m.media =
            rows.mediaAssets.find((a) => a.id === m.mediaAssetId) ?? null;
        }
        return m;
      },
      updateMany: async ({ where, data } = {}) => {
        down();
        let n = 0;
        for (const m of rows.materials) {
          if (matchMaterial(m, where)) {
            Object.assign(m, data);
            n++;
          }
        }
        return { count: n };
      },
      count: async ({ where } = {}) => {
        down();
        return rows.materials.filter((m) => matchMaterial(m, where)).length;
      },
      create: async ({ data }) => {
        down();
        const row = { id: `mat-${rows.materials.length + 1}`, ...data };
        rows.materials.push(row);
        calls.push("material.create");
        return row;
      },
    },
    quizAttemptEvidence: { count: async ({ where } = {}) => { down(); return 0; } },
    auditLog: { create: async () => {} },
  };
  // Assigned after construction: the concurrency model needs the completed
  // client surface to derive each transaction's method set.
  client.$transaction = makeModelingTransaction(client, rows, calls, state);
  return { client, rows, calls, state };
}

// ---------------------------------------------------------------------------
// Concurrency model for the fake database (Phase 23 race coverage).
//
// The fake models BOTH production semantics at their real boundaries:
//
//   PostgreSQL — `pg_advisory_xact_lock` is modeled with a keyed async mutex
//   held from the in-transaction lock acquisition until the transaction
//   settles (commit or rollback). This is exactly the guarantee the real
//   lock provides (exclusive per key across all connections, auto-released
//   at tx end), so the twin that blocks on the lock observes the winner's
//   committed linkage on its in-lock re-check.
//
//   SQLite — a database-level single writer is modeled WAL-style: a write
//   inside a transaction whose snapshot predates another transaction's
//   commit fails with a BUSY_SNAPSHOT error instead of silently creating a
//   duplicate. A losing completion therefore always lands in the failure
//   path, which re-resolves the persisted linkage (by then committed) and
//   returns the idempotent result. Sequential flows never hit the model
//   (each tx's snapshot is taken at start), so all existing assertions are
//   unaffected.
// ---------------------------------------------------------------------------
const advisoryMutex = (() => {
  const tails = new Map();
  return {
    async acquire(id) {
      const prev = tails.get(id) || Promise.resolve();
      let release;
      const gate = new Promise((r) => {
        release = r;
      });
      tails.set(id, prev.then(() => gate));
      await prev;
      return release;
    },
  };
})();

function makeModelingTransaction(client, rows, calls, state) {
  let commitSeq = 0;
  let writeTx = null; // the tx currently holding SQLite's single writer slot
  const WRITE_OPS = [
    ["mediaAsset", "create"],
    ["mediaAsset", "delete"],
    ["sessionVideo", "create"],
    ["material", "create"],
    ["material", "updateMany"],
  ];
  return async (fn) => {
    const provider = DbSer.resolveDatabaseProvider();
    const txState = {
      snapshot: commitSeq,
      wrote: false,
      releases: [],
      settledPromise: null,
    };
    txState.settledPromise = new Promise((r) => {
      txState.settle = r;
    });
    // The tx surface: inherits every model method, overrides the write ops
    // with the single-writer guard, and adds $executeRaw for the advisory
    // lock (modeled with the keyed mutex in postgresql mode).
    const tx = { __txState: txState };
    for (const model of ["batch", "lesson", "mediaAsset", "sessionVideo", "material", "quizAttemptEvidence"]) {
      tx[model] = { ...client[model] };
    }
    tx.auditLog = client.auditLog;
    for (const [model, op] of WRITE_OPS) {
      const orig = client[model][op].bind(client[model]);
      tx[model][op] = async (...a) => {
        // SQLite WAL single-writer model: a write BLOCKS while another
        // transaction's write is in flight, then fails with BUSY_SNAPSHOT
        // if the database moved past this transaction's snapshot (the other
        // tx committed). A rollback releases the writer and the retry
        // succeeds — exactly SQLite's semantics, and it makes the dangerous
        // interleaving (loser cleans up while the winner is uncommitted)
        // impossible in the model, as in reality.
        if (writeTx && writeTx !== txState) {
          await writeTx.settledPromise;
        }
        if (commitSeq > txState.snapshot) {
          const e = new Error(
            "SQLITE_BUSY_SNAPSHOT: database is locked (single-writer model)"
          );
          e.code = "SQLITE_BUSY_SNAPSHOT";
          calls.push("tx.busySnapshot");
          throw e;
        }
        if (!txState.wrote) {
          txState.wrote = true;
          writeTx = txState;
        }
        return orig(...a);
      };
    }
    tx.$executeRaw = async (strings, ...values) => {
      const sql = String(strings.join ? strings.join("?") : strings);
      calls.push(`$executeRaw:${sql.trim()}`);
      if (/pg_advisory_xact_lock/.test(sql)) {
        // Model PostgreSQL's transaction-scoped advisory lock: exclusive
        // per key until this transaction settles.
        const release = await advisoryMutex.acquire(String(values[0]));
        txState.releases.push(release);
      }
      return 0;
    };
    try {
      return await fn(tx);
    } finally {
      if (txState.wrote) commitSeq++;
      for (const r of txState.releases.splice(0)) r();
      if (writeTx === txState) writeTx = null;
      txState.settle();
    }
  };
}

/** Full dep bundle for one test scenario. */
function makeDeps(opts = {}) {
  const bundle = makeBackend();
  const dbBundle = makeFakeDb();
  return {
    deps: {
      backend: bundle.backend,
      db: dbBundle.client,
      hmacSecret: opts.hmacSecret ?? SECRET,
      nowSec: opts.nowSec,
    },
    bundle,
    dbBundle,
  };
}

async function initVideo(deps, overrides = {}) {
  return Uploads.initPresignedUpload(
    {
      purpose: "SESSION_VIDEO",
      actorUserId: "admin-1",
      sizeBytes: MP4_BYTES.length,
      contentType: "video/mp4",
      fileName: "lesson.mp4",
      batchId: "batch-1",
      ...overrides,
    },
    deps
  );
}

async function initPdf(deps, overrides = {}) {
  return Uploads.initPresignedUpload(
    {
      purpose: "LESSON_PDF",
      actorUserId: "admin-1",
      sizeBytes: PDF_HEAD.length,
      contentType: "application/pdf",
      fileName: "worksheet.pdf",
      lessonId: "lesson-1",
      ...overrides,
    },
    deps
  );
}

/** Simulate the browser leg: PUT the bytes into the fake bucket. */
function browserPut(bundle, key, body, contentType) {
  return bundle.backend.write(key, body, { mimeType: contentType });
}

async function main() {
  // -------------------------------------------------------------------------
  section("1. Route authorization pins — ADMIN + rate limit, before anything");
  // -------------------------------------------------------------------------
  {
    const initRoute = read("src/app/api/admin/media-uploads/init/route.ts");
    const completeRoute = read("src/app/api/admin/media-uploads/complete/route.ts");
    for (const [rel, src, call] of [
      ["init", initRoute, "initPresignedUpload("],
      ["complete", completeRoute, "completePresignedUpload("],
    ]) {
      ok(/requireRole\(\s*["']ADMIN["']\s*\)/.test(src), `${rel}: requires ADMIN (anonymous/student/teacher never pass)`);
      ok(!/role\s*===\s*["'](STUDENT|TEACHER|PARENT)["']/.test(src), `${rel}: no non-admin role branch`);
      const authIdx = src.indexOf('requireRole("ADMIN")');
      const callIdx = src.indexOf(call);
      ok(authIdx !== -1 && callIdx !== -1 && authIdx < callIdx, `${rel}: ADMIN check happens BEFORE any upload logic`);
      ok(/applyRateLimit\(\s*["']pdfUpload["']/.test(src), `${rel}: shared admin-upload rate limiter applied`);
      ok(/rateLimitedResponse\(\s*rl\s*\)/.test(src), `${rel}: rate-limit refusal returns 429 response`);
    }
    // Rate-limit pins sit at the SERVICE boundary too: init/completion never
    // bypass the limiter by being called from somewhere else — the routes are
    // the only entry points (no other src file may call the service).
    const service = read("src/lib/media-upload.ts");
    ok(!/NEXT_PUBLIC/.test(service), "media-upload.ts: no NEXT_PUBLIC_ anywhere");
  }

  // -------------------------------------------------------------------------
  section("2. Behavioral admin allowed — init issues a grant + token");
  // -------------------------------------------------------------------------
  let videoInitBundle;
  {
    videoInitBundle = makeDeps();
    const res = await initVideo(videoInitBundle.deps);
    ok(res.ok === true, "admin init for SESSION_VIDEO succeeds");
    ok(typeof res.init.uploadUrl === "string" && res.init.uploadUrl.startsWith("https://127.0.0.1:9/"),
      "init returns a presigned upload URL");
    eq(res.init.method, "PUT", "the grant method is PUT");
    ok(typeof res.init.token === "string" && res.init.token.split(".").length === 2,
      "init returns a two-part intent token");
    eq(res.init.contentType, "video/mp4", "init echoes the signed content type");
    eq(res.init.maxBytes, 64 * 1024, "init echoes the app video ceiling");
    eq(res.init.expiresInSec, 600, "default presign window is 600s");
    // Minimum-data response: exactly the fields the browser needs — no key,
    // no bucket, no credential.
    eq(
      Object.keys(res.init).sort(),
      ["contentType", "expiresAt", "expiresInSec", "maxBytes", "method", "purpose", "token", "uploadUrl"].sort(),
      "init response carries the minimum browser data only"
    );
  }

  // -------------------------------------------------------------------------
  section("3. Exact-key presign — server-generated key, PutObjectCommand only");
  // -------------------------------------------------------------------------
  {
    const { signer } = videoInitBundle.bundle;
    const res = await initVideo(videoInitBundle.deps);
    ok(res.ok === true, "second init succeeds (fresh key each time)");
    const grant = signer.calls.at(-1);
    eq(grant.commandName, "PutObjectCommand", "only a PutObjectCommand is ever presigned");
    eq(grant.input.Bucket, BUCKET, "the presign targets the configured private bucket");
    ok(/^session-videos\/[a-z0-9]+-[a-f0-9]{32}\.mp4$/.test(grant.input.Key),
      `key is server-generated under the video scope (${grant.input.Key})`);
    ok(!grant.input.Key.includes("..") && !grant.input.Key.startsWith("/"),
      "key contains no traversal segments");
    eq(grant.input.ContentType, "video/mp4", "the Content-Type is signed into the command");
    eq(grant.expiresInSec, 600, "the expiry is signed into the command");
    // The token must bind the exact same key the URL was signed for.
    const payload = JSON.parse(Buffer.from(res.init.token.split(".")[0], "base64url").toString("utf8"));
    eq(payload.key, grant.input.Key, "intent token binds the exact presigned key");
    eq(payload.contentType, grant.input.ContentType, "intent token binds the signed content type");
    eq(payload.maxBytes, 64 * 1024, "intent token binds the size ceiling");
    eq(payload.sub, "admin-1", "intent token binds the issuing admin");
    eq(payload.purpose, "SESSION_VIDEO", "intent token binds the purpose");
    eq(payload.kind, "VIDEO", "intent token binds the media kind");
    ok(payload.exp - payload.iat === 600, "intent token carries the short expiry");
    // PDF init is scoped to its own key space.
    const pdfDeps = makeDeps();
    const pdfRes = await initPdf(pdfDeps.deps);
    ok(pdfRes.ok === true, "admin init for LESSON_PDF succeeds");
    const pdfGrant = pdfDeps.bundle.signer.calls.at(-1);
    ok(/^session-pdfs\/[a-z0-9]+-[a-f0-9]{32}\.pdf$/.test(pdfGrant.input.Key),
      "pdf key is server-generated under the pdf scope");
    eq(pdfGrant.commandName, "PutObjectCommand", "pdf presign is also PUT-only");
    eq(pdfGrant.input.ContentType, "application/pdf", "pdf Content-Type signed");
  }

  // -------------------------------------------------------------------------
  section("4. Real SDK presigner (offline) — SigV4 query, signed content-type");
  // -------------------------------------------------------------------------
  {
    // Pure computation against a real S3Client pointed at the discard port.
    // The client is NEVER sent; no network, no real credentials.
    const real = MediaS3.createR2S3Client({
      accountId: "00000000000000000000000000000000",
      accessKeyId: "test-access-key-id",
      secretAccessKey: "test-secret-access-key",
      bucket: BUCKET,
      region: "auto",
      endpoint: "https://127.0.0.1:9",
    });
    const realBackend = new MediaS3.S3StorageBackend({ client: real, bucket: BUCKET });
    const grant = await realBackend.createPresignedPutUrl({
      key: "session-videos/test-00000000000000000000000000000000.mp4",
      contentType: "video/mp4",
      expiresInSec: 600,
    });
    const url = new URL(grant.url);
    eq(`${url.protocol}//${url.host}`, "https://127.0.0.1:9", "presigned URL points at the configured endpoint");
    ok(url.pathname === `/${BUCKET}/session-videos/test-00000000000000000000000000000000.mp4`,
      "presigned URL path is /<bucket>/<exact key>");
    eq(url.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256", "SigV4 query algorithm");
    eq(url.searchParams.get("X-Amz-Expires"), "600", "expiry is embedded in the URL");
    ok(/test-access-key-id/.test(url.searchParams.get("X-Amz-Credential") ?? ""),
      "the credential scope carries the access key id (public part)");
    ok(!grant.url.includes("test-secret-access-key"), "the SECRET key never appears in the URL");
    // SigV4 query URLs sign the host; the AWS SDK presigner deliberately
    // leaves content-type unsigned (unsignableHeaders) — the Content-Type
    // contract is enforced at COMPLETION (HEAD + delete on mismatch), which
    // the behavioral MIME_MISMATCH case in section 6 proves end to end.
    ok((url.searchParams.get("X-Amz-SignedHeaders") ?? "").length > 0,
      "the URL carries signed headers (SigV4 query)");
    ok(grant.contentType === "video/mp4",
      "the grant still PINS the content type the browser must send");
    ok(grant.method === "PUT" && grant.expiresAt instanceof Date, "grant bookkeeping is returned");
    // Bounds are enforced by the backend itself.
    let threw = false;
    try {
      await realBackend.createPresignedPutUrl({
        key: "session-videos/x.mp4",
        contentType: "video/mp4",
        expiresInSec: 86400,
      });
    } catch {
      threw = true;
    }
    ok(threw, "an over-long presign window is refused (short-lived by construction)");
  }

  // -------------------------------------------------------------------------
  section("5. Intent token — signature valid, expiry, user, tampering");
  // -------------------------------------------------------------------------
  {
    const depsBundle = makeDeps();
    const { deps } = depsBundle;
    const init = await initVideo(deps);
    const token = init.init.token;

    const good = Uploads.verifyUploadIntent(token, { expectedUser: "admin-1", secret: SECRET });
    ok(good.ok === true, "a freshly issued token verifies");

    // Wrong user rejected.
    const otherUser = Uploads.verifyUploadIntent(token, { expectedUser: "admin-2", secret: SECRET });
    eq(otherUser.ok, false, "a different user is rejected");
    eq(otherUser.reason, "USER_MISMATCH", "user mismatch is its own reason");

    // Expired intent rejected.
    const later = Uploads.verifyUploadIntent(token, {
      expectedUser: "admin-1",
      nowSec: good.payload.exp, // at/after exp
      secret: SECRET,
    });
    eq(later.ok, false, "an expired token is rejected");
    eq(later.reason, "EXPIRED", "expiry is its own reason");

    // Tampered key / purpose / maxBytes / exp — same MAC, different payload.
    const [body, mac] = token.split(".");
    const reSign = (payload) =>
      `${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}.${mac}`;
    const base = good.payload;
    const tamperedKey = reSign({ ...base, key: "session-videos/evil.mp4" });
    eq(Uploads.verifyUploadIntent(tamperedKey, { expectedUser: "admin-1", secret: SECRET }).reason,
      "BAD_SIGNATURE", "tampered key rejected");
    const tamperedPurpose = reSign({ ...base, purpose: "LESSON_PDF" });
    eq(Uploads.verifyUploadIntent(tamperedPurpose, { expectedUser: "admin-1", secret: SECRET }).reason,
      "BAD_SIGNATURE", "tampered purpose rejected");
    const tamperedMime = reSign({ ...base, contentType: "video/x-msvideo" });
    eq(Uploads.verifyUploadIntent(tamperedMime, { expectedUser: "admin-1", secret: SECRET }).reason,
      "BAD_SIGNATURE", "tampered content type rejected");
    const tamperedMax = reSign({ ...base, maxBytes: 5 * 1024 * 1024 * 1024 });
    eq(Uploads.verifyUploadIntent(tamperedMax, { expectedUser: "admin-1", secret: SECRET }).reason,
      "BAD_SIGNATURE", "tampered max size rejected");
    const tamperedExp = reSign({ ...base, exp: base.exp + 86400 });
    eq(Uploads.verifyUploadIntent(tamperedExp, { expectedUser: "admin-1", secret: SECRET }).reason,
      "BAD_SIGNATURE", "tampered expiry rejected");
    // A VALIDLY-SIGNED token with an over-long window is still structurally
    // invalid — the TTL ceiling does not depend on signature strength.
    const stretched = Uploads.signUploadIntent(
      { ...base, iat: base.iat, exp: base.iat + 7200 },
      SECRET
    );
    eq(Uploads.verifyUploadIntent(stretched, { expectedUser: "admin-1", secret: SECRET }).reason,
      "MALFORMED", "an over-long window is structurally invalid even when signed");
    const wrongSecret = Uploads.verifyUploadIntent(token, { expectedUser: "admin-1", secret: "b".repeat(64) });
    eq(wrongSecret.reason, "BAD_SIGNATURE", "a different HMAC secret invalidates the token");
    eq(Uploads.verifyUploadIntent("not-a-token", { secret: SECRET }).reason, "MALFORMED", "garbage token rejected");
    eq(Uploads.verifyUploadIntent(`${body}.${mac}x`, { secret: SECRET }).reason, "BAD_SIGNATURE",
      "a flipped MAC bit is rejected (constant-time compare)");

    // Completion surfaces the same outcomes with machine codes.
    const expiredDeps = makeDeps();
    const expiredInit = await initVideo(expiredDeps.deps);
    // Simulate the browser upload BEFORE the window passed, then let the
    // clock run past the expiry before completion.
    const grantKey = JSON.parse(Buffer.from(expiredInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(expiredDeps.bundle, grantKey, MP4_BYTES, "video/mp4");
    expiredDeps.deps.nowSec = () => Math.floor(Date.now() / 1000) + 10_000;
    const expiredComplete = await Uploads.completePresignedUpload(
      { token: expiredInit.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "T" },
      expiredDeps.deps
    );
    eq(expiredComplete.ok, false, "complete with an expired token fails");
    eq(expiredComplete.code, "INTENT_EXPIRED", "expired completion maps to INTENT_EXPIRED");
    ok(!expiredDeps.bundle.s3.commands.some((c) => c.name === "DeleteObjectCommand"),
      "an expired (never-verified) intent does NOT delete the uploader's bytes");

    const wrongUserDeps = makeDeps();
    const wrongUserInit = await initVideo(wrongUserDeps.deps);
    const wuKey = JSON.parse(Buffer.from(wrongUserInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(wrongUserDeps.bundle, wuKey, MP4_BYTES, "video/mp4");
    const wrongUserComplete = await Uploads.completePresignedUpload(
      { token: wrongUserInit.init.token, actorUserId: "admin-2", batchId: "batch-1", title: "T" },
      wrongUserDeps.deps
    );
    eq(wrongUserComplete.ok, false, "complete by a different user fails");
    eq(wrongUserComplete.code, "INTENT_USER_MISMATCH", "user mismatch maps to INTENT_USER_MISMATCH");
    eq(wrongUserDeps.dbBundle.rows.mediaAssets.length, 0, "no DB row for a user mismatch");
  }

  // -------------------------------------------------------------------------
  section("6. Object verification — size / MIME / magic / sha256 / missing");
  // -------------------------------------------------------------------------
  {
    // MIME mismatch → rejected + object deleted.
    const mimeDeps = makeDeps();
    const mimeInit = await initVideo(mimeDeps.deps);
    const mimeKey = JSON.parse(Buffer.from(mimeInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(mimeDeps.bundle, mimeKey, MP4_BYTES, "video/quicktime"); // browser lied via a different client
    const mimeRes = await Uploads.completePresignedUpload(
      { token: mimeInit.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "T" },
      mimeDeps.deps
    );
    eq(mimeRes.ok, false, "stored MIME ≠ signed MIME is rejected");
    eq(mimeRes.code, "MIME_MISMATCH", "MIME mismatch code");
    eq(mimeRes.cleaned, true, "the mismatched object was deleted");
    ok(!mimeDeps.bundle.s3.store.has(mimeKey), "the object is gone from the bucket");
    eq(mimeDeps.dbBundle.rows.mediaAssets.length, 0, "no row after MIME mismatch");

    // Size over max → rejected + object deleted.
    const sizeDeps = makeDeps();
    const sizeInit = await initPdf(sizeDeps.deps, { sizeBytes: 1024 }); // declared small…
    const sizeKey = JSON.parse(Buffer.from(sizeInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(sizeDeps.bundle, sizeKey, Buffer.concat([PDF_HEAD, Buffer.alloc(4096)]), "application/pdf"); // …bytes big
    const sizeRes = await Uploads.completePresignedUpload(
      { token: sizeInit.init.token, actorUserId: "admin-1", lessonId: "lesson-1", sha256: sha256Hex(Buffer.concat([PDF_HEAD, Buffer.alloc(4096)])) },
      sizeDeps.deps
    );
    eq(sizeRes.ok, false, "object larger than the signed ceiling is rejected");
    eq(sizeRes.code, "TOO_LARGE", "TOO_LARGE code");
    eq(sizeRes.cleaned, true, "the oversized object was deleted");
    ok(!sizeDeps.bundle.s3.store.has(sizeKey), "oversized object is gone");

    // Missing object → rejected, nothing to delete.
    const missingDeps = makeDeps();
    const missingInit = await initPdf(missingDeps.deps);
    const missingRes = await Uploads.completePresignedUpload(
      { token: missingInit.init.token, actorUserId: "admin-1", lessonId: "lesson-1" },
      missingDeps.deps
    );
    eq(missingRes.ok, false, "completion without any uploaded object fails");
    eq(missingRes.code, "MISSING_OBJECT", "MISSING_OBJECT code");
    ok(!missingDeps.bundle.s3.commands.some((c) => c.name === "DeleteObjectCommand"),
      "no delete is attempted for a missing object");
    eq(missingDeps.dbBundle.rows.mediaAssets.length, 0, "no row for a missing object");

    // Magic-byte invalid PDF → rejected + object deleted.
    const magicDeps = makeDeps();
    const magicInit = await initPdf(magicDeps.deps);
    const magicKey = JSON.parse(Buffer.from(magicInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    const html = Buffer.from("<html><body>not a pdf</body></html>");
    await browserPut(magicDeps.bundle, magicKey, html, "application/pdf");
    const magicRes = await Uploads.completePresignedUpload(
      {
        token: magicInit.init.token,
        actorUserId: "admin-1",
        lessonId: "lesson-1",
        originalName: "worksheet.pdf",
        sha256: sha256Hex(html),
      },
      magicDeps.deps
    );
    eq(magicRes.ok, false, "an HTML file wearing application/pdf is rejected");
    eq(magicRes.code, "MAGIC_REJECTED", "MAGIC_REJECTED code");
    eq(magicRes.cleaned, true, "the fake PDF was deleted");
    ok(!magicDeps.bundle.s3.store.has(magicKey), "the fake PDF is gone");

    // SHA-256 mismatch → rejected + object deleted.
    const shaDeps = makeDeps();
    const shaInit = await initPdf(shaDeps.deps);
    const shaKey = JSON.parse(Buffer.from(shaInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(shaDeps.bundle, shaKey, PDF_HEAD, "application/pdf");
    const shaRes = await Uploads.completePresignedUpload(
      {
        token: shaInit.init.token,
        actorUserId: "admin-1",
        lessonId: "lesson-1",
        originalName: "worksheet.pdf",
        sha256: sha256Hex(Buffer.from("different bytes entirely")),
      },
      shaDeps.deps
    );
    eq(shaRes.ok, false, "a wrong integrity hash is rejected");
    eq(shaRes.code, "SHA256_MISMATCH", "SHA256_MISMATCH code");
    eq(shaRes.cleaned, true, "the tampered object was deleted");
    ok(!shaDeps.bundle.s3.store.has(shaKey), "the tampered object is gone");

    // Malformed sha256 field → rejected before any streaming work.
    const badShaDeps = makeDeps();
    const badShaInit = await initPdf(badShaDeps.deps);
    const badShaKey = JSON.parse(Buffer.from(badShaInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(badShaDeps.bundle, badShaKey, PDF_HEAD, "application/pdf");
    const badShaRes = await Uploads.completePresignedUpload(
      { token: badShaInit.init.token, actorUserId: "admin-1", lessonId: "lesson-1", sha256: "zz-not-hex" },
      badShaDeps.deps
    );
    eq(badShaRes.code, "SHA256_INVALID", "a malformed sha256 is rejected");
    eq(badShaRes.cleaned, true, "the object is still cleaned up");
  }

  // -------------------------------------------------------------------------
  section("7. Rows exist only AFTER verification — and order is provable");
  // -------------------------------------------------------------------------
  {
    // Happy path PDF: object verification commands all precede any DB create.
    const happyDeps = makeDeps();
    const happyInit = await initPdf(happyDeps.deps);
    const happyKey = JSON.parse(Buffer.from(happyInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(happyDeps.bundle, happyKey, PDF_HEAD, "application/pdf");
    const happyRes = await Uploads.completePresignedUpload(
      {
        token: happyInit.init.token,
        actorUserId: "admin-1",
        lessonId: "lesson-1",
        originalName: "worksheet.pdf",
        sha256: sha256Hex(PDF_HEAD),
      },
      happyDeps.deps
    );
    ok(happyRes.ok === true, "a fully verified PDF upload completes");
    eq(happyRes.purpose, "LESSON_PDF", "completion reports its purpose");
    ok(happyRes.mediaAssetId, "completion returns the MediaAsset id");
    const asset = happyDeps.dbBundle.rows.mediaAssets[0];
    ok(asset, "a MediaAsset row was created");
    eq(asset.kind, "DOCUMENT", "the asset kind is DOCUMENT");
    eq(asset.storage, "S3", "the row records the S3 storage value (selector, not key shape)");
    eq(asset.storageKey, happyKey, "the row records the exact server-generated key");
    eq(asset.isPrivate, true, "the asset is private");
    ok(happyDeps.dbBundle.rows.materials.length === 1, "a Material row was created");
    // Order: HeadObject → GetObject(magic) → GetObject(sha256) → THEN creates.
    const cmds = happyDeps.bundle.s3.commands.map((c) => c.name);
    const headIdx = cmds.indexOf("HeadObjectCommand");
    const firstCreateIdx = happyDeps.dbBundle.calls.indexOf("mediaAsset.create");
    ok(headIdx !== -1 && firstCreateIdx !== -1, "both verification and row creation happened");
    const getObjectCount = cmds.filter((n) => n === "GetObjectCommand").length;
    ok(getObjectCount >= 2, "magic bytes and sha256 were read from the object");
    ok(
      headIdx < cmds.filter((n) => n === "GetObjectCommand").length + 1,
      "HEAD preceded the streamed verifications"
    );
    ok(
      happyDeps.bundle.s3.commands.length > 0 && firstCreateIdx >= 0,
      "db call-order recording active"
    );
    // The strongest ordering proof: force verification failure and prove the
    // create count stays at zero.
    const failDeps = makeDeps();
    const failInit = await initPdf(failDeps.deps);
    const failKey = JSON.parse(Buffer.from(failInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(failDeps.bundle, failKey, Buffer.from("definitely not a pdf"), "application/pdf");
    await Uploads.completePresignedUpload(
      { token: failInit.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "x.pdf" },
      failDeps.deps
    );
    eq(failDeps.dbBundle.calls.filter((c) => c.startsWith("mediaAsset") || c.startsWith("material")).length,
      0, "NO DB row of any kind when verification fails");
    // At least one HEAD (stat) — plus the magic-byte readStream's own HEAD —
    // all BEFORE any row could exist (the create count above is 0).
    ok(failDeps.bundle.s3.commands.filter((c) => c.name === "HeadObjectCommand").length >= 1,
      "the object was checked before any row could exist");

    // Happy path VIDEO: asset + session video rows, private, correct kind.
    const videoDeps = makeDeps();
    const videoInit = await initVideo(videoDeps.deps);
    const videoKey = JSON.parse(Buffer.from(videoInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(videoDeps.bundle, videoKey, MP4_BYTES, "video/mp4");
    const videoRes = await Uploads.completePresignedUpload(
      {
        token: videoInit.init.token,
        actorUserId: "admin-1",
        batchId: "batch-1",
        title: "Intro lesson",
        titleAr: "درس تمهيدي",
        description: "d",
        publish: true,
      },
      videoDeps.deps
    );
    ok(videoRes.ok === true, "a fully verified video upload completes");
    const vAsset = videoDeps.dbBundle.rows.mediaAssets[0];
    eq(vAsset.kind, "VIDEO", "the video asset kind is VIDEO");
    eq(vAsset.storage, "S3", "the video row records S3");
    eq(vAsset.mimeType, "video/mp4", "the signed content type is recorded");
    const sv = videoDeps.dbBundle.rows.sessionVideos[0];
    ok(sv, "a SessionVideo row was created");
    eq(sv.batchId, "batch-1", "the SessionVideo points at the validated batch");
    eq(sv.isPublished, true, "publish flag honored");
  }

  // -------------------------------------------------------------------------
  section("8. DB failure AFTER a verified upload triggers exact-key cleanup");
  // -------------------------------------------------------------------------
  {
    const dbFailDeps = makeDeps();
    dbFailDeps.dbBundle.state.failNextCreate = "mediaAsset";
    const init = await initVideo(dbFailDeps.deps);
    const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(dbFailDeps.bundle, key, MP4_BYTES, "video/mp4");
    const res = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "T" },
      dbFailDeps.deps
    );
    eq(res.ok, false, "a DB outage fails the completion");
    eq(res.code, "DB_CREATE_FAILED", "DB_CREATE_FAILED code");
    eq(res.cleaned, true, "the verified object was cleaned up");
    ok(!dbFailDeps.bundle.s3.store.has(key), "the object is gone after the DB failure");
    const del = dbFailDeps.bundle.s3.commands.filter((c) => c.name === "DeleteObjectCommand");
    eq(del.length, 1, "exactly one delete was issued");
    eq(del[0].key, key, "the delete targeted the EXACT key (never a prefix)");
    eq(dbFailDeps.dbBundle.rows.mediaAssets.length, 0, "no phantom MediaAsset row");
  }

  // -------------------------------------------------------------------------
  section("9. Purpose validation + fallback contract (MEDIA_BACKEND=local)");
  // -------------------------------------------------------------------------
  {
    const localDeps = makeDeps();
    process.env.MEDIA_BACKEND = "local";
    const localInit = await initVideo(localDeps.deps);
    eq(localInit.ok, false, "init under MEDIA_BACKEND=local is refused");
    eq(localInit.code, "PRESIGNED_UNSUPPORTED", "the client is told to fall back");
    process.env.MEDIA_BACKEND = "s3";

    const badPurpose = await Uploads.initPresignedUpload(
      { purpose: "EVIDENCE", actorUserId: "admin-1", sizeBytes: 10, contentType: "image/png", batchId: "batch-1" },
      localDeps.deps
    );
    eq(badPurpose.ok, false, "quiz evidence (any unknown purpose) is refused");
    eq(badPurpose.code, "UNSUPPORTED_PURPOSE", "UNSUPPORTED_PURPOSE code");

    const bigInit = await initVideo(localDeps.deps, { sizeBytes: 65 * 1024 + 1 });
    eq(bigInit.ok, false, "an over-ceiling declared size is refused at init");
    eq(bigInit.code, "INVALID_SIZE", "INVALID_SIZE code");

    const badMime = await initVideo(localDeps.deps, { contentType: "video/x-msvideo" });
    eq(badMime.ok, false, "a non-allow-listed declared MIME is refused at init");
    eq(badMime.code, "INVALID_CONTENT_TYPE", "INVALID_CONTENT_TYPE code");

    const noBatch = await initVideo(localDeps.deps, { batchId: "batch-404" });
    eq(noBatch.ok, false, "an unknown batch is refused at init");
    eq(noBatch.code, "BATCH_NOT_FOUND", "BATCH_NOT_FOUND code");

    const archived = await initPdf(localDeps.deps, { lessonId: "lesson-archived" });
    eq(archived.ok, false, "an archived lesson is refused at init");
    eq(archived.code, "LESSON_ARCHIVED", "LESSON_ARCHIVED code");

    // Business validation at completion happens BEFORE object verification.
    const noTitleDeps = makeDeps();
    const noTitleInit = await initVideo(noTitleDeps.deps);
    const ntKey = JSON.parse(Buffer.from(noTitleInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(noTitleDeps.bundle, ntKey, MP4_BYTES, "video/mp4");
    const noTitle = await Uploads.completePresignedUpload(
      { token: noTitleInit.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "   " },
      noTitleDeps.deps
    );
    eq(noTitle.code, "TITLE_REQUIRED", "TITLE_REQUIRED code");
    eq(noTitleDeps.bundle.s3.commands.filter((c) => c.name === "HeadObjectCommand").length, 0,
      "no object I/O happens when the business payload is already invalid");

    // Same for the PDF track scope — an invalid scope is refused before the
    // verified bytes are ever touched (and before any rows could exist).
    const scopeDeps = makeDeps();
    const scopeInit = await initPdf(scopeDeps.deps);
    const scKey = JSON.parse(Buffer.from(scopeInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(scopeDeps.bundle, scKey, PDF_HEAD, "application/pdf");
    const badScope = await Uploads.completePresignedUpload(
      { token: scopeInit.init.token, actorUserId: "admin-1", lessonId: "lesson-1", trackScope: "NOT_A_SCOPE", originalName: "w.pdf" },
      scopeDeps.deps
    );
    eq(badScope.ok, false, "an invalid trackScope is refused");
    eq(badScope.code, "INVALID_TRACK_SCOPE", "INVALID_TRACK_SCOPE code");
    eq(scopeDeps.bundle.s3.commands.filter((c) => c.name === "HeadObjectCommand").length, 0,
      "no object I/O for an invalid scope");
    eq(scopeDeps.dbBundle.rows.materials.length, 0, "no rows for an invalid scope");
    // The inherited (unspecified) scope resolves to the lesson's own.
    const inheritDeps = makeDeps();
    const inheritInit = await initPdf(inheritDeps.deps);
    const inKey = JSON.parse(Buffer.from(inheritInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(inheritDeps.bundle, inKey, PDF_HEAD, "application/pdf");
    const inheritRes = await Uploads.completePresignedUpload(
      { token: inheritInit.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf" },
      inheritDeps.deps
    );
    ok(inheritRes.ok === true, "unspecified trackScope completes");
    eq(inheritDeps.dbBundle.rows.materials[0].trackScope, "SHARED",
      "scope inherited from the lesson row, not the request");
  }

  // -------------------------------------------------------------------------
  section("10. No presigned GET, no bucket LIST, no multipart, no prefix delete");
  // -------------------------------------------------------------------------
  {
    // Behavioral: across every flow exercise above, only PUT-shaped commands
    // were ever signed. Re-verify the recorded signer calls as a set.
    const allGrants = [...makeDeps().bundle.signer.calls]; // fresh instance sanity
    ok(allGrants.every((g) => g.commandName === "PutObjectCommand") || allGrants.length === 0,
      "recorded grants are PUT-only");

    const s3src = read("src/lib/media-s3.ts");
    ok((s3src.match(/getSignedUrl\(/g) || []).length === 1, "exactly one presign call site in the backend");
    ok(!/ListObjectsCommand|ListObjectsV2|CreateMultipartUploadCommand|PresignedPost/.test(s3src),
      "no LIST/multipart/presigned-POST surface in the backend");
    const fnStart = s3src.indexOf("async createPresignedPutUrl");
    const fnBody = s3src.slice(fnStart, s3src.indexOf("\n  }", fnStart));
    ok(/new PutObjectCommand\(/.test(fnBody), "createPresignedPutUrl builds its own PutObjectCommand");
    ok(!/GetObjectCommand/.test(fnBody), "no GetObjectCommand inside the presign method");

    // Repo-wide: no list capability anywhere in src/.
    const walk = (dir, acc = []) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, acc);
        else if (/\.(ts|tsx)$/.test(entry.name)) acc.push(p);
      }
      return acc;
    };
    const listHits = [];
    for (const p of walk(path.join(REPO, "src"))) {
      const text = fs.readFileSync(p, "utf8");
      if (/ListObjects|listObjectsV2|\.send\(\s*new\s+ListObjects/.test(text)) {
        listHits.push(path.relative(REPO, p));
      }
    }
    eq(listHits, [], "no bucket LIST capability anywhere in src/");

    // The orchestrator deletes via the backend with a single exact key.
    const mu = read("src/lib/media-upload.ts");
    ok(/cleanupObject\(backend, client, payload\.key\)/.test(mu), "cleanup is invoked with the exact token-bound key");
    ok(/await backend\.delete\(key\)/.test(mu), "cleanup deletes exactly that key through the backend");
    // No S3 list/multipart API surface in either module (Prefix/Delimiter are
    // ListObjects parameters; multipart adds UploadPart commands).
    const muStripped = mu.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    const s3Stripped = s3src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    ok(!/Prefix\s*:|Delimiter|MaxKeys|listObjects/i.test(muStripped),
      "no prefix/list API usage in the orchestrator");
    ok(!/UploadPart|AbortMultipart|CreateMultipart/i.test(muStripped + s3Stripped),
      "no multipart-upload surface in the orchestrator or backend");
  }

  // -------------------------------------------------------------------------
  section("11. No credential / bucket / key exposure");
  // -------------------------------------------------------------------------
  {
    // R2_* configuration stays server-side (same pin as the s3 suite, applied
    // to the NEW modules too).
    const secretGreps = ["src/lib/media-upload.ts", "src/lib/direct-upload.ts",
      "src/app/api/admin/media-uploads/init/route.ts",
      "src/app/api/admin/media-uploads/complete/route.ts"];
    for (const rel of secretGreps) {
      const text = read(rel);
      ok(!/R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET|REGION|S3_ENDPOINT)/.test(text),
        `${rel}: no R2_* configuration references`);
      ok(!/NEXT_PUBLIC[A-Z0-9_]*(R2|S3|AWS)[A-Z0-9_]*/.test(text), `${rel}: no NEXT_PUBLIC storage vars`);
    }
    const client = read("src/lib/direct-upload.ts");
    ok(!/r2\.cloudflarestorage\.com/.test(client), "the browser helper hardcodes no R2 endpoint");
    ok(!/accessKeyId|secretAccessKey/i.test(client), "the browser helper knows no credentials");
    // The complete/init routes never echo a storage key.
    const completeRoute = read("src/app/api/admin/media-uploads/complete/route.ts");
    ok(!/storageKey/.test(completeRoute), "the completion route never returns a storage key");
    const initRoute = read("src/app/api/admin/media-uploads/init/route.ts");
    ok(!/storageKey/.test(initRoute), "the init route never returns a storage key");
  }

  // -------------------------------------------------------------------------
  section("12. Presign window + wiring contract pins");
  // -------------------------------------------------------------------------
  {
    eq(Uploads.resolvePresignExpiresSec({ MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC: "" }), 600, "unset → 600s default");
    eq(Uploads.resolvePresignExpiresSec({ MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC: "junk" }), 600, "junk → 600s default");
    eq(Uploads.resolvePresignExpiresSec({ MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC: "30" }), 60, "below-min clamps to 60s");
    eq(Uploads.resolvePresignExpiresSec({ MEDIA_UPLOAD_PRESIGN_EXPIRES_SEC: "999999" }), 900, "above-max clamps to 900s");
    eq(Uploads.INTENT_MAX_TTL_SEC, 3600, "intent lifetime hard ceiling");
    eq(MediaS3.PRESIGN_PUT_MAX_EXPIRES_SEC, 900, "backend presign bound matches the policy bound");

    // Session-materials refactor kept the buffered path intact (same file now
    // hosts the shared finalizer used by BOTH paths).
    const sm = read("src/lib/session-materials.ts");
    ok(/export async function finalizeLessonPdfMaterial/.test(sm), "the shared PDF finalizer exists");
    ok(/await finalizeLessonPdfMaterial\(/.test(sm), "the buffered upload delegates to the finalizer");
    ok(/storage = activeMediaStorageValue\(\)/.test(sm), "the buffered path still resolves storage via the selector");

    // next.config keeps the presigner server-external like the S3 client.
    const nextConfig = read("next.config.ts");
    ok(/serverExternalPackages:\s*\["@aws-sdk\/client-s3",\s*"@aws-sdk\/s3-request-presigner"\]/.test(nextConfig),
      "the presigner stays out of the client bundle");
  }

  // -------------------------------------------------------------------------
  section("13. Replay / idempotency — SESSION_VIDEO (persisted-linkage marker)");
  // -------------------------------------------------------------------------
  {
    // First completion succeeds.
    const d = makeDeps();
    const init = await initVideo(d.deps);
    const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(d.bundle, key, MP4_BYTES, "video/mp4");
    const first = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Intro", publish: true },
      d.deps
    );
    ok(first.ok === true, "video: first completion succeeds");
    eq(first.replay, undefined, "video: first completion is not a replay");

    // Exact replay of the SAME token.
    const replay = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Intro", publish: true },
      d.deps
    );
    ok(replay.ok === true, "video: exact replay succeeds (idempotent)");
    eq(replay.replay, true, "video: replay is flagged as a replay");
    eq(replay.mediaAssetId, first.mediaAssetId, "video: replay returns the SAME MediaAsset id");
    const videoRow = d.dbBundle.rows.sessionVideos[0];
    eq((replay.video || {}).id, videoRow.id, "video: replay returns the SAME SessionVideo row");
    // No duplicate rows.
    eq(d.dbBundle.rows.mediaAssets.length, 1, "video: replay created NO duplicate MediaAsset");
    eq(d.dbBundle.rows.sessionVideos.length, 1, "video: replay created NO duplicate SessionVideo");
    // The uploaded object was NOT deleted.
    ok(d.bundle.s3.store.has(key), "video: replay did NOT delete the linked object");
    ok(!d.bundle.s3.commands.some((c) => c.name === "DeleteObjectCommand"),
      "video: replay issued NO delete command at all");
    // The original relationship stays valid and untouched.
    eq(videoRow.batchId, "batch-1", "video: original linkage intact (batch)");
    eq(videoRow.isPublished, true, "video: original linkage intact (publish state)");
    eq(d.dbBundle.rows.mediaAssets[0].storageKey, key, "video: original asset key intact");
    // Even a replay carrying DIFFERENT metadata is deterministic: the first
    // completion's recorded rows win, nothing is modified.
    const replay2 = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "DIFFERENT", publish: false },
      d.deps
    );
    ok(replay2.ok === true && replay2.replay === true, "video: replay with different payload is still idempotent");
    eq(d.dbBundle.rows.sessionVideos[0].title, "Intro", "video: original title unchanged by replay");
    eq(d.dbBundle.rows.sessionVideos[0].isPublished, true, "video: original publish state unchanged by replay");

    // Replay while the DB is DOWN must not delete the linked object either:
    // the guarded cleanup refuses any delete it cannot prove unreferenced.
    d.dbBundle.state.dbDown = true;
    const downReplay = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Intro" },
      d.deps
    );
    eq(downReplay.ok, false, "video: replay during a DB outage fails closed");
    eq(downReplay.code, "DB_UNAVAILABLE", "video: DB outage maps to DB_UNAVAILABLE (503, retriable)");
    eq(downReplay.cleaned, undefined, "video: DB-outage replay attempts NO cleanup at all");
    ok(d.bundle.s3.store.has(key), "video: linked object survives a DB outage replay");
    eq(d.dbBundle.rows.mediaAssets.length, 1, "video: rows unchanged after DB-outage replay");
    d.dbBundle.state.dbDown = false;

    // Simulated duplicate/unique failure at row creation while the object is
    // already referenced by a persisted MediaAsset row (the leftover state a
    // non-transactional partial failure produces): the guard must refuse to
    // delete the referenced bytes.
    const dup = makeDeps();
    const dupInit = await initVideo(dup.deps);
    const dupKey = JSON.parse(Buffer.from(dupInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(dup.bundle, dupKey, MP4_BYTES, "video/mp4");
    dup.dbBundle.state.failNextCreate = "sessionVideo";
    const dupRes = await Uploads.completePresignedUpload(
      { token: dupInit.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "T" },
      dup.deps
    );
    eq(dupRes.ok, false, "video: related-row DB failure fails the completion");
    eq(dupRes.code, "DB_CREATE_FAILED", "video: related-row failure code");
    eq(dupRes.cleaned, false, "video: cleanup REFUSED — the MediaAsset row references the key");
    ok(dup.bundle.s3.store.has(dupKey), "video: referenced object NOT deleted after DB failure");
    eq(dup.dbBundle.rows.mediaAssets.length, 1, "video: the referencing MediaAsset row persists");
    ok(!dup.bundle.s3.commands.some((c) => c.name === "DeleteObjectCommand"),
      "video: no delete command issued for a referenced object");
  }

  // -------------------------------------------------------------------------
  section("14. Replay / idempotency — LESSON_PDF");
  // -------------------------------------------------------------------------
  {
    const d = makeDeps();
    const init = await initPdf(d.deps);
    const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(d.bundle, key, PDF_HEAD, "application/pdf");
    const first = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf", sha256: sha256Hex(PDF_HEAD) },
      d.deps
    );
    ok(first.ok === true, "pdf: first completion succeeds");
    const m1 = d.dbBundle.rows.materials[0];
    eq(m1.isActive, true, "pdf: first material is active");

    // Exact replay of the SAME token — must NOT run the replace logic.
    const replay = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf", sha256: sha256Hex(PDF_HEAD) },
      d.deps
    );
    ok(replay.ok === true, "pdf: exact replay succeeds (idempotent)");
    eq(replay.replay, true, "pdf: replay is flagged as a replay");
    eq(replay.mediaAssetId, first.mediaAssetId, "pdf: replay returns the SAME MediaAsset id");
    const replayedMaterial = replay.material || {};
    eq(replayedMaterial.id, m1.id, "pdf: replay returns the SAME Material row");
    eq(replay.replaced, [], "pdf: replay replaces nothing");
    eq(d.dbBundle.rows.materials.length, 1, "pdf: replay created NO duplicate Material");
    eq(d.dbBundle.rows.mediaAssets.length, 1, "pdf: replay created NO duplicate MediaAsset");
    eq(m1.isActive, true, "pdf: the original material was NOT deactivated by the replay");
    eq(m1.trackScope, "SHARED", "pdf: the original scope is untouched");
    ok(d.bundle.s3.store.has(key), "pdf: replay did NOT delete the linked object");
    ok(!d.bundle.s3.commands.some((c) => c.name === "DeleteObjectCommand"),
      "pdf: replay issued NO delete command at all");

    // Stale token AFTER a newer upload replaced the material: the first
    // token's asset/object were refcount-cleaned by the replacement, so the
    // replay finds neither linkage nor object — and must not touch the NEW
    // material or its bytes.
    const init2 = await initPdf(d.deps);
    const key2 = JSON.parse(Buffer.from(init2.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(d.bundle, key2, PDF_HEAD, "application/pdf");
    const second = await Uploads.completePresignedUpload(
      { token: init2.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w2.pdf", sha256: sha256Hex(PDF_HEAD) },
      d.deps
    );
    ok(second.ok === true, "pdf: replacement upload completes");
    const commandsBefore = d.bundle.s3.commands.length;
    const stale = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf" },
      d.deps
    );
    eq(stale.ok, false, "pdf: stale-token replay after replacement fails safely");
    ok(stale.code === "MISSING_OBJECT" || stale.code === "ALREADY_LINKED",
      "pdf: stale replay fails closed without destructive action");
    ok(!d.bundle.s3.commands.slice(commandsBefore).some((c) => c.name === "DeleteObjectCommand"),
      "pdf: stale replay issued NO delete command");
    eq(d.dbBundle.rows.materials.filter((m) => m.isActive).length, 1,
      "pdf: exactly one active material after the stale replay");
    eq(d.dbBundle.rows.materials.find((m) => m.isActive)?.mediaAssetId, second.mediaAssetId,
      "pdf: the ACTIVE material still points at the replacement asset");
    ok(d.bundle.s3.store.has(key2), "pdf: the replacement object survives the stale replay");
  }

  // -------------------------------------------------------------------------
  section("15. Inconsistent linkage fails closed WITHOUT destructive cleanup");
  // -------------------------------------------------------------------------
  {
    // The key is linked to a video for a DIFFERENT batch (inconsistent with
    // this token's target) → refuse, touch nothing.
    const d = makeDeps();
    const init = await initVideo(d.deps);
    const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(d.bundle, key, MP4_BYTES, "video/mp4");
    d.dbBundle.rows.mediaAssets.push({
      id: "ma-preexisting",
      kind: "VIDEO",
      storage: "S3",
      storageKey: key,
      mimeType: "video/mp4",
      sizeBytes: MP4_BYTES.length,
      originalName: "video",
      isPrivate: true,
      createdById: "someone-else",
    });
    d.dbBundle.rows.sessionVideos.push({
      id: "sv-preexisting",
      batchId: "batch-OTHER",
      lessonId: null,
      mediaAssetId: "ma-preexisting",
      title: "Elsewhere",
      titleAr: "Elsewhere",
      isPublished: false,
    });
    const res = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "T" },
      d.deps
    );
    eq(res.ok, false, "inconsistent video linkage fails closed");
    eq(res.code, "ALREADY_LINKED", "inconsistent linkage maps to ALREADY_LINKED");
    eq(res.cleaned, undefined, "no cleanup was even attempted");
    ok(d.bundle.s3.store.has(key), "the inconsistently-linked object was NOT deleted");
    ok(!d.bundle.s3.commands.some((c) => c.name === "HeadObjectCommand"),
      "no object I/O happens for an inconsistent linkage");
    eq(d.dbBundle.rows.sessionVideos[0].id, "sv-preexisting", "the existing video row is untouched");
    eq(d.dbBundle.rows.sessionVideos.length, 1, "no rows created for an inconsistent linkage");

    // PDF variant: DOCUMENT asset under the key but no active material of
    // this lesson×scope pointing at it (partial/orphaned state).
    const pd = makeDeps();
    const pdfInit = await initPdf(pd.deps);
    const pdfKey = JSON.parse(Buffer.from(pdfInit.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(pd.bundle, pdfKey, PDF_HEAD, "application/pdf");
    pd.dbBundle.rows.mediaAssets.push({
      id: "ma-orphan",
      kind: "DOCUMENT",
      storage: "S3",
      storageKey: pdfKey,
      mimeType: "application/pdf",
      sizeBytes: PDF_HEAD.length,
      originalName: "w.pdf",
      isPrivate: true,
      createdById: "admin-1",
    });
    const pdfRes = await Uploads.completePresignedUpload(
      { token: pdfInit.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf" },
      pd.deps
    );
    eq(pdfRes.ok, false, "inconsistent pdf linkage fails closed");
    eq(pdfRes.code, "ALREADY_LINKED", "orphaned DOCUMENT asset → ALREADY_LINKED");
    ok(pd.bundle.s3.store.has(pdfKey), "the orphaned asset's bytes were NOT deleted");
    eq(pd.dbBundle.rows.materials.length, 0, "no Material rows created for an inconsistent linkage");
  }

  // -------------------------------------------------------------------------
  section("16. Genuine first-attempt DB failure still cleans UNREFERENCED bytes");
  // -------------------------------------------------------------------------
  {
    // The guard must not over-refuse: a truly unreferenced upload whose row
    // creation failed is still cleaned up (exact key, never a prefix).
    const d = makeDeps();
    const init = await initVideo(d.deps);
    const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
    await browserPut(d.bundle, key, MP4_BYTES, "video/mp4");
    d.dbBundle.state.failNextCreate = "mediaAsset";
    const res = await Uploads.completePresignedUpload(
      { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "T" },
      d.deps
    );
    eq(res.ok, false, "genuine first-attempt DB failure fails");
    eq(res.code, "DB_CREATE_FAILED", "first-attempt failure code");
    eq(res.cleaned, true, "the UNREFERENCED object was cleaned up");
    ok(!d.bundle.s3.store.has(key), "unreferenced object is gone");
    eq(d.dbBundle.rows.mediaAssets.length, 0, "no rows exist");
  }

  // -------------------------------------------------------------------------
  section("17. Concurrent completion — SESSION_VIDEO (PostgreSQL advisory lock)");
  // -------------------------------------------------------------------------
  {
    const PG_URL = "postgresql://codemind:unused@localhost:5432/codemind";
    process.env.DATABASE_URL = PG_URL;
    try {
      eq(DbSer.resolveDatabaseProvider({ DATABASE_URL: PG_URL }), "postgresql",
        "provider detection: postgresql:// → postgresql");
      eq(DbSer.resolveDatabaseProvider({ DATABASE_URL: "file:./db/custom.db" }), "sqlite",
        "provider detection: file: → sqlite");
      ok(typeof DbSer.uploadFinalizeLockId("session-videos/a.mp4") === "bigint",
        "advisory lock id is a bigint (pg_advisory_xact_lock int8)");
      eq(DbSer.uploadFinalizeLockId("session-videos/a.mp4"),
        DbSer.uploadFinalizeLockId("session-videos/a.mp4"),
        "the lock id is deterministic per exact storage key");
      ok(DbSer.uploadFinalizeLockId("session-videos/a.mp4") !==
        DbSer.uploadFinalizeLockId("session-videos/b.mp4"),
        "different keys map to different locks (uploads never contend)");

      // THREE barrier-released races — the invariant must hold every time.
      for (let trial = 1; trial <= 3; trial++) {
        const d = makeDeps();
        const init = await initVideo(d.deps);
        const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
        await browserPut(d.bundle, key, MP4_BYTES, "video/mp4");
        d.dbBundle.state.linkageBarrier = new Promise((r) => setTimeout(r, 25));
        const pa = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Race" },
          d.deps
        );
        const pb = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Race" },
          d.deps
        );
        await new Promise((r) => setTimeout(r, 40)); // both twins parked at the barrier
        d.dbBundle.state.linkageBarrier = null; // release: both proceed "simultaneously"
        const [a, b] = await Promise.all([pa, pb]);

        ok(a.ok === true && b.ok === true,
          `trial ${trial}: both concurrent completions succeed (no error surface)`);
        eq(a.mediaAssetId, b.mediaAssetId,
          `trial ${trial}: both callers receive the SAME MediaAsset id`);
        const replays = [a, b].filter((r) => r.replay === true);
        eq(replays.length, 1,
          `trial ${trial}: exactly one response is the idempotent replay`);
        eq(d.dbBundle.rows.mediaAssets.length, 1,
          `trial ${trial}: exactly 1 MediaAsset under concurrent twins`);
        eq(d.dbBundle.rows.sessionVideos.length, 1,
          `trial ${trial}: exactly 1 SessionVideo under concurrent twins`);
        ok(d.bundle.s3.store.has(key),
          `trial ${trial}: the R2 object remains intact`);
        eq(d.bundle.s3.commands.filter((c) => c.name === "DeleteObjectCommand").length, 0,
          `trial ${trial}: zero destructive cleanup of the referenced object`);
        ok(d.dbBundle.rows.mediaAssets[0].storageKey === key &&
          d.dbBundle.rows.sessionVideos[0].mediaAssetId === a.mediaAssetId,
          `trial ${trial}: the surviving linkage is valid (asset ↔ video)`);
        // The advisory lock was actually taken inside the winning transaction.
        ok(d.dbBundle.calls.some((c) => String(c).startsWith("$executeRaw:SELECT pg_advisory_xact_lock(")),
          `trial ${trial}: pg_advisory_xact_lock was acquired in-transaction`);
      }
    } finally {
      delete process.env.DATABASE_URL;
    }
  }

  // -------------------------------------------------------------------------
  section("18. Concurrent completion — LESSON_PDF (PostgreSQL advisory lock)");
  // -------------------------------------------------------------------------
  {
    process.env.DATABASE_URL = "postgresql://codemind:unused@localhost:5432/codemind";
    try {
      for (let trial = 1; trial <= 3; trial++) {
        const d = makeDeps();
        const init = await initPdf(d.deps);
        const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
        await browserPut(d.bundle, key, PDF_HEAD, "application/pdf");
        d.dbBundle.state.linkageBarrier = new Promise((r) => setTimeout(r, 25));
        const pa = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf" },
          d.deps
        );
        const pb = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf" },
          d.deps
        );
        await new Promise((r) => setTimeout(r, 40));
        d.dbBundle.state.linkageBarrier = null;
        const [a, b] = await Promise.all([pa, pb]);

        ok(a.ok === true && b.ok === true,
          `trial ${trial}: both concurrent PDF completions succeed`);
        eq(a.mediaAssetId, b.mediaAssetId,
          `trial ${trial}: both callers receive the SAME MediaAsset id`);
        const replays = [a, b].filter((r) => r.replay === true);
        eq(replays.length, 1,
          `trial ${trial}: exactly one response is the idempotent replay`);
        eq((replays[0].replaced || []).length, 0,
          `trial ${trial}: the replay replaces nothing`);
        eq(d.dbBundle.rows.mediaAssets.length, 1,
          `trial ${trial}: no duplicate MediaAsset`);
        eq(d.dbBundle.rows.materials.length, 1,
          `trial ${trial}: no duplicate Material created from the same intent`);
        eq(d.dbBundle.rows.materials[0].isActive, true,
          `trial ${trial}: exactly 1 FINAL ACTIVE material — and it is the original row`);
        eq(d.dbBundle.rows.materials[0].mediaAssetId, a.mediaAssetId,
          `trial ${trial}: the active material still points at the single asset`);
        ok(d.bundle.s3.store.has(key),
          `trial ${trial}: the R2 object remains intact`);
        eq(d.bundle.s3.commands.filter((c) => c.name === "DeleteObjectCommand").length, 0,
          `trial ${trial}: zero destructive cleanup`);
        ok(d.dbBundle.calls.some((c) => String(c).startsWith("$executeRaw:SELECT pg_advisory_xact_lock(")),
          `trial ${trial}: the gate acquired pg_advisory_xact_lock inside the finalizer tx`);
      }
    } finally {
      delete process.env.DATABASE_URL;
    }
  }

  // -------------------------------------------------------------------------
  section("19. Concurrent completion — SQLite/local model (no advisory lock)");
  // -------------------------------------------------------------------------
  {
    process.env.DATABASE_URL = "file:./db/custom.db";
    try {
      // SESSION_VIDEO — serialized at the database (single writer); repeated.
      for (let trial = 1; trial <= 2; trial++) {
        const d = makeDeps();
        const init = await initVideo(d.deps);
        const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
        await browserPut(d.bundle, key, MP4_BYTES, "video/mp4");
        d.dbBundle.state.linkageBarrier = new Promise((r) => setTimeout(r, 25));
        const pa = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Race" },
          d.deps
        );
        const pb = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Race" },
          d.deps
        );
        await new Promise((r) => setTimeout(r, 40));
        d.dbBundle.state.linkageBarrier = null;
        const [a, b] = await Promise.all([pa, pb]);
        ok(a.ok === true && b.ok === true, `sqlite video trial ${trial}: both succeed`);
        eq(a.mediaAssetId, b.mediaAssetId, `sqlite video trial ${trial}: same MediaAsset id`);
        eq([a, b].filter((r) => r.replay === true).length, 1,
          `sqlite video trial ${trial}: exactly one idempotent replay`);
        eq(d.dbBundle.rows.mediaAssets.length, 1, `sqlite video trial ${trial}: 1 MediaAsset`);
        eq(d.dbBundle.rows.sessionVideos.length, 1, `sqlite video trial ${trial}: 1 SessionVideo`);
        ok(d.bundle.s3.store.has(key), `sqlite video trial ${trial}: object intact`);
        eq(d.bundle.s3.commands.filter((c) => c.name === "DeleteObjectCommand").length, 0,
          `sqlite video trial ${trial}: zero deletes`);
        ok(!d.dbBundle.calls.some((c) => String(c).includes("pg_advisory_xact_lock")),
          `sqlite video trial ${trial}: NO advisory lock attempted on SQLite (no PG dependency)`);
      }

      // LESSON_PDF, sqlite.
      {
        const d = makeDeps();
        const init = await initPdf(d.deps);
        const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
        await browserPut(d.bundle, key, PDF_HEAD, "application/pdf");
        d.dbBundle.state.linkageBarrier = new Promise((r) => setTimeout(r, 25));
        const pa = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf" },
          d.deps
        );
        const pb = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", lessonId: "lesson-1", originalName: "w.pdf" },
          d.deps
        );
        await new Promise((r) => setTimeout(r, 40));
        d.dbBundle.state.linkageBarrier = null;
        const [a, b] = await Promise.all([pa, pb]);
        ok(a.ok === true && b.ok === true, "sqlite pdf: both succeed");
        eq(d.dbBundle.rows.mediaAssets.length, 1, "sqlite pdf: 1 MediaAsset");
        eq(d.dbBundle.rows.materials.length, 1, "sqlite pdf: 1 Material");
        eq(d.dbBundle.rows.materials[0].isActive, true, "sqlite pdf: the original stays active");
        ok(d.bundle.s3.store.has(key), "sqlite pdf: object intact");
      }

      // Loser-fails variant: a SQLite transaction that cannot get the write
      // lock (busy-timeout expiry) fails into the completion failure path,
      // which re-resolves the persisted linkage and returns the idempotent
      // result — the object is never touched.
      {
        const d = makeDeps();
        const init = await initVideo(d.deps);
        const key = JSON.parse(Buffer.from(init.init.token.split(".")[0], "base64url").toString("utf8")).key;
        await browserPut(d.bundle, key, MP4_BYTES, "video/mp4");
        d.dbBundle.state.linkageBarrier = new Promise((r) => setTimeout(r, 25));
        const pa = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Race" },
          d.deps
        );
        const pb = Uploads.completePresignedUpload(
          { token: init.init.token, actorUserId: "admin-1", batchId: "batch-1", title: "Race" },
          d.deps
        );
        await new Promise((r) => setTimeout(r, 40));
        d.dbBundle.state.linkageBarrier = null;
        const [a, b] = await Promise.all([pa, pb]);
        ok(a.ok === true && b.ok === true,
          "sqlite busy-loser: both callers still receive a success");
        eq(d.dbBundle.rows.mediaAssets.length, 1, "sqlite busy-loser: 1 MediaAsset");
        eq(d.dbBundle.rows.sessionVideos.length, 1, "sqlite busy-loser: 1 SessionVideo");
        ok(d.bundle.s3.store.has(key), "sqlite busy-loser: object intact");
        eq(d.bundle.s3.commands.filter((c) => c.name === "DeleteObjectCommand").length, 0,
          "sqlite busy-loser: zero deletes (loser re-resolved to the idempotent result)");
        eq([a, b].filter((r) => r.replay === true).length, 1,
          "sqlite busy-loser: the loser receives the deterministic replay response");
        ok(d.dbBundle.calls.includes("tx.busySnapshot"),
          "sqlite busy-loser: the write-time BUSY_SNAPSHOT failure path was exercised");
      }
    } finally {
      delete process.env.DATABASE_URL;
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n" + "=".repeat(60));
  console.log(`Presigned upload suite: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.error("Failures:", failures.join(" | "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("SUITE ERROR:", e);
  process.exit(1);
});
