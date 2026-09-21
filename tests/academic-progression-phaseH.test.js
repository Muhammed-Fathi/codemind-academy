// CodeMind Academy — Phase H: canonical academic progression / access engine.
//
// 43 scenario groups over the ONE authority for Lesson LOCKED / UNLOCKED /
// COMPLETED (`src/lib/progression.ts`), its catch-up resolution companion
// (`src/lib/catchup.ts`, acting strictly THROUGH the Phase F authority) and
// the thin `src/lib/session-progress.ts` adapter.
//
// APPROVED CONTRACT (corrective patch, session-video-requirement revision):
// video requiredness is Lesson.videoUrl OR >=1 REQUIRED recording (OPTIONAL
// recordings are never progression inputs — Phase B M2, revised); a REQUIRED
// recording gates with its OWN threshold, satisfied by LIVE percent; a
// PUBLISHED + track-eligible quiz is a requirement regardless of pool state
// (pool problems fail loud, never silently drop); `state` is the EFFECTIVE
// state (never COMPLETED-while-locked) while `completed` stays the
// historical fact.
//
//   Scenarios  1–12  pure core: chain, vacuity, thresholds, requirements,
//                     hold boundary, overrides, reasons, current lesson.
//   Scenarios 13–19  loader: dual-chain universe, lifecycle/track slicing,
//                     requirement candidacy (status + track only);
//                     CASE 17f–17j: REQUIRED recordings (own threshold,
//                     live satisfaction, batch isolation, fail-closed).
//   Scenarios 20–25  single-lesson access verdicts (non-oracle, fail-closed).
//   Scenarios 26–30  admin override grant / revoke / list (+ audit).
//   Scenarios 31–34  catch-up eligibility + Phase F resolution.
//   Scenarios 35–38  derived-completion sync, façade agreement, no second
//                     lifecycles, determinism + read-only evaluation.
//
// Behavioural: the shipped TypeScript is compiled with tsc and exercised
// against an in-memory mock Prisma client. Run:
//   node tests/academic-progression-phaseH.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { execFileSync } = require("child_process");
const fs = require("fs");
const Module = require("module");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Compile the shipped modules under test.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseH-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      moduleResolution: "node",
      strict: false,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      rootDir: REPO,
      outDir: OUT,
    },
    files: [
      "src/lib/progression.ts",
      "src/lib/catchup.ts",
      "src/lib/session-progress.ts",
    ].map((f) => path.join(REPO, f)),
  })
);
try {
  execFileSync(
    process.execPath,
    [path.join(REPO, "node_modules/typescript/lib/tsc.js"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch {
  // The repo's own typecheck is the authoritative gate; what matters here is
  // that the JS under test was emitted (stale generated-client types must not
  // block the behavioural suite).
}
const EMIT = path.join(OUT, "src", "lib");
for (const f of ["progression.js", "catchup.js", "session-progress.js"]) {
  if (!fs.existsSync(path.join(EMIT, f))) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// In-memory mock Prisma client (subset emulator, same contract as phase 19).
// ---------------------------------------------------------------------------
function makeMockDb() {
  const t = {
    user: [], student: [], course: [], group: [], part: [], unit: [], topic: [],
    lesson: [], quiz: [], question: [], homework: [], homeworkSubmission: [],
    quizAttempt: [], lessonProgress: [], sessionVideo: [], sessionVideoView: [],
    absenceHold: [], absenceReview: [], progressionOverride: [], subscription: [],
    auditLog: [], batch: [], mediaAsset: [],
  };
  const clone = (v) => (v === undefined ? v : structuredClone(v));
  const byId = (arr, id) => arr.find((r) => r.id === id) || null;
  let seq = 1;
  const writes = [];

  function relOf(table, row, key) {
    const k = `${table}.${key}`;
    switch (k) {
      case "lesson.unit": return row.unitId ? byId(t.unit, row.unitId) : null;
      case "lesson.topic": return row.topicId ? byId(t.topic, row.topicId) : null;
      case "lesson.quizzes": return t.quiz.filter((q) => q.lessonId === row.id);
      case "lesson.homeworks": return t.homework.filter((h) => h.lessonId === row.id);
      case "unit.part": return byId(t.part, row.partId);
      case "topic.unit": return byId(t.unit, row.unitId);
      case "part.course": return byId(t.course, row.courseId);
      case "student.group": return row.groupId ? byId(t.group, row.groupId) : null;
      case "student.batch": return row.batchId ? byId(t.batch, row.batchId) : null;
      case "sessionVideo.batch": return row.batchId ? byId(t.batch, row.batchId) : null;
      case "sessionVideo.media": return row.mediaAssetId ? byId(t.mediaAsset, row.mediaAssetId) : null;
      case "student.subscription": return t.subscription.find((s) => s.studentId === row.id) || null;
      case "group.course": return byId(t.course, row.courseId);
      case "quiz.questions": return t.question.filter((q) => q.quizId === row.id);
      case "absenceHold.absenceReview": return row.absenceReviewId ? byId(t.absenceReview, row.absenceReviewId) : null;
      default: return undefined;
    }
  }
  const TABLE_OF = {
    "lesson.unit": "unit", "lesson.topic": "topic", "lesson.quizzes": "quiz",
    "lesson.homeworks": "homework", "unit.part": "part", "topic.unit": "unit",
    "part.course": "course", "student.group": "group", "student.batch": "batch",
    "sessionVideo.batch": "batch", "sessionVideo.media": "mediaAsset",
    "student.subscription": "subscription", "group.course": "course",
    "quiz.questions": "question", "absenceHold.absenceReview": "absenceReview",
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
          let good = true;
          if ("gte" in v) good = good && row[k] >= v.gte;
          if ("gt" in v) good = good && row[k] > v.gt;
          if ("lte" in v) good = good && row[k] <= v.lte;
          if ("lt" in v) good = good && row[k] < v.lt;
          if ("equals" in v) good = good && row[k] === v.equals;
          return good;
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

  function project(table, row, select, include) {
    if (!row) return row;
    const applySpec = (relTable, r, spec) => {
      if (spec === true) return clone(r);
      const s = spec || {};
      return project(relTable, r, s.select || null, s.include || null);
    };
    const resolve = (key, spec) => {
      const relTable = TABLE_OF[`${table}.${key}`];
      const val = relOf(table, row, key);
      if (val === undefined || val === null) return val ?? null;
      if (Array.isArray(val)) {
        const s = spec === true ? {} : spec || {};
        let arr = val;
        if (s.where) arr = arr.filter((r) => matches(r, s.where, relTable));
        if (s.orderBy) arr = sortRows(arr, s.orderBy);
        if (s.take !== undefined) arr = arr.slice(0, s.take);
        return arr.map((r) => applySpec(relTable, r, spec));
      }
      return applySpec(relTable, val, spec);
    };
    if (select) {
      const out = {};
      for (const [k, v] of Object.entries(select)) {
        out[k] = v === true ? clone(row[k]) : (v && typeof v === "object" ? resolve(k, v) : clone(row[k]));
      }
      return out;
    }
    const out = clone(row);
    if (include) {
      for (const [k, v] of Object.entries(include)) out[k] = resolve(k, v);
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
        if (w.studentId_lessonId) {
          row = t[table].find((r) => r.studentId === w.studentId_lessonId.studentId && r.lessonId === w.studentId_lessonId.lessonId);
        } else {
          const keys = Object.keys(w);
          row = t[table].find((r) => keys.every((k) => r[k] === w[k]));
        }
        return row ? project(table, row, args.select || null, args.include || null) : null;
      },
      async count(args = {}) { return t[table].filter((r) => matches(r, args.where, table)).length; },
      async create({ data }) {
        writes.push({ table, op: "create" });
        const row = { id: `${table}-${seq++}`, ...clone(data) };
        if (row.createdAt === undefined) row.createdAt = new Date();
        t[table].push(row);
        return clone(row);
      },
      async update({ where, data }) {
        writes.push({ table, op: "update" });
        const keys = Object.keys(where || {});
        const row = t[table].find((r) => keys.every((k) => r[k] === where[k]));
        if (row) Object.assign(row, clone(data));
        return clone(row || null);
      },
      async updateMany({ where, data }) {
        writes.push({ table, op: "updateMany" });
        const hit = t[table].filter((r) => matches(r, where, table));
        hit.forEach((r) => Object.assign(r, clone(data)));
        return { count: hit.length };
      },
      async upsert({ where, create, update }) {
        const w = where.studentId_lessonId || where;
        const keys = Object.keys(w);
        const isCompound = !!where.studentId_lessonId;
        const row = t[table].find((r) => keys.every((k) => (isCompound ? r[k] === w[k] : r[k] === w[k])));
        if (row) {
          writes.push({ table, op: "update" });
          Object.assign(row, clone(update));
          return clone(row);
        }
        writes.push({ table, op: "create" });
        const fresh = { id: `${table}-${seq++}`, ...clone(create) };
        t[table].push(fresh);
        return clone(fresh);
      },
      async deleteMany({ where } = {}) {
        writes.push({ table, op: "deleteMany" });
        const hit = t[table].filter((r) => matches(r, where, table));
        hit.forEach((r) => t[table].splice(t[table].indexOf(r), 1));
        return { count: hit.length };
      },
    };
  }

  const db = { __tables: t, __writes: writes, __reads: {} };
  for (const name of Object.keys(t)) {
    const d = delegate(name);
    if (name === "sessionVideo" || name === "sessionVideoView" || name === "question") {
      for (const k of ["findMany", "findFirst", "findUnique", "count"]) {
        const fn = d[k];
        d[k] = async (...a) => {
          db.__reads[name] = (db.__reads[name] || 0) + 1;
          return fn(...a);
        };
      }
    }
    db[name] = d;
  }
  return db;
}

global.__MOCK_DB__ = makeMockDb();
fs.writeFileSync(path.join(OUT, "fake-db.js"), "module.exports = { db: global.__MOCK_DB__ };\n");
fs.writeFileSync(
  path.join(OUT, "prisma-stub.js"),
  "module.exports = new Proxy({}, { get: () => function noop() {} });\n"
);
const realResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "fake-db.js");
  if (request === "@prisma/client") return path.join(OUT, "prisma-stub.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return realResolve.call(this, request, ...rest);
};

const progression = require(path.join(EMIT, "progression.js"));
const catchup = require(path.join(EMIT, "catchup.js"));
const facade = require(path.join(EMIT, "session-progress.js"));

// ---------------------------------------------------------------------------
// Fixture — one course, dual chains, every requirement shape.
// ---------------------------------------------------------------------------
const NOW = new Date("2026-09-15T12:00:00.000Z");
const D = (daysAgo) => new Date(NOW.getTime() - daysAgo * 86400000);
const FUT = (daysAhead) => new Date(NOW.getTime() + daysAhead * 86400000);

function seed() {
  const T = global.__MOCK_DB__.__tables;
  T.user.push({ id: "u-admin", name: "Admin One", email: "admin@test.local" });
  T.course.push({ id: "c1", slug: "c1", name: "Course 1", nameAr: "كورس 1" });
  T.part.push({ id: "p1", courseId: "c1", title: "Part 1", titleAr: "ج1", order: 1 });
  T.unit.push({ id: "u1", partId: "p1", title: "Unit 1", titleAr: "و1", order: 1 });
  T.topic.push({ id: "t1", unitId: "u1", title: "Topic 1", titleAr: "م1", order: 1 });
  const L = (id, o) => ({
    id, officialCode: null, curriculumStatus: "OFFICIAL", trackScope: "SHARED",
    status: "PUBLISHED", isPublished: true, unitId: "u1", topicId: null,
    title: id, titleAr: id, order: 1, description: null, summary: null,
    duration: 90, isLocked: false, videoUrl: null, pdfUrl: null, ...o,
  });
  T.lesson.push(
    L("l1", { order: 1, videoUrl: "https://videos/l1" }),
    L("l2", { order: 2 }), // pool-less PUBLISHED quiz (a requirement); optional recordings ignored
    L("l3", { order: 3 }), // quiz + CLOSED homework
    L("l5", { order: 4 }), // component-less (its OPTIONAL recording is not a requirement)
    L("l4", { order: 1, unitId: null, topicId: "t1", videoUrl: "https://videos/l4" }),
    L("lx", { curriculumStatus: "ARCHIVED", videoUrl: "https://videos/lx" }),
    L("ld", { status: "DRAFT", isPublished: false }),
    L("lg", { trackScope: "LANGUAGE", videoUrl: "https://videos/lg" }),
  );
  T.quiz.push(
    { id: "q1", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l1", title: "Q1", titleAr: "Q1", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "qx", status: "PUBLISHED", trackScope: "LANGUAGE", lessonId: "l1", title: "QX", titleAr: "QX", description: null, passMark: 60, timeLimit: null, order: 1 },
    { id: "qd", status: "DRAFT", trackScope: "SHARED", lessonId: "l1", title: "QD", titleAr: "QD", description: null, passMark: 60, timeLimit: null, order: 2 },
    { id: "qe", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l2", title: "QE", titleAr: "QE", description: null, passMark: 60, timeLimit: null, order: 0 },
    { id: "q3", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l3", title: "Q3", titleAr: "Q3", description: null, passMark: 60, timeLimit: null, order: 0 },
  );
  const Q = (id, quizId) => ({
    id, quizId, type: "MCQ", prompt: `p-${id}`, promptAr: null, options: '["a","b"]',
    answer: "0", explanation: null, difficulty: "MEDIUM", marks: 1, schoolType: null, createdAt: D(5),
  });
  T.question.push(Q("qt1", "q1"), Q("qtx", "qx"), Q("qt3", "q3")); // qe + qd: empty pools
  T.homework.push(
    { id: "h1", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l1", title: "H1", titleAr: "H1", instructions: "do", deadline: FUT(5), maxMarks: 10, createdAt: D(10) },
    { id: "hx", status: "PUBLISHED", trackScope: "LANGUAGE", lessonId: "l1", title: "HX", titleAr: "HX", instructions: "do", deadline: FUT(5), maxMarks: 10, createdAt: D(10) },
    { id: "hc", status: "CLOSED", trackScope: "SHARED", lessonId: "l3", title: "HC", titleAr: "HC", instructions: "do", deadline: D(1), maxMarks: 10, createdAt: D(10) },
  );
  T.batch.push(
    { id: "b1", schoolType: "ARABIC", courseId: "c1", isActive: true, createdAt: D(30) },
    { id: "b9", schoolType: "LANGUAGE", courseId: "c1", isActive: true, createdAt: D(30) },
  );
  // Session-video requirement revision: the seed videos are OPTIONAL (no
  // flag — the schema default), so CASE 17a–17e pin the preserved M2
  // behaviour for them; their media is managed (measurable) so a REQUIRED
  // flip would be expressible.
  T.mediaAsset.push(
    { id: "m1", kind: "VIDEO", storage: "LOCAL_PRIVATE", isPrivate: true },
    { id: "m5", kind: "VIDEO", storage: "LOCAL_PRIVATE", isPrivate: true },
    { id: "m9", kind: "VIDEO", storage: "LOCAL_PRIVATE", isPrivate: true },
  );
  T.sessionVideo.push(
    { id: "v1", batchId: "b1", lessonId: "l2", mediaAssetId: "m1", isPublished: true, requiredPercent: 80 },
    { id: "v5", batchId: "b1", lessonId: "l5", mediaAssetId: "m5", isPublished: true, requiredPercent: 95 },
    { id: "v9", batchId: "b9", lessonId: "l2", mediaAssetId: "m9", isPublished: true, requiredPercent: 95 },
  );
  T.group.push(
    { id: "g1", name: "G1", courseId: "c1", teacherId: null, capacity: 20, schedule: null, isActive: true, createdAt: D(60) },
    { id: "g2", name: "G2", courseId: "c1", teacherId: null, capacity: 20, schedule: null, isActive: true, createdAt: D(60) },
  );
  T.student.push(
    { id: "s1", userId: "u-s1", grade: "2nd Secondary", schoolName: "Nile", schoolType: "ARABIC", nationalId: null, parentPhone: null, studentCode: "CM-S1", groupId: "g1", batchId: "b1", enrolledAt: D(60) },
    { id: "s2", userId: "u-s2", grade: "2nd Secondary", schoolName: "Nile", schoolType: "LANGUAGE", nationalId: null, parentPhone: null, studentCode: "CM-S2", groupId: "g2", batchId: "b9", enrolledAt: D(60) },
    { id: "s3", userId: "u-s3", grade: "2nd Secondary", schoolName: "Nile", schoolType: "ARABIC", nationalId: null, parentPhone: null, studentCode: "CM-S3", groupId: null, batchId: null, enrolledAt: D(60) },
  );
  T.subscription.push(
    { id: "sub1", studentId: "s1", planId: null, status: "ACTIVE", startDate: D(10), endDate: FUT(20), createdAt: D(10) },
    { id: "sub2", studentId: "s2", planId: null, status: "ACTIVE", startDate: D(10), endDate: FUT(20), createdAt: D(10) },
  );
  // s1: l1 fully done; l2 own-batch video watched; l3 quiz FAILED + open + CLOSED hw unsubmitted.
  T.lessonProgress.push({
    id: "lp-s1-l1", studentId: "s1", lessonId: "l1", progress: 100, isCompleted: false,
    lastViewedAt: D(1), videoDurationSec: 600, videoWatchedSec: 600, videoPercent: 100,
    videoCompleted: true, videoCompletedAt: D(1), lastHeartbeatAt: D(1),
  });
  T.quizAttempt.push(
    { id: "a-q1", quizId: "q1", studentId: "s1", score: 9, totalMarks: 10, percentage: 90, passed: true, startedAt: D(2), finishedAt: D(2), cameraStatus: "NOT_REQUESTED" },
    { id: "a-q3-fail", quizId: "q3", studentId: "s1", score: 4, totalMarks: 10, percentage: 40, passed: false, startedAt: D(1), finishedAt: D(1), cameraStatus: "NOT_REQUESTED" },
    { id: "a-q3-open", quizId: "q3", studentId: "s1", score: 0, totalMarks: 10, percentage: 0, passed: false, startedAt: D(0), finishedAt: null, cameraStatus: "NOT_REQUESTED" },
  );
  T.homeworkSubmission.push({
    id: "hs-h1", homeworkId: "h1", studentId: "s1", content: "done", fileUrl: null,
    submittedAt: D(1), grade: null, feedback: null, status: "SUBMITTED",
  });
  T.sessionVideoView.push(
    { id: "sv-s1-v1", studentId: "s1", sessionVideoId: "v1", percent: 85, isCompleted: false },
    { id: "sv-s2-v9", studentId: "s2", sessionVideoId: "v9", percent: 100, isCompleted: true },
  );
  // Legacy TRUE marker on a derived-INCOMPLETE lesson (monotonicity probe).
  T.lessonProgress.push({
    id: "lp-s1-l4", studentId: "s1", lessonId: "l4", progress: 100, isCompleted: true,
    lastViewedAt: D(20), videoDurationSec: 600, videoWatchedSec: 180, videoPercent: 30,
    videoCompleted: false, videoCompletedAt: null, lastHeartbeatAt: D(20),
  });
}

function coreFacts(over = {}) {
  return {
    legacyVideoByLesson: new Map(),
    passedQuizIds: new Set(),
    passedAttemptByQuiz: new Map(),
    submittedHomeworkIds: new Set(),
    submissionByHomework: new Map(),
    ...over,
  };
}
const coreLesson = (id, order, over = {}) => ({
  id, order, hasLegacyVideo: false, quizIds: [], homeworkIds: [], ...over,
});

async function main() {
  seed();
  const db = global.__MOCK_DB__;

  section("Pure core — chain, empty-lesson boundary, thresholds, requirements");
  {
    // CASE 1 (manual-QA stabilization): a lesson with ZERO requirements is
    // NEVER completed. The first reachable empty lesson is UNLOCKED +
    // incomplete (the boundary, with its reason); the next stays LOCKED.
    let r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1), coreLesson("b", 2)],
      facts: coreFacts(), holds: [], overrides: [],
    });
    const e1 = new Map(r.lessons.map((l) => [l.lessonId, l]));
    ok(e1.get("a").unlocked && !e1.get("a").completed && e1.get("a").state === "UNLOCKED", "CASE 1a: first reachable empty lesson is UNLOCKED + incomplete");
    ok(e1.get("a").reasonCode === "NO_COMPLETION_REQUIREMENTS" && /متطلبات إكمال/.test(e1.get("a").reason || ""), "CASE 1b: the boundary carries its Arabic reason + stable code");
    ok(!e1.get("b").unlocked && !e1.get("b").completed && e1.get("b").state === "LOCKED" && e1.get("b").reasonCode === "PREVIOUS_INCOMPLETE", "CASE 1c: the lesson after an empty predecessor stays LOCKED");
    ok(r.currentLessonId === "a", "CASE 1d: the empty boundary is the current lesson");

    // CASE 2: strict chain — L3 locked while L2 incomplete, even with L3's own facts done.
    r = progression.evaluateProgressionCore({
      lessons: [
        coreLesson("a", 1, { quizIds: ["qa"] }),
        coreLesson("b", 2, { quizIds: ["qb"] }),
        coreLesson("c", 3, { quizIds: ["qc"] }),
      ],
      facts: coreFacts({ passedQuizIds: new Set(["qa", "qc"]) }),
      holds: [], overrides: [],
    });
    const byId = new Map(r.lessons.map((l) => [l.lessonId, l]));
    ok(byId.get("a").completed && byId.get("b").completed === false && byId.get("c").completed, "CASE 2a: completion derives per-lesson from facts");
    // EFFECTIVE state: the fact stays COMPLETED (own facts done — history is
    // preserved), but the state is LOCKED with the chain reason attached. A
    // UI branching on `state` can never show this lesson as done-or-open.
    const c = byId.get("c");
    ok(byId.get("b").unlocked && !c.unlocked, "CASE 2b: strict chain holds L3 locked behind incomplete L2");
    ok(c.completed === true && c.state === "LOCKED", "CASE 2c: fact COMPLETED + effective LOCKED (history preserved, access refused)");
    ok(c.reasonCode === "PREVIOUS_INCOMPLETE" && c.unmet.length > 0 && typeof c.reason === "string", "CASE 2d: the block carries reason + structured unmet");

    // CASE 3: completed-but-locked reopens nothing downstream.
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["qx"] }), coreLesson("b", 2), coreLesson("c", 3)],
      facts: coreFacts(),
      holds: [], overrides: [],
    });
    const m = new Map(r.lessons.map((l) => [l.lessonId, l]));
    ok(!m.get("a").completed && !m.get("b").completed && !m.get("c").completed, "CASE 3a: downstream empty lessons are incomplete while L1 is incomplete (no vacuous completion)");
    ok(m.get("a").unlocked && !m.get("b").unlocked && !m.get("c").unlocked, "CASE 3b: locked lessons reopen nothing downstream (no skip via shrinkage)");

    // CASE 4: legacy video threshold is exactly 95 (94 incomplete, 95 complete).
    const vid = (pct) => coreFacts({ legacyVideoByLesson: new Map([["a", { percent: pct, completed: false, completedAt: null }]]) });
    const at94 = progression.evaluateProgressionCore({ lessons: [coreLesson("a", 1, { hasLegacyVideo: true })], facts: vid(94), holds: [], overrides: [] });
    const at95 = progression.evaluateProgressionCore({ lessons: [coreLesson("a", 1, { hasLegacyVideo: true })], facts: vid(95), holds: [], overrides: [] });
    ok(!at94.lessons[0].completed && at95.lessons[0].completed, "CASE 4: 94% incomplete, 95% complete");

    // CASE 5: no videoUrl → NO video requirement (required false, done true,
    // value 100). Recordings are not a core input at all. (The lesson carries
    // a passed quiz so the case still proves completability without video —
    // a fully empty lesson is a boundary per CASE 1, loader proof in CASE 17.)
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["q"] })],
      facts: coreFacts({ passedQuizIds: new Set(["q"]) }),
      holds: [], overrides: [],
    });
    ok(r.lessons[0].video.required === false && r.lessons[0].video.done && r.lessons[0].video.value === 100 && r.lessons[0].completed, "CASE 5: videoUrl-less lesson has no video requirement");

    // CASE 6: the legacy completed flag also satisfies (fact shape coverage).
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { hasLegacyVideo: true })],
      facts: coreFacts({ legacyVideoByLesson: new Map([["a", { percent: 0, completed: true, completedAt: NOW.toISOString() }]]) }),
      holds: [], overrides: [],
    });
    ok(r.lessons[0].completed && r.lessons[0].video.done, "CASE 6: legacy videoCompleted flag satisfies the video requirement");

    // CASE 7: EVERY required quiz must pass.
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["q1", "q2"] })],
      facts: coreFacts({ passedQuizIds: new Set(["q1"]) }),
      holds: [], overrides: [],
    });
    ok(!r.lessons[0].completed && r.lessons[0].reasonCode === "QUIZ_NOT_PASSED", "CASE 7: one unpassed quiz blocks the lesson");

    // CASE 8: EVERY required homework submitted; grading never gates.
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { homeworkIds: ["h1", "h2"] })],
      facts: coreFacts({ submittedHomeworkIds: new Set(["h1", "h2"]) }),
      holds: [], overrides: [],
    });
    ok(r.lessons[0].completed, "CASE 8: submission (any verdict) satisfies; grading latency never gates");
  }

  section("Pure core — holds, overrides, reasons, current lesson");
  {
    const three = [coreLesson("a", 1, { quizIds: ["qa"] }), coreLesson("b", 2, { quizIds: ["q"] }), coreLesson("c", 3)];
    // CASE 9: hold boundary — missed lesson open, after locked, completed-before stays accessible.
    let r = progression.evaluateProgressionCore({
      lessons: three, facts: coreFacts({ passedQuizIds: new Set(["qa"]) }), holds: [{ holdId: "h", reviewId: "r", sessionId: "s", lessonId: "a" }], overrides: [],
    });
    let m = new Map(r.lessons.map((l) => [l.lessonId, l]));
    ok(m.get("a").unlocked && !m.get("a").unmet.includes("ABSENCE_HOLD"), "CASE 9a: the missed lesson itself stays open (no hold unmet on it)");
    ok(!m.get("b").unlocked && m.get("b").reasonCode === "ABSENCE_HOLD", "CASE 9b: lessons after the missed one lock with ABSENCE_HOLD");
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["qa"] }), coreLesson("b", 2, { quizIds: ["qb"] })],
      facts: coreFacts({ passedQuizIds: new Set(["qa", "qb"]) }),
      holds: [{ holdId: "h", reviewId: "r", sessionId: "s", lessonId: "a" }],
      overrides: [],
    });
    ok(r.lessons[1].unlocked && r.lessons[1].completed, "CASE 9c: historical COMPLETED lessons stay accessible past the boundary");

    // CASE 10: override grants its NAMED lesson only.
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["q"] }), coreLesson("b", 2), coreLesson("c", 3)],
      facts: coreFacts(),
      holds: [],
      overrides: [{ overrideId: "o", lessonId: "b", reason: "makeup", grantedAt: NOW.toISOString(), expiresAt: null }],
    });
    m = new Map(r.lessons.map((l) => [l.lessonId, l]));
    ok(m.get("b").unlocked && m.get("b").override?.overrideId === "o" && !m.get("b").completed && m.get("b").state === "UNLOCKED", "CASE 10a: the named lesson opens by exception — access only, facts untouched");
    ok(!m.get("c").unlocked, "CASE 10b: the override grants one lesson — downstream stays locked");

    // CASE 11: Arabic reasons on locked, null when open; primary code first.
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["q"] }), coreLesson("b", 2)],
      facts: coreFacts(), holds: [], overrides: [],
    });
    m = new Map(r.lessons.map((l) => [l.lessonId, l]));
    ok(typeof m.get("a").reason === "string" && m.get("a").reason.length > 0 && m.get("a").reasonCode === "QUIZ_NOT_PASSED", "CASE 11a: open-but-incomplete lesson names its unmet requirement in Arabic");
    ok(m.get("b").reasonCode === "PREVIOUS_INCOMPLETE" && /اللي قبله/.test(m.get("b").reason), "CASE 11b: locked lesson leads with the chain reason");
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["q"] })],
      facts: coreFacts({ passedQuizIds: new Set(["q"]) }),
      holds: [], overrides: [],
    });
    ok(r.lessons[0].completed && r.lessons[0].reason === null && r.lessons[0].reasonCode === null && r.lessons[0].unmet.length === 0, "CASE 11c: satisfied lesson → null reason, empty unmet");

    // CASE 12: current lesson = first unlocked-incomplete.
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["qa"] }), coreLesson("b", 2, { quizIds: ["q"] }), coreLesson("c", 3)],
      facts: coreFacts({ passedQuizIds: new Set(["qa"]) }), holds: [], overrides: [],
    });
    ok(r.currentLessonId === "b", "CASE 12: current lesson skips completed, stops at first open incomplete");
  }

  section("Loader — universe, lifecycle, track, candidacy");
  {
    // CASE 13: dual-chain universe; archived / DRAFT / cross-track excluded; deterministic order.
    const p1 = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    eqIds(p1.lessons.map((l) => l.lessonId), ["l1", "l2", "l3", "l5", "l4"], "CASE 13: s1 universe = canonical-first dual chain, lx/ld/lg excluded, stable order");
    const p2 = await progression.loadCourseProgression("s2", "c1", { now: NOW });
    ok(p2.lessons.some((l) => l.lessonId === "lg") && !p2.lessons.some((l) => l.lessonId === "lx" || l.lessonId === "ld"), "CASE 13b: LANGUAGE student sees lg (same exclusion rules)");

    // CASE 14: DRAFT quiz never a requirement; CLOSED homework IS one.
    const l1 = p1.byLessonId.get("l1"), l3 = p1.byLessonId.get("l3");
    ok(l1.completed && l1.unlocked && l1.state === "COMPLETED", "CASE 14a: l1 complete (q1 passed + h1 submitted + video)");
    ok(l1.completed, "CASE 14a2: DRAFT qd excluded (l1 complete with qd unpassed)");
    ok(l3.quiz.required && !l3.quiz.done, "CASE 14b: q3 required and unsatisfied (failed attempt ≠ pass, open attempt ignored)");
    ok(l3.assignment.required && !l3.assignment.done, "CASE 14c: CLOSED homework is still a requirement until submitted");

    // CASE 15: PUBLISHED + track-eligible = requirement, pool or no pool.
    // qe is pool-less AND unpassed → it genuinely BLOCKS l2 (progression
    // waits for repair/deletion/pass; nothing is silently dropped).
    const l2 = p1.byLessonId.get("l2");
    ok(l2.quiz.required && !l2.quiz.done, "CASE 15a: pool-less PUBLISHED qe REMAINS an l2 requirement");
    ok(!l2.completed && l2.unlocked && l2.state === "UNLOCKED", "CASE 15a2: l2 open-but-incomplete behind the unpassed gate quiz");
    ok(l1.completed, "CASE 15b: cross-track qx/hx excluded for the ARABIC student (l1 still complete)");
    const s2l1 = p2.byLessonId.get("l1");
    ok(!s2l1.completed && !s2l1.quiz.done && !s2l1.assignment.done, "CASE 15c: the SAME rows ARE requirements for the LANGUAGE student (slicing is per-student)");

    // CASE 16: attempted-but-failed satisfies nothing (loader level); the
    // corrected quiz rule breaks the chain at l2, so l3 is chain-locked.
    ok(l2.reasonCode === "QUIZ_NOT_PASSED", "CASE 16a: l2 names its unmet gate quiz");
    ok(!l3.completed && !l3.unlocked && l3.state === "LOCKED" && l3.reasonCode === "PREVIOUS_INCOMPLETE", "CASE 16b: failed + open attempts leave l3 unsatisfied AND chain-locked behind l2");

    // CASE 17: OPTIONAL recordings are NEVER requirements (Phase B M2,
    // revised). l2 carries two published OPTIONAL batch videos (v1 watched
    // 85%, v9 foreign) and l5 one (v5 unwatched) — the video dimension
    // stays not-required throughout.
    ok(l2.video.required === false && l2.video.done, "CASE 17a: published OPTIONAL batch videos create no video requirement (l2)");
    const l5 = p1.byLessonId.get("l5");
    ok(l5.video.required === false && !l5.completed, "CASE 17b: unwatched OPTIONAL recording creates no requirement; empty l5 is incomplete (boundary)");
    ok(l5.state === "LOCKED" && !l5.unlocked && l5.reasonCode === "PREVIOUS_INCOMPLETE", "CASE 17c: loader-level effective state — incomplete behind the chain, state LOCKED, chain reason attached");
    ok(db.__reads.sessionVideo === 2 && (db.__reads.sessionVideoView || 0) === 0 && (db.__reads.question || 0) === 0, "CASE 17d: the loader scans required recordings per evaluation (2 calls above, 2 scans); views unread while nothing is required; pools never");
    // Retroactive publish: an OPTIONAL recording added AFTER completion changes nothing.
    db.__tables.sessionVideo.push({ id: "v-late", batchId: "b1", lessonId: "l1", isPublished: true, requiredPercent: 95 });
    const pLate = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    ok(pLate.byLessonId.get("l1").completed && pLate.byLessonId.get("l1").video.required, "CASE 17e: late-published OPTIONAL recording neither breaks l1 nor widens its video rule");
    db.__tables.sessionVideo.splice(db.__tables.sessionVideo.findIndex((v) => v.id === "v-late"), 1);
    // CASE 17f–17j: REQUIRED recordings ARE progression inputs (the Phase B
    // M2 revision): published + own batch + track-eligible + REQUIRED joins
    // the lesson's video requirement with its OWN threshold, satisfied by
    // LIVE watch percent. Fresh rows per scenario — removed afterwards, so
    // no later case observes them.
    const addReqVideo = ({ id, batchId, lessonId, requiredPercent, storage, title }) => {
      db.__tables.mediaAsset.push({ id: `m-${id}`, kind: "VIDEO", storage, isPrivate: true });
      db.__tables.sessionVideo.push({
        id, batchId, lessonId, mediaAssetId: `m-${id}`, isPublished: true,
        requiredPercent, isRequiredForProgression: true, title: title ?? id, titleAr: title ?? id,
      });
    };
    const dropReqVideo = (id) => {
      const vt = db.__tables.sessionVideo;
      vt.splice(vt.findIndex((v) => v.id === id), 1);
      const mt = db.__tables.mediaAsset;
      mt.splice(mt.findIndex((m) => m.id === `m-${id}`), 1);
      const wt = db.__tables.sessionVideoView;
      for (let i = wt.length - 1; i >= 0; i--) {
        if (wt[i].sessionVideoId === id) wt.splice(i, 1);
      }
    };
    addReqVideo({ id: "v-req5", batchId: "b1", lessonId: "l5", requiredPercent: 95, storage: "LOCAL_PRIVATE", title: "Req 5" });
    const pReq5 = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    const l5req = pReq5.byLessonId.get("l5");
    ok(l5req.video.required === true && l5req.video.done === false, "CASE 17f: a required recording creates a video requirement (unwatched → unmet)");
    ok(l5req.video.requiredCount === 1 && l5req.video.completedCount === 0, "CASE 17f: counts name 0 of 1");
    ok(l5req.video.items?.length === 1 && l5req.video.items[0].id === "v-req5" && l5req.video.items[0].trackable === true && l5req.video.items[0].currentPercent === 0 && l5req.video.items[0].completed === false, "CASE 17f: the item carries identity + trackable + live verdict");
    ok(l5req.video.items[0].title === "Req 5" && l5req.video.items[0].requiredPercent === 95, "CASE 17f: the item carries title + own threshold");
    // l5 sits behind failed l4, so unmet names the CHAIN here (the video
    // code itself is pinned on open l2 in CASE 17i/17j).
    ok(l5req.completed === false, "CASE 17f: the lesson is incomplete");
    db.__tables.sessionVideoView.push({ id: "sv-s1-v-req5", studentId: "s1", sessionVideoId: "v-req5", percent: 100, isCompleted: true });
    const pReq5b = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    const l5sat = pReq5b.byLessonId.get("l5");
    ok(l5sat.video.required === true && l5sat.video.done === true, "CASE 17g: a 100% live watch satisfies the required recording");
    ok(l5sat.video.completedCount === 1 && l5sat.video.items[0].completed === true && l5sat.video.items[0].currentPercent === 100, "CASE 17g: counts + item flip to complete");
    dropReqVideo("v-req5");
    addReqVideo({ id: "v-req9", batchId: "b9", lessonId: "l2", requiredPercent: 95, storage: "LOCAL_PRIVATE", title: "Req 9" });
    const pS1 = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    ok(pS1.byLessonId.get("l2").video.required === false, "CASE 17h: another batch's required recording is invisible to s1 (batch isolation)");
    const pS2a = await progression.loadCourseProgression("s2", "c1", { now: NOW });
    const s2l2 = pS2a.byLessonId.get("l2");
    ok(s2l2.video.required === true && s2l2.video.done === false && (s2l2.video.items ?? []).every((it) => it.id === "v-req9"), "CASE 17h: s2's own-batch required recording gates s2 (unwatched → unmet)");
    db.__tables.sessionVideoView.push({ id: "sv-s2-v-req9", studentId: "s2", sessionVideoId: "v-req9", percent: 96, isCompleted: true });
    const pS2b = await progression.loadCourseProgression("s2", "c1", { now: NOW });
    ok(pS2b.byLessonId.get("l2").video.done === true, "CASE 17h: s2 satisfies their own recording at 96%");
    dropReqVideo("v-req9");
    addReqVideo({ id: "v-req1", batchId: "b1", lessonId: "l2", requiredPercent: 80, storage: "LOCAL_PRIVATE", title: "Req 1" });
    db.__tables.sessionVideoView.push({ id: "sv-s1-v-req1", studentId: "s1", sessionVideoId: "v-req1", percent: 85, isCompleted: false });
    const pThr = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    ok(pThr.byLessonId.get("l2").video.required === true && pThr.byLessonId.get("l2").video.done === true, "CASE 17i: an 85% watch satisfies a custom 80% threshold");
    // Retroactive raise: the SAME 85% row no longer satisfies 90% — the live
    // comparison bites without rewriting any sticky flag.
    db.__tables.sessionVideo.find((v) => v.id === "v-req1").requiredPercent = 90;
    const pThr2 = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    const l2thr = pThr2.byLessonId.get("l2");
    ok(l2thr.video.required === true && l2thr.video.done === false && l2thr.video.items[0].completed === false && l2thr.video.items[0].currentPercent === 85, "CASE 17i: raising the threshold to 90% unmets the frozen 85% row (live rule)");
    ok(l2thr.completed === false && l2thr.unmet.includes("VIDEO_INCOMPLETE"), "CASE 17i: open l2 names the video gap as its blocker");
    dropReqVideo("v-req1");
    addReqVideo({ id: "v-reqx", batchId: "b1", lessonId: "l2", requiredPercent: 80, storage: "EXTERNAL_URL", title: "Req X" });
    db.__tables.sessionVideoView.push({ id: "sv-s1-v-reqx", studentId: "s1", sessionVideoId: "v-reqx", percent: 85, isCompleted: true });
    const pExt = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    const l2x = pExt.byLessonId.get("l2");
    ok(l2x.video.required === true && l2x.video.done === false, "CASE 17j: a required-but-untrackable recording fails CLOSED (percent-passing yet unmet)");
    ok(l2x.video.items[0].trackable === false && l2x.video.items[0].currentPercent === 85 && l2x.video.items[0].completed === false, "CASE 17j: the item names untrackable + frozen percent + unmet");
    ok(l2x.completed === false && l2x.unmet.includes("VIDEO_INCOMPLETE"), "CASE 17j: the lesson stays incomplete with the video code");
    dropReqVideo("v-reqx");

    // CASE 19 (before holds/overrides mutate the world): expiry + revocation.
    db.__tables.progressionOverride.push(
      { id: "ov-expired", studentId: "s1", lessonId: "l5", reason: "old grant", createdByUserId: "u-admin", createdAt: D(9), expiresAt: D(1), revokedAt: null, revokedByUserId: null, revokeReason: null },
      { id: "ov-revoked", studentId: "s1", lessonId: "l5", reason: "bad grant", createdByUserId: "u-admin", createdAt: D(2), expiresAt: null, revokedAt: D(1), revokedByUserId: "u-admin", revokeReason: "mistake" },
    );
    const pExp = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    ok(!pExp.byLessonId.get("l5").unlocked && pExp.byLessonId.get("l5").override === null, "CASE 19: expired + revoked overrides grant nothing");
  }

  function eqIds(a, b, label) {
    ok(JSON.stringify(a) === JSON.stringify(b), `${label} (got ${JSON.stringify(a)})`);
  }

  section("Access verdicts — non-oracle, fail-closed");
  {
    // CASE 20: missing / DRAFT ids are indistinguishable (404, no oracle).
    const miss = await progression.evaluateLessonAccess("s1", "nope", { now: NOW });
    const draft = await progression.evaluateLessonAccess("s1", "ld", { now: NOW });
    ok(!miss.allowed && miss.reason === "LESSON_NOT_FOUND" && miss.evaluation === null, "CASE 20a: missing id → LESSON_NOT_FOUND, no evaluation");
    ok(!draft.allowed && draft.reason === "LESSON_NOT_FOUND" && draft.evaluation === null, "CASE 20b: DRAFT id answers exactly like a missing id");

    // CASE 21: archived history is not openable.
    const arch = await progression.evaluateLessonAccess("s1", "lx", { now: NOW });
    ok(!arch.allowed && arch.reason === "LESSON_NOT_FOUND", "CASE 21: ARCHIVED lesson → LESSON_NOT_FOUND");

    // CASE 22: enrollment gates everything; overrides never bypass it.
    const unenr = await progression.evaluateLessonAccess("s3", "l1", { now: NOW });
    ok(!unenr.allowed && unenr.reason === "NOT_ENROLLED", "CASE 22a: student with no group → NOT_ENROLLED");
    db.__tables.progressionOverride.push({
      id: "ov-s3", studentId: "s3", lessonId: "l1", reason: "should not help", createdByUserId: "u-admin",
      createdAt: D(1), expiresAt: null, revokedAt: null, revokedByUserId: null, revokeReason: null,
    });
    const unenrOv = await progression.evaluateLessonAccess("s3", "l1", { now: NOW });
    ok(!unenrOv.allowed && unenrOv.reason === "NOT_ENROLLED", "CASE 22b: even a live override never bypasses enrollment");

    // CASE 23: cross-track lesson is a 404, not a 403.
    const xtrack = await progression.evaluateLessonAccess("s1", "lg", { now: NOW });
    ok(!xtrack.allowed && xtrack.reason === "LESSON_NOT_FOUND" && xtrack.evaluation === null, "CASE 23: other track's lesson → LESSON_NOT_FOUND");

    // CASE 24: chain lock carries the evaluation (explain without leaking).
    const locked = await progression.evaluateLessonAccess("s1", "l5", { now: NOW });
    ok(!locked.allowed && locked.reason === "PREVIOUS_SESSION_INCOMPLETE", "CASE 24a: locked-behind-chain → PREVIOUS_SESSION_INCOMPLETE");
    ok(locked.evaluation?.reasonCode === "PREVIOUS_INCOMPLETE" && typeof locked.evaluation?.reason === "string", "CASE 24b: denial carries the Arabic reason + code");

    // CASE 25: open lesson allowed with its evaluation (l2: chain-open,
    // incomplete behind its unpassed gate quiz).
    const open = await progression.evaluateLessonAccess("s1", "l2", { now: NOW });
    ok(open.allowed && open.reason === null && open.evaluation?.lessonId === "l2" && open.courseId === "c1", "CASE 25: open lesson → allowed with evaluation + course");
  }

  section("Admin overrides — grant, revoke, list, audit");
  {
    // CASE 26: grant validation (reason, expiry, existence).
    let g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "l5", reason: "  ", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "OVERRIDE_REASON_REQUIRED", "CASE 26a: blank reason refused");
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "l5", reason: "ab", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "OVERRIDE_REASON_REQUIRED", "CASE 26b: short reason refused");
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "l5", reason: "x".repeat(501), actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "OVERRIDE_REASON_TOO_LONG", "CASE 26c: over-long reason refused");
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "l5", reason: "ok reason", expiresAt: D(1).toISOString(), actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "OVERRIDE_EXPIRY_PAST", "CASE 26d: past expiry refused");
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "l5", reason: "ok reason", expiresAt: "not-a-date", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "OVERRIDE_EXPIRY_INVALID", "CASE 26e: invalid expiry refused");
    g = await progression.grantProgressionOverride({ studentId: "ghost", lessonId: "l5", reason: "ok reason", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "STUDENT_NOT_FOUND", "CASE 26f: unknown student refused");
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "ghost", reason: "ok reason", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "LESSON_NOT_FOUND", "CASE 26g: unknown lesson refused");

    // CASE 27: grant scope — lifecycle, course, track are never bypassed.
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "ld", reason: "ok reason", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "LESSON_NOT_GRANTABLE", "CASE 27a: DRAFT lesson not grantable");
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "lx", reason: "ok reason", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "LESSON_NOT_GRANTABLE", "CASE 27b: ARCHIVED lesson not grantable");
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "lg", reason: "ok reason", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "TRACK_DENIED", "CASE 27c: cross-track lesson not grantable");
    g = await progression.grantProgressionOverride({ studentId: "s3", lessonId: "l1", reason: "ok reason", actorUserId: "u-admin", now: NOW });
    ok(!g.ok && g.code === "LESSON_NOT_IN_COURSE", "CASE 27d: unenrolled student's lesson not grantable");

    // CASE 28: grant creates + audits; re-grant replays.
    const auditsBefore = db.__tables.auditLog.length;
    g = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "l5", reason: "catch-up week", actorUserId: "u-admin", now: NOW });
    ok(g.ok && !g.replay, "CASE 28a: grant creates");
    const rows = db.__tables.progressionOverride.filter((o) => o.studentId === "s1" && o.lessonId === "l5" && !o.revokedAt && (o.expiresAt === null || new Date(o.expiresAt) > NOW));
    ok(rows.length === 1 && rows[0].id === g.overrideId, "CASE 28b: exactly one live row");
    ok(db.__tables.auditLog.length === auditsBefore + 1 && db.__tables.auditLog[db.__tables.auditLog.length - 1].action === "PROGRESSION_OVERRIDE_GRANTED", "CASE 28c: grant audited");
    const g2 = await progression.grantProgressionOverride({ studentId: "s1", lessonId: "l5", reason: "catch-up week", actorUserId: "u-admin", now: NOW });
    ok(g2.ok && g2.replay && g2.overrideId === g.overrideId && db.__tables.auditLog.length === auditsBefore + 1, "CASE 28d: re-grant replays (no duplicate, no second audit)");
    // ...and it OPENS the named lesson end to end.
    const ovAccess = await progression.evaluateLessonAccess("s1", "l5", { now: NOW });
    ok(ovAccess.allowed && ovAccess.evaluation?.override?.overrideId === g.overrideId, "CASE 28e: the live override opens l5");
    const stillLocked = await progression.evaluateLessonAccess("s1", "l4", { now: NOW });
    ok(!stillLocked.allowed, "CASE 28f: l4 stays locked (one-lesson exception)");

    // CASE 29: revoke is append-only + idempotent.
    let rv = await progression.revokeProgressionOverride({ overrideId: "ghost", actorUserId: "u-admin", now: NOW });
    ok(!rv.ok && rv.code === "OVERRIDE_NOT_FOUND", "CASE 29a: unknown override → OVERRIDE_NOT_FOUND");
    const auditsMid = db.__tables.auditLog.length;
    rv = await progression.revokeProgressionOverride({ overrideId: g.overrideId, actorUserId: "u-admin", reason: "done", now: NOW });
    ok(rv.ok && !rv.replay, "CASE 29b: revoke succeeds");
    const row = db.__tables.progressionOverride.find((o) => o.id === g.overrideId);
    ok(row && row.revokedAt !== null && row.revokedByUserId === "u-admin", "CASE 29c: row survives with revokedAt (append-only)");
    ok(db.__tables.auditLog.length === auditsMid + 1 && db.__tables.auditLog[db.__tables.auditLog.length - 1].action === "PROGRESSION_OVERRIDE_REVOKED", "CASE 29d: revoke audited");
    const rv2 = await progression.revokeProgressionOverride({ overrideId: g.overrideId, actorUserId: "u-admin", now: NOW });
    ok(rv2.ok && rv2.replay && db.__tables.auditLog.length === auditsMid + 1, "CASE 29e: double revoke replays");
    const relocked = await progression.evaluateLessonAccess("s1", "l5", { now: NOW });
    ok(!relocked.allowed && relocked.reason === "PREVIOUS_SESSION_INCOMPLETE", "CASE 29f: l5 locks again after revoke");

    // CASE 30: list is newest-first with activity + audit identities.
    const list = await progression.listProgressionOverrides({ studentId: "s1", now: NOW });
    ok(list.length >= 3, "CASE 30a: all s1 rows listed");
    ok(new Date(list[0].createdAt) >= new Date(list[1].createdAt), "CASE 30b: newest first");
    ok(list.every((o) => typeof o.active === "boolean") && list.some((o) => !o.active), "CASE 30c: activity flags present; dead rows marked inactive");
    const listed = list.find((o) => o.id === g.overrideId);
    ok(listed?.lesson?.id === "l5" && listed?.grantedBy?.id === "u-admin" && listed?.revokedBy?.id === "u-admin", "CASE 30d: lesson + granter + revoker identities resolved");
  }

  section("Catch-up — eligibility + Phase F resolution");
  {
    const T = db.__tables;
    // A hold on the COMPLETED l1: boundary locks l3+, l2 stays accessible.
    T.absenceReview.push(
      { id: "r1", studentId: "s1", sessionId: "sess1", groupId: "g1", lessonId: "l1", status: "UNEXCUSED", createdAt: D(3) },
      { id: "r3", studentId: "s1", sessionId: "sess3", groupId: "g1", lessonId: "l3", status: "UNEXCUSED", createdAt: D(2) },
      { id: "rx", studentId: "s1", sessionId: "sessx", groupId: "g1", lessonId: "lx", status: "UNEXCUSED", createdAt: D(2) },
    );
    T.absenceHold.push({ id: "h1", studentId: "s1", absenceReviewId: "r1", sessionId: "sess1", status: "ACTIVE", createdAt: D(3), resolvedAt: null, resolvedByUserId: null, resolution: null });

    // CASE 18: ACTIVE hold draws the boundary; RESOLVED holds are invisible.
    T.absenceHold.push({ id: "h-dead", studentId: "s1", absenceReviewId: "rx", sessionId: "sessx", status: "RESOLVED", createdAt: D(9), resolvedAt: D(8), resolvedByUserId: "u-admin", resolution: "ATTENDANCE_CORRECTED" });
    const ph = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    ok(ph.byLessonId.get("l1").unlocked, "CASE 18a: missed lesson itself open");
    ok(!ph.byLessonId.get("l2").unlocked && ph.byLessonId.get("l2").reasonCode === "ABSENCE_HOLD" && ph.byLessonId.get("l2").state === "LOCKED", "CASE 18b: incomplete l2 locks past the boundary (effective LOCKED)");
    const l5h = ph.byLessonId.get("l5");
    ok(!l5h.unlocked && !l5h.completed && l5h.state === "LOCKED" && l5h.reasonCode === "PREVIOUS_INCOMPLETE" && l5h.unmet.includes("ABSENCE_HOLD"), "CASE 18c: incomplete l5 chain-locked past the hold (chain leads, hold trails)");
    ok(ph.boundary.holdBlockedFromLessonId === "l2", "CASE 18d: boundary pointer names l2");
    const holdAccess = await progression.evaluateLessonAccess("s1", "l2", { now: NOW });
    ok(!holdAccess.allowed && holdAccess.reason === "ABSENCE_HOLD", "CASE 18e: hold-blocked access answers ABSENCE_HOLD");
    // Recording access during hold: the missed lesson stays allowed, and the
    // student video list gates on exactly this verdict — catch-up recordings
    // remain listable/watchable while the hold is ACTIVE.
    const missedAccess = await progression.evaluateLessonAccess("s1", "l1", { now: NOW });
    ok(missedAccess.allowed, "CASE 18f: missed lesson stays allowed during its hold (recordings reachable)");
    // Remove the dead hold again — h-dead must be invisible either way, and
    // the RESOLVED-status filter is what the case pins (it is: l2 accessible).
    T.absenceHold.splice(T.absenceHold.findIndex((h) => h.id === "h-dead"), 1);

    // CASE 31: eligibility = missed lesson's OWN requirements satisfied.
    let cu = await progression.evaluateStudentCatchup("s1", { now: NOW });
    ok(cu.holds.length === 1 && cu.holds[0].eligible && cu.holds[0].inUniverse && cu.holds[0].unmet.length === 0, "CASE 31a: hold on completed l1 is eligible");
    T.absenceHold.push({ id: "h3", studentId: "s1", absenceReviewId: "r3", sessionId: "sess3", status: "ACTIVE", createdAt: D(2), resolvedAt: null, resolvedByUserId: null, resolution: null });
    cu = await progression.evaluateStudentCatchup("s1", { now: NOW });
    const cu3 = cu.holds.find((h) => h.holdId === "h3");
    ok(cu3 && !cu3.eligible && JSON.stringify(cu3.unmet) === JSON.stringify(["QUIZ_NOT_PASSED", "HOMEWORK_NOT_SUBMITTED"]), "CASE 31b: hold on incomplete l3 lists its unmet requirements");
    const view = progression.toCatchupHoldView(cu3);
    ok(!("reviewId" in view) && view.unmet[0]?.label?.length > 0, "CASE 31c: public view hides Phase F ids, labels unmet in Arabic");

    // CASE 32: unidentifiable / out-of-universe holds are vacuously eligible.
    T.absenceHold.push({ id: "hx", studentId: "s1", absenceReviewId: "rx", sessionId: "sessx", status: "ACTIVE", createdAt: D(2), resolvedAt: null, resolvedByUserId: null, resolution: null });
    cu = await progression.evaluateStudentCatchup("s1", { now: NOW });
    const cux = cu.holds.find((h) => h.holdId === "hx");
    ok(cux && cux.eligible && !cux.inUniverse && cux.requirements === null, "CASE 32: hold naming archived lx is vacuously eligible");

    // CASE 33: resolution goes THROUGH Phase F; ineligible holds are skipped.
    const res = await catchup.resolveEligibleCatchups("s1", "u-admin", { now: NOW });
    ok(res.resolvedCount === 2, "CASE 33a: the two eligible holds resolve");
    const h1row = T.absenceHold.find((h) => h.id === "h1");
    ok(h1row.status === "RESOLVED" && h1row.resolution === "CATCHUP_COMPLETED" && h1row.resolvedByUserId === "u-admin", "CASE 33b: hold row carries RESOLVED + actor + resolution");
    ok(T.absenceReview.find((r) => r.id === "r1").status === "UNEXCUSED", "CASE 33c: the review keeps its UNEXCUSED history (no rewrite)");
    ok(T.absenceHold.find((h) => h.id === "h3").status === "ACTIVE", "CASE 33d: ineligible h3 skipped, still ACTIVE");
    ok(res.results.find((x) => x.holdId === "h3")?.eligible === false, "CASE 33e: result marks h3 ineligible-with-unmet");
    ok(T.auditLog.some((a) => a.action === "ABSENCE_HOLD_CATCHUP_RESOLVED" && a.entityId === "h1"), "CASE 33f: resolution audited");

    // CASE 34: resolution idempotent; the sweep never throws.
    const res2 = await catchup.resolveEligibleCatchups("s1", "u-admin", { now: NOW });
    ok(res2.resolvedCount === 0 && res2.results.every((x) => !x.resolved), "CASE 34a: second run resolves nothing twice");
    const auditsAfter = T.auditLog.length;
    await catchup.resolveEligibleCatchups("s1", "u-admin", { now: NOW });
    ok(T.auditLog.length === auditsAfter, "CASE 34b: no second audit rows");
    const swept = await catchup.maybeResolveCatchup("ghost-student", "u-admin");
    ok(swept.resolvedCount === 0 && swept.results.length === 0, "CASE 34c: sweep over an unknown student returns empty, never throws");
  }

  section("Sync, façade, no-second-systems, determinism");
  {
    // CASE 35: derived-completion sync is monotonic and honest.
    let sy = await progression.syncDerivedCompletion("s1", "l1");
    ok(sy.completed && sy.synced, "CASE 35a: derived-complete l1 flips the legacy marker");
    ok(db.__tables.lessonProgress.some((r) => r.studentId === "s1" && r.lessonId === "l1" && r.isCompleted), "CASE 35b: the marker row exists");
    sy = await progression.syncDerivedCompletion("s1", "l1");
    ok(sy.completed && !sy.synced, "CASE 35c: second run is a no-op");
    sy = await progression.syncDerivedCompletion("s1", "l3");
    ok(!sy.completed && !sy.synced, "CASE 35d: incomplete lesson → no write");
    sy = await progression.syncDerivedCompletion("s1", "l4");
    const legacy = db.__tables.lessonProgress.find((r) => r.studentId === "s1" && r.lessonId === "l4");
    ok(!sy.completed && !sy.synced && legacy.isCompleted === true, "CASE 35e: legacy TRUE on a derived-incomplete lesson is never rewritten to false");
    sy = await progression.syncDerivedCompletion("s1", "ghost");
    ok(!sy.completed && !sy.synced, "CASE 35f: unknown lesson → no-op, never throws");

    // CASE 36: the adapter agrees with the engine on every surface.
    const eng = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    const fac = await facade.getCourseSessionProgress("s1", "c1");
    ok(JSON.stringify(fac.sessions.map((s) => [s.lessonId, s.completed, s.unlocked])) === JSON.stringify(eng.lessons.map((l) => [l.lessonId, l.completed, l.unlocked])), "CASE 36a: course progress identical");
    ok(fac.currentLessonId === eng.currentLessonId, "CASE 36b: current lesson identical");
    const [ea, fa] = await Promise.all([
      progression.evaluateLessonAccess("s1", "l3", { now: NOW }),
      facade.canAccessLesson("s1", "l3"),
    ]);
    ok(fa.allowed === ea.allowed && fa.reason === ea.reason && fa.status?.state === ea.evaluation?.state && !fa.allowed && fa.status?.state === "LOCKED", "CASE 36c: single-lesson denial identical (LOCKED both sides)");
    const ids = await facade.getUnlockedLessonIds("s1", "c1");
    ok(JSON.stringify([...ids].sort()) === JSON.stringify(eng.lessons.filter((l) => l.unlocked).map((l) => l.lessonId).sort()), "CASE 36d: unlocked set identical");
    const qz = await facade.canAccessQuiz("s1", "q1");
    ok(qz.allowed && qz.reason === null, "CASE 36e: resource gate resolves through the owning lesson");
    const qd = await facade.canAccessQuiz("s1", "qd");
    ok(!qd.allowed && qd.reason === "LESSON_NOT_FOUND", "CASE 36f: DRAFT quiz invisible (non-oracle)");

    // CASE 37: no second lifecycles — static pins on the authority boundaries.
    const catchupSrc = read("src/lib/catchup.ts");
    ok(/from "@\/lib\/absence-review"/.test(catchupSrc) && /resolveHoldForCatchup\(/.test(catchupSrc), "CASE 37a: resolution delegates to the Phase F authority");
    ok(!/absenceHold\.(create|update|upsert|delete)/.test(catchupSrc), "CASE 37b: the companion writes no hold row itself");
    const engSrc = read("src/lib/progression.ts");
    ok(!/(quizAttempt|homeworkSubmission|absenceHold)\.(create|update|upsert|delete)/.test(engSrc), "CASE 37c: the engine writes no academic fact (reads verdicts, never grades)");
    ok(!/eval\(|new Function\(/.test(engSrc), "CASE 37d: no dynamic code in the engine");
    // Corrected-contract pins: videoUrl-OR-required-recordings requiredness,
    // required recordings ARE inputs, pools never, effective state (LOCKED
    // first), read-only evaluation.
    ok(/const videoRequired = lesson\.hasLegacyVideo \|\| requiredVideos\.length > 0;/.test(engSrc), "CASE 37e: video requiredness is legacy-OR-required-recordings (the M2 revision)");
    ok(/db\.sessionVideo\.findMany/.test(engSrc) && /db\.sessionVideoView\.findMany/.test(engSrc) && /isRequiredForProgression: true/.test(engSrc), "CASE 37f: required recordings are engine inputs (published + required + audience scan)");
    ok(!/batchVideos|batchViewByVideo|servableQuizIds|isQuestionEligible/.test(engSrc) && !/db\.question\b/.test(engSrc), "CASE 37f: pools stay non-inputs (no question reads, no pool filters)");
    ok(/const state: ProgressionState = !unlocked/.test(engSrc), "CASE 37g: effective state derives access-first (never COMPLETED-while-locked)");
    ok(!/syncStudentBatch/.test(engSrc) && !/@\/lib\/enrollment/.test(engSrc), "CASE 37h: no batch reconcile on the evaluation path (read-only)");

    // CASE 38: determinism + read-only evaluation.
    db.__writes.length = 0;
    const first = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    const second = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    ok(JSON.stringify(first.lessons) === JSON.stringify(second.lessons) && first.currentLessonId === second.currentLessonId, "CASE 38a: same rows → same verdict, twice");
    await progression.evaluateLessonAccess("s1", "l1", { now: NOW });
    await progression.evaluateStudentCatchup("s1", { now: NOW });
    await facade.getUnlockedLessonIds("s1", "c1");
    ok(db.__writes.length === 0, "CASE 38b: evaluation paths perform zero writes");
  }

  section("Empty-lesson boundary, trichotomy, state contract (manual-QA stabilization)");
  {
    // CASE 39: the Admin override intentionally crosses an empty boundary —
    // access only, facts untouched, expiry/revoke restore the lock.
    let r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1), coreLesson("b", 2)],
      facts: coreFacts(), holds: [],
      overrides: [{ overrideId: "o", lessonId: "b", reason: "admin call", grantedAt: NOW.toISOString(), expiresAt: null }],
    });
    let m = new Map(r.lessons.map((l) => [l.lessonId, l]));
    ok(m.get("b").unlocked && m.get("b").state === "UNLOCKED", "CASE 39a: override opens the lesson past the empty boundary");
    ok(!m.get("b").completed && m.get("b").video.required === false && m.get("b").quiz.required === false && m.get("b").assignment.required === false, "CASE 39b: the override fabricates no requirement and no completion fact");
    ok(!m.get("a").completed && m.get("a").reasonCode === "NO_COMPLETION_REQUIREMENTS", "CASE 39c: the empty lesson itself still names its boundary reason");
    r = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1), coreLesson("b", 2)],
      facts: coreFacts(), holds: [], overrides: [],
    });
    m = new Map(r.lessons.map((l) => [l.lessonId, l]));
    ok(!m.get("b").unlocked && m.get("b").state === "LOCKED", "CASE 39d: without the override the boundary holds (revoke/expiry restores the lock)");

    // CASE 40: configuring requirements later corrupts no history — the same
    // lesson flips boundary → satisfied, and earlier completions stand.
    const before = progression.evaluateProgressionCore({
      lessons: [coreLesson("a", 1, { quizIds: ["qa"] }), coreLesson("b", 2)],
      facts: coreFacts({ passedQuizIds: new Set(["qa"]) }),
      holds: [], overrides: [],
    });
    const mb = new Map(before.lessons.map((l) => [l.lessonId, l]));
    ok(mb.get("a").completed && mb.get("a").state === "COMPLETED" && !mb.get("b").completed && mb.get("b").unlocked, "CASE 40a: completed history + open empty boundary");
    const after = progression.evaluateProgressionCore({
      lessons: [
        coreLesson("a", 1, { quizIds: ["qa"] }),
        coreLesson("b", 2, { hasLegacyVideo: true }),
      ],
      facts: coreFacts({
        passedQuizIds: new Set(["qa"]),
        legacyVideoByLesson: new Map([["b", { percent: 96, completed: true, completedAt: NOW.toISOString() }]]),
      }),
      holds: [], overrides: [],
    });
    const ma = new Map(after.lessons.map((l) => [l.lessonId, l]));
    ok(ma.get("a").completed && ma.get("a").state === "COMPLETED", "CASE 40b: earlier completion survives the later configuration");
    ok(ma.get("b").video.required && ma.get("b").video.done && ma.get("b").completed && ma.get("b").state === "COMPLETED", "CASE 40c: the configured-then-satisfied lesson completes honestly");

    // CASE 41: track + lifecycle still gate empty lessons (the boundary never
    // leaks across audiences or stages).
    const pu = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    const ids = pu.lessons.map((l) => l.lessonId);
    ok(!ids.includes("ld") && !ids.includes("lx") && !ids.includes("lg"), "CASE 41a: empty DRAFT / ARCHIVED / cross-track lessons stay out of the universe");
    const l5u = pu.byLessonId.get("l5");
    ok(l5u.video.required === false && l5u.quiz.required === false && l5u.assignment.required === false && !l5u.completed, "CASE 41b: in-universe empty lesson exposes the all-absent requirement matrix");

    // CASE 42: the requirement trichotomy the UI renders (required × done).
    const tri = await progression.loadCourseProgression("s1", "c1", { now: NOW });
    const t1 = tri.byLessonId.get("l1"), t2 = tri.byLessonId.get("l2"), t3 = tri.byLessonId.get("l3"), t5 = tri.byLessonId.get("l5");
    ok(t1.video.required && t1.video.done && t1.quiz.required && t1.quiz.done && t1.assignment.required && t1.assignment.done, "CASE 42a: satisfied lesson — every dimension REQUIRED_COMPLETE");
    ok(t2.quiz.required && !t2.quiz.done && t2.video.required === false, "CASE 42b: gate quiz REQUIRED_INCOMPLETE; absent video NOT_REQUIRED");
    ok(t3.quiz.required && !t3.quiz.done && t3.assignment.required && !t3.assignment.done, "CASE 42c: failed quiz + unsubmitted CLOSED homework are REQUIRED_INCOMPLETE");
    ok(!t5.video.required && !t5.quiz.required && !t5.assignment.required, "CASE 42d: empty lesson — every dimension NOT_REQUIRED");

    // CASE 43: the state truth table holds for EVERY lesson of a mixed chain
    // (contract: unlocked=false → LOCKED; unlocked+completed → COMPLETED;
    // unlocked+incomplete → UNLOCKED; COMPLETED-with-unlocked=false never).
    const mix = progression.evaluateProgressionCore({
      lessons: [
        coreLesson("done", 1, { quizIds: ["q"] }),
        coreLesson("empty", 2),
        coreLesson("open", 3, { quizIds: ["q3"] }),
        coreLesson("gated", 4, { quizIds: ["q4"] }),
      ],
      facts: coreFacts({ passedQuizIds: new Set(["q"]) }),
      holds: [],
      overrides: [{ overrideId: "o", lessonId: "gated", reason: "x", grantedAt: NOW.toISOString(), expiresAt: null }],
    });
    let tableOk = true, neverBadCombo = true;
    for (const l of mix.lessons) {
      const want = !l.unlocked ? "LOCKED" : l.completed ? "COMPLETED" : "UNLOCKED";
      if (l.state !== want) tableOk = false;
      if (l.state === "COMPLETED" && !l.unlocked) neverBadCombo = false;
    }
    ok(tableOk, "CASE 43a: every lesson's state matches the (unlocked, completed) truth table");
    ok(neverBadCombo, "CASE 43b: COMPLETED with unlocked=false is never emitted");
    const mm = new Map(mix.lessons.map((l) => [l.lessonId, l]));
    ok(mm.get("done").state === "COMPLETED" && mm.get("empty").state === "UNLOCKED" && mm.get("open").state === "LOCKED" && mm.get("gated").state === "UNLOCKED", "CASE 43c: mixed-chain states (complete / boundary / chain-locked / override-island)");
  }

  console.log(`\nacademic progression (phase H): ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log("failures:");
    for (const f of failures) console.log(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
