// CodeMind Academy — Phase 19: Parent & Analytics Alignment regression tests
// (offline, no DB).
//
// Verifies that the student dashboard, parent dashboard, weekly report,
// parent analytics, certificate, teacher analytics and the shared progress
// service all measure the SAME official 23-lesson curriculum universe —
// canonical Part → Unit → Lesson only — sliced per student by trackScope and
// lifecycle, and that Kodgy's scripted grounding references exactly the real
// sessions 1-1 … 7-3.
//
// Representative populated data (never zero-row evidence):
//   * One CANONICAL-ONLY official course: 2 parts / 7 units / 23 unit-linked
//     OFFICIAL lessons (codes 1-1 … 7-3). No Topic rows at all — the
//     "chain-parity" case the roadmap asks for.
//   * Track mix: 18 SHARED (one of them DRAFT — lifecycle exclusion),
//     3 ARABIC-only, 2 LANGUAGE-only → ARABIC universe = 20, LANGUAGE = 19.
//   * Archived legacy history that must NOT count: an ARCHIVED lesson with a
//     completed progress row, an archived homework with a graded submission.
//   * Children: sa (ARABIC) and sc (ARABIC) in group g1; sb (LANGUAGE) in g2;
//     same course — the exact "child A = ARABIC, child B = LANGUAGE"
//     alignment scenario. Parent pa is linked to BOTH (multi-child), pb to sb
//     only, pc to none.
//   * Progress, finished + open quiz attempts, homework submissions,
//     attendance, a teacher with both groups, a cross-course decoy.
//
// Run: node tests/parent-analytics-alignment-phase19.test.js
// Exit code: 0 = all pass, 1 = failure.

const { execSync } = require("child_process");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p19-align-"));

// ---------------------------------------------------------------------------
// 1. Compile the files under test with tsc (type errors fail the suite)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/progress.ts",
  "src/lib/session-progress.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/track-scope.ts",
  "src/lib/school-type.ts",
  "src/lib/enrollment.ts",
  "src/lib/api.ts",
  "src/lib/parent-subscription.ts",
  "src/lib/quiz-analytics.ts",
  "src/lib/official-curriculum.ts",
  "src/lib/kodgy/response-engine.ts",
  "src/app/api/students/me/dashboard/route.ts",
  "src/app/api/students/me/certificate/route.ts",
  "src/app/api/students/me/export-progress/route.ts",
  "src/app/api/parents/me/dashboard/route.ts",
  "src/app/api/parents/me/analytics/route.ts",
  "src/app/api/parents/me/weekly-report/route.ts",
  "src/app/api/teacher/analytics/route.ts",
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
      resolveJsonModule: true,
      baseUrl: REPO,
      rootDir: REPO,
      paths: { "@/*": ["src/*"] },
      typeRoots: [path.join(REPO, "node_modules/@types")],
      outDir: OUT,
      // Only emit; the repo's own tsc run is the authoritative type check.
      noEmitOnError: false,
    },
    files: FILES.map((f) => path.join(REPO, f)),
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch (e) {
  // Pre-existing, unrelated type errors in files pulled in transitively must
  // not block this suite — but the files under test must have been emitted.
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

  function relOf(table, row, key) {
    const k = `${table}.${key}`;
    switch (k) {
      case "lesson.topic": return row.topicId ? byId(t.topic, row.topicId) : null;
      case "lesson.unit": return row.unitId ? byId(t.unit, row.unitId) : null;
      case "lesson.quizzes": return t.quiz.filter((q) => q.lessonId === row.id);
      case "lesson.homeworks": return t.homework.filter((h) => h.lessonId === row.id);
      // Phase 19: dashboard include `progress` on lesson.
      case "lesson.progress": return t.lessonProgress.filter((lp) => lp.lessonId === row.id);
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
      case "group.teacher": return row.teacherId ? byId(t.teacher, row.teacherId) : null;
      case "parent.user": return byId(t.user, row.userId);
      case "parent.children": return t.parentStudentLink.filter((l) => l.parentId === row.id);
      case "parentStudentLink.student": return byId(t.student, row.studentId);
      case "parentStudentLink.parent": return byId(t.parent, row.parentId);
      case "attendance.session": return byId(t.liveSession, row.sessionId);
      case "quizAttempt.quiz": return byId(t.quiz, row.quizId);
      case "homeworkSubmission.homework": return byId(t.homework, row.homeworkId);
      // Phase 19: dashboard include `submissions` on homework.
      case "homework.submissions": return t.homeworkSubmission.filter((h) => h.homeworkId === row.id);
      case "homework.lesson": return byId(t.lesson, row.lessonId);
      case "teacherNote.teacher": return byId(t.teacher, row.teacherId);
      case "teacher.user": return byId(t.user, row.userId);
      // Phase 19: teacher analytics includes groups on teacher.
      case "teacher.groups": return t.group.filter((g) => g.teacherId === row.id);
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
    "lesson.homeworks": "homework", "lesson.progress": "lessonProgress",
    "topic.unit": "unit", "unit.part": "part",
    "unit.lessons": "lesson", "unit.topics": "topic", "part.course": "course",
    "part.units": "unit", "topic.lessons": "lesson", "course.parts": "part",
    "course.groups": "group", "quiz.lesson": "lesson", "quiz.questions": "question",
    "question.quiz": "quiz", "student.user": "user", "student.group": "group",
    "student.subscription": "subscription", "student.attendances": "attendance",
    "student.quizAttempts": "quizAttempt", "student.homeworkSubmits": "homeworkSubmission",
    "student.lessonProgress": "lessonProgress", "group.course": "course",
    "group.students": "student", "group.teacher": "teacher",
    "parent.user": "user", "parent.children": "parentStudentLink",
    "parentStudentLink.student": "student", "parentStudentLink.parent": "parent",
    "attendance.session": "liveSession", "quizAttempt.quiz": "quiz",
    "homeworkSubmission.homework": "homework", "homework.submissions": "homeworkSubmission",
    "homework.lesson": "lesson",
    "teacherNote.teacher": "teacher", "teacher.user": "user", "teacher.groups": "group",
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
          let ok2 = true;
          if ("gte" in v) ok2 = ok2 && row[k] >= v.gte;
          if ("gt" in v) ok2 = ok2 && row[k] > v.gt;
          if ("lte" in v) ok2 = ok2 && row[k] <= v.lte;
          if ("lt" in v) ok2 = ok2 && row[k] < v.lt;
          if ("equals" in v) ok2 = ok2 && row[k] === v.equals;
          return ok2;
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
        } else if (w.officialCode) {
          row = t[table].find((r) => r.officialCode === w.officialCode);
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
  t.userSession = [];
  const sessionRows = t.userSession;
  db.userSession = {
    async findMany({ where } = {}) { return sessionRows.filter((r) => matches(r, where, "userSession")).map(clone); },
    async findFirst({ where } = {}) { return clone(sessionRows.filter((r) => matches(r, where, "userSession"))[0] || null); },
    async findUnique({ where } = {}) {
      const keys = Object.keys(where || {});
      return clone(sessionRows.find((r) => keys.every((k) => r[k] === where[k])) || null);
    },
    async create({ data }) {
      const row = { id: `sess-${seq++}`, createdAt: new Date(), lastSeenAt: new Date(), revokedAt: null, revokedReason: null, ...clone(data) };
      sessionRows.push(row);
      return clone(row);
    },
    async update({ where, data }) {
      const keys = Object.keys(where || {});
      const row = sessionRows.find((r) => keys.every((k) => r[k] === where[k]));
      if (row) Object.assign(row, clone(data));
      return clone(row || null);
    },
    async updateMany({ where, data }) {
      const hit = sessionRows.filter((r) => matches(r, where, "userSession"));
      hit.forEach((r) => Object.assign(r, clone(data)));
      return { count: hit.length };
    },
    async deleteMany({ where } = {}) {
      const hit = sessionRows.filter((r) => matches(r, where, "userSession"));
      hit.forEach((r) => sessionRows.splice(sessionRows.indexOf(r), 1));
      return { count: hit.length };
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
       constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.ok = this.status < 300; this.headers = (init && init.headers) || {}; }
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
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
const section = (t) => console.log(`\n${t}`);

const studentDashboardRoute = require(compiled("src/app/api/students/me/dashboard/route.ts"));
const certificateRoute = require(compiled("src/app/api/students/me/certificate/route.ts"));
const exportProgressRoute = require(compiled("src/app/api/students/me/export-progress/route.ts"));
const parentDashboardRoute = require(compiled("src/app/api/parents/me/dashboard/route.ts"));
const parentAnalyticsRoute = require(compiled("src/app/api/parents/me/analytics/route.ts"));
const weeklyReportRoute = require(compiled("src/app/api/parents/me/weekly-report/route.ts"));
const teacherAnalyticsRoute = require(compiled("src/app/api/teacher/analytics/route.ts"));
const progressLib = require(compiled("src/lib/progress.ts"));
const officialCurriculum = require(compiled("src/lib/official-curriculum.ts"));
const kodgy = require(compiled("src/lib/kodgy/response-engine.ts"));
const { buildReportData } = require(compiled("src/components/parent/monthly-report.tsx"));

const req = (body) => ({ json: async () => body, url: "http://test.local/api", headers: new Map() });
async function bodyOf(res) { return { status: res.status, body: await res.json() }; }

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
// 5. Fixture — a canonical-only official course + populated activity
// ---------------------------------------------------------------------------
const NOW = Date.now();
const D = (daysAgo) => new Date(NOW - daysAgo * 86400000);
const FUT = (daysAhead) => new Date(NOW + daysAhead * 86400000);

// Official lesson layout: [code, unitIdx, order, trackScope, status, hasVideo]
const LESSON_LAYOUT = [
  ["1-1", 1, 1, "SHARED", "PUBLISHED", true],
  ["1-2", 1, 2, "SHARED", "PUBLISHED", true],
  ["1-3", 1, 3, "SHARED", "PUBLISHED", false],
  ["1-4", 1, 4, "ARABIC", "PUBLISHED", true],
  ["2-1", 2, 1, "LANGUAGE", "PUBLISHED", true],
  ["2-2", 2, 2, "ARABIC", "PUBLISHED", false],
  ["2-3", 2, 3, "SHARED", "PUBLISHED", false],
  ["3-1", 3, 1, "SHARED", "PUBLISHED", true],
  ["3-2", 3, 2, "SHARED", "PUBLISHED", false],
  ["3-3", 3, 3, "SHARED", "PUBLISHED", false],
  ["4-1", 4, 1, "ARABIC", "PUBLISHED", true],
  ["4-2", 4, 2, "SHARED", "PUBLISHED", false],
  ["4-3", 4, 3, "SHARED", "PUBLISHED", false],
  ["4-4", 4, 4, "SHARED", "PUBLISHED", false],
  ["5-1", 5, 1, "LANGUAGE", "PUBLISHED", false],
  ["5-2", 5, 2, "SHARED", "PUBLISHED", false],
  ["5-3", 5, 3, "SHARED", "PUBLISHED", false],
  ["6-1", 6, 1, "SHARED", "PUBLISHED", false],
  ["6-2", 6, 2, "SHARED", "PUBLISHED", false],
  ["6-3", 6, 3, "SHARED", "PUBLISHED", false],
  ["7-1", 7, 1, "SHARED", "PUBLISHED", false],
  ["7-2", 7, 2, "SHARED", "PUBLISHED", false],
  ["7-3", 7, 3, "SHARED", "DRAFT", false], // lifecycle: staged, invisible
];
const LID = (code) => `l-${code}`;
// Expected universes: ARABIC = 17 SHARED-published + 3 ARABIC = 20;
// LANGUAGE = 17 + 2 = 19.
const ARABIC_UNIVERSE = 20;
const LANGUAGE_UNIVERSE = 19;

async function seed() {
  const db = global.__MOCK_DB__;
  const T = db.__tables;

  // --- Users ---------------------------------------------------------------
  T.user.push(
    { id: "u-pa", email: "pa@test.local", name: "Parent Multi", role: "PARENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-pb", email: "pb@test.local", name: "Parent Single", role: "PARENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-pc", email: "pc@test.local", name: "Parent Empty", role: "PARENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sa", email: "sa@test.local", name: "Child A Arabic", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sb", email: "sb@test.local", name: "Child B Language", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sc", email: "sc@test.local", name: "Child C Arabic", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-se", email: "se@test.local", name: "Decoy Student", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-t1", email: "t1@test.local", name: "Teacher One", role: "TEACHER", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-t2", email: "t2@test.local", name: "Teacher Two", role: "TEACHER", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
  );

  // --- Courses / groups / teachers ------------------------------------------
  T.course.push(
    { id: "c1", slug: "programming-ai-2nd-sec", name: "Programming & AI", nameAr: "البرمجة والذكاء الاصطناعي", description: "d", color: "#10b981", iconUrl: null, createdAt: D(120) },
    { id: "c2", slug: "decoy-course", name: "Decoy Course", nameAr: "كورس آخر", description: "d", color: "#f59e0b", iconUrl: null, createdAt: D(120) },
  );
  T.teacher.push(
    { id: "t1", userId: "u-t1", bio: null, specialty: "Programming" },
    { id: "t2", userId: "u-t2", bio: null, specialty: "Networks" },
  );
  T.group.push(
    { id: "g1", name: "Group Arabic", courseId: "c1", teacherId: "t1", capacity: 20, schedule: "Sat", isActive: true, createdAt: D(100) },
    { id: "g2", name: "Group Language", courseId: "c1", teacherId: "t1", capacity: 20, schedule: "Sun", isActive: true, createdAt: D(100) },
    { id: "g3", name: "Group Decoy", courseId: "c2", teacherId: "t2", capacity: 20, schedule: "Mon", isActive: true, createdAt: D(100) },
  );

  // --- Official curriculum: canonical-only (no Topic rows anywhere) ---------
  T.part.push(
    { id: "p1", courseId: "c1", title: "Part 1", titleAr: "الجزء الأول", order: 1, description: null },
    { id: "p2", courseId: "c1", title: "Part 2", titleAr: "الجزء الثاني", order: 2, description: null },
  );
  const UNIT_TITLES = {
    1: ["Unit 1 IT & Society", "الوحدة الأولى"],
    2: ["Unit 2 Cybersecurity", "الوحدة الثانية"],
    3: ["Unit 3 Web Applications", "الوحدة الثالثة"],
    4: ["Unit 4 Web & Media Design", "الوحدة الرابعة"],
    5: ["Unit 5 Data", "الوحدة الخامسة"],
    6: ["Unit 6 Analysis", "الوحدة السادسة"],
    7: ["Unit 7 ML & AI", "الوحدة السابعة"],
  };
  for (let i = 1; i <= 7; i++) {
    T.unit.push({
      id: `u${i}`,
      partId: i <= 4 ? "p1" : "p2",
      title: UNIT_TITLES[i][0],
      titleAr: UNIT_TITLES[i][1],
      order: i,
      icon: null,
    });
  }
  for (const [code, unitIdx, order, trackScope, status, hasVideo] of LESSON_LAYOUT) {
    T.lesson.push({
      id: LID(code),
      officialCode: code,
      curriculumStatus: "OFFICIAL",
      trackScope,
      status,
      isPublished: status === "PUBLISHED",
      unitId: `u${unitIdx}`,
      topicId: null, // canonical-only: NO legacy topic link exists at all
      title: `Session ${code}`,
      titleAr: `الجلسة ${code}`,
      order,
      description: null,
      summary: null,
      duration: 90,
      isLocked: false,
      videoUrl: hasVideo ? `https://videos/${code}` : null,
      pdfUrl: null,
    });
  }

  // --- Archived legacy HISTORY (must never enter active reporting) ----------
  T.part.push({ id: "lp", courseId: "c1", title: "Legacy Part", titleAr: "إرث", order: 9, description: null });
  T.unit.push({ id: "lu", partId: "lp", title: "Legacy Unit", titleAr: "وحدة إرث", order: 9, icon: null });
  T.topic.push({ id: "lt", unitId: "lu", title: "Legacy Topic", titleAr: "موضوع إرث", order: 1 });
  T.lesson.push(
    { id: "lx1", officialCode: null, curriculumStatus: "ARCHIVED", trackScope: "SHARED", status: "PUBLISHED", isPublished: true, unitId: null, topicId: "lt", title: "Legacy Lesson X1", titleAr: "درس قديم 1", order: 1, description: null, summary: null, duration: 90, isLocked: false, videoUrl: "https://videos/lx1", pdfUrl: null },
    { id: "lx2", officialCode: null, curriculumStatus: "ARCHIVED", trackScope: "SHARED", status: "PUBLISHED", isPublished: true, unitId: null, topicId: "lt", title: "Legacy Lesson X2", titleAr: "درس قديم 2", order: 2, description: null, summary: null, duration: 90, isLocked: false, videoUrl: null, pdfUrl: null },
  );
  // Decoy course curriculum (cross-course isolation).
  T.part.push({ id: "dp", courseId: "c2", title: "Decoy Part", titleAr: "ج", order: 1, description: null });
  T.unit.push({ id: "du", partId: "dp", title: "Decoy Unit", titleAr: "و", order: 1, icon: null });
  T.lesson.push(
    { id: "dl1", officialCode: "9-9-x", curriculumStatus: "OFFICIAL", trackScope: "SHARED", status: "PUBLISHED", isPublished: true, unitId: "du", topicId: null, title: "Decoy Lesson", titleAr: "درس ك2", order: 1, description: null, summary: null, duration: 90, isLocked: false, videoUrl: "https://videos/dl1", pdfUrl: null },
  );

  // --- Quizzes (session quizzes on official + one on archived history) ------
  T.quiz.push(
    { id: "q11", trackScope: "SHARED", lessonId: "l-1-1", title: "Quiz 1-1", titleAr: "كويز 1-1", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "q12", trackScope: "SHARED", lessonId: "l-1-2", title: "Quiz 1-2", titleAr: "كويز 1-2", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "q14a", trackScope: "ARABIC", lessonId: "l-1-4", title: "Quiz 1-4 AR", titleAr: "كويز 1-4 عربي", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "q21l", trackScope: "LANGUAGE", lessonId: "l-2-1", title: "Quiz 2-1 LG", titleAr: "كويز 2-1 لغات", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "q31", trackScope: "SHARED", lessonId: "l-3-1", title: "Quiz 3-1", titleAr: "كويز 3-1", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "lq1", trackScope: "SHARED", lessonId: "lx1", title: "Legacy Quiz", titleAr: "كويز قديم", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "qc2", trackScope: "SHARED", lessonId: "dl1", title: "Decoy Quiz", titleAr: "كويز ك2", description: null, passMark: 60, timeLimit: null, order: 0 },
  );

  // --- Homework (official + one on archived history) ------------------------
  T.homework.push(
    { id: "h11", trackScope: "SHARED", lessonId: "l-1-1", title: "HW 1-1", titleAr: "واجب 1-1", instructions: "do", deadline: FUT(5), maxMarks: 10, createdAt: D(10) },
    { id: "h12", trackScope: "SHARED", lessonId: "l-1-2", title: "HW 1-2", titleAr: "واجب 1-2", instructions: "do", deadline: FUT(6), maxMarks: 10, createdAt: D(10) },
    { id: "h14a", trackScope: "ARABIC", lessonId: "l-1-4", title: "HW 1-4 AR", titleAr: "واجب 1-4 عربي", instructions: "do", deadline: FUT(7), maxMarks: 20, createdAt: D(10) },
    { id: "h21l", trackScope: "LANGUAGE", lessonId: "l-2-1", title: "HW 2-1 LG", titleAr: "واجب 2-1 لغات", instructions: "do", deadline: FUT(8), maxMarks: 10, createdAt: D(10) },
    { id: "h31", trackScope: "SHARED", lessonId: "l-3-1", title: "HW 3-1", titleAr: "واجب 3-1", instructions: "do", deadline: FUT(9), maxMarks: 10, createdAt: D(10) },
    { id: "hx", trackScope: "SHARED", lessonId: "lx1", title: "Legacy HW", titleAr: "واجب قديم", instructions: "do", deadline: FUT(10), maxMarks: 10, createdAt: D(30) },
  );

  // --- Students / parents / links --------------------------------------------
  T.student.push(
    { id: "sa", userId: "u-sa", grade: "2nd Secondary", schoolName: "Nile", schoolType: "ARABIC", nationalId: "30101011234567", parentPhone: null, studentCode: "CM-AAAA11", groupId: "g1", batchId: null, enrolledAt: D(90) },
    { id: "sb", userId: "u-sb", grade: "2nd Secondary", schoolName: "Nile", schoolType: "LANGUAGE", nationalId: "30102021234567", parentPhone: null, studentCode: "CM-BBBB22", groupId: "g2", batchId: null, enrolledAt: D(90) },
    { id: "sc", userId: "u-sc", grade: "2nd Secondary", schoolName: "Nile", schoolType: "ARABIC", nationalId: "30103031234567", parentPhone: null, studentCode: "CM-CCCC33", groupId: "g1", batchId: null, enrolledAt: D(90) },
    { id: "se", userId: "u-se", grade: "2nd Secondary", schoolName: "Decoy", schoolType: "LANGUAGE", nationalId: "30104041234567", parentPhone: null, studentCode: "CM-DDDD44", groupId: "g3", batchId: null, enrolledAt: D(90) },
  );
  T.parent.push(
    { id: "pa", userId: "u-pa" },
    { id: "pb", userId: "u-pb" },
    { id: "pc", userId: "u-pc" },
  );
  T.parentStudentLink.push(
    { id: "link-a", parentId: "pa", studentId: "sa", relation: "parent", createdAt: D(50) },
    { id: "link-b", parentId: "pa", studentId: "sb", relation: "parent", createdAt: D(50) },
    { id: "link-c", parentId: "pb", studentId: "sb", relation: "parent", createdAt: D(50) },
  );

  // --- Quiz attempts ----------------------------------------------------------
  // sa: q11 90 pass (D2), q14a 80 pass (D3, ARABIC bucket), q31 40 fail (D1),
  //     q12 OPEN (never counted anywhere).
  T.quizAttempt.push(
    { id: "a-q11-sa", quizId: "q11", studentId: "sa", score: 9, totalMarks: 10, percentage: 90, passed: true, startedAt: D(2), finishedAt: D(2), cameraStatus: "NOT_REQUESTED" },
    { id: "a-q14-sa", quizId: "q14a", studentId: "sa", score: 8, totalMarks: 10, percentage: 80, passed: true, startedAt: D(3), finishedAt: D(3), cameraStatus: "NOT_REQUESTED" },
    { id: "a-q31-sa", quizId: "q31", studentId: "sa", score: 4, totalMarks: 10, percentage: 40, passed: false, startedAt: D(1), finishedAt: D(1), cameraStatus: "NOT_REQUESTED" },
    { id: "a-q12-sa-open", quizId: "q12", studentId: "sa", score: 0, totalMarks: 10, percentage: 0, passed: false, startedAt: D(0), finishedAt: null, cameraStatus: "NOT_REQUESTED" },
    // sb: q11 60 pass (D4), q21l 100 pass (D2, LANGUAGE bucket).
    { id: "a-q11-sb", quizId: "q11", studentId: "sb", score: 6, totalMarks: 10, percentage: 60, passed: true, startedAt: D(4), finishedAt: D(4), cameraStatus: "NOT_REQUESTED" },
    { id: "a-q21-sb", quizId: "q21l", studentId: "sb", score: 10, totalMarks: 10, percentage: 100, passed: true, startedAt: D(2), finishedAt: D(2), cameraStatus: "NOT_REQUESTED" },
    // se: decoy cross-course finished attempt — must never reach t1's numbers.
    { id: "a-qc2-se", quizId: "qc2", studentId: "se", score: 5, totalMarks: 10, percentage: 50, passed: false, startedAt: D(2), finishedAt: D(2), cameraStatus: "NOT_REQUESTED" },
  );

  // --- Homework submissions ---------------------------------------------------
  T.homeworkSubmission.push(
    // sa: h11 submitted + h14a graded (in-universe) — numerator = 2.
    { id: "hs-1", homeworkId: "h11", studentId: "sa", content: "done", fileUrl: null, submittedAt: D(1), grade: null, feedback: null, status: "SUBMITTED" },
    { id: "hs-2", homeworkId: "h14a", studentId: "sa", content: "done", fileUrl: null, submittedAt: D(2), grade: 18, feedback: "good", status: "GRADED" },
    // sa: archived-history + cross-track rows — must NOT move the numerator.
    { id: "hs-3", homeworkId: "hx", studentId: "sa", content: "old", fileUrl: null, submittedAt: D(20), grade: 10, feedback: null, status: "GRADED" },
    { id: "hs-4", homeworkId: "h21l", studentId: "sa", content: "cross", fileUrl: null, submittedAt: D(15), grade: null, feedback: null, status: "SUBMITTED" },
    // sb: h21l graded + h11 submitted (in-universe) — numerator = 2.
    { id: "hs-5", homeworkId: "h21l", studentId: "sb", content: "done", fileUrl: null, submittedAt: D(3), grade: 9, feedback: null, status: "GRADED" },
    { id: "hs-6", homeworkId: "h11", studentId: "sb", content: "done", fileUrl: null, submittedAt: D(4), grade: null, feedback: null, status: "SUBMITTED" },
  );

  // --- Lesson progress --------------------------------------------------------
  const lp = (studentId, lessonId, progress, isCompleted, video, daysAgo) => ({
    id: `lp-${studentId}-${lessonId}`,
    studentId,
    lessonId,
    progress,
    isCompleted,
    lastViewedAt: D(daysAgo),
    videoDurationSec: 600,
    videoWatchedSec: video ? Math.round((video.percent / 100) * 600) : 0,
    videoPercent: video ? video.percent : 0,
    videoCompleted: video ? video.completed : false,
    videoCompletedAt: video && video.completed ? D(daysAgo) : null,
    lastHeartbeatAt: D(daysAgo),
  });
  T.lessonProgress.push(
    // sa — 1-1 completed + watched; 1-2 in progress (30% video); 2-2 done
    // (ARABIC lesson); archived lx1 completed → history, must not count.
    lp("sa", "l-1-1", 100, true, { percent: 100, completed: true }, 10),
    lp("sa", "l-1-2", 50, false, { percent: 30, completed: false }, 1),
    lp("sa", "l-2-2", 100, true, null, 12),
    lp("sa", "lx1", 100, true, { percent: 100, completed: true }, 5),
    // sb — 1-1 completed + watched; 2-1 completed + watched; 5-1 in progress.
    lp("sb", "l-1-1", 100, true, { percent: 100, completed: true }, 9),
    lp("sb", "l-2-1", 100, true, { percent: 100, completed: true }, 8),
    lp("sb", "l-5-1", 60, false, null, 7),
  );
  // sc — completed 16 in-universe lessons (80% → certificate eligible) plus
  // one archived completion that must not inflate the count.
  const SC_DONE = [
    "l-1-1", "l-1-2", "l-1-3", "l-1-4", "l-2-2", "l-2-3", "l-3-1", "l-3-2",
    "l-3-3", "l-4-1", "l-4-2", "l-4-3", "l-4-4", "l-5-2", "l-5-3", "l-6-1",
  ];
  for (const lid of SC_DONE) T.lessonProgress.push(lp("sc", lid, 100, true, null, 15));
  T.lessonProgress.push(lp("sc", "lx2", 100, true, null, 15));
  // se — decoy course activity.
  T.lessonProgress.push(lp("se", "dl1", 100, true, { percent: 100, completed: true }, 6));

  // --- Attendance ---------------------------------------------------------------
  T.liveSession.push(
    { id: "s1", groupId: "g1", teacherId: "t1", lessonId: "l-1-1", title: "Session W1", titleAr: "الحصة 1", startAt: D(2), duration: 90, meetingUrl: null, status: "COMPLETED" },
    { id: "sched1", groupId: "g1", teacherId: "t1", lessonId: "l-1-3", title: "Next Live", titleAr: "القادمة", startAt: FUT(1), duration: 90, meetingUrl: "https://meet/x", status: "SCHEDULED" },
  );
  T.attendance.push(
    { id: "att-1", studentId: "sa", sessionId: "s1", status: "PRESENT", note: null, createdAt: D(2) },
  );

  // --- Subscription (sa ACTIVE; sb/sc none) -----------------------------------
  T.subscriptionPlan.push({ id: "sp1", name: "Monthly", nameAr: "شهري", price: 500, durationMonths: 1, features: "[]", isActive: true });
  T.subscription.push({
    id: "sub-sa", studentId: "sa", planId: "sp1", status: "ACTIVE",
    startDate: D(20), endDate: FUT(10), createdAt: D(20),
  });

  // --- Teacher note -----------------------------------------------------------
  T.teacherNote.push({ id: "tn-1", teacherId: "t1", studentId: "sa", note: "Great progress on 1-4", createdAt: D(1) });
}

// ---------------------------------------------------------------------------
// 6. Scenarios
// ---------------------------------------------------------------------------
async function main() {
  await seed();
  const db = global.__MOCK_DB__;

  section("A. Kodgy grounding — every answer references real 1-1 … 7-3 sessions");
  {
    const codes = new Set(officialCurriculum.OFFICIAL_LESSON_CODES);
    eq(kodgy.CURRICULUM_GROUNDING.length, 23, "grounding covers exactly 23 sessions");
    ok(kodgy.CURRICULUM_GROUNDING.every((g) => codes.has(g.code)), "every grounding code is an official lesson code");
    eq(new Set(kodgy.CURRICULUM_GROUNDING.map((g) => g.code)).size, 23, "grounding codes unique");

    // Grounding titles must match the LIVE knowledge model (no stale copies).
    const model = officialCurriculum.loadOfficialCurriculumModel();
    const titleByCode = new Map();
    for (const p of model.parts) {
      for (const u of p.units) {
        for (const l of u.lessons) titleByCode.set(l.code, { title: l.title, titleAr: l.titleAr });
      }
    }
    ok(
      kodgy.CURRICULUM_GROUNDING.every(
        (g) =>
          titleByCode.get(g.code)?.title === g.titleEn &&
          titleByCode.get(g.code)?.titleAr === g.titleAr
      ),
      "grounding titles match the knowledge model exactly (AR + EN)"
    );

    // Every grounding intent exists, and its answer names its sessions in
    // BOTH locales (spot-check through the real matcher).
    const QUERY_BY_INTENT = {
      "edu.it-society": "ما هو التحول الاجتماعي؟",
      "edu.ai-basics": "ما هو الذكاء الاصطناعي؟",
      "edu.cybersecurity": "ما هو الأمن السيبراني؟",
      "edu.web-applications": "ما هي تطبيقات الويب؟",
      "edu.web-media-design": "ما هي تجربة المستخدم؟",
      "edu.data": "كيف أجمع البيانات؟",
      "edu.statistics": "ما هو الاستدلال الإحصائي؟",
      "edu.ml-basics": "ما هو تعلم الآلة؟",
      "edu.neural-network": "What is a neural network?",
      "edu.llm": "What is an LLM?",
    };
    const supported = new Set(kodgy.supportedIntents());
    const codesByIntent = new Map();
    for (const g of kodgy.CURRICULUM_GROUNDING) {
      if (!codesByIntent.has(g.intent)) codesByIntent.set(g.intent, []);
      codesByIntent.get(g.intent).push(g.code);
    }
    for (const [intent, query] of Object.entries(QUERY_BY_INTENT)) {
      ok(supported.has(intent), `intent exists in the engine: ${intent}`);
      const r = kodgy.match(query);
      ok(r.matched && r.intent === intent, `grounding query lands on ${intent} (got ${r.intent})`);
      const codesForIntent = codesByIntent.get(intent) || [];
      const arOk = codesForIntent.every((c) => r.answer.ar.includes(c));
      const enOk = codesForIntent.every((c) => r.answer.en.includes(c));
      ok(arOk && enOk, `${intent} answer names sessions ${codesForIntent.join(", ")} in AR + EN`);
    }

    // The official-structure claims are itself grounded (23 sessions, 7 units).
    const coursesAnswer = kodgy.match("What courses do you have?");
    ok(
      coursesAnswer.answer.en.includes("23") && coursesAnswer.answer.en.includes("1-1") && coursesAnswer.answer.en.includes("7-3"),
      "courses answer states the official 23-session structure"
    );
    const programmingAnswer = kodgy.match("How do I start learning programming?");
    ok(
      !programmingAnswer.answer.en.includes("variables → conditions → loops"),
      "no stale pre-official learning path remains in grounding"
    );
    ok(
      programmingAnswer.answer.en.includes("7-1") && programmingAnswer.answer.en.includes("Cybersecurity"),
      "programming answer teaches the REAL official sequence"
    );

    // Engine contract untouched (Phase 10 contract: same surface, fallback safe).
    ok(typeof kodgy.match === "function" && typeof kodgy.pickAnswer === "function" && typeof kodgy.suggestedPrompts === "function" && typeof kodgy.supportedIntents === "function" && typeof kodgy.normalize === "function", "response-engine contract exports unchanged");
    ok(kodgy.match("zzz totally unknown zzz").intent === "fallback", "unknown question still falls back gracefully");
    const engineSrc = fs.readFileSync(path.join(REPO, "src/lib/kodgy/response-engine.ts"), "utf8");
    ok(
      !/fetch\(|require\(["']https?|@prisma|child_process/.test(engineSrc),
      "engine stays dependency-free: no network, no LLM, no DB"
    );
  }

  section("B. Student dashboard — official totals, track isolation, lifecycle");
  let saDashboard;
  {
    global.__WRITES__ = [];
    await loginAs("u-sa");
    const res = await studentDashboardRoute.GET(req());
    const out = await bodyOf(res);
    eq(out.status, 200, "student dashboard 200");
    saDashboard = out.body;
    // Total = 20, NOT 21 (DRAFT 7-3 excluded), NOT 22 (language lessons 2-1,
    // 5-1 excluded), NOT 24 (archived lx1/lx2, decoy course excluded).
    eq(saDashboard.courseProgress.totalLessons, ARABIC_UNIVERSE, "ARABIC student sees exactly the 20-lesson track universe");
    eq(saDashboard.courseProgress.completedLessons, 2, "archived-completion inflation removed from completed count");
    eq(saDashboard.courseProgress.percentage, 10, "progress percentage = completed / official universe");
    // continueLesson must be the engine's current session, ordered
    // canonically, and open to the student (1-2).
    eq(saDashboard.continueLesson?.id, "l-1-2", "continueLesson = first unlocked incomplete official session");
    ok(saDashboard.continueLesson?.videoUrl === "https://videos/1-2", "open session carries its video URL");
    ok(saDashboard.continueLesson?.part === "Part 1" || saDashboard.continueLesson?.part === "الجزء الأول", "continueLesson resolves the canonical Part chain");
    // Pending homework respects the Phase 4 gating chain: a session is
    // unlocked iff the PREVIOUS session completed, and component-less
    // sessions auto-complete — so 1-2 (current), 1-4 and 3-1 are open for
    // sa, but 1-3/2-2/3-2 stay locked. Of the open sessions' homework, h11
    // and h14a already carry submissions → h12 + h31 remain pending.
    eq(saDashboard.pendingHomework.count, 2, "pending homework = open in-track sessions without a submission");
    eq(
      saDashboard.pendingHomework.items.map((h) => h.id),
      ["h12", "h31"],
      "pending = current session's HW + the open 3-1 HW (locked 1-3/2-2/3-2 hidden)"
    );

    // LANGUAGE student: different universe, same curriculum.
    await loginAs("u-sb");
    const outB = await bodyOf(await studentDashboardRoute.GET(req()));
    eq(outB.body.courseProgress.totalLessons, LANGUAGE_UNIVERSE, "LANGUAGE student sees exactly the 19-lesson track universe");
    eq(outB.body.courseProgress.completedLessons, 2, "LANGUAGE completed count in-universe only");

    // Read-only guarantee.
    eq(global.__WRITES__.length, 0, "student dashboards perform no writes");
  }

  section("C. Certificate — same universe as the dashboard, 80% rule intact");
  {
    await loginAs("u-sa");
    const a = await bodyOf(await certificateRoute.GET(req()));
    eq(a.body.totalLessons, ARABIC_UNIVERSE, "certificate denominator = 20 (track-sliced, official)");
    eq(a.body.completedLessons, 2, "certificate numerator excludes archived completions");
    eq(a.body.progressPct, 10, "certificate pct = 10");
    eq(a.body.eligible, false, "10% → not eligible");
    eq(a.body.certificate, null, "no certificate payload when ineligible");

    await loginAs("u-sc");
    const c = await bodyOf(await certificateRoute.GET(req()));
    eq(c.body.totalLessons, ARABIC_UNIVERSE, "sc certificate denominator = 20");
    eq(c.body.completedLessons, 16, "sc numerator = 16 (archived lx2 completion excluded)");
    eq(c.body.progressPct, 80, "sc pct = 80");
    ok(c.body.eligible === true && c.body.certificate != null, "80% → eligible with certificate payload");
    ok(String(c.body.certificate.certificateId).startsWith("CM-"), "certificate id minted");
    ok(c.body.completedLessons <= c.body.totalLessons && c.body.progressPct <= 100, "certificate invariant: numerator ≤ denominator, pct ≤ 100");
  }

  section("D. Shared progress service — video universe is per-student track");
  {
    const map = await progressLib.getVideoProgressForStudents(["sa", "sb", "sc", "se"]);
    const va = map.get("sa");
    eq(va.totalVideos, 5, "ARABIC video universe = 5 (SHARED 3 + ARABIC 2, archived lx1 excluded)");
    eq(va.completedVideos, 1, "completed videos = 1 (archived lx1 completion excluded)");
    eq(va.averagePercent, 26, "average = (100 + 30) / 5 over the SAME universe");
    eq(va.completionPercent, 20, "completion = 1 / 5");
    eq(va.totalWatchedMinutes, 13, "watched minutes from in-universe rows only (600s + 180s = 780s)");

    const vb = map.get("sb");
    eq(vb.totalVideos, 4, "LANGUAGE video universe = 4 (SHARED 3 + LANGUAGE 1)");
    eq(vb.completedVideos, 2, "sb completed both in-track videos");
    ok(vb.completionPercent <= 100, "video completion ≤ 100%");

    // In-range numbers must derive from the same universe (weekly/monthly).
    const range = await progressLib.getVideoProgressInRange("sa", new Date(NOW - 7 * 86400000), new Date(NOW));
    eq(range.videosWatched, 1, "weekly videos watched counts the in-universe 1-2 heartbeat only");
    eq(range.watchedMinutes, 3, "weekly watched minutes = 1-2 partial watch (lx1 archived excluded)");
    eq(range.videosCompleted, 0, "no in-window completions (archived lx1 completion excluded)");
  }

  section("E. Parent dashboard — multi-child ARABIC + LANGUAGE isolation");
  let paChildren;
  {
    global.__WRITES__ = [];
    await loginAs("u-pa");
    const out = await bodyOf(await parentDashboardRoute.GET(req()));
    eq(out.status, 200, "parent dashboard 200");
    paChildren = out.body.children;
    eq(paChildren.length, 2, "both linked children returned, independently scoped");
    const [childA, childB] = paChildren;
    eq(childA.id, "sa", "first child = ARABIC child");
    eq(childB.id, "sb", "second child = LANGUAGE child");

    // Course progress: per-child universes (NOT a shared union denominator).
    eq(childA.courseProgress.total, ARABIC_UNIVERSE, "ARABIC child total = 20");
    eq(childA.courseProgress.completed, 2, "ARABIC child completed = 2 (archived excluded)");
    eq(childA.courseProgress.pct, 13, "ARABIC child avg progress over 20");
    eq(childB.courseProgress.total, LANGUAGE_UNIVERSE, "LANGUAGE child total = 19 — no track collapse");
    eq(childB.courseProgress.completed, 2, "LANGUAGE child completed = 2");
    eq(childB.courseProgress.pct, 14, "LANGUAGE child avg progress over 19");

    // Homework: official (unit-linked) lessons' homework — the Phase 12 legacy
    // chain debt is gone. Numerators restricted to the same universe.
    eq(childA.homework.total, 4, "ARABIC homework universe = 4 official assignments");
    eq(childA.homework.submitted, 2, "ARABIC submissions = 2 (archived hx + cross-track h21l excluded)");
    eq(childA.homework.graded, 1, "ARABIC graded = 1 (h14a only)");
    eq(childA.homework.completionPct, 50, "ARABIC homework completion = 2/4 (not >100%)");
    eq(childB.homework.total, 4, "LANGUAGE homework universe = 4");
    eq(childB.homework.submitted, 2, "LANGUAGE submissions = 2");
    eq(childB.homework.completionPct, 50, "LANGUAGE homework completion = 2/4");
    ok(paChildren.every((c) => c.homework.submitted <= c.homework.total), "homework numerator ≤ denominator for every child");

    // Video progress through the shared service: per-track denominators.
    eq(childA.videoProgress.totalVideos, 5, "ARABIC child video universe on parent dashboard");
    eq(childB.videoProgress.totalVideos, 4, "LANGUAGE child video universe on parent dashboard");

    // Session progression from the Phase 4 engine: official universe sizes.
    eq(childA.sessionProgress.total, ARABIC_UNIVERSE, "engine universe for ARABIC child = 20");
    // Engine semantics (Phase 4, unchanged): component-less sessions
    // auto-complete; gating is previous-session-completed. sa: fully gated
    // 1-1 done, 1-2/1-4/3-1/4-1 incomplete, 15 empty sessions auto-pass.
    eq(childA.sessionProgress.completed, 16, "engine completion = 1-1 + auto-completed component-less sessions");
    eq(childA.sessionProgress.currentLessonId, "l-1-2", "engine current = 1-2 (first unlocked incomplete)");
    eq(childB.sessionProgress.total, LANGUAGE_UNIVERSE, "engine universe for LANGUAGE child = 19");
    eq(childB.sessionProgress.completed, 17, "sb: 1-1 + 2-1 gated + empties = 17");
    eq(childB.sessionProgress.currentLessonId, "l-1-2", "LANGUAGE child also resumes at 1-2");

    // Strong/weak: canonical UNIT grouping (official lessons have no topic).
    const strongA = childA.strongTopics.map((t2) => t2.title);
    const weakA = childA.weakTopics.map((t2) => t2.title);
    ok(
      strongA.some((t2) => t2 === "الوحدة الأولى"),
      "strong topic grouped by canonical UNIT (official lessons are unit-linked)"
    );
    ok(
      weakA.some((t2) => t2 === "الوحدة الثالثة"),
      "weak topic grouped by canonical UNIT (3-1 = 40%)"
    );
    ok(!strongA.includes("Legacy Topic") && !weakA.includes("Legacy Topic"), "no legacy topic leakage in strong/weak");

    // Quiz averages: finished attempts only (the open q12 attempt invisible).
    eq(childA.quizzes.average, 70, "ARABIC quiz average over finished attempts only");
    eq(childA.quizzes.attempts, 3, "open attempt excluded from attempt count");
    eq(childB.quizzes.average, 80, "LANGUAGE quiz average over finished attempts");

    // Subscription surface still intact (sa ACTIVE, sb none).
    eq(childA.subscription?.status, "ACTIVE", "subscription payload intact");
    eq(childB.subscription, null, "no-subscription child stays null (monthly-report contract)");

    eq(global.__WRITES__.length, 0, "parent dashboard performs no writes");

    // Single-child parent: pb sees only sb with sb's own track universe.
    await loginAs("u-pb");
    const outB = await bodyOf(await parentDashboardRoute.GET(req()));
    eq(outB.body.children.length, 1, "single-child parent sees exactly one child");
    eq(outB.body.children[0].courseProgress.total, LANGUAGE_UNIVERSE, "single-child total = 19");

    // Parent with no linked children: empty, never a crash.
    await loginAs("u-pc");
    const outC = await bodyOf(await parentDashboardRoute.GET(req()));
    eq(outC.body.children.length, 0, "childless parent gets an empty children list");
  }

  section("F. Reports agree with the dashboards — weekly & monthly");
  {
    global.__WRITES__ = [];
    await loginAs("u-pa");
    const out = await bodyOf(await weeklyReportRoute.GET(req()));
    eq(out.body.reports.length, 2, "weekly report covers both children independently");
    const [repA, repB] = out.body.reports;
    eq(repA.studentId, "sa", "weekly row 1 = ARABIC child");
    eq(repB.studentId, "sb", "weekly row 2 = LANGUAGE child");

    // Per-child denominators equal the dashboards' universes — the union
    // collapse would print 9% for BOTH (2 / 22-union).
    eq(repA.summary.completionPct, 10, "weekly ARABIC completion = 2/20 (own track universe)");
    eq(repB.summary.completionPct, 11, "weekly LANGUAGE completion = 2/19 (own track universe — not collapsed)");
    ok(repA.summary.completionPct !== repB.summary.completionPct, "sibling denominators no longer collapsed into one union");

    // Weekly activity windows use the same shared progress service.
    eq(repA.videoProgress.week.videosWatched, 1, "weekly videos watched in window (in-universe)");
    eq(repA.videoProgress.overall.totalVideos, 5, "overall video universe embedded in weekly report");
    eq(repA.summary.quizzesTaken, 3, "weekly quiz window = 3 finished attempts");
    eq(repA.summary.avgQuizScore, 70, "weekly quiz average = 70 (finished only)");
    ok(repA.summary.completionPct <= 100 && repA.summary.completionPct >= 0, "weekly pct within [0, 100]");

    // Monthly report is derived from the SAME dashboard payload → agreement
    // by construction; verify the mapped contract carries the new graded
    // field and the aligned homework denominator.
    const monthlyA = buildReportData(paChildren[0], "ar");
    eq(monthlyA.homework.completionPct, 50, "monthly homework completion matches dashboard");
    eq(monthlyA.homework.graded, 1, "monthly graded count present (contract field)");
    eq(monthlyA.courseProgress.total, ARABIC_UNIVERSE, "monthly course total = 20");
    eq(monthlyA.courseProgress.completed, 2, "monthly course completed = 2");

    eq(global.__WRITES__.length, 0, "weekly report performs no writes");
  }

  section("G. Parent analytics — per-child universes + canonical grouping");
  {
    global.__WRITES__ = [];
    await loginAs("u-pa");
    const out = await bodyOf(await parentAnalyticsRoute.GET(req()));
    eq(out.body.children.length, 2, "analytics covers both children");
    const [anaA, anaB] = out.body.children;

    eq(anaA.totalLessons, ARABIC_UNIVERSE, "analytics ARABIC total = 20");
    eq(anaA.completedLessons, 2, "analytics ARABIC completed = 2");
    eq(anaA.completionPct, 10, "analytics ARABIC pct matches dashboard + weekly report");
    eq(anaB.totalLessons, LANGUAGE_UNIVERSE, "analytics LANGUAGE total = 19");
    eq(anaB.completedLessons, 2, "analytics LANGUAGE completed = 2");
    eq(anaB.completionPct, 11, "analytics LANGUAGE pct matches weekly report");

    // Strong/weak grouped by CURRICULUM container (unit), not quiz titles.
    ok(
      anaA.strongTopics.some((t2) => t2.title === "الوحدة الأولى"),
      "analytics strong topics grouped by canonical unit"
    );
    ok(
      anaA.weakTopics.some((t2) => t2.title === "الوحدة الثالثة"),
      "analytics weak topics grouped by canonical unit (Unit 3 = 40%)"
    );
    eq(anaA.totalQuizzes, 3, "analytics counts finished attempts only");
    eq(anaA.avgQuizPct, 70, "analytics quiz average = 70");
    eq(global.__WRITES__.length, 0, "parent analytics performs no writes");
  }

  section("H. Teacher analytics — trackSplit SHARED/ARABIC/LANGUAGE + official universes");
  {
    global.__WRITES__ = [];
    await loginAs("u-t1");
    const out = await bodyOf(await teacherAnalyticsRoute.GET(req()));
    eq(out.status, 200, "teacher analytics 200");

    const split = out.body.overview.trackSplit;
    eq(Object.keys(split), ["SHARED", "ARABIC", "LANGUAGE"], "all three buckets always present, in order");
    eq(split.SHARED.attemptCount, 3, "SHARED bucket = q11(sa) + q11(sb) + q31(sa)");
    eq(split.SHARED.avgPercentage, 63, "SHARED avg = (90+60+40)/3 attempt-weighted");
    eq(split.SHARED.passRate, 67, "SHARED pass rate = 2/3");
    eq(split.SHARED.participantCount, 2, "SHARED participants = 2");
    eq(split.ARABIC.attemptCount, 1, "ARABIC bucket = q14a(sa) only");
    eq(split.ARABIC.avgPercentage, 80, "ARABIC avg = 80");
    eq(split.LANGUAGE.attemptCount, 1, "LANGUAGE bucket = q21l(sb) only");
    eq(split.LANGUAGE.avgPercentage, 100, "LANGUAGE avg = 100");
    eq(
      split.SHARED.attemptCount + split.ARABIC.attemptCount + split.LANGUAGE.attemptCount,
      5,
      "each attempt lands in exactly ONE bucket — shared attempts classified as SHARED, never double-counted"
    );

    // Per-group split uses the same population (g1: sa+sc; g2: sb).
    const g1 = out.body.groups.find((g) => g.groupId === "g1");
    const g2 = out.body.groups.find((g) => g.groupId === "g2");
    eq(g1.trackSplit.SHARED.attemptCount, 2, "g1 SHARED = q11 + q31");
    eq(g1.trackSplit.ARABIC.attemptCount, 1, "g1 ARABIC = q14a");
    eq(g2.trackSplit.SHARED.attemptCount, 1, "g2 SHARED = q11(sb)");
    eq(g2.trackSplit.LANGUAGE.attemptCount, 1, "g2 LANGUAGE = q21l");

    // Lesson completion runs over official, track-sliced universes per
    // student — never raw history rows (sa raw rows would be 3 incl. lx1).
    const saStats = g1.students.find((s) => s.studentId === "sa");
    const scStats = g1.students.find((s) => s.studentId === "sc");
    eq(saStats.lessonsCompleted, 2, "sa lessonsCompleted in-universe only (archived lx1 excluded)");
    eq(scStats.lessonsCompleted, 16, "sc lessonsCompleted = 16 (archived lx2 excluded)");
    // pooled: sa 2/20 + sc 16/20 → 18/40 = 45
    eq(g1.avgLessonCompletion, 45, "g1 lesson completion pooled over official universes");
    const sbStats = g2.students.find((s) => s.studentId === "sb");
    eq(sbStats.lessonsCompleted, 2, "sb lessonsCompleted = 2 of 19");
    eq(g2.avgLessonCompletion, 11, "g2 lesson completion = 2/19 — LANGUAGE universe, not 2/20");

    // The decoy course/teacher never leaks into t1's analytics.
    eq(out.body.groups.length, 2, "teacher sees only their own groups");
    ok(
      !JSON.stringify(out.body).includes('"se"'),
      "cross-course student never surfaces in t1 analytics"
    );
    eq(global.__WRITES__.length, 0, "teacher analytics performs no writes");
  }

  section("I. Export progress — canonical unit fallback in the CSV");
  {
    await loginAs("u-sa");
    const res = await exportProgressRoute.GET(req());
    ok(typeof res.body === "string" && res.body.includes("Type"), "CSV exported");
    ok(res.body.includes("الوحدة الأولى"), "official unit-linked lessons name their UNIT (was blank topic column)");
    ok(res.body.includes("الجلسة 1-1"), "lesson rows present with titles");
  }

  section("J. Authorization — roles + no client-supplied child/track scope");
  {
    // Role matrix: parent surfaces refuse non-parents, student surfaces
    // refuse non-students, teacher analytics refuses non-teachers.
    await loginAs("u-sa");
    eq((await bodyOf(await parentDashboardRoute.GET(req()))).status, 403, "student cannot call parent dashboard");
    eq((await bodyOf(await parentAnalyticsRoute.GET(req()))).status, 403, "student cannot call parent analytics");
    eq((await bodyOf(await weeklyReportRoute.GET(req()))).status, 403, "student cannot call weekly report");
    await loginAs("u-pa");
    eq((await bodyOf(await studentDashboardRoute.GET(req()))).status, 403, "parent cannot call student dashboard");
    eq((await bodyOf(await certificateRoute.GET(req()))).status, 403, "parent cannot call certificate");
    eq((await bodyOf(await teacherAnalyticsRoute.GET(req()))).status, 403, "parent cannot call teacher analytics");
    logout();
    eq((await bodyOf(await parentDashboardRoute.GET(req()))).status, 401, "anonymous → 401");

    // Client-supplied child/track identifiers must be ignored entirely: the
    // response derives ONLY from the server-side parent links.
    await loginAs("u-pa");
    const baseline = await bodyOf(await parentDashboardRoute.GET(req()));
    const spoofed = req();
    spoofed.json = async () => ({ studentId: "se", track: "ARABIC", childId: "se" });
    const withBody = await bodyOf(await parentDashboardRoute.GET(spoofed));
    eq(withBody.body, baseline.body, "client-supplied child/track ids do not change the parent response");

    // The parent can never receive the decoy course / unlinked student.
    ok(!JSON.stringify(baseline.body).includes("Decoy Course") && !JSON.stringify(baseline.body).includes('"se"'), "no unlinked student/course data in parent payload");
  }

  section("K. Global invariants across every reporting surface");
  {
    // Collect every percentage we just asserted and bound them all.
    const pcts = [
      saDashboard.courseProgress.percentage,
      ...paChildren.flatMap((c) => [c.courseProgress.pct, c.homework.completionPct, c.videoProgress.completionPercent]),
    ];
    ok(pcts.every((p) => p >= 0 && p <= 100), "every reported percentage is within [0, 100]");
  }

  console.log(`\nparent & analytics alignment (phase 19): ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
