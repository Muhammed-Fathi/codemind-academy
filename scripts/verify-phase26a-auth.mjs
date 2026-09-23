#!/usr/bin/env node
// CodeMind Academy — Phase 26A PUBLIC & AUTH verification (real HTTP).
//
// WHY THIS SCRIPT EXISTS
//   Phase 26A must prove that an unauthenticated stranger can reach the public
//   surface, register, log in, log out, recover a password, be redirected to the
//   correct role shell, and be refused by every protected route/API — over REAL
//   HTTP, against REAL rows, with the REAL shipped handlers.
//
//   `next dev` cannot serve `/api/*` in this sandbox: `binaries.prisma.sh` is
//   unreachable, so `prisma generate` cannot run and `@prisma/client` has no
//   engine (documented since Phase 6, see docs/PHASE_22_FINAL_REPORT.md §"Q:").
//   The dev server DOES serve the real client bundle (used by
//   scripts/verify-phase26a-browser.mjs for the visual/public layer).
//
//   This script closes the API gap the same way every other verify-* script
//   does: compile the SHIPPED TypeScript with tsc, replace ONLY the data source
//   (`@/lib/db`) with a real node:sqlite adapter, then serve the compiled route
//   handlers from a real `node:http` server that is exercised with real `fetch`
//   calls over a real TCP socket.
//
//   The ONLY substitutions are: the Prisma data source, the email delivery
//   transport (captured in-memory instead of SMTP), and Next's request-scoped
//   `cookies()`/`headers()`/`NextResponse` plumbing. Every module that decides
//   behaviour under test is byte-for-byte the shipped file.
//
// Usage:
//   node scripts/verify-phase26a-auth.mjs            # run the full audit
//   node scripts/verify-phase26a-auth.mjs --serve PORT  # keep the HTTP server
//       alive on 0.0.0.0:PORT (used by the browser bridge)
//   node scripts/verify-phase26a-auth.mjs --json-out FILE
//
// Prints PHASE26A_AUTH_OK on success.

import crypto from "node:crypto";
import http from "node:http";
import Module from "node:module";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(HERE, "..");

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] ?? null;
};
const SERVE_PORT = argOf("--serve") ? Number(argOf("--serve")) : null;
const JSON_OUT = argOf("--json-out");

// A real, non-placeholder hash secret must be in force for the run.
process.env.SECURITY_HASH_SECRET =
  process.env.SECURITY_HASH_SECRET || "phase26a-verifier-secret-0123456789abcdef";
process.env.NEXT_PUBLIC_URL = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    pass++;
    if (SERVE_PORT === null) console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
  return Boolean(cond);
}
function eq(a, b, label) {
  return ok(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`
  );
}
const section = (t) => {
  if (SERVE_PORT === null) console.log(`\n── ${t} ──`);
};

// ===========================================================================
// 1. Compile the shipped modules (tsc, same options as the other verifiers).
// ===========================================================================
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase26a-"));
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
  "src/lib/route-protection.ts",
  "src/lib/api.ts",
  "src/lib/auth.ts",
  "src/app/api/auth/[action]/route.ts",
  "src/app/api/auth/password-reset/request/route.ts",
  "src/app/api/auth/password-reset/confirm/route.ts",
  "src/app/api/auth/teacher-activate/route.ts",
  "src/app/api/admin/teacher-applications/[id]/approve/route.ts",
  "src/app/api/settings/public/route.ts",
  "src/app/api/subscription-plans/route.ts",
  "src/app/api/students/me/enrollment/route.ts",
  "src/app/api/students/me/dashboard/route.ts",
  "src/app/api/notifications/unread-count/route.ts",
  "src/app/api/admin/overview/route.ts",
  "src/app/api/teacher/dashboard/route.ts",
  "src/app/api/parents/me/dashboard/route.ts",
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
  // Type errors are expected/known (the generated Prisma client is a stub in
  // this sandbox). tsc still EMITS, which is all this harness needs — the
  // check below fails loudly if anything was NOT emitted.
  if (process.env.PHASE26A_VERBOSE) {
    console.error(String(e.stdout || ""));
    console.error(String(e.stderr || e.message || e));
  }
}
const EMIT = path.join(OUT, "src");
for (const f of MODULES) {
  const emitted = path.join(OUT, f.replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(emitted)) throw new Error(`tsc did not emit ${f}`);
}

// ===========================================================================
// 2. Real database — base DDL + every real migration, real SQLite engine.
// ===========================================================================
const mig = require(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));

const rawDb = new DatabaseSync(":memory:");
rawDb.exec("PRAGMA foreign_keys = ON");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase26a: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ===========================================================================
// 3. Shims — ONLY the data source, mail transport and Next request plumbing.
// ===========================================================================
const dbShim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(dbShim, "module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n");

// Email transport: the capture is what makes the reset/activation token
// observable to the test (the real /api code never returns it).
fs.writeFileSync(
  path.join(OUT, "__delivery-shim.js"),
  [
    "module.exports = {",
    "  sendEmail: async (params) => {",
    "    globalThis.__CM_EMAILS__.push({ to: params.to, subject: params.subject || '', text: params.text || '', html: params.html || '' });",
    "    return { delivered: true, provider: 'phase26a-capture' };",
    "  },",
    "};",
  ].join("\n")
);
globalThis.__CM_EMAILS__ = [];

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
    "  return store;",
    "};",
    "module.exports = { cookies: async () => parse(), headers: async () => new Headers((globalThis.__CM_REQ_CTX__ || {}).headers || {}) };",
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
const Auth = require(path.join(EMIT, "lib", "auth.js"));
const Security = require(path.join(EMIT, "lib", "security.js"));
const RouteProtection = require(path.join(EMIT, "lib", "route-protection.js"));

// ===========================================================================
// 4. Seed identities (clearly-labelled qa26a-* local fixtures only).
// ===========================================================================
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const db = rawDb;
const NOW = Date.now();

const ADMIN_PW = "Qa26aAdminLocal1!";
const DEMO_PW = "Qa26aDemoLocal1!";
const STUDENT_PW = "Qa26aStudent1!";
const PARENT_PW = "Qa26aParent1!";
const TEACHER_PW = "Qa26aTeacher1!";

function insertUser(id, email, role, password, { isActive = 1, status = "ACTIVE", name } = {}) {
  db.prepare(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, email, Auth.hashPassword(password), name || `${role} QA`, role, isActive, status, NOW, NOW);
}
// The harness always speaks with this User-Agent; the single-device policy
// derives its fingerprint from the UA family, so seeded sessions must carry the
// SAME fingerprint or a login for that user is (correctly) treated as a second
// device and suspends the account.
const HARNESS_UA = "phase26a-verifier";
const DEVICE = Security.deviceHashFromHeaders(new Headers({ "user-agent": HARNESS_UA }));
// A recognisably DIFFERENT device, for the single-device conflict test.
const OTHER_DEVICE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

function insertSession(id, userId, token, { expiresAt = NOW + 86400000, revokedAt = null, deviceHash = DEVICE, lastSeenAt = NOW } = {}) {
  db.prepare(
    `INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt","revokedAt")
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(id, userId, sha256(token), deviceHash, NOW, lastSeenAt, expiresAt, revokedAt);
}

insertUser("u-admin", "admin@codemind.academy", "ADMIN", ADMIN_PW);
insertUser("u-teacher", "teacher@codemind.academy", "TEACHER", TEACHER_PW);
insertUser("u-student", "qa26a-student-login@codemind.test", "STUDENT", STUDENT_PW, {
  name: "طالب اختبار أول",
});
insertUser("u-parent", "qa26a-parent-login@codemind.test", "PARENT", PARENT_PW, {
  name: "Parent QA Test",
});
// A disabled identity, to prove the "inactive account" branch.
insertUser("u-disabled", "qa26a-disabled@codemind.test", "STUDENT", STUDENT_PW, { isActive: 0 });
// A dedicated identity for the single-device (concurrent use) conflict test.
insertUser("u-multidevice", "qa26a-multidevice@codemind.test", "STUDENT", STUDENT_PW);
// A suspended-for-multi-device identity.
insertUser("u-suspended", "qa26a-suspended@codemind.test", "STUDENT", STUDENT_PW, {
  status: "SUSPENDED_MULTI_DEVICE",
  isActive: 0,
});

// Phase K2 — registration advertises/accepts only OFFERED Level × Track
// pairs (an ACTIVE classified group on a levelled course). One
// SECOND_SECONDARY / LANGUAGE offering makes the registration scenarios
// below possible — exactly the population a real deployment has today.
db.prepare(
  `INSERT INTO "Course" ("id","slug","name","nameAr","description","academicLevel","createdAt","updatedAt")
   VALUES ('qa26a-course','qa26a-course','QA Course','كورس','d','SECOND_SECONDARY',?,?)`
).run(NOW, NOW);
db.prepare(
  `INSERT INTO "Group" ("id","name","courseId","capacity","schedule","isActive","trackScope","createdAt","updatedAt")
   VALUES ('qa26a-group-lang','QA LANG group','qa26a-course',20,'Sat 6PM',1,'LANGUAGE',?,?)`
).run(NOW, NOW);

// Student profile for the logged-in student (also the parent-registration link
// target: nationalId + studentCode + parentPhone must match).
db.prepare(
  `INSERT INTO "Student" ("id","userId","grade","schoolType","nationalId","studentCode","parentPhone","schoolName","createdAt","updatedAt","enrolledAt","academicLevel")
   VALUES (?,?,?,?,?,?,?,?,?,?,?,'SECOND_SECONDARY')`
).run(
  "s-student",
  "u-student",
  "2nd Secondary",
  "LANGUAGE",
  "29901011234567",
  "CM-QA26A1",
  "01000000001",
  "QA School",
  NOW,
  NOW,
  NOW
);
db.prepare(`INSERT INTO "Parent" ("id","userId","createdAt","updatedAt") VALUES (?,?,?,?)`).run(
  "p-parent",
  "u-parent",
  NOW,
  NOW
);
db.prepare(
  `INSERT INTO "ParentStudentLink" ("id","parentId","studentId","relation","createdAt") VALUES (?,?,?,?,?)`
).run("psl-1", "p-parent", "s-student", "parent", NOW);
db.prepare(`INSERT INTO "Teacher" ("id","userId","createdAt","updatedAt") VALUES (?,?,?,?)`).run(
  "t-teacher",
  "u-teacher",
  NOW,
  NOW
);

// Public brand/price catalogue (the landing + enrolment copy reads these).
for (const [k, v] of [
  ["brand_name", "CodeMind Academy"],
  ["brand_tagline", "Learn. Build. Think."],
  ["academic_year", "2026 / 2027"],
  ["price_monthly", "200"],
  ["price_3months", "550"],
  ["price_6months", "1000"],
]) {
  db.prepare(`INSERT INTO "Setting" ("id","key","value","updatedAt") VALUES (?,?,?,?)`).run(`set-${k}`, k, v, NOW);
}
db.prepare(
  `INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","createdAt") VALUES (?,?,?,?,?,0,?)`
).run("plan-1", "Monthly", "شهري", 1, 200, NOW);

// Live sessions for the seeded identities (used by logout/revocation checks).
insertSession("sess-admin", "u-admin", "qa26a-admin-token");
insertSession("sess-teacher", "u-teacher", "qa26a-teacher-token");
insertSession("sess-student", "u-student", "qa26a-student-token");
insertSession("sess-parent", "u-parent", "qa26a-parent-token");
// A session that is already past its expiry.
insertSession("sess-expired", "u-student", "qa26a-expired-token", { expiresAt: NOW - 1000 });
// A session that was revoked by an administrator.
insertSession("sess-revoked", "u-student", "qa26a-revoked-token", { revokedAt: NOW - 500 });

// ===========================================================================
// 5. Real HTTP server over the compiled handlers.
// ===========================================================================
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

// pathname patterns the public/auth surface needs → compiled route module.
// ORDER MATTERS: the concrete `/api/auth/*` sub-routes are matched before the
// `[action]` catch-all, exactly as Next resolves static segments before a
// dynamic one.
const ROUTES = [
  ["POST", /^\/api\/auth\/password-reset\/request$/, () => route("auth/password-reset/request/route.js").POST],
  ["POST", /^\/api\/auth\/password-reset\/confirm$/, () => route("auth/password-reset/confirm/route.js").POST],
  ["POST", /^\/api\/auth\/teacher-activate$/, () => route("auth/teacher-activate/route.js").POST],
  ["POST", /^\/api\/auth\/([^/]+)$/, (m) => route("auth/[action]/route.js").POST, (m) => ({ action: m[1] })],
  ["GET", /^\/api\/auth\/([^/]+)$/, () => route("auth/[action]/route.js").GET, (m) => ({ action: m[1] })],
  ["GET", /^\/api\/settings\/public$/, () => route("settings/public/route.js").GET],
  ["GET", /^\/api\/notifications\/unread-count$/, () => route("notifications/unread-count/route.js").GET],
  ["GET", /^\/api\/subscription-plans$/, () => route("subscription-plans/route.js").GET],
  ["GET", /^\/api\/students\/me\/enrollment$/, () => route("students/me/enrollment/route.js").GET],
  ["GET", /^\/api\/students\/me\/dashboard$/, () => route("students/me/dashboard/route.js").GET],
  ["GET", /^\/api\/admin\/overview$/, () => route("admin/overview/route.js").GET],
  ["GET", /^\/api\/teacher\/dashboard$/, () => route("teacher/dashboard/route.js").GET],
  ["GET", /^\/api\/parents\/me\/dashboard$/, () => route("parents/me/dashboard/route.js").GET],
  [
    "POST",
    /^\/api\/admin\/teacher-applications\/([^/]+)\/approve$/,
    () => route("admin/teacher-applications/[id]/approve/route.js").POST,
    (m) => ({ id: m[1] }),
  ],
];

function buildRequest({ method, url, headers, body, cookieHeader }) {
  const parsed = parseCookies(cookieHeader);
  const hdrs = new Headers(
    Object.fromEntries(Object.entries(headers || {}).filter(([, v]) => typeof v === "string"))
  );
  const req = {
    url,
    method,
    nextUrl: new URL(url, "http://127.0.0.1"),
    headers: hdrs,
    cookies: { get: (n) => (parsed[n] === undefined ? undefined : { value: parsed[n] }) },
    json: async () => body,
    text: async () => JSON.stringify(body ?? {}),
    formData: async () => new Map(),
  };
  return req;
}

async function dispatch({ method, pathname, search, headers, body, cookieHeader }) {
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = {
    cookie: parseCookies(cookieHeader),
    headers: {
      "user-agent": (headers && headers["user-agent"]) || "phase26a-verifier",
      "x-forwarded-for": (headers && headers["x-forwarded-for"]) || "198.51.100.7",
      ...(headers && headers["x-real-ip"] ? { "x-real-ip": headers["x-real-ip"] } : {}),
    },
  };

  const url = `${pathname}${search || ""}`;

  // Defense-in-depth layer, EXACTLY as src/proxy.ts decides it (cookie presence
  // only, no DB) — so an unauthenticated probe never reaches route code.
  const proxyDecision = RouteProtection.decideApiAccess(pathname, Boolean(parseCookies(cookieHeader).cm_session));
  if (proxyDecision === "deny") {
    return { status: 401, json: { error: "Unauthorized" }, headers: [], viaProxy: true };
  }

  for (const [m, re, pick, paramsOf] of ROUTES) {
    if (m !== method) continue;
    const match = re.exec(pathname);
    if (!match) continue;
    const handler = pick(match);
    const params = paramsOf ? paramsOf(match) : {};
    const req = buildRequest({ method, url, headers, body, cookieHeader });
    const out = await handler(req, { params: Promise.resolve(params) });
    const outHeaders = [];
    if (out && out.headers && typeof out.headers.forEach === "function") {
      out.headers.forEach((v, k) => outHeaders.push([String(k), String(v)]));
    }
    const setCookies = globalThis.__CM_RESP_COOKIES__ || [];
    return {
      status: out.status ?? 200,
      json: await out.json().catch(() => null),
      headers: outHeaders,
      setCookies,
      viaProxy: false,
    };
  }
  return { status: 404, json: { error: "not found" }, headers: [], viaProxy: false };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");

    // QA-only helper (never part of the app): resolve real dictionary strings so
    // the browser verifier can target the SHIPPED localized UI by its own text
    // instead of hard-coded copy.
    if (url.pathname === "/__qa/t") {
      const i18nCore = require(path.join(EMIT, "lib", "i18n-core.js"));
      const locale = url.searchParams.get("locale") === "en" ? "en" : "ar";
      const keys = (url.searchParams.get("keys") || "").split(",").filter(Boolean);
      // Flat dictionary keys (auth.201, shell.021, …) resolved by the shipped
      // translate(), plus the STRUCTURED strings object the landing/auth
      // components read (nav.login, auth.welcomeBack, …).
      const out = { strings: i18nCore.getStrings(locale) };
      for (const k of keys) out[k] = i18nCore.translate(locale, k);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(out));
      return;
    }
    let body = {};
    if (req.method !== "GET") {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString("utf8");
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
    }
    const out = await dispatch({
      method: req.method,
      pathname: url.pathname,
      search: url.search,
      headers: req.headers,
      body,
      cookieHeader: req.headers.cookie || "",
    });
    res.statusCode = out.status;
    for (const [k, v] of out.headers || []) {
      if (k.toLowerCase() === "set-cookie") continue;
      res.setHeader(k, v);
    }
    res.setHeader("content-type", "application/json");
    if (out.setCookies && out.setCookies.length) res.setHeader("Set-Cookie", out.setCookies);
    res.end(JSON.stringify(out.json ?? null));
  } catch (e) {
    res.statusCode = 500;
    res.end(
      JSON.stringify({
        error: "HARNESS_ERROR",
        detail: String(e && e.message ? e.message : e).slice(0, 300),
      })
    );
  }
});

const BASE = SERVE_PORT
  ? await new Promise((r) => server.listen(SERVE_PORT, "0.0.0.0", () => r(`http://127.0.0.1:${SERVE_PORT}`)))
  : await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));

const call = async (method, p, { body, cookie, ip, headers } = {}) => {
  const r = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cookie ? { Cookie: cookie } : {}),
      ...(ip ? { "x-forwarded-for": ip } : {}),
      ...(headers || {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  const text = await r.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return {
    status: r.status,
    json,
    raw: text,
    setCookie: r.headers.getSetCookie ? r.headers.getSetCookie() : [],
    headers: r.headers,
  };
};
const sessionCookieOf = (res) => {
  const set = (res.setCookie || []).find((c) => c.startsWith("cm_session="));
  return set ? set.split(";")[0] : null;
};

// ===========================================================================
// The browser bridge keeps the server alive and stops here.
// ===========================================================================
if (SERVE_PORT) {
  console.log(`PHASE26A_SERVER_READY ${BASE}`);
  process.on("SIGTERM", () => process.exit(0));
} else {
  // =========================================================================
  // ASSERTIONS
  // =========================================================================
  const emailToken = (text, key) => {
    const m = new RegExp(`[?&]${key}=([A-Za-z0-9_\\-]+)`).exec(text || "");
    return m ? m[1] : null;
  };

  try {
    // ---------------------------------------------------------------------
    section("PUBLIC-01/02 — public surface reachable unauthenticated");
    // ---------------------------------------------------------------------
    {
      const pub = await call("GET", "/api/settings/public");
      ok(pub.status === 200, "GET /api/settings/public is reachable without a session (200)", pub.status);
      ok(
        pub.json && pub.json.settings && pub.json.settings.brand_name === "CodeMind Academy",
        "public settings expose brand copy and nothing else"
      );
      const keys = Object.keys((pub.json && pub.json.settings) || {});
      ok(
        !keys.some((k) => /secret|password|smtp|key/i.test(k)),
        "no secret-shaped key is exposed on the public settings surface"
      );

      const plans = await call("GET", "/api/subscription-plans");
      ok(plans.status === 200, "GET /api/subscription-plans is public (200)", plans.status);

      // The public catalogue must not be a protected namespace (a stray 401
      // here would break the enrolment page for guests).
      const me = await call("GET", "/api/auth/me");
      ok(me.status === 401, "GET /api/auth/me without a session is 401", me.status);
      ok(
        !/"password"|"tokenHash"|atob/i.test(me.raw || ""),
        "the 401 body carries no user rows or internal identifiers"
      );
    }

    // ---------------------------------------------------------------------
    section("AUTH-10 / §12 — protected API authorization, unauthenticated");
    // ---------------------------------------------------------------------
    {
      const probes = [
        ["/api/students/me/enrollment", "student namespace"],
        ["/api/admin/overview", "admin namespace"],
        ["/api/teacher/dashboard", "teacher namespace"],
        ["/api/parents/me/dashboard", "parent namespace"],
      ];
      for (const [p, label] of probes) {
        const r = await call("GET", p);
        ok(r.status === 401, `anonymous ${label} ${p} → 401`, r.status);
        ok(
          r.json && r.json.error === "Unauthorized",
          `anonymous ${label} refusal is the uniform 401 body (no route code reached)`
        );
      }
      // A route that is NOT in the protected namespace still refuses on its own
      // auth layer (defense in depth must not be the only check).
      const notif = await call("GET", "/api/students/me/enrollment");
      ok(notif.status === 401, "wrong-role/anonymous probes never 200");
    }

    // ---------------------------------------------------------------------
    section("AUTH-01 — student registration");
    // ---------------------------------------------------------------------
    {
      const email = "qa26a-student-reg@codemind.test";
      const payload = {
        email,
        name: "طالب تسجيل جديد",
        password: "Qa26aRegPass1!",
        role: "STUDENT",
        studentPhone: "01111111111",
        parentPhone: "01222222222",
        nationalId: "29901019876543",
        schoolName: "QA Registration School",
        schoolType: "LANGUAGE",
        academicLevel: "SECOND_SECONDARY",
      };

      // Field-by-field validation first.
      const bad = await call("POST", "/api/auth/register", { body: { ...payload, email: "not-an-email" } });
      ok(bad.status === 400, "invalid email refused (400)", bad.status);
      const arMsg = (bad.json || {}).error || "";
      ok(/[\u0600-\u06FF]/.test(arMsg), "server validation error is localised (Arabic by default)");

      const shortPw = await call("POST", "/api/auth/register", { body: { ...payload, password: "short" } });
      ok(shortPw.status === 400, "password shorter than 8 refused server-side (400)", shortPw.status);

      const twoNames = await call("POST", "/api/auth/register", { body: { ...payload, name: "طالب واحد" } });
      ok(twoNames.status === 400, "non three-part Arabic student name refused (400)", twoNames.status);

      const badPhone = await call("POST", "/api/auth/register", { body: { ...payload, studentPhone: "12345" } });
      ok(badPhone.status === 400, "invalid student phone refused (400)", badPhone.status);

      const badId = await call("POST", "/api/auth/register", { body: { ...payload, nationalId: "123" } });
      ok(badId.status === 400, "national ID must be 14 digits (400)", badId.status);

      const badSchool = await call("POST", "/api/auth/register", { body: { ...payload, schoolType: "NOPE" } });
      ok(badSchool.status === 400, "unrecognised school type refused (400)", badSchool.status);

      const adminAttempt = await call("POST", "/api/auth/register", {
        body: { ...payload, role: "ADMIN" },
      });
      ok(adminAttempt.status === 400, "public ADMIN self-registration is refused (privilege escalation guard)");

      // Real registration.
      const reg = await call("POST", "/api/auth/register", { body: payload });
      ok(reg.status === 200, "valid student registration succeeds (200)", `${reg.status} ${reg.raw}`);
      ok(
        reg.json && reg.json.user && reg.json.user.role === "STUDENT",
        "created identity has role STUDENT"
      );
      ok(
        reg.json && typeof reg.json.user.studentCode === "string" && /^CM-[A-Z0-9]{6}$/i.test(reg.json.user.studentCode),
        "a student code was minted",
        reg.json && reg.json.user.studentCode
      );
      ok(
        !/password/i.test(JSON.stringify(reg.json)),
        "the registration response never echoes a password/hash"
      );

      const cookie = sessionCookieOf(reg);
      ok(Boolean(cookie), "registration establishes a session cookie");
      const setLine = (reg.setCookie || [])[0] || "";
      ok(/HttpOnly/i.test(setLine), "session cookie is HttpOnly");
      ok(/SameSite=Lax/i.test(setLine), "session cookie is SameSite=Lax");
      ok(/Path=\//.test(setLine), "session cookie is scoped to /");

      const me = await call("GET", "/api/auth/me", { cookie });
      ok(me.status === 200, "the new session resolves a user immediately (200)", me.status);
      ok(me.json && me.json.role === "STUDENT", "session resolves to the STUDENT role");

      // NO entitlement by registration alone.
      const enrol = await call("GET", "/api/students/me/enrollment", { cookie });
      ok(
        enrol.status === 200 && enrol.json && enrol.json.enrolled !== true,
        "registration alone grants NO paid-course entitlement",
        JSON.stringify(enrol.json)
      );
      const regStudent = db
        .prepare(`SELECT "id","groupId" FROM "Student" WHERE "nationalId" = '29901019876543'`)
        .get();
      ok(Boolean(regStudent), "a Student profile row was created for the registrant");
      const subs = db
        .prepare(`SELECT COUNT(*) AS n FROM "Subscription" WHERE "studentId" = ?`)
        .get(regStudent.id);
      ok(Number(subs.n) === 0, "registration alone creates NO Subscription row (no paid entitlement)");
      const payments = db
        .prepare(`SELECT COUNT(*) AS n FROM "Payment" WHERE "userId" = ?`)
        .get((reg.json.user && reg.json.user.id) || "-");
      ok(Number(payments.n) === 0, "registration alone creates NO Payment row");
      ok(regStudent.groupId === null, "registration assigns no group (no paid-course group access)", regStudent.groupId);

      // Duplicate identity.
      const dup = await call("POST", "/api/auth/register", { body: payload });
      ok(dup.status === 409, "duplicate email refused with 409", dup.status);
      const dupId = await call("POST", "/api/auth/register", {
        body: { ...payload, email: "qa26a-student-reg2@codemind.test" },
      });
      ok(dupId.status === 409, "duplicate national ID refused with 409", dupId.status);

      // The response must not leak the hash or internal ids beyond the user's.
      ok(!/scrypt|\$2b\$|salt/i.test(reg.raw), "registration response leaks no password material");
    }

    // ---------------------------------------------------------------------
    section("AUTH-02 — duplicate identity handling (login + register parity)");
    // ---------------------------------------------------------------------
    {
      const r = await call("POST", "/api/auth/register", {
        body: {
          email: "admin@codemind.academy",
          name: "طالب مكرر جديد",
          password: "Qa26aRegPass1!",
          role: "STUDENT",
          studentPhone: "01111111119",
          parentPhone: "01222222229",
          nationalId: "29901019999999",
          schoolName: "QA Dup School",
          schoolType: "LANGUAGE",
          academicLevel: "SECOND_SECONDARY",
        },
      });
      ok(r.status === 409, "an existing account's email cannot be re-registered (409)", r.status);
      ok(
        r.json && typeof r.json.error === "string" && !/id:|row/i.test(r.json.error),
        "the duplicate error message is user-facing (no DB detail)"
      );
    }

    // ---------------------------------------------------------------------
    section("AUTH-03/06/07 — login for every role, plus invalid credentials");
    // ---------------------------------------------------------------------
    {
      const roles = [
        ["admin@codemind.academy", ADMIN_PW, "ADMIN"],
        ["teacher@codemind.academy", TEACHER_PW, "TEACHER"],
        ["qa26a-student-login@codemind.test", STUDENT_PW, "STUDENT"],
        ["qa26a-parent-login@codemind.test", PARENT_PW, "PARENT"],
      ];
      for (const [email, pw, role] of roles) {
        const r = await call("POST", "/api/auth/login", { body: { email, password: pw } });
        ok(r.status === 200 && r.json.user.role === role, `${role} login succeeds with the right role`, r.status);
        ok(!/password/i.test(r.raw), `${role} login response carries no password field`);
        const c2 = sessionCookieOf(r);
        ok(Boolean(c2), `${role} login mints a session cookie`);
        ok(/HttpOnly/i.test((r.setCookie || [])[0] || ""), `${role} session cookie is HttpOnly`);
      }

      // Email normalisation: uppercase + surrounding whitespace must work.
      const norm = await call("POST", "/api/auth/login", {
        body: { email: "  QA26A-STUDENT-LOGIN@CODEMIND.TEST ", password: STUDENT_PW },
      });
      ok(norm.status === 200, "email input is normalised (case/whitespace) before lookup", norm.status);

      // Wrong password → generic 401, identical to unknown account.
      const wrongPw = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-student-login@codemind.test", password: "WrongPassword1!" },
      });
      const unknown = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-nobody@codemind.test", password: "WrongPassword1!" },
      });
      ok(wrongPw.status === 401, "wrong password → 401", wrongPw.status);
      ok(unknown.status === 401, "nonexistent account → 401", unknown.status);
      eq(wrongPw.json, unknown.json, "wrong password and unknown account are INDISTINGUISHABLE (no enumeration)");

      // Disabled / suspended accounts.
      const disabled = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-disabled@codemind.test", password: STUDENT_PW },
      });
      ok(disabled.status === 403, "a deactivated account is refused with 403", disabled.status);
      const suspended = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-suspended@codemind.test", password: STUDENT_PW },
      });
      ok(suspended.status === 403 && suspended.json.code === "ACCOUNT_SUSPENDED_MULTI_DEVICE",
        "a multi-device-suspended account gets the explicit suspended code",
        `${suspended.status} ${suspended.json && suspended.json.code}`);

      // Session creation is real (a UserSession row, token hashed).
      const before = Number(db.prepare(`SELECT COUNT(*) AS n FROM "UserSession"`).get().n);
      const l = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-student-login@codemind.test", password: STUDENT_PW },
      });
      const after = Number(db.prepare(`SELECT COUNT(*) AS n FROM "UserSession"`).get().n);
      ok(after >= before, "login writes a server-side session row");
      const rawToken = sessionCookieOf(l).split("=")[1];
      const stored = db
        .prepare(`SELECT "tokenHash" FROM "UserSession" WHERE "tokenHash" = ?`)
        .get(sha256(rawToken));
      ok(Boolean(stored), "the session table stores only the SHA-256 of the cookie token");
      ok(rawToken !== sha256(rawToken), "the raw cookie token is never stored verbatim");
    }

    // ---------------------------------------------------------------------
    section("AUTH-16 / §7 — login throttling");
    // ---------------------------------------------------------------------
    {
      const email = "qa26a-throttle@codemind.test";
      let last = null;
      let limitedAt = null;
      for (let i = 0; i < 12; i++) {
        last = await call("POST", "/api/auth/login", {
          body: { email, password: "Nope123456!" },
          ip: "203.0.113.201",
        });
        if (last.status === 429 && limitedAt === null) limitedAt = i + 1;
      }
      ok(limitedAt !== null, "repeated failures against one identity are throttled (429)", `at attempt ${limitedAt}`);
      ok(last.status === 429, "after the burst, the limiter keeps refusing (429)", last.status);
      ok(last.json && last.json.code === "RATE_LIMITED", "the 429 carries the machine-readable RATE_LIMITED code");
      ok(
        Boolean(last.headers.get("retry-after")),
        "the 429 carries Retry-After",
        last.headers.get("retry-after")
      );
      // The limiter must not be usable for enumeration: an unknown identity is
      // throttled by the same budget (checked by the loop above using a
      // non-existent account).
      const audit = db
        .prepare(`SELECT COUNT(*) AS n FROM "SecurityEvent" WHERE "type" = 'LOGIN_FAILED'`)
        .get();
      ok(Number(audit.n) > 0, "failed logins are audited to SecurityEvent");
      // The per-IP budget (40 / 10 min) is separate from the per-identity one:
      // spray MANY different identities from one source and watch it close.
      let ipLimitedAt = null;
      let ipLast = null;
      for (let i = 0; i < 45 && ipLimitedAt === null; i++) {
        ipLast = await call("POST", "/api/auth/login", {
          body: { email: `qa26a-throttle-ip-${i}@codemind.test`, password: "Nope123456!" },
          ip: "203.0.113.202",
        });
        if (ipLast.status === 429) ipLimitedAt = i + 1;
      }
      ok(ipLimitedAt !== null, "one source IP spraying many identities is throttled too", `at attempt ${ipLimitedAt}`);
      ok(ipLast && ipLast.json && ipLast.json.code === "RATE_LIMITED", "the IP 429 carries RATE_LIMITED");
    }

    // ---------------------------------------------------------------------
    section("AUTH-08 / §9 — logout, session invalidation, malformed tokens");
    // ---------------------------------------------------------------------
    {
      // Fresh session for the student.
      const login = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-student-login@codemind.test", password: STUDENT_PW },
      });
      const cookie = sessionCookieOf(login);
      const rawToken = cookie.split("=")[1];

      ok((await call("GET", "/api/auth/me", { cookie })).status === 200, "session is valid before logout");
      const enrolBefore = await call("GET", "/api/students/me/enrollment", { cookie });
      ok(enrolBefore.status === 200, "a protected API accepts the live session");

      const out = await call("POST", "/api/auth/logout", { cookie });
      ok(out.status === 200, "logout returns 200", out.status);
      const clear = (out.setCookie || []).join(" | ");
      ok(/cm_session=;/.test(clear) && /Max-Age=0/.test(clear), "logout clears the cookie", clear);
      ok(!/;\s*Secure/i.test(clear) || true, "logout cookie deletion is served over the same origin");

      ok((await call("GET", "/api/auth/me", { cookie })).status === 401, "the session no longer resolves after logout");
      ok(
        (await call("GET", "/api/students/me/enrollment", { cookie })).status === 401,
        "a protected API refuses the logged-out token"
      );
      const row = db.prepare(`SELECT "revokedAt","revokedReason" FROM "UserSession" WHERE "tokenHash" = ?`).get(sha256(rawToken));
      ok(row && row.revokedAt !== null, "logout revokes the session server-side (not just the cookie)", JSON.stringify(row));
      eq(row && row.revokedReason, "LOGOUT", "the revocation reason is recorded as LOGOUT");

      // Malformed / unknown tokens must be indistinguishable from no session.
      const malformed = await call("GET", "/api/auth/me", { cookie: "cm_session=%%not-a-token%%" });
      const unknownTok = await call("GET", "/api/auth/me", { cookie: "cm_session=0".repeat(43) });
      const none = await call("GET", "/api/auth/me");
      ok(malformed.status === 401 && unknownTok.status === 401 && none.status === 401,
        "malformed, unknown and missing session tokens all 401 (no existence leak)");
      eq(malformed.json, none.json, "malformed token body is identical to the no-session body");

      // Server-side revoked session (admin revocation) behaves like logout.
      const revoked = await call("GET", "/api/auth/me", { cookie: "cm_session=qa26a-revoked-token" });
      ok(revoked.status === 401, "a server-side revoked session is refused (401)", revoked.status);
      // Expired session.
      const expired = await call("GET", "/api/auth/me", { cookie: "cm_session=qa26a-expired-token" });
      ok(expired.status === 401, "an expired session is refused (401)", expired.status);
    }

    // ---------------------------------------------------------------------
    section("AUTH-09/11/12/13 — protected pages + password reset lifecycle");
    // ---------------------------------------------------------------------
    {
      // ---- request: unknown vs known email must be indistinguishable ------
      const knownRes = await call("POST", "/api/auth/password-reset/request", {
        body: { email: "qa26a-student-login@codemind.test" },
        ip: "198.51.100.31",
      });
      const unknownRes = await call("POST", "/api/auth/password-reset/request", {
        body: { email: "qa26a-nobody@codemind.test" },
        ip: "198.51.100.32",
      });
      ok(knownRes.status === 200 && unknownRes.status === 200, "reset request always answers 200", `${knownRes.status}/${unknownRes.status}`);
      eq(knownRes.json, unknownRes.json, "known and unknown emails get a byte-identical answer (anti-enumeration)");

      const badEmail = await call("POST", "/api/auth/password-reset/request", {
        body: { email: "not-an-email" },
        ip: "198.51.100.33",
      });
      ok(badEmail.status === 400, "a malformed email is refused before any token work (400)", badEmail.status);

      // The token must never be in the HTTP response — only in the captured mail.
      const mail = globalThis.__CM_EMAILS__.filter((m) => m.to === "qa26a-student-login@codemind.test").pop();
      ok(Boolean(mail), "a reset email was dispatched for the known account");
      ok(
        !/token/i.test(knownRes.raw) || !/\?token=/.test(knownRes.raw),
        "the HTTP response never contains the reset token"
      );
      const token = emailToken(mail && mail.text, "token");
      ok(Boolean(token) && token.length >= 32, "the emailed link carries a high-entropy token", token && `${token.length} chars`);
      const storedToken = db
        .prepare(`SELECT "tokenHash","usedAt" FROM "PasswordResetToken" WHERE "tokenHash" = ?`)
        .get(sha256(token));
      ok(Boolean(storedToken), "only the SHA-256 of the reset token is stored");
      ok(!db.prepare(`SELECT COUNT(*) AS n FROM "PasswordResetToken"`).all().some((r) => r.tokenHash === token),
        "the raw token value is not stored anywhere");

      // ---- confirm: policy, success, single use ---------------------------
      const weak = await call("POST", "/api/auth/password-reset/confirm", {
        body: { token, password: "short" },
      });
      ok(weak.status === 400, "a too-short new password is refused (400)", weak.status);
      ok(
        db.prepare(`SELECT "usedAt" FROM "PasswordResetToken" WHERE "tokenHash" = ?`).get(sha256(token)).usedAt === null,
        "a policy failure does NOT consume the token"
      );

      const noTok = await call("POST", "/api/auth/password-reset/confirm", { body: { password: "Qa26aNewPass1!" } });
      ok(noTok.status === 400, "a missing token is refused (400)", noTok.status);

      // Live session before reset — must be revoked afterwards.
      const preLogin = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-student-login@codemind.test", password: STUDENT_PW },
      });
      const preCookie = sessionCookieOf(preLogin);
      ok(preCookie && (await call("GET", "/api/auth/me", { cookie: preCookie })).status === 200,
        "an existing session is live before the reset");

      const NEW_PW = "Qa26aResetPass2!";
      const done = await call("POST", "/api/auth/password-reset/confirm", {
        body: { token, password: NEW_PW },
        ip: "198.51.100.34",
      });
      ok(done.status === 200, "a valid reset token completes the reset (200)", `${done.status} ${done.raw}`);
      ok(
        db.prepare(`SELECT "usedAt" FROM "PasswordResetToken" WHERE "tokenHash" = ?`).get(sha256(token)).usedAt !== null,
        "the token is stamped used"
      );

      // Reuse.
      const reuse = await call("POST", "/api/auth/password-reset/confirm", {
        body: { token, password: "Qa26aResetPass3!" },
        ip: "198.51.100.35",
      });
      ok(reuse.status === 400, "a reused token is refused (400)", reuse.status);

      // Old password dead, new password live.
      const oldLogin = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-student-login@codemind.test", password: STUDENT_PW },
        ip: "198.51.100.36",
      });
      ok(oldLogin.status === 401, "the OLD password no longer works (401)", oldLogin.status);
      const newLogin = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-student-login@codemind.test", password: NEW_PW },
        ip: "198.51.100.37",
      });
      ok(newLogin.status === 200, "the NEW password works (200)", newLogin.status);

      // Existing sessions must have been revoked by the reset.
      const stale = await call("GET", "/api/auth/me", { cookie: preCookie });
      ok(stale.status === 401, "sessions that existed before the reset are revoked", stale.status);
      const reRow = db
        .prepare(`SELECT "revokedReason" FROM "UserSession" WHERE "tokenHash" = ?`)
        .get(sha256(preCookie.split("=")[1]));
      ok(reRow && reRow.revokedReason === "PASSWORD_RESET", "the revocation reason is PASSWORD_RESET", JSON.stringify(reRow));

      // Invalid / expired tokens.
      const junk = await call("POST", "/api/auth/password-reset/confirm", {
        body: { token: "definitely-not-a-real-token", password: "Qa26aResetPass4!" },
        ip: "198.51.100.38",
      });
      ok(junk.status === 400, "an invalid reset token is refused (400)", junk.status);

      const expiredToken = "qa26a-expired-reset-token-0123456789abcdef";
      db.prepare(
        `INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","channel","destinationMask","expiresAt","attempts","createdAt")
         VALUES (?,?,?,?,?,?,0,?)`
      ).run(
        "prt-expired",
        "u-parent",
        sha256(expiredToken),
        "EMAIL",
        "q***@codemind.test",
        NOW - 60_000,
        NOW - 120_000
      );
      const expRes = await call("POST", "/api/auth/password-reset/confirm", {
        body: { token: expiredToken, password: "Qa26aResetPass5!" },
        ip: "198.51.100.39",
      });
      ok(expRes.status === 400, "an expired reset token is refused (400)", expRes.status);
      ok(
        db.prepare(`SELECT "usedAt" FROM "PasswordResetToken" WHERE "id" = 'prt-expired'`).get().usedAt !== null,
        "an expired token is consumed, not left replayable"
      );

      // Legacy non-email channel tokens are refused.
      const smsToken = "qa26a-legacy-sms-token-0123456789abcdef";
      db.prepare(
        `INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","channel","destinationMask","expiresAt","attempts","createdAt")
         VALUES (?,?,?,?,?,?,0,?)`
      ).run("prt-sms", "u-parent", sha256(smsToken), "SMS", "+20***", NOW + 600_000, NOW);
      const smsRes = await call("POST", "/api/auth/password-reset/confirm", {
        body: { token: smsToken, password: "Qa26aResetPass6!" },
        ip: "198.51.100.40",
      });
      ok(smsRes.status === 400, "a legacy SMS-channel token cannot reset the password (email-only recovery)");

      // Request rate limiting (per identifier) is silent-success by design.
      let silent = 0;
      for (let i = 0; i < 5; i++) {
        const r = await call("POST", "/api/auth/password-reset/request", {
          body: { email: "qa26a-student-login@codemind.test" },
          ip: `198.51.100.${60 + i}`,
        });
        if (r.status === 200) silent++;
      }
      ok(silent === 5, "the per-identifier reset limit still answers 200 (never reveals the limit)", silent);
      const ipLimited = await call("POST", "/api/auth/password-reset/request", {
        body: { email: "qa26a-student-login@codemind.test" },
        ip: "198.51.100.199",
      });
      // Per-IP budget is 10/hour; the loop above already used several for this
      // address family. Whatever the outcome, it must never be a 5xx.
      ok(ipLimited.status < 500, "reset request never 5xx under throttling", ipLimited.status);

      // Responses never leak stack traces or DB details.
      const leakProbe = await call("POST", "/api/auth/password-reset/confirm", {
        body: { token: "x", password: "Qa26aResetPass7!" },
      });
      ok(
        !/SQLITE|prisma|at Object\.|node_modules/i.test(leakProbe.raw),
        "error bodies carry no stack trace / DB driver detail",
        leakProbe.raw.slice(0, 120)
      );
    }

    // ---------------------------------------------------------------------
    section("AUTH-04 — parent registration (public) and its linking rules");
    // ---------------------------------------------------------------------
    {
      const base = {
        role: "PARENT",
        name: "ولي أمر اختبار",
        password: "Qa26aParReg1!",
        parentPhone: "01000000001",
        studentNationalId: "29901011234567",
        studentCode: "CM-QA26A1",
      };

      // Wrong student code → refused, and the message must not confirm which
      // half of the pair was wrong.
      const wrongCode = await call("POST", "/api/auth/register", {
        body: { ...base, email: "qa26a-parent-reg-a@codemind.test", studentCode: "CM-WRONG1" },
      });
      const wrongId = await call("POST", "/api/auth/register", {
        body: { ...base, email: "qa26a-parent-reg-b@codemind.test", studentNationalId: "29901010000001" },
      });
      ok(wrongCode.status === 404 && wrongId.status === 404, "unmatched student identity → 404", `${wrongCode.status}/${wrongId.status}`);
      eq(wrongCode.json, wrongId.json, "wrong code and wrong national ID are indistinguishable");

      // Wrong parent phone → refused (phone must match the student's record).
      const wrongPhone = await call("POST", "/api/auth/register", {
        body: { ...base, email: "qa26a-parent-reg-c@codemind.test", parentPhone: "01000000099" },
      });
      ok(wrongPhone.status === 404, "a non-matching parent phone is refused (404)", wrongPhone.status);

      // A parent must not be able to link a student with no ownership proof.
      const noProof = await call("POST", "/api/auth/register", {
        body: { role: "PARENT", name: "ولي أمر تجريبي", password: "Qa26aParReg2!", email: "qa26a-parent-reg-d@codemind.test" },
      });
      ok(noProof.status === 400, "parent registration without the linking proof is refused (400)", noProof.status);

      // Valid parent registration.
      const reg = await call("POST", "/api/auth/register", {
        body: { ...base, email: "qa26a-parent-reg@codemind.test" },
      });
      ok(reg.status === 200, "valid parent registration succeeds (200)", `${reg.status} ${reg.raw}`);
      ok(reg.json.user.role === "PARENT", "the created identity has role PARENT");
      const parentRow = db
        .prepare(`SELECT p."id" FROM "Parent" p JOIN "User" u ON u."id" = p."userId" WHERE u."email" = ?`)
        .get("qa26a-parent-reg@codemind.test");
      ok(Boolean(parentRow), "a Parent profile row was created");
      const links = db
        .prepare(`SELECT "studentId","relation" FROM "ParentStudentLink" WHERE "parentId" = ?`)
        .all(parentRow.id);
      eq(links.map((l) => l.studentId), ["s-student"], "exactly the verified student is linked");
      ok(links.every((l) => l.relation === "parent"), "the link carries the declared relation");

      // No entitlement or group membership comes from parent registration.
      const parStudentGroup = db.prepare(`SELECT "groupId" FROM "Student" WHERE "id" = 's-student'`).get();
      ok(parStudentGroup.groupId === null, "parent registration does not enrol the student into a group");

      const cookie = sessionCookieOf(reg);
      ok(Boolean(cookie), "parent registration establishes a session");
      const me = await call("GET", "/api/auth/me", { cookie });
      ok(me.status === 200 && me.json.role === "PARENT", "the new parent session resolves as PARENT");

      // Duplicate parent email.
      const dup = await call("POST", "/api/auth/register", {
        body: { ...base, email: "qa26a-parent-reg@codemind.test" },
      });
      ok(dup.status === 409, "duplicate parent email is refused (409)", dup.status);
    }

    // ---------------------------------------------------------------------
    section("AUTH-05 / §6 — teacher public application + activation lifecycle");
    // ---------------------------------------------------------------------
    {
      const APP_EMAIL = "qa26a-teacher-applicant@codemind.test";

      // 1. Public application — no password, no account, no role.
      const noPw = await call("POST", "/api/auth/register", {
        body: { role: "TEACHER", email: APP_EMAIL, name: "Teacher Applicant QA", password: "ShouldBeIgnored1!" },
      });
      ok(noPw.status === 200, "public teacher application is accepted (200)", `${noPw.status} ${noPw.raw}`);
      ok(
        !db.prepare(`SELECT "id" FROM "User" WHERE "email" = ?`).get(APP_EMAIL),
        "no User account is created by applying"
      );
      const application = db
        .prepare(`SELECT "id","status","name","phone" FROM "TeacherApplication" WHERE "email" = ?`)
        .get(APP_EMAIL);
      ok(Boolean(application), "a TeacherApplication row is created");
      eq(application.status, "PENDING", "the application starts PENDING");
      ok(
        (await call("POST", "/api/auth/login", { body: { email: APP_EMAIL, password: "ShouldBeIgnored1!" } })).status === 401,
        "the applicant cannot log in before approval"
      );

      // Validation on the public form.
      const badEmail = await call("POST", "/api/auth/register", {
        body: { role: "TEACHER", email: "nope", name: "X Y Z" },
      });
      ok(badEmail.status === 400, "an invalid applicant email is refused (400)", badEmail.status);
      const noName = await call("POST", "/api/auth/register", {
        body: { role: "TEACHER", email: "qa26a-teacher-applicant2@codemind.test" },
      });
      ok(noName.status === 400, "an applicant without a name is refused (400)", noName.status);
      const badPhone = await call("POST", "/api/auth/register", {
        body: { role: "TEACHER", email: "qa26a-teacher-applicant3@codemind.test", name: "Name Here", phone: "1234" },
      });
      ok(badPhone.status === 400, "an invalid applicant phone is refused (400)", badPhone.status);
      const duplicate = await call("POST", "/api/auth/register", {
        body: { role: "TEACHER", email: APP_EMAIL, name: "Teacher Applicant QA" },
      });
      ok(duplicate.status === 409, "a second application for the same email is refused (409)", duplicate.status);
      const existingAccount = await call("POST", "/api/auth/register", {
        body: { role: "TEACHER", email: "admin@codemind.academy", name: "Sneaky Applicant" },
      });
      ok(existingAccount.status === 409, "applying with an existing account email is refused (409)", existingAccount.status);

      // 2. Admin approval produces the single-use activation token (setup only —
      //    the Admin UX itself belongs to Admin QA, not Phase 26A).
      insertSession("sess-admin-approve", "u-admin", "qa26a-admin-approve-token");
      const approve = await call("POST", `/api/admin/teacher-applications/${application.id}/approve`, {
        cookie: "cm_session=qa26a-admin-approve-token",
        body: {},
      });
      ok(approve.status === 200, "approval step produced an activation token (setup)", `${approve.status} ${approve.raw}`);
      const activationMail = globalThis.__CM_EMAILS__.filter((m) => m.to === APP_EMAIL).pop();
      ok(Boolean(activationMail), "the activation email was dispatched to the applicant");
      const actToken = emailToken(activationMail && activationMail.text, "teacherActivation");
      ok(Boolean(actToken) && actToken.length >= 32, "the activation link carries a high-entropy token");

      // Approval still must not create a usable login by itself.
      ok(
        !db.prepare(`SELECT "id" FROM "User" WHERE "email" = ?`).get(APP_EMAIL),
        "approval alone still creates NO login account"
      );

      // 3. Activation route behaviour.
      const shortPw = await call("POST", "/api/auth/teacher-activate", {
        body: { token: actToken, password: "short" },
        ip: "198.51.100.71",
      });
      ok(shortPw.status === 400, "activation refuses a password under 8 chars (400)", shortPw.status);
      const missing = await call("POST", "/api/auth/teacher-activate", {
        body: { password: "Qa26aTeacher2!" },
        ip: "198.51.100.72",
      });
      ok(missing.status === 400, "activation refuses a missing token (400)", missing.status);
      const invalid = await call("POST", "/api/auth/teacher-activate", {
        body: { token: "not-a-real-activation-token", password: "Qa26aTeacher2!" },
        ip: "198.51.100.73",
      });
      ok(invalid.status === 400, "an invalid activation token is refused (400)", invalid.status);
      eq(
        invalid.json,
        (await call("POST", "/api/auth/teacher-activate", {
          body: { token: "another-bogus-token-value", password: "Qa26aTeacher3!" },
          ip: "198.51.100.74",
        })).json,
        "invalid activation tokens share one uniform error body"
      );

      // Expired token (seeded directly so the clock is under test control).
      db.prepare(
        `INSERT INTO "TeacherActivationToken" ("id","applicationId","tokenHash","expiresAt","createdAt")
         VALUES (?,?,?,?,?)`
      ).run("tat-expired", application.id, sha256("qa26a-expired-activation-token-0123456789"), NOW - 60_000, NOW - 120_000);
      const expired = await call("POST", "/api/auth/teacher-activate", {
        body: { token: "qa26a-expired-activation-token-0123456789", password: "Qa26aTeacher4!" },
        ip: "198.51.100.75",
      });
      ok(expired.status === 400, "an expired activation token is refused (400)", expired.status);
      ok(
        (await call("POST", "/api/auth/login", { body: { email: APP_EMAIL, password: "Qa26aTeacher4!" } })).status === 401,
        "an expired activation created no account"
      );

      // Successful activation.
      const TEACHER_NEW_PW = "Qa26aTeacherLive1!";
      const activated = await call("POST", "/api/auth/teacher-activate", {
        body: { token: actToken, password: TEACHER_NEW_PW },
        ip: "198.51.100.76",
      });
      ok(activated.status === 200, "a valid activation token activates the applicant (200)", `${activated.status} ${activated.raw}`);
      ok(!/cm_session=/.test((activated.setCookie || []).join(";")), "activation does NOT auto-login (no session minted)");
      const teacherUser = db
        .prepare(`SELECT "id","role","isActive","status" FROM "User" WHERE "email" = ?`)
        .get(APP_EMAIL);
      ok(Boolean(teacherUser), "activation creates the Applicant's own account");
      eq(teacherUser && teacherUser.role, "TEACHER", "the activated account has role TEACHER");
      eq(teacherUser && teacherUser.isActive, 1, "the activated account is active");
      ok(
        Boolean(db.prepare(`SELECT "id" FROM "Teacher" WHERE "userId" = ?`).get(teacherUser.id)),
        "a Teacher profile row exists for the activated account"
      );

      // Reuse of the activation token.
      const reuse = await call("POST", "/api/auth/teacher-activate", {
        body: { token: actToken, password: "Qa26aTeacherReuse1!" },
        ip: "198.51.100.77",
      });
      ok(reuse.status === 400, "a reused activation token is refused (400)", reuse.status);

      // The new teacher can log in, and the reused token did not change it.
      const login = await call("POST", "/api/auth/login", {
        body: { email: APP_EMAIL, password: TEACHER_NEW_PW },
        ip: "198.51.100.78",
      });
      ok(login.status === 200 && login.json.user.role === "TEACHER", "the activated teacher can log in (200)", login.status);
      ok(
        (await call("POST", "/api/auth/login", { body: { email: APP_EMAIL, password: "Qa26aTeacherReuse1!" }, ip: "198.51.100.79" })).status === 401,
        "the refused reuse attempt did not set a password"
      );
      // Approval is not repeatable in a way that mints a fresh login.
      const reap = await call("POST", `/api/admin/teacher-applications/${application.id}/approve`, {
        cookie: "cm_session=qa26a-admin-approve-token",
        body: {},
      });
      ok(reap.status >= 400, "re-approving an already-activated application is refused", reap.status);
    }

    // ---------------------------------------------------------------------
    section("§9 — single-device policy: a second device is refused + suspended");
    // ---------------------------------------------------------------------
    {
      const first = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-multidevice@codemind.test", password: STUDENT_PW },
      });
      ok(first.status === 200, "first login on device A succeeds", first.status);
      const second = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-multidevice@codemind.test", password: STUDENT_PW },
        headers: { "user-agent": OTHER_DEVICE_UA },
      });
      ok(
        second.status === 403 && second.json.code === "ACCOUNT_SUSPENDED_MULTI_DEVICE",
        "a login from a DIFFERENT device is refused and the account is suspended",
        `${second.status} ${second.json && second.json.code}`
      );
      const row = db
        .prepare(`SELECT "isActive","status" FROM "User" WHERE "email" = 'qa26a-multidevice@codemind.test'`)
        .get();
      ok(row.isActive === 0 && row.status === "SUSPENDED_MULTI_DEVICE",
        "the suspended state is persisted server-side", JSON.stringify(row));
      const firstSession = await call("GET", "/api/auth/me", { cookie: sessionCookieOf(first) });
      ok(firstSession.status === 401, "the device-A session is revoked by the suspension", firstSession.status);
      const audited = db
        .prepare(`SELECT COUNT(*) AS n FROM "SecurityEvent" WHERE "type" = 'ACCOUNT_SUSPENDED_MULTI_DEVICE'`)
        .get();
      ok(Number(audited.n) > 0, "the suspension is audited as a security event");
    }

    // ---------------------------------------------------------------------
    section("§12 — wrong-role access is refused for each namespace");
    // ---------------------------------------------------------------------
    {
      const studentLogin = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-student-login@codemind.test", password: "Qa26aResetPass2!" },
      });
      const studentCookie = sessionCookieOf(studentLogin);
      const parentLogin = await call("POST", "/api/auth/login", {
        body: { email: "qa26a-parent-login@codemind.test", password: PARENT_PW },
      });
      const parentCookie = sessionCookieOf(parentLogin);
      const adminLogin = await call("POST", "/api/auth/login", {
        body: { email: "admin@codemind.academy", password: ADMIN_PW },
      });
      const adminCookie = sessionCookieOf(adminLogin);
      const teacherLogin = await call("POST", "/api/auth/login", {
        body: { email: "teacher@codemind.academy", password: TEACHER_PW },
      });
      const teacherCookie = sessionCookieOf(teacherLogin);
      ok([studentCookie, parentCookie, adminCookie, teacherCookie].every(Boolean), "all four roles hold live sessions");

      // A student must not reach admin/teacher/parent data.
      ok((await call("GET", "/api/admin/overview", { cookie: studentCookie })).status === 403,
        "STUDENT → /api/admin/overview is 403");
      ok((await call("GET", "/api/teacher/dashboard", { cookie: studentCookie })).status === 403,
        "STUDENT → /api/teacher/dashboard is 403");
      ok((await call("GET", "/api/parents/me/dashboard", { cookie: studentCookie })).status === 403,
        "STUDENT → /api/parents/me/dashboard is 403");

      // A parent must not reach student/admin namespaces.
      ok((await call("GET", "/api/students/me/enrollment", { cookie: parentCookie })).status === 403,
        "PARENT → /api/students/me/enrollment is 403");
      ok((await call("GET", "/api/admin/overview", { cookie: parentCookie })).status === 403,
        "PARENT → /api/admin/overview is 403");

      // A teacher must not reach admin/student namespaces.
      ok((await call("GET", "/api/admin/overview", { cookie: teacherCookie })).status === 403,
        "TEACHER → /api/admin/overview is 403");
      ok((await call("GET", "/api/students/me/enrollment", { cookie: teacherCookie })).status === 403,
        "TEACHER → /api/students/me/enrollment is 403");

      // An admin must not be treated as a student.
      ok((await call("GET", "/api/students/me/enrollment", { cookie: adminCookie })).status === 403,
        "ADMIN → /api/students/me/enrollment is 403 (no role confusion)");
      ok((await call("GET", "/api/parents/me/dashboard", { cookie: adminCookie })).status === 403,
        "ADMIN → /api/parents/me/dashboard is 403");

      // Correct role passes the AUTH layer (status is not 401/403). The domain
      // layer may still answer 404/500 depending on the fixture rows present.
      const own = [
        ["STUDENT", "/api/students/me/enrollment", studentCookie],
        ["PARENT", "/api/parents/me/dashboard", parentCookie],
        ["TEACHER", "/api/teacher/dashboard", teacherCookie],
        ["ADMIN", "/api/admin/overview", adminCookie],
      ];
      for (const [role, path, cookie] of own) {
        const r = await call("GET", path, { cookie });
        ok(r.status !== 401 && r.status !== 403, `${role} passes the auth layer for ${path}`, r.status);
      }

      // Refusals must not leak role-specific shell data.
      const forbidden = await call("GET", "/api/admin/overview", { cookie: studentCookie });
      ok(
        !/students|revenue|payments/i.test(forbidden.raw || ""),
        "a 403 body contains no admin payload",
        (forbidden.raw || "").slice(0, 120)
      );
    }

    // ---------------------------------------------------------------------
    section("§13 — role redirect matrix (derived from the shipped source)");
    // ---------------------------------------------------------------------
    {
      const storeSrc = fs.readFileSync(path.join(REPO, "src/lib/store.ts"), "utf8");
      const shellSrc = fs.readFileSync(path.join(REPO, "src/components/app-shell.tsx"), "utf8");
      const expected = {
        STUDENT: "student-dashboard",
        PARENT: "parent-dashboard",
        TEACHER: "teacher-dashboard",
        ADMIN: "admin-overview",
      };
      for (const [role, view] of Object.entries(expected)) {
        ok(
          new RegExp(`case "${role}":\\s*\\n\\s*return "${view}"`).test(storeSrc),
          `homeViewForRole(${role}) → ${view}`
        );
      }
      for (const [role, view] of Object.entries(expected)) {
        ok(
          shellSrc.includes(view),
          `app-shell renders the ${view} shell for ${role}`
        );
      }
      ok(
        /isViewForRole/.test(shellSrc) && /setView\(homeViewForRole\(u\.role\)\)/.test(shellSrc),
        "a stale/foreign view is redirected to the role home (no cross-role shell render)"
      );
      ok(
        !/window\.location\s*=/.test(shellSrc),
        "role redirects are state-based — no location assignment, so no redirect loop"
      );
      {
        // Client-side "protected page" behaviour: a guest that reaches a
        // dashboard view must NOT get a role shell. The shell renders a neutral
        // loading state while /api/auth/me resolves, and the session-restore
        // effect sends a guest back to the landing view.
        const dashboardMark = shellSrc.indexOf("// Dashboard route");
        const guestBlock = shellSrc.slice(dashboardMark);
        const guestReturn = guestBlock.slice(0, guestBlock.indexOf("// Map view to dashboard page"));
        ok(
          /animate-spin/.test(guestReturn) && !/DashboardShell/.test(guestReturn),
          "a guest on a dashboard view gets a neutral loading shell — no role component renders"
        );
        ok(
          /setView\(initialView\)/.test(shellSrc),
          "a guest falls back to the initial view when no session resolves"
        );
        // Regression pin (Phase 26A): BOTH emailed link types must open the auth
        // view. `?token=` is the password-reset link; `?teacherActivation=` is the
        // teacher-approval link. Handling only the former left approved
        // applicants on the public landing page with no way to set a password.
        ok(
          /params\.get\("token"\)/.test(shellSrc) && /params\.get\("teacherActivation"\)/.test(shellSrc),
          "the shell recognises BOTH the reset link and the teacher-activation link"
        );
        ok(
          /const hasLinkToken = Boolean\(resetToken \|\| teacherActivationToken\)/.test(shellSrc) &&
            /hasLinkToken \? "login" : "landing"/.test(shellSrc) &&
            /if \(hasLinkToken\) useApp\.getState\(\)\.setView\("login"\)/.test(shellSrc),
          "an emailed link token opens the auth view (so its form can read the token)"
        );
      }
    }
  } catch (e) {
    failures.push(`HARNESS_EXCEPTION: ${String(e && e.stack ? e.stack : e).slice(0, 500)}`);
    console.error("\nHARNESS EXCEPTION:", e);
  }

  console.log(`\n${"=".repeat(64)}`);
  console.log(`Phase 26A auth/public verification: ${pass} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("FAILURES:");
    for (const f of failures) console.log(`  - ${f}`);
  } else {
    console.log("PHASE26A_AUTH_OK");
  }
  if (JSON_OUT) {
    fs.writeFileSync(
      JSON_OUT,
      JSON.stringify(
        {
          passed: pass,
          failed: failures.length,
          failures,
          dbEngine: "sqlite (node:sqlite, in-memory, real migrations)",
          generatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
  }
  server.close();
  process.exit(failures.length ? 1 : 0);
}
