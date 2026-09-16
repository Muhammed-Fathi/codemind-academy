// CodeMind Academy — Phase 26E PARENT PORTAL verifier.
//
// Drives the SHIPPED parent APIs (compiled from src/ with the repo's own tsc,
// exactly like scripts/verify-phase26c-admin.mjs and
// scripts/verify-phase26d-teacher.mjs do) against a REAL SQLite database built
// from the base DDL + every real migration.
//
// What is REAL here: the migration SQL, the schema, the compiled route
// handlers, the Phase 12 track predicates, the Phase 13 lifecycle filters, the
// Phase 19 canonical-curriculum chain, the Phase 26D attempt/retry semantics,
// the shared progress + progression engines and every authorization predicate.
//
// What is SHIMMED (and why):
//   * `@/lib/db`     → sqlite-prisma-lite over node:sqlite. It executes real SQL
//                      and throws UnsupportedQuery rather than approximating.
//   * `@/lib/auth`   → script-controlled current user (`requireUser` still runs
//                      for real, so every role gate below is genuinely enforced).
//   * `next/server`  → minimal NextResponse (status/headers/json).
//   * `next/headers` → no locale cookie (server falls back to `ar`).
//
// NO Neon, NO R2, NO SMTP, NO Vercel. Refuses to run if DATABASE_URL points at
// postgres/neon.
//
// Exit code 0 + `0 failed` iff every assertion holds. Executed as a child
// process by tests/phase26e-parent-full-flow.test.js.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");

const { DatabaseSync } = require("node:sqlite");
const mig = require("./lib/migrate-sqlite.mjs");
const { createSqlitePrisma } = require("./lib/sqlite-prisma-lite.mjs");

// ---------------------------------------------------------------------------
// 0. production safety gate
// ---------------------------------------------------------------------------
const envUrl = process.env.DATABASE_URL || "";
if (/postgres|neon/i.test(envUrl)) {
  console.error(`[26E] refusing to run: DATABASE_URL looks like production (${envUrl.slice(0, 40)}…)`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// assertion plumbing
// ---------------------------------------------------------------------------
let passed = 0;
const failures = [];
function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`ok - ${label}`);
  } else {
    failures.push(label);
    console.log(`FAIL - ${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
}
function eq(a, b, label) {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

// ---------------------------------------------------------------------------
// A. scratch database: base DDL + every real migration
// ---------------------------------------------------------------------------
const SCHEMA_TABLES = [
  "User", "Course", "Part", "Unit", "Topic", "Lesson", "Quiz", "Question",
  "QuizAttempt", "QuizAnswer", "QuizRetryGrant", "Homework", "HomeworkSubmission",
  "Group", "Teacher", "Student", "Parent", "ParentStudentLink", "Attendance",
  "LiveSession", "LessonProgress", "Subscription", "SubscriptionPlan",
  "TeacherNote", "Notification", "NotificationPreference", "ExamAttempt", "MockExam",
];

const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase26e: " });
for (const d of mig.assertColumnsMatchSchema(rawDb, SCHEMA_TABLES)) {
  ok(
    d.declared && d.missing.length === 0 && d.extra.length === 0,
    `A: ${d.table} columns match prisma/schema.prisma`,
    JSON.stringify({ missing: d.missing, extra: d.extra })
  );
}
{
  const linkIdx = rawDb.prepare(`SELECT name, "unique" AS u FROM pragma_index_list('ParentStudentLink')`).all();
  ok(
    linkIdx.filter((i) => i.u === 1).length >= 1,
    "A: ParentStudentLink enforces its unique constraints at the database level"
  );
  const attIdx = rawDb.prepare(`SELECT name, "unique" AS u FROM pragma_index_list('QuizAttempt')`).all();
  ok(
    attIdx.some((i) => i.u === 1),
    "A: QuizAttempt keeps the 26D (quiz, student, attemptNumber) unique index"
  );
}

const client = createSqlitePrisma({ db: rawDb, schemaPath: path.join(REPO, "prisma", "schema.prisma") });
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// B. compile the shipped TypeScript with the repo's own tsc; load with shims
// ---------------------------------------------------------------------------
const REAL_CODE_MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/security.ts",
  "src/lib/rate-limit.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/enrollment.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/session-quiz.ts",
  "src/lib/quiz-retry.ts",
  "src/lib/db-serialization.ts",
  "src/lib/quiz-analytics.ts",
  "src/lib/registration.ts",
  "src/lib/notify.ts",
  "src/lib/parent-access.ts",
  "src/lib/parent-subscription.ts",
  "src/lib/api.ts",
  // parent surfaces under test
  "src/app/api/parents/me/dashboard/route.ts",
  "src/app/api/parents/me/analytics/route.ts",
  "src/app/api/parents/me/weekly-report/route.ts",
  "src/app/api/parents/me/link-student/route.ts",
  "src/app/api/parents/me/notification-prefs/route.ts",
  "src/app/api/students/me/notification-prefs/route.ts",
  // shared content readers a parent may reach
  "src/app/api/courses/route.ts",
  "src/app/api/courses/[slug]/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/quizzes/[id]/route.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase26e-real-"));
  fs.writeFileSync(
    path.join(out, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2020", module: "commonjs", moduleResolution: "node",
        strict: false, skipLibCheck: true, esModuleInterop: true,
        resolveJsonModule: true, allowJs: false, types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO, paths: { "@/*": ["src/*"] }, rootDir: REPO, outDir: out,
      },
      files: REAL_CODE_MODULES.map((f) => path.join(REPO, f)),
    }, null, 2)
  );
  const tscBin = require.resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], { cwd: REPO, stdio: "pipe" });
  } catch {
    /* type noise elsewhere in the graph is tolerated; the emitted files matter */
  }
  for (const f of REAL_CODE_MODULES) {
    if (!fs.existsSync(path.join(out, f.replace(/\.ts$/, ".js")))) {
      throw new Error(`tsc did not emit ${f}`);
    }
  }
  return out;
}

const NEXT_SERVER_SHIM = `
class NextResponse {
  constructor(body, init = {}) {
    this.status = init.status ?? 200;
    this._headers = new Map();
    for (const [k, v] of Object.entries(init.headers || {})) this._headers.set(String(k).toLowerCase(), String(v));
    this._body = body; this._json = undefined;
  }
  static json(data, init = {}) {
    const r = new NextResponse(JSON.stringify(data), { status: init.status ?? 200, headers: { "content-type": "application/json" } });
    r._json = data; return r;
  }
  get headers() { const m = this._headers; return { get: (k) => m.get(String(k).toLowerCase()) ?? null }; }
  async json() {
    if (this._json !== undefined) return this._json;
    return JSON.parse(Buffer.from(this._body || "").toString("utf8"));
  }
}
class NextRequest {}
module.exports = { NextResponse, NextRequest };
`;
const NEXT_HEADERS_SHIM = `module.exports = { cookies: async () => ({ get: () => undefined }) };`;
const AUTH_SHIM = `module.exports = { getCurrentUser: async () => globalThis.__CM_USER__ ?? null };`;
const DB_SHIM = `module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };`;

function loadRealCode(outDir) {
  const { Module } = require("module");
  const files = {
    db: path.join(outDir, "__db-shim.js"),
    auth: path.join(outDir, "__auth-shim.js"),
    nextServer: path.join(outDir, "__next-server-shim.js"),
    nextHeaders: path.join(outDir, "__next-headers-shim.js"),
  };
  fs.writeFileSync(files.db, DB_SHIM);
  fs.writeFileSync(files.auth, AUTH_SHIM);
  fs.writeFileSync(files.nextServer, NEXT_SERVER_SHIM);
  fs.writeFileSync(files.nextHeaders, NEXT_HEADERS_SHIM);
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return files.db;
    if (request === "@/lib/auth") return files.auth;
    if (request === "next/server") return files.nextServer;
    if (request === "next/headers") return files.nextHeaders;
    const m = /^@\/lib\/([\w-]+)$/.exec(request);
    if (m) {
      const compiled = path.join(outDir, "src/lib", `${m[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    // Route-to-route imports (`@/app/api/…/route`) — the parent notification
    // preferences endpoint is a deliberate re-export of the students one.
    const a = /^@\/app\/(.+)$/.exec(request);
    if (a) {
      const compiled = path.join(outDir, "src/app", `${a[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    return originalResolve.call(this, request, ...rest);
  };
  const route = (p) => require(path.join(outDir, "src/app/api", p));
  const lib = (p) => require(path.join(outDir, "src/lib", p));
  return {
    restore() { Module._resolveFilename = originalResolve; },
    trackScope: lib("track-scope.js"),
    notify: lib("notify.js"),
    parentAccess: lib("parent-access.js"),
    parentSubscription: lib("parent-subscription.js"),
    pDash: route("parents/me/dashboard/route.js"),
    pAnalytics: route("parents/me/analytics/route.js"),
    pWeekly: route("parents/me/weekly-report/route.js"),
    pLink: route("parents/me/link-student/route.js"),
    pPrefs: route("parents/me/notification-prefs/route.js"),
    coursesList: route("courses/route.js"),
    courseBySlug: route("courses/[slug]/route.js"),
    lessonById: route("lessons/[id]/route.js"),
    quizById: route("quizzes/[id]/route.js"),
  };
}

// ---------------------------------------------------------------------------
// HTTP-lite driver
// ---------------------------------------------------------------------------
function jsonReq(url, body, method) {
  return {
    url,
    method: method || "GET",
    headers: { get: (k) => (String(k).toLowerCase() === "content-type" ? "application/json" : null) },
    json: async () => body,
    formData: async () => { throw new Error("no form body"); },
  };
}
function asUser(u) {
  globalThis.__CM_USER__ = u ? { id: u.id, email: u.email, name: u.name, role: u.role } : null;
}
async function call(handler, req, params) {
  let res;
  try {
    res = await handler(req, { params: Promise.resolve(params || {}) });
  } catch (e) {
    // A handler that throws is a 500 in production. Returning it lets an
    // assertion FAIL cleanly instead of aborting the whole verifier.
    return { status: 500, json: { error: String((e && e.message) || e) }, headers: { get: () => null } };
  }
  const ct = res.headers?.get?.("content-type") || "";
  if (ct.includes("application/json")) {
    return { status: res.status, json: await res.json(), headers: res.headers };
  }
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST = (r, url, body, params) => call(r.POST, jsonReq(url, body, "POST"), params);
const PUT = (r, url, body) => call(r.PUT, jsonReq(url, body, "PUT"));
const url = (p) => `http://127.0.0.1${p}`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const DAY = 24 * 60 * 60 * 1000;
const at = (days) => new Date(Date.now() + days * DAY);
const months = (n) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + n, Math.min(d.getDate(), 28), 12, 0, 0);
};

function childOf(dash, id) {
  return (dash.json.children || []).find((c) => c.id === id) || null;
}
function reportOf(weekly, id) {
  return (weekly.json.reports || []).find((r) => r.studentId === id) || null;
}
function anaOf(ana, id) {
  return (ana.json.children || []).find((c) => c.studentId === id) || null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const outDir = compileRealCode();
  ok(true, "B: shipped TS compiled with the repo tsc");
  const R = loadRealCode(outDir);
  ok(true, "B: route handlers loaded with db/auth/next shims");
  const restore = R.restore;

  // ---- C. fixtures --------------------------------------------------------
  section("C. fixtures");

  const mkUser = (email, name, role) =>
    client.user.create({ data: { email, password: "x", name, role } });

  const uPA = await mkUser("pa26e@cm.test", "Parent A", "PARENT");
  const uPB = await mkUser("pb26e@cm.test", "Parent B", "PARENT");
  const uPC = await mkUser("pc26e@cm.test", "Parent C", "PARENT");
  const uPD = await mkUser("pd26e@cm.test", "Parent D", "PARENT");
  const uT = await mkUser("t26e@cm.test", "Teacher 26E", "TEACHER");
  const uA = await mkUser("a26e@cm.test", "Admin 26E", "ADMIN");
  const uSAr = await mkUser("sar26e@cm.test", "Child Arabic", "STUDENT");
  const uSLang = await mkUser("slang26e@cm.test", "Child Language", "STUDENT");
  const uSNull = await mkUser("snull26e@cm.test", "Child Unspecified", "STUDENT");
  const uSB = await mkUser("sb26e@cm.test", "Child B", "STUDENT");
  const uSFree = await mkUser("sfree26e@cm.test", "Child Unenrolled", "STUDENT");
  const uSLink = await mkUser("slink26e@cm.test", "Child Linkable", "STUDENT");
  const uSRace = await mkUser("srace26e@cm.test", "Child Race", "STUDENT");
  const uSGhost = await mkUser("sghost26e@cm.test", "Child Ghost", "STUDENT");

  const teacher = await client.teacher.create({ data: { userId: uT.id } });

  const c1 = await client.course.create({ data: { slug: "p26e-c1", name: "Course One", nameAr: "كورس واحد", description: "d" } });
  const c2 = await client.course.create({ data: { slug: "p26e-c2", name: "Course Two", nameAr: "كورس اثنان", description: "d" } });
  const p1 = await client.part.create({ data: { courseId: c1.id, title: "Part 1", titleAr: "جزء ١", order: 1 } });
  const p2 = await client.part.create({ data: { courseId: c2.id, title: "Part 2", titleAr: "جزء ٢", order: 1 } });

  const uAr = await client.unit.create({ data: { partId: p1.id, title: "Arabic Unit", titleAr: "وحدة عربية", order: 1 } });
  const uLang = await client.unit.create({ data: { partId: p1.id, title: "Language Unit", titleAr: "وحدة لغة", order: 2 } });
  const uShared = await client.unit.create({ data: { partId: p1.id, title: "Shared Unit", titleAr: "وحدة مشتركة", order: 3 } });
  const uLegacy = await client.unit.create({ data: { partId: p1.id, title: "Legacy Unit", titleAr: "وحدة قديمة", order: 4 } });
  const topLegacy = await client.topic.create({ data: { unitId: uLegacy.id, title: "Legacy Topic", titleAr: "موضوع قديم", order: 4 } });
  const uDraft = await client.unit.create({ data: { partId: p1.id, title: "Draft Unit", titleAr: "وحدة مسودة", order: 6 } });
  const uArchived = await client.unit.create({ data: { partId: p1.id, title: "Archived Unit", titleAr: "وحدة مؤرشفة", order: 7 } });
  const uB = await client.unit.create({ data: { partId: p2.id, title: "Course Two Unit", titleAr: "وحدة ب", order: 1 } });

  const gAr = await client.group.create({ data: { name: "G Arabic", courseId: c1.id, teacherId: teacher.id, trackScope: "ARABIC" } });
  const gLang = await client.group.create({ data: { name: "G Language", courseId: c1.id, teacherId: teacher.id, trackScope: "LANGUAGE" } });
  const gNull = await client.group.create({ data: { name: "G Unclassified", courseId: c1.id, teacherId: teacher.id, trackScope: null } });
  const gB = await client.group.create({ data: { name: "G Course Two", courseId: c2.id, teacherId: teacher.id, trackScope: "ARABIC" } });

  const sAr = await client.student.create({ data: { userId: uSAr.id, groupId: gAr.id, schoolType: "ARABIC", nationalId: "30001011234567", parentPhone: "01100000001", studentCode: "CM-ARA001", grade: "2nd Secondary" } });
  const sLang = await client.student.create({ data: { userId: uSLang.id, groupId: gLang.id, schoolType: "LANGUAGE", nationalId: "30001011234568", parentPhone: "01100000002", studentCode: "CM-LNG002" } });
  const sNull = await client.student.create({ data: { userId: uSNull.id, groupId: gNull.id, schoolType: null, nationalId: "30001011234569", parentPhone: "01100000003", studentCode: "CM-NUL003" } });
  const sB = await client.student.create({ data: { userId: uSB.id, groupId: gB.id, schoolType: "ARABIC", nationalId: "30001011234570", parentPhone: "01100000004", studentCode: "CM-BBB004" } });
  const sFree = await client.student.create({ data: { userId: uSFree.id, groupId: null, schoolType: "ARABIC", nationalId: "30001011234571", parentPhone: "01100000005", studentCode: "CM-FRE005" } });
  const sLink = await client.student.create({ data: { userId: uSLink.id, groupId: gAr.id, schoolType: "ARABIC", nationalId: "39901011234567", parentPhone: "01147422177", studentCode: "CM-LNK001" } });
  const sRace = await client.student.create({ data: { userId: uSRace.id, groupId: gAr.id, schoolType: "ARABIC", nationalId: "39801011234567", parentPhone: "01100000006", studentCode: "CM-RAC001" } });
  // No stored parent phone → the three-factor match can never succeed (fail closed).
  const sGhost = await client.student.create({ data: { userId: uSGhost.id, groupId: gAr.id, schoolType: "ARABIC", nationalId: "39701011234567", parentPhone: null, studentCode: "CM-GHO001" } });

  const parentA = await client.parent.create({ data: { userId: uPA.id } });
  const parentB = await client.parent.create({ data: { userId: uPB.id } });
  const parentD = await client.parent.create({ data: { userId: uPD.id } });
  await client.parent.create({ data: { userId: uPC.id } }); // no children
  const link = (parentId, studentId, relation) =>
    client.parentStudentLink.create({ data: { parentId, studentId, relation: relation || "parent" } });
  await link(parentA.id, sAr.id);
  await link(parentA.id, sLang.id);
  await link(parentA.id, sNull.id);
  await link(parentA.id, sFree.id);
  await link(parentB.id, sB.id);

  const lesson = (data) => client.lesson.create({ data });
  const lShared = await lesson({ unitId: uShared.id, title: "Shared Session", titleAr: "حصة مشتركة", order: 1, status: "PUBLISHED", trackScope: "SHARED", officialCode: "26E-1", videoUrl: "https://v/1.mp4" });
  const lAr = await lesson({ unitId: uAr.id, title: "Arabic Session", titleAr: "حصة عربية", order: 2, status: "PUBLISHED", trackScope: "ARABIC", officialCode: "26E-2", videoUrl: "https://v/2.mp4" });
  const lLang = await lesson({ unitId: uLang.id, title: "Language Session", titleAr: "حصة لغة", order: 3, status: "PUBLISHED", trackScope: "LANGUAGE", officialCode: "26E-3", videoUrl: "https://v/3.mp4" });
  const lLegacy = await lesson({ topicId: topLegacy.id, title: "Legacy Session", titleAr: "حصة قديمة", order: 4, status: "PUBLISHED", trackScope: "ARABIC", curriculumStatus: "LEGACY", videoUrl: "https://v/4.mp4" });
  const lDraft = await lesson({ unitId: uDraft.id, title: "Draft Session", titleAr: "حصة مسودة", order: 5, status: "DRAFT", trackScope: "ARABIC", curriculumStatus: "LEGACY" });
  const lArchived = await lesson({ unitId: uArchived.id, title: "Archived Session", titleAr: "حصة مؤرشفة", order: 6, status: "PUBLISHED", trackScope: "ARABIC", curriculumStatus: "ARCHIVED" });
  const lB = await lesson({ unitId: uB.id, title: "Course Two Session", titleAr: "حصة ب", order: 1, status: "PUBLISHED", trackScope: "ARABIC", officialCode: "26E-9" });

  const quiz = (lessonId, trackScope, title, titleAr) =>
    client.quiz.create({ data: { lessonId, trackScope, title, titleAr, passMark: 60 } });
  const qShared = await quiz(lShared.id, "SHARED", "Shared Quiz", "اختبار مشترك");
  const qAr = await quiz(lAr.id, "ARABIC", "Arabic Quiz", "اختبار عربي");
  const qLang = await quiz(lLang.id, "LANGUAGE", "Language Quiz", "اختبار لغة");
  const qLegacy = await quiz(lLegacy.id, "ARABIC", "Legacy Quiz", "اختبار قديم");
  const qDraft = await quiz(lDraft.id, "ARABIC", "Draft Quiz", "اختبار مسودة");
  const qArchived = await quiz(lArchived.id, "ARABIC", "Archived Quiz", "اختبار مؤرشف");
  const qB = await quiz(lB.id, "ARABIC", "Course Two Quiz", "اختبار ب");

  // Phase 26D lineage: a retry grant explains attempt #2.
  const grant = await client.quizRetryGrant.create({
    data: { studentId: sAr.id, quizId: qAr.id, grantedByUserId: uA.id, grantedAt: at(-8), consumedAt: at(-6), reason: "Phase 26E retry" },
  });

  const attempt = (data) => client.quizAttempt.create({ data });
  // Arabic child — in-universe attempts (SHARED + ARABIC + legacy chain of c1)
  const atA1 = await attempt({ quizId: qAr.id, studentId: sAr.id, attemptNumber: 1, status: "SUBMITTED", score: 8, totalMarks: 20, percentage: 40, passed: false, startedAt: at(-12), finishedAt: at(-12) });
  const atA2 = await attempt({ quizId: qAr.id, studentId: sAr.id, attemptNumber: 2, status: "SUBMITTED", score: 16, totalMarks: 20, percentage: 80, passed: true, startedAt: at(-6), finishedAt: at(-6), retryGrantId: grant.id });
  const atA3 = await attempt({ quizId: qShared.id, studentId: sAr.id, attemptNumber: 1, status: "SUBMITTED", score: 10, totalMarks: 10, percentage: 100, passed: true, startedAt: at(-2), finishedAt: at(-2) });
  const atA4 = await attempt({ quizId: qLegacy.id, studentId: sAr.id, attemptNumber: 1, status: "SUBMITTED", score: 9, totalMarks: 10, percentage: 90, passed: true, startedAt: at(-1), finishedAt: at(-1) });
  const atA5 = await attempt({ quizId: qAr.id, studentId: sAr.id, attemptNumber: 3, status: "OPEN", score: 0, totalMarks: 0, percentage: 0, passed: false, startedAt: at(-0.2), finishedAt: null });
  // Arabic child — OUT-OF-UNIVERSE attempts that no parent screen may count,
  // name, or let move a number:
  const atA6 = await attempt({ quizId: qArchived.id, studentId: sAr.id, attemptNumber: 1, status: "SUBMITTED", score: 3, totalMarks: 10, percentage: 30, passed: false, startedAt: at(-3), finishedAt: at(-3) }); // archived lesson
  const atA7 = await attempt({ quizId: qLang.id, studentId: sAr.id, attemptNumber: 1, status: "SUBMITTED", score: 7, totalMarks: 10, percentage: 70, passed: true, startedAt: at(-3), finishedAt: at(-3) }); // other track
  const atA8 = await attempt({ quizId: qDraft.id, studentId: sAr.id, attemptNumber: 1, status: "SUBMITTED", score: 2, totalMarks: 10, percentage: 20, passed: false, startedAt: at(-4), finishedAt: at(-4) }); // staged lesson
  const atA9 = await attempt({ quizId: qB.id, studentId: sAr.id, attemptNumber: 1, status: "SUBMITTED", score: 5, totalMarks: 10, percentage: 55, passed: false, startedAt: at(-5), finishedAt: at(-5) }); // other course
  // Language child
  const atL1 = await attempt({ quizId: qLang.id, studentId: sLang.id, attemptNumber: 1, status: "SUBMITTED", score: 6, totalMarks: 10, percentage: 60, passed: true, startedAt: at(-2), finishedAt: at(-2) });
  const atL2 = await attempt({ quizId: qAr.id, studentId: sLang.id, attemptNumber: 1, status: "SUBMITTED", score: 2, totalMarks: 10, percentage: 25, passed: false, startedAt: at(-3), finishedAt: at(-3) }); // other track
  // Unspecified child — SHARED only (fail closed)
  const atN1 = await attempt({ quizId: qShared.id, studentId: sNull.id, attemptNumber: 1, status: "SUBMITTED", score: 5, totalMarks: 10, percentage: 50, passed: false, startedAt: at(-2), finishedAt: at(-2) });
  const atN2 = await attempt({ quizId: qLang.id, studentId: sNull.id, attemptNumber: 1, status: "SUBMITTED", score: 10, totalMarks: 10, percentage: 100, passed: true, startedAt: at(-1), finishedAt: at(-1) }); // other track
  // Parent B's child — course two only
  const atB1 = await attempt({ quizId: qB.id, studentId: sB.id, attemptNumber: 1, status: "SUBMITTED", score: 6, totalMarks: 10, percentage: 60, passed: true, startedAt: at(-1), finishedAt: at(-1) });
  const atB2 = await attempt({ quizId: qAr.id, studentId: sB.id, attemptNumber: 1, status: "SUBMITTED", score: 9, totalMarks: 10, percentage: 95, passed: true, startedAt: at(-2), finishedAt: at(-2) }); // other course

  const hw = (lessonId, trackScope, title, titleAr, maxMarks, deadlineDays) =>
    client.homework.create({ data: { lessonId, trackScope, title, titleAr, maxMarks, deadline: at(deadlineDays) } });
  const hwAr = await hw(lAr.id, "ARABIC", "Arabic Homework", "واجب عربي", 20, 3);
  const hwShared = await hw(lShared.id, "SHARED", "Shared Homework", "واجب مشترك", 10, 1);
  const hwLegacy = await hw(lLegacy.id, "SHARED", "Legacy Homework", "واجب قديم", 10, -2);
  const hwDraft = await hw(lDraft.id, "ARABIC", "Draft Homework", "واجب مسودة", 10, 5);
  const hwArchived = await hw(lArchived.id, "ARABIC", "Archived Homework", "واجب مؤرشف", 10, -9);
  const hwLang = await hw(lLang.id, "LANGUAGE", "Language Homework", "واجب لغة", 10, 2);
  const hwB = await hw(lB.id, "ARABIC", "Course Two Homework", "واجب ب", 10, 2);

  const sub = (homeworkId, studentId, status, grade, submittedAtDays, feedback) =>
    client.homeworkSubmission.create({ data: { homeworkId, studentId, status, grade, submittedAt: submittedAtDays === null ? null : at(submittedAtDays), feedback: feedback ?? null, content: "x" } });
  await sub(hwAr.id, sAr.id, "GRADED", 15, -2, "great");
  await sub(hwShared.id, sAr.id, "LATE", null, -3);
  await sub(hwLegacy.id, sAr.id, "GRADED", 9, -1);
  await sub(hwLang.id, sAr.id, "GRADED", 5, -2); // other track
  await sub(hwArchived.id, sAr.id, "GRADED", 10, -8); // archived lesson
  await sub(hwB.id, sAr.id, "GRADED", 8, -2); // other course
  await sub(hwDraft.id, sAr.id, "GRADED", 3, -4); // staged lesson
  await sub(hwAr.id, sLang.id, "GRADED", 20, -1); // other track for them
  await sub(hwLang.id, sLang.id, "GRADED", 7, -2); // their own assignment

  const sess = (groupId, startAtDays, status, titleAr, lessonId, teacherId) =>
    client.liveSession.create({
      data: { groupId, teacherId: teacherId ?? teacher.id, lessonId: lessonId ?? null, title: "Session", titleAr, startAt: at(startAtDays), status, duration: 90 },
    });
  const sessW1 = await sess(gAr.id, -2, "COMPLETED", "حصة مكتملة ١", lAr.id);
  const sessW2 = await sess(gAr.id, -8, "COMPLETED", "حصة مكتملة ٢", lAr.id);
  const sessW4 = await sess(gAr.id, -3, "COMPLETED", "حصة مكتملة ٤", lShared.id);
  const sessOld = await sess(gAr.id, -200, "COMPLETED", "حصة قديمة جدا", lAr.id);
  const sessL1 = await sess(gLang.id, -2, "COMPLETED", "حصة لغة", lLang.id);
  const sessOther = await sess(gLang.id, 1 / 24, "SCHEDULED", "حصة مجموعة أخرى", lLang.id);
  const lsSoon = await sess(gAr.id, 2 / 24, "SCHEDULED", "حصة قريبة", lDraft.id);
  await sess(gAr.id, 1, "SCHEDULED", "حصة غدا", lAr.id);
  await sess(gAr.id, -1, "COMPLETED", "حصة أمس", lAr.id);

  const att = (studentId, sessionId, status, createdAtDays) =>
    client.attendance.create({ data: { studentId, sessionId, status, createdAt: at(createdAtDays) } });
  await att(sAr.id, sessW1.id, "PRESENT", -2);
  await att(sAr.id, sessW2.id, "LATE", -1); // marked a day ago, for a class 8 days ago
  await att(sAr.id, sessW4.id, "PRESENT", -3);
  await att(sAr.id, sessOld.id, "ABSENT", -200);
  await att(sLang.id, sessL1.id, "PRESENT", -2);

  const prog = (studentId, lessonId, data) =>
    client.lessonProgress.create({ data: { studentId, lessonId, ...data } });
  // Arabic child
  await prog(sAr.id, lAr.id, { progress: 50, isCompleted: false, lastViewedAt: at(-1), videoPercent: 80, videoCompleted: true, videoCompletedAt: at(-1), videoWatchedSec: 600, lastHeartbeatAt: at(-1) });
  await prog(sAr.id, lShared.id, { progress: 100, isCompleted: true, lastViewedAt: at(-2), videoPercent: 50, videoCompleted: false, videoWatchedSec: 300, lastHeartbeatAt: at(-2) });
  await prog(sAr.id, lLang.id, { progress: 100, isCompleted: true, lastViewedAt: at(-2), videoPercent: 100, videoCompleted: true, videoCompletedAt: at(-2), videoWatchedSec: 9999, lastHeartbeatAt: at(-2) }); // other track
  await prog(sAr.id, lArchived.id, { progress: 100, isCompleted: true, lastViewedAt: at(-8), videoPercent: 100, videoCompleted: true, videoCompletedAt: at(-8), videoWatchedSec: 9999, lastHeartbeatAt: at(-8) }); // archived
  await prog(sAr.id, lDraft.id, { progress: 100, isCompleted: true, lastViewedAt: at(-9), videoPercent: 100, videoCompleted: true, videoCompletedAt: at(-9), videoWatchedSec: 9999, lastHeartbeatAt: at(-9) }); // staged
  // Language child
  await prog(sLang.id, lLang.id, { progress: 100, isCompleted: true, lastViewedAt: at(-2) });
  await prog(sLang.id, lAr.id, { progress: 100, isCompleted: true, lastViewedAt: at(-2) }); // other track
  // Parent B's child
  await prog(sB.id, lB.id, { progress: 100, isCompleted: true, lastViewedAt: at(-1) });

  const plan = await client.subscriptionPlan.create({ data: { name: "Plan A", nameAr: "خطة أ", durationMonths: 3, price: 1500 } });
  await client.subscription.create({ data: { studentId: sAr.id, planId: plan.id, status: "ACTIVE", startDate: at(-10), endDate: at(80) } });

  await client.teacherNote.create({ data: { teacherId: teacher.id, studentId: sAr.id, note: "ملاحظة المعلم للطالب" } });
  await client.teacherNote.create({ data: { teacherId: teacher.id, studentId: sB.id, note: "note for B" } });

  await client.notificationPreference.create({ data: { userId: uPA.id, newLesson: false, quietHoursStart: "22:00", quietHoursEnd: "06:00" } });
  const prefBDefault = await client.notificationPreference.create({ data: { userId: uPB.id } });

  const mock = await client.mockExam.create({ data: { title: "Mock One", titleAr: "محاكي واحد", schoolType: "ARABIC", isPublished: true } });
  await client.examAttempt.create({ data: { studentId: sAr.id, mockExamId: mock.id, examType: "MOCK", questionCount: 10, durationMin: 30, score: 11, totalMarks: 20, percentage: 55, passed: false, answers: "[]", startedAt: at(-4), finishedAt: at(-4) } });
  await client.examAttempt.create({ data: { studentId: sAr.id, mockExamId: mock.id, examType: "MOCK", questionCount: 10, durationMin: 30, score: 0, totalMarks: 0, percentage: 0, passed: false, answers: "[]", startedAt: at(-0.1), finishedAt: null } });

  ok(true, "C: fixtures created (2 parents, 6 students, 2 courses, 7 lessons, 7 quizzes, 18 attempts)");

  // keep the ids the assertions need
  const F = {
    uPA, uPB, uPC, uPD, uT, uA, uSAr, uSLang, uSNull, uSB, uSFree, uSLink, uSRace, uSGhost,
    c1, c2, p1, p2, uAr, uLang, uShared, topLegacy, uDraft, uArchived, uB,
    gAr, gLang, gNull, gB, sAr, sLang, sNull, sB, sFree, sLink, sRace, sGhost, parentA, parentB, parentD,
    lShared, lAr, lLang, lLegacy, lDraft, lArchived, lB,
    qShared, qAr, qLang, qLegacy, qDraft, qArchived, qB,
    atA1, atA2, atA3, atA4, atA5, atA6, atA7, atA8, atA9,
    atL1, atL2, atN1, atN2, atB1, atB2,
    hwAr, hwShared, hwLegacy, hwDraft, hwArchived, hwLang, hwB,
    sessW1, sessW2, sessW4, sessOld, sessL1, sessOther, lsSoon,
    plan, prefBDefault, mock, grant,
  };

  await runSections(R, F);
  restore();
}

async function runSections(R, F) {
  const {
    uPA, uPB, uPC, uPD, uSAr, uSB, uSFree, uSLink, uSRace, uSGhost, uT, uA,
    c1, c2, sAr, sLang, sNull, sB, sFree, sLink, sRace, sGhost, parentA, parentB, parentD,
    lShared, lAr, lLang, lLegacy, lDraft, lArchived, lB,
    qShared, qAr, qLang, qLegacy, qDraft, qArchived, qB,
    atA1, atA2, atA3, atA4, atA5, atA6, atA7, atA8, atA9,
    atL1, atL2, atN1, atN2, atB1, atB2,
    hwAr, hwShared, hwLegacy, hwDraft, hwArchived, hwLang, hwB,
    lsSoon, sessOther,
  } = F;

  const P = (u) => asUser(u);
  const ids = (arr, key) => (arr || []).map((x) => (key ? x[key] : x.id));
  const sortedAsc = (arr) => [...arr].sort((a, b) => a - b);
  const allText = (o) => JSON.stringify(o);

  // =========================================================================
  // D. authentication + role gates
  // =========================================================================
  section("D. authentication and role gates");
  P(null);
  for (const [name, run] of [
    ["dashboard", () => GET(R.pDash, url("/api/parents/me/dashboard"))],
    ["analytics", () => GET(R.pAnalytics, url("/api/parents/me/analytics"))],
    ["weekly-report", () => GET(R.pWeekly, url("/api/parents/me/weekly-report"))],
    ["link-student", () => POST(R.pLink, url("/api/parents/me/link-student"), {})],
    ["notification-prefs GET", () => GET(R.pPrefs, url("/api/parents/me/notification-prefs"))],
    ["notification-prefs PUT", () => PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), {})],
  ]) {
    const res = await run();
    eq(res.status, 401, `D: unauthenticated ${name} → 401`);
  }

  for (const [who, u] of [["student", uSAr], ["teacher", uT], ["admin", uA]]) {
    P(u);
    for (const [name, run] of [
      ["dashboard", () => GET(R.pDash, url("/api/parents/me/dashboard"))],
      ["analytics", () => GET(R.pAnalytics, url("/api/parents/me/analytics"))],
      ["weekly-report", () => GET(R.pWeekly, url("/api/parents/me/weekly-report"))],
      ["link-student", () => POST(R.pLink, url("/api/parents/me/link-student"), { studentNationalId: "30001011234567", parentPhone: "01100000001", studentCode: "CM-ARA001" })],
    ]) {
      const res = await run();
      eq(res.status, 403, `D: ${who} cannot call parent ${name} → 403`);
    }
  }

  // A parent without a Parent row cannot be served parent data.
  P(uPC);
  {
    const res = await GET(R.pDash, url("/api/parents/me/dashboard"));
    eq(res.status, 200, "D: a parent with no children still gets a dashboard (empty)");
    eq(res.json.parent.name, "Parent C", "D: the parent block describes the SESSION parent");
    eq(res.json.children.length, 0, "D: no children → empty child list");
    const ana = await GET(R.pAnalytics, url("/api/parents/me/analytics"));
    eq(ana.status, 200, "D: analytics for a childless parent → 200");
    eq(ana.json.children.length, 0, "D: analytics → empty child list");
    const wk = await GET(R.pWeekly, url("/api/parents/me/weekly-report"));
    eq(wk.status, 200, "D: weekly report for a childless parent → 200");
    eq(wk.json.reports.length, 0, "D: weekly report → empty report list");
  }

  // =========================================================================
  // E. ownership — never another parent's child, never a client-named child
  // =========================================================================
  section("E. ownership isolation");
  P(uPA);
  const dashA = await GET(R.pDash, url("/api/parents/me/dashboard"));
  const anaA = await GET(R.pAnalytics, url("/api/parents/me/analytics"));
  const wkA = await GET(R.pWeekly, url("/api/parents/me/weekly-report"));
  eq(dashA.status, 200, "E: ParentA dashboard → 200");
  eq(ids(dashA.json.children).sort(), [sAr.id, sLang.id, sNull.id, sFree.id].sort(), "E: dashboard lists EXACTLY ParentA's linked children");
  eq(ids(anaA.json.children, "studentId").sort(), [sAr.id, sLang.id, sNull.id, sFree.id].sort(), "E: analytics lists the same children");
  eq(ids(wkA.json.reports, "studentId").sort(), [sAr.id, sLang.id, sNull.id, sFree.id].sort(), "E: weekly report lists the same children");

  P(uPB);
  const dashB = await GET(R.pDash, url("/api/parents/me/dashboard"));
  const anaB = await GET(R.pAnalytics, url("/api/parents/me/analytics"));
  const wkB = await GET(R.pWeekly, url("/api/parents/me/weekly-report"));
  eq(ids(dashB.json.children), [sB.id], "E: ParentB sees only their own child");
  eq(ids(anaB.json.children, "studentId"), [sB.id], "E: ParentB analytics → only their own child");
  eq(ids(wkB.json.reports, "studentId"), [sB.id], "E: ParentB weekly → only their own child");
  for (const [label, payload] of [["dashboard", dashB.json], ["analytics", anaB.json], ["weekly", wkB.json]]) {
    const text = allText(payload);
    ok(!text.includes(sAr.id) && !text.includes(sLang.id) && !text.includes(sNull.id), `E: ParentA's children never appear in ParentB's ${label}`);
    ok(!text.includes("Child Arabic") && !text.includes("Child Language"), `E: ParentA's children NAMES never appear in ParentB's ${label}`);
  }
  for (const [label, payload] of [["dashboard", dashA.json], ["analytics", anaA.json], ["weekly", wkA.json]]) {
    const text = allText(payload);
    ok(!text.includes(sB.id) && !text.includes("Child B"), `E: ParentB's child never appears in ParentA's ${label}`);
  }

  // A client-supplied id can never widen the scope. Re-authenticate as
  // ParentA first: the probe must compare like with like.
  P(uPA);
  const qs = `?studentId=${sB.id}&parentId=${parentB.id}&courseId=${c2.id}&childId=${sB.id}&trackScope=LANGUAGE`;
  const dashQA = await GET(R.pDash, url(`/api/parents/me/dashboard${qs}`));
  const anaQA = await GET(R.pAnalytics, url(`/api/parents/me/analytics${qs}`));
  eq(ids(dashQA.json.children).sort(), ids(dashA.json.children).sort(), "E: query ids cannot widen the dashboard scope");
  eq(ids(anaQA.json.children, "studentId").sort(), ids(anaA.json.children, "studentId").sort(), "E: query ids cannot widen the analytics scope");
  ok(!allText(dashQA.json).includes("Child B"), "E: a foreign studentId in the URL changes nothing");
  ok(!allText(anaQA.json).includes("Child B"), "E: a foreign studentId in the analytics URL changes nothing");

  // =========================================================================
  // F. linking lifecycle
  // =========================================================================
  section("F. linking lifecycle");
  const linkCount = (parentId, studentId) =>
    rawDb.prepare(`SELECT COUNT(*) AS c FROM "ParentStudentLink" WHERE "parentId" = ? AND "studentId" = ?`).get(parentId, studentId).c;
  const GOOD = { studentNationalId: sLink.nationalId, parentPhone: "01147422177", studentCode: "CM-LNK001" };
  P(uPA);

  {
    const r = await POST(R.pLink, url("/api/parents/me/link-student"), {});
    eq(r.status, 400, "F: empty body → 400");
    const r2 = await POST(R.pLink, url("/api/parents/me/link-student"), { studentNationalId: sLink.nationalId });
    eq(r2.status, 400, "F: one factor only → 400 (all three are required)");
    const r3 = await POST(R.pLink, url("/api/parents/me/link-student"), { ...GOOD, studentNationalId: "12345" });
    eq(r3.status, 400, "F: malformed national id → 400");
    const r4 = await POST(R.pLink, url("/api/parents/me/link-student"), { ...GOOD, studentCode: "NOPE" });
    eq(r4.status, 400, "F: malformed student code → 400");
    const r5 = await POST(R.pLink, url("/api/parents/me/link-student"), { ...GOOD, parentPhone: "" });
    eq(r5.status, 400, "F: missing parent phone → 400");
    const r6 = await POST(R.pLink, url("/api/parents/me/link-student"), { studentEmail: "slink26e@cm.test" });
    eq(r6.status, 400, "F: legacy email-only linking stays rejected → 400");
  }

  {
    // Unknown (nationalId, code) pair vs a REAL pair with the wrong phone:
    // both must answer the SAME 404 so the endpoint is not an existence oracle.
    const unknown = await POST(R.pLink, url("/api/parents/me/link-student"), {
      studentNationalId: "30001999999999", parentPhone: "01147422177", studentCode: "CM-ZZZ999",
    });
    const wrongPhone = await POST(R.pLink, url("/api/parents/me/link-student"), {
      ...GOOD, parentPhone: "01000000009",
    });
    eq(unknown.status, 404, "F: unknown student pair → 404");
    eq(wrongPhone.status, 404, "F: correct pair but wrong parent phone → 404");
    eq(unknown.json.error, wrongPhone.json.error, "F: the two failures are INDISTINGUISHABLE (no existence oracle)");
    ok(!allText(unknown.json).includes("Child Linkable"), "F: a failed link never names the student");
    ok(!allText(wrongPhone.json).includes("Child Linkable"), "F: a phone mismatch never discloses the student's name/email/code");
    ok(!allText(wrongPhone.json).includes(sLink.nationalId) && !allText(wrongPhone.json).includes("CM-LNK001"), "F: no student PII in a failed link response");
    eq(linkCount(parentA.id, sLink.id), 0, "F: no link row was created by any failed attempt");
  }

  {
    // A student whose stored parent phone is missing can never be claimed.
    const ghost = await POST(R.pLink, url("/api/parents/me/link-student"), {
      studentNationalId: sGhost.nationalId, parentPhone: "01100000007", studentCode: sGhost.studentCode,
    });
    eq(ghost.status, 404, "F: a student with no stored parent phone fails closed → 404");
    eq(linkCount(parentA.id, sGhost.id), 0, "F: that student was not linked");
  }

  {
    // Happy path — case-insensitive code, normalized phone.
    const r = await POST(R.pLink, url("/api/parents/me/link-student"), {
      studentNationalId: sLink.nationalId,
      parentPhone: "0114 742 2177",
      studentCode: "cm-lnk001",
    });
    eq(r.status, 200, "F: verified link → 200 (code case + phone spacing normalised)");
    eq(r.json.linked?.id, sLink.id, "F: the response names the linked student");
    eq(linkCount(parentA.id, sLink.id), 1, "F: exactly one link row");
    const dash = await GET(R.pDash, url("/api/parents/me/dashboard"));
    ok(!!childOf(dash, sLink.id), "F: the newly linked child appears on the dashboard");
    eq(childOf(dash, sLink.id).relation, "parent", "F: an unspecified relation defaults to \"parent\"");
  }

  {
    // Idempotency: the same three factors again must not create a second row,
    // and must not rewrite the original relation/createdAt.
    const before = rawDb.prepare(`SELECT "relation", "createdAt" FROM "ParentStudentLink" WHERE "parentId" = ? AND "studentId" = ?`).get(parentA.id, sLink.id);
    const r = await POST(R.pLink, url("/api/parents/me/link-student"), { ...GOOD, relation: "guardian" });
    const after = rawDb.prepare(`SELECT "relation", "createdAt" FROM "ParentStudentLink" WHERE "parentId" = ? AND "studentId" = ?`).get(parentA.id, sLink.id);
    eq(r.status, 200, "F: re-linking the same student → 200");
    eq(linkCount(parentA.id, sLink.id), 1, "F: re-linking is idempotent (still ONE row)");
    eq(after.relation, before.relation, "F: an existing link keeps its original relation label");
    eq(String(after.createdAt), String(before.createdAt), "F: an existing link keeps its original createdAt");
  }

  {
    // Concurrency: a double-clicked submit for a FRESH pair must not 500.
    // The shipped route used findUnique-then-create; two requests could both
    // see "no link", and the loser surfaced as an unhandled UNIQUE violation.
    const raceBody = { studentNationalId: sRace.nationalId, parentPhone: "01100000006", studentCode: sRace.studentCode };
    const [r1, r2] = await Promise.all([
      POST(R.pLink, url("/api/parents/me/link-student"), raceBody),
      POST(R.pLink, url("/api/parents/me/link-student"), raceBody),
    ]);
    eq(sortedAsc([r1.status, r2.status]), [200, 200], "F: two concurrent first-time links BOTH answer 200");
    eq(linkCount(parentA.id, sRace.id), 1, "F: the concurrent pair produced exactly ONE link row");
  }

  {
    // The relation label is a bounded human word, never a client blob.
    await POST(R.pLink, url("/api/parents/me/link-student"), { ...GOOD, relation: "x".repeat(5000) });
    let row = rawDb.prepare(`SELECT "relation" FROM "ParentStudentLink" WHERE "parentId" = ? AND "studentId" = ?`).get(parentA.id, sLink.id);
    ok(String(row.relation).length <= 40, "F: an oversized relation is not persisted raw", `len=${String(row.relation).length}`);
    eq(row.relation, "parent", "F: an unrecognised relation falls back to \"parent\"");
    await POST(R.pLink, url("/api/parents/me/link-student"), { ...GOOD, relation: { evil: true } });
    row = rawDb.prepare(`SELECT "relation" FROM "ParentStudentLink" WHERE "parentId" = ? AND "studentId" = ?`).get(parentA.id, sLink.id);
    eq(row.relation, "parent", "F: a non-string relation can never be stored");
  }

  // A parent can never link a student via another parent's authority, and a
  // foreign parent's own verified link stays untouched by these attempts.
  {
    P(uPD);
    const r = await POST(R.pLink, url("/api/parents/me/link-student"), { ...GOOD });
    eq(r.status, 200, "F: the same three factors may be re-verified by a second parent (documented model)");
    eq(linkCount(parentD.id, sLink.id), 1, "F: the second parent got their OWN link row");
    eq(linkCount(parentA.id, sLink.id), 1, "F: the first parent's link is unchanged");
  }
  P(uPA);

  // =========================================================================
  // G. dashboard — the child's own academic truth
  // =========================================================================
  section("G. dashboard");
  const dash = await GET(R.pDash, url("/api/parents/me/dashboard"));
  const A = childOf(dash, sAr.id);
  const L = childOf(dash, sLang.id);
  const N = childOf(dash, sNull.id);
  const FREE = childOf(dash, sFree.id);
  ok(!!A && !!L && !!N && !!FREE, "G: every linked child has a payload (none dropped)");

  eq(A.name, "Child Arabic", "G: identity block");
  eq(A.group.name, "G Arabic", "G: child's group");
  eq(A.group.course.nameAr, "كورس واحد", "G: child's course (canonical Arabic name)");
  eq(A.relation, "parent", "G: link relation travels with the payload");

  // Course progress over the PUBLISHED, non-archived, in-course, in-track set.
  eq(A.courseProgress.total, 3, "G: universe = published, non-archived, own-course, own-track lessons (DRAFT/ARCHIVED/other-track/other-course excluded)");
  eq(A.courseProgress.completed, 1, "G: completed lessons count only in-universe completion");
  eq(A.courseProgress.pct, 50, "G: progress average is over the universe (100 + 50) / 3");
  eq(L.courseProgress.total, 2, "G: LANGUAGE child's universe = SHARED + LANGUAGE only");
  eq(L.courseProgress.completed, 1, "G: the ARABIC lesson's progress never counts for the LANGUAGE child");
  eq(L.courseProgress.pct, 50, "G: LANGUAGE child average (100 / 2)");
  eq(N.courseProgress.total, 1, "G: a NULL school type fails closed to SHARED only");
  eq(FREE.courseProgress.total, 0, "G: an unenrolled child has an empty universe (no crash)");
  eq(FREE.courseProgress.pct, 0, "G: empty universe → 0%, never NaN");

  // Quizzes: FINISHED, IN-UNIVERSE attempts, Phase 26D retry history intact.
  eq(A.quizzes.attempts, 4, "G: only finished, IN-UNIVERSE attempts are counted");
  eq(A.quizzes.passed, 3, "G: passed count");
  eq(A.quizzes.failed, 1, "G: failed count");
  eq(A.quizzes.average, 78, "G: quiz average over the in-universe attempts (40+80+100+90)/4");
  eq(A.quizzes.recent.length, 4, "G: recent list length");
  eq(A.quizzes.recent.map((r) => r.percentage), [90, 100, 80, 40], "G: recent list is newest-first and complete");
  eq(A.performanceTrend.map((t) => t.pct), [40, 80, 100, 90], "G: performance trend is chronological");
  eq(A.quizzes.recent[2].score, 16, "G: a retried attempt keeps its OWN score");
  eq(A.quizzes.recent[2].totalMarks, 20, "G: and its own totalMarks");
  eq(A.quizzes.recent[3].passed, false, "G: attempt #1 (before the retry) stays a failure — retry history is not overwritten");
  {
    // Scoped to THIS child's block: the payload legitimately carries a
    // LANGUAGE sibling, whose own block does name LANGUAGE content.
    const text = allText(A);
    for (const ex of [atA5, atA6, atA7, atA8, atA9]) {
      ok(!text.includes(ex.id), `G: attempt ${ex.id} (open/archived/other-track/draft/other-course) never appears`);
    }
    for (const title of ["اختبار لغة", "اختبار مسودة", "اختبار مؤرشف", "اختبار ب", "حصة لغة", "حصة مسودة", "حصة مؤرشفة", "حصة ب", "وحدة لغة", "وحدة مسودة", "وحدة مؤرشفة", "وحدة ب"]) {
      ok(!text.includes(title), `G: out-of-universe content title never leaks: ${title}`);
    }
    ok(sortedAsc(A.quizzes.recent.map((r) => r.percentage)).join(",") === "40,80,90,100", "G: the four in-universe attempts are exactly the reported set");
    ok(!A.quizzes.recent.some((r) => r.percentage === 70 || r.percentage === 30 || r.percentage === 20 || r.percentage === 55), "G: no out-of-universe percentage reaches the quiz lists");
  }

  // Mock exams stay in their own block and never move the quiz numbers.
  eq(A.mockExams.attempts, 1, "G: mock exams count finished ExamAttempts only");
  eq(A.mockExams.average, 55, "G: mock average");
  eq(A.mockExams.best, 55, "G: mock best");
  eq(A.mockExams.failed, 1, "G: mock failed count");
  eq(A.quizzes.average, 78, "G: a mock exam never moves the session-quiz average");

  // Homework parity with the same universe.
  eq(A.homework.total, 3, "G: homework denominator = the same in-universe set");
  eq(A.homework.submitted, 3, "G: submitted = SUBMITTED/GRADED/LATE in universe");
  eq(A.homework.graded, 2, "G: graded count");
  eq(A.homework.pending, 0, "G: pending = universe - submitted");
  eq(A.homework.completionPct, 100, "G: completion cannot exceed 100%");
  eq(A.homework.recent.length, 3, "G: recent homework list covers the universe");
  {
    const graded = A.homework.recent.filter((h) => h.status === "GRADED");
    eq(graded.map((h) => h.grade).sort((a, b) => a - b), [9, 15], "G: grades reported are the in-universe ones");
    eq(L.homework.total, 3, "G: the LANGUAGE child's homework universe is SHARED + LANGUAGE only");
    eq(L.homework.submitted, 1, "G: LANGUAGE child submission counted");
    eq(N.homework.total, 2, "G: SHARED-only child homework universe");
    eq(FREE.homework.total, 0, "G: unenrolled child → empty homework universe");
    eq(FREE.homework.completionPct, 0, "G: no division by zero");
  }

  // Attendance
  eq(A.attendance.total, 4, "G: attendance total");
  eq(A.attendance.present, 3, "G: PRESENT + LATE count as attended (the student rule)");
  eq(A.attendance.pct, 75, "G: attendance percentage");
  eq(A.attendance.byMonth.length, 6, "G: six monthly buckets");
  eq(A.attendance.byMonth.reduce((n, b) => n + b.total, 0), 3, "G: monthly buckets cover the last six months only (the 200-day-old row is outside them)");
  ok(A.attendance.byMonth.every((b) => b.pct >= 0 && b.pct <= 100), "G: every bucket percentage is in [0,100]");

  // Video progress — the shared service's numbers, track-sliced.
  eq(A.videoProgress.totalVideos, 3, "G: video denominator = the child's own published video-bearing lessons");
  eq(A.videoProgress.completedVideos, 1, "G: completed videos");
  eq(A.videoProgress.averagePercent, 43, "G: average is over ALL required videos, unwatched counting 0%");
  eq(A.videoProgress.completionPercent, 33, "G: completion percent");
  eq(A.videoProgress.totalWatchedMinutes, 15, "G: watched minutes");
  ok(Math.abs(new Date(A.videoProgress.lastWatchedAt).getTime() - at(-1).getTime()) < 5000, "G: last watched timestamp");
  eq(L.videoProgress.totalVideos, 2, "G: the LANGUAGE child is measured on their own videos only");

  // Session unlock state comes from the progression engine.
  ok(!!A.sessionProgress, "G: session progress present for an enrolled child");
  eq(A.sessionProgress.total, 3, "G: engine universe = published, non-archived, in-track sessions");
  eq(A.sessionProgress.completed, 1, "G: engine completed count");
  eq(A.sessionProgress.unlocked + A.sessionProgress.locked, A.sessionProgress.total, "G: unlocked + locked = total");
  ok(A.sessionProgress.unlocked >= 1 && A.sessionProgress.locked >= 0, "G: unlock state is internally consistent");
  ok(
    A.sessionProgress.currentLessonId === null || [lShared.id, lAr.id, lLegacy.id].includes(A.sessionProgress.currentLessonId),
    "G: the current session is always an in-universe lesson"
  );
  ok(A.sessionProgress.currentLessonTitle === null || ["حصة مشتركة", "حصة عربية", "حصة قديمة"].includes(A.sessionProgress.currentLessonTitle), "G: current session title is in-universe");
  eq(FREE.sessionProgress, null, "G: an unenrolled child has no session progress (never a fabricated 0)");

  // Subscription visibility
  eq(A.subscription.status, "ACTIVE", "G: subscription status");
  eq(A.subscription.planName, "خطة أ", "G: plan name (Arabic canonical)");
  eq(A.subscription.price, 1500, "G: plan price");
  eq(A.subscription.durationMonths, 3, "G: plan duration");
  ok(Math.abs(A.subscription.daysLeft - 80) <= 1, "G: days left is computed from endDate");
  eq(L.subscription, null, "G: a child with no subscription reports null, not a fabricated row");
  eq(FREE.subscription, null, "G: unenrolled child has no subscription");

  // Teacher notes
  eq(A.teacherNotes.length, 1, "G: teacher notes for this child only");
  eq(A.teacherNotes[0].note, "ملاحظة المعلم للطالب", "G: note body");
  eq(A.teacherNotes[0].teacherName, "Teacher 26E", "G: note author");
  eq(L.teacherNotes.length, 0, "G: a sibling's notes never leak into another child's block");

  // Next session
  ok(!!A.nextSession, "G: next session present");
  eq(A.nextSession.id, lsSoon.id, "G: the soonest SCHEDULED session of the child's OWN group");
  eq(A.nextSession.title, "حصة قريبة", "G: session title");
  eq(A.nextSession.lessonTitle, null, "G: a session attached to a STILL-STAGED lesson does not name it");
  eq(A.nextSession.teacherName, "Teacher 26E", "G: teacher name");
  ok(!allText(A).includes(sessOther.titleAr), "G: another group's session never appears");

  // Strong/weak topics use the canonical curriculum container.
  eq(A.strongTopics.map((t) => t.title), ["وحدة مشتركة", "موضوع قديم", "وحدة عربية"], "G: strong topics are the canonical containers of in-universe attempts");
  eq(A.strongTopics.map((t) => t.avgPct), [100, 90, 60], "G: topic averages");
  eq(A.weakTopics, [], "G: a topic never appears in both lists");
  eq(L.strongTopics.map((t) => t.title), ["وحدة لغة"], "G: the LANGUAGE child's topic list is their own");
  ok(!allText(A).includes("وحدة عربية") || A.strongTopics.some((t) => t.title === "وحدة عربية"), "G: Arabic container only from Arabic attempts");

  // Recent activity is a bounded, newest-first timeline.
  ok(A.recentActivity.length > 0 && A.recentActivity.length <= 8, "G: recent activity is bounded");
  {
    const times = A.recentActivity.map((a) => new Date(a.time).getTime());
    ok(times.every((t, i) => i === 0 || times[i - 1] >= t), "G: recent activity is sorted newest-first");
  }

  // Cross-child isolation inside ONE parent's payload.
  {
    const aPcts = A.quizzes.recent.map((r) => r.percentage).join(",");
    const lPcts = L.quizzes.recent.map((r) => r.percentage).join(",");
    eq(lPcts, "60", "G: the sibling's attempts never fold into this child's list");
    ok(aPcts !== lPcts, "G: each child reports their own attempt set");
    eq(L.quizzes.average, 60, "G: LANGUAGE child average");
    eq(N.quizzes.attempts, 1, "G: an UNSPECIFIED school type reports SHARED attempts only");
    eq(N.quizzes.average, 50, "G: and their own average (the 100% LANGUAGE attempt is excluded)");
    eq(FREE.quizzes.attempts, 0, "G: an unenrolled child has no attempts (no crash)");
    eq(FREE.quizzes.average, 0, "G: no division by zero");
  }

  // =========================================================================
  // H. analytics — same academic truth as the dashboard
  // =========================================================================
  section("H. analytics");
  eq(anaA.status, 200, "H: ParentA analytics → 200");
  const aA = anaOf(anaA, sAr.id);
  const aL = anaOf(anaA, sLang.id);
  const aN = anaOf(anaA, sNull.id);
  const aF = anaOf(anaA, sFree.id);
  eq(aA.totalLessons, 3, "H: analytics universe = the child's own curriculum");
  eq(aA.completedLessons, 1, "H: completed lessons are in-universe only");
  eq(aA.completionPct, 33, "H: completion percentage");
  eq(aA.totalQuizzes, 4, "H: total quizzes = in-universe finished attempts");
  eq(aA.avgQuizPct, 78, "H: average quiz percentage (same as the dashboard)");
  eq(aA.quizTrend.length, 4, "H: trend is the last 10 in-universe attempts");
  eq(aA.quizTrend.map((t) => t.percentage), [40, 80, 100, 90], "H: trend is chronological (oldest → newest)");
  eq(aA.homeworkSubmitted, 3, "H: homework submitted matches the dashboard");
  eq(aA.homeworkGraded, 2, "H: homework graded matches the dashboard");
  eq(aA.homeworkAvgGrade, 12, "H: average grade over the in-universe GRADED submissions (15+9)/2");
  eq(aA.attendancePct, 75, "H: attendance percentage matches the dashboard");
  eq(aA.attendanceByMonth.length, 6, "H: six monthly buckets");
  eq(aA.strongTopics.map((t) => t.title), ["وحدة مشتركة", "موضوع قديم", "وحدة عربية"], "H: strong topics align with the dashboard");
  eq(aA.weakTopics, [], "H: weak topics align with the dashboard");
  {
    const text = allText(aA);
    for (const ex of [atA5, atA6, atA7, atA8, atA9]) {
      ok(!text.includes(ex.id), `H: analytics never names attempt ${ex.id}`);
    }
    for (const title of ["اختبار لغة", "اختبار مسودة", "اختبار مؤرشف", "اختبار ب", "وحدة لغة", "وحدة مؤرشفة", "واجب لغة", "واجب ب"]) {
      ok(!text.includes(title), `H: analytics never names out-of-universe content: ${title}`);
    }
    ok(!text.includes("95") || !text.includes("Child B"), "H: a foreign child's numbers are absent");
  }
  eq(aL.totalQuizzes, 1, "H: the LANGUAGE child counts only their own attempts");
  eq(aL.avgQuizPct, 60, "H: LANGUAGE child average");
  eq(aL.totalLessons, 2, "H: LANGUAGE child universe");
  eq(aN.totalQuizzes, 1, "H: an unspecified school type fails closed to SHARED");
  eq(aF.totalQuizzes, 0, "H: unenrolled child → zeros");
  eq(aF.completionPct, 0, "H: unenrolled child → 0% (no division by zero)");
  eq(aF.homeworkAvgGrade, 0, "H: unenrolled child → 0 average (no NaN)");

  const aB = anaOf(anaB, sB.id);
  eq(aB.totalQuizzes, 1, "H: ParentB's child counts only course-two in-universe attempts");
  eq(aB.avgQuizPct, 60, "H: ParentB's child average (the course-one attempt is excluded)");
  eq(anaB.json.children.length, 1, "H: ParentB analytics lists exactly one child");

  // Consistency between the two parent screens (same child, same numbers).
  eq(aA.avgQuizPct, A.quizzes.average, "H: analytics and dashboard agree on the quiz average");
  eq(aA.homeworkSubmitted, A.homework.submitted, "H: analytics and dashboard agree on homework submitted");
  eq(aA.homeworkGraded, A.homework.graded, "H: analytics and dashboard agree on homework graded");
  eq(aA.attendancePct, A.attendance.pct, "H: analytics and dashboard agree on attendance");
  eq(aA.completionPct, Math.round((A.courseProgress.completed / A.courseProgress.total) * 100), "H: analytics completion and dashboard course progress describe the same universe");

  // =========================================================================
  // I. weekly report
  // =========================================================================
  section("I. weekly report");
  eq(wkA.status, 200, "I: weekly report → 200");
  const wA = reportOf(wkA, sAr.id);
  const wL = reportOf(wkA, sLang.id);
  const wF = reportOf(wkA, sFree.id);
  ok(!!wA && !!wL && !!wF, "I: every child has a report (none dropped)");
  eq(wA.summary.quizzesTaken, 3, "I: only finished, in-universe attempts INSIDE the 7-day window (80, 100, 90)");
  eq(wA.summary.bestQuizScore, 100, "I: best quiz this week");
  eq(wA.summary.avgQuizScore, 90, "I: average quiz this week (80 + 100 + 90) / 3");
  eq(wA.recentQuizzes.length, 3, "I: recent quizzes are the window's attempts");
  eq(wA.recentQuizzes.map((q) => q.percentage), [90, 100, 80], "I: recent quizzes are newest-first");
  eq(wA.summary.lessonsViewed, 2, "I: lessons viewed inside the window");
  eq(wA.summary.homeworkSubmitted, 3, "I: homework submitted inside the window");
  eq(wA.summary.attendanceSessions, 2, "I: attendance is windowed on WHEN THE CLASS HAPPENED (the 8-day-old class is out, even though its row was written yesterday)");
  eq(wA.summary.attendancePct, 100, "I: attendance percentage inside the window");
  eq(wA.summary.activeDays, 4, "I: active days = distinct days with lesson/quiz/homework activity");
  eq(wA.summary.completionPct, 33, "I: completion matches analytics");
  eq(wA.summary.completionPct, aA.completionPct, "I: weekly and analytics completion agree (same universe, same rule)");
  eq(wA.dailyActivity.length, 7, "I: seven daily buckets");
  eq(wA.dailyActivity.reduce((n, d) => n + d.quizzes, 0), 3, "I: daily quiz counts sum to the weekly total");
  eq(wA.dailyActivity.reduce((n, d) => n + d.homework, 0), 3, "I: daily homework counts sum to the weekly total");
  eq(wA.dailyActivity.reduce((n, d) => n + d.lessons, 0), 2, "I: daily lesson counts sum to the weekly total");
  eq(wA.dailyActivity.filter((d) => d.attendance).length, 2, "I: the daily breakdown sees exactly the same attendance sessions as the summary");
  ok(wA.dailyActivity.every((d) => ["PRESENT", "LATE", "ABSENT", "EXCUSED", null].includes(d.attendance)), "I: attendance status is a documented value or null");
  eq(wA.videoProgress.week.videosWatched, 2, "I: weekly video window uses the shared service (in-universe heartbeats only)");
  eq(wA.videoProgress.week.videosCompleted, 1, "I: weekly completed videos");
  eq(wA.videoProgress.week.watchedMinutes, 15, "I: weekly watched minutes");
  eq(wA.videoProgress.overall.totalVideos, 3, "I: overall video progress embedded");
  eq(wA.weekRange && typeof wA.weekRange.from === "string" && typeof wA.weekRange.to === "string", true, "I: the report states its window");
  {
    const text = allText(wA);
    for (const ex of [atA5, atA6, atA7, atA8, atA9]) {
      ok(!text.includes(ex.id), `I: weekly report never names attempt ${ex.id}`);
    }
    for (const title of ["اختبار لغة", "اختبار مسودة", "اختبار مؤرشف", "اختبار ب", "واجب لغة", "واجب ب", "وحدة لغة"]) {
      ok(!text.includes(title), `I: weekly report never names out-of-universe content: ${title}`);
    }
  }
  eq(wL.summary.quizzesTaken, 1, "I: the LANGUAGE child's weekly window is their own");
  eq(wL.summary.avgQuizScore, 60, "I: LANGUAGE child weekly average");
  eq(wF.summary.quizzesTaken, 0, "I: empty week → zeros, no crash");
  eq(wF.summary.attendancePct, 0, "I: empty week → 0% attendance (no division by zero)");
  eq(wF.summary.completionPct, 0, "I: child with no universe → 0%");
  eq(wF.dailyActivity.reduce((n, d) => n + d.quizzes + d.homework + d.lessons, 0), 0, "I: empty week → empty daily activity");
  {
    const wB = reportOf(wkB, sB.id);
    eq(wB.summary.quizzesTaken, 1, "I: ParentB's weekly report counts only their child's in-universe week");
  }

  // =========================================================================
  // J. notification preferences
  // =========================================================================
  section("J. notification preferences");
  P(uPA);
  {
    const get = await GET(R.pPrefs, url("/api/parents/me/notification-prefs"));
    eq(get.status, 200, "J: parent GET prefs → 200");
    eq(get.json.prefs.newLesson, false, "J: the parent's own stored preference is returned");
    eq(get.json.prefs.quietHoursStart, "22:00", "J: stored quiet hours are returned");
  }
  P(uPB);
  {
    const get = await GET(R.pPrefs, url("/api/parents/me/notification-prefs"));
    eq(get.status, 200, "J: GET on a user with no row → 200");
    eq(get.json.prefs.newLesson, true, "J: a missing row is materialised with safe defaults");
    const created = rawDb.prepare(`SELECT COUNT(*) AS c FROM "NotificationPreference" WHERE "userId" = ?`).get(uPB.id).c;
    eq(created, 1, "J: the default row belongs to the SESSION user");
    eq(get.json.prefs.userId, uPB.id, "J: the row is the caller's own");
  }
  P(uPA);
  {
    const put = await PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), {
      newLesson: true, quizResult: true, unknownKey: "x", emailEnabled: "yes", id: "hijack", userId: uPB.id,
    });
    eq(put.status, 200, "J: parent PUT prefs → 200");
    const row = rawDb.prepare(`SELECT * FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    eq(row.newLesson, 1, "J: a boolean key is written");
    eq(row.quizResult, 1, "J: another boolean key is written");
    eq(row.emailEnabled, 0, "J: a wrong-typed value is ignored, never coerced");
    ok(row.unknownKey === undefined && row.id !== "hijack", "J: unknown keys are not persisted (no mass assignment)");
    const rowB = rawDb.prepare(`SELECT * FROM "NotificationPreference" WHERE "userId" = ?`).get(uPB.id);
    eq(rowB.newLesson, 1, "J: a body-supplied userId cannot move another user's row");
  }
  {
    // Malformed values must not be stored as-is: an unparseable quiet hour can
    // never open its window, and the column has no length bound.
    const before = rawDb.prepare(`SELECT "quietHoursStart", "quietHoursEnd" FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    const put = await PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), {
      quietHoursStart: "not-a-time", quietHoursEnd: "99:99",
    });
    eq(put.status, 200, "J: malformed quiet hours → 200 (no crash)");
    const after = rawDb.prepare(`SELECT "quietHoursStart", "quietHoursEnd" FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    eq(after.quietHoursStart, before.quietHoursStart, "J: a malformed quiet-hour value is REJECTED, not stored");
    eq(after.quietHoursEnd, before.quietHoursEnd, "J: an out-of-range time is REJECTED, not stored");
  }
  {
    const put = await PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), { quietHoursStart: "07:30", quietHoursEnd: "09:00" });
    eq(put.status, 200, "J: valid quiet hours accepted");
    const row = rawDb.prepare(`SELECT "quietHoursStart", "quietHoursEnd" FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    eq([row.quietHoursStart, row.quietHoursEnd], ["07:30", "09:00"], "J: valid times are stored verbatim");
  }
  {
    const put = await PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), { quietHoursStart: null });
    eq(put.status, 200, "J: clearing quiet hours → 200");
    const row = rawDb.prepare(`SELECT "quietHoursStart" FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    eq(row.quietHoursStart, null, "J: explicit null clears the window");
  }
  {
    const put = await PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), { quietHoursStart: "x".repeat(5000) });
    eq(put.status, 200, "J: oversized quiet-hour payload → 200 (no crash)");
    const row = rawDb.prepare(`SELECT "quietHoursStart" FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    ok(row.quietHoursStart === null || String(row.quietHoursStart).length <= 5, "J: an unbounded string can never be persisted", `stored len=${row.quietHoursStart === null ? "null" : String(row.quietHoursStart).length}`);
  }
  {
    const payload = rawDb.prepare(`SELECT * FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    const put = await PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), { newLesson: false });
    eq(put.status, 200, "J: a well-formed partial update → 200");
    const after = rawDb.prepare(`SELECT * FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    eq(after.quizResult, payload.quizResult, "J: a partial update leaves untouched fields alone");
    eq(after.newLesson, 0, "J: and applies the supplied field");
  }
  {
    // A student using the same handler only ever touches their own row.
    P(uSAr);
    const before = rawDb.prepare(`SELECT "newLesson" FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    const put = await PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), { newLesson: false, userId: uPA.id });
    eq(put.status, 200, "J: the shared handler answers a student for their OWN row");
    const mine = rawDb.prepare(`SELECT COUNT(*) AS c FROM "NotificationPreference" WHERE "userId" = ?`).get(uSAr.id).c;
    eq(mine, 1, "J: the student's write landed on the student's own row");
    const parentRow = rawDb.prepare(`SELECT "newLesson" FROM "NotificationPreference" WHERE "userId" = ?`).get(uPA.id);
    eq(parentRow.newLesson, before.newLesson, "J: a student can never write a parent's preferences");
  }
  P(uPA);
  {
    // The fan-out helper consumes exactly what this route can store.
    await PUT(R.pPrefs, url("/api/parents/me/notification-prefs"), {
      newLesson: false, announcements: true, quietHoursStart: "22:00", quietHoursEnd: "06:00",
    });
    // Rows shaped exactly like Prisma returns them (booleans, not 0/1).
    const rows = await client.notificationPreference.findMany({
      where: { userId: { in: [uPA.id, uPB.id] } },
    });
    // uPB has no row at all → "missing row means defaults allow".
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const p1 = R.notify.partitionByNotificationPreferences([uPA.id, uPB.id], rows, "NEW_LESSON", noon);
    eq(p1.deliver, [uPB.id], "J: a preference turned OFF excludes exactly that user from the fan-out");
    eq(p1.skippedPreference, 1, "J: and the skip is reported as a preference skip");
    eq(p1.skipped[0].userId, uPA.id, "J: the skipped user is the one who disabled the type");
    const night = new Date();
    night.setHours(23, 30, 0, 0);
    const p2 = R.notify.partitionByNotificationPreferences([uPA.id, uPB.id], rows, "ANNOUNCEMENT", night);
    ok(!p2.deliver.includes(uPA.id), "J: quiet hours suppress delivery for the parent who set them");
    eq(p2.skippedQuietHours, 1, "J: the skip is reported as a quiet-hours skip");
    eq(p2.skipped[0].reason, "QUIET_HOURS", "J: and it is not confused with a preference skip");
    eq(R.notify.normalizeQuietHour("23:59"), "23:59", "J: the normaliser accepts a valid boundary");
    eq(R.notify.normalizeQuietHour("24:00"), undefined, "J: and rejects an out-of-range one");
    eq(R.notify.normalizeQuietHour(null), null, "J: null is an explicit clear");
    eq(R.notify.normalizeQuietHour("x".repeat(4000)), undefined, "J: and an oversized blob is discarded");
  }

  // =========================================================================
  // K. parent reads are read-only
  // =========================================================================
  section("K. read-only");
  {
    const tables = ["Lesson", "Quiz", "QuizAttempt", "Homework", "HomeworkSubmission", "Attendance", "LessonProgress", "Subscription", "ParentStudentLink", "TeacherNote"];
    const before = {};
    for (const t of tables) before[t] = rawDb.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    P(uPA);
    await GET(R.pDash, url("/api/parents/me/dashboard"));
    await GET(R.pAnalytics, url("/api/parents/me/analytics"));
    await GET(R.pWeekly, url("/api/parents/me/weekly-report"));
    await GET(R.pPrefs, url("/api/parents/me/notification-prefs"));
    await GET(R.coursesList, url("/api/courses"));
    await GET(R.lessonById, url(`/api/lessons/${lAr.id}`), { id: lAr.id });
    await GET(R.quizById, url(`/api/quizzes/${qAr.id}`), { id: qAr.id });
    const after = {};
    for (const t of tables) after[t] = rawDb.prepare(`SELECT COUNT(*) AS c FROM "${t}"`).get().c;
    eq(after, before, "K: parent GETs never create or delete academic rows");
  }

  // =========================================================================
  // L. shared content readers — a parent previews at most what a child may open
  // =========================================================================
  section("L. shared content readers");
  {
    const lesson = (id) => GET(R.lessonById, url(`/api/lessons/${id}`), { id });
    const quiz = (id) => GET(R.quizById, url(`/api/quizzes/${id}`), { id });
    const course = (slug) => GET(R.courseBySlug, url(`/api/courses/${slug}`), { slug });

    P(uPA);
    const ownCourse = await course("p26e-c1");
    eq(ownCourse.status, 200, "L: parent opens a course a child is enrolled in → 200");
    const foreignCourse = await course("p26e-c2");
    ok(foreignCourse.status !== 200, "L: parent cannot open a course no child is enrolled in");
    eq((await lesson(lAr.id)).status, 200, "L: published in-scope lesson → 200");
    eq((await lesson(lShared.id)).status, 200, "L: SHARED lesson → 200");
    eq((await lesson(lLegacy.id)).status, 200, "L: legacy-chain published lesson → 200");
    eq((await lesson(lDraft.id)).status, 404, "L: DRAFT lesson → 404");
    eq((await lesson(lArchived.id)).status, 404, "L: archived lesson → 404");
    eq((await lesson(lLang.id)).status, 200, "L: the LANGUAGE lesson is previewable because a linked child is in that track");
    eq((await lesson(lB.id)).status, 404, "L: another course's lesson → 404");
    eq((await quiz(qAr.id)).status, 200, "L: in-scope quiz → 200");
    eq((await quiz(qShared.id)).status, 200, "L: SHARED quiz → 200");
    eq((await quiz(qDraft.id)).status, 404, "L: a staged lesson's quiz → 404");
    eq((await quiz(qArchived.id)).status, 404, "L: an archived lesson's quiz → 404");
    eq((await quiz(qB.id)).status, 404, "L: a foreign course's quiz → 404");

    P(uPB);
    eq((await lesson(lAr.id)).status, 404, "L: a parent whose child is in another course cannot preview the lesson");
    eq((await lesson(lB.id)).status, 200, "L: their own course's lesson → 200");

    P(uPC);
    eq((await lesson(lAr.id)).status, 404, "L: a parent with no children previews nothing");
    ok((await course("p26e-c1")).status !== 200, "L: and cannot open a course");

    // The predicate itself, exercised as data.
    eq(R.trackScope.canAccessTrackScope("LANGUAGE", "LANGUAGE"), true, "L: the track predicate accepts the child's own track");
    eq(R.trackScope.canAccessTrackScope("LANGUAGE", "ARABIC"), false, "L: and refuses the other one");
    eq(R.trackScope.canAccessTrackScope(null, "SHARED"), true, "L: an unknown school type fails closed to SHARED only");
    eq(R.trackScope.canAccessTrackScope(null, "ARABIC"), false, "L: and never to a track-specific scope");
    eq(R.trackScope.canAccessTrackScope("ARABIC", "BOGUS"), false, "L: an unrecognised scope is refused, never treated as SHARED");

    // The complete parent-preview predicate (lifecycle + archive + track + course).
    // The helper takes the lesson's OWN course; passing a course the caller
    // is authorised for is exactly the bug this predicate exists to prevent.
    const preview = (userId, lesson, courseId) =>
      R.parentAccess.isParentLessonPreviewAllowed(userId, lesson, courseId);
    eq(await preview(uPA.id, lAr, c1.id), true, "L: an opened, in-track session is previewable");
    eq(await preview(uPA.id, lDraft, c1.id), false, "L: a staged session is NOT previewable");
    eq(await preview(uPA.id, lArchived, c1.id), false, "L: archived history is NOT previewable");
    eq(await preview(uPA.id, lLang, c1.id), true, "L: a linked LANGUAGE child makes that track previewable");
    eq(await preview(uPA.id, lB, c2.id), false, "L: another course's session is NOT previewable");
    eq(await preview(uPB.id, lAr, c1.id), false, "L: a parent whose child is elsewhere is refused");
    eq(await preview(uPC.id, lShared, c1.id), false, "L: a parent with no children is refused");
    eq(await preview(uPA.id, null, c1.id), false, "L: a missing lesson fails closed");
  }
}

main().then(() => {
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nFAILURES:");
    for (const f of failures) console.log(` - ${f}`);
    process.exit(1);
  }
  if (passed === 0) {
    console.error("no assertions ran");
    process.exit(1);
  }
  // Machine-readable completion marker (the 26D verifier's convention).
  console.log("PHASE26E_TEST_OK");
  process.exit(0);
}).catch((e) => {
  console.error("verifier crashed:", e);
  process.exit(2);
});
