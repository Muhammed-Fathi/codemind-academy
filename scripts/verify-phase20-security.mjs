#!/usr/bin/env node
// CodeMind Academy — Phase 20 real-database verification.
//
// Exercises the SHIPPED security primitive (`checkRateLimit` in
// src/lib/security.ts) against REAL SQLite rows — the same node:sqlite
// backend the other verify-* scripts use, because binaries.prisma.sh is
// unreachable in this sandbox (documented across Phases 6–19). It also
// compiles and runs the two PURE Phase 20 modules (rate-limit.ts,
// content-security-policy.ts) directly, so the policy math and the CSP
// directives are executed, not just source-asserted.
//
// What is proven here:
//   * determinism  — the same (bucket, identifier) sequence yields exactly
//                    `limit` allowed requests then a block;
//   * boundedness  — the stored counter NEVER exceeds `limit`;
//   * atomicity    — the guarded increment (`UPDATE … WHERE count < limit`)
//                    is the shipped statement, executed by SQLite itself;
//   * window reset — an expired window restarts the counter;
//   * block window — `blockedUntil` engages and reports Retry-After;
//   * no raw ids   — the stored identifier is a SHA-256 hash, not the user id;
//   * policy math  — env overrides are clamped, headers carry the right
//                    keys, and the production CSP never contains unsafe-eval.
//
// Prints PHASE20_VERIFY_OK on success. Never touches the developer's real DB.

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
// Scratch DB: the SecurityRateLimit table, exactly as the migration defines it
// ---------------------------------------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase20-"));
const dbPath = path.join(WORK, "scratch.db");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS "SecurityRateLimit" (
    "id"          TEXT NOT NULL PRIMARY KEY,
    "bucket"      TEXT NOT NULL,
    "identifier"  TEXT NOT NULL,
    "count"       INTEGER NOT NULL DEFAULT 0,
    "windowStart" DATETIME NOT NULL,
    "blockedUntil" DATETIME
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "SecurityRateLimit_bucket_identifier_key"
    ON "SecurityRateLimit"("bucket", "identifier");
`);

// A minimal, REAL-SQLite adapter for the one model checkRateLimit touches.
// It is not the full Prisma surface — it implements exactly the calls
// src/lib/security.ts makes, so a wrong statement fails loudly instead of
// being approximated. DateTime columns are converted to Date objects on read
// (node:sqlite returns them as strings; the shipped code calls .getTime()).
const toClient = (row) => {
  if (!row) return null;
  return {
    ...row,
    windowStart: row.windowStart ? new Date(row.windowStart) : null,
    blockedUntil: row.blockedUntil ? new Date(row.blockedUntil) : null,
  };
};
const rlClient = {
  securityRateLimit: {
    findUnique: async ({ where }) => {
      const { bucket, identifier } = where.bucket_identifier;
      const row = sqlite
        .prepare(
          `SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`
        )
        .get(bucket, identifier);
      return toClient(row);
    },
    upsert: async ({ where, create, update }) => {
      const { bucket, identifier } = where.bucket_identifier;
      const id = `rl-${crypto.randomUUID()}`;
      const updateKeys = Object.keys(update || {});
      // Atomic upsert: `update: {}` → INSERT … ON CONFLICT DO NOTHING (the
      // "ensure the row exists" step); otherwise set the update fields from
      // the excluded row (Prisma's ON CONFLICT DO UPDATE semantics).
      const base = `INSERT INTO "SecurityRateLimit" ("id","bucket","identifier","count","windowStart","blockedUntil") VALUES (?,?,?,?,?,?)`;
      if (updateKeys.length === 0) {
        sqlite
          .prepare(
            `${base} ON CONFLICT("bucket","identifier") DO NOTHING`
          )
          .run(id, bucket, identifier, create.count, create.windowStart.toISOString(), create.blockedUntil ?? null);
      } else {
        sqlite
          .prepare(
            `${base} ON CONFLICT("bucket","identifier") DO UPDATE SET
              "count" = excluded."count",
              "windowStart" = excluded."windowStart",
              "blockedUntil" = excluded."blockedUntil"`
          )
          .run(id, bucket, identifier, create.count, create.windowStart.toISOString(), create.blockedUntil ?? null);
      }
      return toClient(
        sqlite
          .prepare(
            `SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`
          )
          .get(bucket, identifier)
      );
    },
    updateMany: async ({ where, data }) => {
      // General guarded UPDATE builder — supports both statements the shipped
      // code issues: the guarded increment (`count: { increment: 1 }` where
      // `count < limit`) and the guarded window reset (`count=1, windowStart=now`
      // where `windowStart <= cutoff`).
      const sets = [];
      const conds = [];
      const params = [];
      if (data.count !== undefined) {
        if (data.count && typeof data.count === "object" && "increment" in data.count) {
          sets.push(`"count" = "count" + ?`);
          params.push(data.count.increment);
        } else {
          sets.push(`"count" = ?`);
          params.push(data.count);
        }
      }
      if (data.windowStart !== undefined) {
        sets.push(`"windowStart" = ?`);
        params.push(data.windowStart.toISOString());
      }
      if (data.blockedUntil !== undefined) {
        sets.push(`"blockedUntil" = ?`);
        params.push(data.blockedUntil ? data.blockedUntil.toISOString() : null);
      }
      conds.push(`"bucket" = ?`);
      params.push(where.bucket);
      conds.push(`"identifier" = ?`);
      params.push(where.identifier);
      if (where.count && typeof where.count === "object" && "lt" in where.count) {
        conds.push(`"count" < ?`);
        params.push(where.count.lt);
      }
      if (where.windowStart && typeof where.windowStart === "object" && "lte" in where.windowStart) {
        conds.push(`"windowStart" <= ?`);
        params.push(where.windowStart.lte.toISOString());
      }
      const result = sqlite
        .prepare(
          `UPDATE "SecurityRateLimit" SET ${sets.join(", ")} WHERE ${conds.join(" AND ")}`
        )
        .run(...params);
      return { count: Number(result.changes ?? 0) };
    },
    update: async ({ where, data }) => {
      const { bucket, identifier } = where.bucket_identifier;
      sqlite
        .prepare(
          `UPDATE "SecurityRateLimit" SET "blockedUntil" = ? WHERE "bucket" = ? AND "identifier" = ?`
        )
        .run(data.blockedUntil.toISOString(), bucket, identifier);
      return toClient(
        sqlite
          .prepare(
            `SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`
          )
          .get(bucket, identifier)
      );
    },
  },
};

globalThis.__CM_DB_CLIENT__ = rlClient;

// ---------------------------------------------------------------------------
// Compile the shipped modules (security.ts + the pure Phase 20 modules)
// ---------------------------------------------------------------------------
const OUT = path.join(WORK, "emit");
fs.mkdirSync(OUT, { recursive: true });
const MODULES = [
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/rate-limit.ts",
  "src/lib/content-security-policy.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      lib: ["es2022"],
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
} catch (e) {
  console.error(String(e.stdout || ""));
  console.error(String(e.stderr || e.message || e));
}

const EMIT = path.join(OUT, "src", "lib");
for (const f of ["security.js", "rate-limit.js", "content-security-policy.js"]) {
  if (!fs.existsSync(path.join(EMIT, f))) {
    throw new Error(`tsc did not emit ${f}`);
  }
}

// Shim @/lib/db so security.ts's default client resolves to the real-SQLite
// adapter (security.ts also imports @/lib/env, which is pure).
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

const Security = require(path.join(EMIT, "security.js"));
const RateLimit = require(path.join(EMIT, "rate-limit.js"));
const Csp = require(path.join(EMIT, "content-security-policy.js"));

// ---------------------------------------------------------------------------
// 1. checkRateLimit determinism / boundedness / block / window reset
// ---------------------------------------------------------------------------
console.log("\n-- 1. checkRateLimit (real SQLite) --");
{
  const bucket = "rl:test";
  const identifier = "hashed-user-1";
  const limit = 3;
  const results = [];
  for (let i = 0; i < 5; i++) {
    results.push(
      await Security.checkRateLimit(bucket, identifier, limit, 60, 120, rlClient)
    );
  }
  eq(
    results.slice(0, 3).map((r) => r.allowed),
    [true, true, true],
    "first `limit` requests are allowed"
  );
  eq(results[3].allowed, false, "request 4 is refused");
  eq(results[4].allowed, false, "request 5 stays refused (block window)");
  ok(results[3].retryAfterSec > 0, "refusal reports Retry-After");
  ok(results.slice(0, 3).every((r) => r.remaining >= 0), "remaining never negative");

  const row = sqlite
    .prepare(
      `SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`
    )
    .get(bucket, identifier);
  eq(row.count, limit, "stored counter never exceeds the limit");
  ok(row.blockedUntil !== null, "block engaged a blockedUntil timestamp");
  eq(
    row.identifier,
    identifier,
    "primitive stores the exact identifier it was given (hashing is the caller's contract)"
  );

  // Window reset: force the window into the past → allowed again, count reset.
  sqlite
    .prepare(
      `UPDATE "SecurityRateLimit" SET "windowStart" = ?, "blockedUntil" = NULL WHERE "bucket" = ? AND "identifier" = ?`
    )
    .run(new Date(Date.now() - 61_000).toISOString(), bucket, identifier);
  const afterReset = await Security.checkRateLimit(bucket, identifier, limit, 60, 120, rlClient);
  eq(afterReset.allowed, true, "expired window resets the limiter");
  const rowAfter = sqlite
    .prepare(
      `SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`
    )
    .get(bucket, identifier);
  eq(rowAfter.count, 1, "reset window starts the counter at 1");
}

// ---------------------------------------------------------------------------
// 2. Atomicity: concurrent guarded increments cannot overshoot
// ---------------------------------------------------------------------------
console.log("\n-- 2. atomic increment (no overshoot under concurrency) --");
{
  const bucket = "rl:atomic";
  const identifier = "hashed-user-2";
  const limit = 10;
  // Fire 40 concurrent checks; the guarded UPDATE can admit at most `limit`.
  const outcomes = await Promise.all(
    Array.from({ length: 40 }, () =>
      Security.checkRateLimit(bucket, identifier, limit, 60, 60, rlClient)
    )
  );
  const allowed = outcomes.filter((r) => r.allowed).length;
  eq(allowed, limit, "exactly `limit` of 40 concurrent requests are admitted");
  const row = sqlite
    .prepare(
      `SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`
    )
    .get(bucket, identifier);
  eq(row.count, limit, "counter lands on exactly the limit (no overshoot)");
}

// ---------------------------------------------------------------------------
// 3. rate-limit.ts policy: config resolution, clamping, headers, identifiers
// ---------------------------------------------------------------------------
console.log("\n-- 3. rate-limit.ts policy --");
{
  eq(RateLimit.DEFAULT_RATE_LIMITS.heartbeat.limit, 300, "heartbeat default = 300/min");
  eq(RateLimit.DEFAULT_RATE_LIMITS.open.blockSec, 300, "open default block = 5 min");

  const overridden = RateLimit.resolveRateLimitConfig("heartbeat", {
    RATE_LIMIT_HEARTBEAT: "10/30/30",
  });
  eq(overridden, { limit: 10, windowSec: 30, blockSec: 30 }, "env override parsed");

  const clamped = RateLimit.resolveRateLimitConfig("heartbeat", {
    RATE_LIMIT_HEARTBEAT: "0/0/999999999",
  });
  eq(clamped.limit, 1, "limit clamped up to 1 (never 0/disabled)");
  eq(clamped.windowSec, 1, "window clamped to minimum");
  eq(clamped.blockSec, RateLimit.RATE_LIMIT_BOUNDS.blockMaxSec, "block clamped to maximum");

  const garbage = RateLimit.resolveRateLimitConfig("open", {
    RATE_LIMIT_OPEN: "not-a-number",
  });
  eq(garbage, RateLimit.DEFAULT_RATE_LIMITS.open, "unparseable override falls back to default");

  const id = RateLimit.rateLimitIdentifier("heartbeat", "user-123");
  ok(id !== "user-123" && /^[0-9a-f]{64}$/.test(id), "identifier is a SHA-256 hex digest");
  ok(RateLimit.rateLimitBucket("open") === "rl:open", "bucket name is namespaced");

  const headers = RateLimit.rateLimitHeaders(
    { limit: 10, windowSec: 60, blockSec: 60 },
    { allowed: false, remaining: 0, retryAfterSec: 42 }
  );
  eq(headers["X-RateLimit-Limit"], "10", "X-RateLimit-Limit present");
  eq(headers["X-RateLimit-Remaining"], "0", "X-RateLimit-Remaining present");
  eq(headers["Retry-After"], "42", "Retry-After present on refusal");

  // enforceRateLimit with a deterministic fake check.
  const fakeCheck = async () => ({ allowed: false, remaining: 0, retryAfterSec: 7 });
  const outcome = await RateLimit.enforceRateLimit({
    key: "open",
    userId: "user-123",
    check: fakeCheck,
  });
  eq(outcome.allowed, false, "enforceRateLimit propagates a refusal");
  eq(outcome.body.code, "RATE_LIMITED", "refusal body carries the machine code");
  eq(outcome.headers["Retry-After"], "7", "refusal carries Retry-After");

  // End-to-end: a raw user id flows through enforceRateLimit into the REAL
  // DB-backed primitive, and the raw id never lands in the table — the stored
  // identifier is the SHA-256 of `rl:<key>:<userId>`.
  const e2eBucket = RateLimit.rateLimitBucket("heartbeat");
  const e2eId = RateLimit.rateLimitIdentifier("heartbeat", "raw-user-42");
  const e2eCheck = (bucket, identifier, lim, win, block) =>
    Security.checkRateLimit(bucket, identifier, lim, win, block, rlClient);
  await RateLimit.enforceRateLimit({
    key: "heartbeat",
    userId: "raw-user-42",
    check: e2eCheck,
  });
  const e2eRow = sqlite
    .prepare(
      `SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`
    )
    .get(e2eBucket, e2eId);
  ok(e2eRow, "end-to-end limit row exists at the hashed identifier");
  ok(
    e2eRow && e2eRow.identifier !== "raw-user-42",
    "end-to-end: the raw user id never lands in the table"
  );
}

// ---------------------------------------------------------------------------
// 4. content-security-policy.ts
// ---------------------------------------------------------------------------
console.log("\n-- 4. content-security-policy.ts --");
{
  const prod = Csp.decideCspHeader({ NODE_ENV: "production" });
  ok(prod && prod.header === "Content-Security-Policy", "production emits an ENFORCED CSP");
  ok(!Csp.containsUnsafeEval(prod.value), "production CSP has NO unsafe-eval");
  ok(/'unsafe-inline'/.test(prod.value), "unsafe-inline present (Next.js bootstrap + inline styles)");
  ok(/frame-src/.test(prod.value) && /https:/.test(prod.value), "video embeds preserved (frame-src https:)");
  ok(/media-src/.test(prod.value) && /blob:/.test(prod.value), "native video preserved (media-src blob:)");
  ok(/object-src 'none'/.test(prod.value), "object-src locked to 'none'");
  ok(/frame-ancestors 'self'/.test(prod.value), "frame-ancestors 'self'");

  const dev = Csp.decideCspHeader({ NODE_ENV: "development" });
  ok(dev && dev.header === "Content-Security-Policy", "development emits a CSP");
  ok(Csp.containsUnsafeEval(dev.value), "development widens script-src with unsafe-eval (HMR)");

  const reportOnly = Csp.decideCspHeader({ NODE_ENV: "production", CSP_REPORT_ONLY: "1" });
  ok(
    reportOnly && reportOnly.header === "Content-Security-Policy-Report-Only",
    "CSP_REPORT_ONLY=1 downgrades to report-only"
  );
  const disabled = Csp.decideCspHeader({ NODE_ENV: "production", CSP_DISABLED: "1" });
  eq(disabled, null, "CSP_DISABLED=1 removes the header");

  const parsed = Csp.parseCsp(prod.value);
  ok(Array.isArray(parsed["script-src"]) && parsed["script-src"].includes("'self'"), "script-src parses with 'self'");
  ok(!parsed["script-src"].includes("'unsafe-eval'"), "production script-src never contains unsafe-eval");
}

// ---------------------------------------------------------------------------
console.log(`\nPhase 20 verify: ${pass} passed, ${fail} failed`);
if (fail) {
  console.error("PHASE20_VERIFY_FAIL");
  process.exit(1);
}
console.log("PHASE20_VERIFY_OK");
process.exit(0);
