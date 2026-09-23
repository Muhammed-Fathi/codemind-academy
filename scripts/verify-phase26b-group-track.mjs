#!/usr/bin/env node
// CodeMind Academy — Phase 26B GROUP AUDIENCE verification (real HTTP).
//
// WHAT THIS SCRIPT OWNS
//   The owner-approved blocker fix for GAP-1: every teaching Group carries an
//   EXPLICIT audience — Group.trackScope (TrackScope enum: ARABIC | LANGUAGE;
//   null = UNCLASSIFIED, fail-closed). This verifier proves the whole audience
//   matrix A–Q end-to-end over the SHIPPED route handlers + REAL SQLite
//   (same discipline as scripts/verify-phase26b-student.mjs, which see for
//   the sandbox rationale):
//
//     A/B  admin creates ARABIC / LANGUAGE groups explicitly;
//     C    missing / SHARED / unknown audiences are rejected (api.285),
//          including the name-inference trap (Arabic-looking name, no
//          audience → still 400; zero rows written);
//     D/E  /api/groups scopes listings to the authenticated student's OWN
//          persisted schoolType (ARABIC sees ARABIC groups, LANGUAGE sees
//          LANGUAGE groups; UNCLASSIFIED hidden from both; anonymous → 401);
//     F/G  /api/enroll rejects wrong-track submissions BOTH directions (400);
//     H    a mismatch creates ZERO Payment / Subscription rows and never
//          touches Student.groupId or Student.schoolType (tamper-proof);
//     I    a same-track submission succeeds (NEW_REQUEST, PENDING rows);
//     J    decision authority: approving with a WRONG-TRACK overrideGroupId →
//          409 GROUP_TRACK_MISMATCH, payment/subscription stay PENDING, no
//          seat consumed, no assignment;
//     K    the SAME payment approved with a CORRECT-track override succeeds;
//     L    a RENEWAL pointed at a wrong-track group is refused (400) with the
//          current entitlement byte-for-byte unchanged;
//     M    dashboard + session-videos are audience-correct for BOTH tracks;
//     N    changing a POPULATED group to an incompatible audience → 409
//          api.287, row untouched, no silent reassignment;
//     O    changing an EMPTY group's audience → allowed (explicit operator
//          classification), row updated;
//     P    content SHARED semantics are UNCHANGED (SHARED lesson + material
//          serve BOTH tracks; ARABIC-only content stays blocked cross-track);
//          SHARED is still rejected on every GROUP write path;
//     Q    capacity semantics are UNCHANGED (full same-track group → 400).
//
//   Local fixtures only, all clearly labelled `gtg-*`. No Neon, no R2, no
//   SMTP, no real payments.
//
// Usage:
//   node scripts/verify-phase26b-group-track.mjs
// Prints PHASE26B_GROUP_TRACK_OK on success.

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
  "src/app/api/teacher/homework/route.ts",
  "src/app/api/admin/groups/route.ts",
  "src/app/api/admin/groups/[id]/route.ts",
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
  ["POST", /^\/api\/admin\/groups$/, () => route("admin/groups/route.js").POST],
  ["PATCH", /^\/api\/admin\/groups\/([^/]+)$/, () => route("admin/groups/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/enroll$/, () => route("enroll/route.js").POST],
  ["GET", /^\/api\/students\/me\/dashboard$/, () => route("students/me/dashboard/route.js").GET],
  ["GET", /^\/api\/students\/me\/session-videos$/, () => route("students/me/session-videos/route.js").GET],
  ["GET", /^\/api\/lessons\/([^/]+)$/, () => route("lessons/[id]/route.js").GET, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/materials\/([^/]+)$/, () => route("materials/[id]/route.js").GET, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/admin\/payments\/([^/]+)\/approve$/, () => route("admin/payments/[id]/approve/route.js").POST, (m) => ({ id: m[1] })],
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
// 5. Fixtures — clearly-labelled gtg-* local rows only.
// ---------------------------------------------------------------------------
const db = rawDb;
const NOW = Date.now();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const ADMIN_PW = "GtgAdminLocal1!";

function insertUser(id, email, role, password, name) {
  db.prepare(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt")
     VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`
  ).run(id, email, Auth.hashPassword(password), name, role, NOW, NOW);
}
function insertSession(id, userId, token) {
  db.prepare(
    `INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt","revokedAt")
     VALUES (?,?,?,?,?,?,?,NULL)`
  ).run(id, userId, sha256(token), "gtg-device", NOW, NOW, NOW + 86400000);
}
insertUser("gtg-admin", "gtg-admin@local.test", "ADMIN", ADMIN_PW, "GTG Admin");
insertSession("gtg-admin-session", "gtg-admin", "gtg-admin-raw-token");
const ADMIN_COOKIE = "cm_session=gtg-admin-raw-token";

// Course skeleton: Part → Unit → lesson 1 (SHARED, published).
const COURSE_ID = "gtg-course";
db.prepare(
  // Phase K2 — the fixture course is levelled (SECOND_SECONDARY); every
  // student below registers at the same level, so the orthogonal level gate
  // is transparent to this audience matrix.
  `INSERT INTO "Course" ("id","slug","name","nameAr","description","color","academicLevel","createdAt","updatedAt")
   VALUES (?,?,?,?,?,?,?,?,?)`
).run(COURSE_ID, "gtg-course", "GTG Course", "كورس GTG", "desc", "#10b981", "SECOND_SECONDARY", NOW, NOW);
db.prepare(
  `INSERT INTO "Part" ("id","courseId","title","titleAr","order") VALUES ('gtg-part',?,'P','ج','1')`
).run(COURSE_ID);
db.prepare(
  `INSERT INTO "Unit" ("id","partId","title","titleAr","order") VALUES ('gtg-unit','gtg-part','U','و','1')`
).run();
db.prepare(
  `INSERT INTO "Lesson" ("id","title","titleAr","order","unitId","status","trackScope","createdAt","updatedAt")
   VALUES ('gtg-l1','Lesson one','درس واحد','1','gtg-unit','PUBLISHED','SHARED',?,?)`
).run(NOW, NOW);
// Cross-track probes (non-official, last positions — never disturb lesson 1).
db.prepare(
  `INSERT INTO "Lesson" ("id","title","titleAr","order","unitId","status","trackScope","createdAt","updatedAt")
   VALUES ('gtg-lesson-arabic','Arabic-only','درس عربي','98','gtg-unit','PUBLISHED','ARABIC',?,?)`
).run(NOW, NOW);
db.prepare(
  `INSERT INTO "Lesson" ("id","title","titleAr","order","unitId","status","trackScope","createdAt","updatedAt")
   VALUES ('gtg-lesson-language','Language-only','درس لغات','99','gtg-unit','PUBLISHED','LANGUAGE',?,?)`
).run(NOW, NOW);

// Groups — the audience matrix (ARABIC / LANGUAGE / UNCLASSIFIED / full).
function insertGroup(id, name, trackScope, capacity = 20) {
  db.prepare(
    `INSERT INTO "Group" ("id","name","courseId","teacherId","capacity","schedule","isActive","trackScope","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, name, COURSE_ID, null, capacity, "Sat & Tue 6PM", 1, trackScope, NOW, NOW);
}
insertGroup("gtg-group-ar", "GTG ARABIC group", "ARABIC");
insertGroup("gtg-group-lang", "GTG LANGUAGE group", "LANGUAGE");
insertGroup("gtg-group-null", "GTG unclassified group", null);
insertGroup("gtg-group-full", "GTG full ARABIC group", "ARABIC", 1);
// The FULL group's seat holder (plain fixture, never a driver).
insertUser("gtg-seat-user", "gtg-seat@local.test", "STUDENT", "GtgSeatLocal1!", "Seat Holder");
db.prepare(
  `INSERT INTO "Student" ("id","userId","grade","academicLevel","schoolName","schoolType","nationalId","parentPhone","groupId","enrolledAt","createdAt","updatedAt")
   VALUES ('gtg-seat-student','gtg-seat-user','2nd Secondary','SECOND_SECONDARY','GTG School','ARABIC','30000000001111','01000000001','gtg-group-full',?,?,?)`
).run(NOW, NOW, NOW);

// One active plan.
db.prepare(
  `INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","isActive","createdAt")
   VALUES ('gtg-plan','Monthly','شهري',1,200,0,1,?)`
).run(NOW);

// Batches + published session videos (content track = batch.schoolType).
db.prepare(
  `INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt")
   VALUES ('gtg-batch-ar','Arabic batch','دفعة عربي','ARABIC',NULL,1,?,?)`
).run(NOW, NOW);
db.prepare(
  `INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt")
   VALUES ('gtg-batch-lang','Language batch','دفعة لغات','LANGUAGE',NULL,1,?,?)`
).run(NOW, NOW);
db.prepare(
  `INSERT INTO "MediaAsset" ("id","kind","storage","externalUrl","isPrivate","createdAt")
   VALUES ('gtg-media-vid','VIDEO','EXTERNAL_URL','https://www.youtube.com/embed/gtg-rec',0,?)`
).run(NOW);
for (const [vid, batch, title] of [
  ["gtg-video-ar", "gtg-batch-ar", "Arabic recording"],
  ["gtg-video-lang", "gtg-batch-lang", "Language recording"],
]) {
  db.prepare(
    `INSERT INTO "SessionVideo" ("id","batchId","lessonId","mediaAssetId","title","titleAr","isPublished","publishedAt","createdAt","updatedAt")
     VALUES (?,?,?,?,?,?,1,?,?,?)`
  ).run(vid, batch, "gtg-l1", "gtg-media-vid", title, title, NOW, NOW, NOW);
}

// Private SHARED PDF material on lesson 1 (local bytes, never /public).
const pdfBytes = Buffer.from("%PDF-1.4 gtg fixture material\n");
fs.writeFileSync(path.join(MEDIA_ROOT, "gtg-material.pdf"), pdfBytes);
db.prepare(
  `INSERT INTO "MediaAsset" ("id","kind","storage","storageKey","mimeType","sizeBytes","originalName","isPrivate","createdAt")
   VALUES ('gtg-material-asset','DOCUMENT','LOCAL_PRIVATE','gtg-material.pdf','application/pdf',?,'material.pdf',1,?)`
).run(pdfBytes.length, NOW);
db.prepare(
  `INSERT INTO "Material" ("id","lessonId","kind","title","trackScope","isActive","mediaAssetId","createdAt","updatedAt")
   VALUES ('gtg-material-l1','gtg-l1','ADMIN_UPLOADED','Material PDF','SHARED',1,'gtg-material-asset',?,?)`
).run(NOW, NOW);

// ---------------------------------------------------------------------------
// 6. Students — born through the REAL register endpoint.
// ---------------------------------------------------------------------------
async function registerStudent(email, name, schoolType, nationalId) {
  return call("POST", "/api/auth/register", {
    body: {
      role: "STUDENT", email, name, password: "GtgStudent1!",
      studentPhone: "01012345678", parentPhone: "01098765432",
      nationalId, schoolName: "GTG School", schoolType,
      academicLevel: "SECOND_SECONDARY",
    },
  });
}
const studentRowOf = (email) =>
  db.prepare(`SELECT s.* FROM "Student" s JOIN "User" u ON u."id"=s."userId" WHERE u."email"=?`).get(email);
const paymentsOf = (userId) =>
  db.prepare(`SELECT * FROM "Payment" WHERE "userId"=? ORDER BY "createdAt" DESC, "id" DESC`).all(userId);
const subOf = (studentId) =>
  db.prepare(`SELECT * FROM "Subscription" WHERE "studentId"=?`).get(studentId) ?? null;
const groupById = (id) => db.prepare(`SELECT * FROM "Group" WHERE "id"=?`).get(id);
const seatCountOf = (groupId) =>
  db.prepare(`SELECT COUNT(*) AS c FROM "Student" WHERE "groupId"=?`).get(groupId).c;

const regAr = await registerStudent("gtg-ar@local.test", "أحمد محمد علي", "ARABIC", "30101011202345");
const AR = cookieOf(regAr);
ok(regAr.status === 200 && AR, "ARABIC student registers", JSON.stringify(regAr.json));
const arUser = regAr.json?.user;
const regLang = await registerStudent("gtg-lang@local.test", "منى خالد محمود", "LANGUAGE", "30202022303456");
const LANG = cookieOf(regLang);
ok(regLang.status === 200 && LANG, "LANGUAGE student registers", JSON.stringify(regLang.json));
const langUser = regLang.json?.user;

const enrollBody = (over = {}) => ({
  courseId: COURSE_ID,
  groupId: "gtg-group-ar",
  planId: "gtg-plan",
  method: "INSTAPAY",
  senderPhone: "01012345678",
  reference: "GTG-REF-0001",
  ...over,
});

// ===========================================================================
section("A/B — Admin creates groups with an EXPLICIT audience");
// ===========================================================================
const mkBody = (over = {}) => ({
  name: "GTG created group", courseId: COURSE_ID, capacity: 20, schedule: "Sat 6PM", ...over,
});
const mkA = await call("POST", "/api/admin/groups", { body: mkBody({ name: "GTG created ARABIC", trackScope: "ARABIC" }), cookie: ADMIN_COOKIE });
ok(mkA.status === 200 || mkA.status === 201, "A: ARABIC group created", JSON.stringify(mkA.json));
ok(groupById(mkA.json?.group?.id)?.trackScope === "ARABIC", "A: audience persisted as ARABIC");
const mkB = await call("POST", "/api/admin/groups", { body: mkBody({ name: "GTG created LANGUAGE", trackScope: "LANGUAGE" }), cookie: ADMIN_COOKIE });
ok(mkB.status === 200 || mkB.status === 201, "B: LANGUAGE group created", JSON.stringify(mkB.json));
ok(groupById(mkB.json?.group?.id)?.trackScope === "LANGUAGE", "B: audience persisted as LANGUAGE");

// ===========================================================================
section("C — Missing / SHARED / unknown audiences rejected (no inference, no default)");
// ===========================================================================
const groupsBeforeC = db.prepare(`SELECT COUNT(*) AS c FROM "Group"`).get().c;
for (const [label, trackScope] of [
  ["absent", undefined],
  ["null", null],
  ["empty string", ""],
  ["SHARED (content-only concept)", "SHARED"],
  ["unknown (AMERICAN)", "AMERICAN"],
]) {
  const body = mkBody({ name: "GTG should-not-exist " + label });
  if (trackScope !== undefined) body.trackScope = trackScope;
  const r = await call("POST", "/api/admin/groups", { body, cookie: ADMIN_COOKIE });
  ok(r.status === 400, `C: ${label} audience rejected (400)`, JSON.stringify(r.json));
}
// The inference trap: an Arabic-looking name with NO audience must still be
// refused — the audience is NEVER inferred from the group name.
const rNameTrap = await call("POST", "/api/admin/groups", {
  body: mkBody({ name: "مجموعة عربي — السبت والثلاثاء" }), cookie: ADMIN_COOKIE,
});
ok(rNameTrap.status === 400, "C: Arabic-looking name WITHOUT an audience is still rejected (400) — no name inference");
ok(db.prepare(`SELECT COUNT(*) AS c FROM "Group"`).get().c === groupsBeforeC, "C: zero rows written by every rejected create");

// ===========================================================================
section("D/E — /api/groups scopes listings to the student's OWN schoolType");
// ===========================================================================
const groupsAr = await call("GET", `/api/groups?courseId=${COURSE_ID}`, { cookie: AR });
const arIds = (groupsAr.json?.groups ?? []).map((g) => g.id);
ok(groupsAr.status === 200, "D: listing 200 for the ARABIC student");
ok(arIds.includes("gtg-group-ar") && arIds.includes("gtg-group-full"), "D: ARABIC student sees the ARABIC groups");
ok(!arIds.includes("gtg-group-lang"), "D: ARABIC student does NOT see the LANGUAGE group");
ok(!arIds.includes("gtg-group-null"), "D: ARABIC student does NOT see the UNCLASSIFIED group");
ok(!("trackScope" in (groupsAr.json?.groups?.[0] ?? {})), "D: audience is internal — never exposed in the payload");
const groupsLang = await call("GET", `/api/groups?courseId=${COURSE_ID}`, { cookie: LANG });
const langIds = (groupsLang.json?.groups ?? []).map((g) => g.id);
ok(groupsLang.status === 200, "E: listing 200 for the LANGUAGE student");
ok(langIds.includes("gtg-group-lang"), "E: LANGUAGE student sees the LANGUAGE group");
ok(!langIds.includes("gtg-group-ar") && !langIds.includes("gtg-group-full"), "E: LANGUAGE student does NOT see the ARABIC groups");
ok(!langIds.includes("gtg-group-null"), "E: LANGUAGE student does NOT see the UNCLASSIFIED group");
const groupsAnon = await call("GET", `/api/groups?courseId=${COURSE_ID}`);
ok(groupsAnon.status === 401 || groupsAnon.status === 403, "D/E: anonymous listing refused (student auth required)");

// ===========================================================================
section("F/G/H — /api/enroll refuses wrong-track submissions; ZERO writes");
// ===========================================================================
const paysArBefore = paymentsOf(arUser.id).length;
const subsArBefore = subOf(studentRowOf("gtg-ar@local.test").id);
const tArToLang = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "gtg-group-lang", reference: "GTG-REF-WRONG-AR" }), cookie: AR });
ok(tArToLang.status === 400, "F: ARABIC student → LANGUAGE group rejected (400)", JSON.stringify(tArToLang.json));
const tLangToAr = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "gtg-group-ar", reference: "GTG-REF-WRONG-LANG" }), cookie: LANG });
ok(tLangToAr.status === 400, "G: LANGUAGE student → ARABIC group rejected (400, reciprocal)", JSON.stringify(tLangToAr.json));
const tArToNull = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "gtg-group-null", reference: "GTG-REF-NULL" }), cookie: AR });
ok(tArToNull.status === 400, "F: UNCLASSIFIED group is NOT enrollable (fail-closed 400)", JSON.stringify(tArToNull.json));
ok(paymentsOf(arUser.id).length === paysArBefore && paymentsOf(langUser.id).length === 0, "H: ZERO Payment rows created by the mismatches");
ok(subOf(studentRowOf("gtg-ar@local.test").id) === subsArBefore && subOf(studentRowOf("gtg-lang@local.test").id) === null, "H: ZERO Subscription rows created by the mismatches");
ok(studentRowOf("gtg-ar@local.test").groupId === null && studentRowOf("gtg-lang@local.test").groupId === null, "H: Student.groupId untouched by the mismatches");
ok(studentRowOf("gtg-ar@local.test").schoolType === "ARABIC" && studentRowOf("gtg-lang@local.test").schoolType === "LANGUAGE", "H: Student.schoolType never mutated (client can never tamper it via enroll)");

// ===========================================================================
section("I — Same-track submission succeeds (NEW_REQUEST, PENDING)");
// ===========================================================================
const submitAr = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "gtg-group-ar", reference: "GTG-REF-AR" }), cookie: AR });
ok(submitAr.status === 200, "I: ARABIC student → ARABIC group submits (200)", JSON.stringify(submitAr.json));
eq(submitAr.json?.scenario, "NEW_REQUEST", "I: scenario = NEW_REQUEST");
const payAr = paymentsOf(arUser.id)[0];
ok(payAr && payAr.status === "PENDING", "I: Payment row PENDING");
ok(subOf(studentRowOf("gtg-ar@local.test").id)?.status === "PENDING", "I: Subscription row PENDING");

// ===========================================================================
section("J — Decision authority: WRONG-TRACK approval override refused (no half-apply)");
// ===========================================================================
const seatLangBefore = seatCountOf("gtg-group-lang");
// The override input is the route's `groupId` body field (admin-only, fully
// validated by the decision authority).
const approveWrong = await call("POST", "/api/admin/payments/" + payAr.id + "/approve", { body: { groupId: "gtg-group-lang" }, cookie: ADMIN_COOKIE });
eq(approveWrong.status, 409, "J: wrong-track overrideGroupId → 409", JSON.stringify(approveWrong.json));
eq(db.prepare(`SELECT "status" FROM "Payment" WHERE "id"=?`).get(payAr.id).status, "PENDING", "J: payment still PENDING (nothing half-applied)");
eq(subOf(studentRowOf("gtg-ar@local.test").id)?.status, "PENDING", "J: subscription still PENDING");
eq(studentRowOf("gtg-ar@local.test").groupId, null, "J: no assignment happened");
eq(seatCountOf("gtg-group-lang"), seatLangBefore, "J: LANGUAGE group seat count unchanged");

// ===========================================================================
section("K — The SAME payment approved with a CORRECT-track override succeeds");
// ===========================================================================
const approveRight = await call("POST", "/api/admin/payments/" + payAr.id + "/approve", { body: { groupId: "gtg-group-ar" }, cookie: ADMIN_COOKIE });
ok(approveRight.status === 200, "K: correct-track override approves (200)", JSON.stringify(approveRight.json).slice(0, 300));
eq(studentRowOf("gtg-ar@local.test").groupId, "gtg-group-ar", "K: student assigned to the ARABIC group");
eq(subOf(studentRowOf("gtg-ar@local.test").id)?.status, "ACTIVE", "K: subscription ACTIVE");

// ===========================================================================
section("L — Wrong-track RENEWAL target refused; current entitlement unchanged");
// ===========================================================================
const subBeforeRenewal = subOf(studentRowOf("gtg-ar@local.test").id);
const paysBeforeRenewal = paymentsOf(arUser.id).length;
const tRenewWrong = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "gtg-group-lang", reference: "GTG-REF-RENEW-WRONG" }), cookie: AR });
ok(tRenewWrong.status === 400, "L: renewal pointed at a LANGUAGE group refused (400)", JSON.stringify(tRenewWrong.json));
const subAfterRenewal = subOf(studentRowOf("gtg-ar@local.test").id);
eq(subAfterRenewal.id, subBeforeRenewal.id, "L: SAME subscription row (no reset)");
eq(subAfterRenewal.status, "ACTIVE", "L: entitlement still ACTIVE");
eq(subAfterRenewal.endDate, subBeforeRenewal.endDate, "L: endDate byte-identical (nothing stacked/torn)");
eq(studentRowOf("gtg-ar@local.test").groupId, "gtg-group-ar", "L: group assignment unchanged");
eq(paymentsOf(arUser.id).length, paysBeforeRenewal, "L: ZERO new Payment rows");

// ===========================================================================
section("M — Dashboard + session-videos audience-correct for BOTH tracks");
// ===========================================================================
const dashAr = await call("GET", "/api/students/me/dashboard", { cookie: AR });
eq(dashAr.json?.subscription?.status, "ACTIVE", "M: ARABIC dashboard ACTIVE");
eq(dashAr.json?.group?.id, "gtg-group-ar", "M: ARABIC dashboard shows the ARABIC group");
const vidsAr = await call("GET", `/api/students/me/session-videos?lessonId=gtg-l1`, { cookie: AR });
eq(vidsAr.status, 200, "M: session-videos 200 for the ARABIC student");
ok(vidsAr.json?.isEnrolled === true, "M: ARABIC student enrolled for videos");
ok(JSON.stringify(vidsAr.json?.videos ?? []).includes("gtg-video-ar"), "M: ARABIC student sees the ARABIC batch recording");
ok(!JSON.stringify(vidsAr.json?.videos ?? []).includes("gtg-video-lang"), "M: ARABIC student does NOT see the LANGUAGE recording");
// LANGUAGE side: same-track submission + plain approval (no override needed).
const submitLang = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "gtg-group-lang", reference: "GTG-REF-LANG" }), cookie: LANG });
ok(submitLang.status === 200, "M: LANGUAGE student → LANGUAGE group submits (200)", JSON.stringify(submitLang.json));
const payLang = paymentsOf(langUser.id)[0];
const approveLang = await call("POST", "/api/admin/payments/" + payLang.id + "/approve", { body: {}, cookie: ADMIN_COOKIE });
ok(approveLang.status === 200, "M: LANGUAGE approval succeeds", JSON.stringify(approveLang.json).slice(0, 200));
eq(studentRowOf("gtg-lang@local.test").groupId, "gtg-group-lang", "M: LANGUAGE student landed in the LANGUAGE group");
const vidsLang = await call("GET", `/api/students/me/session-videos?lessonId=gtg-l1`, { cookie: LANG });
eq(vidsLang.status, 200, "M: session-videos 200 for the LANGUAGE student");
ok(JSON.stringify(vidsLang.json?.videos ?? []).includes("gtg-video-lang"), "M: LANGUAGE student sees the LANGUAGE recording");
ok(!JSON.stringify(vidsLang.json?.videos ?? []).includes("gtg-video-ar"), "M: LANGUAGE student does NOT see the ARABIC recording");

// ===========================================================================
section("N/O — Group audience edits: populated-incompatible refused; empty allowed");
// ===========================================================================
const patchWrong = await call("PATCH", "/api/admin/groups/gtg-group-ar", { body: { trackScope: "LANGUAGE" }, cookie: ADMIN_COOKIE });
eq(patchWrong.status, 409, "N: populated ARABIC group → LANGUAGE refused (409)", JSON.stringify(patchWrong.json));
eq(groupById("gtg-group-ar").trackScope, "ARABIC", "N: row untouched (no silent reclassification)");
eq(studentRowOf("gtg-ar@local.test").schoolType, "ARABIC", "N: student schoolType untouched (no reassignment)");
const patchShared = await call("PATCH", "/api/admin/groups/gtg-group-ar", { body: { trackScope: "SHARED" }, cookie: ADMIN_COOKIE });
eq(patchShared.status, 400, "N/P: SHARED is rejected on the group EDIT path too (400 api.285)");
// O: an EMPTY group may be re-audience'd — explicit operator classification.
const mkSwap = await call("POST", "/api/admin/groups", { body: mkBody({ name: "GTG swap group", trackScope: "ARABIC" }), cookie: ADMIN_COOKIE });
ok(mkSwap.status === 200 || mkSwap.status === 201, "O: empty group created ARABIC");
const patchSwap = await call("PATCH", "/api/admin/groups/" + mkSwap.json?.group?.id, { body: { trackScope: "LANGUAGE" }, cookie: ADMIN_COOKIE });
ok(patchSwap.status === 200, "O: EMPTY group re-audienced ARABIC → LANGUAGE allowed (200)", JSON.stringify(patchSwap.json));
eq(groupById(mkSwap.json?.group?.id)?.trackScope, "LANGUAGE", "O: new audience persisted");
// N-extra: mismatched addStudentIds on the edit path is refused (api.286).
const addWrong = await call("PATCH", "/api/admin/groups/gtg-group-ar", { body: { addStudentIds: [studentRowOf("gtg-lang@local.test").id] }, cookie: ADMIN_COOKIE });
eq(addWrong.status, 409, "N: assigning a LANGUAGE student into the ARABIC group via edit → 409", JSON.stringify(addWrong.json));
eq(studentRowOf("gtg-lang@local.test").groupId, "gtg-group-lang", "N: mismatched assignment never wrote");

// ===========================================================================
section("P — Content SHARED semantics unchanged; audience never leaks into content");
// ===========================================================================
const l1Ar = await call("GET", "/api/lessons/gtg-l1", { cookie: AR });
eq(l1Ar.status, 200, "P: SHARED lesson open for the ARABIC student");
const l1Lang = await call("GET", "/api/lessons/gtg-l1", { cookie: LANG });
eq(l1Lang.status, 200, "P: SHARED lesson open for the LANGUAGE student too");
const matLang = await call("GET", "/api/materials/gtg-material-l1", { cookie: LANG });
eq(matLang.status, 200, "P: SHARED material downloads for the LANGUAGE student");
const arabicForLang = await call("GET", "/api/lessons/gtg-lesson-arabic", { cookie: LANG });
ok(arabicForLang.status === 403 || arabicForLang.status === 404, "P: ARABIC-only lesson still blocked for the (entitled) LANGUAGE student", String(arabicForLang.status));
const langForAr = await call("GET", "/api/lessons/gtg-lesson-language", { cookie: AR });
ok(langForAr.status === 403 || langForAr.status === 404, "P: LANGUAGE-only lesson still blocked for the (entitled) ARABIC student", String(langForAr.status));

// ===========================================================================
section("Q — Capacity semantics unchanged");
// ===========================================================================
const regAr2 = await registerStudent("gtg-ar2@local.test", "يوسف كريم علي", "ARABIC", "30505055606778");
const AR2 = cookieOf(regAr2);
ok(regAr2.status === 200 && AR2, "Q: second ARABIC student registers");
const tFull = await call("POST", "/api/enroll", { body: enrollBody({ groupId: "gtg-group-full", reference: "GTG-REF-FULL" }), cookie: AR2 });
ok(tFull.status === 400, "Q: full same-track group still refused (400)", JSON.stringify(tFull.json));
eq(seatCountOf("gtg-group-full"), 1, "Q: the full group still holds exactly one seat");
ok(paymentsOf(regAr2.json?.user?.id).length === 0, "Q: the refused submission wrote nothing");

// ---------------------------------------------------------------------------
section("SUMMARY");
console.log("\n============================================================");
if (failures.length === 0) {
  console.log(`PHASE26B_GROUP_TRACK_OK — ${pass} assertions passed`);
} else {
  console.log(`PHASE26B_GROUP_TRACK_FAIL — ${pass} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
}
server.close();
process.exit(failures.length === 0 ? 0 : 1);
