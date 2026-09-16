#!/usr/bin/env node
/**
 * Post-launch performance benchmark (Section 8 of the post-launch audit).
 *
 * WHAT IT MEASURES
 *   Application + query latency of the hot auth/dashboard paths, using the
 *   repo's own verification methodology: REAL compiled route handlers (tsc)
 *   against a REAL SQLite database (scripts/lib/migrate-sqlite.mjs +
 *   scripts/lib/sqlite-prisma-lite.mjs — the same harness every phase
 *   verifier uses, because Prisma engine binaries cannot be downloaded in
 *   this sandbox; see the header of sqlite-prisma-lite.mjs).
 *
 *   Endpoints:
 *     POST /api/auth/login          (cold + warm, query count, scrypt cost)
 *     GET  /api/auth/me             (warm, query count)
 *     GET  /api/admin/overview      (cold + warm, query count)
 *     GET  /api/teacher/dashboard   (cold + warm, query count)
 *
 *   "cold"  = first invocation of the endpoint in a fresh process (module
 *             init, first SQLite statement compilation, no caches warm).
 *   "warm"  = mean of N invocations after the cold one.
 *
 * WHAT IT DOES *NOT* MEASURE (documented separately in the audit report)
 *   * Vercel function cold starts (infrastructure; no Vercel here).
 *   * Neon network round-trip per query (no Neon access from the sandbox).
 *     The per-endpoint QUERY COUNT this script prints is the multiplier for
 *     Neon latency: warm Neon RTT from an eu-central Vercel function to a
 *     Neon endpoint is typically ~1-5ms per round-trip when warm, and a
 *     cold/idle Neon endpoint adds a one-time wake-up on the first query.
 *   * Client render time (browser).
 *
 * SAFETY: in-memory SQLite only. No network. No production data. Read-only
 * with respect to everything outside this process.
 *
 * Usage: node scripts/bench-post-launch-perf.mjs [--json out.json] [--runs 10]
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import http from "node:http";
import { fileURLToPath } from "node:url";
import Module from "node:module";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const requireCjs = createRequire(import.meta.url);
const REPO = path.join(HERE, "..");

process.env.SECURITY_HASH_SECRET = process.env.SECURITY_HASH_SECRET || "bench-secret-0123456789abcdef0123456789";
process.env.NEXT_PUBLIC_URL = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

const fail = (m) => { console.error(`\n[BENCH-FAIL] ${m}\n`); process.exit(1); };
const envUrl = process.env.DATABASE_URL || "";
if (/postgres|neon/i.test(envUrl)) fail(`Refusing to run with a DATABASE_URL that looks remote: ${envUrl.slice(0, 60)}`);

const RUNS = (() => {
  const i = process.argv.indexOf("--runs");
  return i >= 0 ? Math.max(1, parseInt(process.argv[i + 1], 10) || 10) : 10;
})();
const DUMP_BODIES = process.argv.includes("--dump-bodies");
const JSON_OUT = (() => {
  const i = process.argv.indexOf("--json");
  return i >= 0 ? process.argv[i + 1] : null;
})();

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-bench-"));
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
  "src/lib/session-materials.ts",
  "src/lib/session-notifications.ts",
  "src/lib/progress.ts",
  "src/lib/teacher-content.ts",
  "src/lib/notify.ts",
  "src/lib/notification-links.ts",
  "src/lib/deep-link.ts",
  "src/lib/media.ts",
  "src/lib/official-curriculum.ts",
  "src/lib/curriculum.ts",
  "src/lib/curriculum-visibility.ts",
  "src/lib/admin-sessions.ts",
  "src/lib/teacher-applications.ts",
  "src/app/api/auth/[action]/route.ts",
  "src/app/api/admin/overview/route.ts",
  "src/app/api/teacher/dashboard/route.ts",
];

// ---------------------------------------------------------------------------
// 1. Compile the real handlers
// ---------------------------------------------------------------------------
fs.writeFileSync(path.join(OUT, "tsconfig.json"), JSON.stringify({
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
}));
const tCompileStart = performance.now();
try {
  execFileSync(process.execPath, [requireCjs.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")], { cwd: REPO, stdio: "pipe" });
} catch {}
const EMIT = path.join(OUT, "src");
for (const f of MODULES) {
  const emitted = path.join(OUT, f.replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(emitted)) fail(`missing compiled emit for ${f}`);
}
const compileMs = performance.now() - tCompileStart;

// ---------------------------------------------------------------------------
// 2. Real SQLite (in-memory) + the lite Prisma-compatible client
// ---------------------------------------------------------------------------
const mig = requireCjs(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
const { createSqlitePrisma } = requireCjs(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));
const rawDb = new DatabaseSync(":memory:");
rawDb.exec("PRAGMA foreign_keys = ON");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "bench: " });
const client = createSqlitePrisma({ db: rawDb, schemaPath: path.join(REPO, "prisma/schema.prisma") });

// Query counting: wrap every model delegate method. $transaction passes
// through untouched (the bench endpoints do not use it).
const COUNTER = { active: false, n: 0 };
function withCounting(c) {
  return new Proxy(c, {
    get(target, prop) {
      const v = target[prop];
      if (prop === "$transaction" || prop === "$queryRaw" || prop === "$executeRaw") return v;
      if (v && typeof v === "object") {
        return new Proxy(v, {
          get(t2, p2) {
            const m = t2[p2];
            if (typeof m === "function") {
              return (...args) => {
                if (COUNTER.active) COUNTER.n++;
                return m.apply(t2, args);
              };
            }
            return m;
          },
        });
      }
      return v;
    },
  });
}
globalThis.__CM_DB_CLIENT__ = withCounting(client);

const MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-bench-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_ROOT;
process.env.MEDIA_BACKEND = "local";

// Module shims (same as the phase verifiers).
const dbShim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(dbShim, "module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };");
fs.writeFileSync(path.join(OUT, "__delivery-shim.js"), "module.exports = { sendEmail: async () => ({ delivered: true }) };");
fs.writeFileSync(path.join(OUT, "__next-server-shim.js"), `
class NextResponse {
  constructor(body, init={}) { this.status=init.status??200; this._headers=new Map(); for(const [k,v] of Object.entries(init.headers||{})) this._headers.set(String(k).toLowerCase(), String(v)); this._body=body; this._json=undefined; this._streamBuffer=null; if(body&&typeof body.getReader==='function'){ this._body=null; this._stream=body; } else this._stream=null; }
  static json(data, init={}) { const merged=Object.assign({ 'content-type':'application/json' }, init.headers||{}); const r=new NextResponse(JSON.stringify(data), { status:init.status??200, headers:merged }); r._json=data; return r; }
  get headers(){ const m=this._headers; return { get:(k)=>m.get(String(k).toLowerCase())??null, forEach:(fn)=>m.forEach((v,k)=>fn(v,k)) }; }
  async _drain(){ if(!this._stream) return; const chunks=[]; const reader=this._stream.getReader(); for(;;){ const {done,value}=await reader.read(); if(done) break; chunks.push(Buffer.from(value)); } this._streamBuffer=Buffer.concat(chunks); this._stream=null; }
  async json(){ if(this._json!==undefined) return this._json; if(this._stream){ try{ await this._drain(); }catch{ return null; } } if(this._streamBuffer){ try{ return JSON.parse(this._streamBuffer.toString('utf8')); }catch{ return null; } } try{ return JSON.parse(Buffer.from(this._body||[]).toString('utf8')); }catch{ return null; } }
}
class NextRequest {}
module.exports={ NextResponse, NextRequest };
`);
fs.writeFileSync(path.join(OUT, "__next-headers-shim.js"), `
const parse=()=>{ const ctx=globalThis.__CM_REQ_CTX__||{ cookie:{}, headers:{} }; const store={ get(name){ const v=ctx.cookie?ctx.cookie[name]:undefined; return v===undefined?undefined:{value:v}; }, set(name,value,opts={}){ const jar=globalThis.__CM_RESP_COOKIES__||(globalThis.__CM_RESP_COOKIES__=[]); const parts=[name+'='+value, 'Path='+(opts.path||'/')]; if(opts.httpOnly) parts.push('HttpOnly'); if(opts.sameSite) parts.push('SameSite='+String(opts.sameSite).charAt(0).toUpperCase()+String(opts.sameSite).slice(1)); if(opts.secure) parts.push('Secure'); if(opts.expires) parts.push('Expires='+new Date(opts.expires).toUTCString()); jar.push(parts.join('; ')); if(ctx.cookie) ctx.cookie[name]=value; }, delete(name){ const jar=globalThis.__CM_RESP_COOKIES__||(globalThis.__CM_RESP_COOKIES__=[]); jar.push(name+'=; Path=/; Max-Age=0'); if(ctx.cookie) delete ctx.cookie[name]; } }; return store; };
module.exports={ cookies: async ()=>parse(), headers: async ()=>new Headers((globalThis.__CM_REQ_CTX__||{}).headers||{}) };
`);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return dbShim;
  if (request === "@/lib/delivery") return path.join(OUT, "__delivery-shim.js");
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) { const compiled = path.join(EMIT, "lib", `${m[1]}.js`); if (fs.existsSync(compiled)) return compiled; }
  return originalResolve.call(this, request, ...rest);
};
const route = (p) => { const full = path.join(EMIT, "app", "api", p); if (!fs.existsSync(full)) fail(`route missing ${p}`); return requireCjs(full); };
const Auth = requireCjs(path.join(EMIT, "lib", "auth.js"));
const RouteProtection = requireCjs(path.join(EMIT, "lib", "route-protection.js"));

const parseCookies = (header) => { const out = {}; if (!header) return out; for (const part of header.split(";")) { const idx = part.indexOf("="); if (idx === -1) continue; out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim(); } return out; };
const ROUTES = [
  ["POST", /^\/api\/auth\/([^\/]+)$/, () => route("auth/[action]/route.js").POST, (m) => ({ action: m[1] })],
  ["GET", /^\/api\/auth\/([^\/]+)$/, () => route("auth/[action]/route.js").GET, (m) => ({ action: m[1] })],
  ["GET", /^\/api\/admin\/overview$/, () => route("admin/overview/route.js").GET],
  ["GET", /^\/api\/teacher\/dashboard$/, () => route("teacher/dashboard/route.js").GET],
];

function buildRequest({ method, url, headers, body, cookieHeader }) {
  const parsed = parseCookies(cookieHeader);
  const hdrs = new Headers(Object.fromEntries(Object.entries(headers || {}).filter(([, v]) => typeof v === "string")));
  return {
    url: new URL(url, "http://127.0.0.1").toString(),
    method,
    nextUrl: new URL(url, "http://127.0.0.1"),
    headers: hdrs,
    cookies: { get: (n) => parsed[n] === undefined ? undefined : { value: parsed[n] } },
    json: async () => body,
    text: async () => JSON.stringify(body ?? {}),
    formData: async () => new Map(),
  };
}
async function dispatch({ method, pathname, search, headers, body, cookieHeader }) {
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = { cookie: parseCookies(cookieHeader), headers: { "user-agent": "post-launch-bench", "x-forwarded-for": "198.51.100.9" } };
  const url = `${pathname}${search || ""}`;
  const proxyDecision = RouteProtection.decideApiAccess(pathname, Boolean(parseCookies(cookieHeader).cm_session));
  if (proxyDecision === "deny") return { status: 401, json: { error: "Unauthorized" }, setCookies: [] };
  for (const [m, re, pick, paramsOf] of ROUTES) {
    if (m !== method) continue;
    const match = re.exec(pathname);
    if (!match) continue;
    const handler = pick(match);
    const params = paramsOf ? paramsOf(match) : {};
    const req = buildRequest({ method, url, headers, body, cookieHeader });
    const out = await handler(req, { params: Promise.resolve(params) });
    const setCookies = globalThis.__CM_RESP_COOKIES__ || [];
    let json = null;
    try { json = await out.json(); } catch { json = null; }
    return { status: out.status ?? 200, json, setCookies };
  }
  return { status: 404, json: { error: "not found" }, setCookies: [] };
}
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    let body = {};
    if (req.method !== "GET") { const chunks = []; for await (const c of req) chunks.push(c); const text = Buffer.concat(chunks).toString("utf8"); try { body = text ? JSON.parse(text) : {}; } catch { body = {}; } }
    const out = await dispatch({ method: req.method, pathname: url.pathname, search: url.search, headers: req.headers, body, cookieHeader: req.headers.cookie || "" });
    res.statusCode = out.status;
    res.setHeader("content-type", "application/json");
    if (out.setCookies && out.setCookies.length) res.setHeader("Set-Cookie", out.setCookies);
    res.end(JSON.stringify(out.json ?? null));
  } catch (e) { res.statusCode = 500; res.end(JSON.stringify({ error: "HARNESS_ERROR", detail: String(e.message).slice(0, 300) })); }
});
const BASE = await new Promise((r) => server.listen(0, "127.0.0.1", () => r(`http://127.0.0.1:${server.address().port}`)));
const call = async (method, p, { body, cookie } = {}) => {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { "content-type": "application/json", "user-agent": "post-launch-bench", ...(cookie ? { cookie } : {}) },
    body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  let text = ""; try { text = await res.text(); } catch {}
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
};

/** Timed + query-counted request. */
async function measure(method, p, opts) {
  COUNTER.active = true; COUNTER.n = 0;
  const t0 = performance.now();
  const out = await call(method, p, opts);
  const ms = performance.now() - t0;
  COUNTER.active = false;
  return { ...out, ms, queries: COUNTER.n };
}

// ---------------------------------------------------------------------------
// 3. Fixtures — a realistic small academy
// ---------------------------------------------------------------------------
const NOW = Date.now();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function insertUser(id, email, role, pw, name) {
  rawDb.prepare(`INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt") VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`).run(id, email, Auth.hashPassword(pw), name, role, NOW, NOW);
}
function insertSession(id, userId, token) {
  rawDb.prepare(`INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt","revokedAt") VALUES (?,?,?,?,?,?,?,NULL)`).run(id, userId, sha256(token), "bench-device", NOW, NOW, NOW + 86400000);
}

const ADMIN_PW = "BenchAdminLocal1!";
const TEACHER_PW = "BenchTeacherLocal1!";
insertUser("bench-admin", "bench-admin@local.test", "ADMIN", ADMIN_PW, "Bench Admin");
// NO pre-seeded admin session on purpose: the login benchmark mints one via
// createSession(). A pre-seeded session with a different deviceHash would
// (correctly) trip the single-device conflict suspension.
let ADMIN_COOKIE = "";

insertUser("bench-teacher", "bench-teacher@local.test", "TEACHER", TEACHER_PW, "Bench Teacher");
rawDb.prepare(`INSERT INTO "Teacher" ("id","userId","bio","specialty","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`).run("bench-teacher-row", "bench-teacher", "bio", "AI", NOW, NOW);
insertSession("bench-teacher-session", "bench-teacher", "bench-teacher-raw-token");
const TEACHER_COOKIE = "cm_session=bench-teacher-raw-token";

const Official = requireCjs(path.join(EMIT, "lib", "official-curriculum.js"));
const reconcileStart = performance.now();
await Official.reconcileOfficialCurriculum(client);
const reconcileMs = performance.now() - reconcileStart;
const COURSE_ID = rawDb.prepare(`SELECT "id" FROM "Course" LIMIT 1`).get().id;
const LESSON_IDS = rawDb.prepare(`SELECT "id" FROM "Lesson"`).all().map((r) => r.id);

// Batches
rawDb.prepare(`INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt") VALUES (?,?,?,?,?,1,?,?)`).run("bench-batch-ar", "Arabic Batch", "مجموعة عربي", "ARABIC", COURSE_ID, NOW, NOW);
rawDb.prepare(`INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt") VALUES (?,?,?,?,?,1,?,?)`).run("bench-batch-lang", "Language Batch", "مجموعة لغات", "LANGUAGE", COURSE_ID, NOW, NOW);

// Groups (both assigned to the bench teacher, like production)
rawDb.prepare(`INSERT INTO "Group" ("id","name","courseId","teacherId","capacity","schedule","isActive","trackScope","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)`).run("bench-group-ar", "Group AR", COURSE_ID, "bench-teacher-row", 30, "Sat 6pm", 1, "ARABIC", NOW, NOW);
rawDb.prepare(`INSERT INTO "Group" ("id","name","courseId","teacherId","capacity","schedule","isActive","trackScope","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)`).run("bench-group-lang", "Group LANG", COURSE_ID, "bench-teacher-row", 30, "Tue 6pm", 1, "LANGUAGE", NOW, NOW);

// Subscription plan + subscriptions
rawDb.prepare(`INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","isActive","createdAt") VALUES (?,?,?,?,?,0,1,?)`).run("bench-plan", "Regular", "عادي", 6, 1200, NOW);

// 40 students: 25 ARABIC (group ar), 15 LANGUAGE (group lang)
const studentIds = [];
for (let i = 0; i < 40; i++) {
  const uid = `bench-stu-${i}`;
  const sid = `bench-stu-row-${i}`;
  const isAr = i < 25;
  insertUser(uid, `bench-stu-${i}@local.test`, "STUDENT", "BenchStudent1!", `Student ${i}`);
  rawDb.prepare(`INSERT INTO "Student" ("id","userId","grade","schoolName","schoolType","groupId","batchId","enrolledAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(sid, uid, "2nd Secondary", "Bench School", isAr ? "ARABIC" : "LANGUAGE", isAr ? "bench-group-ar" : "bench-group-lang", isAr ? "bench-batch-ar" : "bench-batch-lang", NOW, NOW, NOW);
  studentIds.push({ uid, sid, isAr });
  if (i % 2 === 0) {
    rawDb.prepare(`INSERT INTO "Subscription" ("id","studentId","planId","status","startDate","endDate","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)`)
      .run(`bench-sub-${i}`, sid, "bench-plan", "ACTIVE", NOW - 86400000 * 30, NOW + 86400000 * 150, NOW, NOW);
  }
}

// LiveSessions: 2 upcoming (SCHEDULED) + 2 past (COMPLETED) with attendance
const sessionRows = [
  { id: "bench-ls-1", group: "bench-group-ar", start: NOW + 86400000, status: "SCHEDULED" },
  { id: "bench-ls-2", group: "bench-group-lang", start: NOW + 3 * 86400000, status: "SCHEDULED" },
  { id: "bench-ls-3", group: "bench-group-ar", start: NOW - 7 * 86400000, status: "COMPLETED" },
  { id: "bench-ls-4", group: "bench-group-lang", start: NOW - 14 * 86400000, status: "COMPLETED" },
];
for (const s of sessionRows) {
  rawDb.prepare(`INSERT INTO "LiveSession" ("id","groupId","teacherId","lessonId","title","titleAr","startAt","duration","status","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(s.id, s.group, "bench-teacher-row", null, `Session ${s.id}`, `حصة ${s.id}`, s.start, 120, s.status, NOW);
}
let attN = 0;
for (const s of sessionRows.filter((x) => x.status === "COMPLETED")) {
  for (const st of studentIds) {
    if ((s.group === "bench-group-ar") !== st.isAr) continue;
    const status = attN % 7 === 0 ? "ABSENT" : attN % 5 === 0 ? "LATE" : "PRESENT";
    rawDb.prepare(`INSERT INTO "Attendance" ("id","studentId","sessionId","status","createdAt") VALUES (?,?,?,?,?)`)
      .run(`bench-att-${attN++}`, st.sid, s.id, status, NOW);
  }
}

// Quiz + attempts (graded history for the teacher dashboard)
const QUIZ_LESSON = LESSON_IDS[0];
rawDb.prepare(`INSERT INTO "Quiz" ("id","lessonId","trackScope","title","titleAr","passMark","order","quizMode","maxAttempts","shuffleOptions") VALUES (?,?,?,?,?,?,?,'FIXED',1,0)`)
  .run("bench-quiz-1", QUIZ_LESSON, "SHARED", "Bench Quiz", "كويز البنش", 60, 1);
let qa = 0;
for (const st of studentIds.slice(0, 30)) {
  const pct = 40 + (qa * 7) % 61;
  rawDb.prepare(`INSERT INTO "QuizAttempt" ("id","quizId","studentId","score","totalMarks","percentage","passed","startedAt","finishedAt","cameraStatus","attemptNumber","status") VALUES (?,?,?,?,?,?,?,?,?,'NOT_REQUESTED',1,'SUBMITTED')`)
    .run(`bench-qa-${qa}`, "bench-quiz-1", st.sid, pct, 100, pct, pct >= 60 ? 1 : 0, NOW - 86400000 * (qa % 10), NOW - 86400000 * (qa % 10) + 600000);
  qa++;
}

// Homework + submissions (some pending grading)
rawDb.prepare(`INSERT INTO "Homework" ("id","lessonId","trackScope","title","titleAr","deadline","maxMarks","createdAt") VALUES (?,?,?,?,?,?,?,?)`)
  .run("bench-hw-1", QUIZ_LESSON, "SHARED", "HW", "واجب", NOW + 86400000 * 3, 10, NOW);
let hs = 0;
for (const st of studentIds.slice(0, 25)) {
  const graded = hs % 3 !== 0;
  rawDb.prepare(`INSERT INTO "HomeworkSubmission" ("id","homeworkId","studentId","content","submittedAt","grade","status") VALUES (?,?,?,?,?,?,?)`)
    .run(`bench-hs-${hs}`, "bench-hw-1", st.sid, "answer", NOW - 3600000 * (hs + 1), graded ? 8 : null, graded ? "GRADED" : (hs % 2 ? "SUBMITTED" : "PENDING"));
  hs++;
}

// Payments: ~180 rows spread over the last 6 months (admin overview trend)
const METHODS = ["INSTAPAY", "VODAFONE_CASH", "ETISALAT_CASH"];
let payN = 0;
for (let m = 5; m >= 0; m--) {
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth() - m, 1).getTime();
  for (let k = 0; k < 30; k++) {
    const st = studentIds[(m * 5 + k) % studentIds.length];
    const status = k % 9 === 0 ? "PENDING" : "APPROVED";
    rawDb.prepare(`INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)`)
      .run(`bench-pay-${payN++}`, st.uid, null, 500 + (k % 5) * 250, METHODS[k % METHODS.length], status, monthStart + k * 3600000 * 20, monthStart + k * 3600000 * 20);
  }
}

// ---------------------------------------------------------------------------
// 4. Measurements
// ---------------------------------------------------------------------------
const results = {
  environment: {
    node: process.version,
    harness: "compiled-route-handlers + sqlite-prisma-lite (in-memory SQLite)",
    warmRuns: RUNS,
    compiledModules: MODULES.length,
    tscCompileMs: Math.round(compileMs),
    curriculumReconcileMs: Math.round(reconcileMs),
    fixtureCounts: {
      students: studentIds.length,
      liveSessions: sessionRows.length,
      attendance: attN,
      quizAttempts: qa,
      homeworkSubmissions: hs,
      payments: payN,
      lessons: LESSON_IDS.length,
    },
  },
  scrypt: {},
  endpoints: {},
};

// 4.1 Password hashing cost (login's CPU-bound part; NOT a bottleneck to
// "fix" — it is the security parameter, measured for attribution only).
{
  const hash = Auth.hashPassword("measure-me-123");
  const t0 = performance.now();
  Auth.hashPassword("measure-me-123");
  results.scrypt.hashOnceMs = +(performance.now() - t0).toFixed(1);
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t = performance.now();
    Auth.verifyPassword("measure-me-123", hash);
    times.push(performance.now() - t);
  }
  results.scrypt.verifyAvgMs = +(times.reduce((a, b) => a + b, 0) / times.length).toFixed(1);
}

async function bench(name, method, p, opts) {
  const cold = await measure(method, p, opts);
  if (cold.status >= 400) fail(`${name}: unexpected status ${cold.status} ${JSON.stringify(cold.json).slice(0, 200)}`);
  const warm = [];
  for (let i = 0; i < RUNS; i++) warm.push(await measure(method, p, opts));
  const mss = warm.map((w) => w.ms).sort((a, b) => a - b);
  const avg = mss.reduce((a, b) => a + b, 0) / mss.length;
  results.endpoints[name] = {
    coldMs: +cold.ms.toFixed(1),
    coldQueries: cold.queries,
    warmAvgMs: +avg.toFixed(1),
    warmMinMs: +mss[0].toFixed(1),
    warmMaxMs: +mss[mss.length - 1].toFixed(1),
    warmQueriesPerRequest: warm[0].queries,
    responseBytes: JSON.stringify(cold.json ?? {}).length,
  };
  if (DUMP_BODIES) {
    results.bodies = results.bodies || {};
    results.bodies[name] = cold.json;
  }
  return cold;
}

console.log("[bench] login (cold then warm)…");
await bench("POST /api/auth/login (admin)", "POST", "/api/auth/login", {
  body: { email: "bench-admin@local.test", password: ADMIN_PW },
});
{
  // Every login rotates the same-device token, so the cookie from the cold
  // run is superseded by the warm runs. Mint ONE final session for the
  // cookie-dependent benches (not itself measured).
  const fresh = await call("POST", "/api/auth/login", {
    body: { email: "bench-admin@local.test", password: ADMIN_PW },
  });
  const m = /cm_session=([^;]+)/.exec(String(fresh.setCookie || ""));
  if (!m) fail("login did not set a cm_session cookie: " + JSON.stringify(fresh.setCookie));
  ADMIN_COOKIE = `cm_session=${m[1]}`;
}
console.log("[bench] auth/me…");
await bench("GET /api/auth/me (admin session)", "GET", "/api/auth/me", { cookie: ADMIN_COOKIE });
console.log("[bench] admin overview…");
await bench("GET /api/admin/overview", "GET", "/api/admin/overview", { cookie: ADMIN_COOKIE });
console.log("[bench] teacher dashboard…");
await bench("GET /api/teacher/dashboard", "GET", "/api/teacher/dashboard", { cookie: TEACHER_COOKIE });

server.close();

console.log("\n================ POST-LAUNCH PERF BENCH ================");
console.log(JSON.stringify(results, null, 2));
if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(results, null, 2));
  console.log(`\n[bench] written to ${JSON_OUT}`);
}
console.log("[bench] DONE");
process.exit(0);
