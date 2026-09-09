// CodeMind Academy — Phase 7 Parent Dashboard integration tests (offline, no DB).
//
// Exercises the REAL route handlers with an in-memory mock Prisma client
// (the real db/custom.db is never touched):
//   - GET  /api/parents/me/dashboard
//   - GET  /api/parents/me/analytics
//   - GET  /api/parents/me/weekly-report
//   - POST /api/parents/me/link-student
//   - GET  /api/courses/[slug]      (parent scope gate)
//   - GET  /api/lessons/[id]        (parent scope gate)
//   - GET  /api/quizzes/[id]        (parent scope gate)
//   - selectReportChild() from the monthly report component
//
// Fixture shape:
//   ParentA → ChildA + ChildB (course C1) ; ParentB → ChildC (course C2).
//   ChildA carries finished + UNFINISHED quiz attempts (23 finished so any
//   take-20 style cap would show), finished + unfinished mock exams, mixed
//   attendance (PRESENT/LATE/ABSENT), partial lesson progress and one
//   homework submission. ChildB is a blank slate (no attempts, no progress,
//   no subscription). ChildD starts unlinked (linking tests) and unenrolled
//   (null session-progress edge).
//
// Run: node tests/parent-dashboard-isolation.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase7-"));

// ---------------------------------------------------------------------------
// 1. Compile the files under test with tsc (type errors fail the suite)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/parent-access.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/school-type.ts",
  "src/lib/session-quiz.ts",
  "src/lib/progress.ts",
  "src/lib/parent-subscription.ts",
  "src/lib/registration.ts",
  "src/lib/api.ts",
  "src/app/api/parents/me/dashboard/route.ts",
  "src/app/api/parents/me/analytics/route.ts",
  "src/app/api/parents/me/weekly-report/route.ts",
  "src/app/api/parents/me/link-student/route.ts",
  "src/app/api/courses/[slug]/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/quizzes/[id]/route.ts",
  "src/components/parent/monthly-report.tsx",
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
  const emitted = path.join(OUT, "src/app/api/parents/me/dashboard/route.js");
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
    user: [], student: [], parent: [], parentStudentLink: [],
    course: [], group: [], part: [], unit: [], topic: [], lesson: [],
    quiz: [], question: [], homework: [], homeworkSubmission: [],
    quizAttempt: [], lessonProgress: [], attendance: [], liveSession: [],
    teacher: [], teacherNote: [], subscription: [], subscriptionPlan: [],
    examAttempt: [], mockExam: [],
  };
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const byId = (arr, id) => arr.find((r) => r.id === id) || null;
  let seq = 1;

  // Relation lookup: related row(s) for (table, key). Stored rows carry
  // scalars/FKs only; relations are resolved here on demand.
  function relOf(table, row, key) {
    const k = `${table}.${key}`;
    switch (k) {
      case "lesson.topic": return row.topicId ? byId(t.topic, row.topicId) : null;
      case "lesson.unit": return row.unitId ? byId(t.unit, row.unitId) : null;
      case "lesson.quizzes": return t.quiz.filter((q) => q.lessonId === row.id);
      case "lesson.homeworks": return t.homework.filter((h) => h.lessonId === row.id);
      case "topic.unit": return byId(t.unit, row.unitId);
      case "unit.part": return byId(t.part, row.partId);
      case "unit.lessons": return t.lesson.filter((l) => l.unitId === row.id);
      case "unit.topics": return t.topic.filter((x) => x.unitId === row.id);
      case "part.course": return byId(t.course, row.courseId);
      case "part.units": return t.unit.filter((u) => u.partId === row.id);
      case "topic.lessons": return t.lesson.filter((l) => l.topicId === row.id);
      case "course.parts": return t.part.filter((p) => p.courseId === row.id);
      case "course.groups": return t.group.filter((g) => g.courseId === row.id);
      case "quiz.lesson": return byId(t.lesson, row.lessonId);
      case "quiz.questions": return t.question.filter((q) => q.quizId === row.id);
      case "question.quiz": return row.quizId ? byId(t.quiz, row.quizId) : null;
      case "student.user": return byId(t.user, row.userId);
      case "student.group": return row.groupId ? byId(t.group, row.groupId) : null;
      case "student.subscription": return t.subscription.find((s) => s.studentId === row.id) || null;
      case "student.attendances": return t.attendance.filter((a) => a.studentId === row.id);
      case "student.quizAttempts": return t.quizAttempt.filter((a) => a.studentId === row.id);
      case "student.homeworkSubmits": return t.homeworkSubmission.filter((h) => h.studentId === row.id);
      case "student.lessonProgress": return t.lessonProgress.filter((l) => l.studentId === row.id);
      case "group.course": return byId(t.course, row.courseId);
      case "group.students": return t.student.filter((s) => s.groupId === row.id);
      case "parent.user": return byId(t.user, row.userId);
      case "parent.children": return t.parentStudentLink.filter((l) => l.parentId === row.id);
      case "parentStudentLink.student": return byId(t.student, row.studentId);
      case "parentStudentLink.parent": return byId(t.parent, row.parentId);
      case "attendance.session": return byId(t.liveSession, row.sessionId);
      case "quizAttempt.quiz": return byId(t.quiz, row.quizId);
      case "homeworkSubmission.homework": return byId(t.homework, row.homeworkId);
      case "homework.lesson": return byId(t.lesson, row.lessonId);
      case "teacherNote.teacher": return byId(t.teacher, row.teacherId);
      case "teacher.user": return byId(t.user, row.userId);
      case "liveSession.group": return byId(t.group, row.groupId);
      case "liveSession.teacher": return row.teacherId ? byId(t.teacher, row.teacherId) : null;
      case "liveSession.lesson": return row.lessonId ? byId(t.lesson, row.lessonId) : null;
      case "subscription.plan": return row.planId ? byId(t.subscriptionPlan, row.planId) : null;
      case "examAttempt.mockExam": return row.mockExamId ? byId(t.mockExam, row.mockExamId) : null;
      case "lessonProgress.lesson": return byId(t.lesson, row.lessonId);
      default: return undefined;
    }
  }
  const TABLE_OF = {
    "lesson.topic": "topic", "lesson.unit": "unit", "lesson.quizzes": "quiz",
    "lesson.homeworks": "homework", "topic.unit": "unit", "unit.part": "part",
    "unit.lessons": "lesson", "unit.topics": "topic", "part.course": "course",
    "part.units": "unit", "topic.lessons": "lesson", "course.parts": "part",
    "course.groups": "group", "quiz.lesson": "lesson", "quiz.questions": "question",
    "question.quiz": "quiz", "student.user": "user", "student.group": "group",
    "student.subscription": "subscription", "student.attendances": "attendance",
    "student.quizAttempts": "quizAttempt", "student.homeworkSubmits": "homeworkSubmission",
    "student.lessonProgress": "lessonProgress", "group.course": "course",
    "group.students": "student", "parent.user": "user", "parent.children": "parentStudentLink",
    "parentStudentLink.student": "student", "parentStudentLink.parent": "parent",
    "attendance.session": "liveSession", "quizAttempt.quiz": "quiz",
    "homeworkSubmission.homework": "homework", "homework.lesson": "lesson",
    "teacherNote.teacher": "teacher", "teacher.user": "user",
    "liveSession.group": "group", "liveSession.teacher": "teacher",
    "liveSession.lesson": "lesson", "subscription.plan": "subscriptionPlan",
    "examAttempt.mockExam": "mockExam", "lessonProgress.lesson": "lesson",
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
          if ("not" in v) return v.not === null ? row[k] !== null : row[k] !== v.not;
          let ok = true;
          if ("gte" in v) ok = ok && row[k] >= v.gte;
          if ("gt" in v) ok = ok && row[k] > v.gt;
          if ("lte" in v) ok = ok && row[k] <= v.lte;
          if ("lt" in v) ok = ok && row[k] < v.lt;
          if ("equals" in v) ok = ok && row[k] === v.equals;
          return ok;
        }
        // Relation filter (single relation or { some: ... } over a list).
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
        out[k] = v === true ? resolveRelation(table, row, k, true) : resolveRelation(table, row, k, v);
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
        let row = null;
        if (w.parentId_studentId) {
          row = t[table].find((r) => r.parentId === w.parentId_studentId.parentId && r.studentId === w.parentId_studentId.studentId);
        } else if (w.studentId_lessonId) {
          row = t[table].find((r) => r.studentId === w.studentId_lessonId.studentId && r.lessonId === w.studentId_lessonId.lessonId);
        } else {
          const keys = Object.keys(w);
          row = t[table].find((r) => keys.every((k) => r[k] === w[k]));
        }
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
      async upsert({ where, create, update }) {
        const keys = Object.keys(where || {});
        const row = t[table].find((r) => keys.every((k) => r[k] === where[k]));
        if (row) {
          trackWrite(table, "update");
          Object.assign(row, clone(update));
          return clone(row);
        }
        trackWrite(table, "create");
        const fresh = { id: `${table}-${seq++}`, ...clone(create) };
        t[table].push(fresh);
        return clone(fresh);
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
  // Session table for the cookie-session auth layer (not academic state).
  db.userSession = delegate("userSession");
  t.userSession = t.userSession || [];
  // `t.userSession` was created after delegates; rebind to the real array.
  db.userSession = makeSessionDelegate();
  function makeSessionDelegate() {
    const rows = [];
    t.userSession = rows;
    return {
      async findMany({ where } = {}) { return rows.filter((r) => matches(r, where, "userSession")).map(clone); },
      async findFirst({ where } = {}) { return clone(rows.filter((r) => matches(r, where, "userSession"))[0] || null); },
      async findUnique({ where } = {}) {
        const keys = Object.keys(where || {});
        return clone(rows.find((r) => keys.every((k) => r[k] === where[k])) || null);
      },
      async create({ data }) {
        const row = { id: `sess-${seq++}`, createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null, revokedReason: null, ...clone(data) };
        rows.push(row);
        return clone(row);
      },
      async update({ where, data }) {
        const keys = Object.keys(where || {});
        const row = rows.find((r) => keys.every((k) => r[k] === where[k]));
        if (row) Object.assign(row, clone(data));
        return clone(row || null);
      },
      async updateMany({ where, data }) {
        const hit = rows.filter((r) => matches(r, where, "userSession"));
        hit.forEach((r) => Object.assign(r, clone(data)));
        return { count: hit.length };
      },
      async deleteMany({ where } = {}) {
        const hit = rows.filter((r) => matches(r, where, "userSession"));
        hit.forEach((r) => rows.splice(rows.indexOf(r), 1));
        return { count: hit.length };
      },
    };
  }
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
  sonner: shim("sonner", "module.exports = { toast: Object.assign(() => {}, { error() {}, success() {} }) };"),
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
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const section = (t) => console.log(`\n${t}`);

const dashboardRoute = require(compiled("src/app/api/parents/me/dashboard/route.ts"));
const analyticsRoute = require(compiled("src/app/api/parents/me/analytics/route.ts"));
const weeklyRoute = require(compiled("src/app/api/parents/me/weekly-report/route.ts"));
const linkRoute = require(compiled("src/app/api/parents/me/link-student/route.ts"));
const courseRoute = require(compiled("src/app/api/courses/[slug]/route.ts"));
const lessonRoute = require(compiled("src/app/api/lessons/[id]/route.ts"));
const quizRoute = require(compiled("src/app/api/quizzes/[id]/route.ts"));
const { selectReportChild } = require(compiled("src/components/parent/monthly-report.tsx"));

const req = (body) => ({ json: async () => body });
const params = (o) => ({ params: Promise.resolve(o) });
async function bodyOf(res) { return { status: res.status, body: await res.json() }; }

// Session helpers: log in as a user by minting a real UserSession row +
// cookie (getCurrentUser resolves exactly as in production).
async function loginAs(userId) {
  const token = `test-token-${userId}-${Date.now()}`;
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

// ---------------------------------------------------------------------------
// 5. Fixture
// ---------------------------------------------------------------------------
const NOW = Date.now();
const D = (daysAgo) => new Date(NOW - daysAgo * 86400000);
const FUT = (daysAhead) => new Date(NOW + daysAhead * 86400000);

async function seed() {
  const db = global.__MOCK_DB__;
  const T = db.__tables;

  // Users
  const users = [
    { id: "u-pa", email: "pa@test.local", name: "Parent A", role: "PARENT", isActive: true, status: "ACTIVE", phone: "01147422177", avatarUrl: null },
    { id: "u-pb", email: "pb@test.local", name: "Parent B", role: "PARENT", isActive: true, status: "ACTIVE", phone: "01099998888", avatarUrl: null },
    { id: "u-pc", email: "pc@test.local", name: "Parent C", role: "PARENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sa", email: "sa@test.local", name: "Child A", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sb", email: "sb@test.local", name: "Child B", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sc", email: "sc@test.local", name: "Child C", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sd", email: "sd@test.local", name: "Child D", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-t1", email: "t1@test.local", name: "Ms Teacher", role: "TEACHER", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-ad", email: "ad@test.local", name: "Admin", role: "ADMIN", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
  ];
  T.user.push(...users);

  // Courses / groups
  T.course.push(
    { id: "c1", slug: "course-1", name: "Course One", nameAr: "الكورس الأول", description: "d", color: "#10b981", iconUrl: null, createdAt: D(90) },
    { id: "c2", slug: "course-2", name: "Course Two", nameAr: "الكورس الثاني", description: "d", color: "#f59e0b", iconUrl: null, createdAt: D(90) },
  );
  T.group.push(
    { id: "g1", name: "Group 1", courseId: "c1", teacherId: "t1", capacity: 20, schedule: "Sat", isActive: true, createdAt: D(80) },
    { id: "g2", name: "Group 2", courseId: "c2", teacherId: "t1", capacity: 20, schedule: "Sun", isActive: true, createdAt: D(80) },
  );
  T.teacher.push({ id: "t1", userId: "u-t1", bio: null, specialty: "Math" });

  // Curriculum C1: P1 > U1 > T1 > L1..L3 (published) + L4 (unpublished)
  T.part.push({ id: "p1", courseId: "c1", title: "Part 1", titleAr: "الجزء الأول", order: 1, description: null });
  T.unit.push({ id: "u1", partId: "p1", title: "Unit 1", titleAr: "الوحدة الأولى", order: 1, icon: null });
  T.topic.push({ id: "t1t", unitId: "u1", title: "Topic 1", titleAr: "الموضوع الأول", order: 1 });
  T.lesson.push(
    { id: "l1", trackScope: "SHARED", topicId: "t1t", unitId: null, officialCode: null, curriculumStatus: "LEGACY", title: "Lesson One", titleAr: "الدرس الأول", order: 1, description: "d1", summary: "s1", duration: 90, isLocked: false, isPublished: true, status: "PUBLISHED", videoUrl: "https://v/l1", pdfUrl: null },
    { id: "l2", trackScope: "SHARED", topicId: "t1t", unitId: null, officialCode: null, curriculumStatus: "LEGACY", title: "Lesson Two", titleAr: "الدرس الثاني", order: 2, description: "d2", summary: "s2", duration: 90, isLocked: true, isPublished: true, status: "PUBLISHED", videoUrl: null, pdfUrl: null },
    { id: "l3", trackScope: "SHARED", topicId: "t1t", unitId: null, officialCode: null, curriculumStatus: "LEGACY", title: "Lesson Three", titleAr: "الدرس الثالث", order: 3, description: "d3", summary: "s3", duration: 90, isLocked: true, isPublished: true, status: "PUBLISHED", videoUrl: "https://v/l3", pdfUrl: null },
    { id: "l4", trackScope: "SHARED", topicId: "t1t", unitId: null, officialCode: null, curriculumStatus: "LEGACY", title: "Draft Lesson", titleAr: "مسودة", order: 4, description: "", summary: "", duration: 90, isLocked: true, isPublished: false, status: "DRAFT", videoUrl: null, pdfUrl: null },
  );
  // Curriculum C2: single lesson, no video/quiz/homework
  T.part.push({ id: "p2", courseId: "c2", title: "Part 1", titleAr: "ج1", order: 1, description: null });
  T.unit.push({ id: "u2", partId: "p2", title: "Unit 1", titleAr: "و1", order: 1, icon: null });
  T.topic.push({ id: "t2t", unitId: "u2", title: "Topic 1", titleAr: "م1", order: 1 });
  T.lesson.push(
    { id: "l5", trackScope: "SHARED", topicId: "t2t", unitId: null, officialCode: null, curriculumStatus: "LEGACY", title: "C2 Lesson", titleAr: "درس الكورس الثاني", order: 1, description: "", summary: "", duration: 90, isLocked: false, isPublished: true, status: "PUBLISHED", videoUrl: null, pdfUrl: null },
  );

  // Quizzes + questions + homework
  T.quiz.push(
    { id: "q1", trackScope: "SHARED", lessonId: "l1", title: "Quiz One", titleAr: "اختبار واحد", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "q2", trackScope: "SHARED", lessonId: "l2", title: "Quiz Two", titleAr: "اختبار اثنين", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "q3", trackScope: "SHARED", lessonId: "l5", title: "Quiz C2", titleAr: "اختبار ك2", description: null, passMark: 60, timeLimit: null, order: 0 },
  );
  T.question.push({
    id: "qq1", quizId: "q1", type: "MCQ", prompt: "2+2?", promptAr: "٢+٢؟",
    options: JSON.stringify(["3", "4", "5"]), answer: "1", explanation: "basic",
    difficulty: "EASY", marks: 1, schoolType: null, createdAt: D(30),
  });
  T.homework.push(
    { id: "h1", trackScope: "SHARED", lessonId: "l1", title: "HW One", titleAr: "واجب واحد", instructions: "do", deadline: FUT(3), maxMarks: 20, createdAt: D(10) },
    { id: "h2", trackScope: "SHARED", lessonId: "l2", title: "HW Two", titleAr: "واجب اثنين", instructions: "do", deadline: FUT(5), maxMarks: 10, createdAt: D(10) },
  );

  // Students
  T.student.push(
    { id: "sa", userId: "u-sa", grade: "2nd Secondary", schoolName: "Nile", schoolType: "LANGUAGE", nationalId: "30101011234567", parentPhone: "01147422177", studentCode: "CM-AAAA11", groupId: "g1", batchId: null, enrolledAt: D(60) },
    { id: "sb", userId: "u-sb", grade: "2nd Secondary", schoolName: "Nile", schoolType: "LANGUAGE", nationalId: "30102021234567", parentPhone: "01147422177", studentCode: "CM-BBBB22", groupId: "g1", batchId: null, enrolledAt: D(60) },
    { id: "sc", userId: "u-sc", grade: "2nd Secondary", schoolName: "Nile", schoolType: "ARABIC", nationalId: "30103031234567", parentPhone: "01099998888", studentCode: "CM-CCCC33", groupId: "g2", batchId: null, enrolledAt: D(60) },
    { id: "sd", userId: "u-sd", grade: "2nd Secondary", schoolName: "Nile", schoolType: "LANGUAGE", nationalId: "30202021234567", parentPhone: "01147422177", studentCode: "CM-X7K9P2", groupId: null, batchId: null, enrolledAt: D(20) },
  );
  T.parent.push(
    { id: "pa", userId: "u-pa" },
    { id: "pb", userId: "u-pb" },
    { id: "pc", userId: "u-pc" },
  );
  T.parentStudentLink.push(
    { id: "link-a", parentId: "pa", studentId: "sa", relation: "parent", createdAt: D(50) },
    { id: "link-b", parentId: "pa", studentId: "sb", relation: "parent", createdAt: D(50) },
    { id: "link-c", parentId: "pb", studentId: "sc", relation: "parent", createdAt: D(50) },
  );

  // Quiz attempts — ChildA: 2 graded (80 pass / 40 fail) + 1 UNFINISHED + 21
  // extra finished 100s (23 finished total: any take-20 cap would corrupt the
  // average 97).
  T.quizAttempt.push(
    { id: "a1", quizId: "q1", studentId: "sa", score: 8, totalMarks: 10, percentage: 80, passed: true, startedAt: D(6), finishedAt: D(5), cameraStatus: "NOT_REQUESTED" },
    { id: "a2", quizId: "q1", studentId: "sa", score: 4, totalMarks: 10, percentage: 40, passed: false, startedAt: D(3), finishedAt: D(2), cameraStatus: "NOT_REQUESTED" },
    { id: "a3-open", quizId: "q2", studentId: "sa", score: 0, totalMarks: 10, percentage: 0, passed: false, startedAt: D(1), finishedAt: null, cameraStatus: "NOT_REQUESTED" },
  );
  for (let i = 0; i < 21; i++) {
    T.quizAttempt.push({
      id: `ax${i}`, quizId: "q1", studentId: "sa", score: 10, totalMarks: 10,
      percentage: 100, passed: true, startedAt: D(9 + i), finishedAt: D(8 + i),
      cameraStatus: "NOT_REQUESTED",
    });
  }
  T.quizAttempt.push(
    { id: "a4", quizId: "q3", studentId: "sc", score: 9, totalMarks: 10, percentage: 90, passed: true, startedAt: D(4), finishedAt: D(4), cameraStatus: "NOT_REQUESTED" },
  );

  // Mock exams — ChildA: 2 finished (70 pass / 50 fail) + 1 unfinished.
  T.mockExam.push({ id: "me1", title: "Monthly Mock", titleAr: "امتحان تجريبي شهري", description: null, schoolType: "LANGUAGE", courseId: "c1", questionCount: 10, durationMin: 30, passMark: 60, difficulty: "MIXED", selectionMode: "RANDOM", isPublished: true, createdAt: D(30), updatedAt: D(30) });
  T.examAttempt.push(
    { id: "m1", studentId: "sa", mockExamId: null, schoolType: "LANGUAGE", examType: "MOCK", questionCount: 10, durationMin: 15, score: 7, totalMarks: 10, percentage: 70, passed: true, answers: "[]", startedAt: D(4), finishedAt: D(3) },
    { id: "m2-open", studentId: "sa", mockExamId: null, schoolType: "LANGUAGE", examType: "MOCK", questionCount: 10, durationMin: 0, score: 0, totalMarks: 0, percentage: 0, passed: false, answers: "[]", startedAt: D(1), finishedAt: null },
    { id: "m3", studentId: "sa", mockExamId: "me1", schoolType: "LANGUAGE", examType: "MONTHLY", questionCount: 10, durationMin: 20, score: 5, totalMarks: 10, percentage: 50, passed: false, answers: "[]", startedAt: D(2), finishedAt: D(1) },
  );

  // Lesson progress — ChildA partial; ChildB/C blank.
  T.lessonProgress.push(
    { id: "lp1", studentId: "sa", lessonId: "l1", progress: 100, isCompleted: true, lastViewedAt: D(1), videoDurationSec: 600, videoWatchedSec: 600, videoPercent: 100, videoCompleted: true, videoCompletedAt: D(1), lastHeartbeatAt: D(1) },
    { id: "lp2", studentId: "sa", lessonId: "l2", progress: 50, isCompleted: false, lastViewedAt: D(6), videoDurationSec: 400, videoWatchedSec: 120, videoPercent: 30, videoCompleted: false, videoCompletedAt: null, lastHeartbeatAt: D(6) },
  );

  // Homework submissions — ChildA submitted H1 only.
  T.homeworkSubmission.push({
    id: "hs1", homeworkId: "h1", studentId: "sa", content: "done", fileUrl: null,
    submittedAt: D(1), grade: null, feedback: null, status: "SUBMITTED",
  });

  // Attendance — ChildA: PRESENT + LATE + ABSENT + PRESENT (3/4 = 75%).
  T.liveSession.push(
    { id: "s1", groupId: "g1", teacherId: "t1", lessonId: "l1", title: "Session 1", titleAr: "الحصة 1", startAt: D(2), duration: 90, meetingUrl: null, status: "COMPLETED" },
    { id: "s2", groupId: "g1", teacherId: "t1", lessonId: "l1", title: "Session 2", titleAr: "الحصة 2", startAt: D(9), duration: 90, meetingUrl: null, status: "COMPLETED" },
    { id: "s3", groupId: "g1", teacherId: "t1", lessonId: "l1", title: "Session 3", titleAr: "الحصة 3", startAt: D(40), duration: 90, meetingUrl: null, status: "COMPLETED" },
    { id: "s4", groupId: "g1", teacherId: "t1", lessonId: "l1", title: "Session 4", titleAr: "الحصة 4", startAt: D(70), duration: 90, meetingUrl: null, status: "COMPLETED" },
    { id: "sched1", groupId: "g1", teacherId: "t1", lessonId: "l2", title: "Next", titleAr: "القادمة", startAt: FUT(1), duration: 90, meetingUrl: "https://meet/x", status: "SCHEDULED" },
  );
  T.attendance.push(
    { id: "at1", studentId: "sa", sessionId: "s1", status: "PRESENT", note: null, createdAt: D(1) },
    { id: "at2", studentId: "sa", sessionId: "s2", status: "LATE", note: null, createdAt: D(9) },
    { id: "at3", studentId: "sa", sessionId: "s3", status: "ABSENT", note: null, createdAt: D(40) },
    { id: "at4", studentId: "sa", sessionId: "s4", status: "PRESENT", note: null, createdAt: D(70) },
  );

  T.teacherNote.push({ id: "tn1", teacherId: "t1", studentId: "sa", note: "Great progress", createdAt: D(2) });

  T.subscriptionPlan.push({ id: "plan1", name: "Monthly", nameAr: "شهري", price: 300, durationMonths: 1 });
  T.subscription.push({
    id: "sub1", studentId: "sa", planId: "plan1", status: "ACTIVE",
    startDate: D(10), endDate: new Date(NOW + 20 * 86400000),
  });
}

(async () => {
  await seed();
  const db = global.__MOCK_DB__;

  // =========================================================================
  section("A. Authentication / role gates");
  // =========================================================================
  logout();
  for (const [label, call] of [
    ["dashboard", () => dashboardRoute.GET({})],
    ["analytics", () => analyticsRoute.GET({})],
    ["weekly-report", () => weeklyRoute.GET()],
    ["link-student", () => linkRoute.POST(req({}))],
    ["course tree", () => courseRoute.GET({}, params({ slug: "course-1" }))],
    ["lesson", () => lessonRoute.GET({}, params({ id: "l1" }))],
    ["quiz", () => quizRoute.GET({}, params({ id: "q1" }))],
  ]) {
    const r = await bodyOf(await call());
    ok(r.status === 401, `unauthenticated ${label} → 401 (got ${r.status})`);
  }
  await loginAs("u-sa"); // STUDENT role
  {
    const r = await bodyOf(await dashboardRoute.GET({}));
    ok(r.status === 403, `student on parent dashboard → 403 (got ${r.status})`);
    const r2 = await bodyOf(await linkRoute.POST(req({})));
    ok(r2.status === 403, `student on link-student → 403 (got ${r2.status})`);
  }

  // =========================================================================
  section("B. Parent → Student isolation (before linking D)");
  // =========================================================================
  await loginAs("u-pa");
  const dashA = await bodyOf(await dashboardRoute.GET({}));
  ok(dashA.status === 200, "ParentA dashboard → 200");
  ok(
    Array.isArray(dashA.body.children) && dashA.body.children.length === 2,
    `ParentA sees exactly 2 linked children (got ${dashA.body.children?.length})`
  );
  const namesA = (dashA.body.children || []).map((c) => c.name).sort();
  ok(
    namesA.join("|") === "Child A|Child B",
    `ParentA children are A+B only (got ${namesA.join(",")})`
  );
  ok(
    !JSON.stringify(dashA.body).includes("Child C"),
    "ParentA payload contains no Child C data"
  );
  const childA = dashA.body.children.find((c) => c.id === "sa");
  const childB = dashA.body.children.find((c) => c.id === "sb");
  ok(!!childA && !!childB, "Child A and Child B payloads present");

  await loginAs("u-pb");
  const dashB = await bodyOf(await dashboardRoute.GET({}));
  ok(dashB.status === 200, "ParentB dashboard → 200");
  ok(
    dashB.body.children.length === 1 && dashB.body.children[0].id === "sc",
    "ParentB sees ONLY Child C"
  );
  ok(
    !JSON.stringify(dashB.body).includes("Child A"),
    "ParentB payload contains no Child A data"
  );

  await loginAs("u-pc"); // no links
  const dashC = await bodyOf(await dashboardRoute.GET({}));
  ok(
    dashC.status === 200 && dashC.body.children.length === 0,
    "Parent with no links → 200 with zero children"
  );
  const anaC = await bodyOf(await analyticsRoute.GET({}));
  ok(
    anaC.status === 200 && anaC.body.children.length === 0,
    "Parent with no links → empty analytics"
  );
  const weekC = await bodyOf(await weeklyRoute.GET());
  ok(
    weekC.status === 200 && weekC.body.reports.length === 0,
    "Parent with no links → empty weekly reports"
  );

  // =========================================================================
  section("C. Session Quiz results: finished-only, uncapped, server-graded");
  // =========================================================================
  await loginAs("u-pa");
  ok(childA.quizzes.attempts === 23, `ChildA quiz attempts = 23 (got ${childA.quizzes.attempts})`);
  ok(childA.quizzes.passed === 22, `ChildA passed = 22 (got ${childA.quizzes.passed})`);
  ok(childA.quizzes.failed === 1, `ChildA failed = 1 (got ${childA.quizzes.failed})`);
  ok(childA.quizzes.average === 97, `ChildA average = 97 over ALL finished (got ${childA.quizzes.average})`);
  ok(childA.quizzes.recent.length === 6, `recent list capped at 6 (got ${childA.quizzes.recent.length})`);
  ok(
    !childA.quizzes.recent.some((r) => r.percentage === 0 && r.id === "a3-open") &&
      childA.quizzes.recent.every((r) => !!r.finishedAt),
    "unfinished attempt excluded from recent + averages"
  );
  ok(
    childA.quizzes.recent[0].percentage === 40 && childA.quizzes.recent[1].percentage === 80,
    `recent ordered newest-first (got ${childA.quizzes.recent[0].percentage},${childA.quizzes.recent[1].percentage})`
  );
  const trend = childA.performanceTrend;
  ok(trend.length === 6, `performance trend has 6 points (got ${trend.length})`);
  ok(
    trend.every((p, i) => i === 0 || new Date(p.date) >= new Date(trend[i - 1].date)),
    "performance trend is chronological (oldest → newest)"
  );
  // Strong/weak topics derive from finished attempts only (grouped by TOPIC).
  const strongA = childA.strongTopics || [];
  ok(
    (childA.weakTopics || []).length === 0 &&
      strongA.length === 1 &&
      strongA[0].title === "الموضوع الأول" &&
      strongA[0].avgPct === 97,
    `weak topics empty, strong lists the topic at 97% (strong=${JSON.stringify(strongA)})`
  );

  // =========================================================================
  section("D. Blank-slate child (no attempts, no progress, no subscription)");
  // =========================================================================
  ok(childB.quizzes.attempts === 0 && childB.quizzes.average === 0, "ChildB quizzes zeroed");
  ok((childB.performanceTrend || []).length === 0, "ChildB trend empty");
  ok(childB.subscription === null, "ChildB subscription === null (kept contract)");
  ok(
    childB.courseProgress.completed === 0 && childB.courseProgress.total === 3 && childB.courseProgress.pct === 0,
    `ChildB course progress 0/3 (got ${JSON.stringify(childB.courseProgress)})`
  );
  ok(childB.nextSession !== null, "ChildB still resolves the upcoming live session");

  // =========================================================================
  section("E. Attendance counts LATE as attended (student definition)");
  // =========================================================================
  ok(
    childA.attendance.present === 3 && childA.attendance.total === 4 && childA.attendance.pct === 75,
    `dashboard attendance 3/4 = 75% (got ${JSON.stringify({ p: childA.attendance.present, t: childA.attendance.total, pct: childA.attendance.pct })})`
  );
  const byMonthTotals = childA.attendance.byMonth.reduce(
    (acc, b) => ({ present: acc.present + b.present, total: acc.total + b.total }),
    { present: 0, total: 0 }
  );
  ok(
    byMonthTotals.present === 3 && byMonthTotals.total === 4,
    `monthly buckets sum to 3/4 (got ${byMonthTotals.present}/${byMonthTotals.total})`
  );

  // =========================================================================
  section("F. Parent analytics: finished-only, ordered, course-based");
  // =========================================================================
  const anaA = await bodyOf(await analyticsRoute.GET({}));
  ok(anaA.status === 200, "analytics → 200");
  const anaChildA = anaA.body.children.find((c) => c.studentId === "sa");
  const anaChildB = anaA.body.children.find((c) => c.studentId === "sb");
  ok(anaA.body.children.length === 2, "analytics covers the 2 linked children only");
  ok(
    anaChildA.totalQuizzes === 23 && anaChildA.avgQuizPct === 97,
    `analytics quiz totals finished-only: 23 @ 97% (got ${anaChildA.totalQuizzes} @ ${anaChildA.avgQuizPct}%)`
  );
  ok(anaChildA.quizTrend.length === 10, `trend = last 10 (got ${anaChildA.quizTrend.length})`);
  ok(
    anaChildA.quizTrend.every((p, i) => i === 0 || new Date(p.date) >= new Date(anaChildA.quizTrend[i - 1].date)),
    "analytics trend is chronological"
  );
  ok(
    anaChildA.quizTrend.every((p) => p.percentage > 0),
    "analytics trend has no ungraded (0%) open attempt"
  );
  ok(anaChildA.attendancePct === 75, `analytics attendance 75% incl. LATE (got ${anaChildA.attendancePct})`);
  ok(
    anaChildA.completedLessons === 1 && anaChildA.totalLessons === 3 && anaChildA.completionPct === 33,
    `analytics completion 1/3 = 33% course-based (got ${anaChildA.completedLessons}/${anaChildA.totalLessons} = ${anaChildA.completionPct}%)`
  );
  ok(
    anaChildB.totalQuizzes === 0 && anaChildB.completionPct === 0 && anaChildB.quizTrend.length === 0,
    "blank child analytics zeroed"
  );
  ok(
    (anaChildA.weakTopics || []).length === 0 && (anaChildA.strongTopics || []).length === 1,
    "analytics strong/weak from finished attempts only"
  );

  // =========================================================================
  section("G. Weekly report: finished-only, LATE-aware, course-based");
  // =========================================================================
  const weekA = await bodyOf(await weeklyRoute.GET());
  ok(weekA.status === 200, "weekly-report → 200");
  const repA = weekA.body.reports.find((r) => r.studentId === "sa");
  ok(weekA.body.reports.length === 2, "weekly covers the 2 linked children only");
  ok(repA.summary.quizzesTaken === 2, `weekly quizzes taken = 2 (got ${repA.summary.quizzesTaken})`);
  ok(repA.summary.avgQuizScore === 60, `weekly avg quiz = 60 (got ${repA.summary.avgQuizScore})`);
  ok(repA.summary.bestQuizScore === 80, `weekly best quiz = 80 (got ${repA.summary.bestQuizScore})`);
  ok(repA.summary.homeworkSubmitted === 1, `weekly homework = 1 (got ${repA.summary.homeworkSubmitted})`);
  ok(repA.summary.lessonsViewed === 2, `weekly lessons viewed = 2 (got ${repA.summary.lessonsViewed})`);
  ok(
    repA.summary.attendanceSessions === 1 && repA.summary.attendancePct === 100,
    `weekly attendance 1/1 = 100% (got ${repA.summary.attendanceSessions}/${repA.summary.attendancePct}%)`
  );
  ok(repA.summary.completionPct === 33, `weekly completion 33% course-based (got ${repA.summary.completionPct})`);
  ok(repA.summary.activeDays === 4, `weekly active days = 4 (got ${repA.summary.activeDays})`);
  ok(
    repA.recentQuizzes.length === 2 && repA.recentQuizzes.every((q) => q.percentage > 0),
    "weekly recent quizzes are the 2 finished ones"
  );

  // =========================================================================
  section("H. Mock exams: finished-only and separate from session quizzes");
  // =========================================================================
  ok(childA.mockExams.attempts === 2, `mock attempts = 2 (got ${childA.mockExams.attempts})`);
  ok(childA.mockExams.average === 60, `mock average = 60 (got ${childA.mockExams.average})`);
  ok(childA.mockExams.best === 70, `mock best = 70 (got ${childA.mockExams.best})`);
  ok(
    childA.mockExams.passed === 1 && childA.mockExams.failed === 1,
    `mock passed/failed = 1/1 (got ${childA.mockExams.passed}/${childA.mockExams.failed})`
  );
  ok(
    childA.mockExams.recent[0].percentage === 50 && childA.mockExams.recent[1].percentage === 70,
    "mock recent ordered newest-first, unfinished excluded"
  );
  ok(
    childA.mockExams.recent[0].mockExamTitle === "امتحان تجريبي شهري",
    `mock keeps its exam title (got "${childA.mockExams.recent[0].mockExamTitle}")`
  );
  ok(
    childA.mockExams.recent[1].mockExamTitle === "Practice Exam",
    `ad-hoc exam falls back to "Practice Exam" (got "${childA.mockExams.recent[1].mockExamTitle}")`
  );
  ok(
    childA.quizzes.average === 97 && childA.mockExams.average === 60,
    "session-quiz and mock-exam averages do not move each other"
  );
  ok(childB.mockExams.attempts === 0 && childB.mockExams.best === null, "blank child mock block zeroed (best null)");

  // =========================================================================
  section("I. Session unlock state comes from the Phase 4 engine");
  // =========================================================================
  ok(
    childA.courseProgress.completed === 1 && childA.courseProgress.total === 3 && childA.courseProgress.pct === 50,
    `course progress 1/3, pct 50 (got ${JSON.stringify(childA.courseProgress)})`
  );
  ok(
    childA.sessionProgress.total === 3 &&
      childA.sessionProgress.completed === 1 &&
      childA.sessionProgress.unlocked === 2 &&
      childA.sessionProgress.locked === 1,
    `ChildA sessions: total 3, completed 1, unlocked 2, locked 1 (got ${JSON.stringify(childA.sessionProgress)})`
  );
  ok(
    childA.sessionProgress.currentLessonId === "l2" &&
      childA.sessionProgress.currentLessonTitle === "الدرس الثاني",
    `ChildA current session is L2 (got ${childA.sessionProgress.currentLessonId} / "${childA.sessionProgress.currentLessonTitle}")`
  );
  ok(
    childB.sessionProgress.total === 3 &&
      childB.sessionProgress.completed === 0 &&
      childB.sessionProgress.unlocked === 1 &&
      childB.sessionProgress.locked === 2 &&
      childB.sessionProgress.currentLessonId === "l1",
    `blank child: nothing completed, L1 current, rest locked (got ${JSON.stringify(childB.sessionProgress)})`
  );

  // =========================================================================
  section("J. Homework uses the real maxMarks");
  // =========================================================================
  const hwRecent = childA.homework.recent;
  ok(
    childA.homework.total === 2 && childA.homework.submitted === 1 && childA.homework.pending === 1 &&
      childA.homework.completionPct === 50,
    `homework 1/2 submitted = 50% (got ${JSON.stringify({ t: childA.homework.total, s: childA.homework.submitted, pct: childA.homework.completionPct })})`
  );
  ok(
    hwRecent[0].maxGrade === 20 && hwRecent[1].maxGrade === 10,
    `maxGrade honors maxMarks 20/10 (got ${hwRecent[0].maxGrade}/${hwRecent[1].maxGrade})`
  );

  // =========================================================================
  section("K. Video progress (shared service numbers)");
  // =========================================================================
  ok(childA.videoProgress.totalVideos === 2, `2 required videos (got ${childA.videoProgress.totalVideos})`);
  ok(childA.videoProgress.completedVideos === 1, `1 completed (got ${childA.videoProgress.completedVideos})`);
  ok(childA.videoProgress.averagePercent === 50, `average 50% (got ${childA.videoProgress.averagePercent})`);
  ok(childA.videoProgress.completionPercent === 50, `completion 50% (got ${childA.videoProgress.completionPercent})`);
  ok(childA.videoProgress.totalWatchedMinutes === 10, `10 watched minutes (got ${childA.videoProgress.totalWatchedMinutes})`);

  // =========================================================================
  section("L. Linking: verified, idempotent, enumeration-safe");
  // =========================================================================
  const wrongCode = await bodyOf(
    await linkRoute.POST(req({ studentNationalId: "30202021234567", parentPhone: "01147422177", studentCode: "CM-ZZZZ99" }))
  );
  const wrongPhone = await bodyOf(
    await linkRoute.POST(req({ studentNationalId: "30202021234567", parentPhone: "01000000000", studentCode: "CM-X7K9P2" }))
  );
  ok(wrongCode.status === 404, `unknown code → 404 (got ${wrongCode.status})`);
  ok(wrongPhone.status === 404, `wrong phone → 404 (got ${wrongPhone.status})`);
  ok(
    wrongCode.body.error === wrongPhone.body.error,
    `both failures return the IDENTICAL message (no existence oracle): "${wrongCode.body.error}"`
  );
  const badFormat = await bodyOf(
    await linkRoute.POST(req({ studentNationalId: "123", parentPhone: "01147422177", studentCode: "CM-X7K9P2" }))
  );
  ok(badFormat.status === 400, `malformed national id → 400 (got ${badFormat.status})`);
  const emailOnly = await bodyOf(await linkRoute.POST(req({ studentEmail: "sd@test.local" })));
  ok(emailOnly.status === 400, `legacy email-only linking stays rejected (got ${emailOnly.status})`);
  const missing = await bodyOf(await linkRoute.POST(req({})));
  ok(missing.status === 400, `empty body → 400 (got ${missing.status})`);

  const linkOk = await bodyOf(
    await linkRoute.POST(req({ studentNationalId: "30202021234567", parentPhone: "01147422177", studentCode: "CM-X7K9P2" }))
  );
  ok(linkOk.status === 200, `verified link → 200 (got ${linkOk.status})`);
  ok(linkOk.body.linked?.id === "sd", "response names the linked student");
  ok(linkOk.body.children.length === 3, `ParentA now has 3 children (got ${linkOk.body.children.length})`);
  const pairLinks = db.__tables.parentStudentLink.filter((l) => l.parentId === "pa" && l.studentId === "sd");
  ok(pairLinks.length === 1, "exactly one link row for the pair");
  const linkAgain = await bodyOf(
    await linkRoute.POST(req({ studentNationalId: "30202021234567", parentPhone: "01147422177", studentCode: "CM-X7K9P2" }))
  );
  const pairLinks2 = db.__tables.parentStudentLink.filter((l) => l.parentId === "pa" && l.studentId === "sd");
  ok(linkAgain.status === 200 && pairLinks2.length === 1, "re-linking is idempotent (still one row)");

  // Newly linked, unenrolled child: zeroed aggregates + null session state.
  const dashA2 = await bodyOf(await dashboardRoute.GET({}));
  const childD = dashA2.body.children.find((c) => c.id === "sd");
  ok(!!childD, "linked Child D appears in the dashboard");
  ok(
    childD.sessionProgress === null,
    "unenrolled child → sessionProgress null (no course, no crash)"
  );
  ok(
    childD.courseProgress.total === 0 && childD.quizzes.attempts === 0 && childD.subscription === null,
    "unenrolled child aggregates zeroed"
  );

  // =========================================================================
  section("M. Parent content scope (course / lesson / quiz gates)");
  // =========================================================================
  await loginAs("u-pa");
  const c1a = await bodyOf(await courseRoute.GET({}, params({ slug: "course-1" })));
  ok(c1a.status === 200, `ParentA opens child's course → 200 (got ${c1a.status})`);
  const c2a = await bodyOf(await courseRoute.GET({}, params({ slug: "course-2" })));
  ok(
    c2a.status === 403 && c2a.body.code === "NOT_ENROLLED",
    `ParentA opens foreign course → 403 NOT_ENROLLED (got ${c2a.status}/${c2a.body.code})`
  );
  const l1a = await bodyOf(await lessonRoute.GET({}, params({ id: "l1" })));
  ok(l1a.status === 200, `ParentA opens in-scope lesson → 200 (got ${l1a.status})`);
  const l5a = await bodyOf(await lessonRoute.GET({}, params({ id: "l5" })));
  ok(l5a.status === 404, `ParentA opens foreign lesson → 404, existence hidden (got ${l5a.status})`);
  const q1a = await bodyOf(await quizRoute.GET({}, params({ id: "q1" })));
  ok(q1a.status === 200, `ParentA opens in-scope quiz → 200 (got ${q1a.status})`);
  ok(
    q1a.body.questions[0].answer === "1",
    "in-scope parent keeps the documented Phase 1 answer visibility"
  );
  const q3a = await bodyOf(await quizRoute.GET({}, params({ id: "q3" })));
  ok(q3a.status === 404, `ParentA opens foreign quiz → 404 (got ${q3a.status})`);

  await loginAs("u-pb");
  const c2b = await bodyOf(await courseRoute.GET({}, params({ slug: "course-2" })));
  ok(c2b.status === 200, `ParentB opens child's course → 200 (got ${c2b.status})`);
  const c1b = await bodyOf(await courseRoute.GET({}, params({ slug: "course-1" })));
  ok(c1b.status === 403, `ParentB opens foreign course → 403 (got ${c1b.status})`);

  await loginAs("u-pc"); // linked children exist now? No — PC has zero links.
  const c1c = await bodyOf(await courseRoute.GET({}, params({ slug: "course-1" })));
  ok(c1c.status === 403, `parent with no links opens any course → 403 (got ${c1c.status})`);

  // Staff previews and the student gate are unchanged.
  await loginAs("u-t1");
  const c2t = await bodyOf(await courseRoute.GET({}, params({ slug: "course-2" })));
  const l5t = await bodyOf(await lessonRoute.GET({}, params({ id: "l5" })));
  ok(c2t.status === 200 && l5t.status === 200, "teacher preview unchanged (200)");
  await loginAs("u-ad");
  const q3ad = await bodyOf(await quizRoute.GET({}, params({ id: "q3" })));
  ok(q3ad.status === 200, "admin quiz preview unchanged (200)");
  await loginAs("u-sa");
  const c2s = await bodyOf(await courseRoute.GET({}, params({ slug: "course-2" })));
  const c1s = await bodyOf(await courseRoute.GET({}, params({ slug: "course-1" })));
  ok(c2s.status === 403 && c1s.status === 200, "student enrollment gate unchanged (403/200)");

  // =========================================================================
  section("N. Parent GET/reporting endpoints are read-only");
  // =========================================================================
  await loginAs("u-pa");
  global.__WRITES__ = [];
  await dashboardRoute.GET({});
  await analyticsRoute.GET({});
  await weeklyRoute.GET({});
  const academicWrites = global.__WRITES__.filter((w) => w.table !== "userSession");
  ok(
    academicWrites.length === 0,
    `dashboard+analytics+weekly perform zero academic writes (got ${academicWrites.length})`
  );

  // =========================================================================
  section("O. Monthly report child selection (pure rule)");
  // =========================================================================
  const kids = [{ id: "sa" }, { id: "sb" }, { id: "sd" }];
  ok(selectReportChild(kids, "sb")?.id === "sb", "explicit selection wins");
  ok(selectReportChild(kids, "nope")?.id === "sa", "unknown id falls back to first child");
  ok(selectReportChild(kids, undefined)?.id === "sa", "omitted id falls back to first child");
  ok(selectReportChild(kids, null)?.id === "sa", "null id falls back to first child");
  ok(selectReportChild([], "sa") === null, "empty list yields null");
  ok(selectReportChild(null, "sa") === null, "null list yields null");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("UNEXPECTED ERROR:", e);
  process.exit(1);
});
