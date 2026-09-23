#!/usr/bin/env node
// CodeMind Academy — Phase K2 verification: ACADEMIC LEVEL as a runtime
// authority (registration offerings, assignment gates, admin writes, the
// level-aware reconciler, derived lesson level, course-bound mock exams).
//
// Runs the SHIPPED route handlers + libs (compiled with the repo's tsc) over a
// REAL SQLite database built from the real base DDL + every real migration
// (K1 included), through the repo's own Prisma→SQL adapter. Same discipline
// as scripts/verify-phase26b-group-track.mjs. No Neon, no R2, no SMTP.
//
// WINDOWS: every ESM path-load goes through pathToFileURL(...).href; compiled
// CommonJS is loaded with require() on filesystem paths (valid on Windows).
//
// Usage: node scripts/verify-k2-academic-level.mjs
// Prints PHASE_K2_ACADEMIC_LEVEL_OK on success.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Module, { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const REPO = path.join(HERE, "..");

process.env.SECURITY_HASH_SECRET =
  process.env.SECURITY_HASH_SECRET || "k2-verifier-secret-0123456789abcdef";
process.env.NEXT_PUBLIC_URL = process.env.NEXT_PUBLIC_URL || "http://localhost:3000";

let pass = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) pass++;
  else {
    failures.push(label);
    console.log(`  FAIL ${label}${extra !== undefined ? ` :: ${String(extra).slice(0, 300)}` : ""}`);
  }
  return Boolean(cond);
}
const eq = (a, b, label) =>
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const section = (t) => console.log(`\n== ${t} ==`);

// ---------------------------------------------------------------------------
// 1. Compile the shipped TypeScript to CommonJS in a temp dir.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-k2-"));
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
  "src/lib/academic-level.ts",
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
  "src/lib/progress.ts",
  "src/lib/notify.ts",
  "src/lib/notification-links.ts",
  "src/lib/deep-link.ts",
  "src/lib/official-curriculum.ts",
  "src/lib/curriculum-seed.ts",
  "src/lib/mock-exam-pool.ts",
  "src/lib/admin-sessions.ts",
  "src/app/api/auth/[action]/route.ts",
  "src/app/api/registration/options/route.ts",
  "src/app/api/groups/route.ts",
  "src/app/api/courses/route.ts",
  "src/app/api/enroll/route.ts",
  "src/app/api/admin/students/route.ts",
  "src/app/api/admin/students/[id]/route.ts",
  "src/app/api/admin/groups/route.ts",
  "src/app/api/admin/groups/[id]/route.ts",
  "src/app/api/admin/courses/route.ts",
  "src/app/api/admin/courses/[id]/route.ts",
  "src/app/api/admin/lessons/route.ts",
  "src/app/api/admin/level-mismatches/route.ts",
  "src/app/api/admin/mock-exams/route.ts",
  "src/app/api/admin/mock-exams/[id]/route.ts",
  "src/app/api/admin/mock-exams/eligible/route.ts",
  "src/app/api/admin/payments/[id]/approve/route.ts",
];
const files = MODULES.filter((f) => fs.existsSync(path.join(REPO, f)));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      lib: ["es2022", "dom"],
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
    files: files.map((f) => path.join(REPO, f)),
  })
);
try {
  execFileSync(process.execPath, [require.resolve("typescript/bin/tsc"), "-p", path.join(OUT, "tsconfig.json")], {
    cwd: REPO,
    stdio: "pipe",
  });
} catch {
  // expected when the generated Prisma client is a stub; emission still happens
}
const EMIT = path.join(OUT, "src");
for (const f of files) {
  const emitted = path.join(OUT, f.replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(emitted)) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// 2. Real database — base DDL + every real migration (incl. K1).
// ---------------------------------------------------------------------------
const mig = await import(pathToFileURL(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs")).href);
const { createSqlitePrisma } = await import(
  pathToFileURL(path.join(REPO, "scripts", "lib", "sqlite-prisma-lite.mjs")).href
);
const rawDb = new DatabaseSync(":memory:");
rawDb.exec("PRAGMA foreign_keys = ON");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "k2: " });
const client = createSqlitePrisma({ db: rawDb, schemaPath: path.join(REPO, "prisma", "schema.prisma") });
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// 3. Shims — data source, mail transport, Next request plumbing, knowledge model.
// ---------------------------------------------------------------------------
const dbShim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(dbShim, "module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };\n");
fs.writeFileSync(
  path.join(OUT, "__delivery-shim.js"),
  "module.exports = { sendEmail: async () => ({ delivered: true, provider: 'k2-capture' }) };\n"
);
fs.writeFileSync(
  path.join(OUT, "__next-server-shim.js"),
  [
    "class NextResponse {",
    "  constructor(body, init = {}) { this.status = init.status ?? 200; this._headers = new Map(); for (const [k, v] of Object.entries(init.headers || {})) this._headers.set(String(k).toLowerCase(), String(v)); this._body = body; this._json = undefined; }",
    "  static json(data, init = {}) { const r = new NextResponse(JSON.stringify(data), { status: init.status ?? 200, headers: Object.assign({ 'content-type': 'application/json' }, init.headers || {}) }); r._json = data; return r; }",
    "  get headers() { const m = this._headers; return { get: (k) => m.get(String(k).toLowerCase()) ?? null, forEach: (fn) => m.forEach((v, k) => fn(v, k)) }; }",
    "  async json() { if (this._json !== undefined) return this._json; try { return JSON.parse(Buffer.from(this._body || []).toString('utf8')); } catch { return null; } }",
    "}",
    "class NextRequest {}",
    "module.exports = { NextResponse, NextRequest };",
  ].join("\n")
);
fs.writeFileSync(
  path.join(OUT, "__next-headers-shim.js"),
  [
    "const store = () => { const ctx = globalThis.__CM_REQ_CTX__ || { cookie: {}, headers: {} }; return {",
    "  get(name) { const v = ctx.cookie ? ctx.cookie[name] : undefined; return v === undefined ? undefined : { value: v }; },",
    "  set(name, value) { const jar = globalThis.__CM_RESP_COOKIES__ || (globalThis.__CM_RESP_COOKIES__ = []); jar.push(`${name}=${value}; Path=/`); if (ctx.cookie) ctx.cookie[name] = value; },",
    "  delete(name) { if (ctx.cookie) delete ctx.cookie[name]; },",
    "}; };",
    "module.exports = { cookies: async () => store(), headers: async () => new Headers((globalThis.__CM_REQ_CTX__ || {}).headers || {}) };",
  ].join("\n")
);
const REAL_MODEL_PATH = path.join(REPO, "docs", "curriculum", "knowledge-model.json");
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
  if (/knowledge-model\.json$/.test(request)) return REAL_MODEL_PATH;
  return originalResolve.call(this, request, ...rest);
};

const route = (p) => require(path.join(EMIT, "app", "api", p));
const Auth = require(path.join(EMIT, "lib", "auth.js"));
const Level = require(path.join(EMIT, "lib", "academic-level.js"));
const Official = require(path.join(EMIT, "lib", "official-curriculum.js"));
const Pool = require(path.join(EMIT, "lib", "mock-exam-pool.js"));
const Transitions = require(path.join(EMIT, "lib", "payment-transitions.js"));

// ---------------------------------------------------------------------------
// 4. In-process dispatcher over the real handlers.
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
  ["GET", /^\/api\/registration\/options$/, () => route("registration/options/route.js").GET],
  ["GET", /^\/api\/groups$/, () => route("groups/route.js").GET],
  ["GET", /^\/api\/courses$/, () => route("courses/route.js").GET],
  ["POST", /^\/api\/enroll$/, () => route("enroll/route.js").POST],
  ["GET", /^\/api\/admin\/students$/, () => route("admin/students/route.js").GET],
  ["POST", /^\/api\/admin\/students$/, () => route("admin/students/route.js").POST],
  ["PATCH", /^\/api\/admin\/students\/([^/]+)$/, () => route("admin/students/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/admin\/groups$/, () => route("admin/groups/route.js").POST],
  ["PATCH", /^\/api\/admin\/groups\/([^/]+)$/, () => route("admin/groups/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/admin\/courses$/, () => route("admin/courses/route.js").POST],
  ["PATCH", /^\/api\/admin\/courses\/([^/]+)$/, () => route("admin/courses/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["POST", /^\/api\/admin\/lessons$/, () => route("admin/lessons/route.js").POST],
  ["GET", /^\/api\/admin\/level-mismatches$/, () => route("admin/level-mismatches/route.js").GET],
  ["POST", /^\/api\/admin\/mock-exams$/, () => route("admin/mock-exams/route.js").POST],
  ["PATCH", /^\/api\/admin\/mock-exams\/([^/]+)$/, () => route("admin/mock-exams/[id]/route.js").PATCH, (m) => ({ id: m[1] })],
  ["GET", /^\/api\/admin\/mock-exams\/eligible$/, () => route("admin/mock-exams/eligible/route.js").GET],
  ["POST", /^\/api\/admin\/payments\/([^/]+)\/approve$/, () => route("admin/payments/[id]/approve/route.js").POST, (m) => ({ id: m[1] })],
];
async function call(method, url, { body, cookie } = {}) {
  const u = new URL(url, "http://127.0.0.1");
  globalThis.__CM_RESP_COOKIES__ = [];
  globalThis.__CM_REQ_CTX__ = {
    cookie: parseCookies(cookie || ""),
    headers: { "user-agent": "k2-verifier", "x-forwarded-for": "198.51.100.9" },
  };
  for (const [m, re, pick, paramsOf] of ROUTES) {
    if (m !== method) continue;
    const match = re.exec(u.pathname);
    if (!match) continue;
    const req = {
      url: u.toString(),
      method,
      nextUrl: u,
      headers: new Headers({ "user-agent": "k2-verifier" }),
      cookies: { get: (n) => (parseCookies(cookie || "")[n] === undefined ? undefined : { value: parseCookies(cookie || "")[n] }) },
      json: async () => body ?? {},
      text: async () => JSON.stringify(body ?? {}),
      formData: async () => new Map(),
    };
    let out;
    try {
      out = await pick(match)(req, { params: Promise.resolve(paramsOf ? paramsOf(match) : {}) });
    } catch (e) {
      return { status: 500, json: { error: "HANDLER_THREW", detail: String(e?.stack || e).slice(0, 400) } };
    }
    const json = await out.json().catch(() => null);
    const setCookie = (globalThis.__CM_RESP_COOKIES__ || []).join("; ");
    return { status: out.status ?? 200, json, setCookie };
  }
  return { status: 404, json: { error: "no route" } };
}
const cookieOf = (res) => {
  const m = /cm_session=([^;]+)/.exec(res.setCookie || "");
  return m ? `cm_session=${m[1]}` : null;
};

// ---------------------------------------------------------------------------
// 5. Fixtures — clearly labelled k2-* rows.
// ---------------------------------------------------------------------------
const db = rawDb;
const NOW = Date.now();
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
function insertUser(id, email, role, name = id) {
  db.prepare(
    `INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt") VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`
  ).run(id, email, Auth.hashPassword("K2LocalPass1!"), name, role, NOW, NOW);
}
function insertSession(id, userId, token) {
  db.prepare(
    `INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt","revokedAt") VALUES (?,?,?,?,?,?,?,NULL)`
  ).run(id, userId, sha256(token), "k2-device", NOW, NOW, NOW + 86400000);
}
insertUser("k2-admin", "k2-admin@local.test", "ADMIN", "K2 Admin");
insertSession("k2-admin-session", "k2-admin", "k2-admin-raw-token");
const ADMIN = "cm_session=k2-admin-raw-token";

function insertCourse(id, slug, level) {
  db.prepare(
    `INSERT INTO "Course" ("id","slug","name","nameAr","description","color","academicLevel","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, slug, slug, slug, "k2 fixture", "#10b981", level, NOW, NOW);
}
function insertChain(prefix, courseId) {
  db.prepare(`INSERT INTO "Part" ("id","courseId","title","titleAr","order") VALUES (?,?,?,?,1)`).run(`${prefix}-part`, courseId, "P", "ج");
  db.prepare(`INSERT INTO "Unit" ("id","partId","title","titleAr","order") VALUES (?,?,?,?,1)`).run(`${prefix}-unit`, `${prefix}-part`, "U", "و");
  db.prepare(`INSERT INTO "Topic" ("id","unitId","title","titleAr","order") VALUES (?,?,?,?,1)`).run(`${prefix}-topic`, `${prefix}-unit`, "T", "م");
}
function insertGroup(id, courseId, trackScope, capacity = 20, isActive = 1) {
  db.prepare(
    `INSERT INTO "Group" ("id","name","courseId","capacity","schedule","isActive","trackScope","createdAt","updatedAt") VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(id, id, courseId, capacity, "Sat 6PM", isActive, trackScope, NOW, NOW);
}
// SECOND_SECONDARY: ARABIC + LANGUAGE groups. FIRST_SECONDARY: ARABIC only.
// A LEGACY course with NULL level (never levelled) and an INACTIVE group that
// must NOT advertise anything.
insertCourse("k2-c2", "k2-second", "SECOND_SECONDARY");
insertCourse("k2-c1", "k2-first", "FIRST_SECONDARY");
insertCourse("k2-c0", "k2-legacy-null", null);
insertChain("k2-c2", "k2-c2");
insertChain("k2-c1", "k2-c1");
insertGroup("k2-g2-ar", "k2-c2", "ARABIC");
insertGroup("k2-g2-lang", "k2-c2", "LANGUAGE");
insertGroup("k2-g1-ar", "k2-c1", "ARABIC");
insertGroup("k2-g1-lang-off", "k2-c1", "LANGUAGE", 20, 0); // inactive → not offered
insertGroup("k2-g1-null", "k2-c1", null); // unclassified → not offered
insertGroup("k2-g0-ar", "k2-c0", "ARABIC"); // unlevelled course → not offered
db.prepare(
  `INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","isActive","createdAt") VALUES ('k2-plan','Monthly','شهري',1,200,0,1,?)`
).run(NOW);

const studentRowOf = (email) =>
  db.prepare(`SELECT s.* FROM "Student" s JOIN "User" u ON u."id"=s."userId" WHERE u."email"=?`).get(email);
const count = (sql, ...args) => db.prepare(sql).get(...args).c;

async function register(email, name, schoolType, academicLevel, nationalId, extra = {}) {
  const body = {
    role: "STUDENT", email, name, password: "K2Student1!",
    studentPhone: "01012345678", parentPhone: "01098765432",
    nationalId, schoolName: "K2 School", schoolType, ...extra,
  };
  if (academicLevel !== undefined) body.academicLevel = academicLevel;
  return call("POST", "/api/auth/register", { body });
}

// ===========================================================================
section("A — Registration offerings (Level × Track), server-side revalidation");
// ===========================================================================
const opts = await call("GET", "/api/registration/options");
eq(opts.status, 200, "A: GET /api/registration/options is public and 200");
eq(
  opts.json?.offerings,
  [
    { academicLevel: "FIRST_SECONDARY", tracks: ["ARABIC"] },
    { academicLevel: "SECOND_SECONDARY", tracks: ["ARABIC", "LANGUAGE"] },
  ],
  "A: only REAL Level × Track combinations are advertised (FIRST: ARABIC only; SECOND: both)"
);
ok(!("levels" in (opts.json || {})) && !("tracks" in (opts.json || {})), "A: the rejected independent { levels, tracks } shape is NOT exposed");
// Pure reducer: inactive / unclassified / unlevelled rows never advertise.
eq(
  Level.computeRegistrationOfferings([
    { trackScope: "LANGUAGE", course: { academicLevel: "FIRST_SECONDARY" } },
    { trackScope: null, course: { academicLevel: "SECOND_SECONDARY" } },
    { trackScope: "ARABIC", course: { academicLevel: null } },
    { trackScope: "SHARED", course: { academicLevel: "SECOND_SECONDARY" } },
  ]),
  [{ academicLevel: "FIRST_SECONDARY", tracks: ["LANGUAGE"] }],
  "A: reducer ignores unclassified / SHARED / unlevelled rows"
);

const r1 = await register("k2-first-ar@local.test", "أحمد محمد علي", "ARABIC", "FIRST_SECONDARY", "30101011202301", { grade: "HACKED GRADE" });
eq(r1.status, 200, "A: FIRST + ARABIC registers (offered)", JSON.stringify(r1.json));
const FIRST_AR = cookieOf(r1);
const s1 = studentRowOf("k2-first-ar@local.test");
eq(s1?.academicLevel, "FIRST_SECONDARY", "A/B: Student.academicLevel written from the typed input");
eq(s1?.grade, "1st Secondary", "A/B: Student.grade DERIVED from the level ('1st Secondary'); client grade ignored");

const r2 = await register("k2-first-lang@local.test", "منى خالد محمود", "LANGUAGE", "FIRST_SECONDARY", "30202022303402");
eq(r2.status, 400, "A: FIRST + LANGUAGE rejected server-side (not offered)", JSON.stringify(r2.json));
ok(!studentRowOf("k2-first-lang@local.test"), "A: the rejected pair created NO student");
ok(!db.prepare(`SELECT 1 FROM "User" WHERE "email"='k2-first-lang@local.test'`).get(), "A: …and no User row");

const r3 = await register("k2-second-ar@local.test", "يوسف كريم علي", "ARABIC", "SECOND_SECONDARY", "30303033404503");
eq(r3.status, 200, "A: SECOND + ARABIC registers (preserved behaviour)", JSON.stringify(r3.json));
const SECOND_AR = cookieOf(r3);
const r4 = await register("k2-second-lang@local.test", "سارة أحمد حسن", "LANGUAGE", "SECOND_SECONDARY", "30404044505604");
eq(r4.status, 200, "A: SECOND + LANGUAGE registers (preserved behaviour)", JSON.stringify(r4.json));
const SECOND_LANG = cookieOf(r4);
eq(studentRowOf("k2-second-ar@local.test")?.grade, "2nd Secondary", "A/B: Second Secondary grade mirror is the byte-identical '2nd Secondary'");

const r5 = await register("k2-nolevel@local.test", "طارق سعيد عمر", "ARABIC", undefined, "30505055606705");
eq(r5.status, 400, "A: missing academicLevel → 400");
const r6 = await register("k2-badlevel@local.test", "طارق سعيد عمر", "ARABIC", "THIRD_SECONDARY", "30505055606706");
eq(r6.status, 400, "A: unknown academicLevel → 400 (no inference)");
const r7 = await register("k2-gradeonly@local.test", "طارق سعيد عمر", "ARABIC", undefined, "30505055606707", { grade: "1st Secondary" });
eq(r7.status, 400, "A/B: free-text grade can NEVER stand in for the typed level");

// ===========================================================================
section("B — Admin student creation: typed level, derived grade, gated group");
// ===========================================================================
const mk = (over = {}) => ({
  name: "K2 Created", email: `k2-created-${Math.random().toString(36).slice(2, 8)}@local.test`,
  password: "K2Created1!", schoolType: "ARABIC", ...over,
});
const b1 = await call("POST", "/api/admin/students", { body: mk({ academicLevel: "FIRST_SECONDARY", grade: "IGNORED" }), cookie: ADMIN });
eq(b1.status, 200, "B: admin creates a FIRST_SECONDARY student", JSON.stringify(b1.json));
eq(b1.json?.student?.academicLevel, "FIRST_SECONDARY", "B: response carries the typed level");
eq(b1.json?.student?.grade, "1st Secondary", "B: grade mirror derived; client grade cannot override");
const b2 = await call("POST", "/api/admin/students", { body: mk({}), cookie: ADMIN });
eq(b2.status, 400, "B: admin create without academicLevel → 400");
const usersBefore = count(`SELECT COUNT(*) AS c FROM "User"`);
const b3 = await call("POST", "/api/admin/students", { body: mk({ academicLevel: "FIRST_SECONDARY", groupId: "k2-g2-ar" }), cookie: ADMIN });
eq(b3.status, 409, "B/C: admin create with a CROSS-LEVEL group → 409", JSON.stringify(b3.json));
eq(count(`SELECT COUNT(*) AS c FROM "User"`), usersBefore, "B: nothing was created on the cross-level refusal");
const b4 = await call("POST", "/api/admin/students", { body: mk({ academicLevel: "FIRST_SECONDARY", groupId: "k2-g1-ar" }), cookie: ADMIN });
eq(b4.status, 200, "B/C: admin create with a SAME-LEVEL same-track group → 200", JSON.stringify(b4.json));
const b5 = await call("POST", "/api/admin/students", { body: mk({ academicLevel: "SECOND_SECONDARY", schoolType: "LANGUAGE", groupId: "k2-g2-ar" }), cookie: ADMIN });
eq(b5.status, 409, "B/C: same-level WRONG-TRACK group still refused by the existing track rule (409)");

// ===========================================================================
section("C — Group assignment gates (picker, admin add, direct PATCH)");
// ===========================================================================
const pickFirst = await call("GET", "/api/groups", { cookie: FIRST_AR });
eq((pickFirst.json?.groups || []).map((g) => g.id), ["k2-g1-ar"], "C: FIRST student's picker lists ONLY same-level same-track groups");
const pickSecondLang = await call("GET", "/api/groups", { cookie: SECOND_LANG });
eq((pickSecondLang.json?.groups || []).map((g) => g.id), ["k2-g2-lang"], "C: SECOND/LANGUAGE picker lists only k2-g2-lang");
const catFirst = await call("GET", "/api/courses?catalog=1", { cookie: FIRST_AR });
eq((catFirst.json?.courses || []).map((c) => c.id), ["k2-c1"], "C: student course catalogue is level-scoped");

const firstArId = s1.id;
const secondArId = studentRowOf("k2-second-ar@local.test").id;
const addCross = await call("PATCH", "/api/admin/groups/k2-g2-ar", { body: { addStudentIds: [firstArId] }, cookie: ADMIN });
eq(addCross.status, 409, "C: adding a FIRST student to a SECOND group → 409", JSON.stringify(addCross.json));
eq(studentRowOf("k2-first-ar@local.test").groupId, null, "C: cross-level add wrote nothing");
eq(studentRowOf("k2-first-ar@local.test").academicLevel, "FIRST_SECONDARY", "C: the student's level was NOT silently rewritten");
const addSame = await call("PATCH", "/api/admin/groups/k2-g1-ar", { body: { addStudentIds: [firstArId] }, cookie: ADMIN });
eq(addSame.status, 200, "C: same-level same-track add → 200", JSON.stringify(addSame.json));
eq(studentRowOf("k2-first-ar@local.test").groupId, "k2-g1-ar", "C: assignment persisted");
const addWrongTrack = await call("PATCH", "/api/admin/groups/k2-g2-lang", { body: { addStudentIds: [secondArId] }, cookie: ADMIN });
eq(addWrongTrack.status, 409, "C: same-level wrong-track add still refused (existing rule)");

const patchCross = await call("PATCH", `/api/admin/students/${secondArId}`, { body: { groupId: "k2-g1-ar" }, cookie: ADMIN });
eq(patchCross.status, 409, "C: direct admin PATCH groupId across levels → 409", JSON.stringify(patchCross.json));
eq(studentRowOf("k2-second-ar@local.test").groupId, null, "C: direct cross-level PATCH wrote nothing");
const patchSame = await call("PATCH", `/api/admin/students/${secondArId}`, { body: { groupId: "k2-g2-ar" }, cookie: ADMIN });
eq(patchSame.status, 200, "C: direct same-level PATCH → 200");

// Group re-target (courseId change) with members of another level → refused.
const retarget = await call("PATCH", "/api/admin/groups/k2-g1-ar", { body: { courseId: "k2-c2" }, cookie: ADMIN });
eq(retarget.status, 409, "C: re-targeting a POPULATED group to another level's course → 409 (no auto-unassign)");
eq(db.prepare(`SELECT "courseId" FROM "Group" WHERE "id"='k2-g1-ar'`).get().courseId, "k2-c1", "C: the group still points at its own course");
const retargetNull = await call("PATCH", "/api/admin/groups/k2-g0-ar", { body: { courseId: "k2-c0" }, cookie: ADMIN });
ok(retargetNull.status === 200, "C: a no-op courseId (same course) is still accepted");
const mkGroupNull = await call("POST", "/api/admin/groups", { body: { name: "k2 on legacy", courseId: "k2-c0", trackScope: "ARABIC" }, cookie: ADMIN });
eq(mkGroupNull.status, 409, "C: creating a group on an UNLEVELLED course is refused (level derives from the course)");
const mkGroupOk = await call("POST", "/api/admin/groups", { body: { name: "k2 first lang", courseId: "k2-c1", trackScope: "LANGUAGE" }, cookie: ADMIN });
eq(mkGroupOk.status, 200, "C: creating a group on a levelled course works (no Group.academicLevel column)");
const NEW_G1_LANG = mkGroupOk.json?.group?.id;
const optsAfter = await call("GET", "/api/registration/options");
eq(
  optsAfter.json?.offerings?.find((o) => o.academicLevel === "FIRST_SECONDARY")?.tracks,
  ["ARABIC", "LANGUAGE"],
  "A/C: offerings follow reality — FIRST now advertises LANGUAGE once an active LANGUAGE group exists"
);
db.prepare(`UPDATE "Group" SET "isActive"=0 WHERE "id"=?`).run(NEW_G1_LANG);

// ===========================================================================
section("D — Enrollment submission + payment approval enforce I1");
// ===========================================================================
const enrollBody = (over) => ({ courseId: "k2-c2", groupId: "k2-g2-ar", planId: "k2-plan", method: "INSTAPAY", senderPhone: "01012345678", reference: "K2-REF", ...over });
const enrollCross = await call("POST", "/api/enroll", { body: enrollBody({}), cookie: FIRST_AR });
eq(enrollCross.status, 400, "D: FIRST student submitting for a SECOND group → 400", JSON.stringify(enrollCross.json));
eq(count(`SELECT COUNT(*) AS c FROM "Payment"`), 0, "D: the refused submission created NO payment");
const enrollSame = await call("POST", "/api/enroll", { body: enrollBody({ courseId: "k2-c1", groupId: "k2-g1-ar" }), cookie: FIRST_AR });
eq(enrollSame.status, 200, "D: same-level submission → 200", JSON.stringify(enrollSame.json));
const enrollSecond = await call("POST", "/api/enroll", { body: enrollBody({ reference: "K2-REF-2" }), cookie: SECOND_AR });
eq(enrollSecond.status, 200, "D: SECOND student same-level submission → 200", JSON.stringify(enrollSecond.json));

const secondArUserId = r3.json?.user?.id;
const pay = db.prepare(`SELECT * FROM "Payment" WHERE "userId"=? ORDER BY "createdAt" DESC`).get(secondArUserId);
ok(!!pay, "D: SECOND student's PENDING payment exists");
ok(Transitions.PAYMENT_TRANSITION_ERROR_CODES.includes("GROUP_LEVEL_MISMATCH"), "D: GROUP_LEVEL_MISMATCH is a stable domain error");
eq(Transitions.TRANSITION_ERROR_STATUS.GROUP_LEVEL_MISMATCH, 409, "D: …mapped to 409");
const approveCross = await call("POST", `/api/admin/payments/${pay.id}/approve`, { body: { groupId: "k2-g1-ar" }, cookie: ADMIN });
eq(approveCross.status, 409, "D: approving into a CROSS-LEVEL override group → 409", JSON.stringify(approveCross.json));
eq(approveCross.json?.code, "GROUP_LEVEL_MISMATCH", "D: …with the explicit GROUP_LEVEL_MISMATCH code");
eq(db.prepare(`SELECT "status" FROM "Payment" WHERE "id"=?`).get(pay.id).status, "PENDING", "D: payment stays PENDING/reviewable");
eq(studentRowOf("k2-second-ar@local.test").academicLevel, "SECOND_SECONDARY", "D: student level untouched by the refused approval");
const approveOk = await call("POST", `/api/admin/payments/${pay.id}/approve`, { body: {}, cookie: ADMIN });
eq(approveOk.status, 200, "D: approving into the requested SAME-LEVEL group → 200", JSON.stringify(approveOk.json));
eq(studentRowOf("k2-second-ar@local.test").groupId, "k2-g2-ar", "D: approval assigned the same-level group");

// ===========================================================================
section("E — Admin student edit: typed level; cross-level while grouped refused");
// ===========================================================================
const e1 = await call("PATCH", `/api/admin/students/${firstArId}`, { body: { academicLevel: "SECOND_SECONDARY" }, cookie: ADMIN });
eq(e1.status, 409, "E: changing a GROUPED student's level to another level → 409", JSON.stringify(e1.json));
eq(studentRowOf("k2-first-ar@local.test").academicLevel, "FIRST_SECONDARY", "E: level unchanged after refusal");
const e2 = await call("PATCH", `/api/admin/students/${firstArId}`, { body: { academicLevel: "bogus" }, cookie: ADMIN });
eq(e2.status, 400, "E: invalid level → 400");
const e3 = await call("PATCH", `/api/admin/students/${firstArId}`, { body: { grade: "2nd Secondary" }, cookie: ADMIN });
eq(e3.status, 200, "E: a bare grade PATCH is accepted but…");
eq(studentRowOf("k2-first-ar@local.test").grade, "1st Secondary", "E: …grade is NOT writable (mirror stays derived)");
const secondLangId = studentRowOf("k2-second-lang@local.test").id;
const e4 = await call("PATCH", `/api/admin/students/${secondLangId}`, { body: { academicLevel: "FIRST_SECONDARY" }, cookie: ADMIN });
eq(e4.status, 200, "E: an UNGROUPED student's level can be changed", JSON.stringify(e4.json));
eq(studentRowOf("k2-second-lang@local.test").academicLevel, "FIRST_SECONDARY", "E: typed level persisted");
eq(studentRowOf("k2-second-lang@local.test").grade, "1st Secondary", "E: grade mirror re-derived on level change");
const e5 = await call("PATCH", `/api/admin/students/${secondLangId}`, { body: { academicLevel: "SECOND_SECONDARY", groupId: "k2-g2-lang" }, cookie: ADMIN });
eq(e5.status, 200, "E: level + matching group in ONE request validates against the NEW level");
const list = await call("GET", "/api/admin/students?pageSize=50", { cookie: ADMIN });
ok((list.json?.students || []).every((s) => "academicLevel" in s && "levelMismatch" in s), "E: admin list exposes academicLevel + levelMismatch diagnostic");

const c1 = await call("POST", "/api/admin/courses", { body: { name: "K2 no level", nameAr: "بدون" }, cookie: ADMIN });
eq(c1.status, 400, "E: admin course create without academicLevel → 400");
const c2 = await call("POST", "/api/admin/courses", { body: { name: "K2 levelled", nameAr: "مستوى", academicLevel: "FIRST_SECONDARY" }, cookie: ADMIN });
eq(c2.status, 200, "E: admin course create with academicLevel → 200");
eq(c2.json?.course?.academicLevel, "FIRST_SECONDARY", "E: Course.academicLevel written");
const c3 = await call("PATCH", "/api/admin/courses/k2-c2", { body: { academicLevel: "FIRST_SECONDARY" }, cookie: ADMIN });
eq(c3.status, 409, "E: re-levelling a course with grouped students is refused");
const c4 = await call("PATCH", "/api/admin/courses/k2-c0", { body: { academicLevel: "SECOND_SECONDARY" }, cookie: ADMIN });
eq(c4.status, 200, "E: a legacy unlevelled EMPTY course can be levelled explicitly");

// ===========================================================================
section("F — Official reconciler: level-aware spec, Second Secondary byte-pinned");
// ===========================================================================
ok(Official.SECOND_SECONDARY_SPEC?.academicLevel === "SECOND_SECONDARY" && Official.SECOND_SECONDARY_SPEC.courseSlug === "programming-ai-2nd-sec", "F: SECOND_SECONDARY_SPEC pins slug + level");
eq(Official.SECOND_SECONDARY_SPEC.expectedCounts, { parts: 2, units: 7, lessons: 23 }, "F: SECOND_SECONDARY_SPEC pins 2/7/23");
const rep = await Official.reconcileOfficialCurriculum(client);
eq([rep.partsReconciled, rep.unitsReconciled, rep.officialLessonCodes.length], [2, 7, 23], "F: default run still reconciles exactly 2 / 7 / 23");
eq(rep.academicLevel, "SECOND_SECONDARY", "F: report carries the level");
eq(db.prepare(`SELECT "academicLevel" FROM "Course" WHERE "slug"='programming-ai-2nd-sec'`).get().academicLevel, "SECOND_SECONDARY", "F: official course levelled SECOND_SECONDARY");
eq(count(`SELECT COUNT(*) AS c FROM "Lesson" WHERE "officialCode" IS NOT NULL AND "academicLevel"='SECOND_SECONDARY'`), 23, "F: all 23 official lessons carry the derived SECOND_SECONDARY level");
eq(count(`SELECT COUNT(*) AS c FROM "Lesson" WHERE "academicLevel"='FIRST_SECONDARY'`), 0, "F: NO FIRST_SECONDARY lesson row was created");
eq(count(`SELECT COUNT(*) AS c FROM "Course" WHERE "academicLevel"='FIRST_SECONDARY' AND "slug" LIKE 'programming-ai-%'`), 0, "F: no First Secondary official course imported");
const rep2 = await Official.reconcileOfficialCurriculum(client);
eq([rep2.lessonsCreated, rep2.lessonsUpdated], [0, 0], "F: second run is idempotent");
let drift = null;
try {
  await Official.reconcileOfficialCurriculum(client, { ...Official.SECOND_SECONDARY_SPEC, academicLevel: "FIRST_SECONDARY" });
} catch (e) { drift = e; }
ok(drift && /refused/i.test(String(drift.message)), "F/G7: a spec whose level ≠ the stored course level is REFUSED before any write", String(drift?.message));
eq(db.prepare(`SELECT "academicLevel" FROM "Course" WHERE "slug"='programming-ai-2nd-sec'`).get().academicLevel, "SECOND_SECONDARY", "F: refused run changed nothing");
// Spec-parameterised loader: the SAME engine validates a 1-part/1-unit/2-lesson model.
const tiny = Official.loadLevelCurriculumModel({
  academicLevel: "FIRST_SECONDARY", courseSlug: "k2-tiny", course: { name: "t", nameAr: "ت", description: "", color: "#000" },
  expectedCounts: { parts: 1, units: 1, lessons: 2 }, expectedCodes: ["1-1", "1-2"],
  knowledgeModel: { schemaVersion: "k2", parts: [{ id: "p", code: "P1", order: 1, title: "P", titleAr: "ج", units: [{ id: "u", code: "U1", order: 1, title: "U", titleAr: "و", lessons: [
    { id: "a", code: "1-1", order: 1, title: "A", titleAr: "أ" }, { id: "b", code: "1-2", order: 2, title: "B", titleAr: "ب" } ] }] }] },
});
eq(tiny.parts[0].units[0].lessons.length, 2, "F: loader validates against the SPEC's counts/codes — no global 23-lesson assumption");
const src = fs.readFileSync(path.join(REPO, "src", "lib", "official-curriculum.ts"), "utf8");
const engineBody = src.slice(src.indexOf("export async function reconcileOfficialCurriculum"));
const engineCode = engineBody.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
ok(!/EXPECTED_OFFICIAL_COUNTS|OFFICIAL_LESSON_CODES|OFFICIAL_COURSE_SLUG|programming-ai-2nd-sec|الثاني الثانوي|\b23\b/.test(engineCode), "F: the reusable engine body carries no 23-lesson / 2-7 / slug constant (only the spec default)");
ok((engineCode.match(/SECOND_SECONDARY_SPEC/g) || []).length === 2, "F: SECOND_SECONDARY_SPEC appears in the engine ONLY as the backward-compatible default spec");
const loaderBody = src.slice(src.indexOf("export function loadLevelCurriculumModel"), src.indexOf("export type ReconcileReport"));
ok(!/EXPECTED_OFFICIAL_COUNTS|OFFICIAL_LESSON_CODES/.test(loaderBody), "F: the level-aware loader reads counts/codes from the spec only");

// ===========================================================================
section("G — Lesson.academicLevel is DERIVED (canonical + legacy chains), drift detected");
// ===========================================================================
const l1 = await call("POST", "/api/admin/lessons", { body: { title: "K2 first lesson", titleAr: "درس", unitId: "k2-c1-unit", trackScope: "SHARED", academicLevel: "SECOND_SECONDARY" }, cookie: ADMIN });
ok(l1.status === 201 || l1.status === 200, "G: admin lesson create under a FIRST course unit", JSON.stringify(l1.json));
const l1row = db.prepare(`SELECT * FROM "Lesson" WHERE "id"=?`).get(l1.json?.lesson?.id);
eq(l1row?.academicLevel, "FIRST_SECONDARY", "G: derived from the canonical chain (client-supplied SECOND_SECONDARY ignored)");
eq(await Level.deriveLessonLevel({ unitId: "k2-c2-unit", topicId: null }, client), "SECOND_SECONDARY", "G: deriveLessonLevel — canonical Unit chain");
eq(await Level.deriveLessonLevel({ unitId: null, topicId: "k2-c1-topic" }, client), "FIRST_SECONDARY", "G: deriveLessonLevel — legacy Topic chain");
eq(await Level.deriveLessonLevel({ unitId: null, topicId: null }, client), null, "G: orphan derives to null (never guessed)");
// Corrupt one lesson's stored level and one student's level → audit reports both.
db.prepare(`UPDATE "Lesson" SET "academicLevel"='SECOND_SECONDARY' WHERE "id"=?`).run(l1row.id);
db.prepare(`UPDATE "Student" SET "academicLevel"='FIRST_SECONDARY' WHERE "id"=?`).run(secondArId); // grouped in k2-g2-ar (SECOND)
const audit = await call("GET", "/api/admin/level-mismatches", { cookie: ADMIN });
eq(audit.status, 200, "G: admin diagnostics endpoint responds");
ok((audit.json?.lessonMismatches || []).some((m) => m.lessonId === l1row.id && m.derivedLevel === "FIRST_SECONDARY"), "G: stale lesson level DETECTED (stored ≠ chain-derived)");
ok((audit.json?.studentGroupMismatches || []).some((m) => m.studentId === secondArId), "G: I1 violator (student level ≠ group course level) DETECTED");
eq(db.prepare(`SELECT "academicLevel" FROM "Lesson" WHERE "id"=?`).get(l1row.id).academicLevel, "SECOND_SECONDARY", "G: diagnostics NEVER repair at read time");
const anon = await call("GET", "/api/admin/level-mismatches", { cookie: FIRST_AR });
ok(anon.status === 401 || anon.status === 403, "G: diagnostics are ADMIN-only");
db.prepare(`UPDATE "Student" SET "academicLevel"='SECOND_SECONDARY' WHERE "id"=?`).run(secondArId);
db.prepare(`UPDATE "Lesson" SET "academicLevel"='FIRST_SECONDARY' WHERE "id"=?`).run(l1row.id);

// ===========================================================================
section("H — Mock exams: course REQUIRED; automatic pool never crosses course/level");
// ===========================================================================
// Publish the FIRST lesson + a SECOND official lesson, hang a quiz question on each.
db.prepare(`UPDATE "Lesson" SET "status"='PUBLISHED' WHERE "id"=?`).run(l1row.id);
const secondLesson = db.prepare(`SELECT "id" FROM "Lesson" WHERE "officialCode"='1-1'`).get();
db.prepare(`UPDATE "Lesson" SET "status"='PUBLISHED' WHERE "id"=?`).run(secondLesson.id);
const insertQuiz = (id, lessonId) =>
  db.prepare(`INSERT INTO "Quiz" ("id","lessonId","title","titleAr","passMark","order") VALUES (?,?,?,?,60,0)`).run(id, lessonId, id, id);
const insertQ = (id, quizId, schoolType = "ARABIC") =>
  db.prepare(`INSERT INTO "Question" ("id","quizId","type","prompt","options","answer","difficulty","marks","schoolType","createdAt") VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, quizId, "MCQ", id, JSON.stringify(["a", "b", "c", "d"]), "0", "MEDIUM", 1, schoolType, NOW);
insertQuiz("k2-quiz-first", l1row.id);
insertQuiz("k2-quiz-second", secondLesson.id);
insertQ("k2-q-first-1", "k2-quiz-first");
insertQ("k2-q-first-2", "k2-quiz-first");
insertQ("k2-q-second-1", "k2-quiz-second");
insertQ("k2-q-second-2", "k2-quiz-second");
insertQ("k2-q-free", null); // free-bank: no course derivation possible

const noCourse = await call("POST", "/api/admin/mock-exams", { body: { title: "courseless", schoolType: "ARABIC", questionCount: 1 }, cookie: ADMIN });
eq(noCourse.status, 400, "H: creating a mock exam WITHOUT courseId → 400 (runtime-required)", JSON.stringify(noCourse.json));
eq(count(`SELECT COUNT(*) AS c FROM "MockExam"`), 0, "H: nothing created");
const unlevelled = await call("POST", "/api/admin/mock-exams", { body: { title: "x", schoolType: "ARABIC", questionCount: 1, courseId: c2.json.course.id }, cookie: ADMIN });
ok(unlevelled.status === 400, "H: a course with no lesson pool cannot satisfy the count (existing guard still applies)");
const firstExam = await call("POST", "/api/admin/mock-exams", { body: { title: "First exam", schoolType: "ARABIC", questionCount: 2, courseId: "k2-c1" }, cookie: ADMIN });
eq(firstExam.status, 200, "H: FIRST course exam creates with its own 2 lesson-linked questions", JSON.stringify(firstExam.json));
const tooMany = await call("POST", "/api/admin/mock-exams", { body: { title: "First exam 3", schoolType: "ARABIC", questionCount: 3, courseId: "k2-c1" }, cookie: ADMIN });
eq(tooMany.status, 400, "H: FIRST exam cannot borrow SECOND lessons' questions to reach 3 (pool is course-isolated)");
const attached = await call("POST", "/api/admin/mock-exams", { body: { title: "First + attached", schoolType: "ARABIC", questionCount: 3, courseId: "k2-c1", questionIds: ["k2-q-free"] }, cookie: ADMIN });
eq(attached.status, 200, "H: the EXPLICIT admin attachment of a free-bank row is the documented way in (3 = 2 lesson-linked + 1 attached)", JSON.stringify(attached.json));
const crossPin = await call("POST", "/api/admin/mock-exams", { body: { title: "cross pin", schoolType: "ARABIC", selectionMode: "FIXED", courseId: "k2-c1", questionIds: ["k2-q-second-1"] }, cookie: ADMIN });
eq(crossPin.status, 400, "H: pinning ANOTHER course's lesson-linked question is refused");

eq(await Pool.loadMockExamLessonIds(null), [], "H: loadMockExamLessonIds(null) → [] (no course-less automatic lesson pool)");
eq(Pool.mockExamLessonWhere(null), { status: "PUBLISHED", id: { in: [] } }, "H: mockExamLessonWhere(null) matches NO lesson (fail closed)");
const firstIds = await Pool.loadMockExamLessonIds("k2-c1");
ok(firstIds.includes(l1row.id) && !firstIds.includes(secondLesson.id), "H: course scope resolves ONLY the exam's own lessons (both chains)");
const poolFirst = await Pool.countMockExamEligiblePool({ schoolType: "ARABIC", courseId: "k2-c1" });
eq([poolFirst.lessonLinked, poolFirst.bankOnly], [2, 0], "H: FIRST pool = 2 lesson-linked, 0 unattached free-bank rows");
const poolNull = await Pool.countMockExamEligiblePool({ schoolType: "ARABIC", courseId: null });
eq(poolNull.total, 0, "H: a course-less automatic pool is EMPTY (ambiguous free-bank rows excluded)");
const poolAttached = await Pool.countMockExamEligiblePool({ schoolType: "ARABIC", courseId: "k2-c1", mockExamId: attached.json.exam.id });
eq([poolAttached.lessonLinked, poolAttached.attached], [2, 1], "H: the attached free-bank row enters ONLY that exam's pool");
const elig = await call("GET", "/api/admin/mock-exams/eligible?schoolType=ARABIC&courseId=k2-c1", { cookie: ADMIN });
ok(elig.status === 200 && (elig.json.questions || []).every((q) => q.id !== "k2-q-second-1" && q.id !== "k2-q-second-2"), "H: eligible preview for the FIRST course never lists SECOND lesson questions");
// Legacy course-less row (pre-K2 data): publish requires a course; setting one is allowed; clearing is not.
db.prepare(`INSERT INTO "MockExam" ("id","title","titleAr","schoolType","courseId","questionCount","durationMin","passMark","difficulty","selectionMode","isPublished","createdAt","updatedAt") VALUES ('k2-legacy-exam','L','ل','ARABIC',NULL,1,30,60,'MIXED','RANDOM',0,?,?)`).run(NOW, NOW);
const pubLegacy = await call("PATCH", "/api/admin/mock-exams/k2-legacy-exam", { body: { isPublished: true }, cookie: ADMIN });
eq(pubLegacy.status, 409, "H: publishing a legacy course-less exam is refused until a course is bound");
const clearCourse = await call("PATCH", "/api/admin/mock-exams/k2-legacy-exam", { body: { courseId: "" }, cookie: ADMIN });
eq(clearCourse.status, 400, "H: clearing courseId is refused");
const bindLegacy = await call("PATCH", "/api/admin/mock-exams/k2-legacy-exam", { body: { courseId: "k2-c1" }, cookie: ADMIN });
eq(bindLegacy.status, 200, "H: binding a legacy exam to a course works");
eq(db.prepare(`SELECT "courseId" FROM "MockExam" WHERE "id"='k2-legacy-exam'`).get().courseId, "k2-c1", "H: binding persisted");
// Source pins: the "every course" fallback is gone from the pool module.
const poolSrc = fs.readFileSync(path.join(REPO, "src", "lib", "mock-exam-pool.ts"), "utf8");
ok(!/unitId: \{ not: null \}/.test(poolSrc), "H: the 'every course' lesson fallback no longer exists in mock-exam-pool.ts");
ok(/MULTI-LEVEL POOL SAFETY/.test(poolSrc) && /EXPLICITLY ATTACHED/.test(poolSrc), "H: explicit-attachment path is documented separately from automatic selection");
// Second Secondary behaviour: a course-bound SECOND exam still works.
const OFFICIAL_COURSE_ID = db.prepare(`SELECT "id" FROM "Course" WHERE "slug"='programming-ai-2nd-sec'`).get().id;
const secondExam = await call("POST", "/api/admin/mock-exams", { body: { title: "Second exam", schoolType: "ARABIC", questionCount: 2, courseId: OFFICIAL_COURSE_ID }, cookie: ADMIN });
eq(secondExam.status, 200, "H: course-bound SECOND SECONDARY (official course) exam still creates from its own lesson pool", JSON.stringify(secondExam.json));
const secondPool = await Pool.countMockExamEligiblePool({ schoolType: "ARABIC", courseId: OFFICIAL_COURSE_ID });
eq(secondPool.lessonLinked, 2, "H: the Second Secondary pool holds only its own lesson-linked rows (FIRST rows excluded)");

// ---------------------------------------------------------------------------
section("SUMMARY");
console.log("\n============================================================");
if (failures.length === 0) {
  console.log(`PHASE_K2_ACADEMIC_LEVEL_OK — ${pass} assertions passed`);
  process.exit(0);
} else {
  console.log(`PHASE_K2_ACADEMIC_LEVEL_FAIL — ${pass} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log("  - " + f);
  process.exit(1);
}
