// CodeMind Academy — Phase 12 Track Architecture & Enforcement tests.
//
// Four layers, all offline (no database file, no network, no server):
//
//   A. PURE CONTRACT — `src/lib/track-scope.ts` and `src/lib/school-type.ts`
//      are compiled with tsc and exercised directly: the full cross-track
//      guarantee matrix, fail-closed behaviour, and question-tagging
//      precedence.
//
//   B. BEHAVIOURAL — the REAL `session-progress`, `session-quiz`,
//      `enrollment`, `parent-access` and `quiz-analytics` modules are compiled
//      and run against a fake `@/lib/db` that models the Phase 12 schema
//      (Lesson/Quiz/Homework.trackScope, Question.schoolType, Batch.schoolType,
//      Student.schoolType). This exercises real lesson gating, real question
//      selection, real grading arithmetic and real batch reconciliation.
//
//   C. SOURCE INVARIANTS — the track-sensitive routes are read and asserted,
//      in the style of tests/authorization-invariants.test.js, so the server
//      side of every surface is pinned.
//
//   D. SCHEMA + MIGRATION — prisma/schema.prisma and the Phase 12 migration
//      are parsed and asserted: the enum exists, the columns exist, the
//      backfill normalises BEFORE the type change, and the official
//      curriculum's uniqueness is untouched.
//
// Run: node tests/track-architecture-phase12.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Module } = require("module");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
};
const eq = (a, b, label) => {
  const equal = JSON.stringify(a) === JSON.stringify(b);
  ok(equal, `${label} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Compile the modules under test to CommonJS in a temp dir.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p12-test-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: false,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/track-scope.ts"),
      path.join(REPO, "src/lib/school-type.ts"),
      path.join(REPO, "src/lib/session-progress.ts"),
      path.join(REPO, "src/lib/session-quiz.ts"),
      path.join(REPO, "src/lib/enrollment.ts"),
      path.join(REPO, "src/lib/parent-access.ts"),
      path.join(REPO, "src/lib/quiz-analytics.ts"),
      path.join(REPO, "src/lib/progress.ts"),
    ],
  })
);
// Type errors elsewhere in the graph are tolerated here (`npm run typecheck`
// is the real gate); what matters is that the JS under test was emitted.
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* fall through: check the emitted files instead */
}
const EMITTED = [
  "track-scope.js",
  "school-type.js",
  "session-progress.js",
  "session-quiz.js",
  "enrollment.js",
  "parent-access.js",
  "quiz-analytics.js",
  "progress.js",
];
for (const f of EMITTED) {
  if (!fs.existsSync(path.join(OUT, f))) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// The fake database — a Prisma subset emulator over the Phase 12 schema.
// ---------------------------------------------------------------------------
const FAKE_DB_PATH = path.join(OUT, "fake-db.js");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "@/lib/db") return FAKE_DB_PATH;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(OUT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...args);
};

const COURSE = "course-1";
const OTHER_COURSE = "course-2";

/** A fresh world: one shared course, three lessons of three different scopes. */
function world() {
  return {
    students: {
      // id -> { schoolType, batchId, groupId, group, batch }
      "ar-student": { id: "ar-student", schoolType: "ARABIC", batchId: null, groupId: "g1", group: { courseId: COURSE, isActive: true, course: { id: COURSE } }, batch: null },
      "lang-student": { id: "lang-student", schoolType: "LANGUAGE", batchId: null, groupId: "g1", group: { courseId: COURSE, isActive: true, course: { id: COURSE } }, batch: null },
      "none-student": { id: "none-student", schoolType: null, batchId: null, groupId: "g1", group: { courseId: COURSE, isActive: true, course: { id: COURSE } }, batch: null },
      "other-course": { id: "other-course", schoolType: "ARABIC", batchId: null, groupId: "g2", group: { courseId: OTHER_COURSE, isActive: true, course: { id: OTHER_COURSE } }, batch: null },
    },
    lessons: {
      // L-SHARED / L-AR / L-LANG all hang off the same Unit of the same course,
      // with L-SHARED first so progression order is deterministic.
      "L-SHARED": { id: "L-SHARED", order: 1, trackScope: "SHARED", isPublished: true, curriculumStatus: "OFFICIAL", videoUrl: null, unitId: "U1", topicId: null, unit: { id: "U1", order: 1, part: { id: "P1", order: 1, courseId: COURSE } }, topic: null, quizzes: [], homeworks: [] },
      "L-AR": { id: "L-AR", order: 2, trackScope: "ARABIC", isPublished: true, curriculumStatus: "OFFICIAL", videoUrl: null, unitId: "U1", topicId: null, unit: { id: "U1", order: 1, part: { id: "P1", order: 1, courseId: COURSE } }, topic: null, quizzes: [], homeworks: [] },
      "L-LANG": { id: "L-LANG", order: 3, trackScope: "LANGUAGE", isPublished: true, curriculumStatus: "OFFICIAL", videoUrl: null, unitId: "U1", topicId: null, unit: { id: "U1", order: 1, part: { id: "P1", order: 1, courseId: COURSE } }, topic: null, quizzes: [], homeworks: [] },
      // A SHARED lesson in the OTHER course — for course isolation.
      "L-OTHER": { id: "L-OTHER", order: 1, trackScope: "SHARED", isPublished: true, curriculumStatus: "OFFICIAL", videoUrl: null, unitId: "U9", topicId: null, unit: { id: "U9", order: 1, part: { id: "P9", order: 1, courseId: OTHER_COURSE } }, topic: null, quizzes: [], homeworks: [] },
    },
    quizzes: {
      "Q-SHARED": { id: "Q-SHARED", lessonId: "L-SHARED", trackScope: "SHARED" },
      "Q-AR": { id: "Q-AR", lessonId: "L-SHARED", trackScope: "ARABIC" },
      "Q-LANG": { id: "Q-LANG", lessonId: "L-SHARED", trackScope: "LANGUAGE" },
      "Q-AR-OWN": { id: "Q-AR-OWN", lessonId: "L-AR", trackScope: "ARABIC" },
      "Q-LANG-OWN": { id: "Q-LANG-OWN", lessonId: "L-LANG", trackScope: "LANGUAGE" },
    },
    homeworks: {
      "H-SHARED": { id: "H-SHARED", lessonId: "L-SHARED", trackScope: "SHARED" },
      "H-AR": { id: "H-AR", lessonId: "L-SHARED", trackScope: "ARABIC" },
      "H-LANG": { id: "H-LANG", lessonId: "L-SHARED", trackScope: "LANGUAGE" },
      "H-AR-OWN": { id: "H-AR-OWN", lessonId: "L-AR", trackScope: "ARABIC" },
      "H-LANG-OWN": { id: "H-LANG-OWN", lessonId: "L-LANG", trackScope: "LANGUAGE" },
    },
    questions: {
      "q-shared": { id: "q-shared", quizId: "Q-SHARED", schoolType: null, answer: "1", marks: 1, createdAt: new Date(1000), type: "MCQ", prompt: "p", promptAr: null, options: '["a","b"]', explanation: null, difficulty: "MEDIUM" },
      "q-ar": { id: "q-ar", quizId: "Q-SHARED", schoolType: "ARABIC", answer: "1", marks: 1, createdAt: new Date(2000), type: "MCQ", prompt: "p", promptAr: null, options: '["a","b"]', explanation: null, difficulty: "MEDIUM" },
      "q-lang": { id: "q-lang", quizId: "Q-SHARED", schoolType: "LANGUAGE", answer: "1", marks: 1, createdAt: new Date(3000), type: "MCQ", prompt: "p", promptAr: null, options: '["a","b"]', explanation: null, difficulty: "MEDIUM" },
    },
    quizAnswers: [], // { id, attemptId, questionId, selected, isCorrect }
    quizAttempts: [], // { id, quizId, studentId, finishedAt }
    lessonProgress: [],
    homeworkSubmissions: [],
    batches: {
      "b-ar": { id: "b-ar", schoolType: "ARABIC", courseId: COURSE, isActive: true, createdAt: new Date(1) },
      "b-lang": { id: "b-lang", schoolType: "LANGUAGE", courseId: COURSE, isActive: true, createdAt: new Date(2) },
      "b-ar-other": { id: "b-ar-other", schoolType: "ARABIC", courseId: OTHER_COURSE, isActive: true, createdAt: new Date(3) },
      "b-ar-inactive": { id: "b-ar-inactive", schoolType: "ARABIC", courseId: null, isActive: false, createdAt: new Date(4) },
    },
    parents: {
      // parentUserId -> [{ studentId }]
      "p-ar-only": [{ studentId: "ar-student" }],
      "p-lang-only": [{ studentId: "lang-student" }],
      "p-both": [{ studentId: "ar-student" }, { studentId: "lang-student" }],
      "p-none-child": [{ studentId: "none-student" }],
    },
    subscriptions: {},
  };
}

let W = world();
let seq = 100;
const nid = (p) => `${p}-${++seq}`;
/** Deep copy that PRESERVES Date instances (structuredClone keeps Dates). */
const clone = (r) => (r ? structuredClone(r) : r);

function matchCond(value, cond) {
  if (cond === null || cond === undefined) return value === null || value === undefined;
  if (typeof cond !== "object" || Array.isArray(cond)) return value === cond;
  if ("in" in cond) return Array.isArray(cond.in) && cond.in.includes(value);
  if ("not" in cond) return !matchCond(value, cond.not);
  throw new Error(`mock: unsupported condition ${JSON.stringify(cond)}`);
}

/** Attach the nested relation objects a lesson query may ask for. */
function lessonRow(l) {
  return { ...l };
}

function matchLesson(l, where) {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!Array.isArray(v) || !v.some((b) => matchLesson(l, b))) return false;
      continue;
    }
    if (k === "NOT") {
      if (matchLesson(l, v)) return false;
      continue;
    }
    if (k === "unit") {
      if (!l.unit || !matchCond(l.unit.part.courseId, v.part.courseId)) return false;
      continue;
    }
    if (k === "topic") {
      if (!l.topic || !matchCond(l.topic.unit.part.courseId, v.unit.part.courseId)) return false;
      continue;
    }
    if (k === "lessonId") {
      if (!matchCond(l.id, v)) return false;
      continue;
    }
    if (!matchCond(l[k], v)) return false;
  }
  return true;
}

function matchQuestion(q, where) {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    if (k === "OR") {
      if (!Array.isArray(v) || !v.some((b) => matchQuestion(q, b))) return false;
      continue;
    }
    if (!matchCond(q[k], v)) return false;
  }
  return true;
}

function matchBatch(b, where) {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => matchCond(b[k], v));
}

const fakeDb = {
  __writes: { update: 0, updateMany: 0, create: 0, createMany: 0 },
  __resetWrites() {
    this.__writes = { update: 0, updateMany: 0, create: 0, createMany: 0 };
  },
  lesson: {
    async findMany({ where }) {
      return Object.values(W.lessons)
        .filter((l) => matchLesson(l, where))
        .map((l) => ({
          ...clone(lessonRow(l)),
          quizzes: W.lessons[l.id].quizzes,
          homeworks: W.lessons[l.id].homeworks,
        }));
    },
    async findUnique({ where }) {
      const l = W.lessons[where.id];
      return l ? { ...clone(lessonRow(l)), quizzes: l.quizzes, homeworks: l.homeworks } : null;
    },
  },
  student: {
    async findUnique({ where }) {
      const s = W.students[where.id];
      return s ? clone(s) : null;
    },
    async findMany({ where }) {
      return Object.values(W.students).filter((s) => {
        if (!where) return true;
        for (const [k, v] of Object.entries(where)) {
          if (k === "id" && v && "in" in v) {
            if (!v.in.includes(s.id)) return false;
            continue;
          }
          if (k === "group" && v) {
            if (v.courseId !== undefined && (!s.group || s.group.courseId !== v.courseId)) return false;
            if (v.isActive !== undefined && (!s.group || s.group.isActive !== v.isActive)) return false;
            continue;
          }
          if (!matchCond(s[k], v)) return false;
        }
        return true;
      });
    },
    async update({ where, data }) {
      const s = W.students[where.id];
      Object.assign(s, data);
      if (data.batchId !== undefined) s.batch = data.batchId ? W.batches[data.batchId] : null;
      fakeDb.__writes.update++;
      return clone(s);
    },
    async updateMany({ where, data }) {
      const rows = await fakeDb.student.findMany({ where });
      for (const r of rows) await fakeDb.student.update({ where: { id: r.id }, data });
      fakeDb.__writes.updateMany++;
      return { count: rows.length };
    },
  },
  quiz: {
    async findUnique({ where }) {
      const q = W.quizzes[where.id];
      return q ? clone(q) : null;
    },
  },
  homework: {
    async findUnique({ where }) {
      const h = W.homeworks[where.id];
      return h ? clone(h) : null;
    },
    async findMany({ where }) {
      return Object.values(W.homeworks).filter((h) => {
        if (where.lessonId && "in" in where.lessonId && !where.lessonId.in.includes(h.lessonId)) return false;
        if (where.trackScope && !matchCond(h.trackScope, where.trackScope)) return false;
        return true;
      }).map(clone);
    },
  },
  question: {
    async findMany({ where, orderBy }) {
      let rows = Object.values(W.questions).filter((q) => matchQuestion(q, where));
      if (Array.isArray(orderBy)) {
        rows = [...rows].sort((a, b) => {
          for (const o of orderBy) {
            const k = Object.keys(o)[0];
            if (a[k] < b[k]) return o[k] === "asc" ? -1 : 1;
            if (a[k] > b[k]) return o[k] === "asc" ? 1 : -1;
          }
          return 0;
        });
      }
      return rows.map(clone);
    },
  },
  quizAnswer: {
    async findMany({ where }) {
      return W.quizAnswers
        .filter((a) => a.attemptId === where.attemptId)
        .map((a) => ({ ...clone(a), question: clone(W.questions[a.questionId]) }));
    },
    async createMany({ data }) {
      for (const d of data) W.quizAnswers.push({ id: nid("qa"), isCorrect: false, ...d });
      fakeDb.__writes.createMany++;
      return { count: data.length };
    },
    async create({ data }) {
      const row = { id: nid("qa"), isCorrect: false, ...data };
      W.quizAnswers.push(row);
      fakeDb.__writes.create++;
      return clone(row);
    },
    async update({ where, data }) {
      const row = W.quizAnswers.find((a) => a.id === where.id);
      Object.assign(row, data);
      fakeDb.__writes.update++;
      return clone(row);
    },
  },
  quizAttempt: {
    async findMany({ where }) {
      return W.quizAttempts
        .filter((a) => {
          if (where.studentId && !matchCond(a.studentId, where.studentId)) return false;
          if (where.quiz) {
            const quiz = W.quizzes[a.quizId];
            if (!quiz) return false;
            if (where.quiz.lessonId && !matchCond(quiz.lessonId, where.quiz.lessonId)) return false;
          }
          return true;
        })
        .map(clone);
    },
    async findUnique({ where }) {
      const a = W.quizAttempts.find((x) => x.id === where.id);
      if (!a) return null;
      return {
        ...clone(a),
        quiz: {
          questions: Object.values(W.questions)
            .filter((q) => q.quizId === a.quizId)
            .map(clone)
            .sort((x, y) => x.createdAt - y.createdAt || (x.id < y.id ? -1 : 1)),
        },
      };
    },
  },
  batch: {
    async findFirst({ where }) {
      const rows = Object.values(W.batches).filter((b) => matchBatch(b, where));
      rows.sort((a, b) => a.createdAt - b.createdAt);
      return rows[0] ? clone(rows[0]) : null;
    },
    async findUnique({ where }) {
      const b = W.batches[where.id];
      return b ? clone(b) : null;
    },
  },
  lessonProgress: {
    async findMany({ where }) {
      return W.lessonProgress.filter((p) => where.lessonId.in.includes(p.lessonId));
    },
  },
  homeworkSubmission: {
    async findMany({ where }) {
      return W.homeworkSubmissions.filter((h) => where.homeworkId.in.includes(h.homeworkId));
    },
  },
  parent: {
    async findUnique({ where }) {
      const kids = W.parents[where.userId];
      return kids ? { children: kids } : null;
    },
  },
};

fs.writeFileSync(FAKE_DB_PATH, "module.exports = { db: globalThis.__CM_P12_DB__ };\n");
globalThis.__CM_P12_DB__ = fakeDb;

const TS = require(path.join(OUT, "track-scope.js"));
const ST = require(path.join(OUT, "school-type.js"));
const SP = require(path.join(OUT, "session-progress.js"));
const SQ = require(path.join(OUT, "session-quiz.js"));
const EN = require(path.join(OUT, "enrollment.js"));
const PA = require(path.join(OUT, "parent-access.js"));
const QA = require(path.join(OUT, "quiz-analytics.js"));

// ===========================================================================
async function main() {
  // -------------------------------------------------------------------------
  section("1. School type: normalisation of every accepted spelling");
  // -------------------------------------------------------------------------
  for (const v of ["ARABIC", "arabic", "Arabic", "  arabic  ", "AR", "ar", "عربي"]) {
    eq(ST.normalizeSchoolType(v), "ARABIC", `normalizeSchoolType(${JSON.stringify(v)})`);
  }
  for (const v of ["LANGUAGE", "language", "Language", "LANGUAGES", "languages", "LANG", "lang", "لغات"]) {
    eq(ST.normalizeSchoolType(v), "LANGUAGE", `normalizeSchoolType(${JSON.stringify(v)})`);
  }
  eq(ST.normalizeSchoolType(null), null, "null is not a school type");
  eq(ST.normalizeSchoolType(undefined), null, "undefined is not a school type");
  eq(ST.normalizeSchoolType(""), null, "empty string is not a school type");
  eq(ST.normalizeSchoolType(42), null, "a number is not a school type");

  section("2. School type: invalid values are REJECTED by the write-path guard");
  for (const v of ["FRENCH", "arabic-ish", "ARABIC2", {}, [], "عربى"]) {
    const r = ST.requireSchoolType(v);
    ok(r.ok === false, `requireSchoolType(${JSON.stringify(v)}) is rejected`);
  }
  eq(ST.requireSchoolType(null).reason, "EMPTY", "null → EMPTY");
  eq(ST.requireSchoolType("   ").reason, "EMPTY", "blank → EMPTY");
  eq(ST.requireSchoolType("nope").reason, "INVALID", "garbage → INVALID");
  eq(ST.requireSchoolType("arabic"), { ok: true, value: "ARABIC" }, "legacy 'arabic' → ARABIC");
  eq(ST.requireSchoolType("لغات"), { ok: true, value: "LANGUAGE" }, "legacy 'لغات' → LANGUAGE");

  // -------------------------------------------------------------------------
  section("3. Track scope: the CROSS-TRACK GUARANTEE MATRIX");
  // -------------------------------------------------------------------------
  const MATRIX = [
    ["ARABIC", "SHARED", true],
    ["ARABIC", "ARABIC", true],
    ["ARABIC", "LANGUAGE", false],
    ["LANGUAGE", "SHARED", true],
    ["LANGUAGE", "LANGUAGE", true],
    ["LANGUAGE", "ARABIC", false],
  ];
  for (const [student, scope, expected] of MATRIX) {
    eq(
      TS.canAccessTrackScope(student, scope),
      expected,
      `matrix: ${student} student × ${scope} content`
    );
    eq(
      TS.eligibleTrackScopes(student).includes(scope),
      expected,
      `eligibleTrackScopes(${student}) vs ${scope}`
    );
  }

  section("4. Track scope: fail-closed on unknown input (both sides)");
  for (const scope of ["SHARED", "ARABIC", "LANGUAGE"]) {
    eq(TS.canAccessTrackScope(null, scope), scope === "SHARED", `null schoolType × ${scope}`);
    eq(TS.canAccessTrackScope(undefined, scope), scope === "SHARED", `undefined schoolType × ${scope}`);
    eq(TS.canAccessTrackScope("FRENCH", scope), scope === "SHARED", `garbage schoolType × ${scope}`);
  }
  for (const st of ["ARABIC", "LANGUAGE", null]) {
    eq(TS.canAccessTrackScope(st, "BOTH-TRACKS"), false, `unknown scope is refused for ${st}`);
    eq(TS.canAccessTrackScope(st, undefined), false, `undefined scope is refused for ${st}`);
    eq(TS.canAccessTrackScope(st, ""), false, `empty scope is refused for ${st}`);
  }
  eq(TS.normalizeTrackScope("SHARED"), "SHARED", "SHARED normalises");
  eq(TS.normalizeTrackScope("shared"), "SHARED", "'shared' normalises");
  eq(TS.normalizeTrackScope("arabic"), "ARABIC", "a school type is also a track scope");
  eq(TS.normalizeTrackScope("nope"), null, "garbage scope → null (never SHARED)");

  section("5. Track scope: the Prisma predicate is the matrix, expressed as a filter");
  eq(TS.trackScopeWhere("ARABIC"), { trackScope: { in: ["SHARED", "ARABIC"] } }, "ARABIC filter");
  eq(TS.trackScopeWhere("LANGUAGE"), { trackScope: { in: ["SHARED", "LANGUAGE"] } }, "LANGUAGE filter");
  eq(TS.trackScopeWhere(null), { trackScope: { in: ["SHARED"] } }, "null schoolType filter is SHARED-only");
  ok(TS.trackScopeWhere("ARABIC").trackScope.in.length === 2, "the filter is a 2-element list, not a wildcard");

  // -------------------------------------------------------------------------
  section("6. Question bank: selection predicate");
  // -------------------------------------------------------------------------
  eq(TS.eligibleQuestionFilter("ARABIC"), { OR: [{ schoolType: "ARABIC" }, { schoolType: null }] }, "ARABIC bank");
  eq(TS.eligibleQuestionFilter("LANGUAGE"), { OR: [{ schoolType: "LANGUAGE" }, { schoolType: null }] }, "LANGUAGE bank");
  eq(TS.eligibleQuestionFilter(null), { schoolType: null }, "unknown schoolType → SHARED questions only");
  eq(TS.isQuestionEligible("ARABIC", null), true, "ARABIC student × shared question");
  eq(TS.isQuestionEligible("ARABIC", "ARABIC"), true, "ARABIC student × ARABIC question");
  eq(TS.isQuestionEligible("ARABIC", "LANGUAGE"), false, "ARABIC student × LANGUAGE question");
  eq(TS.isQuestionEligible("LANGUAGE", null), true, "LANGUAGE student × shared question");
  eq(TS.isQuestionEligible("LANGUAGE", "LANGUAGE"), true, "LANGUAGE student × LANGUAGE question");
  eq(TS.isQuestionEligible("LANGUAGE", "ARABIC"), false, "LANGUAGE student × ARABIC question");
  eq(TS.isQuestionEligible(null, "ARABIC"), false, "unknown schoolType never gets a tagged question");
  eq(TS.isQuestionEligible("ARABIC", "GARBAGE"), false, "an unrecognised tag is ineligible");

  section("7. Question tagging precedence (§13)");
  eq(TS.resolveQuestionSchoolType("ARABIC", "LANGUAGE"), "ARABIC", "explicit wins over the quiz scope");
  eq(TS.resolveQuestionSchoolType("SHARED", "ARABIC"), null, "explicit SHARED is stored as null");
  eq(TS.resolveQuestionSchoolType("", "ARABIC"), null, "empty string means explicit SHARED");
  eq(TS.resolveQuestionSchoolType(null, "ARABIC"), null, "null means explicit SHARED");
  eq(TS.resolveQuestionSchoolType(undefined, "ARABIC"), "ARABIC", "absent → inherit the ARABIC quiz scope");
  eq(TS.resolveQuestionSchoolType(undefined, "LANGUAGE"), "LANGUAGE", "absent → inherit the LANGUAGE quiz scope");
  eq(TS.resolveQuestionSchoolType(undefined, "SHARED"), null, "absent on a SHARED quiz → SHARED");
  eq(TS.resolveQuestionSchoolType(undefined, undefined), null, "absent with no quiz scope → SHARED");
  ok(TS.parseQuestionSchoolTypeInput(undefined).specified === false, "absent is 'not specified'");
  eq(TS.parseQuestionSchoolTypeInput(null), { ok: true, specified: true, value: null }, "null → explicit SHARED");
  eq(TS.parseQuestionSchoolTypeInput("LANGUAGE"), { ok: true, specified: true, value: "LANGUAGE" }, "LANGUAGE parses");
  ok(TS.parseQuestionSchoolTypeInput("FRENCH").ok === false, "garbage is rejected, not downgraded");
  ok(TS.parseQuestionSchoolTypeInput(7).ok === false, "a non-string is rejected");

  // -------------------------------------------------------------------------
  section("8. LESSON isolation — server-side, via the real progression engine");
  // -------------------------------------------------------------------------
  // Wire the lesson's components so progression has something to gate on, and
  // COMPLETE the first lesson: `canAccessLesson` also enforces the progression
  // lock, so a matrix measured against a locked lesson would be asserting
  // Phase 4 behaviour instead of Phase 12 track scope. With L-SHARED done,
  // every row below is unlocked and the verdict can only come from the track.
  W.lessons["L-SHARED"].quizzes = [{ id: "Q-SHARED" }];
  W.lessons["L-SHARED"].homeworks = [{ id: "H-SHARED" }];
  W.lessons["L-AR"].quizzes = [{ id: "Q-AR-OWN" }];
  W.lessons["L-AR"].homeworks = [{ id: "H-AR-OWN" }];
  W.lessons["L-LANG"].quizzes = [{ id: "Q-LANG-OWN" }];
  W.lessons["L-LANG"].homeworks = [{ id: "H-LANG-OWN" }];
  W.lessonProgress.push({ studentId: "ar-student", lessonId: "L-SHARED", videoPercent: 100, videoCompleted: true, isCompleted: true });
  W.quizAttempts.push({ id: "att-1", quizId: "Q-SHARED", studentId: "ar-student", finishedAt: new Date() });
  W.homeworkSubmissions.push({ homeworkId: "H-SHARED", studentId: "ar-student", submittedAt: new Date() });
  W.lessonProgress.push({ studentId: "lang-student", lessonId: "L-SHARED", videoPercent: 100, videoCompleted: true, isCompleted: true });
  W.quizAttempts.push({ id: "att-2", quizId: "Q-SHARED", studentId: "lang-student", finishedAt: new Date() });
  W.homeworkSubmissions.push({ homeworkId: "H-SHARED", studentId: "lang-student", submittedAt: new Date() });

  const lessonMatrix = [
    ["ar-student", "L-SHARED", true],
    ["ar-student", "L-AR", true],
    ["ar-student", "L-LANG", false],
    ["lang-student", "L-SHARED", true],
    ["lang-student", "L-LANG", true],
    ["lang-student", "L-AR", false],
  ];
  for (const [studentId, lessonId, expected] of lessonMatrix) {
    const a = await SP.canAccessLesson(studentId, lessonId);
    eq(a.allowed, expected, `canAccessLesson(${studentId}, ${lessonId})`);
    if (!expected) {
      // Non-oracle: a cross-track lesson is indistinguishable from a
      // nonexistent one.
      eq(a.reason, "LESSON_NOT_FOUND", `cross-track denial is LESSON_NOT_FOUND for ${lessonId}`);
      eq(a.status, null, `cross-track denial leaks no status row for ${lessonId}`);
    }
  }

  section("9. Wrong course is still refused, and is NOT confused with track");
  {
    const a = await SP.canAccessLesson("ar-student", "L-OTHER");
    eq(a.allowed, false, "ARABIC student cannot open the other course's SHARED lesson");
    eq(a.reason, "NOT_ENROLLED", "the reason is enrollment, not track");
  }

  section("10. PROGRESSION: an ineligible lesson never enters the universe");
  {
    const ar = await SP.getCourseSessionProgress("ar-student", COURSE);
    const arIds = ar.sessions.map((s) => s.lessonId);
    eq(arIds, ["L-SHARED", "L-AR"], "ARABIC universe excludes the LANGUAGE lesson");
    ok(!ar.byLessonId.has("L-LANG"), "L-LANG is absent from the ARABIC lookup map");

    const lang = await SP.getCourseSessionProgress("lang-student", COURSE);
    eq(lang.sessions.map((s) => s.lessonId), ["L-SHARED", "L-LANG"], "LANGUAGE universe excludes the ARABIC lesson");

    // With no ARABIC/LANGUAGE content the universe is the whole curriculum.
    W.lessons["L-AR"].trackScope = "SHARED";
    W.lessons["L-LANG"].trackScope = "SHARED";
    const all = await SP.getCourseSessionProgress("ar-student", COURSE);
    eq(all.sessions.map((s) => s.lessonId), ["L-SHARED", "L-AR", "L-LANG"], "all-SHARED universe is unchanged by Phase 12");
    W.lessons["L-AR"].trackScope = "ARABIC";
    W.lessons["L-LANG"].trackScope = "LANGUAGE";
  }

  section("11. PROGRESSION: an ineligible lesson cannot be an unlock target");
  {
    // L-SHARED is already complete (section 8). For the ARABIC student the next
    // unlock must be L-AR, never L-LANG — even though L-LANG is order 3 and
    // would otherwise follow it.
    const ar = await SP.getCourseSessionProgress("ar-student", COURSE);
    eq(ar.byLessonId.get("L-SHARED").completed, true, "L-SHARED is complete for the ARABIC student");
    eq(ar.byLessonId.get("L-AR").unlocked, true, "L-AR unlocks next");
    eq(ar.byLessonId.get("L-AR").completed, false, "L-AR is not vacuously complete");
    eq(ar.currentLessonId, "L-AR", "the continuation pointer skips the ineligible track entirely");
    ok(ar.currentLessonId !== "L-LANG", "the continuation pointer never lands on the other track");
    ok(!ar.sessions.some((s) => s.lessonId === "L-LANG"), "L-LANG is not an unlock target");

    const unlocked = await SP.getUnlockedLessonIds("ar-student", COURSE);
    ok(!unlocked.has("L-LANG"), "getUnlockedLessonIds never yields the other track");
  }

  section("12. QUIZ isolation — access");
  {
    const qMatrix = [
      ["ar-student", "Q-SHARED", true],
      ["ar-student", "Q-AR", true],
      ["ar-student", "Q-LANG", false],
      ["lang-student", "Q-SHARED", true],
      ["lang-student", "Q-LANG", true],
      ["lang-student", "Q-AR", false],
    ];
    for (const [studentId, quizId, expected] of qMatrix) {
      const a = await SP.canAccessQuiz(studentId, quizId);
      eq(a.allowed, expected, `canAccessQuiz(${studentId}, ${quizId})`);
      if (!expected) eq(a.reason, "LESSON_NOT_FOUND", `cross-track quiz denial is non-oracle for ${quizId}`);
    }
    const missing = await SP.canAccessQuiz("ar-student", "Q-NOPE");
    eq(missing.allowed, false, "a nonexistent quiz is refused");
    eq(missing.reason, "LESSON_NOT_FOUND", "a nonexistent quiz is LESSON_NOT_FOUND");
  }

  section("13. HOMEWORK isolation — access");
  {
    const hMatrix = [
      ["ar-student", "H-SHARED", true],
      ["ar-student", "H-AR", true],
      ["ar-student", "H-LANG", false],
      ["lang-student", "H-SHARED", true],
      ["lang-student", "H-LANG", true],
      ["lang-student", "H-AR", false],
    ];
    for (const [studentId, homeworkId, expected] of hMatrix) {
      const a = await SP.canAccessHomework(studentId, homeworkId);
      eq(a.allowed, expected, `canAccessHomework(${studentId}, ${homeworkId})`);
      if (!expected) eq(a.reason, "LESSON_NOT_FOUND", `cross-track homework denial is non-oracle for ${homeworkId}`);
    }
  }

  section("14. QUIZ isolation — SELECTION (the frozen attempt set)");
  {
    // ARABIC student opens an attempt on the SHARED quiz that holds one
    // question of each tag. Only shared + ARABIC may be frozen in.
    W.quizAnswers = [];
    await SQ.seedAttemptQuestions("attempt-ar", "Q-SHARED", "ARABIC");
    const arSet = W.quizAnswers.filter((a) => a.attemptId === "attempt-ar").map((a) => a.questionId).sort();
    eq(arSet, ["q-ar", "q-shared"], "ARABIC attempt freezes shared + ARABIC questions only");

    W.quizAnswers = [];
    await SQ.seedAttemptQuestions("attempt-lang", "Q-SHARED", "LANGUAGE");
    const langSet = W.quizAnswers.filter((a) => a.attemptId === "attempt-lang").map((a) => a.questionId).sort();
    eq(langSet, ["q-lang", "q-shared"], "LANGUAGE attempt freezes shared + LANGUAGE questions only");

    W.quizAnswers = [];
    await SQ.seedAttemptQuestions("attempt-none", "Q-SHARED", null);
    const noneSet = W.quizAnswers.filter((a) => a.attemptId === "attempt-none").map((a) => a.questionId);
    eq(noneSet, ["q-shared"], "a student with no school type gets SHARED questions only");
  }

  section("15. QUIZ isolation — SERVING narrows even a pre-existing frozen set");
  {
    // Simulate an attempt created BEFORE Phase 12: it holds a LANGUAGE
    // question that this ARABIC student must never see.
    W.quizAnswers = [
      { id: "a1", attemptId: "legacy-ar", questionId: "q-shared", selected: "", isCorrect: false },
      { id: "a2", attemptId: "legacy-ar", questionId: "q-ar", selected: "", isCorrect: false },
      { id: "a3", attemptId: "legacy-ar", questionId: "q-lang", selected: "", isCorrect: false },
    ];
    W.quizAttempts = [{ id: "legacy-ar", quizId: "Q-SHARED", studentId: "ar-student", finishedAt: null }];

    const served = await SQ.loadAttemptQuestionSet("legacy-ar", "ARABIC");
    eq(served.map((q) => q.questionId).sort(), ["q-ar", "q-shared"], "the LANGUAGE row is dropped from the served set");
    ok(!served.some((q) => q.questionId === "q-lang"), "q-lang is never served to an ARABIC student");

    const servedLang = await SQ.loadAttemptQuestionSet("legacy-ar", "LANGUAGE");
    eq(servedLang.map((q) => q.questionId).sort(), ["q-lang", "q-shared"], "the same attempt serves a LANGUAGE student differently");
  }

  section("16. QUIZ isolation — GRADING (an ineligible question never earns credit)");
  {
    const fullSet = [
      { answerId: "a1", questionId: "q-shared", selected: "", question: W.questions["q-shared"] },
      { answerId: "a2", questionId: "q-ar", selected: "", question: W.questions["q-ar"] },
      { answerId: "a3", questionId: "q-lang", selected: "", question: W.questions["q-lang"] },
    ];
    const allCorrect = [
      { questionId: "q-shared", selected: "1" },
      { questionId: "q-ar", selected: "1" },
      { questionId: "q-lang", selected: "1" },
    ];

    const ar = SQ.gradeAttemptQuestionSet(fullSet, allCorrect, 60, "ARABIC");
    eq(ar.totalMarks, 2, "ARABIC grading counts 2 marks (shared + ARABIC), not 3");
    eq(ar.score, 2, "ARABIC student scores full marks on their eligible set");
    eq(ar.percentage, 100, "the denominator shrank, so the percentage is not deflated");
    eq(ar.graded.map((g) => g.questionId).sort(), ["q-ar", "q-shared"], "the LANGUAGE question is absent from the result");

    const lang = SQ.gradeAttemptQuestionSet(fullSet, allCorrect, 60, "LANGUAGE");
    eq(lang.totalMarks, 2, "LANGUAGE grading counts 2 marks (shared + LANGUAGE)");
    eq(lang.graded.map((g) => g.questionId).sort(), ["q-lang", "q-shared"], "the ARABIC question is absent from the result");

    // A crafted answer for the ineligible question must earn nothing.
    const crafted = SQ.gradeAttemptQuestionSet(
      [{ answerId: "a3", questionId: "q-lang", selected: "", question: W.questions["q-lang"] }],
      [{ questionId: "q-lang", selected: "1" }],
      60,
      "ARABIC"
    );
    eq(crafted.totalMarks, 0, "a set containing only an ineligible question grades to zero marks");
    eq(crafted.score, 0, "an ineligible question can never receive credit");
    eq(crafted.graded.length, 0, "and never appears in the graded output");

    // Selection and grading agree: grading the SELECTED set is a no-op change.
    const selectedAr = fullSet.filter((e) => TS.isQuestionEligible("ARABIC", e.question.schoolType));
    const agree = SQ.gradeAttemptQuestionSet(selectedAr, allCorrect, 60, "ARABIC");
    eq(agree.totalMarks, ar.totalMarks, "grading the selected set matches grading the full set");
    eq(agree.score, ar.score, "score is identical either way");
  }

  section("17. Live-quiz set (direct submit / retake) uses the same predicate");
  {
    const ar = await SQ.loadQuizQuestionSet("Q-SHARED", "ARABIC");
    eq(ar.map((q) => q.questionId).sort(), ["q-ar", "q-shared"], "ARABIC live set");
    const lang = await SQ.loadQuizQuestionSet("Q-SHARED", "LANGUAGE");
    eq(lang.map((q) => q.questionId).sort(), ["q-lang", "q-shared"], "LANGUAGE live set");
    const none = await SQ.loadQuizQuestionSet("Q-SHARED", null);
    eq(none.map((q) => q.questionId), ["q-shared"], "unknown school type live set is SHARED only");
  }

  // -------------------------------------------------------------------------
  section("18. BATCH reconciliation — healing and idempotency (§12, §24)");
  // -------------------------------------------------------------------------
  {
    W = world();
    // ARABIC student in course-1 → the course-specific ARABIC batch.
    let r = await EN.reconcileStudentBatch("ar-student");
    eq(r.batchId, "b-ar", "ARABIC student → ARABIC batch of their course");
    eq(r.reason, "ASSIGNED", "first run assigns");
    eq(r.changed, true, "first run writes");

    r = await EN.reconcileStudentBatch("ar-student");
    eq(r.batchId, "b-ar", "second run keeps the same batch");
    eq(r.changed, false, "second run writes nothing (idempotent)");
    eq(r.reason, "OK", "second run reports OK");

    r = await EN.reconcileStudentBatch("lang-student");
    eq(r.batchId, "b-lang", "LANGUAGE student → LANGUAGE batch");

    // Type change ARABIC → LANGUAGE must REPLACE the batch.
    W.students["ar-student"].schoolType = "LANGUAGE";
    r = await EN.reconcileStudentBatch("ar-student");
    eq(r.batchId, "b-lang", "ARABIC → LANGUAGE moves the student");
    eq(r.reason, "REPLACED", "the move is reported as REPLACED");
    eq(W.students["ar-student"].batchId, "b-lang", "the stored batchId was updated");

    // …and back.
    W.students["ar-student"].schoolType = "ARABIC";
    r = await EN.reconcileStudentBatch("ar-student");
    eq(r.batchId, "b-ar", "LANGUAGE → ARABIC moves the student back");
    eq(r.changed, true, "the move back writes");
  }

  section("19. BATCH: an invalid / missing school type is never guessed at");
  {
    W = world();
    W.students["none-student"].schoolType = "FRENCH";
    let r = await EN.reconcileStudentBatch("none-student");
    eq(r.reason, "NO_SCHOOL_TYPE", "an unrecognised school type is refused");
    eq(r.changed, false, "and nothing is written");
    eq(r.batchId, null, "no batch is invented");

    W.students["none-student"].schoolType = null;
    r = await EN.reconcileStudentBatch("none-student");
    eq(r.reason, "NO_SCHOOL_TYPE", "a null school type is refused too");
    eq(r.changed, false, "and nothing is written");

    // A wrong batch already attached is NOT silently kept, and no batch is
    // invented either.
    W.students["none-student"].batchId = "b-ar";
    W.students["none-student"].batch = W.batches["b-ar"];
    r = await EN.reconcileStudentBatch("none-student");
    eq(r.changed, false, "with no school type the reconciler never writes");
  }

  section("20. BATCH: a student is NEVER assigned another course's batch");
  {
    W = world();
    // The ARABIC batch of course-2 exists; an ARABIC student of course-2 must
    // get it, while a course-1 student must not.
    const other = await EN.reconcileStudentBatch("other-course");
    eq(other.batchId, "b-ar-other", "a course-2 student gets the course-2 ARABIC batch");

    const c1 = await EN.reconcileStudentBatch("ar-student");
    eq(c1.batchId, "b-ar", "a course-1 student gets the course-1 ARABIC batch");
    ok(c1.batchId !== other.batchId, "the two students are in different batches");

    // A stale course-2 batch on a course-1 student is CLEARED, not kept.
    W.students["ar-student"].batchId = "b-ar-other";
    W.students["ar-student"].batch = W.batches["b-ar-other"];
    // Remove the correct course-1 batch so rule 3 applies.
    delete W.batches["b-ar"];
    const healed = await EN.reconcileStudentBatch("ar-student");
    eq(healed.reason, "CLEARED", "a wrong-course batch with no replacement is cleared");
    eq(healed.batchId, null, "the student is left with no batch rather than the wrong one");
  }

  section("21. BATCH: course change reconciles (the sticky batchId bug)");
  {
    W = world();
    await EN.reconcileStudentBatch("ar-student");
    eq(W.students["ar-student"].batchId, "b-ar", "starts in the course-1 batch");

    // Move the student's group to the other course.
    W.students["ar-student"].group = { courseId: OTHER_COURSE, isActive: true, course: { id: OTHER_COURSE } };
    const r = await EN.reconcileStudentBatch("ar-student");
    eq(r.batchId, "b-ar-other", "the batch follows the course");
    eq(r.reason, "REPLACED", "reported as a replacement");
  }

  section("22. BATCH: inactive batches are ignored; reconciliation is idempotent twice");
  {
    W = world();
    delete W.batches["b-ar"];
    const r = await EN.reconcileStudentBatch("ar-student");
    eq(r.batchId, null, "the inactive ARABIC batch is not used");
    eq(r.reason, "NO_BATCH", "reported as NO_BATCH");
    const r2 = await EN.reconcileStudentBatch("ar-student");
    eq(r2.changed, false, "a second run over the same state writes nothing");
  }

  section("23. BATCH: attaching a new batch never reassigns an existing one");
  {
    W = world();
    W.students["ar-student"].batchId = "b-ar";
    W.students["lang-student"].batchId = null;
    const attached = await EN.attachUnassignedStudentsToBatch("b-lang");
    eq(attached, 1, "exactly the unattached LANGUAGE student was attached");
    eq(W.students["ar-student"].batchId, "b-ar", "the already-attached student was left alone");
    eq(W.students["lang-student"].batchId, "b-lang", "the unattached one got the batch");
    const again = await EN.attachUnassignedStudentsToBatch("b-lang");
    eq(again, 0, "running it again attaches nobody (idempotent)");
  }

  // -------------------------------------------------------------------------
  section("24. SESSION VIDEO track semantics (§11, §23)");
  // -------------------------------------------------------------------------
  eq(TS.videoTrackFilter("ARABIC"), { batch: { schoolType: "ARABIC" } }, "ARABIC videos only");
  eq(TS.videoTrackFilter("LANGUAGE"), { batch: { schoolType: "LANGUAGE" } }, "LANGUAGE videos only");
  {
    const none = TS.videoTrackFilter(null);
    ok(
      Array.isArray(none.batch.schoolType.in) && none.batch.schoolType.in.length === 0,
      "no school type → an impossible filter (no videos), never both tracks"
    );
    const garbage = TS.videoTrackFilter("FRENCH");
    ok(garbage.batch.schoolType.in.length === 0, "garbage school type → no videos");
  }
  // The matrix, expressed against the batch the video belongs to.
  const videoMatrix = [
    ["ARABIC", "ARABIC", true],
    ["ARABIC", "LANGUAGE", false],
    ["LANGUAGE", "LANGUAGE", true],
    ["LANGUAGE", "ARABIC", false],
    [null, "ARABIC", false],
    [null, "LANGUAGE", false],
  ];
  for (const [student, batch, expected] of videoMatrix) {
    const f = TS.videoTrackFilter(student);
    const allowed =
      "schoolType" in f.batch && typeof f.batch.schoolType === "string"
        ? f.batch.schoolType === batch
        : f.batch.schoolType.in.includes(batch);
    eq(allowed, expected, `video matrix: ${student} student × ${batch} batch`);
  }

  // -------------------------------------------------------------------------
  section("25. PARENT scope follows the CHILD's track (§16)");
  // -------------------------------------------------------------------------
  {
    const arOnly = await PA.getParentTrackScopes("p-ar-only");
    ok(arOnly.has("SHARED") && arOnly.has("ARABIC") && !arOnly.has("LANGUAGE"), "parent of an ARABIC child: SHARED + ARABIC");
    const langOnly = await PA.getParentTrackScopes("p-lang-only");
    ok(langOnly.has("SHARED") && langOnly.has("LANGUAGE") && !langOnly.has("ARABIC"), "parent of a LANGUAGE child: SHARED + LANGUAGE");
    const both = await PA.getParentTrackScopes("p-both");
    ok(both.has("ARABIC") && both.has("LANGUAGE"), "a parent of both tracks sees both");

    ok(await PA.isParentAllowedTrackScope("p-ar-only", "ARABIC"), "ARABIC parent may preview ARABIC");
    ok(!(await PA.isParentAllowedTrackScope("p-ar-only", "LANGUAGE")), "ARABIC parent may NOT preview LANGUAGE");
    ok(await PA.isParentAllowedTrackScope("p-lang-only", "LANGUAGE"), "LANGUAGE parent may preview LANGUAGE");
    ok(!(await PA.isParentAllowedTrackScope("p-lang-only", "ARABIC")), "LANGUAGE parent may NOT preview ARABIC");
    ok(await PA.isParentAllowedTrackScope("p-ar-only", "SHARED"), "SHARED is always previewable");
    ok(!(await PA.isParentAllowedTrackScope("p-ar-only", "GARBAGE")), "an unrecognised scope is refused, not treated as SHARED");
    ok(!(await PA.isParentAllowedTrackScope("p-ar-only", undefined)), "a missing scope is refused");

    // A parent of an UNSPECIFIED child gets SHARED only.
    const noneKid = await PA.getParentTrackScopes("p-none-child");
    eq([...noneKid].sort(), ["SHARED"], "a parent of an unspecified child gets SHARED only");
  }

  // -------------------------------------------------------------------------
  section("26. Analytics primitives are track-safe and preserve Phase 6 rules");
  // -------------------------------------------------------------------------
  {
    const att = (id, quizId, percentage, passed, finished, track) => ({
      id, quizId, studentId: "s", score: percentage, totalMarks: 100, percentage, passed,
      finishedAt: finished ? new Date() : null, __track: track,
    });
    const attempts = [
      att("1", "qa", 80, true, true, "ARABIC"),
      att("2", "qa", 40, false, true, "ARABIC"),
      att("3", "ql", 90, true, true, "LANGUAGE"),
      att("4", "qs", 70, true, true, "SHARED"),
      att("5", "qa", 100, true, false, "ARABIC"), // OPEN — must be ignored
    ];
    const byTrack = QA.summarizeFinishedAttemptsByTrack(attempts, (a) => a.__track);
    eq(byTrack.ARABIC.attemptCount, 2, "ARABIC bucket counts finished attempts only");
    eq(byTrack.LANGUAGE.attemptCount, 1, "LANGUAGE bucket");
    eq(byTrack.SHARED.attemptCount, 1, "SHARED bucket");
    eq(byTrack.ARABIC.avgScore, 60, "ARABIC avgScore is over finished attempts (attempt-weighted)");

    const partitioned = QA.partitionByTrack(
      [{ t: null }, { t: "ARABIC" }, { t: "LANGUAGE" }, { t: "weird" }],
      (x) => x.t
    );
    eq(partitioned.SHARED.length, 2, "null and unrecognised tags report as SHARED (never dropped)");
    eq(partitioned.ARABIC.length, 1, "ARABIC bucket");
    eq(partitioned.LANGUAGE.length, 1, "LANGUAGE bucket");
    eq(Object.keys(partitioned).sort(), ["ARABIC", "LANGUAGE", "SHARED"], "all three buckets always exist");
    eq(QA.trackBucketOf(null), "SHARED", "a shared question reports as SHARED");
    eq(QA.trackBucketOf("LANGUAGE"), "LANGUAGE", "a tagged question keeps its bucket");
  }

  // -------------------------------------------------------------------------
  section("27. Official curriculum invariants survive the track dimension");
  // -------------------------------------------------------------------------
  {
    // A lesson's officialCode is UNIQUE, so track metadata cannot create a
    // second row for the same code.
    const schema = read("prisma/schema.prisma");
    const lessonModel = schema.slice(schema.indexOf("model Lesson {"), schema.indexOf("model Group {"));
    ok(/officialCode\s+String\?\s+@unique/.test(lessonModel), "Lesson.officialCode is still UNIQUE");
    ok(/trackScope\s+TrackScope\s+@default\(SHARED\)/.test(lessonModel), "Lesson.trackScope defaults to SHARED");
    ok(!/officialCode\[\]/.test(lessonModel), "there is no array of official codes (no per-track duplicates)");
  }

  // =========================================================================
  section("28. SOURCE INVARIANTS — the routes enforce track server-side");
  // =========================================================================
  const courseRoute = read("src/app/api/courses/[slug]/route.ts");
  ok(/viewerTrackFilter/.test(courseRoute), "courses/[slug] computes a viewer track slice");
  ok(/getStudentSchoolType/.test(courseRoute), "courses/[slug] derives the student's track from the server");
  ok(/getParentTrackScopes/.test(courseRoute), "courses/[slug] resolves a parent's track from their children");
  ok(
    (courseRoute.match(/\.\.\.viewerTrackFilter/g) || []).length >= 2,
    "courses/[slug] applies the slice to BOTH curriculum chains"
  );

  const lessonRoute = read("src/app/api/lessons/[id]/route.ts");
  ok(/viewerTrackFilter/.test(lessonRoute), "lessons/[id] computes a viewer track slice");
  ok((lessonRoute.match(/\.\.\.viewerTrackFilter/g) || []).length >= 3, "lessons/[id] filters quizzes, homework AND prev/next");
  ok(/isParentAllowedTrackScope/.test(lessonRoute), "lessons/[id] gates parent preview by the child's track");

  const quizRoute = read("src/app/api/quizzes/[id]/route.ts");
  ok(/isQuestionEligible/.test(quizRoute), "quizzes/[id] filters the served questions by track");
  ok(/loadAttemptQuestionSet\(open\.id, schoolType\)/.test(quizRoute), "quizzes/[id] loads the frozen set with the student's track");
  ok(/isParentAllowedTrackScope/.test(quizRoute), "quizzes/[id] gates parent preview by the child's track");

  const startRoute = read("src/app/api/quizzes/[id]/start/route.ts");
  ok(/seedAttemptQuestions\(attempt\.id, id, schoolType\)/.test(startRoute), "start freezes only eligible questions");
  ok(/getStudentSchoolType\(student\.id\)/.test(startRoute), "start derives the track server-side");

  const submitRoute = read("src/app/api/quizzes/[id]/submit/route.ts");
  ok(/loadAttemptQuestionSet\(open\.id, schoolType\)/.test(submitRoute), "submit loads the frozen set with the student's track");
  ok(/loadQuizQuestionSet\(id, schoolType\)/.test(submitRoute), "submit's retake path is track-filtered too");
  ok(/gradeAttemptQuestionSet\(set, answersRaw, quiz\.passMark, schoolType\)/.test(submitRoute), "grading enforces the same track rule");

  const homeworkRoute = read("src/app/api/students/me/homework/route.ts");
  ok(/trackScopeWhere\(schoolType\)/.test(homeworkRoute), "the homework list is track-filtered");

  const videosRoute = read("src/app/api/students/me/session-videos/route.ts");
  ok(/videoTrackFilter\(enrollment\.schoolType\)/.test(videosRoute), "session videos are track-filtered");
  ok(/isPublished: true/.test(videosRoute), "the published requirement is still enforced");
  ok(/batchId,/.test(videosRoute), "the batch authorization is still enforced");

  const mediaRoute = read("src/app/api/media/[id]/route.ts");
  ok(/v\.batch\.schoolType === studentSchoolType/.test(mediaRoute), "media requires the batch track to match the student");
  ok(/v\.isPublished/.test(mediaRoute), "media still requires the video to be published");
  ok(/v\.batchId === student\.batchId/.test(mediaRoute), "media still requires batch membership");

  const engine = read("src/lib/session-progress.ts");
  ok(/\.\.\.trackScopeWhere\(resolvedSchoolType\)/.test(engine), "the progression universe is track-filtered");
  ok(/canAccessTrackScope\(schoolType, lesson\.trackScope\)/.test(engine), "canAccessLesson has an explicit track gate");
  ok(/gateTrackedResource/.test(engine), "quiz/homework gating shares one track implementation");

  const teacherQuiz = read("src/app/api/teacher/quizzes/route.ts");
  ok(/trackScope: quizTrackScope/.test(teacherQuiz), "teacher quiz creation stores an explicit trackScope");
  ok(/schoolType: questionSchoolType/.test(teacherQuiz), "teacher question creation stores an explicit schoolType");
  ok(/parseQuestionSchoolTypeInput\(q\.schoolType\)\.ok/.test(teacherQuiz), "an invalid question school type is rejected");

  const authRoute = read("src/app/api/auth/[action]/route.ts");
  ok(/requireSchoolType\(body\.schoolType\)/.test(authRoute), "registration validates the school type");
  ok(/reconcileStudentBatch/.test(authRoute), "registration reconciles the batch");

  const adminUpdate = read("src/app/api/admin/students/[id]/route.ts");
  ok(/requireSchoolType\(body\.schoolType\)/.test(adminUpdate), "admin update validates the school type");
  ok(/schoolTypeChanged \|\| groupChanged/.test(adminUpdate), "admin update reconciles on BOTH school type and course change");

  const enrollRoute = read("src/app/api/enroll/route.ts");
  ok(/reconcileStudentBatch\(student\.id\)/.test(enrollRoute), "self-enrollment reconciles the batch (course change)");

  section("28b. DENOMINATOR & EMBEDDED-LIST surfaces are track-scoped too");
  // A completion percentage whose DENOMINATOR counts lessons of the other
  // school type is wrong the moment any lesson is tagged, and a dashboard that
  // embeds a homework list is a content surface even though it is not the
  // homework endpoint. These five were found by auditing every route that
  // reads track-scoped content, not just the obvious ones.
  {
    const studentDash = read("src/app/api/students/me/dashboard/route.ts");
    ok(
      /getStudentSchoolType\(student\.id\)/.test(studentDash),
      "students/me/dashboard derives the viewer track server-side"
    );
    ok(
      (studentDash.match(/\.\.\.viewerTrack,/g) || []).length >= 2,
      "students/me/dashboard slices BOTH the lesson universe and the homework list"
    );

    const cert = read("src/app/api/students/me/certificate/route.ts");
    ok(
      /const studentTrack = trackScopeWhere\(student\.schoolType\)/.test(cert),
      "certificate derives the student's track"
    );
    ok(
      (cert.match(/\.\.\.studentTrack,/g) || []).length >= 2,
      "certificate filters BOTH the total and the completed denominator"
    );
    ok(
      cert.indexOf("...studentTrack,") < cert.indexOf("pct >= 80"),
      "the 80% threshold is computed from the filtered counts"
    );

    const parentDash = read("src/app/api/parents/me/dashboard/route.ts");
    ok(
      /const childTrack = trackScopeWhere\(student\.schoolType\)/.test(parentDash),
      "parents/me/dashboard slices per CHILD, not to the parent's union"
    );
    ok(
      (parentDash.match(/\.\.\.childTrack,/g) || []).length >= 2,
      "parents/me/dashboard slices BOTH the universe and the homework list"
    );

    for (const rel of ["parents/me/analytics", "parents/me/weekly-report"]) {
      const src = read(`src/app/api/${rel}/route.ts`);
      ok(
        /trackScopeInWhere\(await getParentTrackScopes\(user\.id\)\)/.test(src),
        `${rel} slices the universe to the union of the linked children's tracks`
      );
    }
  }

  section("29. SECURITY BOUNDARY — no track decision trusts the client");
  {
    // The authorization inputs must come from server-side lookups only.
    const suspects = [courseRoute, lessonRoute, quizRoute, startRoute, submitRoute, homeworkRoute, videosRoute];
    for (const [i, src] of suspects.entries()) {
      ok(
        !/trackScope:\s*(body|params|req\.|url\.searchParams)/.test(src),
        `route #${i} never takes trackScope from the request`
      );
      ok(
        !/schoolType\s*=\s*(body|params|url\.searchParams)/.test(src),
        `route #${i} never takes schoolType from the request`
      );
    }
    // track-scope.ts DOCUMENTS that it never consults the client locale, so
    // strip comments before asserting no runtime locale read exists.
    const codeOnly = read("src/lib/track-scope.ts")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");
    ok(!/locale|Accept-Language|headers\(\)/i.test(codeOnly), "track-scope.ts never reads the UI locale or headers");
  }

  section("30. SCHEMA + MIGRATION invariants");
  {
    const schema = read("prisma/schema.prisma");
    ok(/enum TrackScope \{\s*SHARED\s+ARABIC\s+LANGUAGE\s*\}/.test(schema), "TrackScope enum has exactly SHARED/ARABIC/LANGUAGE");
    ok(/schoolType\s+SchoolType\?/.test(schema), "Student.schoolType is the SchoolType enum");
    ok(!/schoolType\s+String\?/.test(schema), "Student.schoolType is no longer a free-form String");
    const quizModel = schema.slice(schema.indexOf("model Quiz {"), schema.indexOf("model Question {"));
    ok(/trackScope\s+TrackScope\s+@default\(SHARED\)/.test(quizModel), "Quiz.trackScope exists with a SHARED default");
    const hwModel = schema.slice(schema.indexOf("model Homework {"), schema.indexOf("model HomeworkSubmission {"));
    ok(/trackScope\s+TrackScope\s+@default\(SHARED\)/.test(hwModel), "Homework.trackScope exists with a SHARED default");
    ok(/DEPRECATED \/ DEAD SCHEMA/.test(schema), "Enrollment is formally documented as dead schema");
    ok(/DEPRECATED \/ FUTURE SCHEMA/.test(schema), "Track is formally documented as unused schema");

    const migration = read(
      "prisma/migrations/20260909120000_phase12_track_architecture/migration.sql"
    );
    const firstNormalise = migration.indexOf("UPDATE \"Student\" SET \"schoolType\"");
    const firstDdl = migration.indexOf("CREATE TABLE \"new_Lesson\"");
    ok(firstNormalise > -1, "the migration normalises Student.schoolType");
    ok(firstDdl > -1, "the migration adds the trackScope columns");
    ok(firstNormalise < firstDdl, "normalisation runs BEFORE the enum column change");
    ok(/NOT IN \('ARABIC', 'LANGUAGE'\)/.test(migration), "unrecognised school types are handled explicitly");
    ok(!/DROP DATABASE|DROP TABLE "Student"|DELETE FROM/i.test(migration), "the migration deletes no data");
    ok(
      (migration.match(/INSERT INTO "new_/g) || []).length === 3,
      "all three rebuilt tables copy their rows (Lesson, Quiz, Homework)"
    );
    ok(/"trackScope" TEXT NOT NULL DEFAULT 'SHARED'/.test(migration), "trackScope is NOT NULL with a SHARED default");
  }

  Module._resolveFilename = originalResolve;
}

main()
  .then(() => {
    console.log(`\ntrack architecture (phase 12): ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error("UNEXPECTED ERROR:", e);
    process.exit(1);
  });
