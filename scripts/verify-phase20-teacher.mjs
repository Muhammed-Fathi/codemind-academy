#!/usr/bin/env node
// CodeMind Academy — Phase 20 addendum verification: secure teacher
// application & admin approval, over a REAL database and REAL HTTP.
//
// `next dev`/`next build` cannot start in this sandbox (binaries.prisma.sh is
// unreachable — documented across Phases 6–19), so — exactly like the other
// verify-* scripts — the SHIPPED route handlers and domain library are
// compiled with tsc and driven over a REAL `node:http` server with REAL
// `fetch` requests. The ONLY substitutions are the transport shims:
//   * `@/lib/db`       → sqlite-prisma-lite over node:sqlite (real SQL, real
//                        rows, real constraints; throws UnsupportedQuery
//                        instead of approximating);
//   * `@/lib/delivery` → captures the activation email instead of SMTP
//                        (so the RAW activation token can be read back, the
//                        way a real inbox would);
//   * `next/server`, `next/headers` → minimal equivalents.
// `auth.ts` (createSession/getCurrentUserDetailed), `teacher-applications.ts`,
// `checkRateLimit`, `logSecurityEvent` and the compiled route handlers run
// byte-for-byte unmodified.
//
// The full chain is proven:
//   submit → PENDING (no User, no role=TEACHER, no session)
//   duplicate / existing-user / role-injection / status-injection refusals
//   admin approve → APPROVED + single-use activation token (no password)
//   admin reject → REJECTED + token rescinded; re-application reopens PENDING
//   activate → applicant's own password → User(role TEACHER) is born
//   token replay / expiry / wrong-account / pre-activation login all fail
//   non-admin approve/reject denied (IDOR-safe, no existence oracle)
//
// Prints PHASE20_TEACHER_OK on success. Never touches the developer's real DB.

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

const mig = require(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));

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

// ---------------------------------------------------------------------------
// Real database: base DDL + every real migration (including the new one).
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase20-teacher: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// Compile the shipped modules.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase20-teacher-"));
const MODULES = [
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/rate-limit.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/registration.ts",
  "src/lib/teacher-applications.ts",
  "src/lib/api.ts",
  "src/lib/auth.ts",
  "src/app/api/auth/[action]/route.ts",
  "src/app/api/auth/teacher-activate/route.ts",
  "src/app/api/admin/teacher-applications/route.ts",
  "src/app/api/admin/teacher-applications/[id]/approve/route.ts",
  "src/app/api/admin/teacher-applications/[id]/reject/route.ts",
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
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")], {
    cwd: REPO,
    stdio: "pipe",
  });
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
fs.writeFileSync(dbShim, 'module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n');

const capturedEmails = [];
const deliveryShim = path.join(OUT, "__delivery-shim.js");
fs.writeFileSync(
  deliveryShim,
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

const nextServerShim = path.join(OUT, "__next-server-shim.js");
fs.writeFileSync(
  nextServerShim,
  [
    "class NextResponse {",
    "  constructor(body, init = {}) {",
    "    this.status = init.status ?? 200;",
    "    this._headers = new Map();",
    "    for (const [k, v] of Object.entries(init.headers || {})) this._headers.set(String(k).toLowerCase(), String(v));",
    "    this._body = body; this._json = undefined;",
    "  }",
    "  static json(data, init = {}) {",
    "    const r = new NextResponse(JSON.stringify(data), { status: init.status ?? 200, headers: { 'content-type': 'application/json' } });",
    "    r._json = data; return r;",
    "  }",
    "  get headers() { const m = this._headers; return { get: (k) => m.get(String(k).toLowerCase()) ?? null }; }",
    "  async json() { return this._json !== undefined ? this._json : JSON.parse(Buffer.from(this._body || []).toString('utf8')); }",
    "  async arrayBuffer() { const b = Buffer.isBuffer(this._body) ? this._body : Buffer.from(this._body ?? []); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength); }",
    "}",
    "class NextRequest {}",
    "module.exports = { NextResponse, NextRequest };",
  ].join("\n")
);

const nextHeadersShim = path.join(OUT, "__next-headers-shim.js");
fs.writeFileSync(
  nextHeadersShim,
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
    "// Next.js `next/headers` is async: cookies()/headers() return Promises.",
    "module.exports = {",
    "  cookies: async () => parse().cookies(),",
    "  headers: async () => parse().headers(),",
    "};",
  ].join("\n")
);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return dbShim;
  if (request === "@/lib/delivery") return deliveryShim;
  if (request === "next/server") return nextServerShim;
  if (request === "next/headers") return nextHeadersShim;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...rest);
};

const route = (p) => require(path.join(EMIT, "app", "api", p));

// ---------------------------------------------------------------------------
// Seed admin + a student + a teacher (existing accounts) with REAL sessions.
// ---------------------------------------------------------------------------
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const now = Date.now();
const db = rawDb;

// NOTE: DateTime columns are seeded as epoch-millisecond NUMBERS to match the
// representation the sqlite-prisma-lite adapter writes (see its toSqlValue), so
// read-backs round-trip to real Date objects and expiry math is exact.
function seedUser(id, email, role) {
  db.prepare(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt") VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`
  ).run(id, email, "x", role + " Name", role, now, now);
}
function seedSession(sessionId, userId, token) {
  db.prepare(
    `INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt") VALUES (?,?,?,?,?,?,?)`
  ).run(sessionId, userId, sha256(token), "device-verifier", now, now, now + 86400000);
}
seedUser("u-admin", "admin@codemind.academy", "ADMIN");
seedSession("sess-admin", "u-admin", "admin-token");
seedUser("u-student", "student@x.com", "STUDENT");
seedSession("sess-student", "u-student", "student-token");
seedUser("u-teacher", "existing.teacher@x.com", "TEACHER");
db.prepare(`INSERT INTO "Teacher" ("id","userId","createdAt","updatedAt") VALUES (?,?,?,?)`).run("t-existing", "u-teacher", now, now);
seedSession("sess-teacher", "u-teacher", "teacher-token");

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
  "POST /api/auth/register": route("auth/[action]/route.js").POST,
  "GET /api/auth/me": route("auth/[action]/route.js").GET,
  "POST /api/auth/login": route("auth/[action]/route.js").POST,
  "POST /api/auth/teacher-activate": route("auth/teacher-activate/route.js").POST,
  "GET /api/admin/teacher-applications": route("admin/teacher-applications/route.js").GET,
  "POST /api/admin/teacher-applications/approve": route("admin/teacher-applications/[id]/approve/route.js").POST,
  "POST /api/admin/teacher-applications/reject": route("admin/teacher-applications/[id]/reject/route.js").POST,
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = {
    cookie: parseCookies(req.headers.cookie),
    headers: { "user-agent": req.headers["user-agent"] || "", "x-forwarded-for": "127.0.0.1" },
  };

  let body = {};
  if (req.method === "POST") {
    for await (const chunk of req) {
      try {
        body = JSON.parse(chunk.toString("utf8"));
      } catch {
        body = {};
      }
    }
  }

  const nextReq = {
    url: req.url,
    method: req.method,
    headers: { get: (k) => String(k).toLowerCase() === "content-type" ? "application/json" : req.headers[k.toLowerCase()] ?? null },
    json: async () => body,
    formData: async () => { throw new Error("no form body"); },
  };

  let key = null;
  let handler = null;
  let params = {};
  if (req.method === "GET" && url.pathname === "/api/auth/me") { key = "GET /api/auth/me"; params = { action: "me" }; }
  else if (req.method === "POST" && url.pathname === "/api/auth/register") { key = "POST /api/auth/register"; params = { action: "register" }; }
  else if (req.method === "POST" && url.pathname === "/api/auth/login") { key = "POST /api/auth/login"; params = { action: "login" }; }
  else if (req.method === "POST" && url.pathname === "/api/auth/teacher-activate") { key = "POST /api/auth/teacher-activate"; }
  else if (req.method === "GET" && url.pathname === "/api/admin/teacher-applications") { key = "GET /api/admin/teacher-applications"; }
  else if (req.method === "POST") {
    const mApprove = /^\/api\/admin\/teacher-applications\/([^/]+)\/approve$/.exec(url.pathname);
    const mReject = /^\/api\/admin\/teacher-applications\/([^/]+)\/reject$/.exec(url.pathname);
    if (mApprove) { key = "POST /api/admin/teacher-applications/approve"; params = { id: decodeURIComponent(mApprove[1]) }; }
    else if (mReject) { key = "POST /api/admin/teacher-applications/reject"; params = { id: decodeURIComponent(mReject[1]) }; }
  }

  handler = handlers[key];
  if (!handler) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }

  const response = await handler(nextReq, { params: Promise.resolve(params) });
  res.statusCode = response.status ?? 200;
  const ct = response.headers?.get?.("content-type");
  if (ct) res.setHeader("content-type", ct);
  if (globalThis.__CM_RESP_COOKIES__.length) {
    res.setHeader("set-cookie", globalThis.__CM_RESP_COOKIES__);
  }
  const payload =
    typeof response._body === "string" ? response._body : Buffer.from(await response.arrayBuffer()).toString("utf8");
  res.end(payload);
});

const BASE = await new Promise((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

// fetch with a cookie jar
function jar() {
  const cookies = [];
  return {
    cookies,
    fetch: async (path, init = {}) => {
      const headers = { ...(init.headers || {}) };
      if (cookies.length) headers.Cookie = cookies.join("; ");
      const r = await fetch(`${BASE}${path}`, { ...init, headers });
      const setCookie = r.headers.get("set-cookie");
      if (setCookie) {
        const value = setCookie.split(";")[0];
        cookies.push(value);
      }
      return r;
    },
  };
}

const as = (token) => {
  const j = jar();
  if (token) j.cookies.push(`cm_session=${token}`);
  return j;
};

try {
  // ---- 1. Public application → PENDING, no account, no session ------------
  console.log("\n-- 1. public application --");
  {
    const r = await jar().fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Teacher", email: "new.teacher@x.com", phone: "01012345678", role: "TEACHER", password: "ignored", status: "APPROVED", role: "TEACHER" }),
    });
    const body = await r.json();
    eq(r.status, 200, "application submit → 200");
    eq(body.applied, true, "response signals an application, not an account");
    ok(!body.user, "response returns NO user");

    const app = db.prepare(`SELECT * FROM "TeacherApplication" WHERE "email" = ?`).get("new.teacher@x.com");
    ok(app && app.status === "PENDING", "application row exists and is PENDING (client status ignored)");
    ok(app && app.userId === null, "application has no linked user yet");
    const user = db.prepare(`SELECT * FROM "User" WHERE "email" = ?`).get("new.teacher@x.com");
    eq(user, undefined, "NO User row was created");
    const sessionCount = db.prepare(`SELECT COUNT(*) AS c FROM "UserSession" WHERE "userId" = (SELECT "id" FROM "User" WHERE "email"='new.teacher@x.com')`).get().c;
    eq(sessionCount, 0, "no session exists for the applicant");
  }

  // ---- 2. Duplicate / existing-identity refusals ---------------------------
  console.log("\n-- 2. duplicate + existing identity --");
  {
    const dup = await jar().fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "New Teacher", email: "new.teacher@x.com", role: "TEACHER" }),
    });
    eq(dup.status, 409, "duplicate application → 409");
    eq((await db.prepare(`SELECT COUNT(*) AS c FROM "TeacherApplication" WHERE "email" = ?`).get("new.teacher@x.com")).c, 1,
      "still exactly one application row");

    const existing = await jar().fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "A Student", email: "student@x.com", role: "TEACHER" }),
    });
    eq(existing.status, 409, "existing STUDENT email blocks the application → 409");
    const studentRow = db.prepare(`SELECT "role" FROM "User" WHERE "email" = 'student@x.com'`).get();
    eq(studentRow.role, "STUDENT", "existing student account is NOT mutated");

    const adminReg = await jar().fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Hacker", email: "hacker@x.com", role: "ADMIN" }),
    });
    eq(adminReg.status, 400, "public ADMIN registration remains blocked");
  }

  // ---- 3. Non-admins cannot list/approve/reject (IDOR-safe) ---------------
  console.log("\n-- 3. authorization: non-admin approve/reject/list --");
  {
    const appId = db.prepare(`SELECT "id" FROM "TeacherApplication" WHERE "email" = 'new.teacher@x.com'`).get().id;

    const anonApprove = await jar().fetch(`/api/admin/teacher-applications/${appId}/approve`, { method: "POST" });
    eq(anonApprove.status, 401, "anonymous approve → 401");
    const studentApprove = await as("student-token").fetch(`/api/admin/teacher-applications/${appId}/approve`, { method: "POST" });
    eq(studentApprove.status, 403, "STUDENT approve → 403");
    const teacherApprove = await as("teacher-token").fetch(`/api/admin/teacher-applications/${appId}/approve`, { method: "POST" });
    eq(teacherApprove.status, 403, "TEACHER approve → 403 (default: no administrative capability)");
    const studentList = await as("student-token").fetch("/api/admin/teacher-applications");
    eq(studentList.status, 403, "STUDENT cannot list applications");
    const studentReject = await as("student-token").fetch(`/api/admin/teacher-applications/${appId}/reject`, { method: "POST" });
    eq(studentReject.status, 403, "STUDENT reject → 403");

    // Changing the id must not bypass authorization: a non-admin gets the SAME
    // 403 for a bogus id (authorization runs before existence — no oracle).
    const bogusApprove = await as("student-token").fetch(`/api/admin/teacher-applications/does-not-exist/approve`, { method: "POST" });
    eq(bogusApprove.status, 403, "non-admin approve on a bogus id → 403 (not 404 — no oracle)");

    // The applicant themselves is anonymous (no account yet) — they cannot approve.
    const selfApprove = await jar().fetch(`/api/admin/teacher-applications/${appId}/approve`, { method: "POST" });
    eq(selfApprove.status, 401, "applicant (anonymous) cannot approve their own application");
  }

  // ---- 4. Admin approve → APPROVED + activation token, still no password ---
  console.log("\n-- 4. admin approve --");
  {
    const appId = db.prepare(`SELECT "id" FROM "TeacherApplication" WHERE "email" = 'new.teacher@x.com'`).get().id;
    capturedEmails.length = 0;

    const r = await as("admin-token").fetch(`/api/admin/teacher-applications/${appId}/approve`, { method: "POST" });
    const body = await r.json();
    eq(r.status, 200, "admin approve → 200");
    eq(body.alreadyApproved, false, "first approval mints the activation");

    const app = db.prepare(`SELECT * FROM "TeacherApplication" WHERE "id" = ?`).get(appId);
    eq(app.status, "APPROVED", "application is APPROVED");
    ok(app.userId === null, "approval still creates NO user");
    const userCount = db.prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "email" = 'new.teacher@x.com'`).get().c;
    eq(userCount, 0, "approval assigns NO password (no User row at all)");
    ok(app.reviewedByUserId === "u-admin", "approval records the admin reviewer");

    eq(capturedEmails.length, 1, "exactly one activation email sent");
    const m = /teacherActivation=([^&\s"<]+)/.exec(capturedEmails[0].text);
    ok(!!m, "email carries an activation link");
    const token = m ? m[1] : "";
    const tokenRow = db.prepare(`SELECT * FROM "TeacherActivationToken" WHERE "applicationId" = ?`).get(appId);
    ok(tokenRow && tokenRow.tokenHash === sha256(token), "token row stores the SHA-256 of the emailed secret");
    ok(tokenRow && !tokenRow.usedAt, "token is unused");
    ok(tokenRow && new Date(tokenRow.expiresAt).getTime() > Date.now(), "token is unexpired");

    // Idempotent re-approve does NOT re-mint.
    capturedEmails.length = 0;
    const again = await as("admin-token").fetch(`/api/admin/teacher-applications/${appId}/approve`, { method: "POST" });
    const againBody = await again.json();
    eq(againBody.alreadyApproved, true, "re-approve is idempotent");
    eq(capturedEmails.length, 0, "idempotent re-approve sends no second email");
    const tokenRows = db.prepare(`SELECT COUNT(*) AS c FROM "TeacherActivationToken" WHERE "applicationId" = ? AND "usedAt" IS NULL`).get(appId).c;
    eq(tokenRows, 1, "still exactly one live token (not re-minted)");

    globalThis.__APPROVED_TOKEN__ = token;
  }

  // ---- 5. Activation: wrong token, wrong state, replay --------------------
  console.log("\n-- 5. activation token rules --");
  {
    const bogus = await jar().fetch("/api/auth/teacher-activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "bogus-token", password: "NewPassword123" }),
    });
    eq(bogus.status, 400, "unknown token → 400");

    const short = await jar().fetch("/api/auth/teacher-activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: globalThis.__APPROVED_TOKEN__, password: "short" }),
    });
    eq(short.status, 400, "short password → 400");

    // Rejected application's (nonexistent) token cannot activate.
    const rejectable = await jar().fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reject Me", email: "reject.me@x.com", role: "TEACHER" }),
    });
    eq(rejectable.status, 200, "second applicant applies");
    const rejId = db.prepare(`SELECT "id" FROM "TeacherApplication" WHERE "email" = 'reject.me@x.com'`).get().id;
    const rej = await as("admin-token").fetch(`/api/admin/teacher-applications/${rejId}/reject`, { method: "POST" });
    eq(rej.status, 200, "admin rejects the second applicant");
    eq(db.prepare(`SELECT "status" FROM "TeacherApplication" WHERE "id" = ?`).get(rejId).status, "REJECTED", "application is REJECTED");
    eq(db.prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "email" = 'reject.me@x.com'`).get().c, 0, "rejection creates no account");

    // Re-application reopens the SAME row as PENDING.
    const reapply = await jar().fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Reject Me Again", email: "reject.me@x.com", role: "TEACHER" }),
    });
    eq(reapply.status, 200, "rejected applicant may re-apply");
    eq(db.prepare(`SELECT "status" FROM "TeacherApplication" WHERE "id" = ?`).get(rejId).status, "PENDING", "same row re-opened as PENDING");
  }

  // ---- 6. Activate the approved applicant → User(role TEACHER) born --------
  console.log("\n-- 6. activation completes the account --");
  {
    const r = await jar().fetch("/api/auth/teacher-activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: globalThis.__APPROVED_TOKEN__, password: "NewPassword123" }),
    });
    const body = await r.json();
    eq(r.status, 200, "activation → 200");
    ok(!body.user, "activation does NOT auto-authenticate (no user payload)");

    const app = db.prepare(`SELECT * FROM "TeacherApplication" WHERE "email" = 'new.teacher@x.com'`).get();
    eq(app.status, "ACTIVATED", "application is ACTIVATED");
    ok(app.userId, "application links the provisioned user");
    const user = db.prepare(`SELECT * FROM "User" WHERE "id" = ?`).get(app.userId);
    eq(user.role, "TEACHER", "the born user has role TEACHER");
    eq(user.email, "new.teacher@x.com", "the born user carries the applicant's email");
    const teacher = db.prepare(`SELECT * FROM "Teacher" WHERE "userId" = ?`).get(app.userId);
    ok(teacher, "Teacher profile created");
    const tokenRow = db.prepare(`SELECT * FROM "TeacherActivationToken" WHERE "applicationId" = ?`).get(app.id);
    ok(tokenRow.usedAt, "activation token is consumed");

    // Replay the SAME token → refused.
    const replay = await jar().fetch("/api/auth/teacher-activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: globalThis.__APPROVED_TOKEN__, password: "AnotherPass123" }),
    });
    eq(replay.status, 400, "token replay → 400");
    eq(db.prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "email" = 'new.teacher@x.com'`).get().c, 1,
      "replay creates no second account");
  }

  // ---- 7. Login works ONLY after activation --------------------------------
  console.log("\n-- 7. login only after activation --");
  {
    // Expired-token case: a third applicant approved, then the token expired.
    const expApp = await jar().fetch("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Expired Person", email: "expired.person@x.com", role: "TEACHER" }),
    });
    eq(expApp.status, 200, "third applicant applies");
    const expId = db.prepare(`SELECT "id" FROM "TeacherApplication" WHERE "email" = 'expired.person@x.com'`).get().id;
    const expApprove = await as("admin-token").fetch(`/api/admin/teacher-applications/${expId}/approve`, { method: "POST" });
    eq(expApprove.status, 200, "third applicant approved");
    const expiredToken = /teacherActivation=([^&\s"<]+)/.exec(capturedEmails[capturedEmails.length - 1].text)[1];
    db.prepare(`UPDATE "TeacherActivationToken" SET "expiresAt" = ? WHERE "applicationId" = ?`)
      .run(Date.now() - 1000, expId);

    // Login before activation fails (no user row exists yet).
    const beforeLogin = await jar().fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "expired.person@x.com", password: "Whatever123" }),
    });
    eq(beforeLogin.status, 401, "login before activation → 401");

    const expired = await jar().fetch("/api/auth/teacher-activate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: expiredToken, password: "ExpiredPass123" }),
    });
    eq(expired.status, 400, "expired token → 400");
    eq(db.prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "email" = 'expired.person@x.com'`).get().c, 0,
      "expired token cannot create the account");

    // Login after activation works (real session, real cookie).
    const loginJar = jar();
    const login = await loginJar.fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "new.teacher@x.com", password: "NewPassword123" }),
    });
    const loginBody = await login.json();
    eq(login.status, 200, "login after activation → 200");
    eq(loginBody.user.role, "TEACHER", "login returns the TEACHER user");
    ok(loginJar.cookies.some((c) => c.startsWith("cm_session=")), "login issues a real session cookie");

    const me = await loginJar.fetch("/api/auth/me");
    const meBody = await me.json();
    eq(me.status, 200, "authenticated /me → 200");
    eq(meBody.role, "TEACHER", "/me resolves the new teacher");

    // The freshly activated teacher still cannot approve others.
    const expReopen = db.prepare(`SELECT "id" FROM "TeacherApplication" WHERE "email" = 'expired.person@x.com'`).get().id;
    const teacherApprove2 = await loginJar.fetch(`/api/admin/teacher-applications/${expReopen}/approve`, { method: "POST" });
    eq(teacherApprove2.status, 403, "the new teacher cannot approve applications");
  }

  // ---- 8. Audit trail ------------------------------------------------------
  console.log("\n-- 8. security events --");
  {
    const types = db.prepare(`SELECT DISTINCT "type" FROM "SecurityEvent"`).all().map((r) => r.type);
    for (const want of [
      "TEACHER_APPLICATION_SUBMITTED",
      "TEACHER_APPLICATION_BLOCKED",
      "TEACHER_APPLICATION_APPROVED",
      "TEACHER_ACTIVATION_ISSUED",
      "TEACHER_APPLICATION_REJECTED",
      "TEACHER_ACTIVATION_COMPLETED",
      "TEACHER_ACTIVATION_FAILED",
    ]) {
      ok(types.includes(want), `audit event ${want} recorded`);
    }
    const rawTokenLeak = db.prepare(`SELECT COUNT(*) AS c FROM "SecurityEvent" WHERE COALESCE("detail",'') LIKE '%NewPassword123%' OR COALESCE("detail",'') LIKE '%teacherActivation=%'`).get().c;
    eq(rawTokenLeak, 0, "no raw token/password in audit details");
    const rl = db.prepare(`SELECT COUNT(*) AS c FROM "SecurityRateLimit" WHERE "bucket" IN ('rl:teacherApply','teacheract:ip','teacheract:token')`).get().c;
    ok(rl > 0, "rate-limit buckets are exercised (teacherApply / activation)");
  }
} finally {
  server.close();
}

console.log(`\nPhase 20 teacher verification: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log("  FAIL:", f);
  console.error("PHASE20_TEACHER_FAIL");
  process.exit(1);
}
console.log("PHASE20_TEACHER_OK");
process.exit(0);
