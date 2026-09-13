// CodeMind Academy — R2 (S3-compatible) storage backend suite (offline).
//
// Proves, WITHOUT contacting real R2 and WITHOUT any real credential:
//   1.  Backend selector: local stays the default; s3 is accepted; anything
//       else fails closed (never silently degrades to local).
//   2.  S3StorageBackend implements the full StorageBackend contract against
//       a fake S3 client injected at the backend boundary:
//         write / read / missing-object / stat / delete / sha256 /
//         full stream / valid range / open-ended ranges / end clamping /
//         invalid ranges / service-error propagation.
//   3.  Range semantics are byte-for-byte identical to LocalStorageBackend
//       (same resolution, same RangeError messages — shared implementation).
//   4.  Not-found parity: S3 NoSuchKey/404 maps to the SAME behaviour the
//       local backend exposes (ENOENT-coded rejection on read/sha256, null
//       on stat/readStream, idempotent delete). 403 is NEVER mapped away.
//   5.  No credential exposure: R2 vars referenced only server-side in
//       src/lib/media-s3.ts, no NEXT_PUBLIC_* R2 vars anywhere, .env.example
//       carries names-only, and config errors never echo secret values.
//   6.  The local backend + public helpers remain green and the default.
//
// Every behavioural assertion runs against an in-memory fake client
// (S3ClientLike). The only REAL S3Client ever constructed here points at
// 127.0.0.1:9, is built but NEVER sent — zero R2 requests, zero credentials.
//
// Run: node tests/s3-storage-r2.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-s3-r2-test-"));
const BUCKET = "codemind-academy-media";

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
function section(t) {
  console.log(`\n${t}`);
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// Compile the storage modules (same pattern as the Phase 14 suite)
// ---------------------------------------------------------------------------
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
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
      },
      files: [
        path.join(REPO, "src/lib/media.ts"),
        path.join(REPO, "src/lib/media-s3.ts"),
      ],
    },
    null,
    2
  )
);
// Windows portability: a shell-free execFileSync("npx", …) cannot resolve
// npx.cmd (PATHEXT is a cmd.exe concept; without a shell, Node's CreateProcess
// lookup finds no extension-less "npx") → ENOENT. Invoke the repo-local
// TypeScript CLI directly instead: same Node binary (process.execPath),
// exact installed tsc, no shell, no PATH lookup, no npx. Same deterministic
// pattern as tests/quiz-analytics.test.js.
execFileSync(
  process.execPath,
  [
    path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"),
    "-p",
    path.join(OUT, "tsconfig.json"),
  ],
  {
    cwd: REPO,
    stdio: "pipe",
  }
);
const EMIT = path.join(OUT, "src", "lib");

// The emitted JS lives in a temp dir, so bare imports (the AWS SDK and its
// @smithy/* transitive deps) must resolve against the REPO's node_modules.
const Module = require("node:module");
const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  try {
    return originalResolveFilename.call(this, request, ...args);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};

// A scratch MEDIA_ROOT for the local backend — set BEFORE require(media.js),
// which captures MEDIA_STORAGE_PATH at module load.
const LOCAL_ROOT = path.join(OUT, "local-media");
process.env.MEDIA_STORAGE_PATH = LOCAL_ROOT;
delete process.env.MEDIA_BACKEND;

const Media = require(path.join(EMIT, "media.js"));
const MediaS3 = require(path.join(EMIT, "media-s3.js"));
const { S3StorageBackend, resolveR2Config } = MediaS3;

// Empirical NO-NETWORK proof for the in-process suite: any attempt to open a
// TCP socket from this process fails loudly. (The Section 11 subprocess
// probes run in separate processes and intentionally talk to 127.0.0.1:9
// only.) This guarantees no R2 host — or any host — is ever contacted here.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(
      `s3-storage-r2 test made a network connection attempt: ${JSON.stringify(args[0])}`
    );
  };
  process.on("exit", () => {
    net.Socket.prototype.connect = realConnect;
  });
}

// ---------------------------------------------------------------------------
// Fake S3 client — the test boundary. An in-memory bucket keyed by object
// key, recording every command so tests can assert exactly what the backend
// would have sent to R2.
// ---------------------------------------------------------------------------
function s3NotFound(name = "NoSuchKey", status = 404) {
  const e = new Error(`fake R2 ${name}`);
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
}
function makeFakeS3() {
  const store = new Map(); // key -> { body, contentType, lastModified }
  const calls = [];
  let failNext = null;
  const client = {
    failWith(err) {
      failNext = err;
    },
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      calls.push({ name, input });
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      switch (name) {
        case "PutObjectCommand": {
          store.set(input.Key, {
            body: Buffer.from(input.Body),
            contentType: input.ContentType ?? null,
            lastModified: new Date(),
          });
          return { ETag: '"fake"' };
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
        case "HeadObjectCommand": {
          const obj = store.get(input.Key);
          if (!obj) throw s3NotFound("NotFound");
          return { ContentLength: obj.body.length, LastModified: obj.lastModified };
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
  return { client, store, calls };
}
function makeBackend() {
  const fake = makeFakeS3();
  const backend = new S3StorageBackend({ client: fake.client, bucket: BUCKET });
  return { backend, fake };
}
async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}
async function throws(fn, type, label) {
  try {
    await fn();
    ok(false, `${label} — expected ${type ? type.name : "error"}, got success`);
    return null;
  } catch (e) {
    ok(!type || e instanceof type, `${label} — threw ${type ? type.name : "error"}`);
    return e;
  }
}

async function main() {
  // -------------------------------------------------------------------------
  section("1. Backend selector — local default, s3 accepted, else fail closed");
  // -------------------------------------------------------------------------
  {
    eq(Array.from(Media.SUPPORTED_STORAGE_BACKENDS), ["local", "s3"],
      "SUPPORTED_STORAGE_BACKENDS is exactly [local, s3]");
    eq(Media.resolveStorageBackendName({}), "local", "unset MEDIA_BACKEND → local (default preserved)");
    eq(Media.resolveStorageBackendName({ MEDIA_BACKEND: "" }), "local", "empty MEDIA_BACKEND → local");
    eq(Media.resolveStorageBackendName({ MEDIA_BACKEND: "local" }), "local", "explicit local");
    eq(Media.resolveStorageBackendName({ MEDIA_BACKEND: "s3" }), "s3", "s3 accepted");
    eq(Media.resolveStorageBackendName({ MEDIA_BACKEND: " S3 " }), "s3", "s3 case/whitespace-insensitive");
    for (const bad of ["azure", "gcs", "minio", "filesystem", "azure-blob"]) {
      const e = await throws(
        async () => Media.resolveStorageBackendName({ MEDIA_BACKEND: bad }),
        Error,
        `MEDIA_BACKEND="${bad}" fails closed`
      );
      ok(/Refusing to fall/.test(String(e && e.message)),
        `MEDIA_BACKEND="${bad}" error refuses silent local fallback`);
      ok(/local, s3/.test(String(e && e.message)),
        `MEDIA_BACKEND="${bad}" error lists supported backends`);
    }
    // Invalid names must never construct a backend.
    await throws(() => Media.createStorageBackend("azure"), Error,
      "createStorageBackend rejects unknown names");
  }

  // -------------------------------------------------------------------------
  section("2. R2 configuration — server env only, fail closed, no secret echo");
  // -------------------------------------------------------------------------
  {
    const SECRET_SENTINEL = "wJalrXUtnFEMI-K7MDENG-bPxRfiCY-SECRET-SENTINEL";
    const full = {
      R2_ACCOUNT_ID: "abc123account",
      R2_ACCESS_KEY_ID: "fake-access-key-id",
      R2_SECRET_ACCESS_KEY: SECRET_SENTINEL,
      R2_BUCKET: BUCKET,
    };
    const cfg = resolveR2Config(full);
    eq(cfg.endpoint, "https://abc123account.r2.cloudflarestorage.com",
      "endpoint derived from R2_ACCOUNT_ID when R2_S3_ENDPOINT unset");
    eq(cfg.region, "auto", "region defaults to R2's 'auto'");
    eq(cfg.bucket, BUCKET, "bucket from R2_BUCKET");
    const cfg2 = resolveR2Config({ ...full, R2_REGION: "eu-west-1", R2_S3_ENDPOINT: "https://custom.example/s3" });
    eq(cfg2.endpoint, "https://custom.example/s3", "R2_S3_ENDPOINT override honoured");
    eq(cfg2.region, "eu-west-1", "R2_REGION override honoured");

    // Fail closed on each missing/empty required variable.
    for (const drop of MediaS3.REQUIRED_R2_ENV_VARS) {
      const env = { ...full };
      delete env[drop];
      const e = await throws(async () => resolveR2Config(env), Error,
        `missing ${drop} fails closed`);
      ok(e.message.includes(drop), `missing-var error names ${drop}`);
      ok(!e.message.includes(SECRET_SENTINEL),
        `missing-var error never echoes secret values (dropping ${drop})`);
      ok(/server-side env vars/.test(e.message), "error explains server-side requirement");
    }
    const eEmpty = await throws(
      async () => resolveR2Config({ ...full, R2_SECRET_ACCESS_KEY: "   " }),
      Error, "blank R2_SECRET_ACCESS_KEY fails closed");
    ok(eEmpty.message.includes("R2_SECRET_ACCESS_KEY"), "blank-secret error names the variable");
    ok(!eEmpty.message.includes(SECRET_SENTINEL), "blank-secret error does not echo the value");
    eq(Array.from(MediaS3.REQUIRED_R2_ENV_VARS),
      ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"],
      "required R2 env contract");
  }

  // -------------------------------------------------------------------------
  section("3. Backend construction — s3 via selector, fail-closed missing creds");
  // -------------------------------------------------------------------------
  {
    // Real S3Client construction, pointed at an unroutable local endpoint and
    // NEVER sent: constructing performs no network I/O.
    process.env.MEDIA_BACKEND = "s3";
    process.env.R2_ACCOUNT_ID = "test-account";
    process.env.R2_ACCESS_KEY_ID = "test-access-key";
    process.env.R2_SECRET_ACCESS_KEY = "test-secret-key";
    process.env.R2_BUCKET = BUCKET;
    process.env.R2_S3_ENDPOINT = "http://127.0.0.1:9";
    const s3 = await Media.createStorageBackend("s3");
    eq(s3.name, "s3", "createStorageBackend('s3') returns the S3 backend");
    ok(s3 instanceof S3StorageBackend, "instance is S3StorageBackend");

    delete process.env.R2_SECRET_ACCESS_KEY;
    const e = await throws(() => Media.createStorageBackend("s3"), Error,
      "s3 without credentials fails closed at construction");
    ok(/R2_SECRET_ACCESS_KEY/.test(e.message), "construction error names the missing variable");
    ok(!e.message.includes("test-secret-key"), "construction error does not echo any secret");
    delete process.env.MEDIA_BACKEND;
    delete process.env.R2_ACCOUNT_ID;
    delete process.env.R2_ACCESS_KEY_ID;
    delete process.env.R2_BUCKET;
    delete process.env.R2_S3_ENDPOINT;

    // Default path stays local.
    const local = await Media.createStorageBackend();
    eq(local.name, "local", "default backend remains local");
    ok(local instanceof Media.LocalStorageBackend, "default instance is LocalStorageBackend");
  }

  // -------------------------------------------------------------------------
  section("4. write / read / delete / stat against the fake R2");
  // -------------------------------------------------------------------------
  {
    const { backend, fake } = makeBackend();
    const key = "sessions/video-abc123.mp4";
    const bytes = crypto.randomBytes(4096);

    const wrote = await backend.write(key, bytes, { mimeType: "video/mp4" });
    eq(wrote, key, "write returns the storage key");
    eq(fake.calls[0].name, "PutObjectCommand", "write sends PutObjectCommand");
    eq(fake.calls[0].input.Bucket, BUCKET, "write targets the configured bucket");
    eq(fake.calls[0].input.Key, key, "write uses the key verbatim");
    eq(fake.calls[0].input.ContentType, "video/mp4", "mimeType persisted as ContentType");
    ok(!Buffer.compare(Buffer.from(fake.calls[0].input.Body), bytes), "bytes persisted intact");
    ok(!("ACL" in fake.calls[0].input), "no ACL — object stays private");

    const readBack = await backend.read(key);
    eq(readBack.toString("hex"), bytes.toString("hex"), "read returns the exact bytes");
    eq(fake.calls[1].name, "GetObjectCommand", "read sends GetObjectCommand");
    eq(fake.calls[1].input.Bucket, BUCKET, "read targets the configured bucket");

    // Uint8Array input parity.
    await backend.write("u8.bin", new Uint8Array([1, 2, 3]));
    eq((await backend.read("u8.bin")).length, 3, "write accepts Uint8Array");

    const st = await backend.stat(key);
    eq(st.size, 4096, "stat reports size");
    ok(st.lastModified instanceof Date, "stat reports lastModified");
    eq(fake.calls.find((c) => c.name === "HeadObjectCommand").input.Key, key,
      "stat sends HeadObjectCommand");

    await backend.delete(key);
    ok(!fake.store.has(key), "delete removes the object");
    await backend.delete(key); // idempotent
    ok(true, "delete is idempotent (second delete resolves)");
  }

  // -------------------------------------------------------------------------
  section("5. Missing-object parity with the local backend");
  // -------------------------------------------------------------------------
  {
    const { backend, fake } = makeBackend();
    const ghost = "sessions/ghost.mp4";

    const eRead = await throws(() => backend.read(ghost), Error, "read(missing) rejects");
    eq(eRead.code, "ENOENT", "read(missing) error carries code ENOENT (local parity)");
    eq(fake.calls.at(-1).name, "GetObjectCommand", "read miss surfaced after GetObject");

    eq(await backend.stat(ghost), null, "stat(missing) → null (local parity)");
    eq(await backend.readStream(ghost), null, "readStream(missing) → null (local parity)");

    const eHash = await throws(() => backend.sha256(ghost), Error, "sha256(missing) rejects");
    eq(eHash.code, "ENOENT", "sha256(missing) error carries code ENOENT");

    await backend.delete(ghost);
    ok(true, "delete(missing) resolves (idempotent, local parity)");

    // The local backend must expose the same shapes (ground truth check).
    const local = new Media.LocalStorageBackend(path.join(OUT, "local-parity"));
    const eLocal = await throws(() => local.read("nope.bin"), Error, "local read(missing) rejects");
    eq(eLocal.code, "ENOENT", "local read(missing) also ENOENT — parity confirmed");
    eq(await local.stat("nope.bin"), null, "local stat(missing) → null");
    eq(await local.readStream("nope.bin"), null, "local readStream(missing) → null");
  }

  // -------------------------------------------------------------------------
  section("6. sha256 — streamed, exact");
  // -------------------------------------------------------------------------
  {
    const { backend, fake } = makeBackend();
    const payload = crypto.randomBytes(256 * 1024);
    const want = crypto.createHash("sha256").update(payload).digest("hex");
    await backend.write("big/video.mp4", payload, { mimeType: "video/mp4" });

    // Force the GET body to arrive in many small chunks — the hash must
    // stream through update() rather than buffering one blob.
    const chunked = [];
    for (let i = 0; i < payload.length; i += 16384) chunked.push(payload.subarray(i, i + 16384));
    fake.store.get("big/video.mp4").chunked = chunked;
    const origSend = fake.client.send.bind(fake.client);
    fake.client.send = async (cmd) => {
      const out = await origSend(cmd);
      if (cmd.constructor.name === "GetObjectCommand" && out.Body) {
        const obj = fake.store.get(cmd.input.Key);
        if (obj && obj.chunked) out.Body = Readable.from(obj.chunked.map((c) => Buffer.from(c)));
      }
      return out;
    };

    eq(await backend.sha256("big/video.mp4"), want, "sha256 matches over a chunked stream");
    eq(await backend.sha256("big/video.mp4"), want, "sha256 deterministic on repeat");

    // Empty object hashes cleanly too.
    await backend.write("empty.bin", Buffer.alloc(0));
    eq(
      await backend.sha256("empty.bin"),
      crypto.createHash("sha256").update(Buffer.alloc(0)).digest("hex"),
      "sha256 of empty object"
    );
  }

  // -------------------------------------------------------------------------
  section("7. Streaming reads — full, ranges, clamping, invalid");
  // -------------------------------------------------------------------------
  {
    const { backend, fake } = makeBackend();
    const payload = Buffer.from("0123456789".repeat(6)); // 60 bytes
    const key = "sessions/stream.mp4";
    await backend.write(key, payload, { mimeType: "video/mp4" });

    // Full stream: no Range header may be sent.
    const full = await backend.readStream(key);
    eq(fake.calls.at(-1).input.Range, undefined, "full stream sends no Range header");
    eq(full.size, 60, "full stream: total size");
    eq(full.start, 0, "full stream: start 0");
    eq(full.end, 59, "full stream: end is last byte");
    eq(full.contentLength, 60, "full stream: contentLength = size");
    eq((await collect(full.stream)).toString("latin1"), payload.toString("latin1"),
      "full stream bytes intact");

    // Valid inclusive range.
    const r1 = await backend.readStream(key, { start: 2, end: 5 });
    eq(fake.calls.at(-1).input.Range, "bytes=2-5", "range request sends inclusive Range header");
    eq([r1.start, r1.end, r1.contentLength, r1.size], [2, 5, 4, 60],
      "valid range: start/end/contentLength/size");
    eq((await collect(r1.stream)).toString("latin1"), "2345", "valid range bytes");

    // Open-ended start ("to end 3").
    const r2 = await backend.readStream(key, { end: 3 });
    eq([r2.start, r2.end, r2.contentLength], [0, 3, 4], "open-ended start resolves to 0..end");
    eq(fake.calls.at(-1).input.Range, "bytes=0-3", "open-ended start Range header");

    // Open-ended end ("from 54").
    const r3 = await backend.readStream(key, { start: 54 });
    eq([r3.start, r3.end, r3.contentLength], [54, 59, 6], "open-ended end resolves to start..EOF");
    eq(fake.calls.at(-1).input.Range, "bytes=54-59", "open-ended end Range header");

    // End past EOF is CLAMPED (S3 semantics preserved).
    const r4 = await backend.readStream(key, { start: 0, end: 9999 });
    eq([r4.start, r4.end, r4.contentLength], [0, 59, 60], "end past EOF clamped to last byte");
    eq(fake.calls.at(-1).input.Range, undefined,
      "clamp resolving to the full object sends no Range header (full GET)");
    // Clamped but still partial → ranged GET with the clamped bound.
    const r4b = await backend.readStream(key, { start: 10, end: 9999 });
    eq([r4b.start, r4b.end, r4b.contentLength], [10, 59, 50], "partial clamp bookkeeping");
    eq(fake.calls.at(-1).input.Range, "bytes=10-59", "partial clamp sends clamped Range header");

    // Explicit full bounds behave like the full object.
    const r5 = await backend.readStream(key, { start: 0, end: 59 });
    eq([r5.start, r5.end, r5.contentLength], [0, 59, 60], "explicit full bounds");
    eq(fake.calls.at(-1).input.Range, undefined, "explicit full bounds send no Range header");

    // Single last byte.
    const r6 = await backend.readStream(key, { start: 59, end: 59 });
    eq([r6.start, r6.end, r6.contentLength], [59, 59, 1], "single last byte");
    eq((await collect(r6.stream)).toString("latin1"), "9", "last byte content");

    // Empty object: full read fine, any range refused.
    await backend.write("empty.bin", Buffer.alloc(0));
    const re = await backend.readStream("empty.bin");
    eq([re.size, re.start, re.end, re.contentLength], [0, 0, -1, 0],
      "empty object full stream bookkeeping");
    eq((await collect(re.stream)).length, 0, "empty object full stream has no bytes");
    await throws(() => backend.readStream("empty.bin", { start: 0 }), RangeError,
      "any range on empty object refused");

    // Invalid / unsatisfiable ranges.
    await throws(() => backend.readStream(key, { start: 60 }), RangeError,
      "start at EOF refused");
    await throws(() => backend.readStream(key, { start: 61 }), RangeError,
      "start past EOF refused");
    await throws(() => backend.readStream(key, { start: 50, end: 10 }), RangeError,
      "start > end refused");
    await throws(() => backend.readStream(key, { start: -1 }), RangeError,
      "negative start refused");
    await throws(() => backend.readStream(key, { end: -1 }), RangeError,
      "negative end refused");
    await throws(() => backend.readStream(key, { start: NaN }), RangeError,
      "NaN start refused");
    await throws(() => backend.readStream(key, { start: 1.5 }), RangeError,
      "fractional start refused");
  }

  // -------------------------------------------------------------------------
  section("8. Range parity matrix — S3 backend ≡ local backend");
  // -------------------------------------------------------------------------
  {
    const payload = Buffer.from("ABCDEFGHIJKLMNOPQRSTUVWXYZ"); // 26 bytes
    const { backend } = makeBackend();
    const localRoot = path.join(OUT, "range-parity");
    const local = new Media.LocalStorageBackend(localRoot);
    const key = "parity/object.bin";
    await backend.write(key, payload);
    await local.write(key, payload);

    const cases = [
      undefined, {}, { start: 0 }, { end: 4 }, { start: 21 },
      { start: 3, end: 9 }, { start: 0, end: 25 }, { start: 3, end: 999 },
      { start: 25, end: 25 },
    ];
    for (const range of cases) {
      const s3r = await backend.readStream(key, range);
      const loc = await local.readStream(key, range);
      const label = `range ${JSON.stringify(range)}`;
      eq(
        [s3r.start, s3r.end, s3r.contentLength, s3r.size, (await collect(s3r.stream)).toString("latin1")],
        [loc.start, loc.end, loc.contentLength, loc.size, (await collect(loc.stream)).toString("latin1")],
        `${label}: identical bytes + bookkeeping`
      );
    }
    const bad = [
      { start: 26 }, { start: 99 }, { start: 20, end: 1 },
      { start: -4 }, { end: -4 }, { start: NaN }, { start: 2 ** 53 },
    ];
    for (const range of bad) {
      let s3Err = null, localErr = null;
      try { await backend.readStream(key, range); } catch (e) { s3Err = e; }
      try { await local.readStream(key, range); } catch (e) { localErr = e; }
      const label = `invalid range ${JSON.stringify(range)}`;
      ok(s3Err instanceof RangeError && localErr instanceof RangeError, `${label}: both throw RangeError`);
      eq(String(s3Err && s3Err.message), String(localErr && localErr.message),
        `${label}: identical error message`);
    }
  }

  // -------------------------------------------------------------------------
  section("9. Service error propagation — nothing swallowed");
  // -------------------------------------------------------------------------
  {
    const { backend, fake } = makeBackend();
    await backend.write("ok.bin", Buffer.from("fine"));

    const mkServiceErr = (name) => {
      const e = new Error(`simulated ${name}`);
      e.name = name;
      e.$metadata = { httpStatusCode: 500 };
      return e;
    };
    const ops = {
      write: () => backend.write("err.bin", Buffer.from("x")),
      read: () => backend.read("err.bin"),
      stat: () => backend.stat("err.bin"),
      delete: () => backend.delete("err.bin"),
      sha256: () => backend.sha256("err.bin"),
      readStream: () => backend.readStream("err.bin"),
    };
    for (const [opName, op] of Object.entries(ops)) {
      const boom = mkServiceErr("InternalError");
      fake.client.failWith(boom);
      let caught = null;
      try { await op(); } catch (e) { caught = e; }
      ok(caught === boom, `${opName}: service error propagated verbatim (not swallowed)`);
    }
    // Auth/network-flavoured errors propagate too.
    const credErr = new Error("Could not load credentials");
    credErr.name = "CredentialsProviderError";
    fake.client.failWith(credErr);
    let caught = null;
    try { await backend.read("ok.bin"); } catch (e) { caught = e; }
    ok(caught === credErr, "credential errors propagate (never mapped to not-found)");

    // 403 is NOT absence — it must propagate, not become null/ENOENT.
    const forbidden = new Error("denied");
    forbidden.name = "Forbidden";
    forbidden.$metadata = { httpStatusCode: 403 };
    fake.client.failWith(forbidden);
    caught = null;
    try { await backend.readStream("ok.bin"); } catch (e) { caught = e; }
    ok(caught === forbidden, "403 propagates from readStream (not treated as missing)");
    fake.client.failWith(forbidden);
    caught = null;
    try { await backend.stat("ok.bin"); } catch (e) { caught = e; }
    ok(caught === forbidden, "403 propagates from stat (not treated as missing)");
    fake.client.failWith(forbidden);
    caught = null;
    try { await backend.read("ok.bin"); } catch (e) { caught = e; }
    ok(caught === forbidden && caught.code !== "ENOENT", "403 from read never becomes ENOENT");
  }

  // -------------------------------------------------------------------------
  section("10. Public helpers — local default stays wired and green");
  // -------------------------------------------------------------------------
  {
    // Helpers resolve the backend from process.env (MEDIA_BACKEND unset →
    // local). This is the historical path every caller still uses.
    eq(await Media.getStorageBackend().then((b) => b.name), "local",
      "getStorageBackend() default is local");
    const key = "helpers/roundtrip.pdf";
    const data = Buffer.from("%PDF-1.7 helper roundtrip");
    eq(await Media.writePrivateFile(key, data, { mimeType: "application/pdf" }), key,
      "writePrivateFile helper");
    eq((await Media.readPrivateFile(key)).toString(), data.toString(), "readPrivateFile helper");
    const st = await Media.privateFileStat(key);
    eq(st.size, data.length, "privateFileStat helper");
    eq(await Media.sha256PrivateFile(key), crypto.createHash("sha256").update(data).digest("hex"),
      "sha256PrivateFile helper");
    const rs = await Media.readPrivateFileStream(key, { start: 0, end: 4 });
    eq((await collect(rs.stream)).toString(), "%PDF-", "readPrivateFileStream helper range");
    await Media.deletePrivateFile(key);
    eq(await Media.privateFileStat(key), null, "deletePrivateFile helper");
  }

  // -------------------------------------------------------------------------
  section("11. Fail-closed subprocess checks (fresh process caches)");
  // -------------------------------------------------------------------------
  {
    const probe = (env) =>
      execFileSync(
        process.execPath,
        ["-e", `
          const M = require(${JSON.stringify(path.join(EMIT, "media.js"))});
          M.writePrivateFile("x/y.bin", Buffer.from("z"))
            .then(() => { console.log("RESOLVED"); })
            .catch((e) => { console.log("REJECTED:" + e.message); });
        `],
        {
          cwd: REPO,
          encoding: "utf8",
          // NODE_PATH lets the temp-dir emit resolve @aws-sdk/client-s3 from
          // the repo's node_modules in the fresh child process.
          env: { ...process.env, NODE_PATH: path.join(REPO, "node_modules"), ...env },
          timeout: 60000,
        }
      );

    const bogus = probe({ MEDIA_BACKEND: "azure-blob", MEDIA_STORAGE_PATH: LOCAL_ROOT });
    ok(/^REJECTED:.*not a supported storage backend/s.test(bogus),
      "fresh process: MEDIA_BACKEND=azure-blob fails closed on first write");

    const missingCreds = probe({
      MEDIA_BACKEND: "s3",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "ak",
      R2_SECRET_ACCESS_KEY: "", // empty → missing
      R2_BUCKET: BUCKET,
      MEDIA_STORAGE_PATH: LOCAL_ROOT,
    });
    ok(/^REJECTED:.*R2_SECRET_ACCESS_KEY/s.test(missingCreds),
      "fresh process: s3 without full credentials fails closed");
    ok(!fs.existsSync(path.join(LOCAL_ROOT, "x", "y.bin")),
      "fresh process: no local fallback write on s3 misconfiguration");

    const s3Constructs = probe({
      MEDIA_BACKEND: "s3",
      R2_ACCOUNT_ID: "acct",
      R2_ACCESS_KEY_ID: "ak",
      R2_SECRET_ACCESS_KEY: "sk",
      R2_BUCKET: BUCKET,
      R2_S3_ENDPOINT: "http://127.0.0.1:9",
      MEDIA_STORAGE_PATH: LOCAL_ROOT,
    });
    // The write ATTEMPTS the fake endpoint (127.0.0.1:9, nothing listening) —
    // proving the s3 path does not silently touch the local disk, and that no
    // real R2 host is ever contacted by this suite.
    ok(/^REJECTED/.test(s3Constructs), "fresh process: s3 write goes to the object store, not local disk");
    ok(!fs.existsSync(path.join(LOCAL_ROOT, "x", "y.bin")),
      "fresh process: no byte silently written to the local volume under s3");
  }

  // -------------------------------------------------------------------------
  section("12. Credential-exposure audit (static)");
  // -------------------------------------------------------------------------
  {
    // R2_* may only be referenced server-side, inside the s3 backend module.
    const grep = (dir) => {
      const hits = [];
      const walk = (d) => {
        for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
          if (entry.isDirectory()) walk(path.join(d, entry.name));
          else if (/\.(ts|tsx|js|jsx|mjs)$/.test(entry.name)) {
            const p = path.join(d, entry.name);
            const text = fs.readFileSync(p, "utf8");
            if (/R2_(ACCOUNT_ID|ACCESS_KEY_ID|SECRET_ACCESS_KEY|BUCKET|REGION|S3_ENDPOINT)/.test(text)) {
              hits.push(path.relative(REPO, p));
            }
          }
        }
      };
      walk(dir);
      return hits;
    };
    eq(grep(path.join(REPO, "src/app")), [], "no R2_* references in src/app (routes/pages)");
    eq(grep(path.join(REPO, "src/components")), [], "no R2_* references in client components");
    eq(grep(path.join(REPO, "src/lib")).sort(), ["src/lib/media-s3.ts"],
      "R2_* referenced ONLY in src/lib/media-s3.ts (server module)");

    // No NEXT_PUBLIC_* storage credential may exist anywhere in src/.
    const nextPublicHits = [];
    const walkAll = (d) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        if (entry.isDirectory()) walkAll(path.join(d, entry.name));
        else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          const text = fs.readFileSync(path.join(d, entry.name), "utf8");
          if (/NEXT_PUBLIC[A-Z0-9_]*(R2|AWS|S3)[A-Z0-9_]*/.test(text)) nextPublicHits.push(entry.name);
        }
      }
    };
    walkAll(path.join(REPO, "src"));
    eq(nextPublicHits, [], "no NEXT_PUBLIC_* R2/S3/AWS credential variables in src/");

    // .env.example: variable names only, empty values, no secrets.
    const envExample = read(".env.example");
    for (const v of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_REGION", "R2_S3_ENDPOINT"]) {
      ok(new RegExp(`^${v}=`, "m").test(envExample), `.env.example documents ${v}`);
    }
    const secretLine = envExample.split("\n").find((l) => l.startsWith("R2_SECRET_ACCESS_KEY="));
    eq(secretLine, 'R2_SECRET_ACCESS_KEY=""', ".env.example carries no real secret value");
    ok(!/[A-Za-z0-9+/]{30,}/.test(secretLine), "no long base64-ish blob on the secret line");
    ok(/MEDIA_BACKEND="local"/.test(envExample), ".env.example default backend remains local");
    ok(/s3/.test(envExample.split("\n").find((l) => /Supported values/.test(l)) || ""),
      ".env.example documents the s3 option");

    // No hardcoded credential-looking constants in the backend module.
    const s3src = read("src/lib/media-s3.ts");
    ok(!/AKIA[0-9A-Z]{16}/.test(s3src), "no AWS access-key literals in media-s3.ts");
    ok(!/cloudflarestorage\.com\/[a-f0-9]{32}/i.test(s3src), "no embedded account tokens");
    ok(!/s3-request-presigner|getSignedUrl/.test(s3src),
      "no signed-URL construction in the backend (no presigner import/calls)");
    ok(!/public-read/i.test(s3src), "no public ACL anywhere in the backend");
  }

  // -------------------------------------------------------------------------
  console.log(
    `\nS3/R2 storage backend suite: ${pass} passed, ${fail} failed`
  );
  if (fail > 0) {
    console.error("Failures:", failures.join(" | "));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("SUITE ERROR:", e);
  process.exit(1);
});
