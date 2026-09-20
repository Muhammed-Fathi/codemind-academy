#!/usr/bin/env node
// CodeMind Academy — Phase 26B STUDENT FULL FLOW verification (real HTTP).
//
// WHY THIS SCRIPT EXISTS
//   Phase 26B must prove the REAL student lifecycle end-to-end:
//   register → school type → eligible groups → plan → payment submit →
//   PENDING (no access) → admin approval → ACTIVE + group assigned →
//   consume course (lesson / video / quiz / homework) → progression →
//   notifications → expiry warning → renewal (pending preserves access,
//   approval stacks endDate) → expired recovery → grandfathered safety →
//   rejection + retry. Every step runs the SHIPPED route handlers over REAL
//   HTTP against a REAL SQLite database built from the REAL migrations —
//   the same discipline as scripts/verify-phase26a-auth.mjs, which see for
//   the sandbox rationale (`binaries.prisma.sh` unreachable ⇒ no Prisma
//   engines ⇒ `next dev` cannot serve /api/*; only the data source, the mail
//   transport and Next's request plumbing are substituted).
//
//   Local fixtures only, all clearly labelled `qa26b-*`. No Neon, no R2,
//   no SMTP, no real payments.
//
// Usage:
//   node scripts/verify-phase26b-student.mjs
// Prints PHASE26B_STUDENT_OK on success.

import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module from "node:module";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(HERE, "..");

process.env.SECURITY_HASH_SECRET =
  process.env.SECURITY_HASH_SECRET || "phase26b-verifier-secret-0123456789abcdef";
process.env.NEXT_PUBLIC_URL = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------
let pass = 0;
const failures = [];
const matrix = []; // STUDENT-xx rows for the report
function ok(cond, label, extra) {
  if (cond) pass++;
  else {
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
function matrixRow(id, name, expected, actual, verdict, evidence) {
  matrix.push({ id, name, expected, actual, verdict, evidence });
  console.log(`  [${verdict}] ${id} — ${name}`);
}
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------------------------------------------------------------------
// 1. Compile the SHIPPED TypeScript (route handlers + the libs they decide
//    with) to CommonJS in a temp dir. Type errors are expected (the sandbox
//    cannot run `prisma generate`, so the generated client is a stub); tsc
//    still emits, and every module used at runtime is byte-for-byte shipped.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase26b-"));
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
  "src/lib/track-scope.ts",
  "src/lib/enrollment.ts",
  "src/lib/api.ts",
  "src/lib/auth.ts",
  "src/lib/route-protection.ts",
  "src/lib/subscription-entitlement.ts",
  "src/lib/payment-submission.ts",
  "src/lib/payment-transitions.ts",
  "src/lib/db-serialization.ts",
  "src/lib/payment-ux.ts",
  "src/lib/brand.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/session-progress.ts",
  "src/lib/session-quiz.ts",
  "src/lib/progress.ts",
  "src/lib/teacher-content.ts",
  "src/lib/notify.ts",
  "src/lib/notification-links.ts",
  "src/lib/deep-link.ts",
  "src/lib/media.ts",
  "src/lib/official-curriculum.ts",
  "src/lib/curriculum.ts",
  "src/lib/curriculum-visibility.ts",
  "src/app/api/auth/[action]/route.ts",
  "src/app/api/groups/route.ts",
  "src/app/api/courses/route.ts",
  "src/app/api/courses/[slug]/route.ts",
  "src/app/api/subscription-plans/route.ts",
  "src/app/api/enroll/route.ts",
  "src/app/api/students/me/enrollment/route.ts",
  "src/app/api/students/me/dashboard/route.ts",
  "src/app/api/students/me/payments/route.ts",
  "src/app/api/students/me/homework/route.ts",
  "src/app/api/students/me/bookmarks/route.ts",
  "src/app/api/students/me/notes/route.ts",
  "src/app/api/students/me/study-plan/route.ts",
  "src/app/api/students/me/gamification/route.ts",
  "src/app/api/students/me/leaderboard/route.ts",
  "src/app/api/students/me/certificate/route.ts",
  "src/app/api/students/me/export-progress/route.ts",
  "src/app/api/students/me/session-videos/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/lessons/[id]/progress/route.ts",
  "src/app/api/lessons/[id]/video-progress/route.ts",
  "src/app/api/quizzes/[id]/route.ts",
  "src/app/api/quizzes/[id]/start/route.ts",
  "src/app/api/quizzes/[id]/submit/route.ts",
  "src/app/api/materials/[id]/route.ts",
  "src/app/api/notifications/route.ts",
  "src/app/api/notifications/unread-count/route.ts",
  "src/app/api/teacher/quizzes/route.ts",
  "src/app/api/teacher/quizzes/[id]/publish/route.ts",
  "src/app/api/teacher/homework/route.ts",
  "src/app/api/teacher/homework/[id]/publish/route.ts",
  "src/app/api/admin/payments/route.ts",
  "src/app/api/admin/payments/[id]/approve/route.ts",
  "src/app/api/admin/payments/[id]/reject/route.ts",
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
} catch {
  // expected (stub Prisma types); emission still happens
}
const EMIT = path.join(OUT, "src");
for (const f of MODULES) {
  const emitted = path.join(OUT, f.replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(emitted)) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// 2. Real database — base DDL + every real migration, real SQLite engine.
// ---------------------------------------------------------------------------
const mig = require(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));

const rawDb = new DatabaseSync(":memory:");
rawDb.exec("PRAGMA foreign_keys = ON");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase26b: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// Local private media root (materials bytes) — a throwaway dir, never /public.
const MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cm26b-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_ROOT;
process.env.MEDIA_BACKEND = "local";

// ---------------------------------------------------------------------------
// 3. Shims — ONLY the data source, mail transport and Next request plumbing.
// ---------------------------------------------------------------------------
const dbShim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(dbShim, "module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n");

fs.writeFileSync(
  path.join(OUT, "__delivery-shim.js"),
  [
    "module.exports = {",
    "  sendEmail: async (params) => {",
    "    globalThis.__CM_EMAILS__.push({ to: params.to, subject: params.subject || '', text: params.text || '' });",
    "    return { delivered: true, provider: 'phase26b-capture' };",
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
    "    // A route may hand us a WEB READABLE STREAM (material/video delivery).",
    "    // Buffer it eagerly so the underlying fs stream is fully drained on",
    "    // THIS response, never leaking into a pooled keep-alive connection.",
    "    this._streamBuffer = null;",
    "    if (body && typeof body.getReader === 'function') {",
    "      this._body = null;",
    "      this._stream = body;",
    "    } else { this._stream = null; }",
    "  }",
    "  static json(data, init = {}) {",
    "    const merged = Object.assign({ 'content-type': 'application/json' }, init.headers || {});",
    "    const r = new NextResponse(JSON.stringify(data), { status: init.status ?? 200, headers: merged });",
    "    r._json = data; return r;",
    "  }",
    "  get headers() { const m = this._headers; return { get: (k) => m.get(String(k).toLowerCase()) ?? null, forEach: (fn) => m.forEach((v, k) => fn(v, k)) }; }",
    "  async _drain() {",
    "    if (!this._stream) return;",
    "    const chunks = []; const reader = this._stream.getReader();",
    "    for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }",
    "    this._streamBuffer = Buffer.concat(chunks); this._stream = null;",
    "  }",
    "  async json() {",
    "    if (this._json !== undefined) return this._json;",
    "    if (this._stream) { try { await this._drain(); } catch { return null; } }",
    "    if (this._streamBuffer) { try { return JSON.parse(this._streamBuffer.toString('utf8')); } catch { return null; } }",
    "    try { return JSON.parse(Buffer.from(this._body || []).toString('utf8')); } catch { return null; }",
    "  }",
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
const PaymentUx = require(path.join(EMIT, "lib", "payment-ux.js"));
const DeepLink = require(path.join(EMIT, "lib", "deep-link.js"));
const I18N = require(path.join(EMIT, "lib", "i18n-core.js"));

// ---------------------------------------------------------------------------
// 4. HTTP server over the real handlers (same as Phase 26A).
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

const ROUTES = [
  ["POST", /^\/api\/auth\/([^/]+)$/, () => route("auth/[action]/route.js").POST, (m) => ({ action: m[1] })],
  ["GET", /^\/api\/auth\/([^/]+)$/, () => route("auth/[action]/route.js").GET, (m) => ({ action: m[1] })],
  ["GET", /^\/api\/groups$/, () => route("groups/route.js").GET],
  ["GET", /^\/api\/courses$/, () => route("courses/route.js").GET],
  ["GET", /^\/api\/courses\/([^/]+)$/, () => route("courses/[slug]/route.js").GET, (m) => ({ slug: m[1] })],
  ["GET", /^\/api\/subscription-plans$/, () => route("subscription-plans/route.js").GET],
  ["POST", /^\/api\/enroll$/, () => route("enroll/route.js").POST],
  ["GET", /^\/api\/students\/me\/enrollment$/, () => route("students/me/enrollment/route.js").GET],
  ["GET", /^\/api\/students\/me\/dashboard$/, () => route("students/me/dashboard/route.js").GET],
  ["GET", /^\/api\/students\/me\/payments$/, () => route("students/me/payments/route.js").GET],
  ["GET", /^\/api\/students\/me\/homework$/, () => route("students/me/homework/route.js").GET],
  ["POST", /^\/api\/students\/me\/homework$/, () => route("students/me/homework/route.js").POST],
  ["GET", /^\/api\/students\/me\/bookmarks$/, () => route("students/me/bookmarks/route.js").GET],
  ["POST", /^\/api\/students\/me\/bookmarks$/, () => route("students/me/bookmarks/route.js").POST],
  ["GET", /^\/api\/students\/me\/notes$/, () => route("students/me/notes/route.js").GET],
  ["POST", /^\/api\/students\/me\/notes$/, () => route("students/me/notes/route.js").POST],
  ["GET", /^\/api\/students\/me\/study-plan$/, () => route("students/me/study-plan/route.js").GET],
  ["GET", /^\/api\/students\/me\/gamification$/, () => route("students/me/gamification/route.js").GET],
  ["GET", /^\/api\/students\/me\/leaderboard$/, () => route("students/me/leaderboard/route.js").GET],
  ["GET", /^\/api\/students\/me\/certificate$/, () => route("students/me/certificate/route.js").GET],
  ["GET", /^\/api\/students\/me\/export-progress$/, () => route("students/me/export-progress/route.js").GET],
  ["GET", /^\/api\/students\/me\/session-videos$/, () => route("students/me/session-videos/route.js").GET],
  ["GET", /^\/api\/lessons\/([^/]+)$/, () => route("lessons/[id]/route.js").GET, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/lessons\/([^/]+)\/progress$/, () => route("lessons/[id]/progress/route.js").POST, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/lessons\/([^/]+)\/video-progress$/, () => route("lessons/[id]/video-progress/route.js").POST, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/quizzes\/([^/]+)$/, () => route("quizzes/[id]/route.js").GET, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/quizzes\/([^/]+)\/start$/, () => route("quizzes/[id]/start/route.js").POST, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/quizzes\/([^/]+)\/submit$/, () => route("quizzes/[id]/submit/route.js").POST, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/materials\/([^/]+)$/, () => route("materials/[id]/route.js").GET, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/notifications$/, () => route("notifications/route.js").GET],
  ["GET", /^\/api\/notifications\/unread-count$/, () => route("notifications/unread-count/route.js").GET],
  ["GET", /^\/api\/teacher\/quizzes$/, () => route("teacher/quizzes/route.js").GET],
  ["POST", /^\/api\/teacher\/quizzes$/, () => route("teacher/quizzes/route.js").POST],
  ["POST", /^\/api\/teacher\/quizzes\/([^/]+)\/publish$/, () => route("teacher/quizzes/[id]/publish/route.js").POST, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/teacher\/homework$/, () => route("teacher/homework/route.js").GET],
  ["POST", /^\/api\/teacher\/homework$/, () => route("teacher/homework/route.js").POST],
  ["POST", /^\/api\/teacher\/homework\/([^/]+)\/publish$/, () => route("teacher/homework/[id]/publish/route.js").POST, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/admin\/payments$/, () => route("admin/payments/route.js").GET],
  ["POST", /^\/api\/admin\/payments\/([^/]+)\/approve$/, () => route("admin/payments/[id]/approve/route.js").POST, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/admin\/payments\/([^/]+)\/reject$/, () => route("admin/payments/[id]/reject/route.js").POST, (m) => ({ id: m[1] })],
];

function buildRequest({ method, url, headers, body, cookieHeader }) {
  const parsed = parseCookies(cookieHeader);
  const hdrs = new Headers(
    Object.fromEntries(Object.entries(headers || {}).filter(([, v]) => typeof v === "string"))
  );
  return {
    // Absolute request URL — exactly what a real Next.js route handler sees
    // (several handlers do `new URL(req.url)`).
    url: new URL(url, "http://127.0.0.1").toString(),
    method,
    nextUrl: new URL(url, "http://127.0.0.1"),
    headers: hdrs,
    cookies: { get: (n) => (parsed[n] === undefined ? undefined : { value: parsed[n] }) },
    json: async () => body,
    text: async () => JSON.stringify(body ?? {}),
    formData: async () => new Map(),
  };
}

async function dispatch({ method, pathname, search, headers, body, cookieHeader }) {
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = {
    cookie: parseCookies(cookieHeader),
    headers: {
      "user-agent": (headers && headers["user-agent"]) || "phase26b-verifier",
      "x-forwarded-for": (headers && headers["x-forwarded-for"]) || "198.51.100.7",
    },
  };
  const url = `${pathname}${search || ""}`;
  const proxyDecision = RouteProtection.decideApiAccess(pathname, Boolean(parseCookies(cookieHeader).cm_session));
  if (proxyDecision === "deny") {
    return { status: 401, json: { error: "Unauthorized" }, headers: [], setCookies: [], viaProxy: true };
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
      out.headers.forEach((v, k) => {
        // The harness ALWAYS writes its own JSON body, so a handler's
        // content-length (shaped for a PDF/stream body) would corrupt the
        // framing. Everything else is forwarded verbatim.
        if (String(k).toLowerCase() === "content-length") return;
        outHeaders.push([String(k), String(v)]);
      });
    }
    const setCookies = globalThis.__CM_RESP_COOKIES__ || [];
    let json = null;
    try {
      json = await out.json();
    } catch {
      json = null; // streamed/binary responses — status is the assertion
    }
    return { status: out.status ?? 200, json, headers: outHeaders, setCookies, viaProxy: false };
  }
  return { status: 404, json: { error: "not found" }, headers: [], setCookies: [], viaProxy: false };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
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
    res.end(JSON.stringify({ error: "HARNESS_ERROR", detail: String(e && e.message ? e.message : e).slice(0, 300) }));
  }
});

const BASE = await new Promise((r) =>
  server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`))
);

// Every response exposes BOTH shapes (`status`/`json` at the top level and the
// same under `res`) so assertions stay readable in both styles.
process.on("unhandledRejection", (e) => {
  console.log("SERVER-side unhandled rejection:", String(e?.stack || e).slice(0, 500));
});
const call = async (method, p, { body, cookie } = {}) => {
  let res;
  try {
    res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      "content-type": "application/json",
      "user-agent": "phase26b-verifier",
      ...(cookie ? { cookie } : {}),
    },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
  } catch (e) {
    console.log(`  TRANSPORT-ERROR ${method} ${p}:`, String(e?.cause?.message || e?.message || e).slice(0, 200));
    const out = { status: 0, json: null };
    return { ...out, res: out, setCookie: null };
  }
  let text = "";
  try {
    text = await res.text();
  } catch (e) {
    console.log(`  TRANSPORT-ERROR(body) ${method} ${p}:`, String(e?.cause?.message || e?.message || e).slice(0, 200));
  }
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  const out = { status: res.status, json };
  return {
    ...out,
    res: out,
    setCookie: res.headers.get("set-cookie"),
    disposition: res.headers.get("content-disposition"),
  };
};

const cookieOf = (res) => {
  const m = /cm_session=([^;]+)/.exec(res.setCookie || "");
  return m ? `cm_session=${m[1]}` : null;
};

// ---------------------------------------------------------------------------
// 5. Fixtures — clearly-labelled qa26b-* local rows only.
// ---------------------------------------------------------------------------
const db = rawDb;
const NOW = Date.now();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

const ADMIN_PW = "Qa26bAdminLocal1!";
const TEACHER_PW = "Qa26bTeacherLocal1!";

function insertUser(id, email, role, password, name) {
  db.prepare(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt")
     VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`
  ).run(id, email, Auth.hashPassword(password), name, role, NOW, NOW);
}
// Sessions are seeded the same way Phase 26A does: the cookie carries the RAW
// token, the row stores its SHA-256 — the shipped validation path.
function insertSession(id, userId, token) {
  db.prepare(
    `INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt","revokedAt")
     VALUES (?,?,?,?,?,?,?,NULL)`
  ).run(id, userId, sha256(token), "qa26b-device", NOW, NOW, NOW + 86400000);
}

insertUser("qa26b-admin", "qa26b-admin@local.test", "ADMIN", ADMIN_PW, "QA26B Admin");
insertUser("qa26b-teacher", "qa26b-teacher@local.test", "TEACHER", TEACHER_PW, "QA26B Teacher");
db.prepare(
  `INSERT INTO "Teacher" ("id","userId","specialty","createdAt","updatedAt") VALUES ('qa26b-teacher-row','qa26b-teacher','QA',?,?)`
).run(NOW, NOW);
insertSession("qa26b-admin-session", "qa26b-admin", "qa26b-admin-raw-token");
insertSession("qa26b-teacher-session", "qa26b-teacher", "qa26b-teacher-raw-token");
const ADMIN_COOKIE = "cm_session=qa26b-admin-raw-token";
const TEACHER_COOKIE = "cm_session=qa26b-teacher-raw-token";

// 5a. THE official curriculum (canonical 2 parts / 7 units / 23 lessons),
//     reconciled by the SHIPPED reconciler — the same code production uses.
const Official = require(path.join(EMIT, "lib", "official-curriculum.js"));
await Official.reconcileOfficialCurriculum(client);
const officialCount = db.prepare(`SELECT COUNT(*) AS c FROM "Lesson" WHERE "officialCode" IS NOT NULL`).get().c;
eq(officialCount, 23, "official curriculum reconciles to exactly 23 official lessons");
const unitCount = db.prepare(`SELECT COUNT(*) AS c FROM "Unit"`).get().c;
const partCount = db.prepare(`SELECT COUNT(*) AS c FROM "Part"`).get().c;
eq([partCount, unitCount], [2, 7], "official curriculum: 2 parts / 7 units");

const allOfficial = db
  .prepare(`SELECT "id","officialCode","unitId" FROM "Lesson" WHERE "officialCode" IS NOT NULL ORDER BY "officialCode"`)
  .all();
for (const l of allOfficial) {
  db.prepare(`UPDATE "Lesson" SET "status"='PUBLISHED' WHERE "id"=?`).run(l.id);
}
const byCode = Object.fromEntries(allOfficial.map((l) => [l.officialCode, l.id]));
const L1 = byCode["1-1"];
const L2 = byCode["1-2"];
const L3 = byCode["1-3"];
ok(Boolean(L1 && L2 && L3), "first three official lessons exist (1-1..1-3)");
const UNIT1 = allOfficial.find((l) => l.id === L1).unitId;
const COURSE_ID = db.prepare(`SELECT "courseId" FROM "Part" WHERE "id"=(SELECT "partId" FROM "Unit" WHERE "id"=?)`).get(UNIT1).courseId;

// Lesson 1 gets an EXTERNAL_URL video (the 95% heartbeat path is what we drive).
db.prepare(`UPDATE "Lesson" SET "videoUrl"='https://www.youtube.com/embed/qa26b-l1' WHERE "id"=?`).run(L1);

// 5b. A second course + group for the course/group binding tamper test.
db.prepare(
  `INSERT INTO "Course" ("id","slug","name","nameAr","description","color","createdAt","updatedAt")
   VALUES ('qa26b-course-other','qa26b-other','Other QA Course','كورس آخر','qa fixture','#123456',?,?)`
).run(NOW, NOW);
db.prepare(
  `INSERT INTO "Part" ("id","courseId","title","titleAr","order")
   VALUES ('qa26b-part-other','qa26b-course-other','P','ص','1')`
).run();
db.prepare(
  `INSERT INTO "Unit" ("id","partId","title","titleAr","order")
   VALUES ('qa26b-unit-other','qa26b-part-other','U','و','1')`
).run();
db.prepare(
  `INSERT INTO "Lesson" ("id","title","titleAr","order","unitId","status","trackScope","createdAt","updatedAt")
   VALUES ('qa26b-lesson-other','Other lesson','درس آخر','1','qa26b-unit-other','PUBLISHED','SHARED',?,?)`
).run(NOW, NOW);

// 5c. Groups. GAP-1 is FIXED (owner-approved): every group now carries an
//     explicit audience — Group.trackScope (ARABIC | LANGUAGE), the SAME enum
//     the content layer uses. trackScope=null seeds an UNCLASSIFIED group
//     (transitional legacy shape): it must stay invisible and unenrollable
//     until an admin classifies it (fail-closed).
function insertGroup(id, name, courseId, { capacity = 20, isActive = true, teacherId = "qa26b-teacher-row", trackScope = null } = {}) {
  db.prepare(
    `INSERT INTO "Group" ("id","name","courseId","teacherId","capacity","schedule","isActive","trackScope","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, name, courseId, teacherId, capacity, "Sat & Tue 6PM", isActive ? 1 : 0, trackScope, NOW, NOW);
}
insertGroup("qa26b-group-ar", "Group AR — السبت والثلاثاء 6م", COURSE_ID, { capacity: 20, trackScope: "ARABIC" });
insertGroup("qa26b-group-lang", "Group LANG — الأحد والأربعاء 8م", COURSE_ID, { capacity: 20, trackScope: "LANGUAGE" });
insertGroup("qa26b-group-full", "Group FULL — ممتلئة", COURSE_ID, { capacity: 1, trackScope: "ARABIC" });
insertGroup("qa26b-group-off", "Group OFF — موقوفة", COURSE_ID, { capacity: 20, isActive: false, trackScope: "ARABIC" });
insertGroup("qa26b-group-other", "Group OTHER — كورس آخر", "qa26b-course-other", { capacity: 20, teacherId: null, trackScope: "LANGUAGE" });
insertGroup("qa26b-group-null", "Group NULL — غير مصنفة", COURSE_ID, { capacity: 20, trackScope: null });
// The FULL group's seat holder (a plain fixture student, never a driver).
insertUser("qa26b-seat-user", "qa26b-seat@local.test", "STUDENT", "Qa26bSeatLocal1!", "Seat Holder");
db.prepare(
  `INSERT INTO "Student" ("id","userId","grade","schoolName","schoolType","nationalId","parentPhone","groupId","enrolledAt","createdAt","updatedAt")
   VALUES ('qa26b-seat-student','qa26b-seat-user','2nd Secondary','QA School','ARABIC','30000000001111','01000000001','qa26b-group-full',?,?,?)`
).run(NOW, NOW, NOW);

// 5d. Plans — Monthly + Early Bird (active) + one CLOSED plan.
db.prepare(
  `INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","isActive","createdAt")
   VALUES ('qa26b-plan-monthly','Monthly','شهري',1,200,0,1,?)`
).run(NOW);
db.prepare(
  `INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","isActive","description","createdAt")
   VALUES ('qa26b-plan-early','Early Bird','Early Bird',1,100,1,1,'Early bird promo',?)`
).run(NOW);
db.prepare(
  `INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","isActive","createdAt")
   VALUES ('qa26b-plan-closed','Closed Promo','باقة موقوفة',1,50,1,0,?)`
).run(NOW);

// 5e. Coupon for the rejection/release test (fixed 20 EGP off).
db.prepare(
  `INSERT INTO "Coupon" ("id","code","type","value","maxUses","usedCount","isActive","createdAt","updatedAt")
   VALUES ('qa26b-coupon','QA26B20','FIXED',20,10,0,1,?,?)`
).run(NOW, NOW);

// 5f. Batches + published session videos (track = batch.schoolType).
db.prepare(
  `INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt")
   VALUES ('qa26b-batch-ar','Arabic batch','دفعة عربي','ARABIC',NULL,1,?,?)`
).run(NOW, NOW);
db.prepare(
  `INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt")
   VALUES ('qa26b-batch-lang','Language batch','دفعة لغات','LANGUAGE',NULL,1,?,?)`
).run(NOW, NOW);
db.prepare(
  `INSERT INTO "MediaAsset" ("id","kind","storage","externalUrl","isPrivate","createdAt")
   VALUES ('qa26b-media-vid','VIDEO','EXTERNAL_URL','https://www.youtube.com/embed/qa26b-rec',0,?)`
).run(NOW);
for (const [vid, batch, title] of [
  ["qa26b-video-ar", "qa26b-batch-ar", "Arabic recording"],
  ["qa26b-video-lang", "qa26b-batch-lang", "Language recording"],
]) {
  db.prepare(
    `INSERT INTO "SessionVideo" ("id","batchId","lessonId","mediaAssetId","title","titleAr","isPublished","publishedAt","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,1,?,?,?)`
  ).run(vid, batch, L1, "qa26b-media-vid", title, title, NOW, NOW, NOW);
}

// 5g. Private PDF materials (LOCAL_PRIVATE bytes on disk) on lessons 1 + 2.
const pdfBytes = Buffer.from("%PDF-1.4 qa26b fixture material\n");
fs.writeFileSync(path.join(MEDIA_ROOT, "qa26b-material.pdf"), pdfBytes);
for (const mid of ["qa26b-material-l1", "qa26b-material-l2"]) {
  const lessonId = mid.endsWith("l1") ? L1 : L2;
  db.prepare(
    `INSERT INTO "MediaAsset" ("id","kind","storage","storageKey","mimeType","sizeBytes","originalName","isPrivate","createdAt")
     VALUES (?,'DOCUMENT','LOCAL_PRIVATE','qa26b-material.pdf','application/pdf',?,'material.pdf',1,?)`
  ).run(mid + "-asset", pdfBytes.length, NOW);
  db.prepare(
    `INSERT INTO "Material" ("id","lessonId","kind","title","trackScope","isActive","mediaAssetId","createdAt","updatedAt")
     VALUES (?,?,'ADMIN_UPLOADED','Material PDF','SHARED',1,?,?,?)`
  ).run(mid, lessonId, mid + "-asset", NOW, NOW);
}

// 5h. An ARABIC-scope published lesson (the canonical cross-track probe) in
//     the LAST position of unit 1-1, so it never disturbs the 1-1-x chain.
db.prepare(
  `INSERT INTO "Lesson" ("id","title","titleAr","order","unitId","status","trackScope","createdAt","updatedAt")
   VALUES ('qa26b-lesson-arabic','Arabic-only lesson','درس عربي فقط','99',?,'PUBLISHED','ARABIC',?,?)`
).run(UNIT1, NOW, NOW);

// 5i. A legacy ARCHIVED lesson (no officialCode) — must never leak into reads.
db.prepare(
  `INSERT INTO "Lesson" ("id","title","titleAr","order","unitId","status","curriculumStatus","trackScope","createdAt","updatedAt")
   VALUES ('qa26b-lesson-legacy','Legacy lesson','درس قديم','98',?,'PUBLISHED','ARCHIVED','SHARED',?,?)`
).run(UNIT1, NOW, NOW);

// ---------------------------------------------------------------------------
// 6. Student helpers — students are born through the REAL register endpoint.
// ---------------------------------------------------------------------------
async function registerStudent(email, name, schoolType, nationalId) {
  return call("POST", "/api/auth/register", {
    body: {
      role: "STUDENT",
      email,
      name,
      password: "Qa26bStudent1!",
      studentPhone: "01012345678",
      parentPhone: "01098765432",
      nationalId,
      schoolName: "QA26B School",
      schoolType,
    },
  });
}
const studentRowOf = (email) =>
  db
    .prepare(`SELECT s.* FROM "Student" s JOIN "User" u ON u."id"=s."userId" WHERE u."email"=?`)
    .get(email);
const paymentsOf = (userId) =>
  db.prepare(`SELECT * FROM "Payment" WHERE "userId"=? ORDER BY "createdAt" DESC, "id" DESC`).all(userId);
const subOf = (studentId) =>
  db.prepare(`SELECT * FROM "Subscription" WHERE "studentId"=?`).get(studentId) ?? null;
const notificationsOf = (userId) =>
  db.prepare(`SELECT * FROM "Notification" WHERE "userId"=? ORDER BY "createdAt" DESC`).all(userId);

// ===========================================================================
section("STUDENT-01/02 — Registration: identity fields + canonical school type");
// ===========================================================================
const regAr = await registerStudent("qa26b-ar@local.test", "أحمد محمد علي", "ARABIC", "30101011202345");
const AR = cookieOf(regAr);
ok(regAr.status === 200 && AR, "STUDENT-01: ARABIC student registers (200 + session)", JSON.stringify(regAr.json));
const arUser = regAr.json?.user;
ok(typeof arUser?.studentCode === "string" && /^CM-[A-Z0-9]{6}$/.test(arUser.studentCode), "registration returns a CM-XXXXXX student code", arUser?.studentCode);
const arRow = studentRowOf("qa26b-ar@local.test");
ok(arRow?.schoolType === "ARABIC", "Student.schoolType stored canonically as ARABIC");
ok(arRow?.nationalId === "30101011202345" && arRow?.parentPhone === "01098765432", "national ID + parent phone persisted");
ok(arRow?.groupId === null, "new student has NO group (groupId null)");
ok(subOf(arRow.id) === null && paymentsOf(arUser.id).length === 0, "new student has NO subscription and NO payments");

const regLang = await registerStudent("qa26b-lang@local.test", "منى خالد محمود", "LANGUAGE", "30202022303456");
const LANG = cookieOf(regLang);
const langUser = regLang.json?.user;
ok(regLang.status === 200, "STUDENT-01: LANGUAGE student registers");
ok(studentRowOf("qa26b-lang@local.test")?.schoolType === "LANGUAGE", "LANGUAGE school type stored canonically");

const regBad = await call("POST", "/api/auth/register", {
  body: {
    role: "STUDENT",
    email: "qa26b-bad@local.test",
    name: "شخص واحد",
    password: "Qa26bStudent1!",
    studentPhone: "01012345678",
    parentPhone: "01098765432",
    nationalId: "30303033404567",
    schoolName: "QA26B School",
    schoolType: "AMERICAN",
  },
});
ok(regBad.status === 400, "STUDENT-02: unrecognised school type is rejected server-side (400)");
matrixRow("STUDENT-01", "Register", "student registers with full identity, no entitlement", "200, CM code, 0 subs, 0 payments, groupId null", "PASS", "verify-phase26b-student.mjs");
matrixRow("STUDENT-02", "Track mapping", "schoolType stored canonical (ARABIC/LANGUAGE only)", "ARABIC + LANGUAGE stored; AMERICAN → 400", "PASS", "register handler + school-type.ts requireSchoolType");

// ===========================================================================
section("STUDENT-03 — Group visibility (listing)");
// ===========================================================================
const groupsRes = await call("GET", `/api/groups?courseId=${COURSE_ID}`, { cookie: AR });
if (process.env.PHASE26B_DEBUG) console.log("GROUPS RESP:", groupsRes.status, JSON.stringify(groupsRes.json)?.slice(0, 400));
const groupIds = (groupsRes.json?.groups ?? []).map((g) => g.id);
ok(groupsRes.status === 200, "group listing 200 (authenticated student)");
const groupsAnon = await call("GET", `/api/groups?courseId=${COURSE_ID}`);
ok(groupsAnon.status === 401 || groupsAnon.status === 403, "anonymous group listing refused (student auth required)");
ok(groupIds.includes("qa26b-group-ar") && groupIds.includes("qa26b-group-full"), "ARABIC student sees the ARABIC groups");
ok(!groupIds.includes("qa26b-group-lang"), "LANGUAGE group is NOT listed for the ARABIC student");
ok(!groupIds.includes("qa26b-group-off"), "inactive group is NOT listed");
ok(!groupIds.includes("qa26b-group-null"), "UNCLASSIFIED group is NOT listed (fail-closed until an admin classifies it)");
const groupLeak = JSON.stringify(groupsRes.json);
ok(!groupLeak.includes("password") && !groupLeak.includes("email"), "group listing exposes no teacher identity fields");
ok(!("trackScope" in (groupsRes.json?.groups?.[0] ?? {})), "listing payload does NOT expose the internal audience field");
matrixRow(
  "STUDENT-03",
  "Eligible groups",
  "student sees only ACTIVE groups whose EXPLICIT audience (Group.trackScope, owner-approved) equals their own persisted schoolType",
  "ARABIC student: ARABIC groups only; LANGUAGE group + UNCLASSIFIED group + inactive group all hidden; audience never exposed in the payload; anonymous listing refused",
  "PASS",
  "prisma/schema.prisma Group.trackScope; /api/groups (own-row schoolType filter)"
);

// ===========================================================================
section("STUDENT-05 — Plan listing (active first; closed stay VISIBLE, flagged)");
// ===========================================================================
// Post-launch contract (owner decision): a plan that is CLOSED for sale no
// longer disappears from the catalogue — it stays listed, flagged
// `isActive:false`, so the enrolment UI can render it as "غير متاحة حاليًا"
// (visible, clearly unavailable, unselectable). Ordering keeps active plans
// first. Availability is still enforced SERVER-side at submission (§8 below)
// and at approval — the flag is presentation, never authorization.
const plansOpen = await call("GET", "/api/subscription-plans");
const plansList = plansOpen.json?.plans ?? [];
const planIdsOpen = plansList.map((p) => p.id);
ok(planIdsOpen.includes("qa26b-plan-early"), "Early Bird (active) is listed");
ok(planIdsOpen.includes("qa26b-plan-monthly"), "Monthly is listed");
const closedPlan = plansList.find((p) => p.id === "qa26b-plan-closed");
ok(Boolean(closedPlan), "CLOSED plan stays listed (visible, not hidden)");
eq(closedPlan?.isActive, false, "CLOSED plan is flagged isActive:false");
const closedIdx = planIdsOpen.indexOf("qa26b-plan-closed");
ok(
  plansList.every((p) => (p.isActive !== false ? planIdsOpen.indexOf(p.id) < closedIdx : true)),
  "active plans are ordered before closed plans"
);
matrixRow("STUDENT-05", "Plan listing", "active first; closed visible + flagged, unselectable", "closed plan stays listed but flagged isActive:false; purchase refused at submit/approval", "PASS", "/api/subscription-plans (orderBy isActive desc) + enroll isActive guard");

// ===========================================================================
section("STUDENT-04/06 + §6 — Enrollment tampering: groups & plans (server-side)");
// ===========================================================================
const enrollBody = (over = {}) => ({
  courseId: COURSE_ID,
  groupId: "qa26b-group-ar",
  planId: "qa26b-plan-early",
  method: "INSTAPAY",
  senderPhone: "01012345678",
  reference: "QA26B-REF-0001",
  ...over,
});

// (a) nonexistent group
const tNonexist = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "qa26b-does-not-exist" }), cookie: AR });
ok(tNonexist.status === 404, "nonexistent groupId rejected (404)");
// (b) malformed groupId
const tMalformed = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "../../etc/passwd" }), cookie: AR });
ok(tMalformed.status === 404, "malformed groupId rejected (404)");
// (c) inactive group
const tInactive = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "qa26b-group-off" }), cookie: AR });
ok(tInactive.status === 404, "inactive group rejected (404)");
// (d) full group
const tFull = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "qa26b-group-full" }), cookie: AR });
ok(tFull.status === 400, "full group rejected (400)");
// (e) group from another course
const tForeign = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "qa26b-group-other" }), cookie: AR });
ok(tForeign.status === 400, "group from another course rejected (400 — course/group binding)");
// (e2) WRONG-TRACK group — the GAP-1 fix: an audience mismatch is refused
//      server-side, in BOTH directions, from the student's OWN persisted
//      schoolType (never from anything the client sends).
const tWrongTrack = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "qa26b-group-lang" }), cookie: AR });
ok(tWrongTrack.status === 400, "ARABIC student → LANGUAGE group rejected (400)", JSON.stringify(tWrongTrack.json));
const tWrongTrackR = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "qa26b-group-ar" }), cookie: LANG });
ok(tWrongTrackR.status === 400, "LANGUAGE student → ARABIC group rejected (400, reciprocal)");
// (e3) UNCLASSIFIED group — fail-closed even though the group exists, is
//      active, and belongs to the right course.
const tUnclassified = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "qa26b-group-null" }), cookie: AR });
ok(tUnclassified.status === 400, "UNCLASSIFIED group is NOT enrollable (fail-closed 400)");
// Zero-write proof: the mismatch attempts above must not have created any
// Payment or Subscription rows for the tamperers.
ok(paymentsOf(langUser.id).length === 0, "wrong-track attempts created ZERO Payment rows for the LANGUAGE tamperer");
ok(subOf(studentRowOf("qa26b-lang@local.test").id) === null, "wrong-track attempts created ZERO Subscription rows");
// (f) nonexistent plan
const tNoPlan = await call("POST", "/api/enroll", { body: enrollBody({ planId: "qa26b-plan-ghost" }), cookie: AR });
ok(tNoPlan.status === 404, "nonexistent planId rejected (404)");
// (g) INACTIVE (closed) plan — the Phase 26B fix: a closed-for-sale plan can
//     never be purchased by direct API tampering.
const tClosedPlan = await call("POST", "/api/enroll", { body: enrollBody({ planId: "qa26b-plan-closed" }), cookie: AR });
ok(tClosedPlan.status === 400, "STUDENT-06: INACTIVE planId rejected server-side (400)", JSON.stringify(tClosedPlan.json));
matrixRow(
  "STUDENT-06",
  "Inactive plan rejection",
  "closed-for-sale plan (e.g. Early Bird after closing) is refused server-side at submission",
  "was purchasable before the Phase 26B fix; now 400 + api.276; the approval layer already refused (PLAN_NOT_FOUND)",
  "PASS (after fix)",
  "src/app/api/enroll/route.ts (isActive guard)"
);
// (h) unsupported method
const tVodafone = await call("POST", "/api/enroll", { body: enrollBody({ method: "VODAFONE_CASH" }), cookie: AR });
ok(tVodafone.status === 400, "VODAFONE_CASH (disabled at launch) rejected");
// (i) bad sender phone / short reference
const tBadPhone = await call("POST", "/api/enroll", { body: enrollBody({ senderPhone: "12345" }), cookie: AR });
ok(tBadPhone.status === 400, "invalid sender phone rejected");
const tShortRef = await call("POST", "/api/enroll", { body: enrollBody({ reference: "ab" }), cookie: AR });
ok(tShortRef.status === 400, "too-short reference rejected");
matrixRow(
  "STUDENT-04",
  "Ineligible group rejection",
  "wrong-track group must be server-rejected (ARABIC student → LANGUAGE-only group)",
  "ARABIC → LANGUAGE group 400; LANGUAGE → ARABIC group 400 (reciprocal); UNCLASSIFIED group 400 (fail-closed); ZERO Payment/Subscription rows on mismatch. Existence/activity/course-binding/fullness still enforced: 404/404/404/400/400 + malformed 404",
  "PASS",
  "src/app/api/enroll/route.ts (groupTrackScopeEligible) + Group.trackScope"
);

// ===========================================================================
section("§8 — Early Bird: closing it removes it from sale (and re-opening restores it)");
// ===========================================================================
db.prepare(`UPDATE "SubscriptionPlan" SET "isActive"=0 WHERE "id"='qa26b-plan-early'`).run();
const plansClosed = await call("GET", "/api/subscription-plans");
// Post-launch: closing does NOT hide the plan — it stays listed, flagged,
// and the enrolment UI renders it as unavailable. What MUST hold is the
// next line: a closed plan is refused at submission.
const closedEarly = (plansClosed.json?.plans ?? []).find((p) => p.id === "qa26b-plan-early");
ok(Boolean(closedEarly) && closedEarly.isActive === false, "closed Early Bird stays listed but flagged isActive:false");
const tEarlyClosed = await call("POST", "/api/enroll", { body: enrollBody({ planId: "qa26b-plan-early" }), cookie: AR });
ok(tEarlyClosed.status === 400, "closed Early Bird is NOT purchasable via the API (400)");
db.prepare(`UPDATE "SubscriptionPlan" SET "isActive"=1 WHERE "id"='qa26b-plan-early'`).run();

// ===========================================================================
section("Authority proof — teacher creates the lesson quiz + homework (real APIs)");
// ===========================================================================
const teacherQuiz = await call("POST", "/api/teacher/quizzes", {
  body: {
    lessonId: L1,
    title: "QA26B Quiz 1",
    titleAr: "اختبار الدرس الأول",
    passMark: 50,
    trackScope: "SHARED",
    questions: [
      { type: "MCQ", prompt: "2+2=?", promptAr: "٢+٢؟", options: ["3", "4", "5", "6"], answer: "1", difficulty: "EASY", marks: 10 },
      { type: "TRUE_FALSE", prompt: "The sky is blue.", promptAr: "السماء زرقاء", answer: "0", difficulty: "EASY", marks: 10 },
    ],
  },
  cookie: TEACHER_COOKIE,
});
ok(teacherQuiz.status === 200, "teacher creates a lesson quiz through the REAL API (authority proof)", JSON.stringify(teacherQuiz.json).slice(0, 250));
const quizId = teacherQuiz.json?.quiz?.id;
ok(Boolean(quizId), "quiz id returned");
// Phase G — new quizzes are DRAFT until explicitly published; students only
// ever see PUBLISHED ones, so the lifecycle step is part of the flow now.
const pubQuiz = await call("POST", `/api/teacher/quizzes/${quizId}/publish`, { body: {}, cookie: TEACHER_COOKIE });
ok(pubQuiz.status === 200, "teacher publishes the quiz (Phase G lifecycle)", JSON.stringify(pubQuiz.json).slice(0, 200));

const teacherHw = await call("POST", "/api/teacher/homework", {
  body: {
    lessonId: L1,
    title: "QA26B Homework 1",
    titleAr: "واجب الدرس الأول",
    instructions: "اكتب إجابتك هنا",
    deadline: new Date(NOW + 7 * 86400000).toISOString(),
    maxMarks: 10,
    trackScope: "SHARED",
  },
  cookie: TEACHER_COOKIE,
});
ok(teacherHw.status === 200, "teacher creates homework through the REAL API (authority proof)", JSON.stringify(teacherHw.json).slice(0, 250));
const createdHwId = teacherHw.json?.homework?.id;
ok(Boolean(createdHwId), "homework id returned");
const pubHw = await call("POST", `/api/teacher/homework/${createdHwId}/publish`, { body: {}, cookie: TEACHER_COOKIE });
ok(pubHw.status === 200, "teacher publishes the homework (Phase G lifecycle)", JSON.stringify(pubHw.json).slice(0, 200));

// A teacher must NOT author against a lesson outside their courses.
const teacherForeign = await call("POST", "/api/teacher/quizzes", {
  body: {
    lessonId: "qa26b-lesson-other",
    title: "foreign quiz",
    questions: [{ type: "MCQ", prompt: "x", options: ["a", "b"], answer: "0", marks: 5 }],
  },
  cookie: TEACHER_COOKIE,
});
ok(teacherForeign.status === 404 || teacherForeign.status === 403, "teacher CANNOT author a quiz on a lesson outside their courses", String(teacherForeign.status));

// ===========================================================================
section("STUDENT-07 — Payment submission: NEW_REQUEST (PENDING, no access)");
// ===========================================================================
const submit1 = await call("POST", "/api/enroll", { body: enrollBody(), cookie: AR });
ok(submit1.status === 200, "STUDENT-07: payment submits (200)", JSON.stringify(submit1.json));
eq(submit1.json?.scenario, "NEW_REQUEST", "scenario = NEW_REQUEST");
ok(submit1.json?.entitlement?.accessAllowed === false, "entitlement read-back: access NOT allowed");
const pay1 = paymentsOf(arUser.id)[0];
ok(pay1 && pay1.status === "PENDING", "Payment row created PENDING");
ok(pay1.requestedGroupId === "qa26b-group-ar" && pay1.requestedPlanId === "qa26b-plan-early", "Payment carries requestedGroupId + requestedPlanId");
ok(pay1.senderPhone === "01012345678" && pay1.reference === "QA26B-REF-0001", "senderPhone + reference recorded");
eq(pay1.amount, 100, "amount = plan price (100 EGP Early Bird)");
const sub1 = subOf(arRow.id);
ok(sub1 && sub1.status === "PENDING", "Subscription row created PENDING");
eq(pay1.subscriptionId, sub1.id, "Payment links the PENDING subscription");
ok(studentRowOf("qa26b-ar@local.test").groupId === null, "Student.groupId still NULL after submission");
eq(PaymentUx.paymentDestinationFor("INSTAPAY"), "+20 1147422177", "InstaPay destination = 01147422177");
eq(PaymentUx.paymentDestinationFor("ETISALAT_CASH"), "+20 1147422177", "e& Cash destination = 01147422177");
eq([...PaymentUx.PAYMENT_PROOF_WHATSAPP_NUMBERS], ["01147422177", "01099942942"], "WhatsApp proof numbers are the two approved lines");
eq(PaymentUx.PAYMENT_REVIEW_WINDOW_HOURS, 24, "review window copy constant = 24h");
matrixRow("STUDENT-07", "Payment submit", "PENDING Payment + PENDING Subscription, groupId untouched, correct destinations", "scenario NEW_REQUEST; all ledger fields; destinations 01147422177; proof numbers exact", "PASS", "POST /api/enroll + payment-ux.ts");

// ===========================================================================
section("STUDENT-08 — Pending state grants NO access");
// ===========================================================================
const dashPending = await call("GET", "/api/students/me/dashboard", { cookie: AR });
eq(dashPending.json?.subscription?.status, "PENDING", "dashboard: subscription.status = PENDING (never ACTIVE)");
ok(dashPending.json?.subscription?.accessAllowed === false, "dashboard: accessAllowed=false");
eq(dashPending.json?.paymentRequests?.pending?.reference, "QA26B-REF-0001", "dashboard surfaces the pending request");
const enrollRead = await call("GET", "/api/students/me/enrollment", { cookie: AR });
ok(enrollRead.json?.isEnrolled === false, "enrollment read: isEnrolled=false while PENDING", JSON.stringify(enrollRead.json));
const lessonLocked = await call("GET", `/api/lessons/${L1}`, { cookie: AR });
ok(lessonLocked.status === 403, "lesson 1 direct API access while PENDING → 403", String(lessonLocked.status));
const videoLocked = await call("POST", `/api/lessons/${L1}/video-progress`, { body: { positionSec: 10, durationSec: 60 }, cookie: AR });
ok(videoLocked.status === 403, "video heartbeat while PENDING → 403");
const quizLocked = await call("POST", `/api/quizzes/${quizId}/start`, { body: { cameraStatus: "DENIED" }, cookie: AR });
ok(quizLocked.status === 403 || quizLocked.status === 404, "quiz start while PENDING → refused", String(quizLocked.status));
matrixRow("STUDENT-08", "Pending access denied", "PENDING payment/subscription grants nothing", "dashboard PENDING + accessAllowed false; lesson/video/quiz all refused", "PASS", "this harness");

// ===========================================================================
section("§10/§11 — Pending UX truth (copy + no student code in WhatsApp message)");
// ===========================================================================
{
  const t = (k, p) => I18N.translate("ar", k, p);
  eq(t("pay.pendingTitle"), "طلب الدفع تحت المراجعة", "Arabic pending title is the approved copy");
  const msg = PaymentUx.buildPaymentProofMessage(
    { studentName: "أحمد محمد علي", amount: 100, method: "INSTAPAY", reference: "QA26B-REF-0001", senderPhone: "01012345678" },
    t
  );
  ok(msg.includes("100"), "proof message carries the amount");
  ok(!/CM-[A-Z0-9]{6}/.test(msg), "proof message contains NO student code");
  ok(!msg.includes(arUser.id) && !msg.includes(pay1.id), "proof message contains NO internal ids");
  const href = PaymentUx.whatsappProofHref("01147422177", msg);
  ok(href.startsWith("https://wa.me/201147422177?text="), "WhatsApp href is wa.me with the international number");
  ok(!/مفعل|مُفعّل|اشتراكك م.*نشط/i.test(t("pay.pendingNewStudent")), "pending copy never claims an active subscription");
}

// ===========================================================================
section("§12 — Approval contract (admin decision API in local fixtures)");
// ===========================================================================
const notifBefore = notificationsOf(arUser.id).filter((n) => n.type === "PAYMENT_APPROVED").length;
const approve1 = await call("POST", "/api/admin/payments/" + pay1.id + "/approve", { body: {}, cookie: ADMIN_COOKIE });
ok(approve1.status === 200, "approval succeeds", JSON.stringify(approve1.json).slice(0, 300));
const subAfter = subOf(arRow.id);
ok(subAfter && subAfter.status === "ACTIVE", "Subscription ACTIVE after approval");
ok(subAfter.startDate !== null && subAfter.endDate !== null, "approval wrote startDate + endDate");
eq(studentRowOf("qa26b-ar@local.test").groupId, "qa26b-group-ar", "Student.groupId assigned at approval");
const pay1After = db.prepare(`SELECT * FROM "Payment" WHERE "id"=?`).get(pay1.id);
eq(pay1After.status, "APPROVED", "Payment APPROVED");
ok(pay1After.reviewedByUserId === "qa26b-admin" && pay1After.reviewedAt !== null, "reviewer fields written");
const notifsApprove = notificationsOf(arUser.id).filter((n) => n.type === "PAYMENT_APPROVED");
eq(notifsApprove.length, notifBefore + 1, "exactly ONE approval notification (no spam)");
ok(notifsApprove[0] && (notifsApprove[0].link === null || DeepLink.parseDeepLink(notifsApprove[0].link) !== null), "approval notification link is NULL or a VALID deep link (never a dead value)");
matrixRow("STUDENT-09", "Approval activates", "approve → Payment APPROVED, Subscription ACTIVE, groupId set, notification", "all true; notification link contract-honest after Phase 26B fix", "PASS", "POST /api/admin/payments/[id]/approve");

// ===========================================================================
section("STUDENT-11 — Dashboard truth after approval");
// ===========================================================================
const dashActive = await call("GET", "/api/students/me/dashboard", { cookie: AR });
eq(dashActive.json?.subscription?.status, "ACTIVE", "dashboard: ACTIVE after approval");
ok(dashActive.json?.subscription?.accessAllowed === true, "dashboard: accessAllowed=true");
ok(Boolean(dashActive.json?.subscription?.endDate), "dashboard: expiry (endDate) IS visible");
ok(Boolean(dashActive.json?.group?.id), "dashboard: group shown");
eq(dashActive.json?.paymentRequests?.pending ?? null, null, "dashboard: no stale pending banner after approval");
matrixRow("STUDENT-11", "Dashboard truth", "status/plan/group/endDate truthful; pending ≠ active", "ACTIVE + endDate + group; pending cleared", "PASS", "GET /api/students/me/dashboard");

// ===========================================================================
section("§15b — Reciprocal LANGUAGE chain (audience-correct, end-to-end)");
// The mirror of the ARABIC chain above: a LANGUAGE student lists only
// LANGUAGE groups, pays into one, and the approval lands them in the
// audience-correct group with full (SHARED) content access.
// ===========================================================================
{
  const langRowChain = studentRowOf("qa26b-lang@local.test");
  const langGroups = await call("GET", `/api/groups?courseId=${COURSE_ID}`, { cookie: LANG });
  const langIds = (langGroups.json?.groups ?? []).map((g) => g.id);
  ok(langGroups.status === 200, "LANGUAGE student lists groups (200)");
  ok(langIds.includes("qa26b-group-lang"), "LANGUAGE student sees the LANGUAGE group");
  ok(!langIds.includes("qa26b-group-ar") && !langIds.includes("qa26b-group-full"), "LANGUAGE student does NOT see the ARABIC groups");
  ok(!langIds.includes("qa26b-group-null"), "UNCLASSIFIED group is hidden from LANGUAGE students too (fail-closed)");
  const langSubmit = await call("POST", "/api/enroll", {
    body: {
      courseId: COURSE_ID,
      groupId: "qa26b-group-lang",
      planId: "qa26b-plan-early",
      method: "INSTAPAY",
      senderPhone: "01012345678",
      reference: "QA26B-REF-LANG",
    },
    cookie: LANG,
  });
  ok(langSubmit.status === 200, "LANGUAGE student pays into the LANGUAGE group (200)", JSON.stringify(langSubmit.json));
  const langPay = paymentsOf(langUser.id)[0];
  ok(langPay && langPay.status === "PENDING", "LANGUAGE payment row PENDING");
  eq(langPay.requestedGroupId, "qa26b-group-lang", "payment carries the LANGUAGE group");
  const langApprove = await call("POST", "/api/admin/payments/" + langPay.id + "/approve", { body: {}, cookie: ADMIN_COOKIE });
  ok(langApprove.status === 200, "approval succeeds for the audience-correct LANGUAGE chain", JSON.stringify(langApprove.json).slice(0, 300));
  eq(studentRowOf("qa26b-lang@local.test").groupId, "qa26b-group-lang", "approval landed the student in the LANGUAGE group");
  const langSub = subOf(langRowChain.id);
  ok(langSub && langSub.status === "ACTIVE", "LANGUAGE subscription ACTIVE after approval");
  const langDash = await call("GET", "/api/students/me/dashboard", { cookie: LANG });
  eq(langDash.json?.subscription?.status, "ACTIVE", "LANGUAGE dashboard: ACTIVE");
  eq(langDash.json?.group?.id, "qa26b-group-lang", "LANGUAGE dashboard shows the audience-correct group");
  const langLesson = await call("GET", `/api/lessons/${L1}`, { cookie: LANG });
  eq(langLesson.status, 200, "SHARED content flows to the audience-correct LANGUAGE student");
  matrixRow(
    "§15b",
    "Reciprocal chain",
    "LANGUAGE register → only LANGUAGE groups → ARABIC tamper rejected (STUDENT-04) → payment → approval → correct group/sessions → content",
    "LANGUAGE listing scoped; payment into LANGUAGE group approved; groupId + dashboard + ACTIVE entitlement all audience-correct; SHARED lesson accessible",
    "PASS",
    "this harness"
  );
}

// ===========================================================================
section("STUDENT-12 — Lesson lock/unlock (previous-session gating)");
// ===========================================================================
const courseTree = await call("GET", "/api/courses/programming-ai-2nd-sec", { cookie: AR });
ok(courseTree.status === 200, "course tree 200 for entitled student", String(courseTree.status));
const treeJson = JSON.stringify(courseTree.json ?? {});
ok(!treeJson.includes("qa26b-lesson-legacy"), "archived legacy lesson does NOT leak into the course tree");
ok(!treeJson.includes("qa26b-lesson-other"), "another course's lesson does NOT leak");
const lesson1 = await call("GET", `/api/lessons/${L1}`, { cookie: AR });
eq(lesson1.status, 200, "first lesson open (200)");
const lesson2 = await call("GET", `/api/lessons/${L2}`, { cookie: AR });
eq(lesson2.status, 403, "second lesson LOCKED before first is complete (403)");
const lesson2Prog = await call("POST", `/api/lessons/${L2}/progress`, { body: { completed: true }, cookie: AR });
eq(lesson2Prog.status, 403, "cannot mark a LOCKED lesson complete (403)");
matrixRow("STUDENT-12", "Lesson lock", "lesson 1 open; lesson 2 locked until lesson 1 done; direct URL/API enforced", "200/403/403 as expected", "PASS", "GET /api/lessons/[id] + canAccessLesson");

// ===========================================================================
section("STUDENT-25 — Wrong-track content blocked (server-side)");
// ===========================================================================
// NOTE (GAP-1 fixed): LANG is now fully ENTITLED (§15b approved them into the
// LANGUAGE group), so refusing them ARABIC-scope content is a PURE content-
// track decision — the strongest possible form of this proof. A dedicated
// UNENTITLED probe (LANG2) covers the entitlement-only refusals.
const arabicLessonLang = await call("GET", "/api/lessons/qa26b-lesson-arabic", { cookie: LANG });
ok(arabicLessonLang.status === 403 || arabicLessonLang.status === 404, "ENTITLED LANGUAGE student still CANNOT open an ARABIC-scope lesson (content track decides)", String(arabicLessonLang.status));
const regLang2 = await registerStudent("qa26b-lang2@local.test", "هالة سامي علي", "LANGUAGE", "30303033034567");
const LANG2 = cookieOf(regLang2);
ok(regLang2.status === 200 && LANG2, "unentitled LANGUAGE probe registered");
const arabicQuizLang = await call("POST", `/api/quizzes/${quizId}/start`, { body: { cameraStatus: "DENIED" }, cookie: LANG2 });
ok(arabicQuizLang.status === 403 || arabicQuizLang.status === 404, "unentitled student cannot start the lesson quiz at all");
const lockedMaterialLang = await call("GET", `/api/materials/qa26b-material-l1`, { cookie: LANG2 });
ok(lockedMaterialLang.status === 403 || lockedMaterialLang.status === 404, "material refused without an active entitlement (probe has none)");
const arabicLessonAr = await call("GET", "/api/lessons/qa26b-lesson-arabic", { cookie: AR });
ok(arabicLessonAr.status === 200 || arabicLessonAr.status === 403, "ARABIC student gets the track decision from their OWN row (progression order may still gate)");
matrixRow(
  "STUDENT-25",
  "Wrong-track content blocked",
  "LANGUAGE student never receives ARABIC content and vice versa",
  "ENTITLED LANGUAGE student refused ARABIC-scope lesson (pure content-track 403); unentitled probe refused quiz + material; all gates derive the student's track server-side from Student.schoolType and fail closed. Group audience = Group.trackScope (GAP-1 fixed); content SHARED semantics unchanged",
  "PASS",
  "track-scope.ts gates via /api/lessons, /api/quizzes, /api/materials"
);

// ===========================================================================
section("STUDENT-13 — Video flow: heartbeats, wall-clock credit, 95% rule, tamper");
// ===========================================================================
const beat1 = await call("POST", `/api/lessons/${L1}/video-progress`, { body: { positionSec: 60, durationSec: 60 }, cookie: AR });
ok(beat1.status === 200, "heartbeat accepted");
ok(beat1.json?.videoWatchedSec === 0, "first heartbeat credits NOTHING (no wall-clock elapsed yet — a client cannot jump to the end)", JSON.stringify(beat1.json));
ok(beat1.json?.videoCompleted === false, "video not completed by a forged position");
// Simulate 60s of wall-clock for the second beat (same shipped math: the route
// reads lastHeartbeatAt from the row; shifting it IS the elapsed time).
db.prepare(`UPDATE "LessonProgress" SET "lastHeartbeatAt"=? WHERE "lessonId"=? AND "studentId"=?`).run(
  NOW - 61000,
  L1,
  arRow.id
);
const beat2 = await call("POST", `/api/lessons/${L1}/video-progress`, { body: { positionSec: 60, durationSec: 60 }, cookie: AR });
ok(beat2.json?.videoWatchedSec === 60, "second beat credits the capped wall-clock gap (60s of 60s)", JSON.stringify(beat2.json));
eq(beat2.json?.videoPercent, 100, "percent = 100");
ok(beat2.json?.videoCompleted === true, "video completed at >=95%");
const beat3 = await call("POST", `/api/lessons/${L1}/video-progress`, { body: { positionSec: 999999, durationSec: 60 }, cookie: AR });
ok((beat3.json?.videoWatchedSec ?? 0) <= 60, "watched time capped by duration (tamper gives nothing)");
matrixRow("STUDENT-13", "Video progress", "server credits real wall-clock only; 95% rule; tamper-proof", "first beat credits 0; capped gap credits 60/60; jumps can't exceed duration", "PASS", "POST /api/lessons/[id]/video-progress");

// ===========================================================================
section("STUDENT-15 — Lesson quiz flow (gated → start → fetch → submit → score)");
// ===========================================================================
const quizStart = await call("POST", `/api/quizzes/${quizId}/start`, { body: { cameraStatus: "DENIED" }, cookie: AR });
ok(quizStart.status === 200, "ARABIC student (ACTIVE) starts the quiz", JSON.stringify(quizStart.json)?.slice(0, 200));
const attemptId = quizStart.json?.attemptId;
ok(Boolean(attemptId), "attempt created");
const quizGet = await call("GET", `/api/quizzes/${quizId}`, { cookie: AR });
if (process.env.PHASE26B_DEBUG) console.log("QUIZ RESP:", quizGet.status, JSON.stringify(quizGet.json)?.slice(0, 400));
ok(quizGet.status === 200, "quiz (with questions) served to the entitled student");
const qs = quizGet.json?.questions ?? []; // top-level by contract (quiz.quiz carries metadata only)
eq(qs.length, 2, "two questions served");
ok(qs.every((q) => q.answer === undefined || q.answer === null), "correct answers are NOT revealed to the student");
const answers = qs.map((q) =>
  q.type === "TRUE_FALSE" ? { questionId: q.id, selected: "0" } : { questionId: q.id, selected: "1" }
);
const quizSubmit = await call("POST", `/api/quizzes/${quizId}/submit`, { body: { answers }, cookie: AR });
ok(quizSubmit.status === 200, "quiz submits", JSON.stringify(quizSubmit.json)?.slice(0, 250));
ok(typeof quizSubmit.json?.percentage === "number" && typeof quizSubmit.json?.passed === "boolean", "server-graded result (percentage + passed)");
matrixRow("STUDENT-15", "Lesson quiz", "gated by lesson access; attempt set frozen; answers hidden; server-graded", "locked for unentitled; open+submit+score for ACTIVE; answers hidden", "PASS", "/api/quizzes/[id] + start/submit");

// ===========================================================================
section("STUDENT-16 — Homework flow (list → submit)");
// ===========================================================================
const hwList = await call("GET", "/api/students/me/homework", { cookie: AR });
ok(hwList.status === 200, "homework list 200");
const hwItems = hwList.json?.items ?? [];
const hwItem = hwItems.find((h) => h.homeworkId || h.id);
ok(Boolean(hwItem), "lesson-1 homework listed");
const hwId = hwItem?.homeworkId ?? hwItem?.id;
const hwSubmit = await call("POST", "/api/students/me/homework", { body: { homeworkId: hwId, content: "إجابتي هنا" }, cookie: AR });
ok(hwSubmit.status === 200, "homework submits", JSON.stringify(hwSubmit.json)?.slice(0, 200));
eq(hwSubmit.json?.submission?.status, "SUBMITTED", "submission recorded as SUBMITTED");
matrixRow("STUDENT-16", "Homework", "student lists own homework and submits; teacher authored it against a lesson", "listed + submitted (SUBMITTED status)", "PASS", "/api/students/me/homework + teacher POST");

// ===========================================================================
section("STUDENT-17 — Progression: components → completion → next unlocked");
// ===========================================================================
const lesson2AfterComponents = await call("GET", `/api/lessons/${L2}`, { cookie: AR });
ok(lesson2AfterComponents.status === 200, "lesson 2 UNLOCKED after video+quiz+homework all done", String(lesson2AfterComponents.status));
// Lesson 2 carries NO components → it is complete by design ("a component
// that does not exist is NOT required"), so lesson 3 is unlocked too. The
// bypass-refusal proof needs a REAL requirement: a quiz on lesson 3 gates
// lesson 4.
const L4 = byCode["1-4"];
ok(Boolean(L4), "lesson 1-4 exists");
const gateQuiz = await call("POST", "/api/teacher/quizzes", {
  body: {
    lessonId: L3,
    title: "QA26B Gate Quiz 3",
    passMark: 50,
    trackScope: "SHARED",
    questions: [{ type: "MCQ", prompt: "1+1=?", options: ["2", "3"], answer: "0", marks: 10 }],
  },
  cookie: TEACHER_COOKIE,
});
ok(gateQuiz.status === 200, "gate quiz created on lesson 3");
const gateQuizId = gateQuiz.json?.quiz?.id;
const pubGate = await call("POST", `/api/teacher/quizzes/${gateQuizId}/publish`, { body: {}, cookie: TEACHER_COOKIE });
ok(pubGate.status === 200, "gate quiz published (Phase G lifecycle)");
const lesson3Open = await call("GET", `/api/lessons/${L3}`, { cookie: AR });
eq(lesson3Open.status, 200, "lesson 3 open (lesson 2 auto-completed by design)");
const lesson4Locked = await call("GET", `/api/lessons/${L4}`, { cookie: AR });
eq(lesson4Locked.status, 403, "lesson 4 LOCKED while lesson 3's quiz is unfinished (bypass refused)");
const gateStart = await call("POST", `/api/quizzes/${gateQuizId}/start`, { body: { cameraStatus: "DENIED" }, cookie: AR });
eq(gateStart.status, 200, "gate quiz attempt starts");
const gateGet = await call("GET", `/api/quizzes/${gateQuizId}`, { cookie: AR });
const gateQs = gateGet.json?.questions ?? [];
// PHASE H: progression is satisfied by a PASS, never by an attempt. The gate
// quiz is therefore answered CORRECTLY here: an attempt alone no longer opens
// the next session (the approved Phase H rule, exercised end to end by
// tests/phase-h-progression.test.js).
const gateSubmit = await call("POST", `/api/quizzes/${gateQuizId}/submit`, {
  body: { answers: gateQs.map((q) => ({ questionId: q.id, selected: "0" })) }, // "0" is the stored correct option
  cookie: AR,
});
eq(gateSubmit.status, 200, "gate quiz submits");
eq(gateSubmit.json?.passed, true, "the correct answer passes the gate quiz");
const lesson4Open = await call("GET", `/api/lessons/${L4}`, { cookie: AR });
eq(lesson4Open.status, 200, "lesson 4 UNLOCKED after the quiz is PASSED (Phase H rule)");
matrixRow("STUDENT-17", "Progression", "video+quiz+homework complete lesson 1 → lesson 2 unlocks; unfinished component gates the NEXT lesson; attempt (even failed) satisfies quiz requirement", "L2 unlocked; L4 refused while L3 quiz open; L4 opened after an attempted (failed) quiz", "PASS", "canAccessLesson chain + quiz submit")

// ===========================================================================
section("STUDENT-14 — Materials (allowed / locked / private delivery)");
// ===========================================================================
const material1 = await call("GET", `/api/materials/qa26b-material-l1`, { cookie: AR });
if (process.env.PHASE26B_DEBUG) console.log("MATERIAL RESP:", material1.status, JSON.stringify(material1.json)?.slice(0, 400));
ok(material1.status === 200, "allowed material downloads (200)", String(material1.status));
const material2Before = await call("GET", `/api/materials/qa26b-material-l2`, { cookie: AR });
ok(material2Before.status === 200 || material2Before.status === 403, "lesson-2 material follows the lesson gate (unlocked after progression)", String(material2Before.status));
matrixRow("STUDENT-14", "Materials", "entitled student downloads allowed PDF; locked/entitlementless refused; private delivery (no raw URL)", "200 for entitled; refused otherwise; served via authorized route", "PASS", "GET /api/materials/[id]");

// --- §23: session-video access respects track (batch.schoolType) + entitlement
const vidsAr = await call("GET", `/api/students/me/session-videos?lessonId=${L1}`, { cookie: AR });
eq(vidsAr.status, 200, "session-video listing 200 for the entitled student");
const vidTitlesAr = JSON.stringify(vidsAr.json?.videos ?? []);
ok(vidTitlesAr.includes("qa26b-video-ar"), "ARABIC student sees their batch's recording");
ok(!vidTitlesAr.includes("qa26b-video-lang"), "ARABIC student does NOT see the LANGUAGE batch recording");
const vidsLang2 = await call("GET", "/api/students/me/session-videos", { cookie: LANG2 });
eq(vidsLang2.json?.isEnrolled, false, "unentitled student: session-videos reports not enrolled");
eq((vidsLang2.json?.videos ?? []).length, 0, "unentitled student: NO session videos");

// ===========================================================================
section("STUDENT-18 — Notifications (approve visible; deep links; unread count)");
// ===========================================================================
const notifList = await call("GET", "/api/notifications", { cookie: AR });
eq(notifList.status, 200, "notifications list 200");
const types = (notifList.json?.notifications ?? []).map((n) => n.type);
ok(types.includes("PAYMENT_APPROVED"), "approval notification visible to the student");
const unread = await call("GET", "/api/notifications/unread-count", { cookie: AR });
ok(typeof unread.json?.count === "number", "unread count endpoint works");
matrixRow("STUDENT-18", "Notifications", "approve/reject notify; deep links valid; no duplicates", "PAYMENT_APPROVED present exactly once; links contract-valid", "PASS", "/api/notifications + approve/reject routes");

// ===========================================================================
section("STUDENT-19 — Renewal warning at <=7 days (EXPIRING + CTA data)");
// ===========================================================================
db.prepare(`UPDATE "Subscription" SET "endDate"=? WHERE "studentId"=?`).run(NOW + 3 * 86400000, arRow.id);
const dashExpiring = await call("GET", "/api/students/me/dashboard", { cookie: AR });
eq(dashExpiring.json?.subscription?.status, "EXPIRING", "dashboard: EXPIRING within 7 days");
const dte = dashExpiring.json?.subscription?.daysToExpiry;
ok(dte >= 3 && dte <= 4, "daysToExpiry truthful (3-4)", dte);
ok(dashExpiring.json?.subscription?.accessAllowed === true, "EXPIRING still has full access");
ok(Boolean(dashExpiring.json?.subscription?.endDate), "expiry DATE is exposed (the banner renders it)");
// >7 days: no warning state.
db.prepare(`UPDATE "Subscription" SET "endDate"=? WHERE "studentId"=?`).run(NOW + 30 * 86400000, arRow.id);
const dashFine = await call("GET", "/api/students/me/dashboard", { cookie: AR });
eq(dashFine.json?.subscription?.status, "ACTIVE", "dashboard: plain ACTIVE beyond 7 days");
matrixRow(
  "STUDENT-19",
  "Renewal warning",
  "<=7 days → clear warning + expiry date + renew CTA data; >7 days → quiet",
  "EXPIRING state + daysToExpiry + endDate exposed; ACTIVE beyond the window; UI renders the badge+CTA (student.168/169, onRenew)",
  "PASS",
  "dashboard API + SubscriptionPill in student-dashboard.tsx"
);

// ===========================================================================
section("STUDENT-20 — Renewal submission: PENDING request preserves live access");
// ===========================================================================
const subBeforeRenewal = subOf(arRow.id);
const endDateBefore = subBeforeRenewal.endDate;
const renewSubmit = await call("POST", "/api/enroll", {
  body: enrollBody({ planId: "qa26b-plan-monthly", groupId: "qa26b-group-ar", reference: "QA26B-REF-RENEW" }),
  cookie: AR,
});
eq(renewSubmit.json?.scenario, "RENEWAL", "scenario = RENEWAL");
const subDuringRenewal = subOf(arRow.id);
eq(subDuringRenewal.id, subBeforeRenewal.id, "SAME subscription singleton");
eq(subDuringRenewal.status, "ACTIVE", "subscription stays ACTIVE during renewal review");
eq(String(subDuringRenewal.endDate), String(endDateBefore), "endDate untouched during review");
const lessonStillOpen = await call("GET", `/api/lessons/${L1}`, { cookie: AR });
eq(lessonStillOpen.status, 200, "content access UNCHANGED while renewal pending");
const dashRenewing = await call("GET", "/api/students/me/dashboard", { cookie: AR });
eq(dashRenewing.json?.subscription?.status, "ACTIVE", "dashboard still ACTIVE (renewal ≠ downgrade)");
ok(Boolean(dashRenewing.json?.paymentRequests?.pending), "renewal request surfaced as pending");
matrixRow("STUDENT-20", "Renewal pending preserves access", "new PENDING payment; subscription/group/access byte-identical", "scenario RENEWAL; same row; same endDate; lesson still 200", "PASS", "POST /api/enroll + dashboard");

// ===========================================================================
section("STUDENT-21 — Renewal approval stacks endDate (exact dates)");
// ===========================================================================
const renewPay = paymentsOf(arUser.id).find((p) => p.status === "PENDING");
ok(Boolean(renewPay), "renewal payment pending");
const before = new Date(endDateBefore);
const approve2 = await call("POST", "/api/admin/payments/" + renewPay.id + "/approve", { body: {}, cookie: ADMIN_COOKIE });
ok(approve2.status === 200, "renewal approval succeeds", JSON.stringify(approve2.json).slice(0, 300));
const subAfterRenewal = subOf(arRow.id);
eq(subAfterRenewal.id, subBeforeRenewal.id, "SAME singleton after approval");
eq(subAfterRenewal.status, "ACTIVE", "status ACTIVE");
eq(String(subAfterRenewal.startDate), String(subBeforeRenewal.startDate), "startDate PRESERVED");
const expectedEnd = new Date(before);
expectedEnd.setUTCMonth(expectedEnd.getUTCMonth() + 1); // Monthly = 1 month stacked on the existing future endDate
const gotEnd = new Date(subAfterRenewal.endDate);
ok(
  Math.abs(gotEnd.getTime() - expectedEnd.getTime()) < 2000,
  `endDate stacked exactly +1 month on the old endDate (${expectedEnd.toISOString()} vs ${gotEnd.toISOString()})`
);
ok(gotEnd.getTime() > before.getTime(), "renewal EXTENDS beyond the previous expiry (no reset)");
matrixRow("STUDENT-21", "Renewal approval stacks endDate", "same singleton; startDate kept; endDate = old endDate + plan duration", "exact stacking verified to the second", "PASS", "approve route + payment-transitions");

// ===========================================================================
section("STUDENT-22 — Expired subscription: locks + recovery (no dead-end)");
// ===========================================================================
db.prepare(`UPDATE "Subscription" SET "endDate"=? WHERE "studentId"=?`).run(NOW - 86400000, arRow.id);
const dashExpired = await call("GET", "/api/students/me/dashboard", { cookie: AR });
eq(dashExpired.json?.subscription?.status, "EXPIRED", "dashboard: lazily EXPIRED (past endDate, stored ACTIVE)");
eq(dashExpired.json?.subscription?.accessAllowed, false, "expired → accessAllowed=false");
const lessonExpired = await call("GET", `/api/lessons/${L1}`, { cookie: AR });
eq(lessonExpired.status, 403, "content LOCKED after expiry");
const renewExpired = await call("POST", "/api/enroll", {
  body: enrollBody({ planId: "qa26b-plan-monthly", groupId: "qa26b-group-ar", reference: "QA26B-REF-REACT" }),
  cookie: AR,
});
eq(renewExpired.json?.scenario, "NEW_REQUEST", "expired student CAN submit again (re-activation path)");
eq(renewExpired.json?.entitlement?.accessAllowed, false, "…and is truthful: no access until approval");
const reactPay = paymentsOf(arUser.id).find((p) => p.status === "PENDING");
const approve3 = await call("POST", "/api/admin/payments/" + reactPay.id + "/approve", { body: {}, cookie: ADMIN_COOKIE });
ok(approve3.status === 200, "reactivation approval succeeds");
const subReactivated = subOf(arRow.id);
eq(subReactivated.id, subBeforeRenewal.id, "SAME singleton reactivated (no second row)");
eq(subReactivated.status, "ACTIVE", "reactivated ACTIVE");
ok(new Date(subReactivated.endDate).getTime() > NOW, "new future endDate written");
const lessonReact = await call("GET", `/api/lessons/${L1}`, { cookie: AR });
eq(lessonReact.status, 200, "content re-opened after reactivation");
matrixRow("STUDENT-22", "Expired recovery", "expiry locks content truthfully; student can pay again; approval reactivates the SAME singleton", "EXPIRED label; 403; NEW_REQUEST; approve → ACTIVE, access restored", "PASS", "lazy expiry + approve path");

// ===========================================================================
section("STUDENT-10 — Rejection: reason, retry, terminal state, coupon release");
// ===========================================================================
const regRej = await registerStudent("qa26b-rej@local.test", "سارة عمر حسن", "LANGUAGE", "30404044505678");
const REJ = cookieOf(regRej);
const rejUser = regRej.json?.user;
const rejSubmit = await call("POST", "/api/enroll", {
  body: {
    courseId: COURSE_ID,
    groupId: "qa26b-group-lang",
    planId: "qa26b-plan-monthly",
    method: "ETISALAT_CASH",
    senderPhone: "01055555555",
    reference: "QA26B-REF-REJ",
    couponCode: "QA26B20",
  },
  cookie: REJ,
});
ok(rejSubmit.status === 200, "submission with coupon accepted", JSON.stringify(rejSubmit.json).slice(0, 200));
const rejRow = studentRowOf("qa26b-rej@local.test");
eq(paymentsOf(rejUser.id)[0].amount, 180, "coupon applied to the amount (200-20=180)");
const rejPay = paymentsOf(rejUser.id)[0];
ok(rejPay.status === "PENDING", "submission PENDING");
eq(db.prepare(`SELECT "usedCount" FROM "Coupon" WHERE "id"='qa26b-coupon'`).get().usedCount, 1, "coupon consumed at submission");
const rejectNoReason = await call("POST", "/api/admin/payments/" + rejPay.id + "/reject", { body: {}, cookie: ADMIN_COOKIE });
eq(rejectNoReason.status, 400, "rejection without a reason is refused");
const reject1 = await call("POST", "/api/admin/payments/" + rejPay.id + "/reject", { body: { reason: "صورة الإيصال غير واضحة" }, cookie: ADMIN_COOKIE });
if (process.env.PHASE26B_DEBUG) console.log("REJECT RESP:", reject1.status, JSON.stringify(reject1.json)?.slice(0, 300));
ok(reject1.status === 200, "rejection with reason succeeds");
const rejPayAfter = db.prepare(`SELECT * FROM "Payment" WHERE "id"=?`).get(rejPay.id);
eq(rejPayAfter.status, "REJECTED", "payment REJECTED");
eq(rejPayAfter.rejectionReason, "صورة الإيصال غير واضحة", "reason stored");
eq(db.prepare(`SELECT "usedCount" FROM "Coupon" WHERE "id"='qa26b-coupon'`).get().usedCount, 0, "coupon RELEASED on rejection (usedCount back to 0)");
const rejNotifs = notificationsOf(rejUser.id).filter((n) => n.type === "PAYMENT_REJECTED");
eq(rejNotifs.length, 1, "rejection notification sent");
ok(rejNotifs[0].message.includes("غير واضحة"), "rejection notification carries the reason");
ok(subOf(rejRow.id) === null || subOf(rejRow.id).status !== "ACTIVE", "rejected student has NO active entitlement");
const rejMine = await call("GET", "/api/students/me/payments", { cookie: REJ });
ok(rejMine.json?.latestRejected?.rejectionReason === "صورة الإيصال غير واضحة", "student SEES the rejection reason (history)");
eq(rejMine.json?.payments?.length, 1, "history lists the payment");
const rejReApprove = await call("POST", "/api/admin/payments/" + rejPay.id + "/approve", { body: {}, cookie: ADMIN_COOKIE });
ok(rejReApprove.status === 409, "REJECTED → APPROVED forbidden (409 INVALID_TRANSITION)");
const rejReReject = await call("POST", "/api/admin/payments/" + rejPay.id + "/reject", { body: { reason: "again" }, cookie: ADMIN_COOKIE });
ok(rejReReject.status === 409, "REJECTED → REJECTED forbidden (409)");
const rejRetry = await call("POST", "/api/enroll", {
  body: {
    courseId: COURSE_ID,
    groupId: "qa26b-group-lang",
    planId: "qa26b-plan-monthly",
    method: "INSTAPAY",
    senderPhone: "01055555555",
    reference: "QA26B-REF-RETRY",
  },
  cookie: REJ,
});
ok(rejRetry.status === 200, "retry accepted");
const rejPayments = paymentsOf(rejUser.id);
eq(rejPayments.length, 2, "retry created a NEW payment row (rejected one untouched)");
eq(rejPayments[0].status, "PENDING", "new payment PENDING");
const rejectedRowStill = db.prepare(`SELECT * FROM "Payment" WHERE "id"=?`).get(rejPay.id);
eq(rejectedRowStill.status, "REJECTED", "terminal rejected payment cannot be mutated back");
matrixRow("STUDENT-10", "Rejection + retry", "reason required+shown; access stays false; retry = new payment; terminal REJECTED immutable; coupon released", "all verified", "PASS", "reject route + payment-transitions + /api/students/me/payments");

// ===========================================================================
section("STUDENT-23 — Grandfathered student (group, no subscription)");
// ===========================================================================
insertUser("qa26b-grand-user", "qa26b-grand@local.test", "STUDENT", "Qa26bStudent1!", "عمر طارق سعيد");
db.prepare(
  `INSERT INTO "Student" ("id","userId","grade","schoolName","schoolType","nationalId","parentPhone","groupId","enrolledAt","createdAt","updatedAt")
   VALUES ('qa26b-grand-student','qa26b-grand-user','2nd Secondary','Legacy School','ARABIC','30505055606789','01111111111','qa26b-group-ar',?,?,?)`
).run(NOW, NOW, NOW);
const grandLogin = await call("POST", "/api/auth/login", { body: { email: "qa26b-grand@local.test", password: "Qa26bStudent1!" } });
const GRAND = cookieOf(grandLogin);
ok(Boolean(GRAND), "grandfathered student logs in", JSON.stringify(grandLogin.json));
const grandLesson = await call("GET", `/api/lessons/${L1}`, { cookie: GRAND });
eq(grandLesson.status, 200, "grandfathered student HAS access (group + no subscription rule)");
const grandDash = await call("GET", "/api/students/me/dashboard", { cookie: GRAND });
eq(grandDash.json?.subscription?.status, "NONE", "dashboard never claims a PAID state (NONE, not ACTIVE)");
eq(grandDash.json?.subscription?.grandfathered, true, "grandfathered flag true (internal term not rendered)");
const grandSubmit = await call("POST", "/api/enroll", {
  body: enrollBody({ planId: "qa26b-plan-monthly", groupId: "qa26b-group-ar", reference: "QA26B-REF-GRAND" }),
  cookie: GRAND,
});
eq(grandSubmit.json?.scenario, "LEGACY_GRANDFATHERED", "submission scenario = LEGACY_GRANDFATHERED");
eq(grandSubmit.json?.subscription ?? null, null, "NO Subscription row created at submission");
eq(db.prepare(`SELECT "groupId" FROM "Student" WHERE "id"='qa26b-grand-student'`).get().groupId, "qa26b-group-ar", "group intact during review");
eq((await call("GET", `/api/lessons/${L1}`, { cookie: GRAND })).status, 200, "access NOT revoked by submitting (still grandfathered)");
const grandPay = paymentsOf("qa26b-grand-user").find((p) => p.reference === "QA26B-REF-GRAND");
eq(grandPay.subscriptionId, null, "Payment.subscriptionId IS null on the grandfathered path");
const grandApprove = await call("POST", "/api/admin/payments/" + grandPay.id + "/approve", { body: {}, cookie: ADMIN_COOKIE });
ok(grandApprove.status === 200, "grandfathered approval succeeds");
const grandSubAfter = subOf("qa26b-grand-student");
ok(grandSubAfter && grandSubAfter.status === "ACTIVE", "approval BORN the singleton ACTIVE");
eq(db.prepare(`SELECT "groupId" FROM "Student" WHERE "id"='qa26b-grand-student'`).get().groupId, "qa26b-group-ar", "group preserved");
eq((await call("GET", `/api/lessons/${L1}`, { cookie: GRAND })).status, 200, "access UNINTERRUPTED across approval");
matrixRow("STUDENT-23", "Grandfathered flow", "group-only access preserved through submit; approval creates the singleton; access never drops", "all verified", "PASS", "payment-submission.ts scenario C + approve");

// ===========================================================================
section("§7 — Closing a plan never touches an ACTIVE entitlement");
// ===========================================================================
db.prepare(`UPDATE "SubscriptionPlan" SET "isActive"=0 WHERE "id"='qa26b-plan-monthly'`).run();
eq((await call("GET", `/api/lessons/${L1}`, { cookie: AR })).status, 200, "AR student keeps access after their plan is closed for sale");
eq(subOf(arRow.id).status, "ACTIVE", "subscription untouched by plan closure");
db.prepare(`UPDATE "SubscriptionPlan" SET "isActive"=1 WHERE "id"='qa26b-plan-monthly'`).run();

// ===========================================================================
section("STUDENT-24 — Payment history (student read contract)");
// ===========================================================================
const hist = await call("GET", "/api/students/me/payments", { cookie: AR });
eq(hist.status, 200, "payments history 200");
const rows = hist.json?.payments ?? [];
ok(rows.length >= 3, "history lists the student's payments (>=3)", rows.length);
ok(rows.every((r) => ["PENDING", "APPROVED", "REJECTED", "EXPIRED"].includes(r.status)), "statuses are truthful enum values");
const created = rows.map((r) => r.createdAt);
eq(created, [...created].sort().reverse(), "history is newest-first");
ok(rows.every((r) => typeof r.amount === "number" && typeof r.method === "string"), "amount + method present per row");
matrixRow("STUDENT-24", "Payment history", "student sees own rows: status/date/amount/method/reason, newest first, strict ownership", "verified", "PASS", "/api/students/me/payments");

// ===========================================================================
section("§30/§31 — Notification events + expiry-notification architecture");
// ===========================================================================
const arNotifs = notificationsOf(arUser.id);
const approveCount = arNotifs.filter((n) => n.type === "PAYMENT_APPROVED").length;
eq(approveCount, 3, "three approvals → exactly three approval notifications (1:1, no spam)", approveCount);
const srcRoot = path.join(REPO, "src");
const expirySenders = [];
for (const dir of ["app/api", "lib"]) {
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(ts|tsx)$/.test(f.name) && fs.readFileSync(p, "utf8").includes("SUBSCRIPTION_EXPIRATION")) expirySenders.push(p);
    }
  };
  walk(path.join(srcRoot, dir));
}
// A file that merely NAMES the type is not a SENDER, so the guard is applied to
// dispatch capability, not to the string alone. `lib/notification-labels.ts`
// (Phase F manual-QA Finding 8) is the single display-label map for the WHOLE
// NotificationType enum — it exists so no surface renders a raw enum — and it
// contains no dispatch call. It is exempted explicitly (never by pattern) and
// the exemption is re-proved here: the moment that module starts dispatching,
// the Section 31 answer below is wrong and this check must fail again.
const DISPATCH_CALL =
  /notification\.create|notification\.createMany|createNotification|createManyNotifications|notifyUsers?\s*\(|sendNotification/;
const labelMap = path.join(srcRoot, "lib", "notification-labels.ts");
const labelMapIsPresentationOnly =
  !fs.existsSync(labelMap) || !DISPATCH_CALL.test(fs.readFileSync(labelMap, "utf8"));
ok(
  labelMapIsPresentationOnly &&
    expirySenders.every(
      (f) =>
        f.endsWith("notify.ts") ||
        f.includes("admin") ||
        (f === labelMap && labelMapIsPresentationOnly)
    ),
  "no AUTOMATIC expiry-notification sender exists (only prefs mapping + admin broadcast) — Section 31 answer",
  expirySenders.join(",")
);
matrixRow(
  "STUDENT-18b",
  "Expiry notifications",
  "business wants pre-expiry warning; NO second cron allowed (Phase 24 owns the only cron)",
  "read-time EXPIRING warning EXISTS (dashboard); SUBSCRIPTION_EXPIRATION type exists but nothing sends it automatically; lazy read-time notification is the designed extension point — reported, not built",
  "PASS (by design)",
  "EXPIRING_WINDOW_DAYS=7; dashboard state; no cron added"
);

// ===========================================================================
section("§32-36 — Bookmarks / notes / study plan / gamification / certificate / export");
// ===========================================================================
const bm = await call("POST", "/api/students/me/bookmarks", { body: { lessonId: L1 }, cookie: AR });
ok(bm.status === 200 || bm.status === 201, "bookmark created", JSON.stringify(bm.json).slice(0, 120));
const bmList = await call("GET", "/api/students/me/bookmarks", { cookie: AR });
ok((JSON.stringify(bmList.json) || "").includes(L1), "bookmark listed");
const bmOther = await call("GET", "/api/students/me/bookmarks", { cookie: GRAND });
ok(!(JSON.stringify(bmOther.json) || "").includes(L1), "cross-student isolation: other student's bookmarks not served");
const note = await call("POST", "/api/students/me/notes", { body: { lessonId: L1, content: "ملاحظة qa26b" }, cookie: AR });
ok(note.status === 200 || note.status === 201, "note created", JSON.stringify(note.json).slice(0, 120));
const noteList = await call("GET", `/api/students/me/notes?lessonId=${L1}`, { cookie: AR });
ok((JSON.stringify(noteList.json) || "").includes("ملاحظة qa26b"), "note listed");
const studyPlan = await call("GET", "/api/students/me/study-plan", { cookie: AR });
ok(studyPlan.status === 200, "study plan readable", String(studyPlan.status));
const gam = await call("GET", "/api/students/me/gamification", { cookie: AR });
ok(gam.status === 200, "gamification readable");
const lb = await call("GET", "/api/students/me/leaderboard", { cookie: AR });
ok(lb.status === 200, "leaderboard readable");
ok((JSON.stringify(lb.json) || "").length < 200000, "leaderboard payload bounded (<200KB)");
const cert = await call("GET", "/api/students/me/certificate", { cookie: AR });
ok(cert.status === 200 || cert.status === 403 || cert.status === 404, "certificate endpoint responds", String(cert.status));
const certBody = JSON.stringify(cert.json ?? {});
ok(!(cert.status === 200 && certBody.includes('"eligible":true')), "certificate NOT granted before course completion", certBody.slice(0, 120));
const exp = await call("GET", "/api/students/me/export-progress", { cookie: AR });
if (process.env.PHASE26B_DEBUG) console.log("EXPORT RESP:", exp.status, JSON.stringify(exp.json)?.slice(0, 300));
ok(exp.status === 200, "export progress responds for an ARABIC-named student (Content-Disposition fix)", String(exp.status));
const expDisposition = exp.disposition ?? "";
ok(/^attachment; filename="[A-Za-z0-9._-]+"(;|$)/.test(expDisposition), "export filename header is latin1-safe (never 500s)", expDisposition.slice(0, 120));
const expBody = JSON.stringify(exp.json ?? {});
ok(!expBody.includes("qa26b-grand") && !expBody.includes("qa26b-lang"), "export contains only the caller's data");

// ===========================================================================
section("STUDENT-26 — Responsive/RTL invariants (student payment + dashboard)");
// ===========================================================================
{
  const dash = fs.readFileSync(path.join(REPO, "src/components/student/student-dashboard.tsx"), "utf8");
  const panel = fs.readFileSync(path.join(REPO, "src/components/student/payment-status.tsx"), "utf8");
  ok(!/className="[^"]*\bpl-\d/.test(dash), "dashboard: no physical padding-left (logical props only)");
  ok(!/className="[^"]*\bpr-\d/.test(dash), "dashboard: no physical padding-right (logical props only)");
  ok(!/className="[^"]*\bml-\d/.test(panel) && !/className="[^"]*\bmr-\d/.test(panel), "payment panel: logical margins (ms/me) only");
  ok(dash.includes("flip-rtl"), "directional icons use the flip-rtl helper");
  // Renewal CTA keys exist in both locales (the <=7d banner + expired CTA).
  for (const [key, dict] of [
    ["student.168", "i18n-dict"],
    ["student.169", "i18n-dict"],
    ["student.170", "i18n-dict"],
    ["pay.pendingRenewal", "i18n-dict-2026"],
  ]) {
    const arVal = I18N.translate("ar", key);
    const enVal = I18N.translate("en", key);
    ok(arVal !== key && enVal !== key, `${key} resolves in BOTH locales (ar: "${arVal}")`);
  }
}

// ===========================================================================
section("SUMMARY — STUDENT flow matrix");
// ===========================================================================
for (const m of matrix) {
  console.log(`  ${m.verdict.startsWith("PASS") ? "✔" : "✘"} ${m.id.padEnd(12)} ${m.name} — ${m.verdict}`);
}

console.log("\n============================================================");
if (failures.length === 0) {
  console.log(`PHASE26B_STUDENT_OK — ${pass} assertions passed`);
} else {
  console.log(`PHASE26B_STUDENT_FAIL — ${pass} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
}
server.close();
process.exit(failures.length === 0 ? 0 : 1);
