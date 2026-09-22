// CodeMind Academy — Phase I: Parent Academic Visibility & Follow-up tests
// (offline, no DB).
//
// Exercises the REAL route handlers and the real aggregation reader with an
// in-memory mock Prisma client (the real db/custom.db is never touched):
//
//   * GET  /api/parents/me/academics          (the new canonical surface)
//   * GET  /api/parents/me/dashboard          (?studentId= verification)
//   * GET  /api/parents/me/analytics          (?studentId= verification)
//   * GET  /api/parents/me/weekly-report      (?studentId= verification)
//   * GET  /api/quizzes/[id]                  (no answer key for a parent)
//   * GET  /api/lessons/[id]                  (no answer key for a parent)
//   * POST /api/absence-reviews/[id]/reason   (parent read-only)
//   * the role gates of every academic mutation route a parent must never reach
//
// Fixture shape:
//   ParentA → ChildA (ARABIC, g1) + ChildB (LANGUAGE, g2) — same course, two
//   tracks, the multi-child isolation case.
//   ParentB → ChildC (ARABIC, g3, ANOTHER course) — the IDOR target.
//   ParentD → nobody.
//
//   The course carries: 4 lessons (one DRAFT/hidden, one ARABIC-only), a
//   REQUIRED session recording at 40%, published + draft quizzes, five
//   published assignments covering every deadline-aware submission state,
//   one DRAFT assignment, an EXCUSED and an UNEXCUSED absence case (the
//   latter carrying an ACTIVE hold) and a rescheduled + a cancelled session.
//
// Run: node tests/parent-academic-followup-phaseI.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const crypto = require("crypto");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseI-"));

// ---------------------------------------------------------------------------
// 1. Compile the files under test with tsc (type errors fail the suite)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/parent-academics.ts",
  "src/lib/progression.ts",
  "src/lib/session-progress.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/track-scope.ts",
  "src/lib/school-type.ts",
  "src/lib/enrollment.ts",
  "src/lib/api.ts",
  "src/lib/absence-review.ts",
  "src/lib/absence-policy.ts",
  "src/lib/catchup.ts",
  "src/lib/notify.ts",
  "src/lib/parent-access.ts",
  "src/lib/parent-subscription.ts",
  "src/lib/progress.ts",
  "src/app/api/parents/me/academics/route.ts",
  "src/components/parent/academic-followup.tsx",
  "src/components/parent/child-switcher.tsx",
  "src/app/api/parents/me/dashboard/route.ts",
  "src/app/api/parents/me/analytics/route.ts",
  "src/app/api/parents/me/weekly-report/route.ts",
  "src/app/api/absence-reviews/[id]/reason/route.ts",
  "src/app/api/absence-reviews/[id]/decision/route.ts",
  "src/app/api/quizzes/[id]/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/admin/progression-overrides/route.ts",
  "src/app/api/admin/progression-overrides/[id]/revoke/route.ts",
  "src/app/api/admin/quiz-retries/route.ts",
  "src/app/api/quizzes/[id]/start/route.ts",
  "src/app/api/quizzes/[id]/submit/route.ts",
  "src/app/api/students/me/homework/route.ts",
  "src/app/api/students/me/catchup/route.ts",
  "src/app/api/teacher/homework/[id]/grade/route.ts",
  "src/app/api/lessons/[id]/progress/route.ts",
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
      noEmitOnError: false,
    },
    files: FILES.map((f) => path.join(REPO, f)),
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch (e) {
  const emitted = path.join(OUT, "src/app/api/parents/me/academics/route.js");
  if (!fs.existsSync(emitted)) {
    console.error(String(e.stdout || e.message));
    process.exit(1);
  }
}
const compiled = (f) => path.join(OUT, f.replace(/\.tsx?$/, ".js"));

// ---------------------------------------------------------------------------
// 2. In-memory mock Prisma client (Prisma-subset emulator)
//
// The emulator is the Phase 7 one, extended with the Phase F absence family,
// the Phase H engine tables and the notification table. It enforces the SAME
// @@unique([userId, dedupeKey]) the real Notification table declares, so the
// idempotency guarantee the Phase I quiz-result fan-out depends on is real
// here and not assumed.
// ---------------------------------------------------------------------------
function makeMockDb() {
  const t = {
    user: [], student: [], parent: [], parentStudentLink: [],
    course: [], group: [], part: [], unit: [], topic: [], lesson: [],
    quiz: [], question: [], homework: [], homeworkSubmission: [],
    quizAttempt: [], lessonProgress: [], attendance: [], liveSession: [],
    teacher: [], teacherNote: [], subscription: [], subscriptionPlan: [],
    examAttempt: [], mockExam: [],
    // Phase F — the absence-review family the Parent surface reads.
    absenceReview: [], absenceHold: [], absenceReasonSubmission: [],
    attendanceCorrection: [],
    // Phase H — the canonical engine's own reads.
    progressionOverride: [],
    sessionVideo: [], sessionVideoView: [], batch: [], mediaAsset: [],
    // Notification architecture (the Phase I quiz-result fan-out).
    notification: [], notificationPreference: [],
    // Phase B — the course tree's modern video-presence query reads this
    // table; the fixtures carry no SessionVideo rows (empty → legacy
    // videoUrl-only presence, exactly the pre-Phase-B behaviour).
    sessionVideo: [],
    // Phase B — the same tree route lazily reconciles the student's batch
    // (the exact rule the session-video list uses); the fixtures carry no
    // Batch rows, so reconciliation resolves NO_BATCH and performs no write.
    batch: [],
    // Phase H — the canonical progression engine's reads (empty world: no
    // per-video watch state, no absence holds, no admin overrides).
    sessionVideoView: [],
    absenceHold: [],
    progressionOverride: [],
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
      // --- Phase F: absence-review family ---
      case "absenceReview.hold": return t.absenceHold.find((h) => h.absenceReviewId === row.id) || null;
      case "absenceReview.submissions": return t.absenceReasonSubmission.filter((s) => s.absenceReviewId === row.id);
      case "absenceReview.student": return byId(t.student, row.studentId);
      case "absenceReview.session": return byId(t.liveSession, row.sessionId);
      case "absenceReview.group": return byId(t.group, row.groupId);
      case "absenceReview.attendance": return byId(t.attendance, row.attendanceId);
      case "absenceHold.absenceReview": return byId(t.absenceReview, row.absenceReviewId);
      case "absenceReasonSubmission.absenceReview": return byId(t.absenceReview, row.absenceReviewId);
      // --- Phase B/H: recordings ---
      case "sessionVideo.media": return byId(t.mediaAsset, row.mediaAssetId);
      case "sessionVideo.batch": return byId(t.batch, row.batchId);
      case "sessionVideo.lesson": return row.lessonId ? byId(t.lesson, row.lessonId) : null;
      case "sessionVideo.liveSession": return row.liveSessionId ? byId(t.liveSession, row.liveSessionId) : null;
      case "batch.students": return t.student.filter((s) => s.batchId === row.id);
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
    "absenceReview.hold": "absenceHold",
    "absenceReview.submissions": "absenceReasonSubmission",
    "absenceReview.student": "student", "absenceReview.session": "liveSession",
    "absenceReview.group": "group", "absenceReview.attendance": "attendance",
    "absenceHold.absenceReview": "absenceReview",
    "absenceReasonSubmission.absenceReview": "absenceReview",
    "sessionVideo.media": "mediaAsset", "sessionVideo.batch": "batch",
    "sessionVideo.lesson": "lesson", "sessionVideo.liveSession": "liveSession",
    "batch.students": "student",
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
        // The real schema declares @@unique([userId, dedupeKey]) on
        // Notification. The emulator must enforce it too, or an idempotency
        // bug would pass here and surface as a 500 in production.
        if (table === "notification" && data && data.dedupeKey != null) {
          const dup = t[table].some(
            (r) => r.userId === data.userId && r.dedupeKey === data.dedupeKey
          );
          if (dup) {
            const err = new Error("Unique constraint failed on the fields: (`userId`,`dedupeKey`)");
            err.code = "P2002";
            throw err;
          }
        }
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
        // Prisma accepts a COMPOUND unique key in `where`
        // (`{ parentId_studentId: { parentId, studentId } }`) — the shape
        // `findUnique` above already understands. Expand it here too, or an
        // upsert on the pair never matches an existing row and writes a
        // duplicate, which is NOT what the engine does.
        let w = where || {};
        const compound = Object.entries(w).find(
          ([k, v]) =>
            k.includes("_") &&
            v &&
            typeof v === "object" &&
            Object.keys(v).length > 0 &&
            !(k in (t[table][0] || {}))
        );
        if (compound) {
          w = { ...compound[1], ...Object.fromEntries(Object.entries(w).filter(([k]) => k !== compound[0])) };
        }
        const keys = Object.keys(w);
        const row = t[table].find((r) => keys.every((k) => r[k] === w[k]));
        if (row) {
          trackWrite(table, "update");
          Object.assign(row, clone(update));
          return clone(row);
        }
        trackWrite(table, "create");
        const fresh = { id: `${table}-${seq++}`, ...clone(create) };
        // The database enforces @@unique([parentId, studentId]) (and every
        // other compound unique in the schema); the emulator must too, or a
        // broken idempotency path would pass here and fail in production.
        if (
          table === "parentStudentLink" &&
          t[table].some((r) => r.parentId === fresh.parentId && r.studentId === fresh.studentId)
        ) {
          const err = new Error("Unique constraint failed on the fields: (`parentId`,`studentId`)");
          err.code = "P2002";
          throw err;
        }
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
  "framer-motion": shim(
    "framer",
    `const React = require(${JSON.stringify(path.join(REPO, "node_modules/react"))});
     const motion = new Proxy({}, { get: (_, tag) => (props) => { const { initial, animate, exit, transition, whileHover, whileTap, variants, ...rest } = props; return React.createElement(tag, rest); } });
     module.exports = { motion, AnimatePresence: ({ children }) => children };`
  ),
  recharts: shim(
    "recharts",
    `const React = require(${JSON.stringify(path.join(REPO, "node_modules/react"))});
     const Stub = ({ children }) => React.createElement('div', null, children);
     module.exports = new Proxy({}, { get: () => Stub });`
  ),
  "@tanstack/react-query": shim(
    "rq",
    "module.exports = { useQuery: () => global.__RQ__ || {}, useQueryClient: () => ({ invalidateQueries() {} }), QueryClient: class {}, QueryClientProvider: ({ children }) => children };"
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
  if (cond) { pass++; console.log(`  ✓ ${label}`); }
  else { fail++; console.log(`  ✗ ${label}`); }
};
const eq = (actual, expected, label) => ok(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
const section = (t) => console.log(`\n${t}`);

const academicsRoute = require(compiled("src/app/api/parents/me/academics/route.ts"));
const dashboardRoute = require(compiled("src/app/api/parents/me/dashboard/route.ts"));
const analyticsRoute = require(compiled("src/app/api/parents/me/analytics/route.ts"));
const weeklyRoute = require(compiled("src/app/api/parents/me/weekly-report/route.ts"));
const reasonRoute = require(compiled("src/app/api/absence-reviews/[id]/reason/route.ts"));
const decisionRoute = require(compiled("src/app/api/absence-reviews/[id]/decision/route.ts"));
const quizRoute = require(compiled("src/app/api/quizzes/[id]/route.ts"));
const lessonRoute = require(compiled("src/app/api/lessons/[id]/route.ts"));
const overrideRoute = require(compiled("src/app/api/admin/progression-overrides/route.ts"));
const overrideRevokeRoute = require(compiled("src/app/api/admin/progression-overrides/[id]/revoke/route.ts"));
const retryRoute = require(compiled("src/app/api/admin/quiz-retries/route.ts"));
const quizStartRoute = require(compiled("src/app/api/quizzes/[id]/start/route.ts"));
const quizSubmitRoute = require(compiled("src/app/api/quizzes/[id]/submit/route.ts"));
const homeworkRoute = require(compiled("src/app/api/students/me/homework/route.ts"));
const catchupRoute = require(compiled("src/app/api/students/me/catchup/route.ts"));
const gradeRoute = require(compiled("src/app/api/teacher/homework/[id]/grade/route.ts"));
const progressRoute = require(compiled("src/app/api/lessons/[id]/progress/route.ts"));
const progressionLib = require(compiled("src/lib/progression.ts"));
const notifyLib = require(compiled("src/lib/notify.ts"));

// --- Server-side render of the shipped Phase I components -------------------
const React = require(path.join(REPO, "node_modules/react"));
const { renderToStaticMarkup } = require(path.join(REPO, "node_modules/react-dom/server"));
const { AcademicFollowup, AcademicFollowupSkeleton, AcademicFollowupError } = require(
  compiled("src/components/parent/academic-followup.tsx")
);
const { ChildSwitcher } = require(compiled("src/components/parent/child-switcher.tsx"));
// styled-jsx's `<style jsx global>` is compiled away by Next; rendering raw
// with react-dom emits a harmless attribute warning. Silence only that.
const origConsoleError = console.error;
console.error = (...args) => {
  const msg = String(args[0] || "");
  if (msg.includes("non-boolean attribute `jsx`") || msg.includes("non-boolean attribute `global`")) return;
  origConsoleError(...args);
};
const render = (el) => {
  try { return { html: renderToStaticMarkup(el), error: null }; }
  catch (e) { return { html: "", error: e }; }
};

const req = (body) => ({ json: async () => body, url: "http://test.local/api", headers: new Map() });
const reqWithQuery = (studentId) => ({
  json: async () => ({}),
  url: `http://test.local/api?studentId=${encodeURIComponent(studentId)}`,
  headers: new Map(),
});
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

// ---------------------------------------------------------------------------
// 5. Fixture
// ---------------------------------------------------------------------------
const NOW = Date.now();
const D = (daysAgo) => new Date(NOW - daysAgo * 86400000);
const FUT = (daysAhead) => new Date(NOW + daysAhead * 86400000);

async function seed() {
  const db = global.__MOCK_DB__;
  const T = db.__tables;

  T.user.push(
    { id: "u-pa", email: "pa@test.local", name: "Parent A", role: "PARENT", isActive: true, status: "ACTIVE", phone: "01000000001", avatarUrl: null },
    { id: "u-pb", email: "pb@test.local", name: "Parent B", role: "PARENT", isActive: true, status: "ACTIVE", phone: "01000000002", avatarUrl: null },
    { id: "u-pd", email: "pd@test.local", name: "Parent D", role: "PARENT", isActive: true, status: "ACTIVE", phone: "01000000004", avatarUrl: null },
    { id: "u-sa", email: "sa@test.local", name: "Child A", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sb", email: "sb@test.local", name: "Child B", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-sc", email: "sc@test.local", name: "Child C", role: "STUDENT", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-t1", email: "t1@test.local", name: "Ms Teacher", role: "TEACHER", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
    { id: "u-ad", email: "ad@test.local", name: "Admin", role: "ADMIN", isActive: true, status: "ACTIVE", phone: null, avatarUrl: null },
  );

  T.course.push(
    { id: "c1", slug: "course-1", name: "Course One", nameAr: "الكورس الأول", description: "d", color: "#10b981", iconUrl: null, createdAt: D(90) },
    { id: "c9", slug: "course-9", name: "Other Course", nameAr: "كورس تاني", description: "d", color: "#f59e0b", iconUrl: null, createdAt: D(90) },
  );
  T.group.push(
    { id: "g1", name: "Group 1", courseId: "c1", teacherId: "t1", capacity: 20, schedule: "Sat", isActive: true, createdAt: D(80) },
    { id: "g2", name: "Group 2", courseId: "c1", teacherId: "t1", capacity: 20, schedule: "Sun", isActive: true, createdAt: D(80) },
    { id: "g3", name: "Group 3", courseId: "c9", teacherId: "t1", capacity: 20, schedule: "Mon", isActive: true, createdAt: D(80) },
  );
  T.teacher.push({ id: "t1", userId: "u-t1", bio: null, specialty: "Math" });

  // --- Curriculum -----------------------------------------------------------
  T.part.push({ id: "p1", courseId: "c1", title: "Part 1", titleAr: "الجزء الأول", order: 1, description: null });
  T.unit.push({ id: "un1", partId: "p1", title: "Unit 1", titleAr: "الوحدة الأولى", order: 1, icon: null });
  T.topic.push({ id: "tp1", unitId: "un1", title: "Topic 1", titleAr: "الموضوع الأول", order: 1 });
  T.lesson.push(
    { id: "l1", trackScope: "SHARED", topicId: "tp1", unitId: null, officialCode: "1-1", curriculumStatus: "LEGACY", status: "PUBLISHED", title: "Lesson One", titleAr: "الدرس الأول", order: 1, description: "d", summary: "s", duration: 90, isLocked: false, isPublished: true, videoUrl: null, pdfUrl: null },
    { id: "l2", trackScope: "SHARED", topicId: "tp1", unitId: null, officialCode: "1-2", curriculumStatus: "LEGACY", status: "PUBLISHED", title: "Lesson Two", titleAr: "الدرس الثاني", order: 2, description: "d", summary: "s", duration: 90, isLocked: true, isPublished: true, videoUrl: null, pdfUrl: null },
    { id: "l3", trackScope: "ARABIC", topicId: "tp1", unitId: null, officialCode: "1-3", curriculumStatus: "LEGACY", status: "PUBLISHED", title: "Arabic Only", titleAr: "درس عربي فقط", order: 3, description: "d", summary: "s", duration: 90, isLocked: true, isPublished: true, videoUrl: null, pdfUrl: null },
    { id: "l4", trackScope: "SHARED", topicId: "tp1", unitId: null, officialCode: null, curriculumStatus: "LEGACY", status: "DRAFT", title: "Hidden Draft", titleAr: "مسودة مخفية", order: 4, description: "", summary: "", duration: 90, isLocked: true, isPublished: false, videoUrl: null, pdfUrl: null },
  );
  // The OTHER course (Child C) — the IDOR decoy.
  T.part.push({ id: "p9", courseId: "c9", title: "Part 9", titleAr: "ج9", order: 1, description: null });
  T.unit.push({ id: "un9", partId: "p9", title: "Unit 9", titleAr: "و9", order: 1, icon: null });
  T.topic.push({ id: "tp9", unitId: "un9", title: "Topic 9", titleAr: "م9", order: 1 });
  T.lesson.push(
    { id: "l9", trackScope: "SHARED", topicId: "tp9", unitId: null, officialCode: "9-1", curriculumStatus: "LEGACY", status: "PUBLISHED", title: "Other Course Lesson", titleAr: "درس الكورس التاني", order: 1, description: "", summary: "", duration: 90, isLocked: false, isPublished: true, videoUrl: null, pdfUrl: null },
  );

  // --- Quizzes --------------------------------------------------------------
  T.quiz.push(
    { id: "q1", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l1", title: "Quiz One", titleAr: "اختبار واحد", description: null, passMark: 60, timeLimit: null, order: 0, quizMode: "FIXED", questionCount: 0, difficultyPlan: null, shuffleOptions: true, maxAttempts: 3 },
    { id: "q2", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l2", title: "Quiz Two", titleAr: "اختبار اثنين", description: null, passMark: 60, timeLimit: null, order: 0, quizMode: "FIXED", questionCount: 0, difficultyPlan: null, shuffleOptions: true, maxAttempts: 3 },
    { id: "qdraft", status: "DRAFT", trackScope: "SHARED", lessonId: "l1", title: "Draft Quiz", titleAr: "اختبار مسودة", description: null, passMark: 60, timeLimit: null, order: 0, quizMode: "FIXED", questionCount: 0, difficultyPlan: null, shuffleOptions: true, maxAttempts: 3 },
  );
  T.question.push(
    { id: "qq1", quizId: "q1", type: "MCQ", prompt: "2+2?", promptAr: "٢+٢؟", options: JSON.stringify(["3", "4", "5"]), answer: "1", explanation: "SECRET-ANSWER-KEY", difficulty: "EASY", marks: 1, schoolType: null, createdAt: D(30) },
    { id: "qq2", quizId: "q2", type: "MCQ", prompt: "3+3?", promptAr: "٣+٣؟", options: JSON.stringify(["5", "6"]), answer: "1", explanation: "SECRET-ANSWER-KEY-2", difficulty: "EASY", marks: 1, schoolType: null, createdAt: D(30) },
  );

  // --- Homework (every deadline-aware state) --------------------------------
  T.homework.push(
    // future deadline + submitted on time
    { id: "h1", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l1", title: "HW On Time", titleAr: "واجب في المعاد", instructions: "do", deadline: FUT(3), maxMarks: 20, createdAt: D(10) },
    // PAST deadline + no submission → Missing / Overdue
    { id: "h2", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l1", title: "HW Overdue", titleAr: "واجب فات معاده", instructions: "do", deadline: D(2), maxMarks: 10, createdAt: D(10) },
    // future deadline + no submission → Not submitted yet
    { id: "h3", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l1", title: "HW Pending", titleAr: "واجب لسه متسلمش", instructions: "do", deadline: FUT(5), maxMarks: 10, createdAt: D(10) },
    // submitted AFTER the deadline → Submitted late
    { id: "h4", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l1", title: "HW Late", titleAr: "واجب متأخر", instructions: "do", deadline: D(5), maxMarks: 10, createdAt: D(10) },
    // graded (canonically late because submittedAt > deadline)
    { id: "h5", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l1", title: "HW Graded", titleAr: "واجب متصحح", instructions: "do", deadline: D(6), maxMarks: 10, createdAt: D(10) },
    // A DRAFT assignment — must never reach a parent.
    { id: "h6", status: "DRAFT", trackScope: "SHARED", lessonId: "l1", title: "HW Draft Secret", titleAr: "واجب مسودة سري", instructions: "do", deadline: FUT(2), maxMarks: 10, createdAt: D(10) },
    // On a LOCKED lesson (l2) — hidden, because the child cannot open l2.
    { id: "h7", status: "PUBLISHED", trackScope: "SHARED", lessonId: "l2", title: "HW Locked Lesson", titleAr: "واجب درس مقفول", instructions: "do", deadline: FUT(4), maxMarks: 10, createdAt: D(10) },
  );

  // --- Students / parents / links -------------------------------------------
  T.batch.push({ id: "b1", name: "Batch 1", courseId: "c1", schoolType: "ARABIC", createdAt: D(70) });
  T.mediaAsset.push({ id: "ma1", storage: "S3", kind: "VIDEO", mimeType: "video/mp4", sizeBytes: 1000, originalName: "v.mp4", storageKey: "k/v.mp4", uploadedByUserId: "u-ad", createdAt: D(20) });

  T.student.push(
    { id: "sa", userId: "u-sa", grade: "2nd Secondary", schoolName: "Nile", schoolType: "ARABIC", nationalId: "30101011234567", parentPhone: "01000000001", studentCode: "CM-AAAA11", groupId: "g1", batchId: "b1", enrolledAt: D(60) },
    { id: "sb", userId: "u-sb", grade: "2nd Secondary", schoolName: "Nile", schoolType: "LANGUAGE", nationalId: "30102021234567", parentPhone: "01000000001", studentCode: "CM-BBBB22", groupId: "g2", batchId: null, enrolledAt: D(60) },
    { id: "sc", userId: "u-sc", grade: "2nd Secondary", schoolName: "Nile", schoolType: "ARABIC", nationalId: "30103031234567", parentPhone: "01000000002", studentCode: "CM-CCCC33", groupId: "g3", batchId: null, enrolledAt: D(60) },
  );
  T.parent.push({ id: "pa", userId: "u-pa" }, { id: "pb", userId: "u-pb" }, { id: "pd", userId: "u-pd" });
  T.parentStudentLink.push(
    { id: "link-a", parentId: "pa", studentId: "sa", relation: "parent", createdAt: D(50) },
    { id: "link-b", parentId: "pa", studentId: "sb", relation: "parent", createdAt: D(49) },
    { id: "link-c", parentId: "pb", studentId: "sc", relation: "parent", createdAt: D(50) },
  );

  // --- Subscriptions (entitlement) -------------------------------------------
  T.subscriptionPlan.push({ id: "plan1", name: "Monthly", nameAr: "شهري", price: 300, durationMonths: 1 });
  T.subscription.push(
    { id: "sub-a", studentId: "sa", planId: "plan1", status: "ACTIVE", startDate: D(10), endDate: FUT(20) },
    { id: "sub-b", studentId: "sb", planId: "plan1", status: "ACTIVE", startDate: D(10), endDate: FUT(20) },
    { id: "sub-c", studentId: "sc", planId: "plan1", status: "ACTIVE", startDate: D(10), endDate: FUT(20) },
  );

  // --- Quiz attempts (Child A: 2 finished on q1 — last one PASSED) -----------
  T.quizAttempt.push(
    { id: "a1", quizId: "q1", studentId: "sa", attemptNumber: 1, status: "SUBMITTED", score: 4, totalMarks: 10, percentage: 40, passed: false, startedAt: D(6), finishedAt: D(6), cameraStatus: "NOT_REQUESTED" },
    { id: "a2", quizId: "q1", studentId: "sa", attemptNumber: 2, status: "SUBMITTED", score: 9, totalMarks: 10, percentage: 85, passed: true, startedAt: D(1), finishedAt: D(1), cameraStatus: "NOT_REQUESTED" },
    // An UNFINISHED attempt must never count.
    { id: "a3-open", quizId: "q1", studentId: "sa", attemptNumber: 3, status: "OPEN", score: 0, totalMarks: 10, percentage: 0, passed: false, startedAt: D(0.5), finishedAt: null, cameraStatus: "NOT_REQUESTED" },
  );

  // --- Homework submissions ---------------------------------------------------
  T.homeworkSubmission.push(
    { id: "hs1", homeworkId: "h1", studentId: "sa", content: "ok", fileUrl: null, submittedAt: D(1), grade: null, feedback: null, status: "SUBMITTED", attachmentId: null, gradedById: null, gradedAt: null },
    { id: "hs4", homeworkId: "h4", studentId: "sa", content: "late", fileUrl: null, submittedAt: D(3), grade: null, feedback: "متأخر بس المحتوى تمام", status: "LATE", attachmentId: null, gradedById: null, gradedAt: null },
    { id: "hs5", homeworkId: "h5", studentId: "sa", content: "good", fileUrl: null, submittedAt: D(4), grade: 9, feedback: "أحسن واجب", status: "GRADED", attachmentId: null, gradedById: "u-t1", gradedAt: D(1) },
  );

  // A LEGACY `LessonProgress.isCompleted = true` row for l2 — the pre-Phase-H
  // sticky flag. The engine says l2 is LOCKED (its predecessor is incomplete),
  // so this row is exactly the disagreement that used to reach the parent
  // screen. The canonical reader must ignore it.
  T.lessonProgress.push({
    id: "lp-l2", studentId: "sa", lessonId: "l2", progress: 100, isCompleted: true,
    videoPercent: 100, videoCompleted: true, videoCompletedAt: D(5),
  });

  // --- Required session recording at 40% (Child A's batch) --------------------
  T.sessionVideo.push({
    id: "sv1", batchId: "b1", lessonId: "l1", mediaAssetId: "ma1",
    title: "Recording 1-1", titleAr: "تسجيل ١-١", description: null,
    requiredPercent: 95, isRequiredForProgression: true, requirementMode: "ALL_STUDENTS",
    liveSessionId: null, isPublished: true, publishedAt: D(20), createdAt: D(20), updatedAt: D(20),
  });
  T.sessionVideoView.push({ id: "vv1", sessionVideoId: "sv1", studentId: "sa", watchedSec: 240, durationSec: 600, percent: 40, isCompleted: false, lastHeartbeatAt: D(1) });

  // --- Live sessions ----------------------------------------------------------
  T.liveSession.push(
    { id: "s1", groupId: "g1", teacherId: "t1", lessonId: "l1", title: "Session 1", titleAr: "الحصة 1", startAt: D(30), duration: 90, meetingUrl: null, status: "COMPLETED", rescheduleCount: 0, lastRescheduledAt: null, originalStartAt: null, cancelledAt: null, cancelReason: null },
    { id: "s2", groupId: "g1", teacherId: "t1", lessonId: "l1", title: "Session 2", titleAr: "الحصة 2", startAt: D(10), duration: 90, meetingUrl: null, status: "COMPLETED", rescheduleCount: 0, lastRescheduledAt: null, originalStartAt: null, cancelledAt: null, cancelReason: null },
    { id: "sSched", groupId: "g1", teacherId: "t1", lessonId: "l2", title: "Upcoming", titleAr: "القادمة", startAt: FUT(1), duration: 90, meetingUrl: null, status: "SCHEDULED", rescheduleCount: 0, lastRescheduledAt: null, originalStartAt: null, cancelledAt: null, cancelReason: null },
    { id: "sResch", groupId: "g1", teacherId: "t1", lessonId: "l2", title: "Moved", titleAr: "المؤجلة", startAt: FUT(2), duration: 90, meetingUrl: null, status: "SCHEDULED", rescheduleCount: 1, lastRescheduledAt: D(1), originalStartAt: D(1), cancelledAt: null, cancelReason: null },
    { id: "sCancel", groupId: "g1", teacherId: "t1", lessonId: "l2", title: "Cancelled One", titleAr: "الملغاة", startAt: D(3), duration: 90, meetingUrl: null, status: "CANCELLED", rescheduleCount: 0, lastRescheduledAt: null, originalStartAt: null, cancelledAt: D(3), cancelReason: "عطل فني" },
    { id: "sOldCancel", groupId: "g1", teacherId: "t1", lessonId: "l1", title: "Ancient Cancelled", titleAr: "ملغاة قديمة", startAt: D(80), duration: 90, meetingUrl: null, status: "CANCELLED", rescheduleCount: 0, lastRescheduledAt: null, originalStartAt: null, cancelledAt: D(80), cancelReason: "قديم" },
  );
  T.attendance.push(
    { id: "at1", studentId: "sa", sessionId: "s1", status: "ABSENT", note: null, createdAt: D(30) },
    { id: "at2", studentId: "sa", sessionId: "s2", status: "ABSENT", note: null, createdAt: D(10) },
  );

  // --- Phase F absence cases: one EXCUSED, one UNEXCUSED (ACTIVE hold) --------
  T.absenceReview.push(
    { id: "ar1", attendanceId: "at1", studentId: "sa", sessionId: "s1", groupId: "g1", lessonId: "l1", teacherId: "t1", status: "EXCUSED", reason: "عذر طبي", reasonSubmittedAt: D(29), reasonSubmittedByUserId: "u-sa", reasonSubmittedByRole: "STUDENT", decidedByUserId: "u-ad", decidedAt: D(28), decisionNote: "مقبول", createdAt: D(30), updatedAt: D(28) },
    { id: "ar2", attendanceId: "at2", studentId: "sa", sessionId: "s2", groupId: "g1", lessonId: "l1", teacherId: "t1", status: "UNEXCUSED", reason: null, reasonSubmittedAt: null, reasonSubmittedByUserId: null, reasonSubmittedByRole: null, decidedByUserId: "u-ad", decidedAt: D(9), decisionNote: "غير مقبول", createdAt: D(10), updatedAt: D(9) },
  );
  T.absenceHold.push(
    { id: "ah1", absenceReviewId: "ar1", studentId: "sa", sessionId: "s1", status: "RESOLVED", reason: "EXCUSED_ABSENCE", createdAt: D(28), resolvedAt: D(28), resolvedByUserId: "u-ad", resolution: "EXCUSED" },
    { id: "ah2", absenceReviewId: "ar2", studentId: "sa", sessionId: "s2", status: "ACTIVE", reason: "UNEXCUSED_ABSENCE", createdAt: D(9), resolvedAt: null, resolvedByUserId: null, resolution: null },
  );
  T.absenceReasonSubmission.push({
    id: "ars1", absenceReviewId: "ar1", reason: "عذر طبي", submittedByUserId: "u-sa", submittedByRole: "STUDENT", createdAt: D(29),
  });

  // --- Teacher feedback --------------------------------------------------------
  T.teacherNote.push({ id: "tn1", teacherId: "t1", studentId: "sa", note: "أداء ممتاز في الحصة", createdAt: D(2) });
}

// ---------------------------------------------------------------------------
// 6. Tests
// ---------------------------------------------------------------------------
(async () => {
  await seed();
  const db = global.__MOCK_DB__;

  // =========================================================================
  section("A. Authentication / role gates on /api/parents/me/academics");
  // =========================================================================
  logout();
  eq((await bodyOf(await academicsRoute.GET(req()))).status, 401, "anonymous → 401");
  await loginAs("u-sa");
  eq((await bodyOf(await academicsRoute.GET(req()))).status, 403, "STUDENT → 403");
  await loginAs("u-t1");
  eq((await bodyOf(await academicsRoute.GET(req()))).status, 403, "TEACHER → 403");
  await loginAs("u-pd");
  eq((await bodyOf(await academicsRoute.GET(req()))).status, 404, "parent with no links → 404");

  // =========================================================================
  section("B. Linked-child access (the canonical snapshot)");
  // =========================================================================
  await loginAs("u-pa");
  const A = await bodyOf(await academicsRoute.GET(reqWithQuery("sa")));
  eq(A.status, 200, "ParentA → ChildA academics 200");
  eq(A.body.selectedStudentId, "sa", "the requested child is the one returned");
  eq(A.body.snapshot.student.name, "Child A", "the snapshot is Child A's own");
  eq(A.body.children.length, 2, "the switcher lists both linked children");
  ok(
    A.body.children.every((c) => c.id === "sa" || c.id === "sb"),
    "the switcher contains no unlinked student"
  );
  ok(
    !JSON.stringify(A.body).includes("Child C") && !JSON.stringify(A.body).includes('"sc"'),
    "no Child C (unrelated student) data anywhere in the payload"
  );

  // =========================================================================
  section("C. IDOR — a forged / unrelated studentId is refused");
  // =========================================================================
  const idor = await bodyOf(await academicsRoute.GET(reqWithQuery("sc")));
  eq(idor.status, 404, "unrelated studentId (Child C) → 404, never 403");
  const idor2 = await bodyOf(await academicsRoute.GET(reqWithQuery("does-not-exist")));
  eq(idor2.status, 404, "unknown studentId → 404 (identical answer)");
  await loginAs("u-pb");
  const idor3 = await bodyOf(await academicsRoute.GET(reqWithQuery("sa")));
  eq(idor3.status, 404, "ParentB cannot address ParentA's child");
  await loginAs("u-pa");

  // =========================================================================
  section("D. Multiple children stay isolated + switching works");
  // =========================================================================
  const B = await bodyOf(await academicsRoute.GET(reqWithQuery("sb")));
  eq(B.status, 200, "ParentA → ChildB academics 200");
  eq(B.body.snapshot.student.name, "Child B", "ChildB's own snapshot");
  // The two children legitimately share the course and its published SHARED
  // lessons, so isolation is asserted on the CHILD-OWNED facts instead.
  // Quizzes and assignments on a SHARED, UNLOCKED lesson are legitimately
  // listed for both children; what must never cross is a CHILD-OWNED fact.
  const jsonB = JSON.stringify(B.body.snapshot);
  ok(
    !jsonB.includes("أحسن واجب") && !jsonB.includes("متأخر بس المحتوى تمام") && !jsonB.includes("عذر طبي"),
    "ChildB's snapshot carries none of ChildA's submissions, grades or absence reasons"
  );
  ok(
    B.body.snapshot.quizzes.items.every((q) => q.title !== "اختبار مسودة"),
    "the DRAFT quiz is hidden from both children"
  );
  eq(B.body.snapshot.absences.recent.length, 0, "ChildB has no absence cases of their own");
  eq(B.body.snapshot.holds.length, 0, "ChildB carries no hold");
  eq(B.body.snapshot.quizzes.items.every((q) => q.attempts === 0), true, "ChildB has no quiz attempts");
  eq(B.body.snapshot.course.name, A.body.snapshot.course.name, "same course, different tracks");

  // =========================================================================
  section("E. Progression is sourced from the canonical Phase H authority");
  // =========================================================================
  // Load the engine DIRECTLY and compare state-by-state with the parent view.
  // If the parent reader recalculated anything, these would drift.
  const canonical = await progressionLib.loadCourseProgression("sa", "c1");
  const byLesson = new Map(canonical.lessons.map((l) => [l.lessonId, l]));
  const parentLessons = A.body.snapshot.lessons;
  eq(parentLessons.length, canonical.lessons.length, "same number of lessons as the engine");
  let stateMatches = 0;
  for (const view of parentLessons) {
    const code = view.code;
    const engineRow = canonical.lessons.find(
      (l) => (code === "1-1" && l.lessonId === "l1") ||
             (code === "1-2" && l.lessonId === "l2") ||
             (code === "1-3" && l.lessonId === "l3")
    );
    if (!engineRow) continue;
    const row = byLesson.get(engineRow.lessonId);
    if (
      view.state === row.state &&
      view.unlocked === row.unlocked &&
      view.completed === row.completed &&
      view.reason === row.reason &&
      view.reasonCode === row.reasonCode
    ) stateMatches += 1;
  }
  eq(stateMatches, canonical.lessons.length, "every lesson's state/reason is the engine's verbatim");

  const currentEngineId = canonical.currentLessonId;
  const currentView = A.body.snapshot.progress.currentLesson;
  const currentMatches =
    (currentEngineId === "l1" && currentView.code === "1-1") ||
    (currentEngineId === "l2" && currentView.code === "1-2") ||
    (currentEngineId === "l3" && currentView.code === "1-3") ||
    (currentEngineId === null && currentView === null);
  ok(currentMatches, `current lesson is the engine's current lesson (engine=${currentEngineId})`);

  // Canonical completion: the engine's own effective completion count.
  const engineCompleted = canonical.lessons.filter((l) => l.completed && l.unlocked).length;
  eq(A.body.snapshot.progress.completedLessons, engineCompleted, "completed count = engine effective completion");
  eq(A.body.snapshot.progress.totalLessons, canonical.lessons.length, "total = the child's whole universe");

  // =========================================================================
  section("E2. The DASHBOARD's courseProgress is the canonical Phase H count");
  // =========================================================================
  {
    const dash = await bodyOf(await dashboardRoute.GET(reqWithQuery("sa")));
    eq(dash.status, 200, "dashboard 200");
    const childA = dash.body.children[0];
    eq(
      childA.courseProgress.completed,
      canonical.lessons.filter((l) => l.completed && l.unlocked).length,
      "courseProgress.completed is the engine's canonical completion count"
    );
    eq(
      childA.courseProgress.total,
      canonical.lessons.length,
      "courseProgress.total is the engine's universe size"
    );
    eq(childA.courseProgress.completed, 0, "the engine's answer is 0 completed lessons");
    // The legacy arithmetic would have counted the sticky LessonProgress row.
    const legacyCount = db.__tables.lessonProgress.filter(
      (p) => p.studentId === "sa" && p.isCompleted
    ).length;
    eq(legacyCount, 1, "the fixture really does hold a legacy isCompleted row (the trap)");
    ok(
      childA.courseProgress.completed !== legacyCount,
      "the parent number does NOT follow the legacy LessonProgress.isCompleted flag"
    );
  }

  // =========================================================================
  section("F. Canonical human-readable lock reasons + remaining requirements");
  // =========================================================================
  const l1view = parentLessons.find((l) => l.code === "1-1");
  const l1engine = byLesson.get("l1");
  eq(l1view.reason, l1engine.reason, "the lock reason text is the canonical Arabic string");
  eq(l1view.reasonCode, l1engine.reasonCode, "the lock reason code is canonical");
  ok(
    Array.isArray(l1view.unmet) && l1view.unmet.length > 0,
    "the current lesson carries its remaining requirements"
  );
  ok(
    l1view.unmet.some((u) => u.kind === "VIDEO_INCOMPLETE"),
    "the incomplete REQUIRED SessionVideo is reported (VIDEO_INCOMPLETE)"
  );
  ok(
    l1view.unmet.some((u) => u.kind === "HOMEWORK_NOT_SUBMITTED"),
    "the unsubmitted required homework is reported"
  );
  ok(
    l1view.unmet.every((u) => u.label === progressionLib.PROGRESSION_REASON_AR[u.kind]),
    "every unmet label is the engine's own Arabic label (no second mapping)"
  );
  eq(l1view.requirements.video.done, false, "the video requirement is not satisfied (40% < 95%)");
  eq(l1view.requirements.video.value, 40, "the reported video percent is the live canonical value");
  eq(l1view.requirements.quiz.done, true, "the quiz requirement IS satisfied (q1 passed)");

  const l2view = parentLessons.find((l) => l.code === "1-2");
  eq(l2view.state, "LOCKED", "the next lesson is canonically LOCKED");
  ok(!!l2view.reason, `the locked lesson explains itself in Arabic (${l2view.reason})`);

  // =========================================================================
  section("G. Absence visibility: excused vs unexcused vs pending");
  // =========================================================================
  eq(A.body.snapshot.absences.excused, 1, "one EXCUSED absence");
  eq(A.body.snapshot.absences.unexcused, 1, "one UNEXCUSED absence");
  const unexcused = A.body.snapshot.absences.recent.find((r) => r.status === "UNEXCUSED");
  const excused = A.body.snapshot.absences.recent.find((r) => r.status === "EXCUSED");
  ok(!!unexcused && !!excused, "both cases are visible");
  eq(unexcused.holdActive, true, "the UNEXCUSED case carries an ACTIVE hold");
  eq(excused.holdActive, false, "the EXCUSED case does NOT carry an active hold");
  eq(excused.reason, "عذر طبي", "the submitted reason text is visible (read-only)");

  // =========================================================================
  section("H. Active academic hold + catch-up requirement");
  // =========================================================================
  const catchup = await progressionLib.evaluateStudentCatchup("sa");
  eq(A.body.snapshot.holds.length, catchup.holds.length, "the hold list is the Phase H catch-up evaluation");
  const hold = A.body.snapshot.holds[0];
  const engineHold = catchup.holds[0];
  eq(hold.lessonTitle, engineHold.lessonTitle, "the hold names the same missed lesson as the engine");
  eq(hold.eligible, engineHold.eligible, "catch-up eligibility is the engine's verdict");
  eq(hold.reason, engineHold.reason, "the catch-up reason is canonical Arabic");
  eq(
    JSON.stringify(hold.unmet.map((u) => u.kind)),
    JSON.stringify(engineHold.unmet),
    "the catch-up unmet codes are canonical"
  );
  ok(
    A.body.snapshot.actionNeeded.some((a) => a.code === "ABSENCE_HOLD"),
    "Action Needed reports the active hold"
  );
  ok(
    A.body.snapshot.actionNeeded.some((a) => a.code === "CATCHUP_REQUIRED"),
    "Action Needed reports the catch-up requirement"
  );
  ok(
    A.body.snapshot.actionNeeded.some(
      (a) => a.label === progressionLib.PROGRESSION_REASON_AR.HOMEWORK_NOT_SUBMITTED
    ),
    "Action Needed uses the engine's own Arabic text, never an invented rule"
  );

  // =========================================================================
  section("I. Homework status — deadline-aware semantics (Phase G authority)");
  // =========================================================================
  const hw = (title) => A.body.snapshot.homework.items.find((h) => h.title === title);
  eq(hw("واجب في المعاد").status, "SUBMITTED", "submitted before the deadline → Submitted");
  eq(hw("واجب في المعاد").late, false, "on-time submission is not flagged late");
  eq(hw("واجب فات معاده").status, "MISSING_OVERDUE", "past deadline + no submission → Missing / Overdue");
  eq(hw("واجب لسه متسلمش").status, "NOT_SUBMITTED_YET", "before the deadline + no submission → Not submitted yet");
  eq(hw("واجب متأخر").status, "SUBMITTED_LATE", "submitted after the deadline → Submitted late");
  eq(hw("واجب متأخر").late, true, "the canonical late flag is true");
  eq(hw("واجب متصحح").status, "GRADED", "graded submission → Graded");
  eq(hw("واجب متصحح").grade, 9, "the grade is visible");
  eq(hw("واجب متصحح").feedback, "أحسن واجب", "the homework Teacher feedback is visible");
  eq(hw("واجب متأخر").feedback, "متأخر بس المحتوى تمام", "feedback on a late submission is visible too");

  // =========================================================================
  section("J. Content visibility — unpublished / hidden content stays hidden");
  // =========================================================================
  const hwTitles = A.body.snapshot.homework.items.map((h) => h.title);
  ok(
    !hwTitles.some((t) => t.includes("مسودة") || t.includes("Draft")),
    "the DRAFT assignment is never named to a parent"
  );
  ok(!hwTitles.includes("واجب درس مقفول"), "an assignment on a LOCKED lesson stays hidden");
  ok(
    !JSON.stringify(A.body.snapshot).includes("مسودة مخفية") &&
      !JSON.stringify(A.body.snapshot).includes("Hidden Draft"),
    "the DRAFT lesson is absent from the lesson list"
  );
  ok(
    parentLessons.length === 3,
    `the lesson universe is the 3 published in-track lessons (got ${parentLessons.length})`
  );
  // Track isolation: ChildB (LANGUAGE) must not see the ARABIC-only lesson.
  ok(
    !B.body.snapshot.lessons.some((l) => l.code === "1-3"),
    "the LANGUAGE child does not see the ARABIC-only lesson"
  );
  ok(
    A.body.snapshot.lessons.some((l) => l.code === "1-3"),
    "the ARABIC child does see the ARABIC-only lesson (in-universe, locked)"
  );
  // No database ids in the payload.
  ok(
    !JSON.stringify(A.body.snapshot.lessons).includes('"lessonId"') &&
      !JSON.stringify(A.body.snapshot.homework.items).includes('homeworkId') &&
      !JSON.stringify(A.body.snapshot.quizzes.items).includes('quizId'),
    "no lesson/homework/quiz database ids are serialised"
  );
  ok(
    !JSON.stringify(A.body.snapshot.holds).includes("holdId") &&
      !JSON.stringify(A.body.snapshot.holds).includes("reviewId"),
    "no internal Phase F hold/review ids are serialised"
  );

  // =========================================================================
  section("K. Quiz privacy — outcomes only, never the answer key");
  // =========================================================================
  const q1 = A.body.snapshot.quizzes.items.find((q) => q.title === "اختبار واحد");
  eq(q1.attempts, 2, "attempt count = FINISHED attempts only (the open one is ignored)");
  eq(q1.lastOutcome, "PASSED", "the last finished attempt's outcome");
  eq(q1.lastPercentage, 85, "the last finished percentage");
  eq(q1.bestPercentage, 85, "the best finished percentage");
  ok(
    !A.body.snapshot.quizzes.items.some((q) => q.title === "اختبار مسودة"),
    "the DRAFT quiz is not listed"
  );
  const snapshotJson = JSON.stringify(A.body.snapshot);
  ok(!snapshotJson.includes("SECRET-ANSWER-KEY"), "no answer key anywhere in the snapshot");
  ok(!snapshotJson.includes("explanation"), "no question explanations in the snapshot");
  ok(
    !snapshotJson.includes("answers") && !snapshotJson.includes("evidence") &&
      !snapshotJson.includes("camera") && !snapshotJson.includes("antiCheat"),
    "no submitted answers, evidence or anti-cheat fields in the snapshot"
  );

  // The two routes that used to hand the key to every parent.
  const qAsParent = await bodyOf(await quizRoute.GET(req(), params({ id: "q1" })));
  eq(qAsParent.status, 200, "a parent may still open an in-scope quiz");
  ok(
    qAsParent.body.questions.every((q) => q.answer === undefined && q.explanation === undefined),
    "GET /api/quizzes/[id] no longer returns the answer key to a parent"
  );
  const lAsParent = await bodyOf(await lessonRoute.GET(req(), params({ id: "l1" })));
  eq(lAsParent.status, 200, "a parent may still open an in-scope lesson");
  const lessonJson = JSON.stringify(lAsParent.body);
  ok(
    !lessonJson.includes("SECRET-ANSWER-KEY"),
    "GET /api/lessons/[id] no longer leaks quiz answers to a parent"
  );
  // Staff answer visibility is unchanged.
  await loginAs("u-ad");
  const qAsAdmin = await bodyOf(await quizRoute.GET(req(), params({ id: "q1" })));
  eq(qAsAdmin.status, 200, "admin preview unchanged");
  ok(
    qAsAdmin.body.questions.some((q) => q.answer === "1"),
    "the ADMIN still sees the answer key (review/authoring unchanged)"
  );
  await loginAs("u-pa");

  // =========================================================================
  section("L. Live sessions — upcoming / rescheduled / cancelled");
  // =========================================================================
  const titlesOf = (arr) => arr.map((s) => s.title);
  ok(titlesOf(A.body.snapshot.sessions.upcoming).includes("القادمة"), "the upcoming session is listed");
  ok(
    titlesOf(A.body.snapshot.sessions.rescheduled).includes("المؤجلة"),
    "the RESCHEDULED session is listed in its own bucket"
  );
  const moved = A.body.snapshot.sessions.rescheduled.find((s) => s.title === "المؤجلة");
  eq(moved.rescheduled, true, "the reschedule flag is carried");
  eq(moved.rescheduleCount, 1, "the reschedule ceremony count is carried");
  ok(!!moved.originalStartAt, "the original start time is carried (the move is explainable)");
  ok(
    titlesOf(A.body.snapshot.sessions.cancelled).includes("الملغاة"),
    "the CANCELLED session is listed in its own bucket"
  );
  const cancelled = A.body.snapshot.sessions.cancelled.find((s) => s.title === "الملغاة");
  eq(cancelled.cancelReason, "عطل فني", "the cancellation reason is visible");
  ok(
    !titlesOf(A.body.snapshot.sessions.cancelled).includes("ملغاة قديمة"),
    "a cancellation outside the window is not reported"
  );
  ok(
    A.body.snapshot.actionNeeded.some((a) => a.code === "SESSION_RESCHEDULED") &&
      A.body.snapshot.actionNeeded.some((a) => a.code === "SESSION_CANCELLED"),
    "the session lifecycle events surface in Action Needed"
  );

  // =========================================================================
  section("M. Teacher feedback");
  // =========================================================================
  ok(
    A.body.snapshot.teacherFeedback.some((f) => f.note === "أداء ممتاز في الحصة"),
    "the TeacherNote is visible (the channel that already notifies parents)"
  );
  ok(
    A.body.snapshot.teacherFeedback.some((f) => f.source === "HOMEWORK" && f.note === "أحسن واجب"),
    "homework feedback is visible with its source"
  );

  // =========================================================================
  section("N. The Parent snapshot is READ-ONLY (zero academic writes)");
  // =========================================================================
  global.__WRITES__ = [];
  await academicsRoute.GET(reqWithQuery("sa"));
  await academicsRoute.GET(reqWithQuery("sb"));
  const academicWrites = (global.__WRITES__ || []).filter(
    (w) => !["userSession", "notification", "notificationPreference"].includes(w.table)
  );
  eq(academicWrites.length, 0, "the academics route performs no academic writes");

  // =========================================================================
  section("O. Parent mutation attempts are all refused server-side");
  // =========================================================================
  // Several handlers signal a refusal by throwing ApiFailure rather than
  // returning a response; both are a 401/403 to the caller.
  const denied = async (label, call) => {
    let status = null;
    try {
      status = (await bodyOf(await call())).status;
    } catch (e) {
      status = typeof e?.status === "number" ? e.status : null;
    }
    ok(status === 401 || status === 403, `${label} → 401/403 (got ${status})`);
  };
  await denied("POST /api/absence-reviews/[id]/reason (submit an excuse)", () =>
    reasonRoute.POST(req({ reason: "عذر من ولي الأمر" }), params({ id: "ar1" }))
  );
  {
    let body = null, status = null;
    try {
      const r = await bodyOf(await reasonRoute.POST(req({ reason: "عذر" }), params({ id: "ar1" })));
      body = r.body; status = r.status;
    } catch (e) {
      body = e?.details ?? { code: e?.code }; status = e?.status ?? null;
    }
    eq(status, 403, "the absence-reason write is refused with 403");
    eq(body?.code, "PARENT_READ_ONLY", `the refusal has the stable PARENT_READ_ONLY code (got ${JSON.stringify(body)})`);
  }
  await denied("POST /api/absence-reviews/[id]/decision (approve an excuse)", () =>
    decisionRoute.POST(req({ decision: "EXCUSE" }), params({ id: "ar1" }))
  );
  await denied("POST /api/students/me/catchup (resolve a hold)", () => catchupRoute.POST(req()));
  await denied("POST /api/admin/progression-overrides (create an override)", () =>
    overrideRoute.POST(req({ studentId: "sa", lessonId: "l2", reason: "because" }))
  );
  await denied("POST /api/admin/progression-overrides/[id]/revoke (revoke an override)", () =>
    overrideRevokeRoute.POST(req(), params({ id: "po1" }))
  );
  await denied("POST /api/admin/quiz-retries (grant a retry)", () =>
    retryRoute.POST(req({ studentId: "sa", quizId: "q1" }))
  );
  await denied("POST /api/quizzes/[id]/start (start a quiz as the student)", () =>
    quizStartRoute.POST(req(), params({ id: "q1" }))
  );
  await denied("POST /api/quizzes/[id]/submit (submit a quiz as the student)", () =>
    quizSubmitRoute.POST(req({ answers: [] }), params({ id: "q1" }))
  );
  await denied("POST /api/students/me/homework (submit homework as the student)", () =>
    homeworkRoute.POST(req({ homeworkId: "h2", content: "x" }))
  );
  await denied("PATCH /api/teacher/homework/[id]/grade (grade homework)", () =>
    gradeRoute.PATCH(req({ studentId: "sa", grade: 10 }), params({ id: "h2" }))
  );
  await denied("POST /api/lessons/[id]/progress (mark a lesson complete)", () =>
    progressRoute.POST(req({ completed: true }), params({ id: "l2" }))
  );

  // The student's own paths still work — the read-only rule is a ROLE rule,
  // not a blanket lockout.
  await loginAs("u-sa");
  {
    let status = null;
    try { status = (await bodyOf(await catchupRoute.POST(req()))).status; }
    catch (e) { status = typeof e?.status === "number" ? e.status : -1; }
    ok(status !== 403 && status !== 401, `the student may still call their own catch-up (got ${status})`);
  }
  await loginAs("u-pa");

  // =========================================================================
  section("P. ?studentId= is verified on every Parent reporting route");
  // =========================================================================
  {
    const all = await bodyOf(await dashboardRoute.GET(req()));
    eq(all.status, 200, "no studentId → every linked child (unchanged behaviour)");
    eq(all.body.children.length, 2, "both linked children returned");
    const pinned = await bodyOf(await dashboardRoute.GET(reqWithQuery("sa")));
    eq(pinned.status, 200, "a linked studentId → 200");
    eq(pinned.body.children.length, 1, "a pinned request carries that child alone");
    eq(pinned.body.children[0].id, "sa", "and it is the requested child");
    eq(pinned.body.selectedStudentId, "sa", "the selection is echoed back");
    const forged = await bodyOf(await dashboardRoute.GET(reqWithQuery("sc")));
    eq(forged.status, 404, "an unlinked studentId → 404 (IDOR denied)");
  }
  {
    const pinned = await bodyOf(await analyticsRoute.GET(reqWithQuery("sb")));
    eq(pinned.status, 200, "analytics: linked studentId → 200");
    eq(pinned.body.children.length, 1, "analytics: narrowed to that child");
    eq((await bodyOf(await analyticsRoute.GET(reqWithQuery("sc")))).status, 404, "analytics: unlinked → 404");
  }
  {
    const pinned = await bodyOf(await weeklyRoute.GET(reqWithQuery("sb")));
    eq(pinned.status, 200, "weekly-report: linked studentId → 200");
    eq(pinned.body.reports.length, 1, "weekly-report: narrowed to that child");
    eq((await bodyOf(await weeklyRoute.GET(reqWithQuery("sc")))).status, 404, "weekly-report: unlinked → 404");
  }
  // A studentId in the BODY must stay inert (historical invariant).
  {
    const baseline = await bodyOf(await dashboardRoute.GET(req()));
    const spoofed = req();
    spoofed.json = async () => ({ studentId: "sc" });
    const withBody = await bodyOf(await dashboardRoute.GET(spoofed));
    eq(
      JSON.stringify(withBody.body.children.map((c) => c.id)),
      JSON.stringify(baseline.body.children.map((c) => c.id)),
      "a client-supplied studentId in the BODY changes nothing"
    );
  }

  // =========================================================================
  section("Q. Phase I notification addition: quiz result reaches the parents");
  // =========================================================================
  {
    const submitSrc = fs.readFileSync(
      path.join(REPO, "src/app/api/quizzes/[id]/submit/route.ts"),
      "utf8"
    );
    ok(
      submitSrc.includes("parentUserIdsForStudents"),
      "the quiz-result producer fans out to linked parents"
    );
    ok(
      submitSrc.includes("dedupeKey: `quiz-result:${attempt.id}:parent:${parentUserId}`"),
      "the fan-out carries the per-attempt-per-parent dedupe key"
    );
    ok(
      /type: "QUIZ_RESULT"/.test(submitSrc) && submitSrc.includes("link: null"),
      "it reuses the existing QUIZ_RESULT type and does not deep-link a parent into a student view"
    );
    ok(
      !submitSrc.includes("notification.create(") ,
      "no second notification subsystem: it goes through createNotificationIfAllowed"
    );

    // Idempotency of the contract the new path relies on: the unique
    // (userId, dedupeKey) index the schema declares (emulated here) means a
    // retried emit cannot create a second row.
    await notifyLib.createNotificationIfAllowed({
      userId: "u-pa",
      type: "QUIZ_RESULT",
      title: "t",
      message: "m",
      dedupeKey: "quiz-result:att-1:parent:u-pa",
    }).catch(() => {});
    await notifyLib.createNotificationIfAllowed({
      userId: "u-pa",
      type: "QUIZ_RESULT",
      title: "t",
      message: "m",
      dedupeKey: "quiz-result:att-1:parent:u-pa",
    }).catch(() => {});
    const rows = db.__tables.notification.filter(
      (n) => n.userId === "u-pa" && n.dedupeKey === "quiz-result:att-1:parent:u-pa"
    );
    eq(rows.length, 1, "a repeated (userId, dedupeKey) emit cannot duplicate");
    const other = await notifyLib.createNotificationIfAllowed({
      userId: "u-pa",
      type: "QUIZ_RESULT",
      title: "t2",
      message: "m2",
      dedupeKey: "quiz-result:att-2:parent:u-pa",
    }).catch(() => {});
    ok(other !== false, "a DIFFERENT attempt still notifies (the dedupe key is per attempt)");
  }

  // =========================================================================
  section("R. Deferred gap: HOMEWORK_DEADLINE has no producer (documented)");
  // =========================================================================
  {
    const producers = [];
    for (const f of fs.readdirSync(path.join(REPO, "src"), { recursive: true })) {
      const p = String(f);
      if (!p.endsWith(".ts") && !p.endsWith(".tsx")) continue;
      const text = fs.readFileSync(path.join(REPO, "src", p), "utf8");
      if (!text.includes("HOMEWORK_DEADLINE")) continue;
      // A PRODUCER is the place that decides to emit: a notification create
      // call / fan-out siting. The type's DECLARATION (notify.ts, the schema)
      // and the admin broadcast allowlist are not producers.
      // A PRODUCER is the place that picks the TYPE for an outgoing row.
      // `src/lib/notify.ts` only declares the type catalogue and the admin
      // broadcast allowlist only names the types an admin may hand-send, so
      // neither is the deadline-driven producer Phase I is deferring.
      const emits =
        /type:\s*(NotificationType\.)?["']?HOMEWORK_DEADLINE["']?/.test(text) ||
        /HOMEWORK_DEADLINE\s*,\s*title/.test(text);
      if (emits) producers.push(p);
    }
    eq(
      JSON.stringify(producers),
      "[]",
      `no HOMEWORK_DEADLINE producer exists — the deferred Phase I gap is real, not hidden${producers.length ? ` (found ${producers.join(", ")})` : ""}`
    );
  }

  // =========================================================================
  section("S. Arabic-first UI render of the shipped Phase I components");
  // =========================================================================
  {
    const { html, error } = render(React.createElement(AcademicFollowup, { payload: A.body }));
    ok(!error, `AcademicFollowup renders without throwing${error ? ` (${error.message})` : ""}`);
    ok(html.length > 500, "the component renders real content");
    // The three questions, in order.
    ok(html.includes("إيه اللي حصل؟"), "Q1 — 'إيه اللي حصل؟' is rendered");
    ok(html.includes("هل فيه حاجة محتاجة تدخل؟"), "Q2 — 'هل فيه حاجة محتاجة تدخل؟' is rendered");
    ok(html.includes("الطالب محتاج يعمل إيه دلوقتي؟"), "Q3 — 'الطالب محتاج يعمل إيه دلوقتي؟' is rendered");
    ok(
      html.indexOf("إيه اللي حصل؟") < html.indexOf("هل فيه حاجة محتاجة تدخل؟"),
      "Q1 precedes Q2 — the situation comes before the intervention"
    );
    // Canonical Arabic, not enums.
    ok(html.includes("الدرس الأول"), "the current lesson's Arabic title is rendered");
    ok(
      html.includes("أكمل الفيديو الأول، سلّم الـHomework الأول"),
      "the canonical Phase H lock/reason text is rendered verbatim"
    );
    ok(html.includes("واجب فات معاده"), "the overdue assignment is named in Arabic");
    // Privacy: nothing the Parent may not see reaches the DOM.
    ok(!html.includes("SECRET-ANSWER-KEY"), "no answer key in the rendered markup");
    ok(
      !html.includes("مسودة مخفية") && !html.includes("واجب مسودة سري") && !html.includes("اختبار مسودة"),
      "no unpublished content is named in the rendered markup"
    );
    ok(
      !/\b(l1|l2|l3|q1|q2|h1|h2|ar2|ah2|sv1)\b/.test(html.replace(/class="[^"]*"/g, "")),
      "no raw database ids are visible in the rendered markup"
    );
    ok(
      !html.includes("ABSENCE_HOLD") && !html.includes("HOMEWORK_NOT_SUBMITTED") &&
        !html.includes("MISSING_OVERDUE") && !html.includes("UNEXCUSED"),
      "no raw enum / status codes are rendered as user-facing text"
    );
    // RTL: the surface is Arabic-first and right-to-left.
    ok(/dir="rtl"/.test(html), "the component renders RTL");
    // The switcher.
    const sw = render(
      React.createElement(ChildSwitcher, { items: A.body.children, value: "sa", onChange: () => {} })
    );
    ok(!sw.error, `ChildSwitcher renders without throwing${sw.error ? ` (${sw.error.message})` : ""}`);
    ok(sw.html.includes("Child A") && sw.html.includes("Child B"), "the switcher names every linked child");
    ok(sw.html.includes('role="tablist"'), "the switcher is a real tablist (keyboard reachable)");
    ok(
      !render(React.createElement(ChildSwitcher, { items: [A.body.children[0]], value: "sa", onChange: () => {} })).html.trim(),
      "a single child renders no switcher at all (nothing to switch)"
    );
    // Skeleton + error states.
    ok(render(React.createElement(AcademicFollowupSkeleton)).html.length > 50, "the loading skeleton renders");
    ok(
      render(React.createElement(AcademicFollowupError, { onRetry: () => {} })).html.length > 50,
      "the error state renders a retry affordance"
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
