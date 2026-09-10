// CodeMind Academy — Phase 18 real end-to-end teacher workflow verification.
//
// Drives the SHIPPED teacher API (compiled from src/ with the repo's own tsc,
// exactly like scripts/verify-phase15-admin.mjs does) against a REAL SQLite
// database built from the base DDL + every real migration. It walks the whole
// Phase 18 teacher workflow against the REAL route handlers:
//
//   lessons picker (canonical Course → Part → Unit → Lesson, archived visible)
//     → homework create (scope inheritance / containment / ownership)
//     → homework update (graded history preserved, destructive changes refused)
//     → quiz create (timeLimit + track scope persisted, archived refused)
//     → question append (quiz scope is the ceiling)
//     → question read (reference counters + FIXED pins surfaced)
//     → question update (frozen-attempt locks, merge re-validation)
//     → question delete (refused while referenced / FIXED-pinned)
//     → student time-limit enforcement (/start + /submit on the real clock)
//     → student homework submission (track isolation unchanged)
//     → teacher analytics (Phase 6 shape + trackSplit)
//
// What is REAL here: the migration SQL, the schema, the compiled route
// handlers, the ownership/containment/lock helpers, the frozen attempt rows,
// the FIXED mock-exam pins, the grading + time-limit enforcement. What is
// SHIMMED (and why):
//   * `@/lib/db`     → sqlite-prisma-lite over node:sqlite (the Prisma query
//                      engine binary is unreachable from this sandbox; the
//                      adapter executes real SQL and throws UnsupportedQuery
//                      instead of approximating).
//   * `@/lib/auth`   → script-controlled current user (no cookie stack in a
//                      script; requireUser still runs for real).
//   * `next/server`  → minimal NextResponse (status/headers/json/bytes).
//   * `next/headers` → no locale cookie (server falls back to `ar`).
//
// Exit code 0 + `0 failed` iff every assertion holds. Section N of
// tests/teacher-workflow-phase18.test.js executes this file as a child process.

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
  ok(
    JSON.stringify(a) === JSON.stringify(b),
    label,
    `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`
  );
}

// ---------------------------------------------------------------------------
// A. scratch database: base DDL + every real migration
// ---------------------------------------------------------------------------

const SCHEMA_TABLES = [
  "User",
  "Course",
  "Part",
  "Unit",
  "Topic",
  "Lesson",
  "Quiz",
  "Question",
  "QuizAttempt",
  "QuizAnswer",
  "Homework",
  "HomeworkSubmission",
  "MockExam",
  "MockExamQuestion",
  "Group",
  "Teacher",
  "Student",
];

const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "phase18: " });
for (const d of mig.assertColumnsMatchSchema(rawDb, SCHEMA_TABLES)) {
  ok(
    d.declared && d.missing.length === 0 && d.extra.length === 0,
    `A: ${d.table} columns match prisma/schema.prisma`,
    JSON.stringify({ missing: d.missing, extra: d.extra })
  );
}

const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// B. compile the shipped TypeScript with the repo's own tsc; load with shims
// ---------------------------------------------------------------------------

const REAL_CODE_MODULES = [
  // libraries (tsc follows their imports)
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/security.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/enrollment.ts",
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/session-quiz.ts",
  "src/lib/quiz-analytics.ts",
  "src/lib/teacher-content.ts",
  "src/lib/api.ts",
  // teacher routes under test
  "src/app/api/teacher/lessons/route.ts",
  "src/app/api/teacher/homework/route.ts",
  "src/app/api/teacher/homework/[id]/route.ts",
  "src/app/api/teacher/homework/[id]/grade/route.ts",
  "src/app/api/teacher/quizzes/route.ts",
  "src/app/api/teacher/quizzes/[id]/route.ts",
  "src/app/api/teacher/quizzes/[id]/questions/route.ts",
  "src/app/api/teacher/questions/[id]/route.ts",
  "src/app/api/teacher/analytics/route.ts",
  // the student + admin surfaces the teacher workflow must not break
  "src/app/api/students/me/homework/route.ts",
  "src/app/api/exams/mock/route.ts",
  "src/app/api/quizzes/[id]/route.ts",
  "src/app/api/quizzes/[id]/start/route.ts",
  "src/app/api/quizzes/[id]/submit/route.ts",
  "src/app/api/admin/mock-exams/route.ts",
];

function compileRealCode() {
  const { execFileSync } = require("child_process");
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase18-real-"));
  fs.writeFileSync(
    path.join(out, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          target: "es2020",
          module: "commonjs",
          moduleResolution: "node",
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          allowJs: false,
          types: ["node"],
          typeRoots: [path.join(REPO, "node_modules/@types")],
          baseUrl: REPO,
          paths: { "@/*": ["src/*"] },
          rootDir: REPO,
          outDir: out,
        },
        files: REAL_CODE_MODULES.map((f) => path.join(REPO, f)),
      },
      null,
      2
    )
  );
  const tscBin = require.resolve("typescript/bin/tsc");
  try {
    execFileSync(process.execPath, [tscBin, "-p", path.join(out, "tsconfig.json")], {
      cwd: REPO,
      stdio: "pipe",
    });
  } catch {
    /* type noise elsewhere in the graph is tolerated; the emitted files matter */
  }
  for (const f of REAL_CODE_MODULES) {
    const emitted = path.join(out, f.replace(/\.ts$/, ".js"));
    if (!fs.existsSync(emitted)) {
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
    const h = init.headers || {};
    for (const [k, v] of Object.entries(h)) this._headers.set(String(k).toLowerCase(), String(v));
    this._body = body;
    this._json = undefined;
  }
  static json(data, init = {}) {
    const r = new NextResponse(JSON.stringify(data), {
      status: init.status ?? 200,
      headers: { "content-type": "application/json" },
    });
    r._json = data;
    return r;
  }
  get headers() {
    const m = this._headers;
    return { get: (k) => m.get(String(k).toLowerCase()) ?? null };
  }
  async json() {
    if (this._json !== undefined) return this._json;
    return JSON.parse(Buffer.from(this._body || []).toString("utf8"));
  }
  async arrayBuffer() {
    const b = Buffer.isBuffer(this._body) ? this._body : Buffer.from(this._body ?? []);
    return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
  }
}
class NextRequest {}
module.exports = { NextResponse, NextRequest };
`;

const NEXT_HEADERS_SHIM = `
module.exports = { cookies: async () => ({ get: () => undefined }) };
`;

const AUTH_SHIM = `
module.exports = { getCurrentUser: async () => globalThis.__CM_USER__ ?? null };
`;

const DB_SHIM = `
module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };
`;

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
  return {
    restore() {
      Module._resolveFilename = originalResolve;
    },
    lessons: route("teacher/lessons/route.js"),
    homework: route("teacher/homework/route.js"),
    homeworkById: route("teacher/homework/[id]/route.js"),
    homeworkGrade: route("teacher/homework/[id]/grade/route.js"),
    quizzes: route("teacher/quizzes/route.js"),
    quizById: route("teacher/quizzes/[id]/route.js"),
    quizQuestions: route("teacher/quizzes/[id]/questions/route.js"),
    questionById: route("teacher/questions/[id]/route.js"),
    teacherAnalytics: route("teacher/analytics/route.js"),
    studentHomework: route("students/me/homework/route.js"),
    mockExams: route("admin/mock-exams/route.js"),
    quizDetail: route("quizzes/[id]/route.js"),
    quizStart: route("quizzes/[id]/start/route.js"),
    quizSubmit: route("quizzes/[id]/submit/route.js"),
  };
}

// ---------------------------------------------------------------------------
// HTTP-lite driver (same shape as the Phase 15 verifier)
// ---------------------------------------------------------------------------

function jsonReq(url, body) {
  return {
    url,
    method: "GET",
    headers: {
      get: (k) =>
        String(k).toLowerCase() === "content-type" ? "application/json" : null,
    },
    json: async () => body,
    formData: async () => {
      throw new Error("no form body");
    },
  };
}

function asUser(u) {
  globalThis.__CM_USER__ = u
    ? { id: u.id, email: u.email, name: u.name, role: u.role }
    : null;
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
const POST_JSON = (r, url, body, params) => call(r.POST, jsonReq(url, body), params);
const PATCH_JSON = (r, url, body, params) => call(r.PATCH, jsonReq(url, body), params);
const DELETE = (r, url, params) => call(r.DELETE, jsonReq(url), params);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  const outDir = compileRealCode();
  ok(true, "B: shipped TS compiled with the repo tsc");
  const R = loadRealCode(outDir);
  ok(true, "B: route handlers loaded with db/auth/next shims");

  // ---- C. seed ------------------------------------------------------------
  const adminUser = await client.user.create({
    data: { email: "admin18@cm.test", password: "x", name: "Admin", role: "ADMIN" },
  });
  const teacherUserA = await client.user.create({
    data: { email: "ta18@cm.test", password: "x", name: "Teacher A", role: "TEACHER" },
  });
  const teacherUserB = await client.user.create({
    data: { email: "tb18@cm.test", password: "x", name: "Teacher B", role: "TEACHER" },
  });
  const studentUserAr = await client.user.create({
    data: { email: "sar18@cm.test", password: "x", name: "Student AR", role: "STUDENT" },
  });
  const studentUserLang = await client.user.create({
    data: { email: "slang18@cm.test", password: "x", name: "Student LANG", role: "STUDENT" },
  });

  const teacherA = await client.teacher.create({ data: { userId: teacherUserA.id } });
  const teacherB = await client.teacher.create({ data: { userId: teacherUserB.id } });

  const courseA = await client.course.create({
    data: { slug: "phase18-a", name: "Phase 18 A", nameAr: "مرحلة 18 أ", description: "d" },
  });
  const courseB = await client.course.create({
    data: { slug: "phase18-b", name: "Phase 18 B", nameAr: "مرحلة 18 ب", description: "d" },
  });
  const partA = await client.part.create({
    data: { courseId: courseA.id, title: "Part A1", titleAr: "جزء أ1", order: 1 },
  });
  const partB = await client.part.create({
    data: { courseId: courseB.id, title: "Part B1", titleAr: "جزء ب1", order: 1 },
  });
  const unitA = await client.unit.create({
    data: { partId: partA.id, title: "Unit A1", titleAr: "وحدة أ1", order: 1 },
  });
  const unitB = await client.unit.create({
    data: { partId: partB.id, title: "Unit B1", titleAr: "وحدة ب1", order: 1 },
  });
  const topicA = await client.topic.create({
    data: { unitId: unitA.id, title: "Topic A1", titleAr: "موضوع أ1", order: 1 },
  });

  const groupA = await client.group.create({
    data: { name: "Group A", courseId: courseA.id, teacherId: teacherA.id, isActive: true },
  });
  const groupB = await client.group.create({
    data: { name: "Group B", courseId: courseB.id, teacherId: teacherB.id, isActive: true },
  });

  const studentAr = await client.student.create({
    data: { userId: studentUserAr.id, groupId: groupA.id, schoolType: "ARABIC" },
  });
  const studentLang = await client.student.create({
    data: { userId: studentUserLang.id, groupId: groupA.id, schoolType: "LANGUAGE" },
  });

  // Canonical lessons (unitId) + one legacy lesson (topicId) so both chains are
  // exercised by the SAME ownership rule.
  const L = {};
  L.pub = await client.lesson.create({
    data: {
      unitId: unitA.id, officialCode: "P18-01", title: "Shared lesson", titleAr: "حصة مشتركة",
      order: 1, trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL",
    },
  });
  L.ar = await client.lesson.create({
    data: {
      unitId: unitA.id, officialCode: "P18-02", title: "Arabic lesson", titleAr: "حصة عربي",
      order: 2, trackScope: "ARABIC", status: "PUBLISHED", curriculumStatus: "OFFICIAL",
    },
  });
  L.lang = await client.lesson.create({
    data: {
      unitId: unitA.id, officialCode: "P18-03", title: "Language lesson", titleAr: "حصة لغات",
      order: 3, trackScope: "LANGUAGE", status: "PUBLISHED", curriculumStatus: "OFFICIAL",
    },
  });
  L.draft = await client.lesson.create({
    data: {
      unitId: unitA.id, officialCode: "P18-04", title: "Draft lesson", titleAr: "حصة مسودة",
      order: 4, trackScope: "SHARED", status: "DRAFT", curriculumStatus: "OFFICIAL",
    },
  });
  L.archived = await client.lesson.create({
    data: {
      unitId: unitA.id, officialCode: "P18-05", title: "Archived lesson", titleAr: "حصة مؤرشفة",
      order: 5, trackScope: "SHARED", status: "ARCHIVED", curriculumStatus: "ARCHIVED",
    },
  });
  L.legacy = await client.lesson.create({
    data: {
      topicId: topicA.id, title: "Legacy lesson", titleAr: "حصة قديمة",
      order: 6, trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "LEGACY",
    },
  });
  L.b = await client.lesson.create({
    data: {
      unitId: unitB.id, officialCode: "P18-B1", title: "Other teacher lesson", titleAr: "حصة معلم آخر",
      order: 1, trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL",
    },
  });
  // A lesson attached to NO chain at all: management of it must be refused
  // (404 NO_CHAIN) rather than silently authorized.
  L.orphan = await client.lesson.create({
    data: {
      title: "Orphan lesson", titleAr: "حصة يتيمة", order: 9,
      trackScope: "SHARED", status: "DRAFT", curriculumStatus: "LEGACY",
    },
  });

  // ---- questions + quizzes ------------------------------------------------
  const quizShared = await client.quiz.create({
    data: { lessonId: L.pub.id, title: "Q shared", titleAr: "اختبار مشترك", passMark: 50 },
  });
  const qFree = await client.question.create({
    data: {
      quizId: quizShared.id, prompt: "Free question", options: '["a","b"]', answer: "0",
    },
  });
  const qFrozen = await client.question.create({
    data: {
      quizId: quizShared.id, prompt: "Frozen question", options: '["a","b"]', answer: "0",
    },
  });
  const qPinned = await client.question.create({
    data: {
      quizId: quizShared.id, prompt: "Pinned question", options: '["a","b"]', answer: "1",
    },
  });
  // A legacy lesson's quiz proves the fallback chain still authorizes.
  const quizLegacy = await client.quiz.create({
    data: { lessonId: L.legacy.id, title: "Q legacy", titleAr: "اختبار قديم", passMark: 50 },
  });
  await client.question.create({
    data: { quizId: quizLegacy.id, prompt: "Legacy question", options: '["a","b"]', answer: "0" },
  });
  // The other teacher's quiz: every write against it must be refused.
  const quizOther = await client.quiz.create({
    data: {
      lessonId: L.b.id, title: "Q other", titleAr: "اختبار آخر",
      passMark: 50, trackScope: "LANGUAGE",
    },
  });
  const qOther = await client.question.create({
    data: {
      quizId: quizOther.id, prompt: "Other question", options: '["a","b"]', answer: "0",
      schoolType: "LANGUAGE",
    },
  });
  // A bank row (no quiz): not teacher-managed content.
  const qBank = await client.question.create({
    data: { prompt: "Bank question", options: '["a","b"]', answer: "0", schoolType: "ARABIC" },
  });

  // Frozen attempt history on qFrozen (finished) and an OPEN attempt on qOpen.
  const attemptGraded = await client.quizAttempt.create({
    data: {
      quizId: quizShared.id, studentId: studentAr.id, score: 1, totalMarks: 1,
      percentage: 100, passed: true, finishedAt: new Date(Date.now() - 3600_000),
    },
  });
  await client.quizAnswer.create({
    data: {
      attemptId: attemptGraded.id, questionId: qFrozen.id, selected: "0", isCorrect: true,
    },
  });
  const quizOpen = await client.quiz.create({
    data: { lessonId: L.pub.id, title: "Q open", titleAr: "اختبار مفتوح", passMark: 50 },
  });
  const qOpen = await client.question.create({
    data: { quizId: quizOpen.id, prompt: "Open question", options: '["a","b"]', answer: "0" },
  });
  const attemptOpen = await client.quizAttempt.create({
    data: { quizId: quizOpen.id, studentId: studentAr.id, score: 0, totalMarks: 0 },
  });
  await client.quizAnswer.create({
    data: { attemptId: attemptOpen.id, questionId: qOpen.id, selected: "", isCorrect: false },
  });

  // A FIXED mock exam pinning qPinned (the exam definition must never shrink).
  const fixedExam = await client.mockExam.create({
    data: {
      title: "Fixed exam", titleAr: "اختبار ثابت", schoolType: "ARABIC",
      questionCount: 1, selectionMode: "FIXED", isPublished: true,
    },
  });
  await client.mockExamQuestion.create({
    data: { mockExamId: fixedExam.id, questionId: qPinned.id, order: 0 },
  });

  // Homework with a GRADED submission (the destructive-edit guard's input).
  const homeworkGraded = await client.homework.create({
    data: {
      lessonId: L.pub.id, title: "Graded homework", titleAr: "واجب مصحح",
      instructions: "Solve 1-5.", deadline: new Date(Date.now() + 86_400_000),
      maxMarks: 10, trackScope: "SHARED",
    },
  });
  await client.homeworkSubmission.create({
    data: {
      homeworkId: homeworkGraded.id, studentId: studentAr.id, content: "answer",
      status: "GRADED", grade: 7, submittedAt: new Date(),
    },
  });

  const url = (p) => `http://cm.test${p}`;

  // ---- D. the lesson picker: canonical coverage, archived visible ---------
  asUser(teacherUserA);
  const lessonsRes = await GET(R.lessons, url("/api/teacher/lessons"));
  eq(lessonsRes.status, 200, "D: GET /api/teacher/lessons → 200");
  const flat = lessonsRes.json.lessons;
  const byId = Object.fromEntries(flat.map((l) => [l.id, l]));
  ok(Array.isArray(flat) && flat.length >= 6, "D: flat list returns every lesson of the teacher's courses");
  ok(
    byId[L.pub.id] && byId[L.pub.id].officialCode === "P18-01" && byId[L.pub.id].chain === "CANONICAL",
    "D: canonical lesson exposes officialCode + CANONICAL chain",
    JSON.stringify(byId[L.pub.id])
  );
  ok(
    byId[L.pub.id] && byId[L.pub.id].part?.title && byId[L.pub.id].unit?.title && byId[L.pub.id].course?.name,
    "D: canonical lesson exposes course → part → unit placement",
    JSON.stringify(byId[L.pub.id])
  );
  eq(byId[L.pub.id]?.trackScope, "SHARED", "D: lesson carries its trackScope");
  eq(byId[L.draft.id]?.status, "DRAFT", "D: DRAFT lesson stays visible for management");
  eq(byId[L.archived.id]?.curriculumStatus, "ARCHIVED", "D: ARCHIVED lesson stays visible for management");
  ok(!!byId[L.archived.id]?.archived, "D: ARCHIVED lesson is flagged `archived` (not filtered out)");
  eq(byId[L.legacy.id]?.chain, "LEGACY", "D: topic-chained lesson is labelled LEGACY, not dropped");
  ok(!byId[L.b.id], "D: another teacher's lesson is absent from the picker");
  ok(
    lessonsRes.json.grouped?.some((c) => c.id === courseA.id && c.parts?.length > 0),
    "D: grouped view nests course → parts → units",
    JSON.stringify(lessonsRes.json.grouped?.map((c) => [c.id, c.parts?.length]))
  );
  const groupedLesson = lessonsRes.json.grouped
    .flatMap((c) => c.parts)
    .flatMap((p) => p.units)
    .flatMap((u) => u.lessons);
  ok(
    groupedLesson.some((l) => l.id === L.pub.id),
    "D: grouped view contains the canonical lesson"
  );

  // ---- E. homework creation ----------------------------------------------
  const deadline = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const hwCreate = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id,
    title: "New homework",
    titleAr: "واجب جديد",
    instructions: "Do the exercises.",
    deadline,
    maxMarks: 20,
  });
  eq(hwCreate.status, 200, "E: POST /api/teacher/homework → 200");
  eq(hwCreate.json.homework.trackScope, "ARABIC", "E: an absent scope INHERITS the lesson's (ARABIC)");
  eq(hwCreate.json.homework.trackScopeInherited, true, "E: inheritance is reported explicitly");
  const createdHomeworkId = hwCreate.json.homework.id;

  const hwExplicit = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.pub.id,
    title: "Shared homework",
    instructions: "Do the exercises.",
    deadline,
    maxMarks: 5,
    trackScope: "LANGUAGE",
  });
  eq(hwExplicit.status, 200, "E: explicit track scope inside a SHARED lesson is allowed");
  eq(hwExplicit.json.homework.trackScope, "LANGUAGE", "E: explicit scope is stored verbatim");
  eq(hwExplicit.json.homework.trackScopeInherited, false, "E: explicit scope is not reported as inherited");

  const hwBadScope = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, title: "Nope", instructions: "x", deadline, trackScope: "LANGUAGE",
  });
  eq(hwBadScope.status, 400, "E: a scope outside the lesson's is refused (400)");
  ok(!!hwBadScope.json.error, "E: refusal carries a localized message");

  const hwUnknownScope = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, title: "Nope", instructions: "x", deadline, trackScope: "MIXED",
  });
  eq(hwUnknownScope.status, 400, "E: an unknown scope value is refused (400)");

  const hwNoTitle = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, instructions: "x", deadline,
  });
  eq(hwNoTitle.status, 400, "E: a missing title is refused (400)");
  const hwNoInstructions = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, title: "No instructions", deadline,
  });
  eq(hwNoInstructions.status, 400, "E: missing instructions are refused (400) — readiness needs them");
  const hwBadDeadline = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, title: "Bad deadline", instructions: "x", deadline: "not-a-date",
  });
  eq(hwBadDeadline.status, 400, "E: an unparseable deadline is refused (400)");
  const hwBadMarks = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, title: "Bad marks", instructions: "x", deadline, maxMarks: 0,
  });
  eq(hwBadMarks.status, 400, "E: out-of-range marks are refused (400)");
  const hwLongTitle = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, title: "x".repeat(161), instructions: "x", deadline,
  });
  eq(hwLongTitle.status, 400, "E: an over-long title is refused (400)");
  const hwLongInstructions = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, title: "Long", instructions: "x".repeat(4001), deadline,
  });
  eq(hwLongInstructions.status, 400, "E: over-long instructions are refused (400)");

  const hwOtherLesson = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.b.id, title: "Foreign", instructions: "x", deadline,
  });
  eq(hwOtherLesson.status, 403, "E: creating homework on another teacher's lesson → 403");
  const hwMissingLesson = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: "does-not-exist", title: "Missing", instructions: "x", deadline,
  });
  eq(hwMissingLesson.status, 404, "E: an unknown lesson id → 404 (not an ownership oracle)");
  const hwOrphanLesson = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.orphan.id, title: "Orphan", instructions: "x", deadline,
  });
  eq(hwOrphanLesson.status, 404, "E: a lesson with no course chain → 404, never authorized");
  const hwArchived = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.archived.id, title: "Archived", instructions: "x", deadline,
  });
  eq(hwArchived.status, 409, "E: no NEW homework on an ARCHIVED lesson → 409");
  const hwLegacyOk = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.legacy.id, title: "Legacy hw", instructions: "x", deadline,
  });
  eq(hwLegacyOk.status, 200, "E: the legacy topic chain still authorizes homework creation");

  asUser(teacherUserB);
  const hwAsB = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.ar.id, title: "Cross", instructions: "x", deadline,
  });
  eq(hwAsB.status, 403, "E: teacher B cannot create homework on teacher A's lesson → 403");

  // ---- F. homework update: graded history is preserved --------------------
  asUser(teacherUserA);
  const hwPatch = await PATCH_JSON(R.homeworkById, url(`/api/teacher/homework/${homeworkGraded.id}`), {
    title: "Renamed homework",
    instructions: "Solve 1-10.",
  }, { id: homeworkGraded.id });
  eq(hwPatch.status, 200, "F: PATCH homework title/instructions → 200");
  eq(hwPatch.json.homework.gradedCount, 1, "F: the graded submission is reported as preserved");
  eq(hwPatch.json.homework.preservedGrades, 1, "F: preserved grade count is returned");
  const subAfterPatch = await client.homeworkSubmission.findUnique({
    where: { homeworkId_studentId: { homeworkId: homeworkGraded.id, studentId: studentAr.id } },
  });
  eq(subAfterPatch.grade, 7, "F: a metadata edit does NOT touch the stored grade");
  eq(subAfterPatch.status, "GRADED", "F: a metadata edit does NOT touch the submission status");

  const hwMove = await PATCH_JSON(R.homeworkById, url(`/api/teacher/homework/${homeworkGraded.id}`), {
    lessonId: L.ar.id,
  }, { id: homeworkGraded.id });
  eq(hwMove.status, 400, "F: moving homework to another lesson is refused (destructive)");

  const hwShrink = await PATCH_JSON(R.homeworkById, url(`/api/teacher/homework/${homeworkGraded.id}`), {
    maxMarks: 5,
  }, { id: homeworkGraded.id });
  eq(hwShrink.status, 409, "F: maxMarks below the highest stored grade is refused (409)");

  const hwRetag = await PATCH_JSON(R.homeworkById, url(`/api/teacher/homework/${homeworkGraded.id}`), {
    trackScope: "ARABIC",
  }, { id: homeworkGraded.id });
  eq(hwRetag.status, 409, "F: re-tagging homework that already has graded work is refused (409)");

  const hwNoop = await PATCH_JSON(R.homeworkById, url(`/api/teacher/homework/${homeworkGraded.id}`), {}, { id: homeworkGraded.id });
  eq(hwNoop.status, 400, "F: an empty patch is refused (400)");

  const hwOtherPatch = await PATCH_JSON(R.homeworkById, url(`/api/teacher/homework/${createdHomeworkId}`), {
    lessonId: L.b.id,
  }, { id: createdHomeworkId });
  eq(hwOtherPatch.status, 400, "F: a cross-course lesson move is refused before any ownership leak");

  asUser(teacherUserB);
  const hwPatchForeign = await PATCH_JSON(R.homeworkById, url(`/api/teacher/homework/${createdHomeworkId}`), {
    title: "Hijack",
  }, { id: createdHomeworkId });
  eq(hwPatchForeign.status, 403, "F: teacher B cannot patch teacher A's homework → 403");

  // ---- G. quiz creation: timeLimit + track scope persisted ----------------
  asUser(teacherUserA);
  const quizCreate = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.pub.id,
    title: "Timed quiz",
    titleAr: "اختبار موقوت",
    description: "d",
    passMark: 60,
    timeLimit: 30,
    trackScope: "ARABIC",
    questions: [
      {
        type: "MCQ", prompt: "Pick 0", options: ["zero", "one"], answer: "0",
        marks: 1, schoolType: "ARABIC",
      },
    ],
  });
  eq(quizCreate.status, 200, "G: POST /api/teacher/quizzes → 200");
  eq(quizCreate.json.quiz.timeLimit, 30, "G: timeLimit is persisted (not decorative)");
  eq(quizCreate.json.quiz.trackScope, "ARABIC", "G: explicit quiz scope inside a SHARED lesson is stored");
  eq(quizCreate.json.quiz.trackScopeExplicit, true, "G: explicit scope is flagged");
  const timedQuizId = quizCreate.json.quiz.id;

  const quizInherit = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.ar.id,
    title: "Inherited quiz",
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  eq(quizInherit.status, 200, "G: quiz creation on an ARABIC lesson → 200");
  eq(quizInherit.json.quiz.trackScope, "ARABIC", "G: an absent scope INHERITS the lesson's (never SHARED)");
  eq(quizInherit.json.quiz.trackScopeExplicit, false, "G: inheritance is reported as non-explicit");

  const quizBadScope = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.ar.id,
    title: "Bad scope",
    trackScope: "LANGUAGE",
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  eq(quizBadScope.status, 400, "G: a quiz scope outside the lesson's is refused (400)");

  const quizBadLimit = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.pub.id, title: "Bad limit", timeLimit: 0,
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  eq(quizBadLimit.status, 400, "G: a non-positive timeLimit is refused, never silently clamped");

  const quizNoQuestions = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.pub.id, title: "Empty quiz", questions: [],
  });
  eq(quizNoQuestions.status, 400, "G: a quiz with no questions is refused (400)");

  const quizArchived = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.archived.id, title: "Archived quiz",
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  eq(quizArchived.status, 409, "G: no NEW quiz on an ARCHIVED lesson → 409");

  const quizForeignLesson = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.b.id, title: "Foreign quiz",
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  eq(quizForeignLesson.status, 403, "G: a quiz on another teacher's lesson → 403");

  // ---- H. question append: the quiz scope is the ceiling ------------------
  const qAppend = await POST_JSON(R.quizQuestions, url(`/api/teacher/quizzes/${quizShared.id}/questions`), {
    type: "MCQ", prompt: "Appended", options: ["a", "b"], answer: "1", marks: 2,
  }, { id: quizShared.id });
  eq(qAppend.status, 200, "H: POST quiz/[id]/questions → 200");
  eq(qAppend.json.question.schoolType, null, "H: an untagged question in a SHARED quiz inherits SHARED (null)");
  ok(qAppend.json.questionCount >= 4, "H: the running question count is returned");
  const appendedId = qAppend.json.question.id;

  const qOutOfScope = await POST_JSON(R.quizQuestions, url(`/api/teacher/quizzes/${quizInherit.json.quiz.id}/questions`), {
    type: "MCQ", prompt: "Wrong track", options: ["a", "b"], answer: "0", schoolType: "LANGUAGE",
  }, { id: quizInherit.json.quiz.id });
  eq(qOutOfScope.status, 400, "H: a LANGUAGE question inside an ARABIC quiz is refused (unreachable content)");

  const qBadAnswer = await POST_JSON(R.quizQuestions, url(`/api/teacher/quizzes/${quizShared.id}/questions`), {
    type: "MCQ", prompt: "Bad answer", options: ["a", "b"], answer: "9",
  }, { id: quizShared.id });
  eq(qBadAnswer.status, 400, "H: an out-of-range answer index is refused (400)");

  const qTooFewOptions = await POST_JSON(R.quizQuestions, url(`/api/teacher/quizzes/${quizShared.id}/questions`), {
    type: "MCQ", prompt: "One option", options: ["a"], answer: "0",
  }, { id: quizShared.id });
  eq(qTooFewOptions.status, 400, "H: fewer than two options is refused (400)");

  asUser(teacherUserB);
  const qForeignAppend = await POST_JSON(R.quizQuestions, url(`/api/teacher/quizzes/${quizShared.id}/questions`), {
    type: "MCQ", prompt: "Foreign", options: ["a", "b"], answer: "0",
  }, { id: quizShared.id });
  eq(qForeignAppend.status, 403, "H: teacher B cannot append to teacher A's quiz → 403");

  // ---- I. question read: reference counters surfaced ----------------------
  asUser(teacherUserA);
  const qPinnedGet = await GET(R.questionById, url(`/api/teacher/questions/${qPinned.id}`), { id: qPinned.id });
  eq(qPinnedGet.status, 200, "I: GET teacher question → 200");
  eq(qPinnedGet.json.references.fixedExamPins, 1, "I: the FIXED pin count is surfaced");
  eq(qPinnedGet.json.canDelete, false, "I: canDelete is false while a FIXED exam pins the question");
  ok(
    qPinnedGet.json.deleteBlockers.includes("FIXED_EXAM_PIN"),
    "I: the blocker list names FIXED_EXAM_PIN"
  );
  eq(qPinnedGet.json.mockExamPins[0].mockExamId, fixedExam.id, "I: the pin names the exam that holds it");
  eq(qPinnedGet.json.quiz.trackScope, "SHARED", "I: the owning quiz scope is returned");

  const qFrozenGet = await GET(R.questionById, url(`/api/teacher/questions/${qFrozen.id}`), { id: qFrozen.id });
  eq(qFrozenGet.json.references.gradedAttempts, 1, "I: graded attempt history is counted");
  eq(qFrozenGet.json.canEditAnswerKey, false, "I: the answer key is locked once an attempt exists");

  const qBankGet = await GET(R.questionById, url(`/api/teacher/questions/${qBank.id}`), { id: qBank.id });
  eq(qBankGet.status, 403, "I: a bank question (no quiz) is not teacher-managed content → 403");

  const qOtherGet = await GET(R.questionById, url(`/api/teacher/questions/${qOther.id}`), { id: qOther.id });
  eq(qOtherGet.status, 403, "I: another teacher's question → 403");

  // ---- J. question update: frozen-attempt locks ---------------------------
  const qTextEdit = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${qFrozen.id}`), {
    prompt: "Frozen question (wording fixed)",
  }, { id: qFrozen.id });
  eq(qTextEdit.status, 200, "J: prompt-only edit is allowed with frozen history");
  eq(qTextEdit.json.question.prompt, "Frozen question (wording fixed)", "J: the prompt really changed");

  const qAnswerEdit = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${qFrozen.id}`), {
    answer: "1",
  }, { id: qFrozen.id });
  eq(qAnswerEdit.status, 409, "J: editing the answer key under frozen history is refused (409)");
  const qAfterRefusal = await client.question.findUnique({ where: { id: qFrozen.id } });
  eq(qAfterRefusal.answer, "0", "J: the refused edit wrote NOTHING (the frozen attempt still grades correctly)");

  const qOptionsEdit = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${qFrozen.id}`), {
    options: ["yes", "no", "maybe"],
  }, { id: qFrozen.id });
  eq(qOptionsEdit.status, 409, "J: editing the option list under frozen history is refused (409)");

  const qTagEdit = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${qFrozen.id}`), {
    schoolType: "ARABIC",
  }, { id: qFrozen.id });
  eq(qTagEdit.status, 409, "J: re-tagging an answered question is refused (409)");

  const qOpenEdit = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${qOpen.id}`), {
    answer: "1",
  }, { id: qOpen.id });
  eq(qOpenEdit.status, 409, "J: editing the answer key under an OPEN attempt is refused (409)");

  const qOpenText = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${qOpen.id}`), {
    explanation: "Added afterwards.",
  }, { id: qOpen.id });
  eq(qOpenText.status, 200, "J: an explanation edit is safe even under an open attempt");

  const qInvalidEdit = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${appendedId}`), {
    options: ["only-one"],
  }, { id: appendedId });
  eq(qInvalidEdit.status, 400, "J: an edit is re-validated against the same draft rules (400)");

  const qEmptyEdit = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${appendedId}`), {}, { id: appendedId });
  eq(qEmptyEdit.status, 400, "J: an empty patch is refused (400)");

  const qTagWithin = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${appendedId}`), {
    schoolType: "SHARED",
  }, { id: appendedId });
  eq(qTagWithin.status, 200, "J: an explicit SHARED tag is accepted inside a SHARED quiz");

  const qTagOutOfQuiz = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${appendedId}`), {
    schoolType: "BOGUS",
  }, { id: appendedId });
  eq(qTagOutOfQuiz.status, 400, "J: an unparseable tag is refused (400)");

  asUser(teacherUserB);
  const qForeignEdit = await PATCH_JSON(R.questionById, url(`/api/teacher/questions/${qFrozen.id}`), {
    prompt: "Hijack",
  }, { id: qFrozen.id });
  eq(qForeignEdit.status, 403, "J: teacher B cannot edit teacher A's question → 403");

  // ---- K. question delete: refusal when referenced ------------------------
  asUser(teacherUserA);
  const delPinned = await DELETE(R.questionById, url(`/api/teacher/questions/${qPinned.id}`), { id: qPinned.id });
  eq(delPinned.status, 409, "K: deleting a FIXED-pinned question is refused (409)");
  const stillPinned = await client.mockExamQuestion.findMany({ where: { mockExamId: fixedExam.id } });
  eq(stillPinned.length, 1, "K: the FIXED exam definition did not shrink");
  const pinnedQuestionStillThere = await client.question.findUnique({ where: { id: qPinned.id } });
  ok(!!pinnedQuestionStillThere, "K: the refused delete left the question row intact");

  const delFrozen = await DELETE(R.questionById, url(`/api/teacher/questions/${qFrozen.id}`), { id: qFrozen.id });
  eq(delFrozen.status, 409, "K: deleting a question with frozen answer history is refused (409)");
  const frozenRows = await client.quizAnswer.findMany({ where: { questionId: qFrozen.id } });
  eq(frozenRows.length, 1, "K: the frozen answer row survives the refused delete");

  const delOpen = await DELETE(R.questionById, url(`/api/teacher/questions/${qOpen.id}`), { id: qOpen.id });
  eq(delOpen.status, 409, "K: deleting a question in an OPEN attempt is refused (409)");

  const delAppended = await DELETE(R.questionById, url(`/api/teacher/questions/${appendedId}`), { id: appendedId });
  eq(delAppended.status, 200, "K: an unreferenced question is deletable");
  eq(delAppended.json.deleted, true, "K: the delete is reported");
  const gone = await client.question.findUnique({ where: { id: appendedId } });
  ok(!gone, "K: the unreferenced question really is gone");

  asUser(teacherUserB);
  const delForeign = await DELETE(R.questionById, url(`/api/teacher/questions/${qFree.id}`), { id: qFree.id });
  eq(delForeign.status, 403, "K: teacher B cannot delete teacher A's question → 403");

  // ---- L. quiz delete: attempts + FIXED pins protect the quiz -------------
  asUser(teacherUserA);
  const delQuizWithAttempts = await DELETE(R.quizById, url(`/api/teacher/quizzes/${quizShared.id}`), { id: quizShared.id });
  eq(delQuizWithAttempts.status, 409, "L: deleting a quiz that students have attempted is refused (409)");

  const delQuizWithOpenAttempt = await DELETE(R.quizById, url(`/api/teacher/quizzes/${quizOpen.id}`), { id: quizOpen.id });
  eq(delQuizWithOpenAttempt.status, 409, "L: a quiz with an OPEN attempt is protected too (409)");

  const cleanQuiz = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.pub.id,
    title: "Disposable quiz",
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  eq(cleanQuiz.status, 200, "L: a disposable quiz is created for the delete path");
  const delCleanQuiz = await DELETE(R.quizById, url(`/api/teacher/quizzes/${cleanQuiz.json.quiz.id}`), {
    id: cleanQuiz.json.quiz.id,
  });
  eq(delCleanQuiz.status, 200, "L: an unreferenced quiz is deletable");
  eq(delCleanQuiz.json.deleted, true, "L: the quiz delete is reported");

  asUser(teacherUserB);
  const delForeignQuiz = await DELETE(R.quizById, url(`/api/teacher/quizzes/${quizShared.id}`), { id: quizShared.id });
  eq(delForeignQuiz.status, 403, "L: teacher B cannot delete teacher A's quiz → 403");

  // The question-bank admin surface still pins what it is told to pin.
  asUser(adminUser);
  const examCreate = await POST_JSON(R.mockExams, url("/api/admin/mock-exams"), {
    title: "Admin fixed exam",
    schoolType: "ARABIC",
    questionCount: 1,
    selectionMode: "FIXED",
    difficulty: "MIXED",
  });
  eq(examCreate.status, 200, "L: the admin FIXED-exam ceremony still creates exams");
  const newExamId = examCreate.json.exam.id;
  const newExamPins = await client.mockExamQuestion.findMany({ where: { mockExamId: newExamId } });
  eq(newExamPins.length, 1, "L: a FIXED exam pins exactly the requested number of questions");

  // ---- M. time-limit enforcement on the real clock ------------------------
  const timedQuizRow = await client.quiz.findUnique({ where: { id: timedQuizId } });
  eq(timedQuizRow.timeLimit, 30, "M: the created quiz stores its time limit");

  asUser(studentUserAr);
  const start1 = await POST_JSON(R.quizStart, url(`/api/quizzes/${timedQuizId}/start`), {}, { id: timedQuizId });
  eq(start1.status, 200, "M: student /start on the timed quiz → 200");
  eq(start1.json.timeLimitMinutes, 30, "M: the server reports the time limit");
  eq(start1.json.resumed, false, "M: a first start is not a resume");
  const expiresAt = start1.json.expiresAt ? new Date(start1.json.expiresAt).getTime() : null;
  const startedAt = start1.json.startedAt ? new Date(start1.json.startedAt).getTime() : null;
  ok(
    typeof expiresAt === "number" && typeof startedAt === "number" &&
      expiresAt - startedAt === 30 * 60_000 + 30_000,
    "M: the deadline is server-computed (start + limit + grace), never client-supplied",
    `${expiresAt} - ${startedAt}`
  );
  ok(typeof start1.json.remainingSeconds === "number" && start1.json.remainingSeconds > 1700,
    "M: remaining seconds come from the server clock");

  const submitOnTime = await POST_JSON(R.quizSubmit, url(`/api/quizzes/${timedQuizId}/submit`), {
    answers: [],
  }, { id: timedQuizId });
  eq(submitOnTime.status, 200, "M: an in-window submit is graded normally");

  // A second attempt, aged past its deadline: late answers must NOT be graded.
  const start2 = await POST_JSON(R.quizStart, url(`/api/quizzes/${timedQuizId}/start`), {}, { id: timedQuizId });
  eq(start2.status, 200, "M: a retake after the first submit starts a fresh attempt");
  const agedStart = new Date(Date.now() - 40 * 60_000);
  await client.quizAttempt.update({
    where: { id: start2.json.attemptId },
    data: { startedAt: agedStart },
  });
  const lateSubmit = await POST_JSON(R.quizSubmit, url(`/api/quizzes/${timedQuizId}/submit`), {
    answers: [{ questionId: (await client.question.findFirst({ where: { quizId: timedQuizId } })).id, selected: "0" }],
  }, { id: timedQuizId });
  eq(lateSubmit.status, 409, "M: a submit past the deadline is refused (409)");
  eq(lateSubmit.json.code, "TIME_LIMIT_EXCEEDED", "M: the refusal is machine-readable");
  eq(lateSubmit.json.score, 0, "M: the expired attempt is finalised from server-held answers (zero)");
  const lateAttempt = await client.quizAttempt.findUnique({ where: { id: start2.json.attemptId } });
  ok(!!lateAttempt.finishedAt, "M: the expired attempt ends up FINISHED (no permanently open attempt)");
  ok(
    Math.abs(new Date(lateAttempt.finishedAt).getTime() - (agedStart.getTime() + 30 * 60_000 + 30_000)) < 1000,
    "M: finishedAt is the DEADLINE, not the late request's time"
  );

  const resumeAfterExpiry = await POST_JSON(R.quizStart, url(`/api/quizzes/${timedQuizId}/start`), {}, { id: timedQuizId });
  eq(resumeAfterExpiry.status, 200, "M: /start after an expiry → 200");
  eq(resumeAfterExpiry.json.resumed, false, "M: an expired attempt is never resumed (no banked time)");
  ok(resumeAfterExpiry.json.attemptId !== start2.json.attemptId, "M: a FRESH attempt with a fresh clock is created");

  const studentTeacherWrite = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.pub.id, title: "Student authored",
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  eq(studentTeacherWrite.status, 403, "M: the student session cannot reach teacher writes");

  asUser(teacherUserA);
  const noLimitQuiz = await POST_JSON(R.quizzes, url("/api/teacher/quizzes"), {
    lessonId: L.lang.id,
    title: "Untimed",
    timeLimit: "",
    questions: [{ type: "MCQ", prompt: "p", options: ["a", "b"], answer: "0" }],
  });
  eq(noLimitQuiz.status, 200, "M: an empty timeLimit creates an untimed quiz");
  eq(noLimitQuiz.json.quiz.timeLimit, null, "M: no limit is stored as null (never 0)");

  // ---- N. student homework submission + track isolation -------------------
  // The student-facing assignment lives on the FIRST published lesson (the only
  // one progression unlocks without prerequisites) and is explicitly ARABIC, so
  // the isolation under test is the RESOURCE gate, not the lesson order.
  const hwArOnly = await POST_JSON(R.homework, url("/api/teacher/homework"), {
    lessonId: L.pub.id, title: "Arabic only", titleAr: "واجب عربي",
    instructions: "x", deadline, maxMarks: 5, trackScope: "ARABIC",
  });
  eq(hwArOnly.status, 200, "N: an ARABIC-scoped assignment is created");
  const hwArId = hwArOnly.json.homework.id;

  asUser(studentUserAr);
  const subAr = await POST_JSON(R.studentHomework, url("/api/students/me/homework"), {
    homeworkId: hwArId, content: "my answer",
  });
  eq(subAr.status, 200, "N: the ARABIC student can submit the ARABIC assignment");
  const subArRow = await client.homeworkSubmission.findUnique({
    where: { homeworkId_studentId: { homeworkId: hwArId, studentId: studentAr.id } },
  });
  eq(subArRow.status, "SUBMITTED", "N: the submission is stored with the existing status contract");

  await client.homeworkSubmission.update({
    where: { id: subArRow.id },
    data: { status: "GRADED", grade: 9 },
  });
  const subTwice = await POST_JSON(R.studentHomework, url("/api/students/me/homework"), {
    homeworkId: hwArId, content: "second try",
  });
  eq(subTwice.status, 409, "N: a GRADED submission stays immutable to the student (409)");

  asUser(studentUserLang);
  const subLang = await POST_JSON(R.studentHomework, url("/api/students/me/homework"), {
    homeworkId: hwArId, content: "wrong track",
  });
  // The refusal is deliberately the SAME non-oracle 404 a nonexistent resource
  // returns (src/lib/session-progress.ts): a student probing the other track's
  // ids must not learn that they exist.
  eq(subLang.status, 404, "N: the LANGUAGE student is refused the ARABIC assignment (non-oracle 404)");

  // ---- O. teacher analytics: Phase 6 shape + trackSplit -------------------
  asUser(teacherUserA);
  const analytics = await GET(R.teacherAnalytics, url("/api/teacher/analytics"));
  eq(analytics.status, 200, "O: GET /api/teacher/analytics → 200");
  ok(!!analytics.json.overview, "O: the Phase 6 overview is still returned");
  ok(!!analytics.json.overview.trackSplit, "O: the overview carries a trackSplit");
  eq(
    Object.keys(analytics.json.overview.trackSplit).sort(),
    ["ARABIC", "LANGUAGE", "SHARED"],
    "O: trackSplit is bucketed by the shared TRACK_BUCKETS contract"
  );
  const groups = analytics.json.groups || [];
  ok(groups.length > 0, "O: the teacher's groups are listed");
  groups.forEach((g, i) => ok(!!g.trackSplit, `O: group #${i} carries a trackSplit`));

  // ---- P. the quiz detail contract (student surface) is untouched ---------
  asUser(studentUserAr);
  const quizDetail = await GET(R.quizDetail, url(`/api/quizzes/${timedQuizId}`), { id: timedQuizId });
  eq(quizDetail.status, 200, "P: GET /api/quizzes/[id] → 200 for the enrolled student");
  ok(
    "attemptWindow" in quizDetail.json.quiz,
    "P: the attempt window is part of the quiz payload"
  );
  const win = quizDetail.json.quiz.attemptWindow;
  ok(!!win && !!win.expiresAt, "P: the OPEN attempt's server deadline is rendered back to the client");
  ok(
    !!win && Number.isFinite(new Date(win.expiresAt).getTime()) &&
      new Date(win.expiresAt).getTime() > Date.now(),
    "P: the reported deadline agrees with the freshly created attempt (no client clock involved)"
  );

  R.restore();

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    console.log("failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("verify-phase18-teacher crashed:", e);
  process.exit(1);
});
