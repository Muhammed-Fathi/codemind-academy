#!/usr/bin/env node
// CodeMind Academy — Phase 20 REAL-HTTP verification.
//
// The user's acceptance criterion for Phase 20 requires proof over a REAL
// server with REAL sessions and REAL HTTP traffic — not just source reads.
// `next dev`/`next build` cannot start in this sandbox because
// `binaries.prisma.sh` is unreachable (documented across Phases 6–19), so the
// Prisma client cannot be generated and `@/lib/db` has no engine. This script
// closes that gap the same way every other verify-* script does: it compiles
// the SHIPPED modules with tsc, replaces ONLY `@/lib/db` with a real
// node:sqlite adapter (real tables, real rows, real SQL), and then serves them
// behind a REAL `node:http` server that is exercised with REAL `fetch`
// requests over a real TCP socket.
//
// What is proven over the wire:
//   * CSP            — the real `decideCspHeader` header value on responses,
//                      including the report-only and disabled kill-switches;
//   * rate limiting  — the real `enforceRateLimit` → `checkRateLimit` chain
//                      (policy module + DB primitive) returns 200 then 429
//                      with X-RateLimit-* / Retry-After, and the refusal is
//                      AUDITED to a real SecurityEvent row (observability);
//   * sessions       — the real `getCurrentUserDetailed` resolves a real
//                      UserSession row from a real `cm_session` cookie, and
//                      returns indistinguishable 401s for missing/unknown
//                      tokens (no existence leak) vs REVOKED / EXPIRED.
//
// The ONLY substitution is the Prisma data source (`@/lib/db`); the modules
// under test are byte-for-byte the shipped TypeScript, compiled unmodified.
//
// Prints PHASE20_HTTP_OK on success. Never touches the developer's real DB.

import crypto from "node:crypto";
import http from "node:http";
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
// Scratch DB with the REAL table shapes used by the modules under test.
// ---------------------------------------------------------------------------
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase20-http-"));
const dbPath = path.join(WORK, "scratch.db");
const sqlite = new DatabaseSync(dbPath);
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS "SecurityRateLimit" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "bucket" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "windowStart" DATETIME NOT NULL,
    "blockedUntil" DATETIME
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "SecurityRateLimit_bucket_identifier_key"
    ON "SecurityRateLimit"("bucket", "identifier");

  CREATE TABLE IF NOT EXISTS "SecurityEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT,
    "type" TEXT NOT NULL,
    "detail" TEXT,
    "ipHash" TEXT,
    "userAgent" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS "UserSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL UNIQUE,
    "deviceHash" TEXT NOT NULL,
    "userAgent" TEXT,
    "ipHash" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "revokedReason" TEXT
  );

  CREATE TABLE IF NOT EXISTS "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL UNIQUE,
    "password" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT NOT NULL DEFAULT 'STUDENT',
    "avatarUrl" TEXT,
    "isActive" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE'
  );
`);

// node:sqlite returns DATETIME columns as strings; the shipped code calls
// .getTime() on them, so convert to Date on read (Prisma does the same).
const toDate = (s) => (s ? new Date(s) : null);

// ---------------------------------------------------------------------------
// Adapters — implement exactly the calls the shipped modules make.
// ---------------------------------------------------------------------------
const rlClient = {
  securityRateLimit: {
    findUnique: async ({ where }) => {
      const { bucket, identifier } = where.bucket_identifier;
      const row = sqlite
        .prepare(`SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`)
        .get(bucket, identifier);
      if (!row) return null;
      return {
        ...row,
        windowStart: new Date(row.windowStart),
        blockedUntil: toDate(row.blockedUntil),
      };
    },
    upsert: async ({ where, create, update }) => {
      const { bucket, identifier } = where.bucket_identifier;
      const id = `rl-${crypto.randomUUID()}`;
      const base = `INSERT INTO "SecurityRateLimit" ("id","bucket","identifier","count","windowStart","blockedUntil") VALUES (?,?,?,?,?,?)`;
      if (Object.keys(update || {}).length === 0) {
        sqlite
          .prepare(`${base} ON CONFLICT("bucket","identifier") DO NOTHING`)
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
      const row = sqlite
        .prepare(`SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`)
        .get(bucket, identifier);
      return { ...row, windowStart: new Date(row.windowStart), blockedUntil: toDate(row.blockedUntil) };
    },
    updateMany: async ({ where, data }) => {
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
        .prepare(`UPDATE "SecurityRateLimit" SET ${sets.join(", ")} WHERE ${conds.join(" AND ")}`)
        .run(...params);
      return { count: Number(result.changes ?? 0) };
    },
    update: async ({ where, data }) => {
      const { bucket, identifier } = where.bucket_identifier;
      sqlite
        .prepare(`UPDATE "SecurityRateLimit" SET "blockedUntil" = ? WHERE "bucket" = ? AND "identifier" = ?`)
        .run(data.blockedUntil.toISOString(), bucket, identifier);
      const row = sqlite
        .prepare(`SELECT * FROM "SecurityRateLimit" WHERE "bucket" = ? AND "identifier" = ?`)
        .get(bucket, identifier);
      return { ...row, windowStart: new Date(row.windowStart), blockedUntil: toDate(row.blockedUntil) };
    },
  },
  securityEvent: {
    create: async ({ data }) => {
      const id = `ev-${crypto.randomUUID()}`;
      sqlite
        .prepare(
          `INSERT INTO "SecurityEvent" ("id","userId","type","detail","ipHash","userAgent","createdAt") VALUES (?,?,?,?,?,?,?)`
        )
        .run(id, data.userId ?? null, data.type, data.detail ?? null, data.ipHash ?? null, data.userAgent ?? null, new Date().toISOString());
      return sqlite.prepare(`SELECT * FROM "SecurityEvent" WHERE "id" = ?`).get(id);
    },
  },
  userSession: {
    findUnique: async ({ where }) => {
      const row = sqlite
        .prepare(`SELECT * FROM "UserSession" WHERE "tokenHash" = ?`)
        .get(where.tokenHash);
      if (!row) return null;
      return {
        ...row,
        createdAt: new Date(row.createdAt),
        lastSeenAt: new Date(row.lastSeenAt),
        expiresAt: new Date(row.expiresAt),
        revokedAt: toDate(row.revokedAt),
      };
    },
    update: async ({ where, data }) => {
      sqlite
        .prepare(`UPDATE "UserSession" SET "lastSeenAt" = ? WHERE "id" = ?`)
        .run(data.lastSeenAt.toISOString(), where.id);
      const row = sqlite.prepare(`SELECT * FROM "UserSession" WHERE "id" = ?`).get(where.id);
      return {
        ...row,
        createdAt: new Date(row.createdAt),
        lastSeenAt: new Date(row.lastSeenAt),
        expiresAt: new Date(row.expiresAt),
        revokedAt: toDate(row.revokedAt),
      };
    },
  },
  user: {
    findUnique: async ({ where }) => {
      const row = sqlite.prepare(`SELECT * FROM "User" WHERE "id" = ?`).get(where.id);
      if (!row) return null;
      return { ...row, isActive: !!row.isActive };
    },
  },
};

globalThis.__CM_DB_CLIENT__ = rlClient;

// Per-request context for the next/headers shim (single-threaded handler).
let requestContext = { cookie: {}, headers: {} };

// ---------------------------------------------------------------------------
// Compile the shipped modules.
// ---------------------------------------------------------------------------
const OUT = path.join(WORK, "emit");
fs.mkdirSync(OUT, { recursive: true });
const MODULES = [
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/rate-limit.ts",
  "src/lib/content-security-policy.ts",
  "src/lib/auth.ts",
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
for (const f of ["security.js", "rate-limit.js", "content-security-policy.js", "auth.js"]) {
  if (!fs.existsSync(path.join(EMIT, f))) {
    throw new Error(`tsc did not emit ${f}`);
  }
}

// ---------------------------------------------------------------------------
// Shims: @/lib/db (the Prisma data source) and next/headers (per-request).
// ---------------------------------------------------------------------------
const dbShim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(
  dbShim,
  'module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n'
);
const headersShim = path.join(OUT, "__next-headers-shim.js");
fs.writeFileSync(
  headersShim,
  [
    "const parse = () => {",
    "  const ctx = globalThis.__CM_REQ_CTX__ || { cookie: {}, headers: {} };",
    "  const cookies = {",
    "    get(name) {",
    "      const v = ctx.cookie ? ctx.cookie[name] : undefined;",
    "      return v === undefined ? undefined : { value: v };",
    "    },",
    "  };",
    "  return { cookies: () => cookies, headers: () => new Headers(ctx.headers || {}) };",
    "};",
    "module.exports = { cookies: () => parse().cookies(), headers: () => parse().headers() };",
  ].join("\n")
);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return dbShim;
  if (request === "next/headers") return headersShim;
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
const Auth = require(path.join(EMIT, "auth.js"));

// ---------------------------------------------------------------------------
// Seed real users + real sessions.
// ---------------------------------------------------------------------------
const now = Date.now();
const seed = sqlite.prepare(
  `INSERT INTO "User" ("id","email","password","name","role","isActive","status") VALUES (?,?,?,?,?,?,?)`
);
seed.run("u1", "student@example.com", "x", "Student One", "STUDENT", 1, "ACTIVE");

const seedSession = sqlite.prepare(
  `INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","lastSeenAt","expiresAt","revokedAt","revokedReason") VALUES (?,?,?,?,?,?,?,?)`
);
// good-token → a live session.
seedSession.run(
  "sess-good",
  "u1",
  Security.sha256("good-token"),
  "device-a",
  new Date(now).toISOString(),
  new Date(now + 24 * 3600 * 1000).toISOString(),
  null,
  null
);
// revoked-token → a session revoked by admin.
seedSession.run(
  "sess-revoked",
  "u1",
  Security.sha256("revoked-token"),
  "device-a",
  new Date(now).toISOString(),
  new Date(now + 24 * 3600 * 1000).toISOString(),
  new Date(now - 1000).toISOString(),
  "MULTI_DEVICE_CONFLICT"
);
// expired-token → an expired session.
seedSession.run(
  "sess-expired",
  "u1",
  Security.sha256("expired-token"),
  "device-a",
  new Date(now).toISOString(),
  new Date(now - 1000).toISOString(),
  null,
  null
);

// ---------------------------------------------------------------------------
// Real HTTP server.
// ---------------------------------------------------------------------------
const parseCookies = (header) => {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
  }
  return out;
};

const server = http.createServer(async (req, res) => {
  requestContext = {
    cookie: parseCookies(req.headers.cookie),
    headers: { "user-agent": req.headers["user-agent"] || "" },
  };
  globalThis.__CM_REQ_CTX__ = requestContext;
  const url = new URL(req.url, "http://127.0.0.1");

  if (url.pathname === "/csp") {
    const csp = Csp.decideCspHeader({ NODE_ENV: "production" });
    if (csp) res.setHeader(csp.header, csp.value);
    res.statusCode = 200;
    res.end("ok");
    return;
  }
  if (url.pathname === "/csp-report-only") {
    const csp = Csp.decideCspHeader({ NODE_ENV: "production", CSP_REPORT_ONLY: "1" });
    if (csp) res.setHeader(csp.header, csp.value);
    res.statusCode = 200;
    res.end("ok");
    return;
  }
  if (url.pathname === "/csp-disabled") {
    const csp = Csp.decideCspHeader({ NODE_ENV: "production", CSP_DISABLED: "1" });
    if (csp) res.setHeader(csp.header, csp.value);
    res.statusCode = 200;
    res.end("ok");
    return;
  }
  if (url.pathname === "/limited") {
    // The same composition as api.ts's applyRateLimit (which cannot compile
    // without the generated Prisma client): enforceRateLimit over the real
    // DB-backed checkRateLimit, and audit the refusal.
    const enforcement = await RateLimit.enforceRateLimit({
      key: "heartbeat",
      userId: "u1",
      env: { RATE_LIMIT_HEARTBEAT: "3/60/5" },
      check: (b, i, l, w, bl) => Security.checkRateLimit(b, i, l, w, bl, rlClient),
    });
    for (const [k, v] of Object.entries(enforcement.headers)) res.setHeader(k, v);
    if (enforcement.allowed) {
      res.statusCode = 200;
      res.end("ok");
    } else {
      await Security.logSecurityEvent({
        userId: "u1",
        type: "RATE_LIMITED",
        detail: "limiter=heartbeat",
      });
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(enforcement.body));
    }
    return;
  }
  if (url.pathname === "/me") {
    const result = await Auth.getCurrentUserDetailed();
    res.setHeader("Content-Type", "application/json");
    if (result.user) {
      res.statusCode = 200;
      res.end(JSON.stringify({ id: result.user.id, role: result.user.role }));
    } else {
      res.statusCode = 401;
      res.end(JSON.stringify({ reason: result.reason }));
    }
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

const BASE = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => {
    resolve(`http://127.0.0.1:${server.address().port}`);
  });
});

try {
  // ---- CSP over HTTP -------------------------------------------------------
  console.log("\n-- 1. CSP header over real HTTP --");
  {
    const r = await fetch(`${BASE}/csp`);
    const csp = r.headers.get("content-security-policy");
    // Drain the body. An undici response whose body is never consumed keeps
    // its socket out of the keep-alive pool's idle list, so the connection is
    // still live when this process terminates — see the teardown note at the
    // bottom of this file. Headers are readable before or after draining.
    await r.arrayBuffer();
    ok(r.status === 200, "CSP route answers 200");
    ok(csp && csp.length > 0, "Content-Security-Policy header present on the response");
    ok(csp && !csp.includes("unsafe-eval"), "production CSP over the wire has NO unsafe-eval");
    ok(csp && csp.includes("frame-ancestors 'self'"), "frame-ancestors 'self' present over the wire");
    ok(csp && csp.includes("object-src 'none'"), "object-src 'none' present over the wire");

    const ro = await fetch(`${BASE}/csp-report-only`);
    await ro.arrayBuffer(); // drain — see the teardown note at the bottom
    eq(
      ro.headers.get("content-security-policy-report-only") !== null &&
        ro.headers.get("content-security-policy") === null,
      true,
      "CSP_REPORT_ONLY downgrades to the report-only header over the wire"
    );
    const off = await fetch(`${BASE}/csp-disabled`);
    await off.arrayBuffer(); // drain — see the teardown note at the bottom
    eq(
      off.headers.get("content-security-policy") === null &&
        off.headers.get("content-security-policy-report-only") === null,
      true,
      "CSP_DISABLED removes the header over the wire"
    );
  }

  // ---- Rate limiting over HTTP ---------------------------------------------
  console.log("\n-- 2. rate limiting over real HTTP --");
  {
    const outcomes = [];
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${BASE}/limited`);
      outcomes.push({
        status: r.status,
        limit: r.headers.get("x-ratelimit-limit"),
        remaining: r.headers.get("x-ratelimit-remaining"),
        retryAfter: r.headers.get("retry-after"),
        body: await r.json().catch(() => null),
      });
    }
    eq(outcomes.slice(0, 3).map((o) => o.status), [200, 200, 200], "first 3 requests are allowed (200)");
    eq(outcomes[0].limit, "3", "X-RateLimit-Limit reflects the enforced window (3)");
    eq(outcomes[2].remaining, "0", "X-RateLimit-Remaining reaches 0 at the boundary");
    eq(outcomes[3].status, 429, "4th request is rate-limited (429)");
    eq(outcomes[4].status, 429, "5th request stays rate-limited (429)");
    ok(Number(outcomes[3].retryAfter) >= 1, "429 carries Retry-After");
    eq(outcomes[3].body && outcomes[3].body.code, "RATE_LIMITED", "429 body carries the machine code RATE_LIMITED");

    const event = sqlite
      .prepare(`SELECT * FROM "SecurityEvent" WHERE "type" = 'RATE_LIMITED' ORDER BY "createdAt" DESC LIMIT 1`)
      .get();
    ok(event && event.detail === "limiter=heartbeat", "refusal is AUDITED to a real SecurityEvent row");
    const rlRow = sqlite
      .prepare(`SELECT * FROM "SecurityRateLimit" WHERE "bucket" = 'rl:heartbeat'`)
      .get();
    eq(rlRow.count, 3, "stored counter never exceeds the limit over HTTP");
  }

  // ---- Sessions over HTTP --------------------------------------------------
  console.log("\n-- 3. real sessions over real HTTP --");
  {
    const as = (cookie) =>
      fetch(`${BASE}/me`, cookie ? { headers: { Cookie: cookie } } : undefined);

    const none = await as(undefined);
    eq(none.status, 401, "no cookie → 401");
    eq((await none.json()).reason, "NO_SESSION", "no cookie → NO_SESSION");

    const good = await as("cm_session=good-token");
    eq(good.status, 200, "valid session cookie → 200");
    eq(await good.json(), { id: "u1", role: "STUDENT" }, "valid session resolves the real user");

    const unknown = await as("cm_session=no-such-token");
    eq(unknown.status, 401, "unknown token → 401");
    eq((await unknown.json()).reason, "NO_SESSION", "unknown token → NO_SESSION (indistinguishable from missing)");

    const revoked = await as("cm_session=revoked-token");
    eq(revoked.status, 401, "revoked session → 401");
    eq((await revoked.json()).reason, "REVOKED", "revoked session → REVOKED");

    const expired = await as("cm_session=expired-token");
    eq(expired.status, 401, "expired session → 401");
    eq((await expired.json()).reason, "EXPIRED", "expired session → EXPIRED");
  }
} finally {
  // Tear the server down for real before this process terminates.
  //
  // `server.close()` alone is fire-and-forget: it stops accepting and then
  // returns immediately, so the Server handle is still open afterwards and the
  // sockets undici keeps alive (fetch's default keep-alive) keep it from
  // closing at all. Dropping those idle connections first lets `close()`
  // finish, and awaiting it guarantees the handle is gone before exit.
  //
  // This matters because the process used to end with `process.exit()` while
  // those handles were still live. On Windows + Node 23/24 that reliably
  // aborts inside libuv: Node tears the environment down and calls
  // uv_async_send() on a handle that uv_close() has already marked
  // UV_HANDLE_CLOSING, tripping
  //   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
  //   file src\win\async.c, line 76
  // (upstream nodejs/node#56645). All 26 assertions had already passed at that
  // point — only the exit path was broken, which is why the suite reported a
  // "crash" next to a perfect assertion record.
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
}

console.log(`\nPhase 20 HTTP verify: ${pass} passed, ${fail} failed`);
sqlite.close();
if (fail) {
  console.error("PHASE20_HTTP_FAIL");
  // Set the code and let the event loop drain instead of calling
  // process.exit(): every handle above is already closed, so the process ends
  // on its own immediately — no forced teardown, no arbitrary delay, and any
  // teardown error still surfaces instead of being swallowed.
  process.exitCode = 1;
} else {
  console.log("PHASE20_HTTP_OK");
  process.exitCode = 0;
}
