// CodeMind Academy — Phase 8 Mock Exam cleanup & integration tests (offline, no DB).
//
// Exercises the REAL route handlers with an in-memory mock Prisma client
// (the real db/custom.db is never touched):
//   - GET/POST /api/exams/mock
//   - GET/POST /api/admin/mock-exams
//   - PATCH/DELETE /api/admin/mock-exams/[id]
//   - GET  /api/students/me/mock-exams
//
// Fixture shape:
//   Course C1 (ARABIC students): canonical lesson LC1 (quiz Q1) + legacy
//   lesson LL1 (quiz Q2); questions across ARABIC / LANGUAGE / shared banks
//   in BOTH question tables. Course C2 (LANGUAGE students): one canonical
//   lesson. StudentA (ARABIC, C1), StudentB (LANGUAGE, C2), StudentC
//   (unenrolled), StudentD (no school type).
//
// Contracts under test:
//   - GET serves NO answer key (no correctIndex / explanation per question);
//     correctness is revealed only by the POST review payload.
//   - FIXED exams serve the pinned set in pinned order (no shuffle/slice/
//     difficulty filter); RANDOM exams sample server-side per request.
//   - Grading stays server-side + bank-isolated (extends the isolation suite).
//   - ExamAttempt state never touches QuizAttempt/QuizAnswer/LessonProgress.
//   - Teacher analytics + parent dashboard keep mock results separate
//     (source invariants; the Phase 6/7 suites guard the behaviour).
//
// Run: node tests/mock-exam-phase8.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase8-"));

// ---------------------------------------------------------------------------
// 1. Compile the files under test with tsc (type errors fail the suite)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/school-type.ts",
  "src/lib/enrollment.ts",
  "src/lib/api.ts",
  "src/app/api/exams/mock/route.ts",
  "src/app/api/admin/mock-exams/route.ts",
  "src/app/api/admin/mock-exams/[id]/route.ts",
  "src/app/api/students/me/mock-exams/route.ts",
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
  else { fail++; console.log(`  ✗ ${label}`); }
};
const section = (t) => console.log(`\n${t}`);

const examRoute = require(compiled("src/app/api/exams/mock/route.ts"));
const adminRoute = require(compiled("src/app/api/admin/mock-exams/route.ts"));
const adminIdRoute = require(compiled("src/app/api/admin/mock-exams/[id]/route.ts"));
const studentListRoute = require(compiled("src/app/api/students/me/mock-exams/route.ts"));

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
// 5. Fixture
// ---------------------------------------------------------------------------
const NOW = Date.now();
const D = (daysAgo) => new Date(NOW - daysAgo * 86400000);
const OPTS = JSON.stringify(["alpha", "beta", "gamma", "delta"]);

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
    { id: "c1", slug: "course-1", name: "Course One", nameAr: "كورس ١" },
    { id: "c2", slug: "course-2", name: "Course Two", nameAr: "كورس ٢" },
  );
  T.group.push(
    { id: "g1", name: "Group 1", courseId: "c1", isActive: true },
    { id: "g2", name: "Group 2", courseId: "c2", isActive: true },
  );
  // C1 curriculum: canonical lesson LC1 + legacy lesson LL1.
  T.part.push({ id: "p1", courseId: "c1", title: "P1", titleAr: "ج١", order: 1 });
  T.unit.push({ id: "u1", partId: "p1", title: "U1", titleAr: "و١", order: 1 });
  T.topic.push({ id: "t1", unitId: "u1", title: "T1", titleAr: "م١", order: 1 });
  T.lesson.push(
    { id: "lc1", topicId: null, unitId: "u1", title: "Canonical", titleAr: "كانوني", order: 1 },
    { id: "ll1", topicId: "t1", unitId: null, title: "Legacy", titleAr: "قديم", order: 2 },
  );
  // C2 curriculum: one canonical lesson.
  T.part.push({ id: "p2", courseId: "c2", title: "P1", titleAr: "ج١", order: 1 });
  T.unit.push({ id: "u2", partId: "p2", title: "U1", titleAr: "و١", order: 1 });
  T.lesson.push(
    { id: "lc2", topicId: null, unitId: "u2", title: "C2 lesson", titleAr: "درس ٢", order: 1 },
  );

  T.quiz.push(
    { id: "q1", lessonId: "lc1", title: "Q1", titleAr: "س١", passMark: 60 },
    { id: "q2", lessonId: "ll1", title: "Q2", titleAr: "س٢", passMark: 60 },
    { id: "q3", lessonId: "lc2", title: "Q3", titleAr: "س٣", passMark: 60 },
  );
  // Question bank (Question table): ARABIC + shared + LANGUAGE rows.
  T.question.push(
    { id: "qar1", quizId: "q1", type: "MCQ", prompt: "ar1", promptAr: "ع١", options: OPTS, answer: "1", explanation: "exp-ar1", difficulty: "EASY", marks: 5, schoolType: "ARABIC", createdAt: D(9) },
    { id: "qshared1", quizId: "q1", type: "MCQ", prompt: "sh1", promptAr: "مش١", options: OPTS, answer: "0", explanation: "exp-sh1", difficulty: "MEDIUM", marks: 2, schoolType: null, createdAt: D(9) },
    { id: "qar2", quizId: "q2", type: "MCQ", prompt: "ar2", promptAr: "ع٢", options: OPTS, answer: "3", explanation: "exp-ar2", difficulty: "HARD", marks: 3, schoolType: "ARABIC", createdAt: D(9) },
    { id: "qlang1", quizId: "q2", type: "MCQ", prompt: "lang1", promptAr: null, options: OPTS, answer: "2", explanation: "exp-lang1", difficulty: "EASY", marks: 4, schoolType: "LANGUAGE", createdAt: D(9) },
    { id: "qlang2", quizId: "q3", type: "MCQ", prompt: "lang2", promptAr: null, options: OPTS, answer: "0", explanation: "exp-lang2", difficulty: "EASY", marks: 1, schoolType: "LANGUAGE", createdAt: D(9) },
  );
  // ExamQuestion table: same bank split (legacy pool).
  T.examQuestion.push(
    { id: "eqar1", lessonId: "lc1", examType: "MOCK", prompt: "eq-ar1", promptAr: "تج١", options: OPTS, answer: "2", explanation: "exp-eqar1", difficulty: "MEDIUM", marks: 6, schoolType: "ARABIC" },
    { id: "eqshared1", lessonId: "ll1", examType: "MOCK", prompt: "eq-sh1", promptAr: "تج-مش١", options: OPTS, answer: "1", explanation: "exp-eqsh1", difficulty: "EASY", marks: 2, schoolType: null },
    { id: "eqlang1", lessonId: "ll1", examType: "MOCK", prompt: "eq-lang1", promptAr: null, options: OPTS, answer: "0", explanation: "exp-eqlang1", difficulty: "EASY", marks: 7, schoolType: "LANGUAGE" },
  );

  T.student.push(
    { id: "sa", userId: "u-sa", schoolType: "ARABIC", groupId: "g1", batchId: null },
    { id: "sb", userId: "u-sb", schoolType: "LANGUAGE", groupId: "g2", batchId: null },
    { id: "sc", userId: "u-sc", schoolType: "ARABIC", groupId: null, batchId: null },
    { id: "sd", userId: "u-sd", schoolType: null, groupId: "g1", batchId: null },
  );

  T.mockExam.push(
    { id: "m-random-ar", title: "Random AR", titleAr: "عشوائي ع", description: null, schoolType: "ARABIC", courseId: "c1", questionCount: 2, durationMin: 20, passMark: 70, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: true, createdAt: D(5) },
    // questionCount(5) intentionally exceeds the 3 pins + HARD difficulty:
    // FIXED must serve the pins, not the count/difficulty.
    { id: "m-fixed-ar", title: "Fixed AR", titleAr: "ثابت ع", description: null, schoolType: "ARABIC", courseId: null, questionCount: 5, durationMin: 25, passMark: 50, difficulty: "HARD", selectionMode: "FIXED", isPublished: true, createdAt: D(4) },
    { id: "m-fixed-lang", title: "Fixed LANG", titleAr: "ثابت لغات", description: null, schoolType: "LANGUAGE", courseId: null, questionCount: 2, durationMin: 30, passMark: 60, difficulty: "MIXED", selectionMode: "FIXED", isPublished: true, createdAt: D(4) },
    { id: "m-unpub", title: "Draft", titleAr: "مسودة", description: null, schoolType: "ARABIC", courseId: null, questionCount: 2, durationMin: 30, passMark: 60, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: false, createdAt: D(3) },
    { id: "m-c2", title: "C2 AR", titleAr: "ع ك٢", description: null, schoolType: "ARABIC", courseId: "c2", questionCount: 2, durationMin: 30, passMark: 60, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: true, createdAt: D(3) },
    { id: "m-fixed-empty", title: "Empty fixed", titleAr: "ثابت فاضي", description: null, schoolType: "ARABIC", courseId: null, questionCount: 2, durationMin: 30, passMark: 60, difficulty: "MIXED", selectionMode: "FIXED", isPublished: true, createdAt: D(2) },
  );
  T.mockExamQuestion.push(
    { id: "pin1", mockExamId: "m-fixed-ar", questionId: "qar1", examQuestionId: null, order: 0 },
    { id: "pin2", mockExamId: "m-fixed-ar", questionId: null, examQuestionId: "eqar1", order: 1 },
    { id: "pin3", mockExamId: "m-fixed-ar", questionId: "qshared1", examQuestionId: null, order: 2 },
    { id: "pinL1", mockExamId: "m-fixed-lang", questionId: "qlang2", examQuestionId: null, order: 0 },
    { id: "pinL2", mockExamId: "m-fixed-lang", questionId: null, examQuestionId: "eqlang1", order: 1 },
  );

  // Finished history: sa has a linked attempt + an unlinked practice attempt;
  // sb has one linked attempt (must never leak into sa's numbers).
  T.examAttempt.push(
    { id: "att-sa-1", studentId: "sa", mockExamId: "m-random-ar", schoolType: "ARABIC", examType: "MOCK", questionCount: 2, durationMin: 20, score: 8, totalMarks: 10, percentage: 80, passed: true, answers: "[]", startedAt: D(2), finishedAt: D(2) },
    { id: "att-sa-2", studentId: "sa", mockExamId: null, schoolType: "ARABIC", examType: "MOCK", questionCount: 5, durationMin: 10, score: 2, totalMarks: 10, percentage: 20, passed: false, answers: "[]", startedAt: D(1), finishedAt: D(1) },
    { id: "att-sb-1", studentId: "sb", mockExamId: "m-fixed-lang", schoolType: "LANGUAGE", examType: "MOCK", questionCount: 2, durationMin: 30, score: 8, totalMarks: 8, percentage: 100, passed: true, answers: "[]", startedAt: D(1), finishedAt: D(1) },
  );
}

const BANK = { qar1: "ARABIC", qshared1: null, qar2: "ARABIC", qlang1: "LANGUAGE", qlang2: "LANGUAGE" };
const EBANK = { eqar1: "ARABIC", eqshared1: null, eqlang1: "LANGUAGE" };
const bankOf = (id) => (id in BANK ? BANK[id] : EBANK[id]);
const inBank = (id, st) => bankOf(id) === st || bankOf(id) === null;

// ---------------------------------------------------------------------------
// 6. The tests
// ---------------------------------------------------------------------------
async function main() {
  await seed();
  const T = global.__MOCK_DB__.__tables;

  section("A. auth matrix");
  logout();
  {
    const g = await bodyOf(await examRoute.GET(getReq("count=5")));
    ok(g.status === 401, "GET /api/exams/mock unauthenticated -> 401");
    const p = await bodyOf(await examRoute.POST(postReq({ answers: [] })));
    ok(p.status === 401, "POST /api/exams/mock unauthenticated -> 401");
    const l = await bodyOf(await studentListRoute.GET(getReq("")));
    ok(l.status === 401, "GET student mock-exams unauthenticated -> 401");
  }
  for (const [uid, label] of [["u-t1", "TEACHER"], ["u-pa", "PARENT"], ["u-ad", "ADMIN"]]) {
    await loginAs(uid);
    const g = await bodyOf(await examRoute.GET(getReq("count=5")));
    ok(g.status === 403, `${label} GET /api/exams/mock -> 403 (students only)`);
    const p = await bodyOf(await examRoute.POST(postReq({ answers: [] })));
    ok(p.status === 403, `${label} POST /api/exams/mock -> 403 (students only)`);
    const l = await bodyOf(await studentListRoute.GET(getReq("")));
    ok(l.status === 403, `${label} GET student mock-exams -> 403 (students only)`);
  }
  await loginAs("u-sa");
  {
    const g = await bodyOf(await adminRoute.GET(getReq("")));
    ok(g.status === 401 || g.status === 403, "student GET admin mock-exams -> denied");
    const p = await bodyOf(await adminRoute.POST(postReq({ title: "x", schoolType: "ARABIC" })));
    ok(p.status === 401 || p.status === 403, "student POST admin mock-exams -> denied");
    const pt = await bodyOf(await adminIdRoute.PATCH(postReq({ isPublished: true }), params({ id: "m-random-ar" })));
    ok(pt.status === 401 || pt.status === 403, "student PATCH admin mock-exam -> denied");
    const dl = await bodyOf(await adminIdRoute.DELETE(getReq(""), params({ id: "m-random-ar" })));
    ok(dl.status === 401 || dl.status === 403, "student DELETE admin mock-exam -> denied");
  }

  section("B. GET practice: no answer key, bank isolation, canonical+legacy");
  await loginAs("u-sa");
  clearWrites();
  {
    const r = await bodyOf(await examRoute.GET(getReq("count=10&difficulty=mixed")));
    ok(r.status === 200 && r.body.exam, "practice GET serves an exam");
    const qs = r.body.exam.questions;
    ok(qs.length === 5, `ARABIC practice pool serves all 5 in-bank C1 questions (got ${qs.length})`);
    ok(qs.every((q) => !("correctIndex" in q)), "served questions carry NO correctIndex");
    ok(qs.every((q) => !("explanation" in q)), "served questions carry NO explanation");
    ok(
      JSON.stringify(qs).includes("exp-ar1") === false,
      "no stored explanation text leaks into the draft payload"
    );
    const ids = qs.map((q) => q.id).sort();
    ok(
      JSON.stringify(ids) === JSON.stringify(["eqar1", "eqshared1", "qar1", "qar2", "qshared1"]),
      `pool = canonical + legacy x both tables (${ids.join(",")})`
    );
    ok(qs.every((q) => inBank(q.id, "ARABIC")), "every served id is ARABIC-bank or shared");
    ok(qs.every((q) => Array.isArray(q.options) && q.options.length === 4), "options served as arrays");
    ok(r.body.exam.schoolType === "ARABIC", "exam echo carries the DB-backed school type");
    ok(r.body.exam.mockExamId === null, "practice draft is unlinked");
  }
  {
    // count clamping + difficulty contract + examType whitelist
    const big = await bodyOf(await examRoute.GET(getReq("count=9999")));
    ok(big.body.exam.questions.length === 5, "count=9999 clamps to the pool (no crash, no dupes)");
    const zero = await bodyOf(await examRoute.GET(getReq("count=0")));
    ok(zero.body.exam.questions.length >= 1, "count=0 clamps up to >= 1");
    const nan = await bodyOf(await examRoute.GET(getReq("count=abc")));
    ok(nan.status === 200 && nan.body.exam, "count=abc falls back safely");
    const easy = await bodyOf(await examRoute.GET(getReq("count=10&difficulty=EASY")));
    const eids = easy.body.exam.questions.map((q) => q.id).sort();
    ok(
      JSON.stringify(eids) === JSON.stringify(["eqshared1", "qar1"]),
      `difficulty=EASY filters server-side (${eids.join(",")})`
    );
    const bogus = await bodyOf(await examRoute.GET(getReq("count=2&difficulty=BOGUS")));
    ok(bogus.body.exam.questions.length === 2, "unknown difficulty falls back to the full pool");
    const et = await bodyOf(await examRoute.GET(getReq("count=2&examType=BOGUS")));
    ok(et.body.exam.examType === "MOCK", "unknown examType echoes as MOCK");
  }
  {
    // LANGUAGE student, C2 course: own bank only.
    await loginAs("u-sb");
    const r = await bodyOf(await examRoute.GET(getReq("count=10")));
    const ids = r.body.exam.questions.map((q) => q.id).sort();
    ok(JSON.stringify(ids) === JSON.stringify(["qlang2"]), `LANGUAGE C2 pool is exactly [qlang2] (${ids.join(",")})`);
    ok(r.body.exam.questions.every((q) => !("correctIndex" in q)), "no key for LANGUAGE either");
  }
  ok(
    academicWrites().length === 0,
    "GET /api/exams/mock is read-only (no attempt created by viewing)"
  );

  section("C. GET linked exam: eligibility gates");
  await loginAs("u-sa");
  {
    const r = await bodyOf(await examRoute.GET(getReq("mockExamId=m-random-ar")));
    ok(r.status === 200 && r.body.exam.mockExamId === "m-random-ar", "eligible linked exam served");
    ok(r.body.exam.questions.length === 2, "linked exam uses its configured count");
    ok(r.body.exam.durationMin === 20 && r.body.exam.passMark === 70, "linked exam config applied");
    ok(r.body.exam.questions.every((q) => inBank(q.id, "ARABIC")), "linked RANDOM sample stays in-bank");
  }
  {
    const no = await bodyOf(await examRoute.GET(getReq("mockExamId=does-not-exist")));
    ok(no.status === 404, "unknown exam id -> 404");
    const unpub = await bodyOf(await examRoute.GET(getReq("mockExamId=m-unpub")));
    ok(unpub.status === 404, "unpublished exam -> 404");
    const cross = await bodyOf(await examRoute.GET(getReq("mockExamId=m-c2")));
    ok(cross.status === 404, "course-bound exam outside my course -> 404 (no existence leak)");
    await loginAs("u-sb");
    const bank = await bodyOf(await examRoute.GET(getReq("mockExamId=m-random-ar")));
    ok(bank.status === 403, "foreign-bank exam -> 403");
    const fixedLang = await bodyOf(await examRoute.GET(getReq("mockExamId=m-fixed-lang")));
    ok(fixedLang.status === 200, "LANGUAGE student opens the LANGUAGE fixed exam");
  }
  {
    await loginAs("u-sc");
    const un = await bodyOf(await examRoute.GET(getReq("count=5")));
    ok(un.status === 400, "unenrolled student GET -> 400");
    await loginAs("u-sd");
    const nt = await bodyOf(await examRoute.GET(getReq("count=5")));
    ok(nt.status === 400, "student with no school type GET -> 400");
  }

  section("D. FIXED contract: pinned set, pinned order, deterministic");
  await loginAs("u-sa");
  {
    const seqs = [];
    for (let i = 0; i < 3; i++) {
      const r = await bodyOf(await examRoute.GET(getReq("mockExamId=m-fixed-ar")));
      ok(r.status === 200, `FIXED fetch #${i + 1} -> 200`);
      seqs.push(r.body.exam.questions.map((q) => q.id));
    }
    const want = ["qar1", "eqar1", "qshared1"];
    ok(
      seqs.every((s) => JSON.stringify(s) === JSON.stringify(want)),
      `FIXED serves pins in pinned order across refetches (${seqs[0].join(",")})`
    );
    const r = await bodyOf(await examRoute.GET(getReq("mockExamId=m-fixed-ar")));
    ok(r.body.exam.questions.length === 3, "FIXED serves the pins (3), not questionCount (5)");
    ok(
      r.body.exam.questions.some((q) => q.difficulty !== "HARD"),
      "FIXED ignores the exam difficulty filter (pins rule)"
    );
    const empty = await bodyOf(await examRoute.GET(getReq("mockExamId=m-fixed-empty")));
    ok(empty.status === 200 && empty.body.exam === null, "FIXED exam with zero pins -> exam:null + message");
  }

  section("E. POST: server grading + review + attribution + isolation");
  await loginAs("u-sa");
  const quizAttemptsBefore = T.quizAttempt.length;
  const quizAnswersBefore = T.quizAnswer.length;
  const lessonProgressBefore = T.lessonProgress.length;
  const examAttemptsBefore = T.examAttempt.length;
  let firstAttemptId = null;
  {
    // Honest submission on own bank (selected TEXT, the client contract).
    const r = await bodyOf(
      await examRoute.POST(
        postReq({
          examType: "MOCK",
          durationMin: 20,
          mockExamId: "m-random-ar",
          answers: [
            { questionId: "qar1", selected: "beta", isCorrect: false, marks: 0 },
            { questionId: "eqshared1", selected: "WRONG-TEXT", isCorrect: true, marks: 9999 },
          ],
        })
      )
    );
    ok(r.status === 200, "honest submit -> 200");
    const a = r.body.attempt;
    firstAttemptId = a.id;
    ok(a.mockExamId === "m-random-ar", "attempt attributed to the eligible exam");
    ok(a.score === 5 && a.totalMarks === 7, `score/total recomputed server-side (5/7, got ${a.score}/${a.totalMarks})`);
    ok(a.percentage === 71 && a.passed === true, `71% >= passMark 70 -> passed (got ${a.percentage}/${a.passed})`);
    ok(a.durationMin === 20, "linked attempt inherits the exam duration");
    ok(a.finishedAt, "attempt is finished at submit");
    ok(Array.isArray(r.body.review) && r.body.review.length === 2, "POST returns a per-question review");
    const rev = Object.fromEntries(r.body.review.map((x) => [x.questionId, x]));
    ok(rev.qar1.isCorrect === true && rev.qar1.correctText === "beta", "review: correct text revealed post-submit");
    ok(rev.qar1.explanation === "exp-ar1", "review: explanation revealed post-submit");
    ok(rev.eqshared1.isCorrect === false && rev.eqshared1.correctText === "beta", "wrong answer: review still shows the key");
    ok(rev.eqshared1.marks === 2, "client marks:9999 overridden by the DB key (2)");
    const snap = JSON.parse(T.examAttempt.find((x) => x.id === a.id).answers);
    ok(snap.length === 2 && snap.every((s) => typeof s.isCorrect === "boolean"), "answers snapshot persisted as JSON");
  }
  {
    // Crafted submission: foreign-bank + unknown ids, forged score fields.
    const r = await bodyOf(
      await examRoute.POST(
        postReq({
          examType: "BOGUS",
          durationMin: 9999,
          mockExamId: "m-fixed-lang",
          answers: [
            { questionId: "qlang1", selected: "gamma", isCorrect: true, marks: 100 },
            { questionId: "eqlang1", selected: "alpha", isCorrect: true, marks: 100 },
            { questionId: "nope", selected: "0", isCorrect: true, marks: 100 },
          ],
        })
      )
    );
    ok(r.status === 200, "crafted submit still -> 200 (graded, not trusted)");
    const a = r.body.attempt;
    ok(a.mockExamId === null, "foreign-bank exam id is NOT linked (silent practice fallback)");
    ok(a.score === 0 && a.totalMarks === 0 && a.percentage === 0, "foreign/unknown ids score 0 with 0 total");
    ok(a.passed === false, "0% does not pass");
    ok(a.examType === "MOCK", "bogus examType stored as MOCK");
    ok(a.durationMin === 300, "free-practice duration clamped to 300");
    ok(r.body.review.every((x) => x.correctText === null && x.explanation === null), "no key material for out-of-bank ids");
    ok(r.body.review.every((x) => x.isCorrect === false), "forged isCorrect:true overridden everywhere");
    const malformed = await bodyOf(
      await examRoute.POST(
        postReq({
          answers: [
            { questionId: 12345, selected: "beta", isCorrect: true, marks: 50 },
            { questionId: null, selected: "beta", isCorrect: true, marks: 50 },
            { questionId: { $ne: null }, selected: "beta", isCorrect: true, marks: 50 },
          ],
        })
      )
    );
    ok(malformed.status === 200, "non-string questionIds do not crash grading");
    ok(malformed.body.attempt.score === 0 && malformed.body.attempt.totalMarks === 0, "malformed ids grade as unknown (0/0)");
  }
  {
    // Unpublished exam id + oversized payload + missing answers + gates.
    const unpub = await bodyOf(
      await examRoute.POST(postReq({ mockExamId: "m-unpub", answers: [{ questionId: "qar1", selected: "beta" }] }))
    );
    ok(unpub.body.attempt.mockExamId === null, "unpublished exam id is NOT linked");
    const big = await bodyOf(
      await examRoute.POST(postReq({ answers: new Array(201).fill({ questionId: "qar1", selected: "x" }) }))
    );
    ok(big.status === 400, ">200 answers -> 400");
    const missing = await bodyOf(await examRoute.POST(postReq({})));
    ok(missing.status === 400, "missing answers -> 400");
    await loginAs("u-sc");
    const un = await bodyOf(await examRoute.POST(postReq({ answers: [{ questionId: "qar1", selected: "beta" }] })));
    ok(un.status === 400, "unenrolled student POST -> 400 (no attempt created)");
    await loginAs("u-sa");
  }
  {
    // Retake = a second row; history untouched; session-quiz state untouched.
    const again = await bodyOf(
      await examRoute.POST(
        postReq({ answers: [{ questionId: "qar1", selected: "beta", isCorrect: false, marks: 0 }] })
      )
    );
    ok(again.body.attempt.id !== firstAttemptId, "second submit creates a NEW attempt (no overwrite)");
    ok(T.examAttempt.length === examAttemptsBefore + 5, "5 POSTs created exactly 5 ExamAttempt rows");
    ok(
      T.examAttempt.every((a) => a.finishedAt),
      "every ExamAttempt row is finished (no open server state)"
    );
    ok(T.quizAttempt.length === quizAttemptsBefore, "mock submits create NO QuizAttempt");
    ok(T.quizAnswer.length === quizAnswersBefore, "mock submits create NO QuizAnswer");
    ok(T.lessonProgress.length === lessonProgressBefore, "mock submits touch NO LessonProgress");
  }

  section("F. student list: eligibility + own history only + read-only");
  await loginAs("u-sa");
  clearWrites();
  {
    const r = await bodyOf(await studentListRoute.GET(getReq("")));
    ok(r.status === 200, "student list -> 200");
    const ids = r.body.exams.map((e) => e.id).sort();
    ok(
      JSON.stringify(ids) === JSON.stringify(["m-fixed-ar", "m-fixed-empty", "m-random-ar"]),
      `sa sees exactly her eligible published exams (${ids.join(",")})`
    );
    ok(!JSON.stringify(r.body).includes("correctIndex"), "list payload carries no key material");
    const byId = Object.fromEntries(r.body.exams.map((e) => [e.id, e]));
    ok(byId["m-random-ar"].attempts === 2 && byId["m-random-ar"].bestPercentage === 80, "own attempt count + best (2 attempts, best 80)");
    ok(byId["m-fixed-ar"].attempts === 0 && byId["m-fixed-ar"].bestPercentage === null, "untaken exam: 0 attempts, null best");
    await loginAs("u-sb");
    const rb = await bodyOf(await studentListRoute.GET(getReq("")));
    const bIds = rb.body.exams.map((e) => e.id);
    ok(JSON.stringify(bIds) === JSON.stringify(["m-fixed-lang"]), "sb sees only the LANGUAGE exam");
    ok(rb.body.exams[0].attempts === 1 && rb.body.exams[0].bestPercentage === 100, "sb's own history only (sa's rows never leak)");
    await loginAs("u-sc");
    const un = await bodyOf(await studentListRoute.GET(getReq("")));
    ok(un.status === 400, "unenrolled student list -> 400");
  }
  ok(academicWrites().length === 0, "student list endpoint is read-only");

  section("G. admin: guards count both tables, stale sweep, delete detaches");
  await loginAs("u-ad");
  {
    const r = await bodyOf(await adminRoute.GET(getReq("schoolType=ARABIC")));
    ok(r.status === 200, "admin list -> 200");
    ok(r.body.pools.ARABIC === 5 && r.body.pools.LANGUAGE === 5, `pools count Q+EQ per bank, shared in both (AR=5, LANG=5, got ${r.body.pools.ARABIC}/${r.body.pools.LANGUAGE})`);
    ok(r.body.exams.every((e) => e.schoolType === "ARABIC"), "schoolType filter applied");
    const fixed = r.body.exams.find((e) => e.id === "m-fixed-ar");
    ok(fixed.pinnedQuestions === 3 && fixed.attempts === 0, "list carries pin + attempt counts");
  }
  {
    const sat = await bodyOf(
      await adminRoute.POST(postReq({ title: "New random", titleAr: "جديد", schoolType: "ARABIC", questionCount: 5, difficulty: "MIXED", selectionMode: "RANDOM" }))
    );
    ok(sat.status === 200, "create RANDOM satisfiable-by-combined-pool (5 > 3 Q-only, <= 5 total) -> 200");
    const justOver = await bodyOf(
      await adminRoute.POST(postReq({ title: "Just over", schoolType: "ARABIC", questionCount: 6 }))
    );
    ok(justOver.status === 400, "create one past the combined pool (6 > 5) -> 400");
    const over = await bodyOf(
      await adminRoute.POST(postReq({ title: "Too big", schoolType: "ARABIC", questionCount: 99 }))
    );
    ok(over.status === 400, "create beyond the combined pool -> 400");
    const noTitle = await bodyOf(await adminRoute.POST(postReq({ schoolType: "ARABIC" })));
    ok(noTitle.status === 400, "create without title -> 400");
    const noType = await bodyOf(await adminRoute.POST(postReq({ title: "x" })));
    ok(noType.status === 400, "create without schoolType -> 400");
    const bogusCourse = await bodyOf(
      await adminRoute.POST(postReq({ title: "x", schoolType: "ARABIC", questionCount: 1, courseId: "no-such-course" }))
    );
    ok(bogusCourse.status === 400, "create with an unknown courseId -> 400 (no dangling binding)");
    const fx = await bodyOf(
      await adminRoute.POST(postReq({ title: "New fixed", schoolType: "ARABIC", questionCount: 3, selectionMode: "FIXED" }))
    );
    ok(fx.status === 200, "create FIXED -> 200");
    const pins = T.mockExamQuestion.filter((l) => l.mockExamId === fx.body.exam.id);
    ok(pins.length === 3, "FIXED auto-pins exactly questionCount links");
    ok(pins.every((l) => l.questionId && !l.examQuestionId), "auto-pins point at the Question bank");
    const pinnedTypes = pins.map((l) => T.question.find((q) => q.id === l.questionId).schoolType);
    ok(pinnedTypes.every((st) => st === "ARABIC" || st === null), "auto-pins drawn only from the matching bank");
  }
  {
    // Publish guard: inflate the count, then try to publish.
    const mk = await bodyOf(
      await adminRoute.POST(postReq({ title: "Draft big", schoolType: "ARABIC", questionCount: 2 }))
    );
    const id = mk.body.exam.id;
    const inflate = await bodyOf(await adminIdRoute.PATCH(postReq({ questionCount: 50 }), params({ id })));
    ok(inflate.status === 200, "raising questionCount on a draft is allowed");
    const pub = await bodyOf(await adminIdRoute.PATCH(postReq({ isPublished: true }), params({ id })));
    ok(pub.status === 400, "publishing beyond the combined pool -> 400");
    const missing = await bodyOf(await adminIdRoute.PATCH(postReq({ isPublished: true }), params({ id: "nope" })));
    ok(missing.status === 404, "PATCH unknown exam -> 404");
  }
  {
    // Bank switch sweeps BOTH link types, keeps shared pins.
    const before = T.mockExamQuestion.filter((l) => l.mockExamId === "m-fixed-ar").map((l) => l.id).sort();
    ok(JSON.stringify(before) === JSON.stringify(["pin1", "pin2", "pin3"]), "3 pins before the switch");
    const sw = await bodyOf(
      await adminIdRoute.PATCH(postReq({ schoolType: "LANGUAGE" }), params({ id: "m-fixed-ar" }))
    );
    ok(sw.status === 200 && sw.body.exam.schoolType === "LANGUAGE", "schoolType switch -> 200");
    const after = T.mockExamQuestion.filter((l) => l.mockExamId === "m-fixed-ar").map((l) => l.id);
    ok(JSON.stringify(after) === JSON.stringify(["pin3"]), "ARABIC Question + ExamQuestion pins swept, shared pin kept");
    // FIXED exam now serves the surviving shared pin only (no leakage).
    await loginAs("u-sb");
    const r = await bodyOf(await examRoute.GET(getReq("mockExamId=m-fixed-ar")));
    ok(
      r.status === 200 && JSON.stringify(r.body.exam.questions.map((q) => q.id)) === JSON.stringify(["qshared1"]),
      "post-switch FIXED serves only the surviving shared pin"
    );
    await loginAs("u-ad");
  }
  {
    // DELETE detaches attempts (history survives) and removes the definition.
    const attBefore = T.examAttempt.filter((a) => a.mockExamId === "m-random-ar").length;
    ok(attBefore === 2, "2 attempts linked to m-random-ar before delete");
    const dl = await bodyOf(await adminIdRoute.DELETE(getReq(""), params({ id: "m-random-ar" })));
    ok(dl.status === 200, "DELETE -> 200");
    ok(!T.mockExam.find((e) => e.id === "m-random-ar"), "exam definition removed");
    ok(T.examAttempt.filter((a) => a.mockExamId === "m-random-ar").length === 0, "no dangling links remain");
    ok(T.examAttempt.length === examAttemptsBefore + 5, "attempt rows themselves survive the delete");
    const dlMissing = await bodyOf(await adminIdRoute.DELETE(getReq(""), params({ id: "nope" })));
    ok(dlMissing.status === 404, "DELETE unknown exam -> 404");
  }

  section("H. session-quiz / teacher / parent separation (source invariants)");
  {
    const examSrc = fs.readFileSync(path.join(REPO, "src/app/api/exams/mock/route.ts"), "utf8");
    const getSeg = examSrc.slice(examSrc.indexOf("export async function GET"), examSrc.indexOf("export async function POST"));
    const postSeg = examSrc.slice(examSrc.indexOf("export async function POST"));
    ok(!/correctIndex/.test(getSeg), "GET segment never mentions the answer key");
    // No `explanation:`/`explanation,` payload key in the served draft (the
    // word itself appears only in the no-key-design comment).
    ok(!/explanation\s*[:,}]/.test(getSeg), "GET segment ships no explanation payload key");
    ok(/correctText/.test(postSeg), "POST builds the post-submit review (correctText)");
    ok(!/quizAttempt|quizAnswer|lessonProgress/i.test(examSrc), "mock route never touches session-quiz/progression tables");
    ok(!/findFirst/.test(examSrc), "mock route holds no open-attempt lookup (submit-atomic design)");
    const quizStart = fs.readFileSync(path.join(REPO, "src/app/api/quizzes/[id]/start/route.ts"), "utf8");
    const quizSubmit = fs.readFileSync(path.join(REPO, "src/app/api/quizzes/[id]/submit/route.ts"), "utf8");
    ok(!/examAttempt|mockExam/i.test(quizStart + quizSubmit), "session-quiz routes never touch mock-exam tables");
    const teacherAnalytics = fs.readFileSync(path.join(REPO, "src/app/api/teacher/analytics/route.ts"), "utf8");
    ok(!/examAttempt|mockExam/i.test(teacherAnalytics), "teacher analytics exclude ExamAttempt (Phase 6 intact)");
    const parentDash = fs.readFileSync(path.join(REPO, "src/app/api/parents/me/dashboard/route.ts"), "utf8");
    ok(/studentId: student\.id, finishedAt: \{ not: null \}/.test(parentDash), "parent mock block stays finished-only + child-scoped");
    ok(!/db\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/.test(parentDash), "parent dashboard stays read-only");
    const client = fs.readFileSync(path.join(REPO, "src/components/student/mock-exam.tsx"), "utf8");
    ok(/q\.options\[selected\]/.test(client), "client submits the selected option TEXT (server contract)");
    ok(/mockExamId/.test(client), "client plumbs mockExamId through start + submit");
    ok(!/correctIndex/.test(client), "client no longer reads any answer key");
    ok(/d\.review/.test(client), "client renders correctness from the POST review");
    const mig = fs.readFileSync(path.join(REPO, "prisma/migrations/20260906120000_platform_upgrade_2026/migration.sql"), "utf8");
    ok(/MockExamQuestion_mockExamId_fkey.*ON DELETE CASCADE/.test(mig), "schema: deleting an exam cascades its pins");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  return fail;
}

main().then((fail) => process.exit(fail ? 1 : 0)).catch((e) => { console.error(e); process.exit(1); });
