// CodeMind Academy — Phase 26D TEACHER FULL FLOW + QUIZ ARCHITECTURE verifier.
//
// Drives the SHIPPED teacher, student and admin APIs (compiled from src/ with
// the repo's own tsc, exactly like scripts/verify-phase18-teacher.mjs and
// scripts/verify-phase26c-admin.mjs do) against a REAL SQLite database built
// from the base DDL + every real migration.
//
// What is REAL here: the migration SQL (including the new Phase 26D migration),
// the schema, the compiled route handlers, the blueprint selection service, the
// attempt state machine, the frozen question snapshots, the retry-grant model,
// server-side grading and every authorization predicate.
//
// What is SHIMMED (and why):
//   * `@/lib/db`     → sqlite-prisma-lite over node:sqlite. It executes real SQL
//                      and throws UnsupportedQuery rather than approximating.
//   * `@/lib/auth`   → script-controlled current user (`requireUser` still runs
//                      for real, so every role gate below is genuinely enforced).
//   * `next/server`  → minimal NextResponse (status/headers/json/bytes).
//   * `next/headers` → no locale cookie (server falls back to `ar`).
//
// NO Neon, NO R2, NO SMTP, NO Vercel. Refuses to run if DATABASE_URL points at
// postgres/neon.
//
// Exit code 0 + `0 failed` iff every assertion holds. Executed as a child
// process by tests/phase26d-teacher-full-flow.test.js.

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
  console.error(`[26D] refusing to run: DATABASE_URL looks like production (${envUrl.slice(0, 40)}…)`);
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
  "Group", "Teacher", "Student", "AuditLog", "Attendance", "LiveSession",
];

const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase26d: " });
for (const d of mig.assertColumnsMatchSchema(rawDb, SCHEMA_TABLES)) {
  ok(
    d.declared && d.missing.length === 0 && d.extra.length === 0,
    `A: ${d.table} columns match prisma/schema.prisma`,
    JSON.stringify({ missing: d.missing, extra: d.extra })
  );
}

// The Phase 26D unique index must exist, or "one attempt #N" is a convention
// rather than a database guarantee.
{
  const idx = rawDb.prepare(`SELECT name, "unique" AS u FROM pragma_index_list('QuizAttempt')`).all();
  const uniq = idx.find((i) => i.name === "QuizAttempt_quizId_studentId_attemptNumber_key");
  ok(!!uniq && uniq.u === 1, "A: QuizAttempt(quizId, studentId, attemptNumber) UNIQUE index exists");
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
  "src/lib/quiz-blueprint.ts",
  "src/lib/quiz-retry.ts",
  "src/lib/db-serialization.ts",
  "src/lib/quiz-analytics.ts",
  "src/lib/teacher-content.ts",
  "src/lib/parent-access.ts",
  "src/lib/api.ts",
  // teacher surfaces
  "src/app/api/teacher/dashboard/route.ts",
  "src/app/api/teacher/lessons/route.ts",
  "src/app/api/teacher/attendance/route.ts",
  "src/app/api/teacher/homework/route.ts",
  "src/app/api/teacher/homework/[id]/route.ts",
  "src/app/api/teacher/homework/[id]/publish/route.ts",
  "src/app/api/teacher/homework/[id]/grade/route.ts",
  "src/app/api/teacher/quizzes/route.ts",
  "src/app/api/teacher/quizzes/[id]/route.ts",
  "src/app/api/teacher/quizzes/[id]/questions/route.ts",
  "src/app/api/teacher/quizzes/[id]/attempts/route.ts",
  "src/app/api/teacher/questions/[id]/route.ts",
  "src/app/api/teacher/templates/route.ts",
  "src/app/api/teacher/templates/[id]/route.ts",
  "src/app/api/teacher/analytics/route.ts",
  // student quiz surfaces
  "src/app/api/quizzes/[id]/route.ts",
  "src/app/api/quizzes/[id]/start/route.ts",
  "src/app/api/quizzes/[id]/submit/route.ts",
  "src/app/api/quizzes/[id]/attempts/route.ts",
  // admin surfaces
  "src/app/api/admin/quiz-retries/route.ts",
  "src/app/api/admin/quiz-attempts/route.ts",
  "src/app/api/admin/quiz-attempts/[id]/route.ts",
  "src/app/api/admin/question-bank/route.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase26d-real-"));
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
    return originalResolve.call(this, request, ...rest);
  };
  const route = (p) => require(path.join(outDir, "src/app/api", p));
  const lib = (p) => require(path.join(outDir, "src/lib", p));
  return {
    restore() { Module._resolveFilename = originalResolve; },
    // The REAL limits constant, read from the compiled shipped module — not a
    // copy, so a limit change in src/ moves these assertions with it.
    limits: lib("teacher-content.js").TEACHER_LIMITS,
    blueprint: lib("quiz-blueprint.js"),
    serialization: lib("db-serialization.js"),
    tDashboard: route("teacher/dashboard/route.js"),
    tLessons: route("teacher/lessons/route.js"),
    tAttendance: route("teacher/attendance/route.js"),
    tHomework: route("teacher/homework/route.js"),
    tHomeworkById: route("teacher/homework/[id]/route.js"),
    tHomeworkPublish: route("teacher/homework/[id]/publish/route.js"),
    tHomeworkGrade: route("teacher/homework/[id]/grade/route.js"),
    tQuizzes: route("teacher/quizzes/route.js"),
    tQuizById: route("teacher/quizzes/[id]/route.js"),
    tQuizQuestions: route("teacher/quizzes/[id]/questions/route.js"),
    tQuizAttempts: route("teacher/quizzes/[id]/attempts/route.js"),
    tQuestionById: route("teacher/questions/[id]/route.js"),
    tTemplates: route("teacher/templates/route.js"),
    tTemplateById: route("teacher/templates/[id]/route.js"),
    tAnalytics: route("teacher/analytics/route.js"),
    quizDetail: route("quizzes/[id]/route.js"),
    quizStart: route("quizzes/[id]/start/route.js"),
    quizSubmit: route("quizzes/[id]/submit/route.js"),
    quizAttempts: route("quizzes/[id]/attempts/route.js"),
    aRetries: route("admin/quiz-retries/route.js"),
    aAttempts: route("admin/quiz-attempts/route.js"),
    aAttemptById: route("admin/quiz-attempts/[id]/route.js"),
    aQuestionBank: route("admin/question-bank/route.js"),
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
  const res = await handler(req, { params: Promise.resolve(params || {}) });
  const ct = res.headers?.get?.("content-type") || "";
  if (ct.includes("application/json")) {
    return { status: res.status, json: await res.json(), headers: res.headers };
  }
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()), headers: res.headers };
}
const GET = (r, url, params) => call(r.GET, jsonReq(url), params);
const POST = (r, url, body, params) => call(r.POST, jsonReq(url, body, "POST"), params);
const PATCH = (r, url, body, params) => call(r.PATCH, jsonReq(url, body, "PATCH"), params);
const DELETE = (r, url, params) => call(r.DELETE, jsonReq(url, undefined, "DELETE"), params);
const url = (p) => `http://127.0.0.1${p}`;

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const outDir = compileRealCode();
  ok(true, "B: shipped TS compiled with the repo tsc");
  const R = loadRealCode(outDir);
  const TEACHER_LIMITS = R.limits;
  ok(true, "B: route handlers loaded with db/auth/next shims");

  // ---- C. seed ------------------------------------------------------------
  section("C. fixtures");
  const adminUser = await client.user.create({ data: { email: "a26d@cm.test", password: "x", name: "Admin", role: "ADMIN" } });
  const teacherUserA = await client.user.create({ data: { email: "ta26d@cm.test", password: "x", name: "Teacher A", role: "TEACHER" } });
  const teacherUserB = await client.user.create({ data: { email: "tb26d@cm.test", password: "x", name: "Teacher B", role: "TEACHER" } });
  const studentUserAr = await client.user.create({ data: { email: "sar26d@cm.test", password: "x", name: "Student AR", role: "STUDENT" } });
  const studentUserAr2 = await client.user.create({ data: { email: "sar2b@cm.test", password: "x", name: "Student AR2", role: "STUDENT" } });
  const studentUserLang = await client.user.create({ data: { email: "slang26d@cm.test", password: "x", name: "Student LANG", role: "STUDENT" } });
  const parentUser = await client.user.create({ data: { email: "p26d@cm.test", password: "x", name: "Parent", role: "PARENT" } });

  const teacherA = await client.teacher.create({ data: { userId: teacherUserA.id } });
  const teacherB = await client.teacher.create({ data: { userId: teacherUserB.id } });

  const courseA = await client.course.create({ data: { slug: "p26d-a", name: "26D A", nameAr: "كورس أ", description: "d" } });
  const courseB = await client.course.create({ data: { slug: "p26d-b", name: "26D B", nameAr: "كورس ب", description: "d" } });
  const partA = await client.part.create({ data: { courseId: courseA.id, title: "Part A", titleAr: "جزء أ", order: 1 } });
  const partB = await client.part.create({ data: { courseId: courseB.id, title: "Part B", titleAr: "جزء ب", order: 1 } });
  const unitA = await client.unit.create({ data: { partId: partA.id, title: "Unit A", titleAr: "وحدة أ", order: 1 } });
  const unitB = await client.unit.create({ data: { partId: partB.id, title: "Unit B", titleAr: "وحدة ب", order: 1 } });

  const groupA = await client.group.create({ data: { name: "Group A", courseId: courseA.id, teacherId: teacherA.id, isActive: true, trackScope: "ARABIC" } });
  const groupB = await client.group.create({ data: { name: "Group B", courseId: courseB.id, teacherId: teacherB.id, isActive: true, trackScope: "ARABIC" } });

  const studentAr = await client.student.create({ data: { userId: studentUserAr.id, groupId: groupA.id, schoolType: "ARABIC" } });
  const studentAr2 = await client.student.create({ data: { userId: studentUserAr2.id, groupId: groupA.id, schoolType: "ARABIC" } });
  const studentLang = await client.student.create({ data: { userId: studentUserLang.id, groupId: groupA.id, schoolType: "LANGUAGE" } });

  const L = {};
  L.pub = await client.lesson.create({ data: { unitId: unitA.id, officialCode: "P26D-01", title: "Shared lesson", titleAr: "حصة مشتركة", order: 1, trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL" } });
  L.draft = await client.lesson.create({ data: { unitId: unitA.id, officialCode: "P26D-02", title: "Draft lesson", titleAr: "حصة مسودة", order: 2, trackScope: "SHARED", status: "DRAFT", curriculumStatus: "OFFICIAL" } });
  L.b = await client.lesson.create({ data: { unitId: unitB.id, officialCode: "P26D-B1", title: "Other course lesson", titleAr: "حصة كورس آخر", order: 1, trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL" } });
  ok(true, "C: fixtures created (2 teachers, 3 students, 2 courses, 3 lessons)");

  // A LEGACY quiz: created the pre-26D way (no blueprint columns supplied), so
  // every backward-compatibility assertion below runs against a real legacy row.
  const legacyQuiz = await client.quiz.create({ data: { lessonId: L.pub.id, title: "Legacy quiz", titleAr: "اختبار قديم", passMark: 50 } });
  for (let i = 0; i < 3; i++) {
    await client.question.create({ data: { quizId: legacyQuiz.id, prompt: `Legacy Q${i}`, options: '["a","b"]', answer: "0", difficulty: "MEDIUM", marks: 1 } });
  }
  const legacyRow = await client.quiz.findUnique({ where: { id: legacyQuiz.id } });
  eq(legacyRow.quizMode, "FIXED", "C: a legacy quiz defaults to quizMode=FIXED");
  eq(legacyRow.maxAttempts, 1, "C: a legacy quiz still gets the one-attempt default");
  eq(legacyRow.questionCount, null, "C: a legacy quiz has no blueprint count");

  // A BLUEPRINT quiz with a pool large enough to vary between attempts.
  const bpQuiz = await client.quiz.create({
    data: {
      lessonId: L.pub.id, title: "Blueprint quiz", titleAr: "اختبار مخطط", passMark: 50,
      quizMode: "BLUEPRINT", questionCount: 4, shuffleOptions: false, maxAttempts: 1,
      difficultyPlan: JSON.stringify({ EASY: 2, MEDIUM: 2 }),
    },
  });
  const bpQuestions = [];
  const poolSpec = [
    ["EASY", null], ["EASY", null], ["EASY", null], ["EASY", null],
    ["MEDIUM", null], ["MEDIUM", null], ["MEDIUM", null], ["MEDIUM", null],
    ["HARD", null], ["HARD", null],
  ];
  for (let i = 0; i < poolSpec.length; i++) {
    const q = await client.question.create({
      data: { quizId: bpQuiz.id, prompt: `Pool Q${i}`, options: JSON.stringify(["a", "b", "c", "d"]), answer: String(i % 4), difficulty: poolSpec[i][0], marks: 1, schoolType: poolSpec[i][1] },
    });
    bpQuestions.push(q);
  }
  ok(bpQuestions.length === 10, "C: blueprint quiz has a 10-question pool");

  // A track-mixed quiz, for pool containment.
  const trackQuiz = await client.quiz.create({ data: { lessonId: L.pub.id, title: "Track quiz", titleAr: "اختبار المسار", passMark: 50, quizMode: "BLUEPRINT", questionCount: 2 } });
  await client.question.create({ data: { quizId: trackQuiz.id, prompt: "Shared q", options: '["a","b"]', answer: "0", schoolType: null } });
  await client.question.create({ data: { quizId: trackQuiz.id, prompt: "Arabic q", options: '["a","b"]', answer: "0", schoolType: "ARABIC" } });
  await client.question.create({ data: { quizId: trackQuiz.id, prompt: "Language q", options: '["a","b"]', answer: "0", schoolType: "LANGUAGE" } });

  // A shuffle quiz.
  const shuffleQuiz = await client.quiz.create({ data: { lessonId: L.pub.id, title: "Shuffle quiz", titleAr: "اختبار خلط", passMark: 50, quizMode: "BLUEPRINT", questionCount: 1, shuffleOptions: true } });
  await client.question.create({ data: { quizId: shuffleQuiz.id, prompt: "Shuffle q", options: JSON.stringify(["o0", "o1", "o2", "o3"]), answer: "1", difficulty: "MEDIUM", marks: 1 } });

  // A foreign quiz on another teacher's course.
  const foreignQuiz = await client.quiz.create({ data: { lessonId: L.b.id, title: "Foreign quiz", titleAr: "اختبار غريب", passMark: 50 } });

  // =========================================================================
  section("D. TEACHER-01 auth / account gates");
  asUser(null);
  eq((await GET(R.tDashboard, url("/api/teacher/dashboard"))).status, 401, "TEACHER-01: anonymous → 401");
  asUser(studentUserAr);
  eq((await GET(R.tDashboard, url("/api/teacher/dashboard"))).status, 403, "TEACHER-01: student cannot reach the teacher dashboard → 403");
  eq((await GET(R.tAnalytics, url("/api/teacher/analytics"))).status, 403, "TEACHER-01: student cannot reach teacher analytics → 403");
  asUser(teacherUserA);
  eq((await GET(R.aAttempts, url("/api/admin/quiz-attempts"))).status, 403, "TEACHER-01: teacher cannot reach an ADMIN route → 403");
  eq((await GET(R.aRetries, url("/api/admin/quiz-retries"))).status, 403, "TEACHER-01: teacher cannot list retry grants → 403");
  eq((await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: studentAr.id, quizId: legacyQuiz.id })).status, 403, "TEACHER-15: teacher CANNOT grant a retry → 403");
  asUser(studentUserAr);
  eq((await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: studentAr.id, quizId: legacyQuiz.id })).status, 403, "TEACHER-15: student CANNOT grant a retry → 403");
  eq((await GET(R.aAttemptById, url("/api/admin/quiz-attempts/x"), { id: "x" })).status, 403, "TEACHER-01: student cannot reach admin attempt detail → 403");

  // =========================================================================
  section("E. TEACHER-02/03/04 dashboard + group/student scope");
  asUser(teacherUserA);
  const dash = await GET(R.tDashboard, url("/api/teacher/dashboard"));
  eq(dash.status, 200, "TEACHER-02: teacher dashboard → 200");
  const dashGroupIds = (dash.json.groups || []).map((g) => g.id);
  ok(dashGroupIds.includes(groupA.id), "TEACHER-03: assigned group is visible");
  ok(!dashGroupIds.includes(groupB.id), "TEACHER-03/21: a foreign group is absent (no cross-group leakage)");
  const dashStudents = (dash.json.groups || []).flatMap((g) => (g.students || []).map((s) => s.id));
  ok(dashStudents.includes(studentAr.id), "TEACHER-04: assigned student is visible");

  asUser(teacherUserB);
  const dashB = await GET(R.tDashboard, url("/api/teacher/dashboard"));
  const dashBGroupIds = (dashB.json.groups || []).map((g) => g.id);
  ok(dashBGroupIds.includes(groupB.id) && !dashBGroupIds.includes(groupA.id), "TEACHER-21: teacher B sees only group B");

  // =========================================================================
  section("F. TEACHER-05 attendance");
  asUser(teacherUserA);
  const sessionA = await client.liveSession.create({ data: { groupId: groupA.id, teacherId: teacherA.id, title: "S1", titleAr: "حصة 1", startAt: new Date(), duration: 60, status: "SCHEDULED" } });
  const attList = await GET(R.tAttendance, url(`/api/teacher/attendance?groupId=${groupA.id}&sessionId=${sessionA.id}`));
  eq(attList.status, 200, "TEACHER-05: attendance list → 200");
  ok((attList.json.students || []).length >= 2, "TEACHER-05: eligible students are listed");
  const attPost = await POST(R.tAttendance, url("/api/teacher/attendance"), {
    sessionId: sessionA.id,
    attendance: [{ studentId: studentAr.id, status: "PRESENT" }, { studentId: studentAr2.id, status: "ABSENT" }],
  });
  eq(attPost.status, 200, "TEACHER-05: marking attendance → 200");
  const attRow = await client.attendance.findFirst({ where: { studentId: studentAr.id, sessionId: sessionA.id } });
  eq(attRow.status, "PRESENT", "TEACHER-05: the attendance row was written");
  // Update the same student again — must update, not duplicate.
  await POST(R.tAttendance, url("/api/teacher/attendance"), { sessionId: sessionA.id, attendance: [{ studentId: studentAr.id, status: "LATE" }] });
  const attRows = await client.attendance.findMany({ where: { studentId: studentAr.id, sessionId: sessionA.id } });
  eq(attRows.length, 1, "TEACHER-05: re-marking updates in place (no duplicate row)");
  eq(attRows[0].status, "LATE", "TEACHER-05: the updated status is stored");
  // Foreign group refusal.
  const attForeign = await GET(R.tAttendance, url(`/api/teacher/attendance?groupId=${groupB.id}`));
  eq(attForeign.status, 403, "TEACHER-05/21: attendance for a foreign group → 403");

  // =========================================================================
  section("G. TEACHER-06 lessons");
  const lessons = await GET(R.tLessons, url("/api/teacher/lessons"));
  eq(lessons.status, 200, "TEACHER-06: lesson list → 200");
  const lessonIds = (lessons.json.lessons || []).map((l) => l.id);
  ok(lessonIds.includes(L.pub.id) && lessonIds.includes(L.draft.id), "TEACHER-06: DRAFT and PUBLISHED lessons of the own course are both listed");
  ok(!lessonIds.includes(L.b.id), "TEACHER-06/23: a lesson of another course is absent");

  // =========================================================================
  section("H. TEACHER-07/08/09 homework");
  const hwCreate = await POST(R.tHomework, url("/api/teacher/homework"), {
    lessonId: L.pub.id, title: "HW 26D", titleAr: "واجب", instructions: "do it",
    deadline: new Date(Date.now() + 86400000).toISOString(), maxMarks: 10,
  });
  eq(hwCreate.status, 200, "TEACHER-07: homework create → 200");
  const hwId = hwCreate.json.homework?.id;
  ok(!!hwId, "TEACHER-07: the homework id is returned");
  const hwPublish = await POST(R.tHomeworkPublish, url(`/api/teacher/homework/${hwId}/publish`), {}, { id: hwId });
  eq(hwPublish.status, 200, "TEACHER-07: homework publish → 200");
  const hwBadDeadline = await POST(R.tHomework, url("/api/teacher/homework"), {
    lessonId: L.pub.id, title: "HW bad", deadline: "not-a-date", maxMarks: 10,
  });
  ok(hwBadDeadline.status === 400, "TEACHER-07: an invalid deadline is refused → 400", `got ${hwBadDeadline.status}`);
  // A valid deadline is supplied on purpose: without one the request dies on
  // input validation (400) before ever reaching the ownership check, and the
  // assertion would be proving the wrong thing.
  // A valid deadline AND instructions are supplied on purpose: without them the
  // request dies on input validation (400) before ever reaching the ownership
  // check, and the assertion would be proving the wrong thing.
  const hwForeign = await POST(R.tHomework, url("/api/teacher/homework"), {
    lessonId: L.b.id, title: "HW foreign", maxMarks: 10,
    instructions: "foreign",
    deadline: new Date(Date.now() + 86400000).toISOString(),
  });
  eq(hwForeign.status, 403, "TEACHER-07/23: homework on a foreign lesson → 403");
  const hwEdit = await PATCH(R.tHomeworkById, url(`/api/teacher/homework/${hwId}`), { title: "HW 26D edited" }, { id: hwId });
  eq(hwEdit.status, 200, "TEACHER-08: homework edit → 200");
  // Student submits, teacher grades.
  await client.homeworkSubmission.create({ data: { homeworkId: hwId, studentId: studentAr.id, content: "my work", status: "SUBMITTED", submittedAt: new Date() } });
  const grade = await PATCH(R.tHomeworkGrade, url(`/api/teacher/homework/${hwId}/grade`), { studentId: studentAr.id, grade: 8, feedback: "good" }, { id: hwId });
  eq(grade.status, 200, "TEACHER-09: homework grading → 200");
  const subRow = await client.homeworkSubmission.findFirst({ where: { homeworkId: hwId, studentId: studentAr.id } });
  eq(subRow.status, "GRADED", "TEACHER-09: the submission is now GRADED");
  const gradeForeign = await PATCH(R.tHomeworkGrade, url(`/api/teacher/homework/${hwId}/grade`), { studentId: "nonexistent-student", grade: 8 }, { id: hwId });
  ok(gradeForeign.status >= 400, "TEACHER-09: grading a foreign/unknown student is refused", `got ${gradeForeign.status}`);

  // =========================================================================
  section("I. TEACHER-10/11 quiz authoring + blueprint");
  const qCreate = await POST(R.tQuizzes, url("/api/teacher/quizzes"), {
    lessonId: L.pub.id, title: "Authored quiz", titleAr: "اختبار",
    blueprint: { quizMode: "BLUEPRINT", questionCount: 2, difficultyPlan: { EASY: 1, MEDIUM: 1 }, maxAttempts: 1 },
    questions: [
      { type: "MCQ", prompt: "p1", options: ["a", "b"], answer: "0", difficulty: "EASY" },
      { type: "MCQ", prompt: "p2", options: ["a", "b"], answer: "1", difficulty: "MEDIUM" },
    ],
  });
  eq(qCreate.status, 200, "TEACHER-10: teacher creates a quiz → 200");
  const authoredQuizId = qCreate.json.quiz?.id;
  const authoredRow = await client.quiz.findUnique({ where: { id: authoredQuizId } });
  eq(authoredRow.quizMode, "BLUEPRINT", "TEACHER-11: the authored blueprint mode is persisted");
  eq(authoredRow.questionCount, 2, "TEACHER-11: the authored question count is persisted");
  eq(JSON.parse(authoredRow.difficultyPlan), { EASY: 1, MEDIUM: 1 }, "TEACHER-11: the authored difficulty plan is persisted");
  eq(authoredRow.maxAttempts, 1, "TEACHER-11: the attempt ceiling is persisted");
  // An invalid blueprint is refused, not silently clamped.
  const qBadPlan = await POST(R.tQuizzes, url("/api/teacher/quizzes"), {
    lessonId: L.pub.id, title: "Bad plan", questionCount: 1,
    blueprint: { quizMode: "BLUEPRINT", questionCount: 2, difficultyPlan: { EASY: 5 } },
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  ok(qBadPlan.status === 400, "TEACHER-11: a plan demanding more than the count is refused → 400", `got ${qBadPlan.status}`);
  const qBadCount = await POST(R.tQuizzes, url("/api/teacher/quizzes"), {
    lessonId: L.pub.id, title: "Bad count",
    blueprint: { quizMode: "BLUEPRINT", questionCount: 9999 },
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  ok(qBadCount.status === 400, "TEACHER-11: an out-of-range question count is refused → 400", `got ${qBadCount.status}`);
  // The list echoes the SAME resolved blueprint the start route applies.
  const tQuizzes = await GET(R.tQuizzes, url("/api/teacher/quizzes"));
  const listed = (tQuizzes.json.quizzes || []).find((q) => q.id === authoredQuizId);
  ok(!!listed && listed.blueprint && listed.blueprint.mode === "BLUEPRINT", "TEACHER-11: the teacher list echoes the resolved blueprint");
  // Foreign quiz management.
  const foreignDetail = await GET(R.tQuizById, url(`/api/teacher/quizzes/${foreignQuiz.id}`), { id: foreignQuiz.id });
  eq(foreignDetail.status, 403, "TEACHER-23: a foreign quiz is 403, not 404-content");

  // =========================================================================
  section("J. TEACHER-12 question bank");
  asUser(adminUser);
  const bank = await GET(R.aQuestionBank, url("/api/admin/question-bank?pageSize=5"));
  eq(bank.status, 200, "TEACHER-12: admin question bank → 200");
  asUser(teacherUserA);
  eq((await GET(R.aQuestionBank, url("/api/admin/question-bank"))).status, 403, "TEACHER-12: teacher cannot reach the ADMIN bank route → 403");
  const qPatch = await PATCH(R.tQuestionById, url(`/api/teacher/questions/${bpQuestions[0].id}`), { prompt: "Edited prompt" }, { id: bpQuestions[0].id });
  eq(qPatch.status, 200, "TEACHER-12: teacher edits a question in own scope → 200");
  asUser(teacherUserB);
  const qForeign = await PATCH(R.tQuestionById, url(`/api/teacher/questions/${bpQuestions[0].id}`), { prompt: "hijack" }, { id: bpQuestions[0].id });
  eq(qForeign.status, 403, "TEACHER-12/23: teacher B cannot edit teacher A's question → 403");

  // =========================================================================
  section("K. QUIZ ARCHITECTURE — blueprint, selection, freeze, one attempt");
  asUser(studentUserAr);

  // QUIZ-01/02/03 — server selects; client cannot choose ids.
  const preStart = await GET(R.quizDetail, url(`/api/quizzes/${bpQuiz.id}`), { id: bpQuiz.id });
  eq(preStart.status, 200, "QUIZ-01: blueprint quiz GET → 200");
  eq(preStart.json.quiz.quizMode, "BLUEPRINT", "QUIZ-01: the blueprint mode is exposed");
  eq(preStart.json.quiz.attemptRequired, true, "QUIZ-02: a blueprint quiz serves NO questions before /start");
  eq((preStart.json.questions || []).length, 0, "QUIZ-02/26: the pool is not handed to the client pre-start");

  const start1 = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), { cameraStatus: "NOT_REQUESTED", questionIds: bpQuestions.map((q) => q.id), attemptNumber: 7 }, { id: bpQuiz.id });
  eq(start1.status, 200, "QUIZ-02: /start → 200");
  eq(start1.json.attemptNumber, 1, "QUIZ-03: a client-supplied attemptNumber is ignored (server says 1)");
  const attempt1Id = start1.json.attemptId;

  const frozen = await client.quizAnswer.findMany({ where: { attemptId: attempt1Id } });
  eq(frozen.length, 4, "QUIZ-04: exactly questionCount questions were frozen");
  const frozenQs = await Promise.all(frozen.map((a) => client.question.findUnique({ where: { id: a.questionId } })));
  const diffs = frozenQs.map((q) => q.difficulty).sort();
  eq(diffs, ["EASY", "EASY", "MEDIUM", "MEDIUM"], "QUIZ-04: the difficulty plan was honoured exactly");
  ok(frozen.every((a) => a.promptSnapshot !== null && a.answerSnapshot !== null && a.optionsSnapshot !== null), "QUIZ-06: every frozen row carries a full snapshot");
  ok(frozen.every((a) => typeof a.orderIndex === "number"), "QUIZ-06: every frozen row carries its frozen position");

  // QUIZ-05/13 — no cross-track leakage.
  asUser(studentUserLang);
  const startLang = await POST(R.quizStart, url(`/api/quizzes/${trackQuiz.id}/start`), {}, { id: trackQuiz.id });
  eq(startLang.status, 200, "QUIZ-05: LANGUAGE student starts the track quiz → 200");
  const langFrozen = await client.quizAnswer.findMany({ where: { attemptId: startLang.json.attemptId } });
  const langPrompts = (await Promise.all(langFrozen.map((a) => client.question.findUnique({ where: { id: a.questionId } })))).map((q) => q.prompt).sort();
  ok(!langPrompts.includes("Arabic q"), "QUIZ-05/13: an ARABIC-only question is never frozen into a LANGUAGE attempt");
  asUser(studentUserAr);
  const startAr = await POST(R.quizStart, url(`/api/quizzes/${trackQuiz.id}/start`), {}, { id: trackQuiz.id });
  const arFrozen = await client.quizAnswer.findMany({ where: { attemptId: startAr.json.attemptId } });
  const arPrompts = (await Promise.all(arFrozen.map((a) => client.question.findUnique({ where: { id: a.questionId } })))).map((q) => q.prompt).sort();
  ok(!arPrompts.includes("Language q"), "QUIZ-05/13: a LANGUAGE-only question is never frozen into an ARABIC attempt");
  ok(arPrompts.includes("Arabic q") && arPrompts.includes("Shared q"), "QUIZ-05: the ARABIC attempt gets shared + ARABIC only");

  // QUIZ-10/11 — refresh / logout-login resume the SAME attempt.
  const resume1 = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), {}, { id: bpQuiz.id });
  eq(resume1.json.attemptId, attempt1Id, "QUIZ-10: a repeated /start resumes the same attempt (refresh)");
  eq(resume1.json.resumed, true, "QUIZ-10: the response reports resumed=true");
  asUser(null);
  asUser(studentUserAr);
  const resume2 = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), {}, { id: bpQuiz.id });
  eq(resume2.json.attemptId, attempt1Id, "QUIZ-11: logout/login resumes the same attempt");
  const frozenAfter = await client.quizAnswer.findMany({ where: { attemptId: attempt1Id } });
  eq(frozenAfter.length, 4, "QUIZ-06: resuming did not grow the frozen set");

  // QUIZ-07 — a bank edit must not rewrite the frozen attempt.
  const targetQ = frozenQs[0];
  // Capture the ORIGINAL key first: the pool's answers are `i % 4`, so one of
  // them really is "3" and hard-coding "3" as the "edited" value would make the
  // assertion below vacuous for that question.
  const originalAnswer = targetQ.answer;
  const editedAnswer = originalAnswer === "3" ? "0" : "3";
  await client.question.update({ where: { id: targetQ.id }, data: { prompt: "REWRITTEN PROMPT", answer: editedAnswer, marks: 99 } });
  const servedMid = await GET(R.quizDetail, url(`/api/quizzes/${bpQuiz.id}`), { id: bpQuiz.id });
  const servedTarget = (servedMid.json.questions || []).find((q) => q.id === targetQ.id);
  ok(!!servedTarget, "QUIZ-07: the frozen question is still served after a bank edit");
  ok(servedTarget.prompt !== "REWRITTEN PROMPT", "QUIZ-07: the served wording is the FROZEN one, not the edited one");
  ok((servedTarget.answer === undefined), "QUIZ-26: no answer key is served before submission");

  // QUIZ-14/12 — server grades; submit is terminal.
  const submit1 = await POST(R.quizSubmit, url(`/api/quizzes/${bpQuiz.id}/submit`), {
    answers: frozen.map((a) => ({ questionId: a.questionId, selected: "0" })),
    score: 999, percentage: 100, passed: true,
  }, { id: bpQuiz.id });
  eq(submit1.status, 200, "QUIZ-12: submit → 200");
  eq(submit1.json.status, "SUBMITTED", "QUIZ-12: the attempt is reported SUBMITTED");
  const att1Row = await client.quizAttempt.findUnique({ where: { id: attempt1Id } });
  ok(att1Row.score < 999, "QUIZ-14: a client-supplied score is ignored", `score=${att1Row.score}`);
  ok(att1Row.percentage <= 100 && att1Row.finishedAt !== null, "QUIZ-14: the server wrote its own score and finishedAt");
  eq(att1Row.status, "SUBMITTED", "QUIZ-12: the stored status is SUBMITTED");
  // The grading basis was the FROZEN answer, not the edited live one.
  const targetAnswerRow = frozen.find((a) => a.questionId === targetQ.id);
  const targetLive = await client.question.findUnique({ where: { id: targetQ.id } });
  eq(targetLive.answer, editedAnswer, "QUIZ-07: the live question really was edited (so the next assertion is meaningful)");
  eq(targetAnswerRow.answerSnapshot, originalAnswer, "QUIZ-07: the attempt kept the ORIGINAL answer key, not the edited one");

  // QUIZ-28 — duplicate submit is replay-safe.
  const submit2 = await POST(R.quizSubmit, url(`/api/quizzes/${bpQuiz.id}/submit`), {
    answers: frozen.map((a) => ({ questionId: a.questionId, selected: "1" })),
  }, { id: bpQuiz.id });
  eq(submit2.status, 409, "QUIZ-28: a duplicate submit is refused → 409");
  eq(submit2.json.code, "ATTEMPT_ALREADY_SUBMITTED", "QUIZ-28: the refusal is machine-readable");
  eq(submit2.json.percentage, att1Row.percentage, "QUIZ-28: the replay returns the ORIGINAL result, unchanged");
  const attCountAfterReplay = await client.quizAttempt.count({ where: { quizId: bpQuiz.id, studentId: studentAr.id } });
  eq(attCountAfterReplay, 1, "QUIZ-28/15: no second attempt was created by the replay");

  // QUIZ-08/09/13 — one attempt by default; a second start is denied.
  const start2 = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), {}, { id: bpQuiz.id });
  eq(start2.status, 409, "QUIZ-08/13: a second start after submit is refused → 409");
  eq(start2.json.code, "ATTEMPT_LIMIT_REACHED", "QUIZ-13: the refusal names the attempt limit");
  eq(start2.json.retryRequiresAdmin, true, "QUIZ-13: the refusal states a retry needs an Admin");
  const submitNoAttempt = await POST(R.quizSubmit, url(`/api/quizzes/${legacyQuiz.id}/submit`), { answers: [] }, { id: legacyQuiz.id });
  eq(submitNoAttempt.status, 409, "QUIZ-13: submit with no open attempt cannot manufacture one → 409");
  eq(submitNoAttempt.json.code, "ATTEMPT_NOT_STARTED", "QUIZ-13: and says so machine-readably");

  // QUIZ-27 — a forged question id outside the frozen set is ignored.
  // Deliberately created on its OWN throwaway quiz: a question added to bpQuiz
  // would be a legitimate pool member and could be selected honestly (making the
  // assertion meaningless), and adding it to legacyQuiz would change that quiz's
  // question count out from under the backward-compatibility assertions below.
  const strayQuiz = await client.quiz.create({ data: { lessonId: L.pub.id, title: "Stray quiz", titleAr: "اختبار دخيل", passMark: 50 } });
  const strayQuestion = await client.question.create({ data: { quizId: strayQuiz.id, prompt: "Stray", options: '["a","b"]', answer: "0", difficulty: "EASY", marks: 1 } });
  asUser(studentUserAr2);
  const startAr2 = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), {}, { id: bpQuiz.id });
  const ar2Frozen = await client.quizAnswer.findMany({ where: { attemptId: startAr2.json.attemptId } });
  const submitForged = await POST(R.quizSubmit, url(`/api/quizzes/${bpQuiz.id}/submit`), {
    answers: [
      ...ar2Frozen.map((a) => ({ questionId: a.questionId, selected: "0" })),
      { questionId: strayQuestion.id, selected: "0" },
    ],
  }, { id: bpQuiz.id });
  eq(submitForged.status, 200, "QUIZ-27: submit with an extra forged question still succeeds for the frozen set");
  ok(!(submitForged.json.answers || []).some((a) => a.questionId === strayQuestion.id), "QUIZ-27: the forged question is absent from the graded result");
  const strayRow = await client.quizAnswer.findFirst({ where: { attemptId: startAr2.json.attemptId, questionId: strayQuestion.id } });
  ok(!strayRow, "QUIZ-27: the forged question never became an answer row");

  // QUIZ-21 — variation.
  //
  // This used to assert "two students drew different sets". That was FLAKY and
  // has been removed: the pool is 4 EASY + 4 MEDIUM + 2 HARD and the plan asks
  // for 2 EASY + 2 MEDIUM, so there are only C(4,2)^2 = 36 possible papers and
  // two independent draws collide about 1 time in 36. A gate that fails ~3% of
  // runs proves nothing.
  //
  // What is asserted instead is (a) what is ALWAYS true of every real draw —
  // size and difficulty plan — and (b) variation itself, proven deterministically
  // against the real selector with its injectable RNG, where it is a property of
  // the code rather than a coin toss.
  const ar2Ids = ar2Frozen.map((a) => a.questionId).sort();
  const ar1Ids = frozen.map((a) => a.questionId).sort();

  const diffOf = (ids) => {
    const rows = bpQuestions.filter((q) => ids.includes(q.id));
    const by = { EASY: 0, MEDIUM: 0, HARD: 0 };
    for (const r of rows) by[r.difficulty] += 1;
    return by;
  };
  eq(ar1Ids.length, 4, "QUIZ-21: student 1's paper has exactly questionCount questions");
  eq(ar2Ids.length, 4, "QUIZ-21: student 2's paper has exactly questionCount questions");
  const d1 = diffOf(ar1Ids);
  const d2 = diffOf(ar2Ids);
  ok(d1.EASY === 2 && d1.MEDIUM === 2, "QUIZ-21: student 1's paper honours the 2 EASY + 2 MEDIUM plan");
  ok(d2.EASY === 2 && d2.MEDIUM === 2, "QUIZ-21: student 2's paper honours the 2 EASY + 2 MEDIUM plan");
  console.log(`   [26D] two real draws: ${JSON.stringify(ar1Ids)} vs ${JSON.stringify(ar2Ids)}`);

  // Deterministic variation proof against the SHIPPED selector.
  {
    // A seeded LCG: reproducible, so this assertion can never flake.
    const lcg = (seed) => {
      let st = seed >>> 0;
      return () => {
        st = (Math.imul(st, 1664525) + 1013904223) >>> 0;
        return st / 4294967296;
      };
    };
    const pool = bpQuestions.map((q) => ({
      id: q.id, difficulty: q.difficulty, schoolType: q.schoolType,
      marks: q.marks, type: q.type, prompt: q.prompt, options: q.options,
      answer: q.answer, createdAt: q.createdAt,
    }));
    const bp = R.blueprint.resolveQuizBlueprint({
      quizMode: "BLUEPRINT", questionCount: 4, shuffleOptions: false,
      difficultyPlan: JSON.stringify({ EASY: 2, MEDIUM: 2 }),
    });
    const pick = (seed) =>
      R.blueprint
        .selectAttemptQuestions({ pool, blueprint: bp, schoolType: null, random: lcg(seed) })
        .questions.map((q) => q.id).sort();

    const a = pick(1);
    const b = pick(2);
    const aAgain = pick(1);
    eq(JSON.stringify(a), JSON.stringify(aAgain), "QUIZ-21: the same RNG seed reproduces the SAME paper (randomness is injectable, not hidden)");
    ok(JSON.stringify(a) !== JSON.stringify(b), "QUIZ-21: different seeds produce DIFFERENT papers (variation is real)", `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

    // Across many seeds the selector must not collapse onto one paper.
    const distinct = new Set();
    for (let seed = 1; seed <= 40; seed++) distinct.add(JSON.stringify(pick(seed)));
    ok(distinct.size >= 10, `QUIZ-21: 40 seeds yield many distinct papers (got ${distinct.size})`);

    // Unused-first is a hard preference, so a retry reuses nothing when the
    // pool can avoid it.
    const first = pick(7);
    const retry = R.blueprint
      .selectAttemptQuestions({ pool, blueprint: bp, schoolType: null, previouslyUsedIds: first, random: lcg(99) })
      .questions.map((q) => q.id);
    const retryOverlap = retry.filter((id) => first.includes(id)).length;
    eq(retryOverlap, 0, "QUIZ-21: a retry with 6 unused eligible questions reuses NONE of the previous paper");
  }

  // =========================================================================
  section("L. QUIZ-16..20 Admin retry grant");
  asUser(adminUser);
  const grantBad = await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: "nope", quizId: bpQuiz.id });
  eq(grantBad.status, 404, "QUIZ-16: granting to a nonexistent student → 404");
  const grantBadQuiz = await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: studentAr.id, quizId: "nope" });
  eq(grantBadQuiz.status, 404, "QUIZ-16: granting on a nonexistent quiz → 404");
  const grantWrongCourse = await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: studentAr.id, quizId: foreignQuiz.id });
  eq(grantWrongCourse.status, 400, "QUIZ-16/23: granting across courses is refused → 400");
  const grantWrongTrack = await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: studentLang.id, quizId: bpQuiz.id });
  // bpQuiz is SHARED so a LANGUAGE student IS eligible; use the ARABIC-only path instead.
  const arOnlyQuiz = await client.quiz.create({ data: { lessonId: L.pub.id, title: "AR only", titleAr: "عربي فقط", passMark: 50, trackScope: "ARABIC" } });
  await client.question.create({ data: { quizId: arOnlyQuiz.id, prompt: "ar q", options: '["a","b"]', answer: "0" } });
  const grantTrack = await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: studentLang.id, quizId: arOnlyQuiz.id });
  eq(grantTrack.status, 400, "QUIZ-13/16: granting an ARABIC-only quiz to a LANGUAGE student → 400");
  void grantWrongTrack;

  const grant1 = await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: studentAr.id, quizId: bpQuiz.id, reason: "connection dropped" });
  eq(grant1.status, 201, "QUIZ-16: an Admin grant → 201");
  eq(grant1.json.attemptsGranted, 1, "QUIZ-19: exactly ONE attempt is granted");
  const grantRow = await client.quizRetryGrant.findUnique({ where: { id: grant1.json.grantId } });
  eq(grantRow.grantedByUserId, adminUser.id, "QUIZ-16/30: the grant records WHO granted it");
  eq(grantRow.consumedAt, null, "QUIZ-19: the grant starts unconsumed");
  const audit = await client.auditLog.findMany({ where: { action: "QUIZ_RETRY_GRANTED", entityId: grant1.json.grantId } });
  eq(audit.length, 1, "QUIZ-30: the grant wrote a QUIZ_RETRY_GRANTED audit entry");
  eq(audit[0].userId, adminUser.id, "QUIZ-30: the audit entry names the acting admin");
  ok(audit[0].details.includes("connection dropped"), "QUIZ-30: the audit entry carries the reason");

  const grantDup = await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: studentAr.id, quizId: bpQuiz.id });
  eq(grantDup.status, 409, "QUIZ-19: a second unconsumed grant is refused → 409");
  eq(grantDup.json.code, "ALREADY_PENDING", "QUIZ-19: and reports the pending grant");

  // QUIZ-20 — the grant is consumed by the attempt it permits.
  asUser(studentUserAr);
  const start3 = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), {}, { id: bpQuiz.id });
  eq(start3.status, 200, "QUIZ-16/20: with a grant, a further attempt starts → 200");
  eq(start3.json.attemptNumber, 2, "QUIZ-20: the granted attempt is sequence #2");
  eq(start3.json.usedRetryGrant, true, "QUIZ-20: the response reports the grant was used");
  const grantAfter = await client.quizRetryGrant.findUnique({ where: { id: grant1.json.grantId } });
  ok(!!grantAfter.consumedAt, "QUIZ-20: the grant is now CONSUMED");
  const att3 = await client.quizAttempt.findUnique({ where: { id: start3.json.attemptId } });
  eq(att3.retryGrantId, grant1.json.grantId, "QUIZ-20/23: the attempt records its grant lineage");

  // QUIZ-13 — the consumed grant cannot be spent twice.
  const start4 = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), {}, { id: bpQuiz.id });
  eq(start4.json.attemptId, start3.json.attemptId, "QUIZ-20: while attempt #2 is OPEN it is resumed, not duplicated");
  await POST(R.quizSubmit, url(`/api/quizzes/${bpQuiz.id}/submit`), { answers: [] }, { id: bpQuiz.id });
  const start5 = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), {}, { id: bpQuiz.id });
  eq(start5.status, 409, "QUIZ-13/20: a CONSUMED grant cannot be spent again → 409");
  eq(start5.json.code, "ATTEMPT_LIMIT_REACHED", "QUIZ-13: the limit is reported again");

  // QUIZ-15/22 — history preserved.
  const allAttempts = await client.quizAttempt.findMany({ where: { quizId: bpQuiz.id, studentId: studentAr.id }, orderBy: { attemptNumber: "asc" } });
  eq(allAttempts.length, 2, "QUIZ-15/22: both attempts still exist (history preserved)");
  eq(allAttempts.map((a) => a.attemptNumber), [1, 2], "QUIZ-15: attempt numbers are 1 and 2");
  ok(allAttempts.every((a) => a.finishedAt !== null), "QUIZ-15: no attempt was reopened or reset");

  // QUIZ-21 — the retry drew a different set where the pool allowed.
  const att3Ids = (await client.quizAnswer.findMany({ where: { attemptId: start3.json.attemptId } })).map((a) => a.questionId).sort();
  const overlap = att3Ids.filter((id) => ar1Ids.includes(id)).length;
  ok(att3Ids.length === 4, "QUIZ-21: the retry attempt also froze exactly questionCount questions");
  console.log(`   [26D] retry overlap: ${overlap}/4 (pool 10, previously used ${ar1Ids.length})`);
  // Deterministic, not probabilistic: attempt #1 took 2 EASY + 2 MEDIUM, so
  // exactly 2 EASY and 2 MEDIUM remain unused and the plan needs 2 of each.
  // Unused-first therefore forces zero reuse — assert the exact value.
  eq(overlap, 0, "QUIZ-21: the real retry reused NONE of the previous paper (unused-first is a hard preference)");

  // =========================================================================
  section("M. QUIZ-23/24/25 attempt inspection");
  asUser(adminUser);
  const aList = await GET(R.aAttempts, url("/api/admin/quiz-attempts"));
  eq(aList.status, 200, "QUIZ-23: admin attempt list → 200");
  ok((aList.json.attempts || []).length >= 4, "QUIZ-23: the admin list returns attempts across students");
  const aFiltered = await GET(R.aAttempts, url(`/api/admin/quiz-attempts?studentId=${studentAr.id}&quizId=${bpQuiz.id}`));
  eq((aFiltered.json.attempts || []).length, 2, "QUIZ-23: the admin list filters by student + quiz");
  const aRetried = await GET(R.aAttempts, url(`/api/admin/quiz-attempts?retried=1&quizId=${bpQuiz.id}`));
  eq((aRetried.json.attempts || []).length, 1, "QUIZ-23: retried=1 isolates the grant-permitted attempt");
  const aDetail = await GET(R.aAttemptById, url(`/api/admin/quiz-attempts/${start3.json.attemptId}`), { id: start3.json.attemptId });
  eq(aDetail.status, 200, "QUIZ-23: admin attempt detail → 200");
  eq(aDetail.json.attempt.attemptNumber, 2, "QUIZ-23: the detail reports the sequence number");
  ok(!!aDetail.json.attempt.retryGrant, "QUIZ-23: the detail carries the retry lineage");
  eq(aDetail.json.attempt.retryGrant.grantedByName, "Admin", "QUIZ-23: the lineage names the granter");
  eq((aDetail.json.history || []).length, 2, "QUIZ-23: the detail lists the full attempt history");
  eq(aDetail.json.attempt.questions.length, 4, "QUIZ-23: the detail lists the frozen questions");
  const adminListKeys = aList.json.attempts || [];
  ok(adminListKeys.every((a) => !("questions" in a)), "QUIZ-26: the admin LIST ships no questions and therefore no answer keys");

  // QUIZ-24 — teacher scoped inspection.
  asUser(teacherUserA);
  const tAtt = await GET(R.tQuizAttempts, url(`/api/teacher/quizzes/${bpQuiz.id}/attempts`), { id: bpQuiz.id });
  eq(tAtt.status, 200, "QUIZ-24: teacher inspects attempts of an own quiz → 200");
  eq(tAtt.json.canGrantRetry, false, "QUIZ-17: the teacher surface states it cannot grant retries");
  ok((tAtt.json.attempts || []).length >= 3, "QUIZ-24: the teacher sees the attempts of their own course's quiz");
  const tAttForeign = await GET(R.tQuizAttempts, url(`/api/teacher/quizzes/${foreignQuiz.id}/attempts`), { id: foreignQuiz.id });
  eq(tAttForeign.status, 403, "QUIZ-24/23: teacher cannot inspect a foreign quiz's attempts → 403");

  // QUIZ-25 — student sees only their own.
  asUser(studentUserAr);
  const sAtt = await GET(R.quizAttempts, url(`/api/quizzes/${bpQuiz.id}/attempts`), { id: bpQuiz.id });
  eq(sAtt.status, 200, "QUIZ-25: student reads own attempt history → 200");
  eq((sAtt.json.attempts || []).length, 2, "QUIZ-25: the student sees exactly their own two attempts");
  eq(sAtt.json.entitlement.attemptsUsed, 2, "QUIZ-25: the entitlement reports attempts used");
  eq(sAtt.json.entitlement.retryRequiresAdmin, true, "QUIZ-25: and that a retry requires an Admin");
  ok(sAtt.json.attempts.every((a) => a.retryGrant === null || Object.keys(a.retryGrant).length === 1), "QUIZ-25: the student never sees WHO granted the retry");
  asUser(studentUserLang);
  const sAttOther = await GET(R.quizAttempts, url(`/api/quizzes/${bpQuiz.id}/attempts`), { id: bpQuiz.id });
  eq((sAttOther.json.attempts || []).length, 0, "QUIZ-25: another student sees none of student AR's attempts");

  // QUIZ-26 — no answer key for an OPEN attempt.
  asUser(studentUserAr2);
  // A fresh student with a genuinely OPEN attempt (studentAr2's was submitted
  // above), so the "no key while open" rule is tested against a real open row.
  const ar3User = await client.user.create({ data: { email: "sar3@cm.test", password: "x", name: "Student AR3", role: "STUDENT" } });
  await client.student.create({ data: { userId: ar3User.id, groupId: groupA.id, schoolType: "ARABIC" } });
  asUser(ar3User);
  const openStart = await POST(R.quizStart, url(`/api/quizzes/${bpQuiz.id}/start`), {}, { id: bpQuiz.id });
  eq(openStart.status, 200, "QUIZ-26: a fresh student can start the quiz");
  asUser(adminUser);
  const openInspect = await GET(R.aAttemptById, url(`/api/admin/quiz-attempts/${openStart.json.attemptId}`), { id: openStart.json.attemptId });
  eq(openInspect.json.attempt.answerKeyRevealed, false, "QUIZ-26: an OPEN attempt reveals no answer key, even to Admin");
  ok((openInspect.json.attempt.questions || []).every((q) => q.correctAnswer === undefined), "QUIZ-26: no correctAnswer field on an OPEN attempt");

  // =========================================================================
  section("N. QUIZ-29 backward compatibility (legacy FIXED quiz)");
  asUser(studentUserAr);
  const legacyStart = await POST(R.quizStart, url(`/api/quizzes/${legacyQuiz.id}/start`), {}, { id: legacyQuiz.id });
  eq(legacyStart.status, 200, "QUIZ-29: a legacy FIXED quiz still starts → 200");
  const legacyFrozen = await client.quizAnswer.findMany({ where: { attemptId: legacyStart.json.attemptId } });
  eq(legacyFrozen.length, 3, "QUIZ-29: a FIXED quiz freezes ALL its questions (legacy behaviour intact)");
  const legacyDetail = await GET(R.quizDetail, url(`/api/quizzes/${legacyQuiz.id}`), { id: legacyQuiz.id });
  eq(legacyDetail.json.quiz.attemptRequired, false, "QUIZ-29: a FIXED quiz does not require /start before serving questions");
  ok((legacyDetail.json.questions || []).length === 3, "QUIZ-29: the legacy quiz serves its questions");
  const legacySubmit = await POST(R.quizSubmit, url(`/api/quizzes/${legacyQuiz.id}/submit`), {
    answers: legacyFrozen.map((a) => ({ questionId: a.questionId, selected: "0" })),
  }, { id: legacyQuiz.id });
  eq(legacySubmit.status, 200, "QUIZ-29: a legacy quiz still grades → 200");
  eq(legacySubmit.json.percentage, 100, "QUIZ-29: and grades correctly against the frozen key");
  const legacySecond = await POST(R.quizStart, url(`/api/quizzes/${legacyQuiz.id}/start`), {}, { id: legacyQuiz.id });
  eq(legacySecond.status, 409, "QUIZ-29/08: the one-attempt rule applies to legacy quizzes too");

  // =========================================================================
  section("O. option shuffle policy");
  const shufStart = await POST(R.quizStart, url(`/api/quizzes/${shuffleQuiz.id}/start`), {}, { id: shuffleQuiz.id });
  const shufRow = (await client.quizAnswer.findMany({ where: { attemptId: shufStart.json.attemptId } }))[0];
  const shufLive = await client.question.findUnique({ where: { id: shufRow.questionId } });
  const shufFrozenOpts = JSON.parse(shufRow.optionsSnapshot);
  eq(shufFrozenOpts.length, 4, "QUIZ-06: the shuffled option order was frozen");
  ok(shufFrozenOpts[Number(shufRow.answerSnapshot)] === JSON.parse(shufLive.options)[Number(shufLive.answer)], "QUIZ-06: the frozen answer index still points at the ORIGINAL correct text");

  // =========================================================================
  section("P. TEACHER-17 templates");
  asUser(teacherUserA);
  const tpl = await POST(R.tTemplates, url("/api/teacher/templates"), {
    title: "TPL 26D", titleAr: "قالب 26D", description: "d", duration: 45,
  });
  ok(tpl.status === 200 || tpl.status === 201, "TEACHER-17: template create → 200/201", `got ${tpl.status}`);
  const tplId = tpl.json.template?.id ?? tpl.json.id;
  if (tplId) {
    const tplList = await GET(R.tTemplates, url("/api/teacher/templates"));
    ok((tplList.json.templates || []).some((t) => t.id === tplId), "TEACHER-17: the template is listed for its owner");
    asUser(teacherUserB);
    const tplForeign = await DELETE(R.tTemplateById, url(`/api/teacher/templates/${tplId}`), { id: tplId });
    // 404, not 403: "not yours" and "does not exist" must be
    // indistinguishable, or the endpoint is an existence oracle.
    eq(tplForeign.status, 404, "TEACHER-17: teacher B deleting teacher A's template → 404");
    const tplSurvived = await client.lessonPlanTemplate.findUnique({ where: { id: tplId } });
    ok(!!tplSurvived, "TEACHER-17: teacher A's template SURVIVED the foreign delete attempt");
    eq(tplSurvived && tplSurvived.teacherId, teacherA.id, "TEACHER-17: and still belongs to teacher A");
    asUser(teacherUserA);
    const tplOwn = await DELETE(R.tTemplateById, url(`/api/teacher/templates/${tplId}`), { id: tplId });
    eq(tplOwn.status, 200, "TEACHER-17: the OWNER can delete their own template → 200");
    const tplGone = await client.lessonPlanTemplate.findUnique({ where: { id: tplId } });
    ok(!tplGone, "TEACHER-17: and it is really gone");
  }

  // =========================================================================
  section("Q. TEACHER-16 analytics");
  asUser(teacherUserA);
  const analytics = await GET(R.tAnalytics, url("/api/teacher/analytics"));
  eq(analytics.status, 200, "TEACHER-16: teacher analytics → 200");
  ok(!!analytics.json.overview, "TEACHER-16: the analytics overview is returned");
  const aq = await GET(R.tQuizzes, url("/api/teacher/quizzes"));
  const bpListed = (aq.json.quizzes || []).find((q) => q.id === bpQuiz.id);
  ok(!!bpListed, "TEACHER-16: the blueprint quiz appears in teacher quiz analytics");

  // =========================================================================
  {
    section("R. TEACHER-13/14 question authoring authority");
    asUser(teacherUserA);
    // Use a fresh, no-attempt quiz: Phase G correctly locks the blueprint after
    // the first attempt, so the existing legacyQuiz is intentionally unsuitable
    // for this authoring check by this point in the verifier.
    const authoringQuiz = await client.quiz.create({ data: { lessonId: L.pub.id, title: "Authoring verifier quiz", titleAr: "اختبار تحقق التأليف", passMark: 50 } });
    const qAdd = await POST(R.tQuizQuestions, url(`/api/teacher/quizzes/${authoringQuiz.id}/questions`), {
      type: "MCQ", prompt: "Authored Q", options: ["a", "b", "c"], answer: "1",
      difficulty: "EASY", marks: 5,
    }, { id: authoringQuiz.id });
    ok(qAdd.status === 200 || qAdd.status === 201, "TEACHER-13: teacher authors a question on an own quiz → 200/201");
    const authoredId = qAdd.json.question ? qAdd.json.question.id : qAdd.json.id;
    ok(!!authoredId, "TEACHER-13: the authored question id is returned");
    const authoredRow = await client.question.findUnique({ where: { id: authoredId } });
    eq(authoredRow.quizId, authoringQuiz.id, "TEACHER-13: the question landed on the own quiz");
    eq(authoredRow.marks, 5, "TEACHER-13: the authored marks were persisted, not defaulted");

    const qPatch = await PATCH(R.tQuestionById, url(`/api/teacher/questions/${authoredId}`), { prompt: "Authored Q v2" }, { id: authoredId });
    eq(qPatch.status, 200, "TEACHER-14: teacher edits an own question → 200");
    const patchedRow = await client.question.findUnique({ where: { id: authoredId } });
    eq(patchedRow.prompt, "Authored Q v2", "TEACHER-14: the edit was persisted");

    const qDelete = await DELETE(R.tQuestionById, url(`/api/teacher/questions/${authoredId}`), { id: authoredId });
    eq(qDelete.status, 200, "TEACHER-14: teacher deletes an own question → 200");
    const deletedRow = await client.question.findUnique({ where: { id: authoredId } });
    ok(!deletedRow, "TEACHER-14: and it is really gone");

    // =========================================================================
  }

  {
    section("S. TEACHER-19 limits are enforced, never clamped");
    asUser(teacherUserA);
    const longTitle = "x".repeat(TEACHER_LIMITS.TITLE_MAX + 1);
    const overTitle = await POST(R.tHomework, url("/api/teacher/homework"), {
      lessonId: L.pub.id, title: longTitle, instructions: "i",
      deadline: new Date(Date.now() + 86400000).toISOString(), maxMarks: 10,
    });
    eq(overTitle.status, 400, "TEACHER-19: an over-long title is REFUSED → 400");
    const clampedRow = await client.homework.findFirst({ where: { lessonId: L.pub.id, title: longTitle.slice(0, TEACHER_LIMITS.TITLE_MAX) } });
    ok(!clampedRow, "TEACHER-19: the over-long title was NOT silently truncated and saved");

    const badMarks = await POST(R.tHomework, url("/api/teacher/homework"), {
      lessonId: L.pub.id, title: "HW bad marks", instructions: "i",
      deadline: new Date(Date.now() + 86400000).toISOString(), maxMarks: 5000,
    });
    eq(badMarks.status, 400, "TEACHER-19: out-of-range maxMarks is REFUSED → 400, not clamped to 100");

    const badPrompt = await POST(R.tQuizQuestions, url(`/api/teacher/quizzes/${legacyQuiz.id}/questions`), {
      type: "MCQ", prompt: "p".repeat(TEACHER_LIMITS.PROMPT_MAX + 1), options: ["a", "b"], answer: "0",
    }, { id: legacyQuiz.id });
    eq(badPrompt.status, 400, "TEACHER-19: an over-long question prompt is REFUSED → 400");

    const badOpts = await POST(R.tQuizQuestions, url(`/api/teacher/quizzes/${legacyQuiz.id}/questions`), {
      type: "MCQ", prompt: "one option only", options: ["a"], answer: "0",
    }, { id: legacyQuiz.id });
    eq(badOpts.status, 400, "TEACHER-19: fewer than OPTIONS_MIN options is REFUSED → 400");

    const badAnswer = await POST(R.tQuizQuestions, url(`/api/teacher/quizzes/${legacyQuiz.id}/questions`), {
      type: "MCQ", prompt: "answer out of range", options: ["a", "b"], answer: "9",
    }, { id: legacyQuiz.id });
    eq(badAnswer.status, 400, "TEACHER-19: an answer index outside the option list is REFUSED → 400");

    // =========================================================================
  }

  {
    section("T. TEACHER-22 track containment at authoring time");
    asUser(teacherUserA);
    // The containment rule (isQuestionScopeWithinQuiz) is: a question's track
    // must be SHARED, or equal to the quiz's track. A LANGUAGE question is
    // therefore ADMISSIBLE on a SHARED quiz — the quiz reaches both tracks and
    // the per-student track filter drops it for ARABIC students at selection
    // time (covered by QUIZ-05/13). Asserting a 400 there would be wrong.
    const sharedAuthoringQuiz = await client.quiz.create({
      data: { lessonId: L.pub.id, title: "Shared authoring quiz", titleAr: "اختبار تأليف مشترك", passMark: 50 },
    });
    const sharedQuizLangQ = await POST(R.tQuizQuestions, url(`/api/teacher/quizzes/${sharedAuthoringQuiz.id}/questions`), {
      type: "MCQ", prompt: "LANGUAGE-only Q on SHARED", options: ["a", "b"], answer: "0", schoolType: "LANGUAGE",
    }, { id: sharedAuthoringQuiz.id });
    ok(sharedQuizLangQ.status === 200 || sharedQuizLangQ.status === 201,
      "TEACHER-22: a LANGUAGE question IS admissible on a SHARED quiz (filtered per student later)");

    // The REAL refusal: a track-specific quiz that cannot reach the tag.
    const arabicQuiz = await client.quiz.create({
      data: { lessonId: L.pub.id, title: "Arabic-only quiz", titleAr: "اختبار عربي فقط", passMark: 50, trackScope: "ARABIC" },
    });
    const wrongTrackQ = await POST(R.tQuizQuestions, url(`/api/teacher/quizzes/${arabicQuiz.id}/questions`), {
      type: "MCQ", prompt: "LANGUAGE-only Q", options: ["a", "b"], answer: "0", schoolType: "LANGUAGE",
    }, { id: arabicQuiz.id });
    eq(wrongTrackQ.status, 400, "TEACHER-22: a LANGUAGE question on an ARABIC quiz is REFUSED → 400");
    const wrongTrackRow = await client.question.findFirst({ where: { quizId: arabicQuiz.id, prompt: "LANGUAGE-only Q" } });
    ok(!wrongTrackRow, "TEACHER-22: and nothing was written behind the refusal");

    // A SHARED question on a track-specific quiz is fine.
    const sharedOnArabic = await POST(R.tQuizQuestions, url(`/api/teacher/quizzes/${arabicQuiz.id}/questions`), {
      type: "MCQ", prompt: "SHARED Q on ARABIC", options: ["a", "b"], answer: "0",
    }, { id: arabicQuiz.id });
    ok(sharedOnArabic.status === 200 || sharedOnArabic.status === 201,
      "TEACHER-22: a SHARED question is admissible on a track-specific quiz");

    // =========================================================================
  }

  section("U. QUIZ-09 attempt sequence is DB-enforced");
  {
    // The unique constraint must reject a duplicate (quizId, studentId,
    // attemptNumber) at the DATABASE level, not merely by convention in code.
    let threw = false;
    try {
      await client.quizAttempt.create({
        data: { quizId: bpQuiz.id, studentId: studentAr.id, attemptNumber: 1, status: "SUBMITTED", score: 0, percentage: 0, passed: false, startedAt: new Date(), finishedAt: new Date() },
      });
    } catch { threw = true; }
    ok(threw, "QUIZ-09: the DB rejects a duplicate (quizId, studentId, attemptNumber)");

    // And the live sequence really is 1..N per (quiz, student).
    const seq = await client.quizAttempt.findMany({ where: { quizId: bpQuiz.id, studentId: studentAr.id }, orderBy: { attemptNumber: "asc" } });
    const nums = seq.map((a) => a.attemptNumber);
    ok(nums.every((n, i) => n === i + 1), "QUIZ-09: attempt numbers form a contiguous 1..N sequence");
    const allAttempts = await client.quizAttempt.findMany();
    ok(allAttempts.every((a) => (a.status === "OPEN") === (a.finishedAt === null)), "QUIZ-09: status and finishedAt never disagree");
  }

  // =========================================================================
  section("V. QUIZ-18 grant records WHO and WHEN");
  {
    const grantRow = await client.quizRetryGrant.findFirst({
      where: { studentId: studentAr.id, quizId: bpQuiz.id, consumedAt: { not: null } },
    });
    ok(!!grantRow, "QUIZ-18: the consumed grant row still exists (retry never deletes history)");
    ok(!!grantRow && !!grantRow.grantedByUserId, "QUIZ-18: the grant records WHO granted it");
    ok(!!grantRow && !!grantRow.grantedAt, "QUIZ-18: the grant records WHEN it was granted");
    ok(!!grantRow && !!grantRow.consumedAt, "QUIZ-18: the grant records WHEN it was consumed");
    ok(!!grantRow && grantRow.consumedAt >= grantRow.grantedAt, "QUIZ-18: consumption is not earlier than the grant");
    eq(grantRow.grantedByUserId, adminUser.id, "QUIZ-18: the recorded granter is the admin who acted");
    // The grant must survive its own consumption.
    const prior = await client.quizAttempt.count({ where: { quizId: bpQuiz.id, studentId: studentAr.id } });
    ok(prior >= 2, "QUIZ-18: both the original and the granted attempt survive");

    // QUIZ-22: history preservation, asserted directly rather than only as a
    // side-effect of QUIZ-15. The original attempt must be intact — same score,
    // same finishedAt, still SUBMITTED — after the retry has been taken.
    const original = await client.quizAttempt.findFirst({
      where: { quizId: bpQuiz.id, studentId: studentAr.id, attemptNumber: 1 },
    });
    ok(!!original, "QUIZ-22: attempt #1 still exists after the granted retry");
    eq(original.status, "SUBMITTED", "QUIZ-22: attempt #1 is still SUBMITTED (never reopened)");
    ok(!!original.finishedAt, "QUIZ-22: attempt #1 kept its finishedAt (never nulled)");
    ok(!!original.retryGrantId === false, "QUIZ-22: attempt #1 was not retro-tagged with the grant");
    const answersKept = await client.quizAnswer.count({ where: { attemptId: original.id } });
    ok(answersKept > 0, "QUIZ-22: attempt #1 kept its answer rows");
    const snapshotIntact = await client.quizAnswer.findMany({ where: { attemptId: original.id } });
    ok(snapshotIntact.every((a) => a.promptSnapshot != null && a.answerSnapshot != null),
      "QUIZ-22: attempt #1's frozen snapshots are all still present");
  }

  // =========================================================================
  section("W. TEACHER-18/20/24/25 no-credential, scoped, no-invention");
  {
    // TEACHER-18: no teacher surface may hand out raw object-storage credentials.
    const teacherFiles = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p2 = path.join(d, e.name);
        if (e.isDirectory()) walk(p2);
        else if (e.name.endsWith(".ts")) teacherFiles.push(p2);
      }
    })(path.join(REPO, "src/app/api/teacher"));
    const credLeak = teacherFiles.filter((f) =>
      /R2_ACCESS_KEY_ID|R2_SECRET_ACCESS_KEY|AWS_SECRET_ACCESS_KEY|SECRET_ACCESS_KEY|CLOUDFLARE_ACCOUNT_ID/.test(fs.readFileSync(f, "utf8")));
    ok(credLeak.length === 0, "TEACHER-18: no teacher route references raw R2/S3 credentials");
    ok(teacherFiles.length > 0, `TEACHER-18: scanned ${teacherFiles.length} teacher route files`);
    // And no teacher route may serve a signed-credential payload at all.
    const signLeak = teacherFiles.filter((f) =>
      /accessKeyId|secretAccessKey/.test(fs.readFileSync(f, "utf8")));
    ok(signLeak.length === 0, "TEACHER-18: no teacher route serialises an access key pair");

    // TEACHER-24: a Teacher cannot SEND notifications — none was invented.
    const notifSend = teacherFiles.filter((f) =>
      /notification\.create|notifications\/send|sendNotification/.test(fs.readFileSync(f, "utf8")));
    // The homework-grade route writes an automatic result notification, which is
    // pre-existing Phase 18 behaviour and NOT a teacher-controlled send surface.
    const notifSenders = notifSend.map((f) => path.basename(path.dirname(f)) + "/" + path.basename(f));
    ok(notifSenders.length <= 1, `TEACHER-24: at most the pre-existing homework-grade notification exists (found ${notifSenders.join(", ") || "none"})`);
    ok(!notifSenders.some((f) => f.includes("notifications")), "TEACHER-24: there is no teacher notification-SEND route");

    // TEACHER-20: the dashboard is scoped to the teacher's own groups.
    asUser(teacherUserA);
    const dash = await GET(R.tDashboard, url("/api/teacher/dashboard"));
    eq(dash.status, 200, "TEACHER-20: teacher dashboard → 200");
    const dashGroupNames = (dash.json.groups || []).map((g) => g.name);
    ok(dashGroupNames.includes(groupA.name), "TEACHER-20: the dashboard lists the teacher's OWN group");
    ok(!dashGroupNames.includes(groupB.name), "TEACHER-20: the dashboard omits another teacher's group");
    ok(typeof dash.json.pendingHomeworkCount === "number", "TEACHER-20: the dashboard reports a real numeric homework count");

    // TEACHER-25: analytics returns REAL numbers for real rows — never invented.
    asUser(teacherUserA);
    const an = await GET(R.tAnalytics, url("/api/teacher/analytics"));
    eq(an.status, 200, "TEACHER-25: teacher analytics → 200");
    const anGroups = an.json.groups || an.json.groupStats || [];
    ok(Array.isArray(anGroups) && anGroups.length > 0, "TEACHER-25: analytics returns the teacher's real groups");
    const anNames = anGroups.map((g) => g.groupName || g.name);
    ok(anNames.some((n) => n === groupA.name), "TEACHER-25: the seeded group appears by its real name");
    ok(!anNames.some((n) => n === groupB.name), "TEACHER-25: another teacher's group is absent from analytics");
  }


  // =========================================================================
  section("X. QUIZ-31 history integrity under Question EDIT and DELETE");
  {
    // A dedicated quiz + student so this section cannot be perturbed by any
    // earlier attempt.
    const hzQuiz = await client.quiz.create({
      data: { lessonId: L.pub.id, title: "History quiz", titleAr: "اختبار السجل", passMark: 50 },
    });
    const hzQuestions = [];
    for (let i = 0; i < 3; i++) {
      hzQuestions.push(await client.question.create({
        data: {
          quizId: hzQuiz.id, prompt: `HZ Q${i}`, options: '["a","b","c"]',
          answer: String(i % 3), difficulty: "MEDIUM", marks: 4,
        },
      }));
    }
    const hzUser = await client.user.create({ data: { email: "hz26d@cm.test", password: "x", name: "HZ Student", role: "STUDENT" } });
    await client.student.create({ data: { userId: hzUser.id, groupId: groupA.id, schoolType: "ARABIC" } });

    // (1) Start a real attempt through the shipped handler.
    asUser(hzUser);
    const hzStart = await POST(R.quizStart, url(`/api/quizzes/${hzQuiz.id}/start`), {}, { id: hzQuiz.id });
    eq(hzStart.status, 200, "QUIZ-31: attempt started");
    const hzAttemptId = hzStart.json.attemptId;

    // (2) The frozen snapshot rows exist BEFORE any mutation.
    const hzBefore = await client.quizAnswer.findMany({ where: { attemptId: hzAttemptId } });
    eq(hzBefore.length, 3, "QUIZ-31: the attempt froze all 3 questions");
    ok(hzBefore.every((a) => a.promptSnapshot != null), "QUIZ-31: every frozen row carries a prompt snapshot");
    ok(hzBefore.every((a) => a.answerSnapshot != null), "QUIZ-31: every frozen row carries the answer key snapshot");
    ok(hzBefore.every((a) => a.marksSnapshot != null), "QUIZ-31: every frozen row carries a marks snapshot");
    ok(hzBefore.every((a) => a.optionsSnapshot != null), "QUIZ-31: every frozen row carries an options snapshot");

    // Submit so the attempt is TERMINAL history, not an in-flight assessment.
    const hzSubmit = await POST(R.quizSubmit, url(`/api/quizzes/${hzQuiz.id}/submit`), {
      answers: hzBefore.map((a) => ({ questionId: a.questionId, selected: a.answerSnapshot })),
    }, { id: hzQuiz.id });
    eq(hzSubmit.status, 200, "QUIZ-31: the attempt submitted");
    const hzScoreBefore = hzSubmit.json.score;
    const hzPctBefore = hzSubmit.json.percentage;

    const target = hzQuestions[0];
    const targetFrozen = hzBefore.find((a) => a.questionId === target.id);
    const originalPrompt = targetFrozen.promptSnapshot;
    const originalAnswer = targetFrozen.answerSnapshot;
    const originalMarks = targetFrozen.marksSnapshot;
    const originalOptions = targetFrozen.optionsSnapshot;

    // (3)+(4) Once an attempt exists, Phase G freezes the complete blueprint,
    // including non-grading fields. The historical snapshot remains readable;
    // quiz duplication is the sanctioned editing path.
    asUser(teacherUserA);
    const hzEdit = await PATCH(R.tQuestionById, url(`/api/teacher/questions/${target.id}`), {
      prompt: "REWRITTEN AFTER SUBMISSION", explanation: "rewritten too",
    }, { id: target.id });
    eq(hzEdit.status, 409, "QUIZ-31: editing any field after an attempt is REFUSED → 409");

    const hzAfterEdit = await client.quizAnswer.findFirst({ where: { attemptId: hzAttemptId, questionId: target.id } });
    eq(hzAfterEdit.promptSnapshot, originalPrompt, "QUIZ-31: the frozen prompt is UNCHANGED by the live edit");
    eq(hzAfterEdit.answerSnapshot, originalAnswer, "QUIZ-31: the frozen answer key is UNCHANGED by the live edit");
    eq(hzAfterEdit.marksSnapshot, originalMarks, "QUIZ-31: the frozen marks are UNCHANGED by the live edit");
    eq(hzAfterEdit.optionsSnapshot, originalOptions, "QUIZ-31: the frozen options are UNCHANGED by the live edit");

    // Grading-relevant fields must be locked while history exists.
    const hzGradingEdit = await PATCH(R.tQuestionById, url(`/api/teacher/questions/${target.id}`), { answer: "2" }, { id: target.id });
    ok(hzGradingEdit.status >= 400, "QUIZ-31: editing the answer key of a referenced question is REFUSED");
    const hzMarksEdit = await PATCH(R.tQuestionById, url(`/api/teacher/questions/${target.id}`), { marks: 99 }, { id: target.id });
    ok(hzMarksEdit.status >= 400, "QUIZ-31: editing the marks of a referenced question is REFUSED");

    // (5) DELETE the referenced question through the real Teacher route.
    const hzDelete = await DELETE(R.tQuestionById, url(`/api/teacher/questions/${target.id}`), { id: target.id });
    eq(hzDelete.status, 409, "QUIZ-31: deleting a question referenced by frozen history is REFUSED → 409");

    // (9) No QuizAnswer row disappeared.
    const hzAfterDelete = await client.quizAnswer.findMany({ where: { attemptId: hzAttemptId } });
    eq(hzAfterDelete.length, hzBefore.length, "QUIZ-31: NO QuizAnswer row disappeared because of the delete attempt");
    const liveStill = await client.question.findUnique({ where: { id: target.id } });
    ok(!!liveStill, "QUIZ-31: the live question row also survived the refused delete");

    // (6)+(7) Historical detail still returns the ORIGINAL frozen question, and
    // the score is unchanged.
    asUser(adminUser);
    const hzDetail = await GET(R.aAttemptById, url(`/api/admin/quiz-attempts/${hzAttemptId}`), { id: hzAttemptId });
    eq(hzDetail.status, 200, "QUIZ-31: the historical attempt detail is still readable");
    const hzDetailQs = hzDetail.json.attempt.questions || [];
    eq(hzDetailQs.length, 3, "QUIZ-31: the detail still lists all 3 frozen questions");
    const hzDetailTarget = hzDetailQs.find((q) => q.questionId === target.id);
    ok(!!hzDetailTarget, "QUIZ-31: the edited question is still present in the historical detail");
    ok(
      !!hzDetailTarget && (hzDetailTarget.promptSnapshot === originalPrompt || hzDetailTarget.prompt === originalPrompt),
      "QUIZ-31: the historical detail shows the ORIGINAL frozen wording, not the rewritten one"
    );
    eq(hzDetail.json.attempt.score, hzScoreBefore, "QUIZ-31: the historical score is UNCHANGED");
    eq(hzDetail.json.attempt.percentage, hzPctBefore, "QUIZ-31: the historical percentage is UNCHANGED");

    // (10) A FOREIGN teacher cannot exploit the delete path.
    asUser(teacherUserB);
    const hzForeignDelete = await DELETE(R.tQuestionById, url(`/api/teacher/questions/${target.id}`), { id: target.id });
    ok(hzForeignDelete.status === 403 || hzForeignDelete.status === 404,
      "QUIZ-31: a foreign teacher cannot reach the delete path", `got ${hzForeignDelete.status}`);
    const stillThere = await client.question.findUnique({ where: { id: target.id } });
    ok(!!stillThere, "QUIZ-31: the question survived the foreign teacher's delete attempt");
    const hzRowsFinal = await client.quizAnswer.count({ where: { attemptId: hzAttemptId } });
    eq(hzRowsFinal, hzBefore.length, "QUIZ-31: frozen rows still complete after the foreign attempt");

    // The guard must not be a blanket ban: an UNREFERENCED question in the same
    // quiz is deletable, so the 409 above is about history, not about deletion
    // being disabled.
    asUser(teacherUserA);
    const spare = await client.question.create({
      data: { quizId: hzQuiz.id, prompt: "HZ spare", options: '["a","b"]', answer: "0", difficulty: "EASY", marks: 1 },
    });
    const spareDelete = await DELETE(R.tQuestionById, url(`/api/teacher/questions/${spare.id}`), { id: spare.id });
    eq(spareDelete.status, 200, "QUIZ-31: an UNREFERENCED question is still deletable (the guard is specific, not a blanket ban)");

    // (8) Retry history stays intact: grant a retry, take it, and confirm both
    // attempts and the frozen rows of the FIRST one survive.
    asUser(adminUser);
    const hzGrant = await POST(R.aRetries, url("/api/admin/quiz-retries"), { studentId: (await client.student.findFirst({ where: { userId: hzUser.id } })).id, quizId: hzQuiz.id, reason: "history check" });
    eq(hzGrant.status, 201, "QUIZ-31: a retry grant was issued");
    asUser(hzUser);
    const hzStart2 = await POST(R.quizStart, url(`/api/quizzes/${hzQuiz.id}/start`), {}, { id: hzQuiz.id });
    eq(hzStart2.status, 200, "QUIZ-31: the granted retry attempt started");
    eq(hzStart2.json.attemptNumber, 2, "QUIZ-31: the retry is sequence #2");
    const hzRowsAfterRetry = await client.quizAnswer.count({ where: { attemptId: hzAttemptId } });
    eq(hzRowsAfterRetry, hzBefore.length, "QUIZ-31: the FIRST attempt's frozen rows survived the retry");
    const hzFirstStill = await client.quizAttempt.findUnique({ where: { id: hzAttemptId } });
    eq(hzFirstStill.status, "SUBMITTED", "QUIZ-31: the first attempt is still SUBMITTED (retry history intact)");
    eq(hzFirstStill.score, hzScoreBefore, "QUIZ-31: the first attempt's score survived the retry");
  }


  // =========================================================================
  section("Y. QUIZ-32 Question Bank pool semantics");
  {
    // "Question Bank" operationally means TWO different things, and the selector
    // only ever reads one of them:
    //   * the GLOBAL/shared bank  -> Question rows with quizId = NULL, created
    //     through POST /api/admin/question-bank with no quizId;
    //   * a QUIZ'S OWN POOL       -> Question rows whose quizId is that quiz.
    // loadQuizQuestionPool() filters `where: { quizId }`, so shared rows are NOT
    // candidates. These assertions pin that, so nobody later "fixes" the
    // selector to sample the global bank and silently breaks the freeze
    // (a shared row has no owning quiz, so deleting it would cascade into every
    // attempt that ever drew it).
    asUser(adminUser);
    const sharedQ = await POST(R.aQuestionBank, url("/api/admin/question-bank"), {
      prompt: "SHARED BANK Q", options: ["a", "b", "c"], answer: "0", difficulty: "EASY", marks: 1,
    });
    ok(sharedQ.status === 200 || sharedQ.status === 201, "QUIZ-32: an admin can create a shared (quizId=null) bank question");
    const sharedRow = await client.question.findFirst({ where: { prompt: "SHARED BANK Q" } });
    ok(!!sharedRow, "QUIZ-32: the shared bank row exists");
    eq(sharedRow.quizId, null, "QUIZ-32: the shared bank row has quizId = NULL");

    // A FIXED quiz must serve exactly its OWN questions and nothing from the
    // shared bank.
    const poolQuiz = await client.quiz.create({
      data: { lessonId: L.pub.id, title: "Pool quiz", titleAr: "اختبار البنك", passMark: 50 },
    });
    for (let i = 0; i < 2; i++) {
      await client.question.create({
        data: { quizId: poolQuiz.id, prompt: `POOL Q${i}`, options: '["a","b"]', answer: "0", difficulty: "EASY", marks: 1 },
      });
    }
    const poolUser = await client.user.create({ data: { email: "pool26d@cm.test", password: "x", name: "Pool Student", role: "STUDENT" } });
    await client.student.create({ data: { userId: poolUser.id, groupId: groupA.id, schoolType: "ARABIC" } });

    asUser(poolUser);
    const poolStart = await POST(R.quizStart, url(`/api/quizzes/${poolQuiz.id}/start`), {}, { id: poolQuiz.id });
    eq(poolStart.status, 200, "QUIZ-32: the pool quiz started");
    const poolRows = await client.quizAnswer.findMany({ where: { attemptId: poolStart.json.attemptId } });
    eq(poolRows.length, 2, "QUIZ-32: the attempt froze ONLY the quiz's own 2 questions");
    ok(!poolRows.some((r) => r.questionId === sharedRow.id),
      "QUIZ-32: the shared (quizId=NULL) bank question was NOT sampled into the attempt");
    const frozenPrompts = poolRows.map((r) => r.promptSnapshot);
    ok(frozenPrompts.every((p2) => String(p2).startsWith("POOL Q")),
      "QUIZ-32: every frozen question came from the quiz's own pool");

    // Deleting a shared bank row must not touch the frozen attempt.
    asUser(teacherUserA);
    const sharedDel = await DELETE(R.tQuestionById, url(`/api/teacher/questions/${sharedRow.id}`), { id: sharedRow.id });
    ok(sharedDel.status >= 400, "QUIZ-32: a shared bank row is not deletable through the teacher route (not owned)", `got ${sharedDel.status}`);
    const poolRowsAfter = await client.quizAnswer.count({ where: { attemptId: poolStart.json.attemptId } });
    eq(poolRowsAfter, 2, "QUIZ-32: the frozen attempt is unaffected by shared-bank activity");
  }


  // =========================================================================
  section("Z. QUIZ-33 concurrency protocol — the destructive-delete lock");
  {
    const ser = R.serialization;

    // (1) The lock id is deterministic per quiz, and distinct across quizzes —
    //     otherwise unrelated quizzes would serialize against each other, or
    //     (worse) two different quizzes would share a lock and still race.
    const l1 = ser.quizDestructiveLockId("quiz-A");
    const l2 = ser.quizDestructiveLockId("quiz-A");
    const l3 = ser.quizDestructiveLockId("quiz-B");
    eq(String(l1), String(l2), "QUIZ-33: the same quiz always maps to the same lock id");
    ok(String(l1) !== String(l3), "QUIZ-33: different quizzes map to different lock ids");
    ok(l1 >= 0n && l1 <= 0x7fffffffffffffffn, "QUIZ-33: the lock id fits PostgreSQL's signed bigint (63-bit)");

    // (2) Namespace isolation: a quiz lock must never collide with the Phase 23
    //     upload lock or the Phase 25 group-seat lock.
    ok(String(ser.quizDestructiveLockId("x")) !== String(ser.uploadFinalizeLockId("x")),
      "QUIZ-33: the quiz lock namespace cannot collide with the upload-finalize lock");
    ok(String(ser.quizDestructiveLockId("x")) !== String(ser.groupSeatLockId("x")),
      "QUIZ-33: the quiz lock namespace cannot collide with the group-seat lock");

    // (3) On PostgreSQL the lock is issued as PARAMETERIZED raw SQL — the id is
    //     bound, never interpolated. Captured by recording what the tx receives.
    const calls = [];
    const fakeTx = {
      $executeRaw: (strings, ...values) => {
        calls.push({ sql: strings.join("?"), values });
        return Promise.resolve(1);
      },
    };
    await ser.acquireQuizDestructiveLock(fakeTx, "quiz-A", "postgresql");
    eq(calls.length, 1, "QUIZ-33: exactly one raw statement is issued on PostgreSQL");
    eq(calls[0].sql, "SELECT pg_advisory_xact_lock(?)",
      "QUIZ-33: the statement is a parameterized pg_advisory_xact_lock (no string interpolation)");
    eq(calls[0].values.length, 1, "QUIZ-33: the lock id is passed as a BOUND value");
    eq(String(calls[0].values[0]), String(ser.quizDestructiveLockId("quiz-A")),
      "QUIZ-33: the bound value is this quiz's lock id");
    ok(typeof calls[0].values[0] === "bigint", "QUIZ-33: the lock id is bound as a bigint (int8), not a string");
    ok(!calls[0].sql.includes("quiz-A"), "QUIZ-33: the raw SQL contains no interpolated identifier");

    // (4) It is TRANSACTION-scoped: xact_lock, not the session-level variant that
    //     would leak past COMMIT and could deadlock a serverless pool.
    ok(!/pg_advisory_lock\s*\(/.test(calls[0].sql),
      "QUIZ-33: uses the transaction-scoped lock, never the session-scoped one");

    // (5) On SQLite it is a deliberate NO-OP — local development must never
    //     depend on a PostgreSQL primitive. SQLite's own single-writer lock is
    //     what serializes writers there.
    const sqliteCalls = [];
    const sqliteTx = { $executeRaw: (strings, ...v) => { sqliteCalls.push(strings.join("?")); return Promise.resolve(1); } };
    await ser.acquireQuizDestructiveLock(sqliteTx, "quiz-A", "sqlite");
    eq(sqliteCalls.length, 0, "QUIZ-33: on SQLite the advisory call is skipped (no PostgreSQL dependency locally)");

    // (6) A tx without raw-SQL support must not throw (some test fakes model a
    //     narrower surface) — the in-transaction re-check still guards.
    let threw = false;
    try { await ser.acquireQuizDestructiveLock({}, "quiz-A", "postgresql"); } catch { threw = true; }
    ok(!threw, "QUIZ-33: a tx without $executeRaw is tolerated, not fatal");

    // (7) The provider gate resolves from DATABASE_URL exactly as Prisma
    //     dispatches, so the lock is only attempted against real PostgreSQL.
    eq(ser.resolveDatabaseProvider({ DATABASE_URL: "postgresql://u:p@h:5432/db" }), "postgresql",
      "QUIZ-33: a postgresql:// URL resolves to postgresql");
    eq(ser.resolveDatabaseProvider({ DATABASE_URL: "postgres://u:p@h:5432/db" }), "postgresql",
      "QUIZ-33: a postgres:// URL resolves to postgresql");
    eq(ser.resolveDatabaseProvider({ DATABASE_URL: "file:./db/custom.db" }), "sqlite",
      "QUIZ-33: a file: URL resolves to sqlite");
    eq(ser.resolveDatabaseProvider({}), "sqlite",
      "QUIZ-33: an unset DATABASE_URL resolves to sqlite (local default)");

    // (8) The REAL routes must take the lock as their FIRST statement, before any
    //     reference read — acquiring it later reopens the very window it closes.
    const readRoute = (rel) =>
      fs.readFileSync(path.join(REPO, "src/app/api", rel), "utf8");

    const qDel = readRoute("teacher/questions/[id]/route.ts");
    const qTx = qDel.slice(qDel.indexOf("db.$transaction(async (tx)"));
    const qLockAt = qTx.indexOf("acquireQuizDestructiveLock");
    const qRefsAt = qTx.indexOf("loadQuestionReferences");
    const qDeleteAt = qTx.indexOf("tx.question.delete");
    ok(qLockAt > 0 && qLockAt < qRefsAt && qRefsAt < qDeleteAt,
      "QUIZ-33: question delete order is LOCK -> check references -> delete");

    const quizDel = readRoute("teacher/quizzes/[id]/route.ts");
    const zTx = quizDel.slice(quizDel.indexOf("db.$transaction(async (tx)"));
    const zLockAt = zTx.indexOf("acquireQuizDestructiveLock");
    const zAttemptsAt = zTx.indexOf("tx.quizAttempt.findMany");
    const zDeleteAt = zTx.indexOf("tx.quiz.delete");
    ok(zLockAt > 0 && zLockAt < zAttemptsAt && zAttemptsAt < zDeleteAt,
      "QUIZ-33: quiz delete order is LOCK -> count attempts -> delete");

    // The start route has TWO write transactions (the pre-Phase-5 resume path
    // and the create path), so slice from the CREATE transaction specifically —
    // slicing from the first match would assert against the wrong block.
    const startRoute = readRoute("quizzes/[id]/start/route.ts");
    const sCreateIdx = startRoute.indexOf("const attempt = await db.$transaction(async (tx)");
    ok(sCreateIdx > 0, "QUIZ-33: the attempt-create transaction is present");
    const sTx = startRoute.slice(sCreateIdx);
    const sLockAt = sTx.indexOf("acquireQuizDestructiveLock");
    const sCreateAt = sTx.indexOf("tx.quizAttempt.create");
    const sSeedAt = sTx.indexOf("seedAttemptQuestions");
    ok(sLockAt > 0 && sLockAt < sCreateAt && sCreateAt < sSeedAt,
      "QUIZ-33: start order is LOCK -> create attempt -> freeze rows (all under one lock)");
    ok(/seedAttemptQuestions\(created\.id, id, schoolType, \{[\s\S]*?tx,/.test(sTx),
      "QUIZ-33: the freeze is written THROUGH the transaction, not after COMMIT");
    ok(!/await seedAttemptQuestions\(attempt\.id/.test(startRoute),
      "QUIZ-33: no post-COMMIT freeze remains on the create path");

    // The resume path freezes rows too, so it must honour the same protocol.
    const sResumeIdx = startRoute.indexOf("const set = await loadAttemptQuestionSet");
    const sResume = startRoute.slice(sResumeIdx, startRoute.indexOf("const resumedState"));
    const rLockAt = sResume.indexOf("acquireQuizDestructiveLock");
    const rSeedAt = sResume.indexOf("seedAttemptQuestions");
    ok(rLockAt > 0 && rLockAt < rSeedAt,
      "QUIZ-33: the pre-Phase-5 resume path also locks BEFORE freezing");
    ok(/seedAttemptQuestions\(existing\.id, id, schoolType, \{ blueprint, tx \}\)/.test(sResume),
      "QUIZ-33: the resume freeze is written through its transaction");

    // (9) Both sides key the SAME lock. If start keyed by student and delete by
    //     question, they would never contend and the race would remain open.
    ok(/acquireQuizDestructiveLock\(tx, id\)/.test(startRoute),
      "QUIZ-33: attempt start keys the lock by QUIZ id");
    ok(/acquireQuizDestructiveLock\(tx, id\)/.test(quizDel),
      "QUIZ-33: quiz delete keys the lock by the SAME quiz id");
    ok(/acquireQuizDestructiveLock\(tx, owned\.owner\.quiz\.id\)/.test(qDel),
      "QUIZ-33: question delete keys the lock by its OWNING quiz id, so it contends with start");
  }

  R.restore();

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  console.log("PHASE26D_VERIFIER_OK");
}

main().catch((e) => {
  console.error("\n[26D] verifier crashed:", e && e.stack ? e.stack : String(e));
  process.exit(1);
});
