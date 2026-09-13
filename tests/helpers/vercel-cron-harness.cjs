/* eslint-disable @typescript-eslint/no-require-imports -- plain-node harness, same convention as the other suites */
// CodeMind Academy — Phase 24: Vercel cron route + shared purge core harness
// (OFFLINE).
//
// Run by tests/vercel-cron-retention-phase24.test.js as a child process:
//
//   CM_REPO=<repo> CM_EMIT=<compiled src dir> CM_CASES=<comma list> \
//     [CM_MEDIA_ROOT=<scratch volume>] node tests/helpers/vercel-cron-harness.cjs
//
// It loads the SHIPPED route handler (compiled unmodified by the suite) and
// replaces exactly two boundaries:
//   * `pg` — a fake single-connection client. In A-cases it is inert; in
//     B-cases it is a tiny in-memory PostgreSQL for the exact SQL the shared
//     purge core issues (nothing else is answerable — any unexpected query
//     throws, so a scope creep fails loudly).
//   * `@/lib/evidence-retention` — in A-cases (auth/failure mapping) a stub
//     that records every call and returns a canned report or throws; in
//     B-cases (integration) the REAL shipped core is used.
//
// For the S3 integration cases the S3 boundary is swapped the same way the
// R2 wiring suite does it: the REAL S3StorageBackend around an in-memory fake
// client. No R2_* variable is ever set, so a broken injection fails closed
// instead of contacting a real bucket.
//
// GUARANTEES: zero network (any socket connect throws and is reported), zero
// credentials, deterministic. One `CASE_JSON` line per scenario.

const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = process.env.CM_REPO || path.resolve(__dirname, "..", "..");
const EMIT = process.env.CM_EMIT; // compiled `<out>/src`
const CASES = (process.env.CM_CASES || "").split(",").filter(Boolean);
const MEDIA_ROOT = process.env.CM_MEDIA_ROOT || path.join(os.tmpdir(), "cm-cron-harness-media");
if (!EMIT || !CASES.length) {
  console.error("harness: CM_EMIT and CM_CASES are required");
  process.exit(1);
}
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

const TEST_SECRET = "cm-test-cron-secret-0123456789abcdef";
const WRONG_SECRET = "cm-wrong-secret-value-0123456789abcdef";
const PG_URL = "postgresql://cm:cm@127.0.0.1:5432/codemind-harness";
const ROUTE_URL = "http://localhost/api/cron/purge-evidence";

// --- ZERO-NETWORK guard -----------------------------------------------------
const networkAttempts = [];
const realConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  networkAttempts.push(JSON.stringify(args[0]));
  throw new Error("vercel-cron harness attempted a network connection");
};
process.on("exit", () => {
  net.Socket.prototype.connect = realConnect;
});

// --- B-mode in-memory PostgreSQL (exact SQL the shared core issues) ---------
const pgState = { ops: [] };
function resetPgState(state) {
  pgState.ops = [];
  pgState.state = state;
  pgState.constructed = false;
  pgState.connected = false;
  pgState.ended = false;
}
function makePgStub() {
  return {
    Client: class {
      constructor(opts) {
        pgState.constructed = true;
        pgState.connectOpts = opts || null;
      }
      async connect() {
        if (pgState.connectThrow) {
          throw new Error("MARKER-connect-refused host=127.0.0.1:5432");
        }
        pgState.connected = true;
      }
      async end() {
        pgState.ended = true;
      }
      async query(sql, params = []) {
        const s = sql.replace(/\s+/g, " ").trim();
        pgState.ops.push(s);
        const st = pgState.state || {};
        if (s === "BEGIN" || s === "COMMIT" || s === "ROLLBACK") return { rows: [], rowCount: 0 };
        let m;
        if ((m = /^SELECT COUNT\(\*\) AS n FROM "([A-Za-z]+)"$/.exec(s))) {
          const t = m[1];
          if (t === "QuizAttemptEvidence") {
            return { rows: [{ n: st.evidence.length + (st.unstamped || 0) }] };
          }
          return { rows: [{ n: (st.protected[t] || []).length }] };
        }
        if (/^SELECT "id","attemptId","mediaAssetId","kind","retainUntil" FROM "QuizAttemptEvidence" WHERE "retainUntil" IS NOT NULL$/.test(s)) {
          return {
            rows: st.evidence.filter(
              (r) => r.retainUntil !== null && r.retainUntil !== undefined
            ),
          };
        }
        if (/^SELECT COUNT\(\*\) AS n FROM "QuizAttemptEvidence" WHERE "retainUntil" IS NULL$/.test(s)) {
          return { rows: [{ n: st.unstamped || 0 }] };
        }
        if (/^DELETE FROM "QuizAttemptEvidence" WHERE "id" IN \(/.test(s)) {
          let n = 0;
          for (const id of params) {
            const i = st.evidence.findIndex((r) => String(r.id) === String(id));
            if (i !== -1) {
              st.evidence.splice(i, 1);
              n++;
            }
          }
          return { rows: [], rowCount: n };
        }
        if (/^SELECT \(SELECT COUNT\(\*\) FROM "QuizAttemptEvidence" WHERE "mediaAssetId" = \$1\) AS e, \(SELECT COUNT\(\*\) FROM "Material" WHERE "mediaAssetId" = \$1\) AS m, \(SELECT COUNT\(\*\) FROM "SessionVideo" WHERE "mediaAssetId" = \$1\) AS s$/.test(s)) {
          const a = String(params[0]);
          const e = st.evidence.filter(
            (r) => r.mediaAssetId !== null && r.mediaAssetId !== undefined && String(r.mediaAssetId) === a
          ).length;
          return { rows: [{ e, m: st.material[a] || 0, s: st.sessionVideo[a] || 0 }] };
        }
        if (/^SELECT "storageKey","storage" FROM "MediaAsset" WHERE "id" = \$1$/.test(s)) {
          const a = st.assets[String(params[0])];
          return { rows: a ? [{ storageKey: a.key, storage: a.storage }] : [] };
        }
        if (/^DELETE FROM "MediaAsset" WHERE "id" = \$1$/.test(s)) {
          const k = String(params[0]);
          const existed = st.assets[k] !== undefined;
          delete st.assets[k];
          return { rows: [], rowCount: existed ? 1 : 0 };
        }
        throw new Error("fake pg: unexpected query: " + s);
      }
    },
    Pool: class {},
  };
}

// --- in-memory S3 bucket (real S3StorageBackend, fake client) ---------------
const s3 = { bucket: new Map(), ops: [], failDelete: false };
function s3Error(name, status) {
  const e = new Error("fake R2 " + name);
  e.name = name;
  e.$metadata = { httpStatusCode: status };
  return e;
}
const fakeS3Client = {
  async send(command) {
    const name = command.constructor.name;
    const input = command.input;
    s3.ops.push(name + " " + input.Key);
    if (name === "DeleteObjectCommand") {
      if (s3.failDelete) throw new Error("fake R2 DeleteObject failure");
      s3.bucket.delete(input.Key);
      return {};
    }
    if (name === "HeadObjectCommand") {
      const o = s3.bucket.get(input.Key);
      if (!o) throw s3Error("NotFound", 404);
      return { ContentLength: o.length };
    }
    if (name === "GetObjectCommand") {
      const o = s3.bucket.get(input.Key);
      if (!o) throw s3Error("NoSuchKey", 404);
      return { Body: o };
    }
    throw new Error("fake: unexpected S3 command " + name);
  },
};

// --- A-mode stub for the shared core -----------------------------------------
const coreCalls = [];
function makeCoreStub() {
  return {
    EVIDENCE_PURGE_PROTECTED_TABLES: ["SecurityEvent"],
    runEvidencePurge: async (opts) => {
      coreCalls.push({
        dialect: opts && opts.backend && opts.backend.dialect,
        dryRun: opts && opts.dryRun,
        hasNow: opts && opts.now instanceof Date,
      });
      if (globalThis.__CM_CORE_THROW__) {
        throw new Error("MARKER-inner-details " + globalThis.__CM_CORE_THROW__);
      }
      return globalThis.__CM_CORE_REPORT__;
    },
  };
}
const CANNED_OK = {
  dryRun: false,
  now: "2026-09-13T03:00:00.000Z",
  scanned: 5,
  expired: 3,
  retained: 2,
  expiredIds: ["e1", "e2", "e3"],
  deletedEvidenceRows: 3,
  detachedAssets: 1,
  detachedByStorage: { LOCAL_PRIVATE: 1 },
  deletedAssetRows: 1,
  deletedFiles: 2,
  failedFiles: ["some/object/key.jpg"],
  protectedTables: {},
  protectedTablesAfter: {},
  protectedMoved: [],
  ok: true,
};
const CANNED_INVARIANT = Object.assign({}, CANNED_OK, {
  ok: false,
  protectedMoved: ["SecurityEvent: 4 -> 5"],
});

// --- module interception ------------------------------------------------------
const IS_B = CASES.some((c) => c.startsWith("B_"));
const STUB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "cm-cron-stubs-"));
function stub(name, source) {
  const p = path.join(STUB_DIR, name);
  fs.writeFileSync(p, source);
  return p;
}
const STUBS = {
  pg: stub("pg.js", "module.exports = globalThis.__CM_PG_STUB__;\n"),
  ...(IS_B
    ? {}
    : {
        "@/lib/evidence-retention": stub(
          "evidence-retention.js",
          "module.exports = globalThis.__CM_CORE_STUB__;\n"
        ),
      }),
};
// The stub modules read their behaviour from globals so the case loop below
// can reprogram them without reloading modules.
globalThis.__CM_PG_STUB__ = makePgStub();
globalThis.__CM_CORE_STUB__ = makeCoreStub();

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

// B-mode: the REAL core (and its media import) must see the scratch volume as
// the LOCAL_PRIVATE root, captured at module load — set BEFORE any load.
if (IS_B) process.env.MEDIA_STORAGE_PATH = MEDIA_ROOT;
// No credential ever reaches a harness.
for (const v of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "R2_REGION", "R2_S3_ENDPOINT"]) {
  delete process.env[v];
}

// B-mode S3 boundary: REAL S3StorageBackend, FAKE client (same swap the R2
// wiring suite uses). Done before the route is loaded.
if (IS_B) {
  const mediaS3Path = path.join(EMIT, "lib", "media-s3.js");
  const realMediaS3 = require(mediaS3Path);
  require.cache[require.resolve(mediaS3Path)].exports = Object.assign({}, realMediaS3, {
    createS3StorageBackendFromEnv: () =>
      new realMediaS3.S3StorageBackend({
        client: fakeS3Client,
        bucket: "cm-harness-bucket",
      }),
  });
}

const route = require(path.join(EMIT, "app", "api", "cron", "purge-evidence", "route.js"));

// --- per-case wiring ----------------------------------------------------------
function setEnvForCase(c) {
  delete process.env.CRON_SECRET;
  delete process.env.DATABASE_URL;
  if (c === "A_NO_CRON_SECRET") {
    process.env.DATABASE_URL = PG_URL; // secret missing despite a valid DB
    return;
  }
  process.env.CRON_SECRET = TEST_SECRET;
  if (c === "A_NO_DB") return; // no DATABASE_URL at all
  if (c === "A_SQLITE_DB") {
    process.env.DATABASE_URL = "file:./db/custom.db";
    return;
  }
  process.env.DATABASE_URL = PG_URL;
}

function requestForCase(c) {
  const headers = {};
  const url =
    c === "A_QUERY_SECRET" ? ROUTE_URL + "?secret=" + encodeURIComponent(TEST_SECRET) : ROUTE_URL;
  switch (c) {
    case "A_NO_AUTH":
      break; // no headers at all
    case "A_MALFORMED_NO_TOKEN":
      headers.authorization = "Bearer";
      break;
    case "A_MALFORMED_SCHEME":
      headers.authorization = "Token " + TEST_SECRET;
      break;
    case "A_MALFORMED_MULTI":
      headers.authorization = "Bearer " + TEST_SECRET + " extra";
      break;
    case "A_WRONG_SECRET":
      headers.authorization = "Bearer " + WRONG_SECRET;
      break;
    case "A_COOKIE_ONLY":
      headers.cookie = "session=abc123; user=student-1";
      break;
    case "A_QUERY_SECRET":
      break; // secret only in the query string — never an auth input
    default:
      headers.authorization = "Bearer " + TEST_SECRET;
  }
  const method =
    c === "A_POST" ? "POST" : c === "A_PUT" ? "PUT" : c === "A_PATCH" ? "PATCH" : c === "A_DELETE" ? "DELETE" : "GET";
  return { url, method, headers };
}

function pgStateForCase(c) {
  const now = new Date();
  const past = new Date("2026-02-01T00:00:00.000Z");
  switch (c) {
    case "B_LOCAL":
      return {
        evidence: [{ id: "ev-b1", attemptId: "a1", mediaAssetId: "ma-b1", kind: "SNAPSHOT", retainUntil: past }],
        unstamped: 0,
        assets: { "ma-b1": { key: "quiz-evidence/b1.jpg", storage: "LOCAL_PRIVATE" } },
        material: {},
        sessionVideo: {},
        protected: {},
      };
    case "B_S3_OK":
    case "B_S3_FAIL":
      return {
        evidence: [{ id: "ev-b2", attemptId: "a2", mediaAssetId: "ma-b2", kind: "SNAPSHOT", retainUntil: past }],
        unstamped: 0,
        assets: { "ma-b2": { key: "quiz-evidence/b2.jpg", storage: "S3" } },
        material: {},
        sessionVideo: {},
        protected: {},
      };
    case "B_REFERENCED":
      return {
        evidence: [{ id: "ev-b4", attemptId: "a4", mediaAssetId: "ma-b4", kind: "SNAPSHOT", retainUntil: past }],
        unstamped: 0,
        assets: { "ma-b4": { key: "quiz-evidence/b4.jpg", storage: "LOCAL_PRIVATE" } },
        material: { "ma-b4": 1 },
        sessionVideo: {},
        protected: {},
      };
    case "B_IDEMPOTENT":
      return {
        evidence: [],
        unstamped: 1, // one NULL-stamp row: retained forever, never purged
        assets: {},
        material: {},
        sessionVideo: {},
        protected: {},
      };
    default:
      return null; // A-cases: the fake pg is never driven
  }
}

async function runCase(c) {
  coreCalls.length = 0;
  s3.bucket.clear();
  s3.ops = [];
  s3.failDelete = false;
  globalThis.__CM_CORE_THROW__ = null;
  globalThis.__CM_CORE_REPORT__ = null;

  if (c === "B_LOCAL") {
    const f = path.join(MEDIA_ROOT, "quiz-evidence", "b1.jpg");
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, Buffer.from("local-doomed-bytes"));
  }
  if (c === "B_S3_OK" || c === "B_S3_FAIL") {
    s3.bucket.set("quiz-evidence/b2.jpg", Buffer.from("s3-doomed-bytes"));
    if (c === "B_S3_FAIL") s3.failDelete = true;
  }

  setEnvForCase(c);
  if (c === "A_PURGE_THROW") globalThis.__CM_CORE_THROW__ = "host=db.internal sql=SELECT";
  if (c === "A_INVARIANT") globalThis.__CM_CORE_REPORT__ = CANNED_INVARIANT;
  if (c === "A_OK") globalThis.__CM_CORE_REPORT__ = CANNED_OK;

  const state = pgStateForCase(c);
  resetPgState(state);
  pgState.connectThrow = c === "A_PG_CONNECT_FAIL";

  const { url, method, headers } = requestForCase(c);
  const req = new Request(url, { method, headers });
  const handler = route[method];
  const res = await handler(req);
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = { __unparseable__: String(await res.text()).slice(0, 200) };
  }
  return {
    case: c,
    status: res.status,
    body,
    cacheControl: res.headers.get("cache-control"),
    coreCalls: coreCalls.slice(),
    pg: {
      constructed: pgState.constructed,
      connected: pgState.connected,
      ended: pgState.ended,
      ops: pgState.ops.slice(),
    },
    s3: { ops: s3.ops.slice(), remaining: [...s3.bucket.keys()] },
  };
}

(async () => {
  const results = [];
  for (const c of CASES) {
    try {
      results.push(await runCase(c));
    } catch (e) {
      results.push({ case: c, __harnessError__: String((e && e.stack) || e).slice(0, 800) });
    }
  }
  for (const r of results) console.log("CASE_JSON " + JSON.stringify(r));
  console.log(
    "HARNESS_SUMMARY " +
      JSON.stringify({
        cases: results.length,
        networkAttempts,
      })
  );
})().catch((e) => {
  console.error("harness fatal:", e);
  process.exit(1);
});
