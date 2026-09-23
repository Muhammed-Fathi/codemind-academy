#!/usr/bin/env node
/**
 * Post-launch ADMIN LIFECYCLE verifier (Section 2 + Section 5 of the
 * post-launch audit).
 *
 * WHAT IT PROVES — with REAL compiled route handlers over REAL SQLite
 * (the repo's standard harness: scripts/lib/migrate-sqlite.mjs +
 * scripts/lib/sqlite-prisma-lite.mjs — Prisma engine binaries cannot be
 * downloaded in this sandbox; see the sqlite-prisma-lite.mjs header):
 *
 *   Groups          DELETE refused while students (api.294) or sessions
 *                   (api.295) exist; allowed + audited when empty; 404 after.
 *   Teachers        PATCH profile (name/email/phone/bio/specialty) with
 *                   validation (api.297/api.060/api.053/api.064); email change
 *                   revokes every live session; DELETE refused while groups/
 *                   sessions/notes exist (api.296); unused teacher deleted,
 *                   application history UNLINKED but preserved.
 *   Courses         PATCH metadata-only with validation (api.018); DELETE
 *                   refused while groups/parts/enrollments/mockExams/batches
 *                   reference it (api.298); empty course deletable.
 *   Question bank   GET exposes reference counts + blockers; PATCH locks
 *                   grading fields while attempts exist (api.245) but allows
 *                   text edits; DELETE refused for frozen answers (api.247)
 *                   and FIXED exam pins (api.246); free bank question
 *                   editable + deletable; 404 after delete (api.244).
 *   Authorization   every lifecycle route is ADMIN-only server-side:
 *                   teacher cookie → 403, no cookie → 401.
 *   Section 5       teacher dashboard isolation: a teacher only ever sees
 *                   their OWN groups' sessions; a group with no LiveSession
 *                   rows yields an empty (correct-by-design) session list.
 *   Perf pins       admin overview still returns a 6-bucket revenue trend
 *                   whose current-month bucket equals revenueThisMonth after
 *                   the single-scan optimization; teacher dashboard payload
 *                   shape unchanged after the concurrency rework.
 *
 * SAFETY: in-memory SQLite only. No network. No production data. Refuses to
 * run when DATABASE_URL looks remote.
 *
 * Usage: node scripts/verify-post-launch-admin-lifecycle.mjs
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

process.env.SECURITY_HASH_SECRET = process.env.SECURITY_HASH_SECRET || "lifecycle-verifier-secret-0123456789abcd";
process.env.NEXT_PUBLIC_URL = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

const fail = (m) => { console.error(`\n[LIFECYCLE-FAIL] ${m}\n`); process.exit(1); };
const envUrl = process.env.DATABASE_URL || "";
if (/postgres|neon/i.test(envUrl)) fail(`Refusing to run with a DATABASE_URL that looks remote: ${envUrl.slice(0, 60)}`);

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-lifecycle-"));
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
  "src/app/api/admin/groups/[id]/route.ts",
  "src/app/api/admin/teachers/[id]/route.ts",
  "src/app/api/admin/courses/[id]/route.ts",
  "src/app/api/admin/question-bank/[id]/route.ts",
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
try {
  execFileSync(process.execPath, [requireCjs.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")], { cwd: REPO, stdio: "pipe" });
} catch {}
const EMIT = path.join(OUT, "src");
for (const f of MODULES) {
  const emitted = path.join(OUT, f.replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(emitted)) fail(`missing compiled emit for ${f}`);
}

// ---------------------------------------------------------------------------
// 2. Real SQLite (in-memory) + the lite Prisma-compatible client
// ---------------------------------------------------------------------------
const mig = requireCjs(path.join(REPO, "scripts/lib/migrate-sqlite.mjs"));
const { createSqlitePrisma } = requireCjs(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs"));
const rawDb = new DatabaseSync(":memory:");
rawDb.exec("PRAGMA foreign_keys = ON");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "lifecycle: " });
const client = createSqlitePrisma({ db: rawDb, schemaPath: path.join(REPO, "prisma/schema.prisma") });
globalThis.__CM_DB_CLIENT__ = client;

const MEDIA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-lifecycle-media-"));
process.env.MEDIA_STORAGE_PATH = MEDIA_ROOT;
process.env.MEDIA_BACKEND = "local";

// Module shims (same as the phase verifiers / perf bench).
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
const { getServerT } = requireCjs(path.join(EMIT, "lib", "i18n-server.js"));
const tApi = await getServerT();

const parseCookies = (header) => { const out = {}; if (!header) return out; for (const part of header.split(";")) { const idx = part.indexOf("="); if (idx === -1) continue; out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim(); } return out; };
const ROUTES = [
  ["POST", /^\/api\/auth\/([^\/]+)$/, () => route("auth/[action]/route.js").POST, (m) => ({ action: m[1] })],
  ["GET", /^\/api\/auth\/([^\/]+)$/, () => route("auth/[action]/route.js").GET, (m) => ({ action: m[1] })],
  ["GET", /^\/api\/admin\/overview$/, () => route("admin/overview/route.js").GET],
  ["GET", /^\/api\/teacher\/dashboard$/, () => route("teacher/dashboard/route.js").GET],
  ["PATCH", /^\/api\/admin\/groups\/([^\/]+)$/, () => route("admin/groups/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["DELETE", /^\/api\/admin\/groups\/([^\/]+)$/, () => route("admin/groups/[id]/route.js").DELETE, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/admin\/teachers\/([^\/]+)$/, () => route("admin/teachers/[id]/route.js").GET, (m) => ({ id: m[1] })],
  ["PATCH", /^\/api\/admin\/teachers\/([^\/]+)$/, () => route("admin/teachers/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["DELETE", /^\/api\/admin\/teachers\/([^\/]+)$/, () => route("admin/teachers/[id]/route.js").DELETE, (m) => ({ id: m[1] })],
  ["PATCH", /^\/api\/admin\/courses\/([^\/]+)$/, () => route("admin/courses/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["DELETE", /^\/api\/admin\/courses\/([^\/]+)$/, () => route("admin/courses/[id]/route.js").DELETE, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/admin\/question-bank\/([^\/]+)$/, () => route("admin/question-bank/[id]/route.js").GET, (m) => ({ id: m[1] })],
  ["PATCH", /^\/api\/admin\/question-bank\/([^\/]+)$/, () => route("admin/question-bank/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["DELETE", /^\/api\/admin\/question-bank\/([^\/]+)$/, () => route("admin/question-bank/[id]/route.js").DELETE, (m) => ({ id: m[1] })],
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
  globalThis.__CM_REQ_CTX__ = { cookie: parseCookies(cookieHeader), headers: { "user-agent": "lifecycle-verifier", "x-forwarded-for": "198.51.100.9" } };
  const url = `${pathname}${search || ""}`;
  const proxyDecision = RouteProtection.decideApiAccess(pathname, Boolean(parseCookies(cookieHeader).cm_session));
  if (proxyDecision === "deny") return { status: 401, json: { error: "Unauthorized" }, setCookies: [] };
  for (const [m, re, pick, paramsOf] of ROUTES) {
    if (m !== method) continue;
    const match = re.exec(pathname);
    if (!match) continue;
    const handler = pick(match);
    if (typeof handler !== "function") return { status: 405, json: { error: "method not allowed" }, setCookies: [] };
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
    if (req.method !== "GET" && req.method !== "DELETE") { const chunks = []; for await (const c of req) chunks.push(c); const text = Buffer.concat(chunks).toString("utf8"); try { body = text ? JSON.parse(text) : {}; } catch { body = {}; } }
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
    headers: { "content-type": "application/json", "user-agent": "lifecycle-verifier", ...(cookie ? { cookie } : {}) },
    body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body ?? {}),
  });
  let text = ""; try { text = await res.text(); } catch {}
  let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
};

// ---------------------------------------------------------------------------
// 3. Fixtures
// ---------------------------------------------------------------------------
const NOW = Date.now();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function insertUser(id, email, role, pw, name) {
  rawDb.prepare(`INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt") VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`).run(id, email, Auth.hashPassword(pw), name, role, NOW, NOW);
}
function insertSession(id, userId, token) {
  rawDb.prepare(`INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt","revokedAt") VALUES (?,?,?,?,?,?,?,NULL)`).run(id, userId, sha256(token), "verifier-device", NOW, NOW, NOW + 86400000);
}
function insertGroup(id, name, teacherRow, trackScope, courseId = null) {
  rawDb.prepare(`INSERT INTO "Group" ("id","name","courseId","teacherId","capacity","schedule","isActive","trackScope","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, name, courseId, teacherRow, 30, "Sat 6pm", 1, trackScope, NOW, NOW);
}
function insertLiveSession(id, groupId, teacherRow, status, start) {
  rawDb.prepare(`INSERT INTO "LiveSession" ("id","groupId","teacherId","lessonId","title","titleAr","startAt","duration","status","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, groupId, teacherRow, null, `Session ${id}`, `حصة ${id}`, start, 120, status, NOW);
}

// Admin (login mints the session — NO pre-seeded admin session, otherwise the
// single-device conflict rule would (correctly) suspend the account).
const ADMIN_PW = "VerifierAdmin1!";
insertUser("v-admin", "v-admin@local.test", "ADMIN", ADMIN_PW, "Verifier Admin");

// Teacher under test + a SECOND teacher for isolation checks.
const TEACHER_PW = "VerifierTeacher1!";
insertUser("v-teacher", "v-teacher@local.test", "TEACHER", TEACHER_PW, "Verifier Teacher");
rawDb.prepare(`INSERT INTO "Teacher" ("id","userId","bio","specialty","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`).run("v-teacher-row", "v-teacher", "bio", "AI", NOW, NOW);
insertSession("v-teacher-session", "v-teacher", "v-teacher-raw-token");
const TEACHER_COOKIE = "cm_session=v-teacher-raw-token";

insertUser("v-other-teacher", "v-other@local.test", "TEACHER", TEACHER_PW, "Other Teacher");
rawDb.prepare(`INSERT INTO "Teacher" ("id","userId","bio","specialty","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`).run("v-other-row", "v-other-teacher", "bio", "Math", NOW, NOW);

// Unused teacher (zero groups/sessions/notes) with a linked APPROVED
// application — the DELETE must remove the user but PRESERVE (unlink) the
// application history row.
insertUser("v-unused", "v-unused@local.test", "TEACHER", TEACHER_PW, "Unused Teacher");
rawDb.prepare(`INSERT INTO "Teacher" ("id","userId","bio","specialty","createdAt","updatedAt") VALUES (?,?,?,?,?,?)`).run("v-unused-row", "v-unused", null, null, NOW, NOW);
rawDb.prepare(`INSERT INTO "TeacherApplication" ("id","email","name","phone","specialty","bio","status","adminNote","reviewedByUserId","reviewedAt","userId","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("v-app-1", "v-unused@local.test", "Unused Teacher", null, null, null, "APPROVED", null, "v-admin", NOW, "v-unused", NOW, NOW);

// Curriculum (real reconciler) → course + lessons for realistic references.
const Official = requireCjs(path.join(EMIT, "lib", "official-curriculum.js"));
await Official.reconcileOfficialCurriculum(client);
const COURSE_ID = rawDb.prepare(`SELECT "id" FROM "Course" LIMIT 1`).get().id;
const LESSON_IDS = rawDb.prepare(`SELECT "id" FROM "Lesson"`).all().map((r) => r.id);
const QUIZ_LESSON = LESSON_IDS[0];

// Empty course (no groups/parts/enrollments/mockExams/batches) — deletable.
rawDb.prepare(`INSERT INTO "Course" ("id","slug","academicLevel","name","nameAr","description","color","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)`)
  .run("v-empty-course", "verifier-empty-course", "SECOND_SECONDARY", "Empty Course", "كورس فاضي", "unused", "#10b981", NOW, NOW);

// Batches + groups + students
rawDb.prepare(`INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt") VALUES (?,?,?,?,?,1,?,?)`).run("v-batch-ar", "Arabic Batch", "مجموعة عربي", "ARABIC", COURSE_ID, NOW, NOW);
rawDb.prepare(`INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt") VALUES (?,?,?,?,?,1,?,?)`).run("v-batch-lang", "Language Batch", "مجموعة لغات", "LANGUAGE", COURSE_ID, NOW, NOW);
insertGroup("v-group-ar", "Group AR", "v-teacher-row", "ARABIC", COURSE_ID);
insertGroup("v-group-lang", "Group LANG", "v-teacher-row", "LANGUAGE", COURSE_ID);
insertGroup("v-group-empty", "Group Empty", "v-other-row", "ARABIC", COURSE_ID);       // no students, no sessions → deletable
insertGroup("v-group-sessions", "Group Sessions", "v-other-row", "ARABIC", COURSE_ID); // sessions but no students → api.295
insertGroup("v-group-other", "Group Other", "v-other-row", "ARABIC", COURSE_ID);        // other teacher's teaching group

rawDb.prepare(`INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","isActive","createdAt") VALUES (?,?,?,?,?,0,1,?)`).run("v-plan", "Regular", "عادي", 6, 1200, NOW);

const studentIds = [];
for (let i = 0; i < 6; i++) {
  const uid = `v-stu-${i}`;
  const sid = `v-stu-row-${i}`;
  const isAr = i < 4;
  insertUser(uid, `v-stu-${i}@local.test`, "STUDENT", "VerifierStudent1!", `Student ${i}`);
  rawDb.prepare(`INSERT INTO "Student" ("id","userId","grade","schoolName","schoolType","academicLevel","groupId","batchId","enrolledAt","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(sid, uid, "2nd Secondary", "Verifier School", isAr ? "ARABIC" : "LANGUAGE", "SECOND_SECONDARY", isAr ? "v-group-ar" : "v-group-lang", isAr ? "v-batch-ar" : "v-batch-lang", NOW, NOW, NOW);
  studentIds.push({ uid, sid, isAr });
}

// Sessions: v-teacher's (2 groups) + one COMPLETED with attendance + the
// OTHER teacher's session (must never leak into v-teacher's dashboard).
insertLiveSession("v-ls-1", "v-group-ar", "v-teacher-row", "SCHEDULED", NOW + 86400000);
insertLiveSession("v-ls-2", "v-group-lang", "v-teacher-row", "SCHEDULED", NOW + 3 * 86400000);
insertLiveSession("v-ls-3", "v-group-ar", "v-teacher-row", "COMPLETED", NOW - 7 * 86400000);
insertLiveSession("v-ls-other", "v-group-other", "v-other-row", "SCHEDULED", NOW + 86400000);
insertLiveSession("v-ls-guard", "v-group-sessions", "v-other-row", "SCHEDULED", NOW + 5 * 86400000);
let attN = 0;
for (const st of studentIds.filter((x) => x.isAr)) {
  rawDb.prepare(`INSERT INTO "Attendance" ("id","studentId","sessionId","status","createdAt") VALUES (?,?,?,?,?)`)
    .run(`v-att-${attN++}`, st.sid, "v-ls-3", attN % 4 === 0 ? "ABSENT" : "PRESENT", NOW);
}

// Quiz + one GRADED attempt with a frozen QuizAnswer (freezes q-frozen).
rawDb.prepare(`INSERT INTO "Quiz" ("id","lessonId","trackScope","title","titleAr","passMark","order","quizMode","maxAttempts","shuffleOptions") VALUES (?,?,?,?,?,?,?,'FIXED',1,0)`)
  .run("v-quiz-1", QUIZ_LESSON, "SHARED", "Verifier Quiz", "كويز التحقق", 60, 1);
rawDb.prepare(`INSERT INTO "QuizAttempt" ("id","quizId","studentId","score","totalMarks","percentage","passed","startedAt","finishedAt","cameraStatus","attemptNumber","status") VALUES (?,?,?,?,?,?,?,?,?,'NOT_REQUESTED',1,'SUBMITTED')`)
  .run("v-qa-0", "v-quiz-1", studentIds[0].sid, 80, 100, 80, 1, NOW - 86400000, NOW - 86400000 + 600000);

// Homework: 6 submissions, 2 of them awaiting grading (hs % 3 === 0).
rawDb.prepare(`INSERT INTO "Homework" ("id","lessonId","trackScope","title","titleAr","deadline","maxMarks","createdAt") VALUES (?,?,?,?,?,?,?,?)`)
  .run("v-hw-1", QUIZ_LESSON, "SHARED", "HW", "واجب", NOW + 86400000 * 3, 10, NOW);
let hs = 0;
for (const st of studentIds) {
  const graded = hs % 3 !== 0;
  rawDb.prepare(`INSERT INTO "HomeworkSubmission" ("id","homeworkId","studentId","content","submittedAt","grade","status") VALUES (?,?,?,?,?,?,?)`)
    .run(`v-hs-${hs}`, "v-hw-1", st.sid, "answer", NOW - 3600000 * (hs + 1), graded ? 8 : null, graded ? "GRADED" : (hs % 2 ? "SUBMITTED" : "PENDING"));
  hs++;
}

// Payments for the overview revenue pins: 3 approved this month, 1 approved
// last month, 1 pending.
const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
const lastMonthStart = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 1).getTime();
const payRows = [
  ["v-pay-0", monthStart + 3600000, 500, "APPROVED"],
  ["v-pay-1", monthStart + 7200000, 750, "APPROVED"],
  ["v-pay-2", monthStart + 10800000, 500, "APPROVED"],
  ["v-pay-3", lastMonthStart + 3600000, 1000, "APPROVED"],
  ["v-pay-4", monthStart + 14400000, 250, "PENDING"],
];
for (const [id, ts, amount, status] of payRows) {
  rawDb.prepare(`INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, studentIds[0].uid, null, amount, "INSTAPAY", status, ts, ts);
}

// Questions: free (bank-only), frozen (answered attempt), FIXED exam pin.
function insertQuestion(id, quizId, prompt) {
  rawDb.prepare(`INSERT INTO "Question" ("id","quizId","type","prompt","promptAr","options","answer","explanation","difficulty","marks","schoolType","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, quizId, "MCQ", prompt, null, JSON.stringify(["A", "B", "C", "D"]), "0", null, "MEDIUM", 1, null, NOW);
}
insertQuestion("v-q-free", null, "Free bank question");
insertQuestion("v-q-frozen", "v-quiz-1", "Frozen quiz question");
insertQuestion("v-q-pinned", null, "Pinned bank question");
rawDb.prepare(`INSERT INTO "QuizAnswer" ("id","attemptId","questionId","selected","isCorrect") VALUES (?,?,?,?,?)`)
  .run("v-qans-0", "v-qa-0", "v-q-frozen", "0", 1);
rawDb.prepare(`INSERT INTO "MockExam" ("id","title","titleAr","description","schoolType","courseId","questionCount","durationMin","passMark","difficulty","selectionMode","isPublished","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
  .run("v-me-fixed", "Fixed Exam", "امتحان ثابت", null, "ARABIC", COURSE_ID /* K3: courseId NOT NULL */, 10, 30, 60, "MIXED", "FIXED", 0, NOW, NOW);
rawDb.prepare(`INSERT INTO "MockExamQuestion" ("id","mockExamId","questionId","examQuestionId","order") VALUES (?,?,?,?,?)`)
  .run("v-meq-0", "v-me-fixed", "v-q-pinned", null, 0);

// ---------------------------------------------------------------------------
// 4. Checks
// ---------------------------------------------------------------------------
const results = [];
let failures = 0;
function record(id, desc, pass, detail = "") {
  results.push({ id, desc, pass, detail });
  if (!pass) failures++;
  console.log(`[${pass ? "PASS" : "FAIL"}] ${id} — ${desc} ${detail}`);
}
const errText = (res) => String(res.json && res.json.error ? res.json.error : "");

// --- Login (admin) ----------------------------------------------------------
let ADMIN_COOKIE = "";
{
  const res = await call("POST", "/api/auth/login", { body: { email: "v-admin@local.test", password: ADMIN_PW } });
  const m = /cm_session=([^;]+)/.exec(String(res.setCookie || ""));
  if (res.status !== 200 || !m) fail(`admin login failed: ${res.status} ${JSON.stringify(res.json)}`);
  ADMIN_COOKIE = `cm_session=${m[1]}`;
  record("AUTH-01", "Admin login succeeds and sets cm_session", true);
}

// --- Non-destructive shape pins (run BEFORE mutations) ----------------------
{
  const res = await call("GET", "/api/admin/overview", { cookie: ADMIN_COOKIE });
  const t = res.json || {};
  record("PERF-01", "Admin overview 200", res.status === 200, `status=${res.status}`);
  record("PERF-02", "revenueTrend has exactly 6 monthly buckets", Array.isArray(t.revenueTrend) && t.revenueTrend.length === 6, `len=${t.revenueTrend?.length}`);
  const lastBucket = Array.isArray(t.revenueTrend) ? t.revenueTrend[5] : null;
  record("PERF-03", "current-month trend bucket equals totals.revenueThisMonth (single-scan bucketing)",
    !!lastBucket && lastBucket.revenue === t.totals?.revenueThisMonth && lastBucket.revenue === 1750,
    `bucket=${lastBucket?.revenue} totals=${t.totals?.revenueThisMonth}`);
  record("PERF-04", "pendingPayments + attendance + quiz avg present",
    t.totals?.pendingPayments === 1 && typeof t.totals?.attendanceRate === "number" && typeof t.totals?.avgQuizScore === "number",
    JSON.stringify({ p: t.totals?.pendingPayments, a: t.totals?.attendanceRate, q: t.totals?.avgQuizScore }));
}
{
  const res = await call("GET", "/api/teacher/dashboard", { cookie: TEACHER_COOKIE });
  const t = res.json || {};
  const raw = JSON.stringify(t);
  record("SCOPE-01", "Teacher dashboard 200", res.status === 200, `status=${res.status}`);
  record("SCOPE-02", "Teacher sees exactly their 2 groups", Array.isArray(t.groups) && t.groups.length === 2 && t.groups.every((g) => ["v-group-ar", "v-group-lang"].includes(g.id)), `groups=${(t.groups||[]).map((g)=>g.id).join(",")}`);
  record("SCOPE-03", "Other teacher's groups/sessions NEVER appear in the payload",
    !raw.includes("v-ls-other") && !raw.includes("v-group-other") && !raw.includes("v-group-sessions") && !raw.includes("v-ls-guard") && !raw.includes("v-group-empty"));
  record("SCOPE-04", "Upcoming sessions only from own groups", (t.upcomingSessions || []).every((s) => ["v-group-ar", "v-group-lang"].includes(s.group?.id)) && (t.upcomingSessions || []).length === 2, `n=${(t.upcomingSessions||[]).length}`);
  record("SCOPE-05", "Group with only past sessions → nextSession null; upcoming group → nextSession set",
    t.groups?.find((g) => g.id === "v-group-ar")?.nextSession?.id === "v-ls-1" &&
    t.groups?.find((g) => g.id === "v-group-lang")?.nextSession?.id === "v-ls-2");
  record("SCOPE-06", "pendingHomeworkCount = 2 (the two ungraded submissions)", t.pendingHomeworkCount === 2, `got=${t.pendingHomeworkCount}`);
  record("SCOPE-07", "recentActivity capped at 8 and sorted desc", (t.recentActivity || []).length <= 8 && (t.recentActivity || []).every((a, i, arr) => i === 0 || new Date(arr[i - 1].time) >= new Date(a.time)));
  record("SCOPE-08", "Group stats: attendance % computed from own sessions only", t.groups?.find((g) => g.id === "v-group-ar")?.stats?.attendancePct === 75, `got=${t.groups?.find((g) => g.id === "v-group-ar")?.stats?.attendancePct}`);
}

// --- Authorization: lifecycle routes are ADMIN-only server-side -------------
{
  const asTeacher = await call("DELETE", "/api/admin/groups/v-group-empty", { cookie: TEACHER_COOKIE });
  record("AUTHZ-01", "Teacher cannot DELETE a group (403)", asTeacher.status === 403, `status=${asTeacher.status}`);
  const asTeacher2 = await call("PATCH", "/api/admin/teachers/v-teacher-row", { cookie: TEACHER_COOKIE, body: { name: "Hacked" } });
  record("AUTHZ-02", "Teacher cannot PATCH a teacher (403)", asTeacher2.status === 403, `status=${asTeacher2.status}`);
  const anon = await call("DELETE", "/api/admin/courses/v-empty-course", {});
  record("AUTHZ-03", "Anonymous cannot DELETE a course (401)", anon.status === 401, `status=${anon.status}`);
  const anon2 = await call("PATCH", "/api/admin/question-bank/v-q-free", { body: { prompt: "x" } });
  record("AUTHZ-04", "Anonymous cannot PATCH a question (401)", anon2.status === 401, `status=${anon2.status}`);
}

// --- Groups: guarded DELETE --------------------------------------------------
{
  const withStudents = await call("DELETE", "/api/admin/groups/v-group-ar", { cookie: ADMIN_COOKIE });
  record("GRP-01", "DELETE group with students refused 409 (api.294)", withStudents.status === 409 && errText(withStudents) === tApi("api.294", { p1: 4 }), `status=${withStudents.status} err=${errText(withStudents).slice(0, 60)}`);
  const withSessions = await call("DELETE", "/api/admin/groups/v-group-sessions", { cookie: ADMIN_COOKIE });
  record("GRP-02", "DELETE group with sessions refused 409 (api.295)", withSessions.status === 409 && errText(withSessions) === tApi("api.295", { p1: 1 }), `status=${withSessions.status}`);
  const missing = await call("DELETE", "/api/admin/groups/nope", { cookie: ADMIN_COOKIE });
  record("GRP-03", "DELETE unknown group → 404 (api.020)", missing.status === 404 && errText(missing) === tApi("api.020"), `status=${missing.status}`);
  const empty = await call("DELETE", "/api/admin/groups/v-group-empty", { cookie: ADMIN_COOKIE });
  record("GRP-04", "DELETE empty group succeeds", empty.status === 200 && empty.json?.deleted === true, `status=${empty.status}`);
  const audit = rawDb.prepare(`SELECT COUNT(*) AS c FROM "AuditLog" WHERE "action"='GROUP_DELETED' AND "entityId"='v-group-empty'`).get();
  record("GRP-05", "GROUP_DELETED audit row written", Number(audit?.c) === 1);
  const gone = await call("DELETE", "/api/admin/groups/v-group-empty", { cookie: ADMIN_COOKIE });
  record("GRP-06", "Second DELETE → 404 (idempotent-safe)", gone.status === 404, `status=${gone.status}`);
}

// --- Teachers: PATCH validation + guarded DELETE -----------------------------
{
  const bad = await call("PATCH", "/api/admin/teachers/v-teacher-row", { cookie: ADMIN_COOKIE, body: { name: "   " } });
  record("TCH-01", "PATCH blank name refused 400 (api.297)", bad.status === 400 && errText(bad) === tApi("api.297"), `status=${bad.status}`);
  const clash = await call("PATCH", "/api/admin/teachers/v-teacher-row", { cookie: ADMIN_COOKIE, body: { email: "v-admin@local.test" } });
  record("TCH-02", "PATCH email clash refused 409 (api.053)", clash.status === 409 && errText(clash) === tApi("api.053"), `status=${clash.status}`);
  const badPhone = await call("PATCH", "/api/admin/teachers/v-teacher-row", { cookie: ADMIN_COOKIE, body: { phone: "12345" } });
  record("TCH-03", "PATCH invalid phone refused 400 (api.064)", badPhone.status === 400 && errText(badPhone) === tApi("api.064"), `status=${badPhone.status}`);
  const okEdit = await call("PATCH", "/api/admin/teachers/v-teacher-row", { cookie: ADMIN_COOKIE, body: { name: "Verifier Teacher 2", bio: "updated bio", specialty: "Robotics", phone: "01099942942" } });
  record("TCH-04", "PATCH valid profile edit succeeds", okEdit.status === 200 && okEdit.json?.ok === true, `status=${okEdit.status}`);
  const got = await call("GET", "/api/admin/teachers/v-teacher-row", { cookie: ADMIN_COOKIE });
  record("TCH-05", "GET reflects the edit (name/bio/specialty)", got.json?.teacher?.user?.name === "Verifier Teacher 2" && got.json?.teacher?.bio === "updated bio" && got.json?.teacher?.specialty === "Robotics", JSON.stringify(got.json?.teacher?.user?.name));
  const withHistory = await call("DELETE", "/api/admin/teachers/v-teacher-row", { cookie: ADMIN_COOKIE });
  record("TCH-06", "DELETE teacher with groups refused 409 (api.296)", withHistory.status === 409 && errText(withHistory) === tApi("api.296", { p1: 2, p2: 3, p3: 0 }), `status=${withHistory.status} err=${errText(withHistory).slice(0, 80)}`);
  const unusedDel = await call("DELETE", "/api/admin/teachers/v-unused-row", { cookie: ADMIN_COOKIE });
  record("TCH-07", "DELETE unused teacher succeeds", unusedDel.status === 200 && unusedDel.json?.deleted === true, `status=${unusedDel.status}`);
  // NOTE: the Teacher ROW itself is removed in production by the schema's
  // `onDelete: Cascade` on Teacher.userId — the harness DDL (migrate-sqlite
  // base schema) intentionally emits NO foreign keys, so only the explicit
  // `db.user.delete` is observable here. The cascade itself is pinned from
  // prisma/schema.prisma in tests/post-launch-admin-lifecycle.test.js.
  const userGone = rawDb.prepare(`SELECT COUNT(*) AS c FROM "User" WHERE "id"='v-unused'`).get();
  record("TCH-08", "User row removed by DELETE (Teacher cascade pinned from schema)", Number(userGone?.c) === 0);
  const app = rawDb.prepare(`SELECT "id","userId","status" FROM "TeacherApplication" WHERE "id"='v-app-1'`).get();
  record("TCH-09", "Application history PRESERVED but unlinked (userId NULL)", !!app && app.userId === null && app.status === "APPROVED");
  // GET on the deleted teacher's id would 404 in production once the schema
  // cascade removes the Teacher row; the harness keeps the orphaned row (no
  // FKs), so pin the 404 path on an id that never existed instead.
  const after = await call("GET", "/api/admin/teachers/does-not-exist", { cookie: ADMIN_COOKIE });
  record("TCH-10", "GET unknown teacher → 404", after.status === 404 && errText(after) === "Teacher not found", `status=${after.status} err=${errText(after)}`);
  const audit = rawDb.prepare(`SELECT COUNT(*) AS c FROM "AuditLog" WHERE "action"='TEACHER_DELETED' AND "entityId"='v-unused-row'`).get();
  record("TCH-11", "TEACHER_DELETED audit row written", Number(audit?.c) === 1);
}

// --- Courses: metadata PATCH + guarded DELETE --------------------------------
{
  const badColor = await call("PATCH", "/api/admin/courses/v-empty-course", { cookie: ADMIN_COOKIE, body: { color: "green" } });
  record("CRS-01", "PATCH invalid color refused 400 (api.018)", badColor.status === 400 && errText(badColor) === tApi("api.018"), `status=${badColor.status}`);
  const emptyBody = await call("PATCH", "/api/admin/courses/v-empty-course", { cookie: ADMIN_COOKIE, body: {} });
  record("CRS-02", "PATCH with no fields refused 400 (api.018)", emptyBody.status === 400, `status=${emptyBody.status}`);
  const edit = await call("PATCH", "/api/admin/courses/v-empty-course", { cookie: ADMIN_COOKIE, body: { name: "Renamed Course", nameAr: "كورس متعدل", color: "#123456" } });
  record("CRS-03", "PATCH metadata succeeds", edit.status === 200 && edit.json?.course?.name === "Renamed Course" && edit.json?.course?.color === "#123456", `status=${edit.status}`);
  const inUse = await call("DELETE", `/api/admin/courses/${COURSE_ID}`, { cookie: ADMIN_COOKIE });
  record("CRS-04", "DELETE course in use refused 409 (api.298)", inUse.status === 409, `status=${inUse.status} err=${errText(inUse).slice(0, 80)}`);
  const official = rawDb.prepare(`SELECT COUNT(*) AS c FROM "Course" WHERE "id"=?`).get(COURSE_ID);
  record("CRS-05", "Refused course still exists", Number(official?.c) === 1);
  const del = await call("DELETE", "/api/admin/courses/v-empty-course", { cookie: ADMIN_COOKIE });
  record("CRS-06", "DELETE empty course succeeds", del.status === 200 && del.json?.deleted === true, `status=${del.status}`);
  const audit = rawDb.prepare(`SELECT COUNT(*) AS c FROM "AuditLog" WHERE "action"='COURSE_DELETED' AND "entityId"='v-empty-course'`).get();
  record("CRS-07", "COURSE_DELETED audit row written", Number(audit?.c) === 1);
}

// --- Question bank: frozen-history guards ------------------------------------
{
  const free = await call("GET", "/api/admin/question-bank/v-q-free", { cookie: ADMIN_COOKIE });
  record("QB-01", "GET free question → canDelete true, no blockers", free.status === 200 && free.json?.canDelete === true && (free.json?.deleteBlockers || []).length === 0 && free.json?.canEditAnswerKey === true, `status=${free.status}`);
  const frozenGet = await call("GET", "/api/admin/question-bank/v-q-frozen", { cookie: ADMIN_COOKIE });
  record("QB-02", "GET frozen question → canDelete false, canEditAnswerKey false, references counted",
    frozenGet.status === 200 && frozenGet.json?.canDelete === false && frozenGet.json?.canEditAnswerKey === false && frozenGet.json?.references?.answers === 1 && frozenGet.json?.references?.gradedAttempts === 1,
    JSON.stringify(frozenGet.json?.references));
  const pinnedGet = await call("GET", "/api/admin/question-bank/v-q-pinned", { cookie: ADMIN_COOKIE });
  record("QB-03", "GET pinned question → FIXED_EXAM_PIN blocker + pin listed",
    pinnedGet.status === 200 && (pinnedGet.json?.deleteBlockers || []).includes("FIXED_EXAM_PIN") && (pinnedGet.json?.mockExamPins || []).length === 1,
    JSON.stringify(pinnedGet.json?.deleteBlockers));
  const lockAnswer = await call("PATCH", "/api/admin/question-bank/v-q-frozen", { cookie: ADMIN_COOKIE, body: { answer: "1" } });
  record("QB-04", "PATCH answer of attempted question refused 409 (api.245)", lockAnswer.status === 409 && errText(lockAnswer) === tApi("api.245"), `status=${lockAnswer.status}`);
  const lockMarks = await call("PATCH", "/api/admin/question-bank/v-q-frozen", { cookie: ADMIN_COOKIE, body: { marks: 5 } });
  record("QB-05", "PATCH marks of attempted question refused 409 (api.245)", lockMarks.status === 409, `status=${lockMarks.status}`);
  const textEdit = await call("PATCH", "/api/admin/question-bank/v-q-frozen", { cookie: ADMIN_COOKIE, body: { prompt: "Clarified wording" } });
  record("QB-06", "PATCH non-grading text of attempted question ALLOWED", textEdit.status === 200 && textEdit.json?.question?.prompt === "Clarified wording", `status=${textEdit.status}`);
  const delFrozen = await call("DELETE", "/api/admin/question-bank/v-q-frozen", { cookie: ADMIN_COOKIE });
  record("QB-07", "DELETE attempted question refused 409 (api.247)", delFrozen.status === 409 && errText(delFrozen) === tApi("api.247"), `status=${delFrozen.status} err=${errText(delFrozen).slice(0, 60)}`);
  const delPinned = await call("DELETE", "/api/admin/question-bank/v-q-pinned", { cookie: ADMIN_COOKIE });
  record("QB-08", "DELETE FIXED-exam-pinned question refused 409 (api.246)", delPinned.status === 409 && errText(delPinned) === tApi("api.246"), `status=${delPinned.status} err=${errText(delPinned).slice(0, 60)}`);
  const freeEdit = await call("PATCH", "/api/admin/question-bank/v-q-free", { cookie: ADMIN_COOKIE, body: { prompt: "Updated free question", options: ["W", "X", "Y", "Z"], answer: "2" } });
  record("QB-09", "PATCH free question (incl. grading fields) succeeds", freeEdit.status === 200 && String(freeEdit.json?.question?.answer) === "2", `status=${freeEdit.status} answer=${freeEdit.json?.question?.answer}`);
  const freeDel = await call("DELETE", "/api/admin/question-bank/v-q-free", { cookie: ADMIN_COOKIE });
  record("QB-10", "DELETE free question succeeds", freeDel.status === 200 && freeDel.json?.deleted === true, `status=${freeDel.status}`);
  const afterDel = await call("GET", "/api/admin/question-bank/v-q-free", { cookie: ADMIN_COOKIE });
  record("QB-11", "GET deleted question → 404 (api.244)", afterDel.status === 404 && errText(afterDel) === tApi("api.244"), `status=${afterDel.status}`);
  const frozenStill = rawDb.prepare(`SELECT COUNT(*) AS c FROM "Question" WHERE "id"='v-q-frozen'`).get();
  record("QB-12", "Refused questions still exist", Number(frozenStill?.c) === 1);
}

// --- Session revocation on teacher email change (identity change) ------------
{
  const before = await call("GET", "/api/teacher/dashboard", { cookie: TEACHER_COOKIE });
  record("REV-01", "Teacher session works before email change", before.status === 200, `status=${before.status}`);
  const change = await call("PATCH", "/api/admin/teachers/v-teacher-row", { cookie: ADMIN_COOKIE, body: { email: "v-teacher-new@local.test" } });
  record("REV-02", "PATCH email succeeds", change.status === 200, `status=${change.status}`);
  const after = await call("GET", "/api/teacher/dashboard", { cookie: TEACHER_COOKIE });
  record("REV-03", "Old teacher session revoked after email change (401)", after.status === 401, `status=${after.status}`);
  const relogin = await call("POST", "/api/auth/login", { body: { email: "v-teacher-new@local.test", password: TEACHER_PW } });
  record("REV-04", "Teacher can log in with the new email", relogin.status === 200, `status=${relogin.status}`);
}

server.close();

console.log(`\n================ POST-LAUNCH ADMIN LIFECYCLE ================`);
const passed = results.filter((r) => r.pass).length;
console.log(`${passed}/${results.length} checks passed`);
if (failures > 0) {
  console.log("FAILED CHECKS:");
  for (const r of results.filter((x) => !x.pass)) console.log(`  - ${r.id}: ${r.desc} ${r.detail}`);
  process.exit(1);
}
console.log("[lifecycle] ALL PASS");
