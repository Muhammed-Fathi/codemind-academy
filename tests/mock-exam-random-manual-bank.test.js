// CodeMind Academy — Mock Exam: RANDOM/FIXED with MANUALLY created questions.
//
// Reproduces the reported defect end-to-end against the REAL route handlers
// (in-memory Prisma emulator; no DB is touched):
//
//   Admin "Add Question"  ->  Question row with quizId = NULL (no lesson)
//   Admin creates a RANDOM exam  ->  student attempt must be able to receive it
//
// The contract this suite pins (round 2):
//
//   * a manual Question Bank row is ELIGIBLE for a RANDOM exam only through an
//     explicit per-exam attachment (`MockExamQuestion`) — never globally, so it
//     can never leak into another course of the same school type;
//   * RANDOM serves exactly `count` distinct eligible questions;
//   * FIXED serves exactly the pinned ids in pinned order (an explicit pin is
//     bound to ONE exam and is not a cross-course leak);
//   * the paper is FROZEN when the attempt STARTS: the ordered ids live on the
//     OPEN `ExamAttempt` row (`finishedAt = NULL`) and are replayed on every
//     later fetch, so a bank change mid-attempt can neither swap nor add a
//     question — and after a submit the next start draws a NEW paper;
//   * an undersized pool is reported and refused at creation, never silently
//     half-served;
//   * bank isolation, course isolation, enrollment gates, admin-only
//     authorization and the no-answer-key-before-submit rule all still hold.
//
// Run: node tests/mock-exam-random-manual-bank.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-manual-bank-"));

// ---------------------------------------------------------------------------
// 1. Compile the files under test with tsc (type errors fail the suite)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/school-type.ts",
  "src/lib/enrollment.ts",
  "src/lib/api.ts",
  "src/lib/mock-exam-pool.ts",
  "src/app/api/exams/mock/route.ts",
  "src/app/api/admin/mock-exams/route.ts",
  "src/app/api/admin/mock-exams/[id]/route.ts",
  "src/app/api/admin/mock-exams/eligible/route.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      jsx: "react-jsx",
      strict: true,
      noImplicitAny: false,
      skipLibCheck: true,
      esModuleInterop: true,
      baseUrl: REPO,
      rootDir: REPO,
      paths: { "@/*": ["src/*"] },
      typeRoots: [path.join(REPO, "node_modules/@types")],
      outDir: OUT,
      noEmitOnError: false,
    },
    files: FILES.map((f) => path.join(REPO, f)),
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch (e) {
  const emitted = path.join(OUT, "src/app/api/exams/mock/route.js");
  if (!fs.existsSync(emitted)) {
    console.error(String(e.stdout || e.message));
    process.exit(1);
  }
}
const compiled = (f) => path.join(OUT, f.replace(/\.tsx?$/, ".js"));

// ---------------------------------------------------------------------------
// 2. In-memory mock Prisma client (Prisma-subset emulator)
// ---------------------------------------------------------------------------
function makeMockDb() {
  const t = {
    user: [], student: [], group: [], course: [], part: [], unit: [], topic: [],
    lesson: [], quiz: [], question: [], examQuestion: [], mockExam: [],
    mockExamQuestion: [], examAttempt: [], quizAttempt: [], quizAnswer: [],
    lessonProgress: [],
  };
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const byId = (arr, id) => arr.find((r) => r.id === id) || null;
  let seq = 1;

  function relOf(table, row, key) {
    const k = `${table}.${key}`;
    switch (k) {
      case "lesson.topic": return row.topicId ? byId(t.topic, row.topicId) : null;
      case "lesson.unit": return row.unitId ? byId(t.unit, row.unitId) : null;
      case "topic.unit": return byId(t.unit, row.unitId);
      case "unit.part": return byId(t.part, row.partId);
      case "part.course": return byId(t.course, row.courseId);
      case "quiz.lesson": return byId(t.lesson, row.lessonId);
      case "question.quiz": return row.quizId ? byId(t.quiz, row.quizId) : null;
      case "examQuestion.lesson": return row.lessonId ? byId(t.lesson, row.lessonId) : null;
      case "student.group": return row.groupId ? byId(t.group, row.groupId) : null;
      case "student.subscription": return null;
      case "group.course": return byId(t.course, row.courseId);
      case "mockExam.course": return row.courseId ? byId(t.course, row.courseId) : null;
      case "mockExam.questions": return t.mockExamQuestion.filter((l) => l.mockExamId === row.id);
      case "mockExam.attempts": return t.examAttempt.filter((a) => a.mockExamId === row.id);
      case "mockExamQuestion.question": return row.questionId ? byId(t.question, row.questionId) : null;
      case "mockExamQuestion.examQuestion": return row.examQuestionId ? byId(t.examQuestion, row.examQuestionId) : null;
      // The attachment back-relations (`mockExamLinks`): the per-exam pool
      // membership filter reads them, so the shim must resolve them too.
      case "question.mockExamLinks": return t.mockExamQuestion.filter((l) => l.questionId === row.id);
      case "examQuestion.mockExamLinks": return t.mockExamQuestion.filter((l) => l.examQuestionId === row.id);
      case "examAttempt.mockExam": return row.mockExamId ? byId(t.mockExam, row.mockExamId) : null;
      default: return undefined;
    }
  }
  const TABLE_OF = {
    "lesson.topic": "topic", "lesson.unit": "unit", "topic.unit": "unit",
    "unit.part": "part", "part.course": "course", "quiz.lesson": "lesson",
    "question.quiz": "quiz", "examQuestion.lesson": "lesson",
    "student.group": "group", "student.subscription": "subscription",
    "group.course": "course", "mockExam.course": "course",
    "mockExam.questions": "mockExamQuestion", "mockExam.attempts": "examAttempt",
    "mockExamQuestion.question": "question",
    "mockExamQuestion.examQuestion": "examQuestion",
    "question.mockExamLinks": "mockExamQuestion",
    "examQuestion.mockExamLinks": "mockExamQuestion",
    "examAttempt.mockExam": "mockExam",
  };
  const OP_KEYS = new Set(["in", "not", "gte", "gt", "lte", "lt", "equals"]);

  function matches(row, where, table) {
    if (!where) return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === "OR" && Array.isArray(v)) return v.some((w) => matches(row, w, table));
      if (k === "AND" && Array.isArray(v)) return v.every((w) => matches(row, w, table));
      if (v !== null && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
        const keys = Object.keys(v);
        if (keys.some((x) => OP_KEYS.has(x))) {
          if ("in" in v) return v.in.includes(row[k]);
          // SQL 3-valued `not`: NULL never matches `not <value>` (shared pins
          // survive a bank switch); `not: null` means IS NOT NULL.
          if ("not" in v) {
            if (v.not === null) return row[k] !== null;
            if (row[k] === null || row[k] === undefined) return false;
            return row[k] !== v.not;
          }
          let ok = true;
          if ("gte" in v) ok = ok && row[k] >= v.gte;
          if ("gt" in v) ok = ok && row[k] > v.gt;
          if ("lte" in v) ok = ok && row[k] <= v.lte;
          if ("lt" in v) ok = ok && row[k] < v.lt;
          if ("equals" in v) ok = ok && row[k] === v.equals;
          return ok;
        }
        const rel = relOf(table, row, k);
        const relTable = TABLE_OF[`${table}.${k}`];
        if (rel === undefined) return true;
        if (v && typeof v === "object" && "some" in v) {
          return Array.isArray(rel) && rel.some((r) => matches(r, v.some, relTable));
        }
        if (rel == null) return false;
        if (Array.isArray(rel)) return rel.some((r) => matches(r, v, relTable));
        return matches(rel, v, relTable);
      }
      return row[k] === v;
    });
  }

  function sortRows(arr, orderBy) {
    const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...arr].sort((a, b) => {
      for (const o of keys) {
        const [k, dir] = Object.entries(o)[0];
        const av = a[k], bv = b[k];
        if (av == null && bv == null) continue;
        if (av == null) return dir === "asc" ? -1 : 1;
        if (bv == null) return dir === "asc" ? 1 : -1;
        if (av < bv) return dir === "asc" ? -1 : 1;
        if (av > bv) return dir === "asc" ? 1 : -1;
      }
      return 0;
    });
  }

  function resolveRelation(table, row, key, spec) {
    const relTable = TABLE_OF[`${table}.${key}`];
    const val = relOf(table, row, key);
    if (val === undefined || val === null) return val ?? null;
    const applySpec = (r) => {
      if (spec === true) return clone(r);
      const s = spec || {};
      return project(relTable, r, s.select || null, s.include || null);
    };
    if (Array.isArray(val)) {
      let arr = val;
      const s = spec === true ? {} : spec || {};
      if (s.where) arr = arr.filter((r) => matches(r, s.where, relTable));
      if (s.orderBy) arr = sortRows(arr, s.orderBy);
      if (s.take !== undefined) arr = arr.slice(0, s.take);
      return arr.map(applySpec);
    }
    return applySpec(val);
  }

  function project(table, row, select, include) {
    if (!row) return row;
    if (select) {
      const out = {};
      for (const [k, v] of Object.entries(select)) {
        if (v === true) out[k] = clone(row[k]);
        else if (v && typeof v === "object") out[k] = resolveRelation(table, row, k, v);
      }
      return out;
    }
    const out = clone(row);
    if (include) {
      for (const [k, v] of Object.entries(include)) {
        if (k === "_count") {
          const sel = (v && v.select) || {};
          const counts = {};
          if (sel.questions) counts.questions = (relOf(table, row, "questions") || []).length;
          if (sel.attempts) counts.attempts = (relOf(table, row, "attempts") || []).length;
          out._count = counts;
        } else {
          out[k] = v === true ? resolveRelation(table, row, k, true) : resolveRelation(table, row, k, v);
        }
      }
    }
    return out;
  }

  function delegate(table) {
    const runFind = (args = {}) => {
      let arr = t[table].filter((r) => matches(r, args.where, table));
      if (args.orderBy) arr = sortRows(arr, args.orderBy);
      if (args.take !== undefined) arr = arr.slice(0, args.take);
      return arr.map((r) => project(table, r, args.select || null, args.include || null));
    };
    return {
      async findMany(args) { return runFind(args); },
      async findFirst(args) { return runFind(args)[0] || null; },
      async findUnique(args = {}) {
        const w = args.where || {};
        const keys = Object.keys(w);
        const row = t[table].find((r) => keys.every((k) => r[k] === w[k]));
        return row ? project(table, row, args.select || null, args.include || null) : null;
      },
      async count(args = {}) {
        return t[table].filter((r) => matches(r, args.where, table)).length;
      },
      async create({ data }) {
        trackWrite(table, "create");
        const row = { id: `${table}-${seq++}`, ...clone(data) };
        t[table].push(row);
        return clone(row);
      },
      async createMany({ data }) {
        trackWrite(table, "createMany");
        for (const d of data) t[table].push({ id: `${table}-${seq++}`, ...clone(d) });
        return { count: data.length };
      },
      async update({ where, data }) {
        trackWrite(table, "update");
        const keys = Object.keys(where || {});
        const row = t[table].find((r) => keys.every((k) => r[k] === where[k]));
        if (row) Object.assign(row, clone(data));
        return row ? clone(row) : null;
      },
      async updateMany({ where, data }) {
        trackWrite(table, "updateMany");
        const hit = t[table].filter((r) => matches(r, where, table));
        hit.forEach((r) => Object.assign(r, clone(data)));
        return { count: hit.length };
      },
      async delete({ where }) {
        trackWrite(table, "delete");
        const keys = Object.keys(where || {});
        const i = t[table].findIndex((r) => keys.every((k) => r[k] === where[k]));
        if (i >= 0) t[table].splice(i, 1);
        return null;
      },
      async deleteMany({ where } = {}) {
        trackWrite(table, "deleteMany");
        const hit = t[table].filter((r) => matches(r, where, table));
        hit.forEach((r) => t[table].splice(t[table].indexOf(r), 1));
        return { count: hit.length };
      },
    };
  }

  const db = { __tables: t };
  for (const name of Object.keys(t)) db[name] = delegate(name);
  db.$transaction = async (ops) => Promise.all(ops);
  // Session table for the cookie-session auth layer (not academic state).
  const sessRows = [];
  t.userSession = sessRows;
  db.userSession = {
    async findUnique({ where } = {}) {
      const keys = Object.keys(where || {});
      return clone(sessRows.find((r) => keys.every((k) => r[k] === where[k])) || null);
    },
    async create({ data }) {
      const row = { id: `sess-${seq++}`, ...clone(data) };
      sessRows.push(row);
      return clone(row);
    },
    async update({ where, data }) {
      const keys = Object.keys(where || {});
      const row = sessRows.find((r) => keys.every((k) => r[k] === where[k]));
      if (row) Object.assign(row, clone(data));
      return clone(row || null);
    },
  };
  return db;
}

function trackWrite(table, op) {
  if (!global.__WRITES__) global.__WRITES__ = [];
  global.__WRITES__.push({ table, op });
}

// ---------------------------------------------------------------------------
// 3. Module shims
// ---------------------------------------------------------------------------
global.__MOCK_DB__ = makeMockDb();
global.__COOKIES__ = new Map();
global.__WRITES__ = [];
global.__HEADERS__ = {
  "user-agent": "codemind-test-agent/1.0",
  "x-forwarded-for": "203.0.113.10",
};

const shim = (name, body) => {
  const p = path.join(OUT, `__shim_${name.replace(/[^a-z0-9]/gi, "_")}.js`);
  fs.writeFileSync(p, body);
  return p;
};
const SHIMS = {
  "@/lib/db": shim("db", "module.exports = { db: global.__MOCK_DB__ };"),
  "next/headers": shim(
    "headers",
    `module.exports = {
       cookies: async () => ({
         get: (k) => global.__COOKIES__.has(k) ? { value: global.__COOKIES__.get(k) } : undefined,
         set: (k, v) => global.__COOKIES__.set(k, v),
         delete: (k) => global.__COOKIES__.delete(k),
       }),
       headers: async () => new Map(Object.entries(global.__HEADERS__ || {})),
     };`
  ),
  "next/server": shim(
    "server",
    `class NextResponse {
       constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.ok = this.status < 300; }
       static json(data, init) { return new NextResponse(data, init); }
       async json() { return this.body; }
     }
     module.exports = { NextResponse, NextRequest: class {} };`
  ),
};
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (SHIMS[request]) return SHIMS[request];
  if (request.startsWith("@/")) {
    const rel = request.slice(2);
    for (const cand of [`src/${rel}.js`, `src/${rel}/index.js`]) {
      const abs = path.join(OUT, cand);
      if (fs.existsSync(abs)) return abs;
    }
    return compileOnDemand(rel);
  }
  try {
    return origResolve.call(this, request, parent, ...rest);
  } catch (e) {
    if (!request.startsWith(".") && !path.isAbsolute(request)) {
      return require.resolve(request, { paths: [REPO] });
    }
    throw e;
  }
};
function compileOnDemand(rel) {
  const candidates = [`src/${rel}.tsx`, `src/${rel}.ts`, `src/${rel}/index.tsx`, `src/${rel}/index.ts`];
  const src = candidates.map((c) => path.join(REPO, c)).find((p) => fs.existsSync(p));
  if (!src) throw new Error(`Cannot resolve @/${rel}`);
  const outFile = path.join(OUT, path.relative(REPO, src).replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(outFile)) {
    const cfg = path.join(OUT, `tsconfig.${Buffer.from(rel).toString("hex").slice(0, 40)}.json`);
    fs.writeFileSync(cfg, JSON.stringify({
      compilerOptions: {
        target: "es2020", module: "commonjs", jsx: "react-jsx", skipLibCheck: true,
        esModuleInterop: true, baseUrl: REPO, rootDir: REPO, paths: { "@/*": ["src/*"] },
        outDir: OUT, noEmitOnError: false, noImplicitAny: false,
      },
      files: [src],
    }));
    try { execSync(`npx tsc -p ${cfg}`, { cwd: REPO, stdio: "pipe" }); } catch {}
  }
  return outFile;
}

// ---------------------------------------------------------------------------
// 4. Assertion harness + handlers under test
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const ok = (cond, label) => {
  if (cond) { pass++; }
  else { fail++; console.log(`  \u2717 ${label}`); }
};
const section = (t) => console.log(`\n${t}`);

const examRoute = require(compiled("src/app/api/exams/mock/route.ts"));
const adminRoute = require(compiled("src/app/api/admin/mock-exams/route.ts"));
const adminIdRoute = require(compiled("src/app/api/admin/mock-exams/[id]/route.ts"));
const eligibleRoute = require(compiled("src/app/api/admin/mock-exams/eligible/route.ts"));
const poolLib = require(compiled("src/lib/mock-exam-pool.ts"));

const getReq = (qs) => ({ url: `http://test.local/api/x?${qs || ""}` });
const postReq = (body) => ({ json: async () => body });
const params = (o) => ({ params: Promise.resolve(o) });
async function bodyOf(res) { return { status: res.status, body: await res.json() }; }

async function loginAs(userId) {
  const token = `test-token-${userId}-${Date.now()}-${Math.random()}`;
  await global.__MOCK_DB__.userSession.create({
    data: {
      userId,
      tokenHash: crypto.createHash("sha256").update(token).digest("hex"),
      deviceHash: "test-device",
      expiresAt: new Date(Date.now() + 86400000),
      lastSeenAt: new Date(),
    },
  });
  global.__COOKIES__.set("cm_session", token);
}
function logout() { global.__COOKIES__.clear(); }
function academicWrites() {
  return (global.__WRITES__ || []).filter((w) => w.table !== "userSession");
}
function clearWrites() { global.__WRITES__ = []; }

// ---------------------------------------------------------------------------
// 5. Fixture — a bank of MANUALLY created questions (no lesson, no AI data)
// ---------------------------------------------------------------------------
const NOW = Date.now();
const D = (daysAgo) => new Date(NOW - daysAgo * 86400000);
const OPTS = JSON.stringify(["alpha", "beta", "gamma", "delta"]);

// Every one of these is what the Admin "Add Question" dialog produces:
//   quizId: null, no lesson link, no AI/provenance field of any kind.
// Difficulties are spread so the difficulty filter can be exercised.
const MANUAL_ARABIC = [
  { id: "m01", difficulty: "EASY" },
  { id: "m02", difficulty: "EASY" },
  { id: "m03", difficulty: "MEDIUM" },
  { id: "m04", difficulty: "MEDIUM" },
  { id: "m05", difficulty: "MEDIUM" },
  { id: "m06", difficulty: "MEDIUM" },
  { id: "m07", difficulty: "MEDIUM" },
  { id: "m08", difficulty: "MEDIUM" },
  { id: "m09", difficulty: "MEDIUM" },
  { id: "m10", difficulty: "MEDIUM" },
  { id: "m11", difficulty: "HARD" },
  { id: "m12", difficulty: "HARD" },
];

async function seed() {
  const T = global.__MOCK_DB__.__tables;

  T.user.push(
    { id: "u-ad", email: "ad@test.local", name: "Admin", role: "ADMIN", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-t1", email: "t1@test.local", name: "Teacher", role: "TEACHER", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-pa", email: "pa@test.local", name: "Parent", role: "PARENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sa", email: "sa@test.local", name: "Student A", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sb", email: "sb@test.local", name: "Student B", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sc", email: "sc@test.local", name: "Student C", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sd", email: "sd@test.local", name: "Student D", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
  );
  T.course.push(
    { id: "c1", slug: "course-1", name: "Course One", nameAr: "\u0643\u0648\u0631\u0633 \u0661" },
    { id: "c2", slug: "course-2", name: "Course Two", nameAr: "\u0643\u0648\u0631\u0633 \u0662" },
  );
  T.group.push(
    { id: "g1", name: "Group 1", courseId: "c1", isActive: true },
    { id: "g2", name: "Group 2", courseId: "c2", isActive: true },
  );
  // C1: canonical (unit) lesson + legacy (topic) lesson + a DRAFT lesson whose
  // questions must never be served.
  T.part.push({ id: "p1", courseId: "c1", title: "P1", titleAr: "\u062c\u0661", order: 1 });
  T.unit.push({ id: "u1", partId: "p1", title: "U1", titleAr: "\u0648\u0661", order: 1 });
  T.topic.push({ id: "t1", unitId: "u1", title: "T1", titleAr: "\u0645\u0661", order: 1 });
  T.lesson.push(
    { id: "lc1", topicId: null, unitId: "u1", title: "Canonical", titleAr: "\u0643\u0627\u0646\u0648\u0646\u064a", order: 1, status: "PUBLISHED" },
    { id: "ll1", topicId: "t1", unitId: null, title: "Legacy", titleAr: "\u0642\u062f\u064a\u0645", order: 2, status: "PUBLISHED" },
    { id: "ld1", topicId: null, unitId: "u1", title: "Draft", titleAr: "\u0645\u0633\u0648\u062f\u0629", order: 3, status: "DRAFT" },
  );
  T.quiz.push(
    { id: "qz1", lessonId: "lc1", title: "Q1", titleAr: "\u0633\u0661", passMark: 60 },
    { id: "qz2", lessonId: "ll1", title: "Q2", titleAr: "\u0633\u0662", passMark: 60 },
    { id: "qz3", lessonId: "ld1", title: "Q3", titleAr: "\u0633\u0663", passMark: 60 },
  );

  // 12 manual bank-only ARABIC questions (the fixture the task asks for).
  for (const m of MANUAL_ARABIC) {
    T.question.push({
      id: m.id, quizId: null, type: "MCQ", prompt: m.id, promptAr: m.id,
      options: OPTS, answer: "1", explanation: `exp-${m.id}`,
      difficulty: m.difficulty, marks: 2, schoolType: "ARABIC", createdAt: D(9),
    });
  }
  T.question.push(
    // Shared manual question (both banks may serve it).
    { id: "mShare", quizId: null, type: "MCQ", prompt: "mShare", promptAr: "mShare", options: OPTS, answer: "0", explanation: "exp-share", difficulty: "MEDIUM", marks: 1, schoolType: null, createdAt: D(9) },
    // Lesson-linked ARABIC question (canonical lesson).
    { id: "qLinked", quizId: "qz1", type: "MCQ", prompt: "qLinked", promptAr: "\u0645\u0631\u062a\u0628\u0637", options: OPTS, answer: "2", explanation: "exp-linked", difficulty: "MEDIUM", marks: 3, schoolType: "ARABIC", createdAt: D(8) },
    // Lesson-linked ARABIC question (legacy chain).
    { id: "qLegacy", quizId: "qz2", type: "MCQ", prompt: "qLegacy", promptAr: "\u0642\u062f\u064a\u0645", options: OPTS, answer: "3", explanation: "exp-legacy", difficulty: "MEDIUM", marks: 4, schoolType: "ARABIC", createdAt: D(8) },
    // LANGUAGE-only question: must never reach an ARABIC attempt.
    { id: "qLang", quizId: "qz1", type: "MCQ", prompt: "qLang", promptAr: null, options: OPTS, answer: "0", explanation: "exp-lang", difficulty: "EASY", marks: 5, schoolType: "LANGUAGE", createdAt: D(8) },
    // Question on a DRAFT lesson: lifecycle must keep it out of the pool.
    { id: "qDraft", quizId: "qz3", type: "MCQ", prompt: "qDraft", promptAr: null, options: OPTS, answer: "0", explanation: "exp-draft", difficulty: "EASY", marks: 6, schoolType: "ARABIC", createdAt: D(7) },
  );
  T.examQuestion.push(
    { id: "eqLinked", lessonId: "lc1", examType: "MOCK", prompt: "eqLinked", promptAr: null, options: OPTS, answer: "1", explanation: "exp-eq", difficulty: "MEDIUM", marks: 2, schoolType: "ARABIC" },
    // Legacy row with no lesson: bank-only, eligible exactly like a manual row
    // — i.e. only for the exams that attached it.
    { id: "eqManual", lessonId: null, examType: "MOCK", prompt: "eqManual", promptAr: null, options: OPTS, answer: "2", explanation: "exp-eqm", difficulty: "MEDIUM", marks: 2, schoolType: "ARABIC" },
    { id: "eqLang", lessonId: "lc1", examType: "MOCK", prompt: "eqLang", promptAr: null, options: OPTS, answer: "0", explanation: "exp-eql", difficulty: "EASY", marks: 2, schoolType: "LANGUAGE" },
  );

  // Course Two's manual bank (same school type as Course One — the exact
  // cross-course trap the contract must close) + a manual row that no exam
  // attached at all.
  for (const id of ["n01", "n02", "n03", "n04"]) {
    T.question.push({
      id, quizId: null, type: "MCQ", prompt: id, promptAr: id, options: OPTS,
      answer: "1", explanation: `exp-${id}`, difficulty: "MEDIUM", marks: 2,
      schoolType: "ARABIC", createdAt: D(9),
    });
  }
  T.question.push({
    id: "mUnattached", quizId: null, type: "MCQ", prompt: "mUnattached", promptAr: "mUnattached",
    options: OPTS, answer: "1", explanation: "exp-unattached", difficulty: "MEDIUM",
    marks: 2, schoolType: "ARABIC", createdAt: D(9),
  });

  T.student.push(
    { id: "sa", userId: "u-sa", schoolType: "ARABIC", groupId: "g1", batchId: null },
    { id: "sb", userId: "u-sb", schoolType: "LANGUAGE", groupId: "g2", batchId: null },
    { id: "sc", userId: "u-sc", schoolType: "ARABIC", groupId: null, batchId: null },
    // Second ARABIC student, enrolled in the OTHER course.
    { id: "sd", userId: "u-sd", schoolType: "ARABIC", groupId: "g2", batchId: null },
  );

  // Exams. `mx-empty-lang` is inserted directly: it stands for a bank that was
  // emptied AFTER publication, which the create guard cannot prevent.
  T.mockExam.push(
    { id: "mx-random", title: "Random", titleAr: "\u0639\u0634\u0648\u0627\u0626\u064a", description: null, schoolType: "ARABIC", courseId: null, questionCount: 5, durationMin: 20, passMark: 70, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: true, createdAt: D(5) },
    { id: "mx-hard", title: "Hard", titleAr: "\u0635\u0639\u0628", description: null, schoolType: "ARABIC", courseId: null, questionCount: 5, durationMin: 20, passMark: 50, difficulty: "HARD", selectionMode: "RANDOM", isPublished: true, createdAt: D(4) },
    { id: "mx-empty-lang", title: "Empty", titleAr: "\u0641\u0627\u0636\u064a", description: null, schoolType: "LANGUAGE", courseId: null, questionCount: 3, durationMin: 15, passMark: 60, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: true, createdAt: D(3) },
    // Course-bound ARABIC exams: each samples its OWN course's lessons + its
    // OWN attachments, nothing else (the cross-course regression fixtures).
    { id: "mx-c1", title: "Course One", titleAr: "\u0643\u0648\u0631\u0633 \u0661", description: null, schoolType: "ARABIC", courseId: "c1", questionCount: 4, durationMin: 20, passMark: 60, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: true, createdAt: D(4) },
    { id: "mx-c2", title: "Course Two", titleAr: "\u0643\u0648\u0631\u0633 \u0662", description: null, schoolType: "ARABIC", courseId: "c2", questionCount: 3, durationMin: 20, passMark: 60, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: true, createdAt: D(4) },
    // The freeze fixture: a fresh exam so the attempt index starts at 0.
    { id: "mx-freeze", title: "Freeze", titleAr: "\u062a\u062c\u0645\u064a\u062f", description: null, schoolType: "ARABIC", courseId: "c1", questionCount: 3, durationMin: 20, passMark: 60, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: true, createdAt: D(2) },
  );

  // Attachments: the ONLY way a lesson-less manual row becomes eligible, and
  // each exam owns exactly the rows the Admin attached to it.
  const attach = (mockExamId, ids) =>
    ids.forEach((questionId, order) =>
      T.mockExamQuestion.push({
        id: `link-${mockExamId}-${questionId}`,
        mockExamId,
        questionId,
        examQuestionId: null,
        order,
      })
    );
  attach("mx-random", [...MANUAL_ARABIC.map((m) => m.id), "mShare"]);
  attach("mx-hard", ["m11", "m12"]);
  attach("mx-empty-lang", ["mShare"]);
  attach("mx-c1", ["m01", "m02", "m03", "m04", "m05", "m06"]);
  attach("mx-c2", ["n01", "n02", "n03", "n04"]);
  attach("mx-freeze", ["m07", "m08", "m09", "m10", "m11", "m12"]);
  // A legacy bank-only ExamQuestion row attaches the same way.
  T.mockExamQuestion.push({
    id: "link-eqManual",
    mockExamId: "mx-random",
    questionId: null,
    examQuestionId: "eqManual",
    order: 20,
  });
}

// The eligible pool as the contract defines it (independent re-implementation,
// so the assertion fails if the route's pool drifts from the contract).
function expectedPool(T, schoolType, courseId, mockExamId) {
  const visibleLessons = T.lesson
    .filter((l) => l.status === "PUBLISHED")
    .filter((l) => {
      const course = l.unitId
        ? (T.unit.find((u) => u.id === l.unitId) || {}).partId
          ? (T.part.find((p) => p.id === T.unit.find((u) => u.id === l.unitId).partId) || {}).courseId
          : null
        : l.topicId
          ? (T.topic.find((t) => t.id === l.topicId) || {}).unitId
            ? (T.unit.find((u) => u.id === T.topic.find((t) => t.id === l.topicId).unitId) || {}).partId
              ? (T.part.find((p) => p.id === T.unit.find((u) => u.id === T.topic.find((t) => t.id === l.topicId).unitId).partId) || {}).courseId
              : null
            : null
          : null;
      return courseId ? course === courseId : course !== null && course !== undefined;
    })
    .map((l) => l.id);
  const inBank = (st) => st === schoolType || st === null;
  const links = T.mockExamQuestion.filter((l) => mockExamId && l.mockExamId === mockExamId);
  const attachedQ = new Set(links.filter((l) => l.questionId).map((l) => l.questionId));
  const attachedEq = new Set(links.filter((l) => l.examQuestionId).map((l) => l.examQuestionId));
  const ids = [];
  for (const q of T.question) {
    if (!inBank(q.schoolType)) continue;
    const lessonId = q.quizId ? (T.quiz.find((z) => z.id === q.quizId) || {}).lessonId ?? null : null;
    if (!q.quizId || !lessonId) {
      // A manual (lesson-less) row is eligible for exactly the exams that
      // attached it — and for NONE when nothing did.
      if (attachedQ.has(q.id)) ids.push(q.id);
    } else if (visibleLessons.includes(lessonId)) ids.push(q.id);
  }
  for (const q of T.examQuestion) {
    if (!inBank(q.schoolType)) continue;
    if (!q.lessonId) {
      if (attachedEq.has(q.id)) ids.push(q.id);
    } else if (visibleLessons.includes(q.lessonId)) ids.push(q.id);
  }
  return ids.sort();
}

// The same deterministic sampler the route uses: the expected frozen set.
const seededSample = (ids, count, seed) =>
  poolLib
    .selectMockExamQuestions(ids.map((id) => ({ id })), count, seed)
    .map((q) => q.id);

// ---------------------------------------------------------------------------
// 6. The tests
// ---------------------------------------------------------------------------
async function main() {
  await seed();
  const T = global.__MOCK_DB__.__tables;
  // The exam-less pool (lesson-linked rows only — a manual row has no exam to
  // attach it to), plus the pool of each exam under test.
  const basePool = expectedPool(T, "ARABIC", null, null);
  const randomPool = expectedPool(T, "ARABIC", null, "mx-random");
  const c1Pool = expectedPool(T, "ARABIC", "c1", "mx-c1");
  const c2Pool = expectedPool(T, "ARABIC", "c2", "mx-c2");

  section("A. Manual bank-only questions enter the RANDOM pool ONLY by attachment");
  {
    ok(
      MANUAL_ARABIC.every((m) => !T.question.find((q) => q.id === m.id).quizId),
      "fixture really is manual: every mXX has quizId = null (no lesson, no AI metadata)"
    );
    ok(
      randomPool.includes("m01") && randomPool.includes("m12"),
      "manual questions ATTACHED to the exam are in its RANDOM pool"
    );
    ok(
      !randomPool.includes("mUnattached"),
      "an unattached manual row of the same bank is NOT in any pool (no global fallback)"
    );
    ok(
      !randomPool.includes("n01") && !c1Pool.includes("n01"),
      "another course's manual row is NOT in this exam's pool"
    );
    ok(!randomPool.includes("qDraft"), "a DRAFT lesson's question stays ineligible");
    ok(!randomPool.includes("qLang") && !randomPool.includes("eqLang"), "other-bank questions stay ineligible");
    ok(randomPool.includes("mShare"), "a shared (schoolType null) attached manual row is eligible");
    ok(randomPool.includes("eqManual"), "an attached legacy bank-only ExamQuestion row is eligible too");
    ok(
      randomPool.length === 3 + 13 + 1,
      `pool = lesson-linked rows + THIS exam's attachments (got ${randomPool.length})`
    );
    ok(
      basePool.length === 3 && !basePool.includes("m01"),
      `without an exam there are no attachments, so only lesson-linked rows are eligible (got ${basePool.length})`
    );
  }

  section("B. ALL STUDENTS: ADMIN-only surfaces");
  logout();
  {
    for (const role of ["u-t1", "u-pa", "u-sa"]) {
      await loginAs(role);
      const r = await bodyOf(await eligibleRoute.GET(getReq("schoolType=ARABIC")));
      ok(r.status === 403, `${role} cannot read the eligible-pool endpoint (403, got ${r.status})`);
      const c = await bodyOf(await adminRoute.POST(postReq({ title: "x", schoolType: "ARABIC" })));
      ok(c.status === 403, `${role} cannot create an exam (403, got ${c.status})`);
    }
    await loginAs("u-ad");
    const missing = await bodyOf(await eligibleRoute.GET(getReq("")));
    ok(missing.status === 400, "eligible endpoint without schoolType -> 400");
    const r = await bodyOf(await eligibleRoute.GET(getReq("schoolType=ARABIC")));
    ok(
      r.status === 200 && r.body.pool.total === basePool.length,
      `admin reads the exam-less pool size (${basePool.length}, got ${r.body.pool.total})`
    );
    ok(r.body.pool.bankOnly === 0, "no exam -> no attached free-bank rows are counted");
    const scoped = await bodyOf(await eligibleRoute.GET(getReq("schoolType=ARABIC&mockExamId=mx-random")));
    ok(
      scoped.status === 200 && scoped.body.pool.attached === 13,
      `the exam-scoped pool reports its 13 attachments (got ${scoped.body.pool.attached})`
    );
    ok(
      scoped.body.pool.bankOnly === 13 && scoped.body.pool.total === randomPool.length,
      "the exam-scoped total includes the attached rows (and only its own)"
    );
    const mismatched = await bodyOf(await eligibleRoute.GET(getReq("schoolType=LANGUAGE&mockExamId=mx-random")));
    ok(mismatched.status === 404, "an exam id from another bank -> 404 (no crafted cross-scope counts)");
  }

  section("C. Creation guards (attachment is the only manual route in)");
  {
    const tooBig = await bodyOf(
      await adminRoute.POST(postReq({ title: "Too big", schoolType: "ARABIC", questionCount: basePool.length + 1, selectionMode: "RANDOM" }))
    );
    ok(tooBig.status === 400, "RANDOM beyond exam-less pool -> 400 (clear Arabic api.213)");
    // Attaching manual ids EXTENDS the exam's pool: the guard measures the
    // pool AFTER the links land — exactly what a student will be served from.
    const attachIds = ["m01", "m02", "m03", "m04"];
    const okOne = await bodyOf(
      await adminRoute.POST(postReq({ title: "Fits", schoolType: "ARABIC", questionCount: basePool.length + attachIds.length, selectionMode: "RANDOM", questionIds: attachIds }))
    );
    ok(okOne.status === 200, "RANDOM with 4 manual attachments -> 200 (pool + attachments covers the count)");
    const okLinks = T.mockExamQuestion.filter((l) => l.mockExamId === okOne.body.exam.id);
    ok(okLinks.length === attachIds.length, "the RANDOM attachments are stored per exam (pool membership)");
    const attachForeign = await bodyOf(
      await adminRoute.POST(postReq({ title: "Foreign attach", schoolType: "ARABIC", questionCount: 1, selectionMode: "RANDOM", questionIds: ["m01", "qLang"] }))
    );
    ok(attachForeign.status === 400, "attaching an id outside the bank -> 400 (api.309)");

    // Manual ids only: the exact FIXED contract.
    const chosen = ["m01", "m03", "m05", "m07"];
    const fx = await bodyOf(
      await adminRoute.POST(postReq({ title: "Fixed manual", schoolType: "ARABIC", selectionMode: "FIXED", questionIds: chosen }))
    );
    ok(fx.status === 200, "create FIXED with explicit manual question ids -> 200");
    ok(fx.body.exam.questionCount === chosen.length, "FIXED count is derived from the selection");
    const pins = T.mockExamQuestion.filter((l) => l.mockExamId === fx.body.exam.id).map((l) => l.questionId);
    ok(JSON.stringify(pins) === JSON.stringify(chosen), `pins are exactly the chosen ids in order (${pins.join(",")})`);

    // FIXED WITHOUT an explicit selection fills from the QUESTION bank, which
    // now means the lesson-linked rows: unattached manual rows cannot be
    // silently filled in any more.
    const autoShort = await bodyOf(
      await adminRoute.POST(postReq({ title: "Auto short", schoolType: "ARABIC", questionCount: 4, selectionMode: "FIXED" }))
    );
    ok(autoShort.status === 400, "FIXED auto-fill cannot reach unattached manual rows -> 400");
    const autoOk = await bodyOf(
      await adminRoute.POST(postReq({ title: "Auto ok", schoolType: "ARABIC", questionCount: 2, selectionMode: "FIXED" }))
    );
    ok(autoOk.status === 200, "FIXED auto-fill from the lesson-linked pool -> 200");
    const autoPins = T.mockExamQuestion.filter((l) => l.mockExamId === autoOk.body.exam.id).map((l) => l.questionId);
    ok(autoPins.every((id) => basePool.includes(id)), "auto-pins come only from the lesson-linked pool");

    const dupe = await bodyOf(
      await adminRoute.POST(postReq({ title: "Dupe", schoolType: "ARABIC", selectionMode: "FIXED", questionIds: ["m01", "m01"] }))
    );
    ok(dupe.status === 400, "duplicate ids -> 400 (api.307)");
    const mismatch = await bodyOf(
      await adminRoute.POST(postReq({ title: "Mismatch", schoolType: "ARABIC", selectionMode: "FIXED", questionCount: 3, questionIds: ["m01", "m02"] }))
    );
    ok(mismatch.status === 400, "questionCount contradictory to the selection -> 400 (api.308)");
    const foreign = await bodyOf(
      await adminRoute.POST(postReq({ title: "Foreign", schoolType: "ARABIC", selectionMode: "FIXED", questionIds: ["m01", "qLang"] }))
    );
    ok(foreign.status === 400, "an id outside the bank -> 400 (api.309)");
    // A question of a DRAFT lesson must not be pinnable into a FIXED exam.
    const draft = await bodyOf(
      await adminRoute.POST(postReq({ title: "Draft pin", schoolType: "ARABIC", selectionMode: "FIXED", questionIds: ["m01", "qDraft"] }))
    );
    ok(draft.status === 400, "pinning a draft lesson's question -> 400 (api.309)");
    // A difficulty slice that cannot cover the count is refused up front.
    const hard = await bodyOf(
      await adminRoute.POST(postReq({ title: "Hard 5", schoolType: "ARABIC", questionCount: 5, difficulty: "HARD", selectionMode: "RANDOM" }))
    );
    ok(hard.status === 400, "RANDOM 5 questions at HARD when only 2 HARD exist -> 400");
    const hardOk = await bodyOf(
      await adminRoute.POST(postReq({ title: "Hard 2", schoolType: "ARABIC", questionCount: 2, difficulty: "HARD", selectionMode: "RANDOM" }))
    );
    ok(hardOk.status === 200, "RANDOM 2 questions at HARD -> 200");
    const lang = await bodyOf(
      await adminRoute.POST(postReq({ title: "Lang", schoolType: "ARABIC", selectionMode: "FIXED", questionIds: ["m01", "qLang"] }))
    );
    ok(lang.status === 400, "pinning a LANGUAGE question into an ARABIC exam -> 400 (api.309)");
  }

  section("D. FIXED: the pinned manual questions are served unchanged");
  await loginAs("u-sa");
  {
    const r1 = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-fixed-manual")));
    ok(r1.status === 404, "unknown exam id -> 404");
    const fxId = T.mockExam.find((e) => e.title === "Fixed manual").id;
    // Publishing is the Admin's second gate: it must re-check the pool too.
    logout();
    await loginAs("u-ad");
    const pub = await bodyOf(await adminIdRoute.PATCH(postReq({ isPublished: true }), params({ id: fxId })));
    ok(pub.status === 200, `publish the FIXED exam -> 200 (got ${pub.status})`);
    logout();
    await loginAs("u-sa");
    const seqs = [];
    for (let i = 0; i < 3; i++) {
      const r = await bodyOf(await examRoute.GET(getReq(`mockExamId=${fxId}`)));
      if (r.status !== 200) console.log("DEBUG", r.status, JSON.stringify(r.body).slice(0, 500));
      ok(r.status === 200, `FIXED fetch #${i + 1} -> 200`);
      seqs.push(r.body.exam.questions.map((q) => q.id));
    }
    const want = ["m01", "m03", "m05", "m07"];
    ok(seqs.every((s) => JSON.stringify(s) === JSON.stringify(want)), `FIXED served the exact pinned manual ids every time (${seqs[0].join(",")})`);
    const raw = JSON.stringify(seqs);
    ok(!raw.includes("qLang"), "FIXED never leaked a LANGUAGE question");
    ok(T.question.filter((q) => want.includes(q.id)).every((q) => q.quizId === null), "the whole FIXED set came from the manual (lesson-less) bank");
  }

  section("C2. Publish guard");
  {
    logout();
    await loginAs("u-ad");
    // A FIXED exam whose count exceeds its pins must not publish (api.312).
    const made = await bodyOf(
      await adminRoute.POST(postReq({ title: "Pin short", schoolType: "ARABIC", selectionMode: "FIXED", questionIds: ["m01", "m02"] }))
    );
    ok(made.status === 200, "FIXED exam with 2 pins created");
    const id = made.body.exam.id;
    ok((await bodyOf(await adminIdRoute.PATCH(postReq({ questionCount: 9 }), params({ id })))).status === 200, "raising the count on a draft FIXED exam is allowed");
    const pub = await bodyOf(await adminIdRoute.PATCH(postReq({ isPublished: true }), params({ id })));
    ok(pub.status === 400, "publishing a FIXED exam beyond its pins -> 400 (api.312)");
    ok((await bodyOf(await adminIdRoute.PATCH(postReq({ questionCount: 2, isPublished: true }), params({ id })))).status === 200, "publishing once the count matches the pins -> 200");
  }

  section("E. RANDOM: count, eligibility, no duplicates, frozen per attempt");
  {
    logout();
    await loginAs("u-sa");
    const r = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-random")));
    ok(r.status === 200 && r.body.exam.questions.length === 5, "RANDOM served exactly the configured 5 questions");
    const ids = r.body.exam.questions.map((q) => q.id);
    ok(new Set(ids).size === ids.length, "no duplicate question in one attempt");
    ok(ids.every((id) => randomPool.includes(id)), "every served id is in the exam's attached pool");
    ok(!ids.includes("mUnattached") && !ids.includes("n01"), "no unattached and no other-course row is ever served");
    ok(r.body.exam.eligiblePool === randomPool.length, `response reports the eligible pool (${r.body.exam.eligiblePool})`);
    ok(r.body.exam.selectionMode === "RANDOM" && r.body.exam.shortfall === null, "no shortfall for a satisfiable RANDOM exam");

    // The served set must be reproducible from the seeded sampler — and, more
    // importantly, it must be STORED: the attempt row is what makes the paper
    // final (a later pool change cannot re-sample it).
    const seed0 = poolLib.mockExamSampleSeed({
      studentId: "sa", courseId: "c1", examId: "mx-random", attemptIndex: 0, count: 5, difficulty: "mixed",
    });
    ok(JSON.stringify(ids) === JSON.stringify(seededSample(randomPool, 5, seed0)), "served set == the attempt's deterministic sample");

    const attemptId = r.body.exam.attemptId;
    ok(typeof attemptId === "string" && attemptId.length > 0, "starting the exam opened a persisted attempt");
    ok(r.body.exam.resumed === false, "the first serve is a fresh draw");
    const openRow = T.examAttempt.find((a) => a.id === attemptId);
    ok(!!openRow && !openRow.finishedAt, "the attempt row is OPEN (finishedAt NULL) — an open paper is not an attempt");
    const storedPaper = poolLib.readFrozenPaper(openRow && openRow.answers);
    ok(
      !!storedPaper && JSON.stringify(storedPaper.ids) === JSON.stringify(ids),
      "the ordered ids are STORED on the row at start (freeze, not just determinism)"
    );

    const again = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-random")));
    ok(JSON.stringify(again.body.exam.questions.map((q) => q.id)) === JSON.stringify(ids), "refresh (same attempt) returns the SAME set and order");
    ok(
      again.body.exam.resumed === true && again.body.exam.attemptId === attemptId,
      "refresh RESUMES the same persisted attempt row (no new row, no re-draw)"
    );
    ok(
      JSON.stringify(again.body.exam.questions.map((q) => q.options)) ===
        JSON.stringify(r.body.exam.questions.map((q) => q.options)),
      "refresh replays the same option order too (presentation is frozen with the paper)"
    );

    const manualOnly = await bodyOf(await examRoute.GET(getReq(`mockExamId=${T.mockExam.find((e) => e.id === "mx-hard").id}`)));
    const hardIds = manualOnly.body.exam.questions.map((q) => q.id);
    ok(manualOnly.body.exam.questions.length === 2, `difficulty=HARD serves the 2 HARD manual questions (got ${manualOnly.body.exam.questions.length})`);
    ok(hardIds.every((id) => ["m11", "m12"].includes(id)), "difficulty filter selected the HARD manual rows");
    ok(manualOnly.body.exam.shortfall && manualOnly.body.exam.shortfall.requested === 5, "a pool below the configured count reports a shortfall");
  }

  section("F. Retry: a finished attempt yields a NEW paper");
  {
    const before = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-random")));
    const first = before.body.exam.questions.map((q) => q.id);
    // A real client submits the ids it was served; the submit then FINALIZES
    // the open paper's row instead of creating a second, unrelated attempt.
    const submitted = first.slice(0, 2);
    const sub = await bodyOf(
      await examRoute.POST(postReq({ examType: "MOCK", mockExamId: "mx-random", answers: submitted.map((id) => ({ questionId: id, selected: "beta" })) }))
    );
    ok(sub.status === 200 && sub.body.attempt.mockExamId === "mx-random", "submit links the attempt to the manual-bank exam");
    ok(
      sub.body.attempt.id === before.body.exam.attemptId && !!sub.body.attempt.finishedAt,
      "the submit FINALIZED the open paper's row (same attempt identity, now finished)"
    );
    ok(
      sub.body.review.length === submitted.length && sub.body.attempt.totalMarks > 0,
      `the finished row carries the graded snapshot (${sub.body.review.length} rows)`
    );
    ok(
      T.examAttempt.filter((a) => a.mockExamId === "mx-random" && !a.finishedAt).length === 0,
      "no open paper survives its submit"
    );
    const after = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-random")));
    const second = after.body.exam.questions.map((q) => q.id);
    const seed1 = poolLib.mockExamSampleSeed({
      studentId: "sa", courseId: "c1", examId: "mx-random", attemptIndex: 1, count: 5, difficulty: "mixed",
    });
    ok(
      JSON.stringify(second) === JSON.stringify(seededSample(randomPool, 5, seed1)),
      "attempt #1 draws its own deterministic paper over the CURRENT pool"
    );
    ok(JSON.stringify(second) !== JSON.stringify(first), "the retry paper differs from the first attempt");
    const third = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-random")));
    ok(JSON.stringify(third.body.exam.questions.map((q) => q.id)) === JSON.stringify(second), "the new attempt is frozen too");
  }

  section("G. Security: no key before submit, no client-chosen ids, no cross-role writes");
  {
    const r = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-random")));
    const payload = JSON.stringify(r.body);
    ok(!payload.includes("correctIndex") && !/explanation\s*[:,}]/.test(payload), "GET ships no answer key / explanation");
    ok(r.body.exam.questions.every((q) => Array.isArray(q.options) && q.options.length === 4), "options are served shuffled, without the key");

    // Duplicated answers collapse into ONE graded row (an attempt is a set).
    const dupe = await bodyOf(
      await examRoute.POST(postReq({ answers: [{ questionId: "m02", selected: "beta" }, { questionId: "m02", selected: "alpha" }] }))
    );
    ok(dupe.status === 200 && dupe.body.attempt.questionCount === 1, "duplicate answers in one submit collapse to one row");

    // Foreign-bank / unknown ids are graded 0 and never linked.
    const forged = await bodyOf(
      await examRoute.POST(postReq({ mockExamId: "mx-empty-lang", answers: [{ questionId: "qLang", selected: "alpha", isCorrect: true, marks: 99 }] }))
    );
    ok(forged.body.attempt.mockExamId === null, "foreign-bank exam id is not linked");
    ok(forged.body.attempt.score === 0 && forged.body.attempt.totalMarks === 0, "foreign-bank id grades 0/0");
    ok(forged.body.review.every((x) => x.correctText === null), "no key material for out-of-bank ids");

    // A FIXED exam must not be mutable by a non-admin either.
    const fxId = T.mockExam.find((e) => e.title === "Fixed manual").id;
    logout();
    await loginAs("u-t1");
    const tPatch = await bodyOf(await adminIdRoute.PATCH(postReq({ isPublished: false }), params({ id: fxId })));
    ok(tPatch.status === 403, `teacher cannot unpublish an exam (${tPatch.status})`);
    logout();
    await loginAs("u-sa");
    const sPatch = await bodyOf(await adminIdRoute.PATCH(postReq({ questionCount: 1 }), params({ id: fxId })));
    ok(sPatch.status === 403, `student cannot mutate an exam (${sPatch.status})`);

    await loginAs("u-sc");
    const un = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-random")));
    ok(un.status === 400, "unenrolled student -> 400");
    await loginAs("u-sb");
    const foreignExam = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-random")));
    ok(foreignExam.status === 403, "foreign-bank exam -> 403");
  }

  section("H. LANGUAGE student: own bank, own course, own attachments");
  {
    const sbPool = expectedPool(T, "LANGUAGE", "c2", "mx-empty-lang");
    ok(!sbPool.includes("m01"), "LANGUAGE pool excludes ARABIC-only manual questions");
    ok(!sbPool.includes("qLang") && !sbPool.includes("eqLang"), "questions of a lesson outside the student's course are excluded");
    ok(
      JSON.stringify(sbPool) === JSON.stringify(["mShare"]),
      `the LANGUAGE/c2 exam pool is only its attached shared question (${sbPool.join(",")})`
    );
    // Free practice has NO exam to attach a manual row to: it serves the
    // lesson-linked universe of the student's course only.
    const practice = await bodyOf(await examRoute.GET(getReq("count=10")));
    ok(
      practice.status === 200 && practice.body.exam === null,
      "LANGUAGE practice (no c2 lesson, no exam) -> no questions and no broken paper"
    );
    ok(
      practice.body.eligiblePool === 0 && typeof practice.body.message === "string",
      "and the empty practice pool is reported clearly"
    );
    const small = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-empty-lang")));
    ok(
      small.status === 200 && small.body.exam.questions.length === 1 && small.body.exam.shortfall,
      "an undersized exam pool still serves its questions WITH a reported shortfall"
    );
  }

  section("J. Cross-course isolation: Course A never receives Course B's questions");
  {
    logout();
    await loginAs("u-sa");
    const a = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-c1")));
    ok(a.status === 200, "the c1 student opens the c1 exam");
    const aIds = a.body.exam.questions.map((q) => q.id);
    ok(aIds.length === 4, `the c1 exam serves its configured 4 questions (got ${aIds.length})`);
    ok(aIds.every((id) => c1Pool.includes(id)), "every served id is in the c1 pool");
    ok(aIds.every((id) => !c2Pool.includes(id)), "NO Course Two question is ever served to Course A");
    ok(!aIds.includes("mUnattached"), "an unattached manual row of the same bank is never served");
    ok(a.body.exam.eligiblePool === c1Pool.length, `the c1 exam reports its own pool (${a.body.exam.eligiblePool})`);

    logout();
    await loginAs("u-sd");
    const b = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-c2")));
    ok(b.status === 200, "the c2 student opens the c2 exam");
    const bIds = b.body.exam.questions.map((q) => q.id);
    ok(bIds.length === 3, `the c2 exam serves its configured 3 questions (got ${bIds.length})`);
    ok(bIds.every((id) => c2Pool.includes(id)), "every served id is in the c2 pool");
    ok(bIds.every((id) => !c1Pool.includes(id)), "NO Course One question is ever served to Course B (and vice versa)");
    ok(b.body.exam.eligiblePool === c2Pool.length, `the c2 exam reports its own pool (${b.body.exam.eligiblePool})`);

    const cross = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-c1")));
    ok(cross.status === 404, "a c2 student cannot even open c1's exam (404, not a leak)");

    logout();
    await loginAs("u-ad");
    const scoped = await bodyOf(await eligibleRoute.GET(getReq("schoolType=ARABIC&courseId=c1&mockExamId=mx-c1")));
    ok(scoped.status === 200 && scoped.body.pool.attached === 6, "the c1 exam reports exactly its 6 attachments");
    ok(scoped.body.pool.total === c1Pool.length, "the c1 pool total excludes every c2 row");
    logout();
    await loginAs("u-sa");
  }

  section("K. Freeze: a bank change mid-attempt cannot alter an active paper");
  {
    logout();
    await loginAs("u-sa");
    const first = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-freeze")));
    ok(first.status === 200 && first.body.exam.questions.length === 3, "the freeze exam serves its 3 questions");
    const frozenIds = first.body.exam.questions.map((q) => q.id);
    const attemptId = first.body.exam.attemptId;
    const paper = poolLib.readFrozenPaper(T.examAttempt.find((a) => a.id === attemptId).answers);
    ok(!!paper && paper.ids.join("|") === frozenIds.join("|"), "the paper's ordered ids are stored at start");

    // Mutate the bank in every way that used to change a paper:
    //  (1) an eligible question is ADDED to this exam's pool...
    T.question.push({
      id: "mFrozenNew", quizId: null, type: "MCQ", prompt: "mFrozenNew", promptAr: "mFrozenNew",
      options: OPTS, answer: "1", explanation: "exp-frozen-new", difficulty: "MEDIUM",
      marks: 2, schoolType: "ARABIC", createdAt: D(0),
    });
    T.mockExamQuestion.push({
      id: "link-mx-freeze-mFrozenNew", mockExamId: "mx-freeze",
      questionId: "mFrozenNew", examQuestionId: null, order: 99,
    });
    //  (2) a question of the paper is DETACHED from the exam...
    const attachedInPaper = frozenIds.filter((id) =>
      T.mockExamQuestion.some((l) => l.mockExamId === "mx-freeze" && l.questionId === id)
    );
    ok(attachedInPaper.length >= 2, "fixture: the paper contains attached manual rows");
    const detached = attachedInPaper[0];
    const moved = frozenIds.find((id) => id !== detached && id !== attachedInPaper[1]) ?? frozenIds[1];
    const third = frozenIds.find((id) => id !== detached && id !== moved) ?? frozenIds[2];
    const link = T.mockExamQuestion.find((l) => l.mockExamId === "mx-freeze" && l.questionId === detached);
    ok(!!link, "fixture: the detached question was attached");
    if (link) T.mockExamQuestion.splice(T.mockExamQuestion.indexOf(link), 1);
    //  (3) another is moved out of the bank entirely...
    T.question.find((q) => q.id === moved).schoolType = "LANGUAGE";
    //  (4) and the third changes difficulty (the exam's slice changes).
    T.question.find((q) => q.id === third).difficulty = "EASY";

    const again = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-freeze")));
    const againIds = again.body.exam.questions.map((q) => q.id);
    ok(again.body.exam.resumed === true && again.body.exam.attemptId === attemptId, "the refetch resumes the SAME attempt");
    ok(
      JSON.stringify(againIds) === JSON.stringify(frozenIds),
      `identical ids AND order after add/detach/eligibility/difficulty changes (${againIds.join(",")})`
    );
    ok(!againIds.includes("mFrozenNew"), "a newly eligible question is NOT injected into the running paper");
    const mutatedPool = expectedPool(T, "ARABIC", "c1", "mx-freeze");
    ok(
      !mutatedPool.includes(detached) && !mutatedPool.includes(moved),
      "the mutations really removed those rows from the live pool"
    );
    ok(
      JSON.stringify(
        poolLib.selectMockExamQuestions(mutatedPool.map((id) => ({ id })), 3, paper.seed).map((q) => q.id)
      ) !== JSON.stringify(frozenIds),
      "a fresh sample over the mutated pool would NOT reproduce the paper — persistence, not determinism"
    );

    // Submitting finalizes the frozen row; the next start draws a NEW paper.
    const sub = await bodyOf(
      await examRoute.POST(postReq({ examType: "MOCK", mockExamId: "mx-freeze", answers: frozenIds.map((id) => ({ questionId: id, selected: "beta" })) }))
    );
    ok(sub.status === 200 && sub.body.attempt.id === attemptId, "the submit finalized the SAME row (history keeps its identity)");
    const after = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-freeze")));
    const nextIds = after.body.exam.questions.map((q) => q.id);
    ok(after.body.exam.attemptId !== attemptId && after.body.exam.resumed === false, "a new start opens a NEW attempt (fresh paper)");
    const postPool = expectedPool(T, "ARABIC", "c1", "mx-freeze");
    const seed1 = poolLib.mockExamSampleSeed({
      studentId: "sa", courseId: "c1", examId: "mx-freeze", attemptIndex: 1, count: 3, difficulty: "mixed",
    });
    ok(
      JSON.stringify(nextIds) === JSON.stringify(seededSample(postPool, 3, seed1)),
      "the retry paper is drawn fresh from the CURRENT (mutated) pool"
    );
    ok(nextIds.every((id) => postPool.includes(id)), "and it never contains a row the bank no longer serves");
  }

  section("I. An exam whose bank is emptied after publication");
  {
    // The Admin cannot un-publish by accident, but the bank behind a published
    // exam can be emptied by deletion. The student path must degrade to a clear
    // "no questions" answer rather than an empty paper. (`mx-empty-lang` is a
    // LANGUAGE exam, so this runs as the LANGUAGE student.)
    logout();
    await loginAs("u-sb");
    for (const t of ["question", "examQuestion"]) {
      const rows = T[t];
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].schoolType === null || rows[i].schoolType === "LANGUAGE") rows.splice(i, 1);
      }
    }
    const empty = await bodyOf(await examRoute.GET(getReq("mockExamId=mx-empty-lang")));
    ok(empty.status === 200 && empty.body.exam === null, "an emptied bank yields exam:null, not a broken paper");
    ok(typeof empty.body.message === "string" && empty.body.message.length > 0, "and a clear message for the student");
    ok(empty.body.eligiblePool === 0, "the response reports an empty eligible pool");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

main().then((fail) => process.exit(fail ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
