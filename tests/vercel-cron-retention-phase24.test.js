// CodeMind Academy — Phase 24: Vercel retention cron (offline suite).
//
// Proves, without credentials, without a real database and without touching
// any real object store:
//   1. vercel.json contains EXACTLY the intended daily cron (0 3 * * * UTC).
//   2. The route exists, is Vercel-Node compatible, is GET-only, and never
//      reads the secret from the query string.
//   3. No NEXT_PUBLIC_CRON_SECRET exists anywhere; the .env.example contract
//      is correct (empty value, server-only, production-required).
//   4. Single retention implementation: the shared core carries the purge
//      operation; the CLI delegates to it; the route calls it.
//   5. Route auth + failure mapping (shipped route handler, stubbed core/pg):
//      no auth 401, malformed 401, wrong secret 401, cookie-only 401,
//      query-param secret 401, missing CRON_SECRET 503 (fail closed),
//      non-Postgres DATABASE_URL 503, correct secret → purge invoked exactly
//      once + minimal 200 shape, connect failure 500, purge exception 500
//      without leaking internals, invariant violation 500, other methods 405.
//   6. Route ↔ real-core integration (shipped core, in-memory PostgreSQL,
//      real local volume, real S3StorageBackend over a fake client):
//      LOCAL_PRIVATE deletion, S3 deletion, S3 delete-failure recorded,
//      referenced asset never detached, idempotent second run.
//   7. Shared core directly (scratch SQLite + scratch volume): expired-only
//      targeting, reference-safe detach, dry-run no-op, protected-table
//      assertion, S3 fail-closed.
//
// GUARANTEES: no real R2, no credentials, no network at all (the harness
// makes any socket connect throw and reports attempts), no schema change.
//
// Run: node tests/vercel-cron-retention-phase24.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-cron-p24-"));
const MEDIA_ROOT = path.join(OUT, "media-volume");
fs.mkdirSync(path.join(MEDIA_ROOT, "quiz-evidence"), { recursive: true });
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

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

// ---------------------------------------------------------------------------
section("1. vercel.json — exactly the intended daily cron");
// ---------------------------------------------------------------------------
{
  let vj = null;
  try {
    vj = JSON.parse(read("vercel.json"));
    ok(true, "vercel.json exists and parses as JSON");
  } catch (e) {
    ok(false, "vercel.json exists and parses as JSON");
  }
  if (vj) {
    eq(
      vj,
      {
        // Phase 26H: the project's build command is pinned in-repo so the
        // deployment can never fall back to the framework default
        // (`npm run build`), which generates the SQLITE Prisma Client and
        // cannot talk to a `postgresql://` production URL.
        buildCommand: "npm run build:postgres",
        crons: [{ path: "/api/cron/purge-evidence", schedule: "0 3 * * *" }],
      },
      "vercel.json contains EXACTLY the PostgreSQL build command + one cron: /api/cron/purge-evidence @ 0 3 * * *"
    );
    // Phase 26H pin: the production build MUST generate the PostgreSQL client.
    eq(
      vj.buildCommand,
      "npm run build:postgres",
      "buildCommand is the PostgreSQL production build (never the SQLite `npm run build`)"
    );
    // Phase 26H pin: the build command must not smuggle in a migration.
    ok(
      !/migrate/i.test(String(vj.buildCommand)),
      "buildCommand contains no migration step (migrations are an operator action)"
    );
    ok(
      Array.isArray(vj.crons) && vj.crons.length === 1,
      "exactly one cron entry (no extra scheduled jobs)"
    );
    // "0 3 * * *" = minute 0, hour 3, every day → 03:00 UTC daily.
    const [min, hour, dom, mon, dow] = (vj.crons[0] || {}).schedule ? (vj.crons[0].schedule.match(/(\S+)/g) || []) : [];
    eq(
      [min, hour, dom, mon, dow],
      ["0", "3", "*", "*", "*"],
      "schedule field-by-field: 03:00 UTC daily"
    );
  }
}

// ---------------------------------------------------------------------------
section("2. Route exists — Vercel Node runtime, GET-only, no query-param secret");
// ---------------------------------------------------------------------------
const ROUTE_REL = "src/app/api/cron/purge-evidence/route.ts";
{
  ok(fs.existsSync(path.join(REPO, ROUTE_REL)), `route file exists: ${ROUTE_REL}`);
  const route = read(ROUTE_REL);
  ok(/export const runtime = "nodejs"/.test(route), "route pins the Vercel Node runtime");
  ok(/export const dynamic = "force-dynamic"/.test(route), "route is force-dynamic (never cache-stale)");
  ok(/export async function GET/.test(route), "route exports an async GET handler");
  for (const m of ["POST", "PUT", "PATCH", "DELETE"]) {
    ok(new RegExp(`export function ${m}\\(`).test(route), `route refuses ${m} explicitly (405)`);
  }
  ok(!/export function HEAD\(/.test(route), "no HEAD export (Next 405 default)");
  ok(!/searchParams/.test(route) && !/new URL\(/.test(route), "route never parses the query string");
  ok(/timingSafeEqual\(/.test(route), "secret comparison uses timingSafeEqual");
  ok(/createHash\("sha256"\)/.test(route), "secrets are hashed to a fixed digest before comparison");
  ok(!/NEXT_PUBLIC/.test(route), "route references no NEXT_PUBLIC_* variable");
  const envVars = [...new Set((route.match(/process\.env\.(\w+)/g) || []).map((v) => v.slice("process.env.".length)))].sort();
  eq(envVars, ["CRON_SECRET", "DATABASE_URL"], "route reads only CRON_SECRET + DATABASE_URL from env");
  ok(/Authorization/.test(route) && /Bearer/i.test(route), "route authorizes via the Bearer scheme");
}

// ---------------------------------------------------------------------------
section("3. No NEXT_PUBLIC_CRON_SECRET anywhere; .env.example contract");
// ---------------------------------------------------------------------------
{
  const walk = (dir, acc = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx|js|cjs|mjs|json|md|txt|html|css)$/.test(entry.name)) acc.push(p);
    }
    return acc;
  };
  const SELF = path.join(REPO, "tests", "vercel-cron-retention-phase24.test.js");
  const dirs = ["src", "scripts", "tests", "docs", "public"].filter((d) =>
    fs.existsSync(path.join(REPO, d))
  );
  // The sweep excludes its own source (its labels quote the banned name).
  const files = dirs.flatMap((d) => walk(path.join(REPO, d))).filter((f) => f !== SELF);
  for (const f of fs.readdirSync(REPO)) {
    if (/^(vercel\.json|Caddyfile|next\.config\.ts|\.env\.example|package\.json)$/.test(f)) files.push(path.join(REPO, f));
  }
  const banned = new RegExp("NEXT_PUBLIC_" + "CRON_SECRET");
  const hits = files.filter((f) => banned.test(fs.readFileSync(f, "utf8")));
  ok(hits.length === 0, `no NEXT_PUBLIC_CRON_SECRET in the repo (${hits.length} hits)`);
  const env = read(".env.example");
  ok(/^CRON_SECRET=$/m.test(env), ".env.example ships CRON_SECRET= with NO value");
  ok(!/NEXT_PUBLIC_\w*CRON/i.test(env), ".env.example documents no NEXT_PUBLIC_* cron variable");
  ok(/SERVER-ONLY/.test(env) && /REQUIRED in production/.test(env), "CRON_SECRET documented as server-only + required in production");
  ok(/Authorization: Bearer <CRON_SECRET>/.test(env), "CRON_SECRET documents the exact bearer header");
}

// ---------------------------------------------------------------------------
section("4. Single retention implementation (core / CLI / route)");
// ---------------------------------------------------------------------------
{
  const core = read("src/lib/evidence-retention.ts");
  ok(/export async function runEvidencePurge\(/.test(core), "shared core exports runEvidencePurge");
  ok(/export interface PurgeSqlBackend/.test(core) && /export interface PurgeReport/.test(core), "shared core exports the backend + report contracts");
  ok(/WHERE "retainUntil" IS NOT NULL/.test(core), "core pre-filters stamped rows (exact-row targeting)");
  ok(/selectExpiredEvidence\(/.test(core), "core makes the final expiry call with the shared rule");
  ok(/isManagedPrivateStorage\(asset\[0\]\.storage\)/.test(core), "core gate uses the shared managed-private predicate");
  ok(/backendNameForStorageValue\(/.test(core), "core dispatches on the recorded storage value");
  ok(/new LocalStorageBackend\(mediaRoot\)/.test(core), "core deletes LOCAL_PRIVATE objects through the storage abstraction");
  ok(/createStorageBackend\(name\)/.test(core), "core deletes S3 objects through the storage abstraction");
  ok(/await storage\.delete\(key\)/.test(core) && /still present after delete/.test(core), "core verifies convergence after deleting an object");
  ok(/for \(const t of EVIDENCE_PURGE_PROTECTED_TABLES\)/.test(core), "core asserts the protected tables before AND after");
  ok(/DELETE FROM "MediaAsset" WHERE "id"/.test(core), "core deletes the MediaAsset row only when detached");

  const cli = read("scripts/media/purge-expired-evidence.ts");
  ok(/import\s*\{[^}]*runEvidencePurge[^}]*\}\s*from\s*"@\/lib\/evidence-retention"/.test(cli), "CLI imports runEvidencePurge from the shared core");
  ok(!/DELETE FROM "QuizAttemptEvidence"/.test(cli), "CLI carries no duplicate evidence-deletion SQL");
  ok(!/selectExpiredEvidence\(/.test(cli), "CLI carries no duplicate selection rule");
  ok(!/isManagedPrivateStorage\(/.test(cli), "CLI carries no duplicate storage gate");
  // Operator semantics preserved: dry-run default, --live AND --yes.
  ok(/\["?--live"?\]|a === "--live"/.test(cli) && /a === "--yes"/.test(cli), "CLI keeps the --live/--yes operator flags");
  ok(/requires BOTH --live AND --yes/.test(cli), "CLI refusal message unchanged");

  const route = read(ROUTE_REL);
  ok(/import\s*\{[^}]*runEvidencePurge[^}]*\}\s*from\s*"@\/lib\/evidence-retention"/.test(route), "route imports runEvidencePurge from the shared core");
  ok(!/DELETE FROM "QuizAttemptEvidence"/.test(route), "route carries no deletion SQL of its own");
}

// ---------------------------------------------------------------------------
// Compile the shipped route + core for the behavioural harnesses (same
// convention as tests/media-storage-wiring.test.js).
// ---------------------------------------------------------------------------
const MODULES = [
  ROUTE_REL,
  "src/lib/evidence-retention.ts",
  "src/lib/media.ts",
  "src/lib/media-s3.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify(
    {
      compilerOptions: {
        target: "es2022",
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
      files: MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
let tscOutput = "";
try {
  execFileSync(process.execPath, [path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"), "-p", path.join(OUT, "tsconfig.json")], {
    cwd: REPO,
    stdio: "pipe",
  });
} catch (e) {
  tscOutput = String((e && e.stdout) || "") + String((e && e.stderr) || "");
}
const EMIT = path.join(OUT, "src");
for (const rel of [
  "app/api/cron/purge-evidence/route.js",
  "lib/evidence-retention.js",
  "lib/media.js",
  "lib/media-s3.js",
]) {
  ok(
    fs.existsSync(path.join(EMIT, rel)),
    `tsc emitted ${rel}${fs.existsSync(path.join(EMIT, rel)) ? "" : ` — tsc said: ${tscOutput.slice(0, 400)}`}`
  );
}

const A_CASES = [
  "A_NO_AUTH",
  "A_MALFORMED_NO_TOKEN",
  "A_MALFORMED_SCHEME",
  "A_MALFORMED_MULTI",
  "A_WRONG_SECRET",
  "A_COOKIE_ONLY",
  "A_QUERY_SECRET",
  "A_NO_CRON_SECRET",
  "A_NO_DB",
  "A_SQLITE_DB",
  "A_OK",
  "A_PG_CONNECT_FAIL",
  "A_PURGE_THROW",
  "A_INVARIANT",
  "A_POST",
  "A_PUT",
  "A_PATCH",
  "A_DELETE",
].join(",");
const B_CASES = ["B_LOCAL", "B_S3_OK", "B_S3_FAIL", "B_REFERENCED", "B_IDEMPOTENT"].join(",");

function runHarness(cases, env = {}) {
  const out = execFileSync(process.execPath, [path.join(REPO, "tests", "helpers", "vercel-cron-harness.cjs")], {
    cwd: REPO,
    encoding: "utf8",
    env: Object.assign({}, process.env, env, {
      CM_REPO: REPO,
      CM_EMIT: EMIT,
      CM_CASES: cases,
      CM_MEDIA_ROOT: MEDIA_ROOT,
      NODE_PATH: path.join(REPO, "node_modules"),
      NODE_NO_WARNINGS: "1",
      // No credential ever reaches a harness.
      R2_ACCOUNT_ID: "",
      R2_ACCESS_KEY_ID: "",
      R2_SECRET_ACCESS_KEY: "",
      R2_BUCKET: "",
      R2_REGION: "",
      R2_S3_ENDPOINT: "",
    }),
    timeout: 180000,
  });
  const results = {};
  for (const line of out.split("\n")) {
    const m = /^CASE_JSON (\{[\s\S]*\})$/.exec(line);
    if (m) {
      const r = JSON.parse(m[1]);
      results[r.case] = r;
    }
  }
  const sum = /HARNESS_SUMMARY (\{[\s\S]*\})/.exec(out);
  results.__summary__ = sum ? JSON.parse(sum[1]) : null;
  return results;
}

const TEST_SECRET = "cm-test-cron-secret-0123456789abcdef";
const WRONG_SECRET = "cm-wrong-secret-value-0123456789abcdef";

// ---------------------------------------------------------------------------
section("5. Route auth + failure mapping (shipped handler; stubbed core/pg)");
// ---------------------------------------------------------------------------
{
  const r = runHarness(A_CASES);
  const get = (c) => r[c];
  const bodyStr = (c) => JSON.stringify(get(c) && get(c).body);

  ok(!!r.__summary__ && Array.isArray(r.__summary__.networkAttempts) && r.__summary__.networkAttempts.length === 0,
    "zero network attempts across all A-cases");

  // --- authorization: only the bearer secret works -------------------------
  for (const [c, label] of [
    ["A_NO_AUTH", "no Authorization header"],
    ["A_MALFORMED_NO_TOKEN", "malformed: 'Bearer' with no token"],
    ["A_MALFORMED_SCHEME", "malformed: non-Bearer scheme"],
    ["A_MALFORMED_MULTI", "malformed: multi-token bearer"],
    ["A_WRONG_SECRET", "wrong secret"],
    ["A_COOKIE_ONLY", "logged-in session cookie without the bearer"],
    ["A_QUERY_SECRET", "secret only in the query string"],
  ]) {
    ok(!!get(c), `harness reported ${c}`);
    if (!get(c)) continue;
    ok(get(c).status === 401, `${label} → 401 (got ${get(c).status})`);
    eq(get(c).body, { ok: false, error: "unauthorized" }, `${label} body is the fixed 401 shape`);
    ok(get(c).coreCalls.length === 0, `${label} → purge NOT invoked`);
    ok(get(c).pg.constructed === false, `${label} → no database connection constructed`);
  }
  ok(!bodyStr("A_WRONG_SECRET").includes(TEST_SECRET) && !bodyStr("A_WRONG_SECRET").includes(WRONG_SECRET),
    "401 body never echoes the secret (either direction)");

  // --- server misconfiguration: fail closed, before any DB work ------------
  ok(get("A_NO_CRON_SECRET") && get("A_NO_CRON_SECRET").status === 503,
    "missing CRON_SECRET → 503 (fail closed)");
  eq(get("A_NO_CRON_SECRET").body, { ok: false, error: "misconfigured", reason: "CRON_SECRET_NOT_SET" }, "503 body names the missing variable, never a value");
  ok(get("A_NO_CRON_SECRET").coreCalls.length === 0 && get("A_NO_CRON_SECRET").pg.constructed === false,
    "missing CRON_SECRET → nothing runs, not even a connection");
  ok(get("A_NO_DB") && get("A_NO_DB").status === 503 && get("A_NO_DB").coreCalls.length === 0,
    "correct secret but missing DATABASE_URL → 503, purge not invoked");
  ok(get("A_SQLITE_DB") && get("A_SQLITE_DB").status === 503 && get("A_SQLITE_DB").body.reason === "DATABASE_URL_NOT_POSTGRES",
    "sqlite DATABASE_URL → 503 DATABASE_URL_NOT_POSTGRES (production purge is PostgreSQL)");

  // --- success: purge invoked exactly once, minimal shape -------------------
  const okCase = get("A_OK");
  ok(okCase && okCase.status === 200, `correct secret → 200 (got ${okCase && okCase.status})`);
  eq(okCase.body, { ok: true, deleted: 3, deletedAssets: 1, deletedFiles: 2, failed: 1 },
    "200 body is the minimal machine-readable summary (no keys/ids/endpoints)");
  eq(okCase.coreCalls.length, 1, "purge invoked EXACTLY ONCE on success");
  eq(okCase.coreCalls[0].dialect, "postgresql", "core receives a PostgreSQL-dialect backend");
  ok(okCase.coreCalls[0].hasNow === true, "core receives a server-side clock (never client input)");
  ok(okCase.coreCalls[0].dryRun === undefined || okCase.coreCalls[0].dryRun === false, "cron run is live (no dry-run path)");
  ok(okCase.pg.constructed === true && okCase.pg.connected === true && okCase.pg.ended === true,
    "connection constructed, used, and released");
  ok(okCase.cacheControl === "no-store", "responses are no-store (never cacheable)");
  ok(!JSON.stringify(okCase.body).includes(TEST_SECRET), "200 body never contains the secret");

  // --- failures: 500, fixed bodies, no internals ---------------------------
  ok(get("A_PG_CONNECT_FAIL") && get("A_PG_CONNECT_FAIL").status === 500, "db connect failure → 500");
  eq(get("A_PG_CONNECT_FAIL").body, { ok: false, error: "purge failed" }, "connect failure body is fixed");
  ok(!bodyStr("A_PG_CONNECT_FAIL").includes("MARKER-connect-refused") && !bodyStr("A_PG_CONNECT_FAIL").includes("127.0.0.1"),
    "connect failure leaks no error internals/host");
  ok(get("A_PURGE_THROW") && get("A_PURGE_THROW").status === 500, "purge exception → 500");
  eq(get("A_PURGE_THROW").body, { ok: false, error: "purge failed" }, "exception body is fixed");
  ok(!bodyStr("A_PURGE_THROW").includes("MARKER-inner-details"), "exception message internals never reach the response");
  ok(get("A_INVARIANT") && get("A_INVARIANT").status === 500, "protected-table invariant violation → 500");
  eq(get("A_INVARIANT").body, { ok: false, error: "purge invariant violation" }, "invariant body names the class only");
  ok(get("A_INVARIANT").pg.ended === true, "connection released even on invariant failure");

  // --- GET only --------------------------------------------------------------
  for (const c of ["A_POST", "A_PUT", "A_PATCH", "A_DELETE"]) {
    const m = c.slice(2);
    ok(get(c) && get(c).status === 405, `${m} → 405 (GET only)`);
    ok(get(c) && get(c).coreCalls.length === 0, `${m} → purge NOT invoked`);
  }
}

// ---------------------------------------------------------------------------
section("6. Route ↔ real shared core (in-memory PG, real volume, fake S3)");
// ---------------------------------------------------------------------------
{
  const r = runHarness(B_CASES);
  const get = (c) => r[c];
  ok(!!r.__summary__ && r.__summary__.networkAttempts.length === 0, "zero network attempts across all B-cases");

  // 6a. LOCAL_PRIVATE: row + asset + bytes all gone, transactional, verified.
  const b1 = get("B_LOCAL");
  ok(b1 && b1.status === 200, `B_LOCAL → 200 (got ${b1 && b1.status})`);
  eq(b1.body, { ok: true, deleted: 1, deletedAssets: 1, deletedFiles: 1, failed: 0 }, "B_LOCAL summary counts");
  ok(!fs.existsSync(path.join(MEDIA_ROOT, "quiz-evidence", "b1.jpg")), "LOCAL_PRIVATE bytes removed from the volume");
  const ops1 = b1.pg.ops;
  ok(ops1.includes("BEGIN") && ops1.includes("COMMIT"), "row deletes run inside a transaction");
  const bi = ops1.indexOf("BEGIN");
  const di = ops1.indexOf("DELETE FROM \"QuizAttemptEvidence\" WHERE \"id\" IN ($1)");
  const mi = ops1.indexOf("DELETE FROM \"MediaAsset\" WHERE \"id\" = $1");
  const ci = ops1.indexOf("COMMIT");
  ok(bi !== -1 && di > bi && mi > di && ci > mi, "DELETE evidence → detach check → DELETE asset → COMMIT (all inside tx)");
  ok(ops1.every((o) => !/^DELETE FROM "(SecurityEvent|AuditLog|TeacherApplication|TeacherActivationToken|UserSession|PasswordResetToken|SecurityRateLimit|QuizAttempt|Student|User)"$/.test(o)),
    "no protected table is ever a delete target");
  ok(b1.pg.ended === true, "connection released after the run");

  // 6b. S3: object deleted through the real S3StorageBackend (fake client).
  const b2 = get("B_S3_OK");
  ok(b2 && b2.status === 200, `B_S3_OK → 200 (got ${b2 && b2.status})`);
  eq(b2.body, { ok: true, deleted: 1, deletedAssets: 1, deletedFiles: 1, failed: 0 }, "B_S3_OK summary counts");
  eq(b2.s3.remaining, [], "S3 object is actually gone from the bucket");
  ok(b2.s3.ops.some((o) => o.startsWith("DeleteObjectCommand quiz-evidence/b2.jpg")), "S3 DeleteObject issued for the recorded key");
  ok(b2.s3.ops.some((o) => o.startsWith("HeadObjectCommand quiz-evidence/b2.jpg")), "S3 delete verified with a HEAD (convergence)");

  // 6c. S3 delete failure: recorded, not skipped, run still completes.
  const b3 = get("B_S3_FAIL");
  ok(b3 && b3.status === 200, `B_S3_FAIL → 200 (run completed; residue is reported, not hidden) (got ${b3 && b3.status})`);
  eq(b3.body, { ok: true, deleted: 1, deletedAssets: 1, deletedFiles: 0, failed: 1 }, "B_S3_FAIL summary counts");
  eq(b3.s3.remaining, ["quiz-evidence/b2.jpg"], "failed S3 delete leaves the object (orphaned-bytes direction, retried next run)");

  // 6d. Referenced asset: the row survives, nothing is touched.
  const b4 = get("B_REFERENCED");
  ok(b4 && b4.status === 200, `B_REFERENCED → 200 (got ${b4 && b4.status})`);
  eq(b4.body, { ok: true, deleted: 1, deletedAssets: 0, deletedFiles: 0, failed: 0 }, "referenced asset is never detached");
  ok(!b4.pg.ops.some((o) => o.startsWith("DELETE FROM \"MediaAsset\"")), "no MediaAsset delete for a referenced asset");

  // 6e. Idempotency: a second run finds nothing to do and no-ops safely.
  const b5 = get("B_IDEMPOTENT");
  ok(b5 && b5.status === 200, `B_IDEMPOTENT → 200 (got ${b5 && b5.status})`);
  eq(b5.body, { ok: true, deleted: 0, deletedAssets: 0, deletedFiles: 0, failed: 0 }, "second run deletes nothing");
  ok(!b5.pg.ops.some((o) => o.startsWith("DELETE FROM")), "second run issues no DELETE at all");
}

// ---------------------------------------------------------------------------
section("7. Shared core directly (scratch SQLite + scratch volume)");
// ---------------------------------------------------------------------------
{
  const { DatabaseSync } = require("node:sqlite");
  const PROTECTED = ["SecurityEvent", "AuditLog", "TeacherApplication", "TeacherActivationToken", "UserSession", "PasswordResetToken", "SecurityRateLimit", "QuizAttempt", "Student", "User"];
  const tmp = path.join(OUT, "core-direct");
  fs.mkdirSync(tmp, { recursive: true });
  const NOW = "2026-09-13T03:00:00.000Z";

  const makeDb = (file) => {
    const d = new DatabaseSync(file);
    d.exec(
      'CREATE TABLE "QuizAttemptEvidence" ("id" TEXT PRIMARY KEY, "attemptId" TEXT, "mediaAssetId" TEXT, "kind" TEXT, "status" TEXT, "capturedAt" TEXT, "retainUntil" TEXT);\n' +
        'CREATE TABLE "Material" ("id" TEXT PRIMARY KEY, "mediaAssetId" TEXT);\n' +
        'CREATE TABLE "SessionVideo" ("id" TEXT PRIMARY KEY, "mediaAssetId" TEXT);\n' +
        'CREATE TABLE "MediaAsset" ("id" TEXT PRIMARY KEY, "storage" TEXT, "storageKey" TEXT);\n' +
        PROTECTED.map((t) => `CREATE TABLE "${t}" ("id" TEXT PRIMARY KEY);`).join("\n")
    );
    return d;
  };

  const dbLocal = path.join(tmp, "local.db");
  {
    const d = makeDb(dbLocal);
    d.exec(
      "INSERT INTO \"MediaAsset\" VALUES ('ma1','LOCAL_PRIVATE','e/x.jpg');\n" +
        "INSERT INTO \"MediaAsset\" VALUES ('ma3','LOCAL_PRIVATE','e/keep.jpg');\n" +
        "INSERT INTO \"Material\" VALUES ('mat1','ma3');\n" +
        "INSERT INTO \"QuizAttemptEvidence\" VALUES ('ev1','a1','ma1','SNAPSHOT',NULL,'2026-01-01','2026-02-01T00:00:00.000Z');\n" +
        "INSERT INTO \"QuizAttemptEvidence\" VALUES ('ev2','a2',NULL,'STATUS','GRANTED','2026-01-01',NULL);\n" +
        "INSERT INTO \"QuizAttemptEvidence\" VALUES ('ev3','a3','ma3','SNAPSHOT',NULL,'2026-01-01','2026-02-01T00:00:00.000Z');"
    );
    d.close();
  }
  const dbDry = path.join(tmp, "dry.db");
  {
    const d = makeDb(dbDry);
    d.exec(
      "INSERT INTO \"MediaAsset\" VALUES ('maD','LOCAL_PRIVATE','e/dry.jpg');\n" +
        "INSERT INTO \"QuizAttemptEvidence\" VALUES ('evD','aD','maD','SNAPSHOT',NULL,'2026-01-01','2026-02-01T00:00:00.000Z');"
    );
    d.close();
  }
  const dbMoved = path.join(tmp, "moved.db");
  {
    const d = makeDb(dbMoved);
    d.exec("INSERT INTO \"QuizAttemptEvidence\" VALUES ('evM','aM',NULL,'SNAPSHOT',NULL,'2026-01-01','2026-02-01T00:00:00.000Z');");
    d.close();
  }
  const dbS3 = path.join(tmp, "s3.db");
  {
    const d = makeDb(dbS3);
    d.exec(
      "INSERT INTO \"MediaAsset\" VALUES ('maS','S3','e/s3.jpg');\n" +
        "INSERT INTO \"QuizAttemptEvidence\" VALUES ('evS','aS','maS','SNAPSHOT',NULL,'2026-01-01','2026-02-01T00:00:00.000Z');"
    );
    d.close();
  }

  const localFile = path.join(MEDIA_ROOT, "e", "x.jpg");
  const keepFile = path.join(MEDIA_ROOT, "e", "keep.jpg");
  const dryFile = path.join(MEDIA_ROOT, "e", "dry.jpg");
  fs.mkdirSync(path.join(MEDIA_ROOT, "e"), { recursive: true });
  fs.writeFileSync(localFile, Buffer.from("core-local-doomed"));
  fs.writeFileSync(keepFile, Buffer.from("core-local-keep"));
  fs.writeFileSync(dryFile, Buffer.from("core-dry-keep"));

  let hout = "";
  try {
    hout = execFileSync(
      process.execPath,
      [
        "node_modules/tsx/dist/cli.mjs",
        path.join(REPO, "tests", "helpers", "core-direct-harness.mts"),
        dbLocal,
        dbDry,
        dbMoved,
        dbS3,
        MEDIA_ROOT,
        localFile,
        keepFile,
        dryFile,
        NOW,
      ],
      {
        cwd: REPO,
        encoding: "utf8",
        env: Object.assign({}, process.env, {
          NODE_NO_WARNINGS: "1",
          R2_ACCOUNT_ID: "",
          R2_ACCESS_KEY_ID: "",
          R2_SECRET_ACCESS_KEY: "",
          R2_BUCKET: "",
          R2_REGION: "",
          R2_S3_ENDPOINT: "",
        }),
        timeout: 180000,
      }
    );
  } catch (e) {
    ok(false, "core-direct harness ran (crashed: " + String((e && e.stdout) || e.message).slice(0, 400) + ")");
  }
  const hjson = /HARNESS_JSON (\{[\s\S]*\})/.exec(hout);
  if (hjson) {
    const j = JSON.parse(hjson[1]);
    // 7a.
    ok(j.r1.ok === true, "7a: live run ok");
    eq(j.r1.deletedEvidenceRows, 2, "7a: only the two expired rows delete (STATUS row + NULL-stamp row never)");
    eq(j.r1.deletedAssetRows, 1, "7a: only the unreferenced asset detaches");
    eq(j.r1.deletedFiles, 1, "7a: the LOCAL_PRIVATE bytes are deleted");
    eq(j.r1.failedFiles, [], "7a: nothing failed");
    eq(j.r1.detachedByStorage, { LOCAL_PRIVATE: 1 }, "7a: storage of the detached object recorded");
    eq(j.r1.expiredIds.sort(), ["ev1", "ev3"], "7a: exact expired ids (rule unchanged)");
    ok(j.r1After.localFileGone === true && j.r1After.keepFileGone === false, "7a: doomed file gone, referenced file kept");
    ok(j.r1After.evidence === 1, "7a: only the STATUS row survives in the DB");
    ok(j.r1After.ma3Rows === 1, "7a: the referenced MediaAsset row survives");
    // 7b.
    ok(j.r2.ok === true && j.r2.dryRun === true, "7b: dry run reports ok");
    eq(j.r2.expired, 1, "7b: dry run still sees the expired row");
    eq(j.r2.deletedEvidenceRows, 0, "7b: dry run deletes nothing");
    ok(j.r2After.evidence === 1 && j.r2After.assets === 1 && j.r2After.dryFileGone === false, "7b: dry run changed nothing (rows + bytes)");
    // 7c.
    ok(j.r3.ok === false, "7c: protected-table movement flips the report to ok=false");
    eq(j.r3.protectedMoved.length, 1, "7c: exactly one movement recorded");
    ok(/^SecurityEvent: 0 -> 1$/.test(j.r3.protectedMoved[0]), "7c: the movement names the table and counts");
    ok(j.r3.securityAfter === 1, "7c: the intrusion is what was detected");
    // 7d.
    ok(j.r4.ok === true, "7d: run completes with a recorded failure (fail-closed, not fatal)");
    eq(j.r4.deletedAssetRows, 1, "7d: the S3 asset row detaches in the transaction");
    eq(j.r4.deletedFiles, 0, "7d: no bytes deleted from an unconfigured object store");
    eq(j.r4.detachedByStorage, { S3: 1 }, "7d: the S3 object was recognised");
    ok(j.r4.failedFiles.length === 1 && /e\/s3\.jpg: MEDIA_BACKEND=s3 requires server-side env vars/.test(j.r4.failedFiles[0]),
      "7d: the failure names the missing configuration (no bucket contacted)");
    ok(!/[A-Za-z0-9+/]{30,}/.test(j.r4.failedFiles[0]), "7d: no secret-looking value in the failure record");
  } else {
    ok(false, "core-direct harness produced a result: " + hout.slice(-400));
  }
}

// ---------------------------------------------------------------------------
console.log("\n" + "=".repeat(60));
console.log(`Phase 24 vercel-cron-retention tests: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.error("Failures:");
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
