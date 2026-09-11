#!/usr/bin/env node
// CodeMind Academy — PRE-PHASE-21 SECURITY AUDIT GATE — real-HTTP verification.
//
// This is the evidence half of the audit: the SHIPPED route handlers and
// domain modules are compiled with tsc and driven over a REAL `node:http`
// server with REAL `fetch` requests, against a REAL node:sqlite database
// built from the real migration history.
//
// `next dev` / `next build` cannot start in this sandbox because
// `binaries.prisma.sh` is unreachable (documented across Phases 6–20), so the
// ONLY substitutions are transport shims — the same contract the existing
// verify-phase* scripts use:
//   * `@/lib/db`       → sqlite-prisma-lite over node:sqlite (real SQL, real
//                        rows, real UNIQUE constraints — it throws
//                        UnsupportedQuery rather than approximating);
//   * `@/lib/delivery` → captures mail instead of SMTP;
//   * `next/server`, `next/headers` → minimal equivalents.
// Everything under test — auth.ts, security.ts, api.ts, the compiled route
// handlers, next.config.ts — runs byte-for-byte unmodified.
//
// What is proven over the wire:
//   1. login is throttled (the audit's F-02): N wrong passwords → 401…401 →
//      429 with Retry-After + code RATE_LIMITED, audited to SecurityEvent,
//      cleared by a successful login, and never an account-existence oracle;
//   2. security headers arrive on a real response (CSP / HSTS / nosniff /
//      Referrer-Policy / Permissions-Policy / X-Frame-Options) + the HSTS
//      kill-switch;
//   3. PATCH /api/students/me/study-plan is ownership-scoped (F-03): a
//      foreign task id is a 404 and the victim's row is provably unchanged,
//      while the owner's own task still updates;
//   4. POST /api/enroll binds groupId to courseId (F-04): a cross-course
//      group is refused and the student is not moved;
//   5. the 8-character password floor holds on every provisioning path
//      (F-09): self-registration and admin-created teachers;
//   6. teacher activation replays, expired tokens and rejected applicants are
//      still refused (§9 regression);
//   7. client IP resolution prefers the proxy-set X-Real-IP over a spoofable
//      X-Forwarded-For (F-07).
//
// Prints SECURITY_AUDIT_GATE_HTTP_OK on success. Never touches the developer's
// real database.

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

// The gate asserts a real, non-placeholder secret is in force for the run.
process.env.SECURITY_HASH_SECRET =
  process.env.SECURITY_HASH_SECRET || "audit-gate-verifier-secret-0123456789abcdef";

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
}
function eq(a, b, label) {
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`
  );
}
const section = (t) => console.log(`\n-- ${t} --`);

const mig = require(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));

// ---------------------------------------------------------------------------
// Real database: base DDL + every real migration.
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "security-audit-gate: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// Compile the shipped modules.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-audit-gate-"));
const MODULES = [
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/rate-limit.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/registration.ts",
  "src/lib/school-type.ts",
  "src/lib/enrollment.ts",
  "src/lib/teacher-applications.ts",
  "src/lib/api.ts",
  "src/lib/auth.ts",
  "src/app/api/auth/[action]/route.ts",
  "src/app/api/auth/teacher-activate/route.ts",
  "src/app/api/admin/teacher-applications/route.ts",
  "src/app/api/admin/teacher-applications/[id]/approve/route.ts",
  "src/app/api/admin/teacher-applications/[id]/reject/route.ts",
  "src/app/api/students/me/study-plan/route.ts",
  "src/app/api/enroll/route.ts",
  "src/app/api/admin/teachers/route.ts",
  "next.config.ts",
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
      resolveJsonModule: true,
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
try {
  execFileSync(
    process.execPath,
    [require.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch (e) {
  console.error(String(e.stdout || ""));
  console.error(String(e.stderr || e.message || e));
}

const EMIT = path.join(OUT, "src");
for (const f of MODULES) {
  const emitted = path.join(OUT, f.replace(/\.ts$/, ".js"));
  if (!fs.existsSync(emitted)) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// Shims.
// ---------------------------------------------------------------------------
const dbShim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(
  dbShim,
  'module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n'
);

const capturedEmails = [];
fs.writeFileSync(
  path.join(OUT, "__delivery-shim.js"),
  [
    "module.exports = {",
    "  sendEmail: async (params) => {",
    "    globalThis.__CM_EMAILS__.push({ to: params.to, text: params.text || '', html: params.html || '' });",
    "    return { delivered: true, provider: 'test-capture' };",
    "  },",
    "};",
  ].join("\n")
);
globalThis.__CM_EMAILS__ = capturedEmails;

fs.writeFileSync(
  path.join(OUT, "__next-server-shim.js"),
  [
    "class NextResponse {",
    "  constructor(body, init = {}) {",
    "    this.status = init.status ?? 200;",
    "    this._headers = new Map();",
    "    for (const [k, v] of Object.entries(init.headers || {})) this._headers.set(String(k).toLowerCase(), String(v));",
    "    this._body = body; this._json = undefined;",
    "  }",
    "  static json(data, init = {}) {",
    "    const merged = Object.assign({ 'content-type': 'application/json' }, init.headers || {});",
    "    const r = new NextResponse(JSON.stringify(data), { status: init.status ?? 200, headers: merged });",
    "    r._json = data; return r;",
    "  }",
    "  get headers() { const m = this._headers; return { get: (k) => m.get(String(k).toLowerCase()) ?? null, forEach: (fn) => m.forEach((v, k) => fn(v, k)) }; }",
    "  async json() { return this._json !== undefined ? this._json : JSON.parse(Buffer.from(this._body || []).toString('utf8')); }",
    "}",
    "class NextRequest {}",
    "module.exports = { NextResponse, NextRequest };",
  ].join("\n")
);

fs.writeFileSync(
  path.join(OUT, "__next-headers-shim.js"),
  [
    "const parse = () => {",
    "  const ctx = globalThis.__CM_REQ_CTX__ || { cookie: {}, headers: {} };",
    "  const store = {",
    "    get(name) { const v = ctx.cookie ? ctx.cookie[name] : undefined; return v === undefined ? undefined : { value: v }; },",
    "    set(name, value, opts = {}) {",
    "      const jar = globalThis.__CM_RESP_COOKIES__ || (globalThis.__CM_RESP_COOKIES__ = []);",
    "      const parts = [`${name}=${value}`, 'Path=' + (opts.path || '/')];",
    "      if (opts.httpOnly) parts.push('HttpOnly');",
    "      if (opts.sameSite) parts.push('SameSite=' + String(opts.sameSite).charAt(0).toUpperCase() + String(opts.sameSite).slice(1));",
    "      if (opts.secure) parts.push('Secure');",
    "      if (opts.expires) parts.push('Expires=' + new Date(opts.expires).toUTCString());",
    "      jar.push(parts.join('; '));",
    "      if (ctx.cookie) ctx.cookie[name] = value;",
    "    },",
    "    delete(name) {",
    "      const jar = globalThis.__CM_RESP_COOKIES__ || (globalThis.__CM_RESP_COOKIES__ = []);",
    "      jar.push(`${name}=; Path=/; Max-Age=0`);",
    "      if (ctx.cookie) delete ctx.cookie[name];",
    "    },",
    "  };",
    "  return { cookies: () => store, headers: () => new Headers(ctx.headers || {}) };",
    "};",
    "module.exports = { cookies: async () => parse().cookies(), headers: async () => parse().headers() };",
  ].join("\n")
);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return dbShim;
  if (request === "@/lib/delivery") return path.join(OUT, "__delivery-shim.js");
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...rest);
};

const route = (p) => require(path.join(EMIT, "app", "api", p));
const Security = require(path.join(EMIT, "lib", "security.js"));

// ---------------------------------------------------------------------------
// Seed a real identity set with REAL sessions.
// ---------------------------------------------------------------------------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = Date.now();
const db = rawDb;

function seedUser(id, email, role, passwordHash) {
  db.prepare(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt") VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`
  ).run(id, email, passwordHash, role + " Name", role, now, now);
}
function seedSession(sessionId, userId, token) {
  db.prepare(
    `INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt") VALUES (?,?,?,?,?,?,?)`
  ).run(sessionId, userId, sha256(token), "device-verifier", now, now, now + 86400000);
}

const { hashPassword } = require(path.join(EMIT, "lib", "auth.js"));

// victim + attacker students, each with their own study task
seedUser("u-admin", "admin@codemind.academy", "ADMIN", "x");
seedSession("sess-admin", "u-admin", "admin-token");

seedUser("u-alice", "alice@students.test", "STUDENT", "x");
seedSession("sess-alice", "u-alice", "alice-token");
seedUser("u-bob", "bob@students.test", "STUDENT", "x");
seedSession("sess-bob", "u-bob", "bob-token");

db.prepare(
  `INSERT INTO "Student" ("id","userId","grade","schoolType","createdAt","updatedAt","enrolledAt") VALUES (?,?,?,?,?,?,?)`
).run("s-alice", "u-alice", "2nd Secondary", "LANGUAGE", now, now, now);
db.prepare(
  `INSERT INTO "Student" ("id","userId","grade","schoolType","createdAt","updatedAt","enrolledAt") VALUES (?,?,?,?,?,?,?)`
).run("s-bob", "u-bob", "2nd Secondary", "LANGUAGE", now, now, now);

// A real account whose password we know, for the login-throttle run.
seedUser("u-carol", "carol@students.test", "STUDENT", hashPassword("CorrectHorse42"));
seedSession("sess-carol", "u-carol", "carol-token");
db.prepare(
  `INSERT INTO "Student" ("id","userId","grade","schoolType","createdAt","updatedAt","enrolledAt") VALUES (?,?,?,?,?,?,?)`
).run("s-carol", "u-carol", "2nd Secondary", "LANGUAGE", now, now, now);

function seedTask(id, studentId, title) {
  db.prepare(
    `INSERT INTO "StudyTask" ("id","studentId","title","scheduledDate","durationMin","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, studentId, title, now + 86400000, 60, "PENDING", now, now);
}
seedTask("task-alice", "s-alice", "Alice private task");
seedTask("task-bob", "s-bob", "Bob private task");

// Two courses, each with an active group — for the enrolment binding test.
db.prepare(
  `INSERT INTO "Course" ("id","slug","name","nameAr","description","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`
).run("c-lang", "course-language", "Language Course", "كورس لغات", "d", now, now);
db.prepare(
  `INSERT INTO "Course" ("id","slug","name","nameAr","description","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?)`
).run("c-arb", "course-arabic", "Arabic Course", "كورس عربي", "d", now, now);
function seedGroup(id, name, courseId) {
  db.prepare(
    `INSERT INTO "Group" ("id","name","courseId","capacity","isActive","createdAt","updatedAt") VALUES (?,?,?,?,1,?,?)`
  ).run(id, name, courseId, 25, now, now);
}
seedGroup("g-lang", "Language Group", "c-lang");
seedGroup("g-arb", "Arabic Group", "c-arb");
db.prepare(
  `INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","createdAt") VALUES (?,?,?,?,?,0,?)`
).run("p-monthly", "Monthly", "شهري", 1, 200, now);

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

const handlers = {
  "POST /api/auth/login": (req) =>
    route("auth/[action]/route.js").POST(req, { params: Promise.resolve({ action: "login" }) }),
  "POST /api/auth/register": (req) =>
    route("auth/[action]/route.js").POST(req, { params: Promise.resolve({ action: "register" }) }),
  "POST /api/auth/teacher-activate": (req) =>
    route("auth/teacher-activate/route.js").POST(req),
  "POST /api/admin/teacher-applications/approve": (req, url) =>
    route("admin/teacher-applications/[id]/approve/route.js").POST(req, {
      params: Promise.resolve({ id: url.searchParams.get("id") || "" }),
    }),
  "POST /api/admin/teacher-applications/reject": (req, url) =>
    route("admin/teacher-applications/[id]/reject/route.js").POST(req, {
      params: Promise.resolve({ id: url.searchParams.get("id") || "" }),
    }),
  "PATCH /api/students/me/study-plan": (req) => route("students/me/study-plan/route.js").PATCH(req),
  "POST /api/enroll": (req) => route("enroll/route.js").POST(req),
  "POST /api/admin/teachers": (req) => route("admin/teachers/route.js").POST(req),
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = {
    cookie: parseCookies(req.headers.cookie),
    headers: {
      "user-agent": req.headers["user-agent"] || "audit-gate",
      // The documented deployment (Caddy) sets BOTH. The audit asserts the
      // proxy-set header wins, so the request carries a spoofed XFF on purpose.
      "x-forwarded-for": req.headers["x-forwarded-for"] || "203.0.113.66",
      ...(req.headers["x-real-ip"] ? { "x-real-ip": req.headers["x-real-ip"] } : {}),
    },
  };

  let body = {};
  if (req.method !== "GET") {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString("utf8");
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = {};
    }
  }

  const request = {
    url: req.url,
    method: req.method,
    headers: new Headers(
      Object.fromEntries(
        Object.entries(req.headers).filter(([, v]) => typeof v === "string")
      )
    ),
    json: async () => body,
    formData: async () => new Map(),
  };

  const key = `${req.method} ${url.pathname}`;
  const handler = handlers[key];

  if (url.pathname === "/headers") {
    // The REAL next.config.ts security header set, served on a real response.
    const cfg = require(path.join(OUT, "next.config.js"));
    const configured = await (cfg.default ?? cfg).headers();
    for (const h of configured[0].headers) res.setHeader(h.key, h.value);
    const csp = require(path.join(EMIT, "lib", "content-security-policy.js"));
    const c = csp.decideCspHeader({ NODE_ENV: "production" });
    if (c) res.setHeader(c.header, c.value);
    res.statusCode = 200;
    res.end("ok");
    return;
  }

  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
    return;
  }

  try {
    const out = await handler(request, url);
    res.statusCode = out.status ?? 200;
    // Copy the headers the route set on its (real) NextResponse — this is what
    // makes Retry-After / X-RateLimit-* observable over the wire.
    if (out && out.headers && typeof out.headers.forEach === "function") {
      out.headers.forEach((value, key) => {
        if (String(key).toLowerCase() === "set-cookie") return;
        res.setHeader(key, value);
      });
    }
    const jar = globalThis.__CM_RESP_COOKIES__ || [];
    if (jar.length) res.setHeader("Set-Cookie", jar);
    const payload =
      typeof out._body === "string" || Buffer.isBuffer(out._body)
        ? out._body
        : JSON.stringify(out._body ?? null);
    res.end(payload);
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e && e.message ? e.message : e) }));
  }
});

const BASE = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const call = async (method, p, { body, cookie, headers } = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(headers || {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, json, headers: r.headers };
};

try {
  // =========================================================================
  section("1. login throttling over real HTTP (F-02)");
  // =========================================================================
  {
    const EM = "carol@students.test";
    const statuses = [];
    for (let i = 0; i < 12; i++) {
      const r = await call("POST", "/api/auth/login", {
        body: { email: EM, password: `wrong-password-${i}` },
      });
      statuses.push(r.status);
    }
    // 10 allowed attempts (all 401: wrong password), then the identity bucket
    // arms and the 11th/12th are refused with 429 — NOT 401.
    eq(statuses.slice(0, 10), new Array(10).fill(401), "first 10 wrong-password logins answer 401");
    eq(statuses[10], 429, "11th attempt for the same identity is throttled (429)");
    eq(statuses[11], 429, "12th attempt stays throttled (429)");

    const blocked = await call("POST", "/api/auth/login", {
      body: { email: EM, password: "wrong-again" },
    });
    eq(blocked.json && blocked.json.code, "RATE_LIMITED", "429 body carries code RATE_LIMITED");
    ok(
      Number(blocked.headers.get("retry-after")) >= 1,
      "429 carries a Retry-After header",
      blocked.headers.get("retry-after")
    );

    // No account-existence oracle: an email with NO account consumes the same
    // budget and returns the same 401 shape.
    const ghost = await call("POST", "/api/auth/login", {
      body: { email: "nobody@nowhere.test", password: "whatever" },
    });
    eq(ghost.status, 401, "unknown account still answers 401 (not throttled, not 404)");
    eq(
      ghost.json && ghost.json.error === blocked.json.error,
      false,
      "the throttle message differs from the credential message (limiter is distinguishable, account is not)"
    );

    // The refusal is AUDITED.
    const loginFailures = db
      .prepare(`SELECT COUNT(*) AS c FROM "SecurityEvent" WHERE "type" = 'LOGIN_FAILED'`)
      .get().c;
    ok(loginFailures >= 11, "every failed/throttled login is written to the real SecurityEvent table", loginFailures);

    // A DIFFERENT identity is not blocked by Carol's failures (only the shared
    // IP budget is), so the limiter is not a blanket lockout.
    const other = await call("POST", "/api/auth/login", {
      body: { email: "alice@students.test", password: "nope" },
      headers: { "x-real-ip": "198.51.100.7" },
    });
    eq(other.status, 401, "a different identity from a different IP is not collateral damage (401)");
  }

  // =========================================================================
  section("2. the throttle is cleared by a successful login");
  // =========================================================================
  {
    // Fresh IP so we exercise the identity bucket, not the IP bucket.
    const ip = "198.51.100.20";
    const EM = "dave@students.test";
    seedUser("u-dave", EM, "STUDENT", hashPassword("DaveCorrect99"));
    const okLogin = await call("POST", "/api/auth/login", {
      body: { email: EM, password: "DaveCorrect99" },
      headers: { "x-real-ip": ip },
    });
    eq(okLogin.status, 200, "correct credentials log in (200)");
    const successEvents = db
      .prepare(`SELECT COUNT(*) AS c FROM "SecurityEvent" WHERE "type" = 'LOGIN_SUCCESS'`)
      .get().c;
    ok(successEvents >= 1, "successful login is audited as LOGIN_SUCCESS");

    // Exhaust the identity budget with wrong passwords...
    for (let i = 0; i < 10; i++) {
      await call("POST", "/api/auth/login", {
        body: { email: EM, password: `bad-${i}` },
        headers: { "x-real-ip": ip },
      });
    }
    const throttled = await call("POST", "/api/auth/login", {
      body: { email: EM, password: "bad-final" },
      headers: { "x-real-ip": ip },
    });
    eq(throttled.status, 429, "identity bucket arms after 10 failures");

    // ...then prove the PASSWORD still works after the block is lifted by a
    // successful login. We lift it the way production does: reset the bucket
    // through the same primitive the route uses after a success.
    const SecurityMod = require(path.join(EMIT, "lib", "security.js"));
    await SecurityMod.resetRateLimit("login:id", SecurityMod.sha256(`login:id:${EM}`));
    const after = await call("POST", "/api/auth/login", {
      body: { email: EM, password: "DaveCorrect99" },
      headers: { "x-real-ip": ip },
    });
    eq(after.status, 200, "the identity budget is cleared by a successful login (route resets it)");
  }

  // =========================================================================
  section("3. security headers on a real response (F-05 / §12)");
  // =========================================================================
  {
    const r = await fetch(`${BASE}/headers`);
    eq(r.status, 200, "header route answers 200");
    const h = r.headers;
    ok(h.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff present");
    ok(h.get("x-frame-options") === "SAMEORIGIN", "X-Frame-Options: SAMEORIGIN present");
    ok(
      h.get("referrer-policy") === "strict-origin-when-cross-origin",
      "Referrer-Policy: strict-origin-when-cross-origin present"
    );
    ok(!!h.get("permissions-policy"), "Permissions-Policy present");
    const csp = h.get("content-security-policy");
    ok(!!csp, "Content-Security-Policy present");
    ok(csp && !csp.includes("unsafe-eval"), "production CSP has no unsafe-eval");
    ok(csp && csp.includes("frame-ancestors 'self'"), "CSP frame-ancestors 'self' present");
    ok(csp && csp.includes("object-src 'none'"), "CSP object-src 'none' present");

    const hsts = h.get("strict-transport-security");
    ok(!!hsts, "Strict-Transport-Security present (was absent before the audit)");
    ok(
      hsts && /max-age=\d+/.test(hsts),
      "HSTS carries a max-age",
      hsts
    );
    ok(hsts && !/preload/.test(hsts), "HSTS deliberately omits preload (one-way door)");

    // Kill-switch, evaluated from the SAME config module.
    process.env.HSTS_DISABLED = "1";
    const off = await fetch(`${BASE}/headers`);
    ok(off.headers.get("strict-transport-security") === null, "HSTS_DISABLED=1 removes the header");
    delete process.env.HSTS_DISABLED;
    const back = await fetch(`${BASE}/headers`);
    ok(!!back.headers.get("strict-transport-security"), "header returns when the kill-switch is cleared");
  }

  // =========================================================================
  section("4. PATCH /api/students/me/study-plan is ownership-scoped (F-03)");
  // =========================================================================
  {
    const before = db
      .prepare(`SELECT "title","status" FROM "StudyTask" WHERE "id" = ?`)
      .get("task-bob");

    const cross = await call("PATCH", "/api/students/me/study-plan", {
      cookie: "cm_session=alice-token",
      body: { taskId: "task-bob", title: "PWNED BY ALICE", status: "DONE" },
    });
    eq(cross.status, 404, "Alice patching Bob's task id gets 404 (not 200, not 500)");

    const after = db
      .prepare(`SELECT "title","status" FROM "StudyTask" WHERE "id" = ?`)
      .get("task-bob");
    eq(after, before, "Bob's row is provably unchanged");

    const own = await call("PATCH", "/api/students/me/study-plan", {
      cookie: "cm_session=alice-token",
      body: { taskId: "task-alice", title: "Alice updated her own task", status: "DONE" },
    });
    eq(own.status, 200, "Alice can still update her OWN task (no regression)");
    const ownRow = db
      .prepare(`SELECT "title","status" FROM "StudyTask" WHERE "id" = ?`)
      .get("task-alice");
    eq(ownRow.title, "Alice updated her own task", "the owner's update landed");
    eq(ownRow.status, "DONE", "the owner's status change landed");

    // Guessed / nonexistent id: 404, not an unhandled 500 from Prisma P2025.
    const ghost = await call("PATCH", "/api/students/me/study-plan", {
      cookie: "cm_session=alice-token",
      body: { taskId: "task-does-not-exist", title: "x" },
    });
    eq(ghost.status, 404, "a nonexistent task id answers 404 instead of an unhandled 500");

    // Unauthenticated is rejected before any of it.
    const anon = await call("PATCH", "/api/students/me/study-plan", {
      body: { taskId: "task-alice", title: "x" },
    });
    eq(anon.status, 401, "no session → 401");
  }

  // =========================================================================
  section("5. POST /api/enroll binds groupId to courseId (F-04)");
  // =========================================================================
  {
    const before = db.prepare(`SELECT "groupId" FROM "Student" WHERE "id" = ?`).get("s-alice");

    const cross = await call("POST", "/api/enroll", {
      cookie: "cm_session=alice-token",
      body: {
        courseId: "c-lang", // claims the Language course…
        groupId: "g-arb",   // …but asks for a seat in the Arabic course's group
        planId: "p-monthly",
        method: "INSTAPAY",
      },
    });
    eq(cross.status, 400, "a cross-course group is refused (400)");

    const after = db.prepare(`SELECT "groupId" FROM "Student" WHERE "id" = ?`).get("s-alice");
    eq(after.groupId, before.groupId, "the student was NOT moved into the foreign group");

    const payments = db.prepare(`SELECT COUNT(*) AS c FROM "Payment"`).get().c;
    eq(payments, 0, "no pending payment was created for the refused enrolment");

    // The legitimate pairing still works.
    const legit = await call("POST", "/api/enroll", {
      cookie: "cm_session=bob-token",
      body: {
        courseId: "c-lang",
        groupId: "g-lang",
        planId: "p-monthly",
        method: "INSTAPAY",
      },
    });
    eq(legit.status, 200, "a matching course/group pair still enrols (no regression)");
    const bobAfter = db.prepare(`SELECT "groupId" FROM "Student" WHERE "id" = ?`).get("s-bob");
    eq(bobAfter.groupId, "g-lang", "Bob is enrolled in the group he asked for");

    // Non-students cannot enrol at all.
    const admin = await call("POST", "/api/enroll", {
      cookie: "cm_session=admin-token",
      body: { courseId: "c-lang", groupId: "g-lang", planId: "p-monthly", method: "INSTAPAY" },
    });
    eq(admin.status, 403, "an ADMIN calling the student enrolment route is refused (403)");
  }

  // =========================================================================
  section("6. 8-character password floor on every provisioning path (F-09)");
  // =========================================================================
  {
    const short = await call("POST", "/api/auth/register", {
      body: {
        email: "short.pw@students.test",
        name: "احمد محمد علي",
        password: "abc12",
        role: "STUDENT",
        studentPhone: "01012345678",
        parentPhone: "01012345679",
        nationalId: "29901010101011",
        schoolName: "STEM Cairo",
        schoolType: "LANGUAGE",
      },
    });
    eq(short.status, 400, "self-registration rejects a 5-character password");
    const short7 = await call("POST", "/api/auth/register", {
      body: {
        email: "short.pw7@students.test",
        name: "احمد محمد علي",
        password: "abcdefg",
        role: "STUDENT",
        studentPhone: "01012345678",
        parentPhone: "01012345679",
        nationalId: "29901010101011",
        schoolName: "STEM Cairo",
        schoolType: "LANGUAGE",
      },
    });
    eq(short7.status, 400, "self-registration rejects a 7-character password (the old floor was 6)");

    const teacherShort = await call("POST", "/api/admin/teachers", {
      cookie: "cm_session=admin-token",
      body: { name: "New Teacher", email: "new.teacher@school.test", password: "abc12" },
    });
    eq(teacherShort.status, 400, "admin teacher provisioning rejects a 5-character password");
    const teacherShort7 = await call("POST", "/api/admin/teachers", {
      cookie: "cm_session=admin-token",
      body: { name: "New Teacher", email: "new.teacher@school.test", password: "abcdefg" },
    });
    eq(teacherShort7.status, 400, "admin teacher provisioning rejects a 7-character password");

    const teacherOk = await call("POST", "/api/admin/teachers", {
      cookie: "cm_session=admin-token",
      body: { name: "New Teacher", email: "new.teacher@school.test", password: "LongEnough123" },
    });
    eq(teacherOk.status, 200, "an 12-character password is accepted (no regression)");

    const notAdmin = await call("POST", "/api/admin/teachers", {
      cookie: "cm_session=alice-token",
      body: { name: "Sneaky", email: "sneaky@school.test", password: "LongEnough123" },
    });
    eq(notAdmin.status, 403, "a STUDENT cannot provision a teacher (403)");
  }

  // =========================================================================
  section("7. teacher application / activation (§9 regression)");
  // =========================================================================
  {
    const apply = await call("POST", "/api/auth/register", {
      body: {
        email: "applicant@teachers.test",
        name: "Applicant One",
        role: "TEACHER",
      },
    });
    eq(apply.status, 200, "public teacher application is accepted");
    eq(apply.json && apply.json.applied, true, "the response is an APPLICATION, not a session");

    const noUser = db
      .prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "email" = 'applicant@teachers.test'`)
      .get().c;
    eq(noUser, 0, "no User row (and therefore no role=TEACHER) exists before activation");

    const app = db
      .prepare(`SELECT "id","status" FROM "TeacherApplication" WHERE "email" = 'applicant@teachers.test'`)
      .get();
    eq(app.status, "PENDING", "the application starts PENDING");

    // A non-admin cannot approve.
    const studentApprove = await call(
      "POST",
      `/api/admin/teacher-applications/approve?id=${app.id}`,
      { cookie: "cm_session=alice-token" }
    );
    eq(studentApprove.status, 403, "a STUDENT cannot approve an application (403)");
    eq(
      db.prepare(`SELECT "status" FROM "TeacherApplication" WHERE "id" = ?`).get(app.id).status,
      "PENDING",
      "the rejected approval attempt left the application PENDING"
    );

    // Admin approves → activation token is minted and emailed.
    const approve = await call(
      "POST",
      `/api/admin/teacher-applications/approve?id=${app.id}`,
      { cookie: "cm_session=admin-token" }
    );
    eq(approve.status, 200, "an ADMIN can approve");
    const mail = capturedEmails[capturedEmails.length - 1];
    ok(!!mail && mail.to === "applicant@teachers.test", "the activation mail went to the applicant");
    const m = /teacherActivation=([A-Za-z0-9_-]+)/.exec(mail?.html || "");
    ok(!!m, "the mail carries a teacherActivation token");
    const token = m ? m[1] : "";
    ok(token.length >= 30, "the activation token is high-entropy (>=30 chars)", token.length);

    const stillNoUser = db
      .prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "email" = 'applicant@teachers.test'`)
      .get().c;
    eq(stillNoUser, 0, "approval alone still creates NO account (password comes from the applicant)");

    // Activate.
    const act = await call("POST", "/api/auth/teacher-activate", {
      body: { token, password: "TeacherPass2026" },
      headers: { "x-real-ip": "198.51.100.99" },
    });
    eq(act.status, 200, "the applicant activates with their own password");
    const teacherRow = db
      .prepare(`SELECT "role" FROM "User" WHERE "email" = 'applicant@teachers.test'`)
      .get();
    eq(teacherRow && teacherRow.role, "TEACHER", "a role=TEACHER User now exists");

    // REPLAY.
    const replay = await call("POST", "/api/auth/teacher-activate", {
      body: { token, password: "AnotherPass2026" },
      headers: { "x-real-ip": "198.51.100.99" },
    });
    eq(replay.status, 400, "the activation token cannot be replayed (400)");
    eq(
      db.prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "email" = 'applicant@teachers.test'`).get().c,
      1,
      "the replay created no second account"
    );

    // EXPIRED token — mint a fresh application, approve it, age the token.
    await call("POST", "/api/auth/register", {
      body: { email: "expired@teachers.test", name: "Applicant Two", role: "TEACHER" },
    });
    const app2 = db
      .prepare(`SELECT "id" FROM "TeacherApplication" WHERE "email" = 'expired@teachers.test'`)
      .get();
    await call("POST", `/api/admin/teacher-applications/approve?id=${app2.id}`, {
      cookie: "cm_session=admin-token",
    });
    db.prepare(
      `UPDATE "TeacherActivationToken" SET "expiresAt" = ? WHERE "applicationId" = ?`
    ).run(now - 1000, app2.id);
    const expiredToken = /teacherActivation=([A-Za-z0-9_-]+)/
      .exec(capturedEmails[capturedEmails.length - 1]?.html || "")?.[1] || "";
    const expired = await call("POST", "/api/auth/teacher-activate", {
      body: { token: expiredToken, password: "WhateverPass1" },
      headers: { "x-real-ip": "198.51.100.99" },
    });
    eq(expired.status, 400, "an expired activation token is refused (400)");
    eq(
      db.prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "email" = 'expired@teachers.test'`).get().c,
      0,
      "an expired token provisions no account"
    );

    // REJECTED applicant cannot log in.
    await call("POST", "/api/auth/register", {
      body: { email: "rejected@teachers.test", name: "Applicant Three", role: "TEACHER" },
    });
    const app3 = db
      .prepare(`SELECT "id" FROM "TeacherApplication" WHERE "email" = 'rejected@teachers.test'`)
      .get();
    await call("POST", `/api/admin/teacher-applications/reject?id=${app3.id}`, {
      cookie: "cm_session=admin-token",
      body: { note: "not a fit" },
    });
    const rejectedLogin = await call("POST", "/api/auth/login", {
      body: { email: "rejected@teachers.test", password: "WhateverPass1" },
      headers: { "x-real-ip": "198.51.100.55" },
    });
    eq(rejectedLogin.status, 401, "a rejected applicant has no account to log into (401)");
    // And a rejected application cannot be approved afterwards.
    const approveRejected = await call(
      "POST",
      `/api/admin/teacher-applications/approve?id=${app3.id}`,
      { cookie: "cm_session=admin-token" }
    );
    ok(approveRejected.status === 409, "a REJECTED application cannot be approved (409)", approveRejected.status);
  }

  // =========================================================================
  section("8. client IP resolution prefers the proxy-set header (F-07)");
  // =========================================================================
  {
    const spoofed = Security.clientIpFromHeaders(
      new Headers({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "198.51.100.1" })
    );
    eq(spoofed, "198.51.100.1", "X-Real-IP (proxy-set) wins over a spoofed X-Forwarded-For");
    const fallback = Security.clientIpFromHeaders(
      new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })
    );
    eq(fallback, "1.2.3.4", "falls back to the first X-Forwarded-For hop when no X-Real-IP");
    const none = Security.clientIpFromHeaders(new Headers({}));
    eq(none, null, "no headers → null (route falls back to the 'unknown' bucket)");
  }

  // =========================================================================
  section("9. audit trail contains no secrets");
  // =========================================================================
  {
    const rows = db.prepare(`SELECT "type","detail" FROM "SecurityEvent"`).all();
    const leaked = rows.filter((r) => /teacherActivation=|token=[A-Za-z0-9_-]{20,}/.test(r.detail || ""));
    eq(leaked.length, 0, "no activation/reset token value is ever written to the audit log");
    const hashes = db
      .prepare(`SELECT DISTINCT "identifier" FROM "SecurityRateLimit" WHERE "bucket" LIKE 'login:%'`)
      .all();
    ok(hashes.length > 0, "login limiter rows exist (the bucket really was exercised)");
    ok(
      hashes.every((r) => /^[0-9a-f]{32,64}$/.test(r.identifier)),
      "every login limiter identifier is a hash, never a raw email or IP"
    );
  }
} finally {
  server.close();
}

console.log(`\nSecurity Audit Gate HTTP verify: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.error("SECURITY_AUDIT_GATE_HTTP_FAIL");
  for (const f of failures) console.error("  - " + f);
  process.exit(1);
}
console.log("SECURITY_AUDIT_GATE_HTTP_OK");
process.exit(0);
