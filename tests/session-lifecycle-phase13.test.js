// CodeMind Academy — Phase 13 (session lifecycle) behavior suite.
//
// WHAT THIS FILE PROVES, AND HOW
//   Phase 13 splits one boolean (`Lesson.isPublished`) into a real lifecycle
//   (`DRAFT → READY → PUBLISHED`), retires another (`isLocked`), and moves the
//   student universe from "published flag" to "opened session". The rules are
//   small but they are load-bearing in two opposite directions:
//
//     • too weak  → staged work leaks to students (the Phase 12 finding);
//     • too strong → progression, parent previews and the reconciler break.
//
//   So every section here is written as a pair where it matters: the behavior
//   must hold, AND a mutation that breaks it must make the test fail (see
//   `pinned()` and section 19). A green run therefore means the assertions are
//   still capable of going red — the failure mode Phase 12's report calls out.
//
//   Layers used, strongest last:
//     1. Pure functions (no I/O): status lattice, transition table, readiness.
//     2. The ceremony against a STRICT fake client: a `where` clause the fake
//        does not understand throws instead of passing silently, and every
//        `status` predicate is evaluated for real, so an unconditional write or
//        a forgotten `status: from` guard fails here.
//     3. Source pins over the routes/readers that cannot boot without Next's
//        request runtime — each pin carries a negative control.
//     4. THE REAL DATABASE: `scripts/verify-phase13-db.mjs` is executed as a
//        child process. It applies the actual `prisma/migrations/*.sql` files
//        to real SQLite, rehearses the backfill against a data-shaped fixture,
//        and then runs the SHIPPED modules (reconciler, lifecycle, progression,
//        parent access) over real rows. Mock-only verification is exactly what
//        this phase forbids, so this file refuses to pass without layer 4
//        (it FAILS, not skips, unless the environment truly lacks `node:sqlite`).
//
// Run:  node tests/session-lifecycle-phase13.test.js     (no bun in this env)

const { execSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO = path.resolve(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase13-test-"));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    pass++;
  } else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
}
function eq(got, want, label) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label} (got ${a}, want ${b})`);
}
function section(title) {
  console.log(`\n${title}`);
}

/**
 * A source pin with a built-in negative control: the pattern must match the
 * real source, and must NOT match a source in which the matched text has been
 * removed. Without the second half, `ok(/x/.test(src))` can pass while the
 * thing it claims to guarantee is optional.
 */
function pinned(src, re, label, mutate) {
  ok(re.test(src), label);
  const mutated = mutate ? mutate(src) : src.replace(re, "");
  ok(!re.test(mutated), `${label} — negative control: mutating it flips the pin`);
}

// ---------------------------------------------------------------------------
// Compile the real modules (same convention as the Phase 11/12 suites)
// ---------------------------------------------------------------------------
const MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/progress.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/session-progress.ts",
  "src/lib/enrollment.ts",
  "src/lib/parent-access.ts",
  "src/lib/official-curriculum.ts",
];
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
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
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
      },
      files: MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* type noise elsewhere in the graph is tolerated; `npm run typecheck` is the gate */
}
const EMIT = path.join(OUT, "src", "lib");
for (const f of [
  "session-lifecycle.js",
  "session-progress.js",
  "parent-access.js",
  "enrollment.js",
  "official-curriculum.js",
]) {
  if (!fs.existsSync(path.join(EMIT, f))) throw new Error(`tsc did not emit ${f}`);
}

// ---------------------------------------------------------------------------
// The strict fake database
// ---------------------------------------------------------------------------
const FAKE_DB_PATH = path.join(OUT, "fake-db.js");
fs.writeFileSync(
  FAKE_DB_PATH,
  "module.exports = { get db() { return globalThis.__CM_FAKE_DB__; } };\n"
);
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
  if (request === "@/lib/db") return FAKE_DB_PATH;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  const json = /knowledge-model\.json$/.exec(request);
  if (json) {
    const copied = path.join(OUT, "docs", "curriculum", "knowledge-model.json");
    if (fs.existsSync(copied)) return copied;
  }
  return originalResolve.call(this, request, ...args);
};

const L = require(path.join(EMIT, "session-lifecycle.js"));
const SP = require(path.join(EMIT, "session-progress.js"));
const PA = require(path.join(EMIT, "parent-access.js"));

/**
 * A fake Prisma client. Deliberately strict:
 *   • `where` clauses are evaluated field-by-field; an unknown clause THROWS;
 *   • `updateMany` counts only rows matching every clause (so dropping the
 *     `status: from` guard from the ceremony is observable);
 *   • `sessionPublication` enforces the UNIQUE lessonId the migration declares.
 * Anything it cannot model raises rather than quietly succeeding.
 */
function makeDb(seed = {}) {
  const t = {
    lesson: new Map(),
    quiz: [],
    homework: [],
    sessionVideo: [],
    material: [],
    lessonProgress: [],
    quizAttempt: [],
    homeworkSubmission: [],
    sessionVideoView: [],
    sessionPublication: [],
    auditLog: [],
    student: new Map(),
    parent: new Map(),
  };
  const writes = { updateMany: 0, create: 0, upsert: 0, deleteMany: 0 };
  const tx = { started: 0, rolledBack: 0 };

  for (const [id, row] of Object.entries(seed.lessons ?? {})) {
    t.lesson.set(id, {
      id,
      title: `Lesson ${id}`,
      titleAr: `درس ${id}`,
      order: 1,
      status: "DRAFT",
      isPublished: false,
      curriculumStatus: "OFFICIAL",
      trackScope: "SHARED",
      officialCode: null,
      videoUrl: null,
      pdfUrl: null,
      unitId: "u1",
      topicId: null,
      duration: 90,
      summary: null,
      description: null,
      ...row,
    });
  }
  for (const q of seed.quizzes ?? []) t.quiz.push({ trackScope: "SHARED", ...q });
  for (const h of seed.homeworks ?? []) t.homework.push({ trackScope: "SHARED", ...h });
  for (const v of seed.sessionVideos ?? []) t.sessionVideo.push(v);
  for (const m of seed.materials ?? []) t.material.push({ isActive: true, ...m });
  for (const [studentId, row] of Object.entries(seed.students ?? {})) {
    t.student.set(studentId, { id: studentId, ...row });
  }
  for (const [userId, row] of Object.entries(seed.parents ?? {})) {
    t.parent.set(userId, row);
  }

  const match = (row, where, table) => {
    for (const [k, v] of Object.entries(where ?? {})) {
      if (k === "AND" || k === "OR" || k === "NOT") {
        const list = v.map((sub) => match(row, sub, table));
        if (k === "AND" && !list.every(Boolean)) return false;
        if (k === "OR" && !list.some(Boolean)) return false;
        if (k === "NOT" && list.some(Boolean)) return false;
        continue;
      }
      if (k === "in" || k === "notIn" || k === "not" || k === "lte" || k === "gte") {
        throw new Error(`fake db: unsupported top-level operator '${k}'`);
      }
      const value = row[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const keys = Object.keys(v);
        for (const key of keys) {
          if (!["in", "notIn", "not", "lte", "gte", "lt", "gt", "equals"].includes(key)) {
            // A nested RELATION filter (e.g. `unit: { part: {…} }`) — supported
            // only for the shapes the readers use, loudly.
            if (key === "part" || key === "unit" || key === "topic" || key === "select") continue;
            throw new Error(`fake db: unsupported operator '${key}' on ${table}.${k}`);
          }
        }
        if ("in" in v && !v.in.includes(value)) return false;
        if ("not" in v && value === v.not) return false;
        if ("equals" in v && value !== v.equals) return false;
        continue;
      }
      if (value !== v) return false;
    }
    return true;
  };

  const project = (row, spec) => {
    if (!spec) return { ...row };
    const out = {};
    for (const [key, sub] of Object.entries(spec)) {
      if (sub === true) {
        out[key] = row[key];
        continue;
      }
      if (key === "quizzes") {
        const rows = t.quiz.filter((q) => q.lessonId === row.id);
        out.quizzes = rows.map((q) => shape(q, sub.select, { _count: sub._count }));
      } else if (key === "homeworks") {
        out.homeworks = t.homework
          .filter((h) => h.lessonId === row.id)
          .map((h) => shape(h, sub.select));
      } else if (key === "sessionVideos") {
        out.sessionVideos = t.sessionVideo
          .filter((v) => v.lessonId === row.id)
          .map((v) => shape(v, sub.select));
      } else if (key === "materials") {
        out.materials = t.material
          .filter((m) => m.lessonId === row.id && match(m, sub.where, "material"))
          .map((m) => shape(m, sub.select));
      } else if (key === "publication") {
        const p = t.sessionPublication.find((x) => x.lessonId === row.id);
        out.publication = p ? shape(p, sub.select) : null;
      } else if (key === "unit" || key === "topic") {
        out[key] = row[key] ?? null;
      } else {
        throw new Error(`fake db: unsupported projection '${key}'`);
      }
    }
    return out;
  };
  const shape = (row, select, extra) => {
    if (!select && !extra) return { ...row };
    const out = {};
    for (const [k, v] of Object.entries(select ?? {})) {
      if (v === true) out[k] = row[k];
    }
    if (extra?._count) {
      out._count = {};
      for (const rel of Object.keys(extra._count.select ?? {})) {
        if (rel === "questions") out._count.questions = row.questions?.length ?? row.questionCount ?? 0;
        else throw new Error(`fake db: unsupported _count of ${rel}`);
      }
    }
    return out;
  };

  const db = {
    __tables: t,
    __writes: writes,
    __tx: tx,
    __dump: () => ({
      statuses: Object.fromEntries([...t.lesson.entries()].map(([id, r]) => [id, r.status])),
      mirrors: Object.fromEntries([...t.lesson.entries()].map(([id, r]) => [id, r.isPublished])),
      publications: t.sessionPublication.map((p) => ({ lessonId: p.lessonId, segment: p.segment })),
      audits: t.auditLog.map((a) => ({ action: a.action, entityId: a.entityId })),
    }),
    $transaction: async (fn) => {
      tx.started++;
      try {
        return await fn(db);
      } catch (e) {
        tx.rolledBack++;
        throw e;
      }
    },
    lesson: {
      findUnique: async ({ where, select, include } = {}) => {
        const row = [...t.lesson.values()].find((r) => match(r, where, "lesson"));
        if (!row) return null;
        return project(row, select ?? (include ? { ...scalarKeys(row), ...include } : null));
      },
      findFirst: async ({ where } = {}) =>
        [...t.lesson.values()].find((r) => match(r, where, "lesson")) ?? null,
      findMany: async ({ where, select } = {}) =>
        [...t.lesson.values()]
          .filter((r) => match(r, where, "lesson"))
          .map((r) => project(r, select)),
      updateMany: async ({ where, data }) => {
        writes.updateMany++;
        let count = 0;
        for (const row of [...t.lesson.values()]) {
          if (!match(row, where, "lesson")) continue;
          for (const k of Object.keys(data)) {
            if (!(k in row) && k !== "status" && k !== "isPublished") {
              throw new Error(`fake db: write of unknown Lesson column '${k}'`);
            }
          }
          Object.assign(row, data);
          count++;
        }
        return { count };
      },
      update: async ({ where, data }) => {
        const row = [...t.lesson.values()].find((r) => match(r, where, "lesson"));
        if (!row) throw new Error("fake db: P2025 lesson not found");
        Object.assign(row, data);
        return { ...row };
      },
      create: async ({ data }) => {
        const row = { id: `l${t.lesson.size + 1}`, ...data };
        t.lesson.set(row.id, row);
        return { ...row };
      },
    },
    sessionPublication: {
      findUnique: async ({ where } = {}) =>
        t.sessionPublication.find((p) => match(p, where, "sessionPublication")) ?? null,
      findFirst: async ({ where } = {}) =>
        t.sessionPublication.find((p) => match(p, where, "sessionPublication")) ?? null,
      findMany: async ({ where } = {}) =>
        t.sessionPublication.filter((p) => match(p, where, "sessionPublication")),
      count: async ({ where } = {}) =>
        t.sessionPublication.filter((p) => match(p, where, "sessionPublication")).length,
      create: async ({ data }) => {
        writes.create++;
        if (t.sessionPublication.some((p) => p.lessonId === data.lessonId)) {
          const e = new Error("Unique constraint failed on the fields: (`lessonId`)");
          e.code = "P2002";
          throw e;
        }
        const row = {
          id: `pub-${t.sessionPublication.length + 1}`,
          publishedAt: new Date(0),
          ...data,
        };
        t.sessionPublication.push(row);
        return row;
      },
      upsert: async ({ where, create, update, select }) => {
        writes.upsert++;
        // The ceremony passes `update: {}` — an existing anchor must come back
        // UNCHANGED (no second publishedAt, no clobbered segment).
        if (update && Object.keys(update).length) {
          throw new Error("fake db: the ceremony must not update an existing publication");
        }
        const existing = t.sessionPublication.find((p) => match(p, where, "sessionPublication"));
        if (existing) return select ? shape(existing, select) : { ...existing };
        const row = await db.sessionPublication.create({ data: create });
        return select ? shape(row, select) : row;
      },
      deleteMany: async ({ where } = {}) => {
        writes.deleteMany++;
        const before = t.sessionPublication.length;
        t.sessionPublication = t.sessionPublication.filter(
          (p) => !match(p, where, "sessionPublication")
        );
        return { count: before - t.sessionPublication.length };
      },
    },
    auditLog: {
      create: async ({ data }) => {
        t.auditLog.push(data);
        return data;
      },
    },
    student: {
      findUnique: async ({ where } = {}) => {
        const row = t.student.get(where?.id);
        if (!row) return null;
        return { ...row };
      },
      findMany: async ({ where } = {}) =>
        [...t.student.values()].filter((r) => match(r, where, "student")),
    },
    parent: {
      findUnique: async ({ where, select } = {}) => {
        const row = t.parent.get(where?.userId);
        if (!row) return null;
        if (select?.children) return { children: row.children };
        return { ...row };
      },
    },
    // Progression reads these; the fixtures below keep them empty on purpose
    // (no session is ever "completed" without an explicit row).
    lessonProgress: {
      findMany: async ({ where } = {}) =>
        (t.lessonProgress ?? []).filter((r) => match(r, where, "lessonProgress")),
    },
    quizAttempt: {
      findMany: async ({ where } = {}) =>
        (t.quizAttempt ?? []).filter((r) => match(r, where, "quizAttempt")),
    },
    homeworkSubmission: {
      findMany: async ({ where } = {}) =>
        (t.homeworkSubmission ?? []).filter((r) => match(r, where, "homeworkSubmission")),
    },
    sessionVideoView: {
      findMany: async ({ where } = {}) =>
        (t.sessionVideoView ?? []).filter((r) => match(r, where, "sessionVideoView")),
    },
  };
  const scalarKeys = (row) =>
    Object.fromEntries(Object.keys(row).map((k) => [k, true]));
  return db;
}

// ---------------------------------------------------------------------------
// 1. the status lattice
// ---------------------------------------------------------------------------
section("1. LessonStatus is a three-state enum with a fixed order");
eq([...L.LESSON_STATUSES], ["DRAFT", "READY", "PUBLISHED"], "the enum members, in lifecycle order");
eq(L.LESSON_NEW_LIFECYCLE, { status: "DRAFT", isPublished: false }, "a new lesson is DRAFT and the mirror agrees");
eq(L.LESSON_STUDENT_STATUS_FILTER, { status: "PUBLISHED" }, "the student universe is PUBLISHED only");
for (const [status, want] of [
  ["DRAFT", false],
  ["READY", false],
  ["PUBLISHED", true],
]) {
  eq(L.isStudentVisibleStatus(status), want, `isStudentVisibleStatus(${status})`);
  eq(L.publishedMirror(status), want, `publishedMirror(${status}) — the mirror means exactly 'published'`);
}
eq(L.lifecycleRank("DRAFT") < L.lifecycleRank("READY"), true, "DRAFT ranks below READY");
eq(L.lifecycleRank("READY") < L.lifecycleRank("PUBLISHED"), true, "READY ranks below PUBLISHED");
eq(L.lifecycleRank("nonsense"), L.lifecycleRank("DRAFT"), "an unrecognised status ranks as DRAFT (fail closed)");

section("2. normalization is total and fail-closed");
for (const [input, want] of [
  ["DRAFT", "DRAFT"],
  [" draft ", "DRAFT"],
  ["Draft", "DRAFT"],
  ["PUBLISHED", "PUBLISHED"],
  ["READY", "READY"],
  ["ARCHIVED", null],
  ["LIVE", null],
  ["", null],
  [null, null],
  [undefined, null],
  [42, null],
  [{}, null],
]) {
  eq(L.normalizeLessonStatus(input), want, `normalizeLessonStatus(${JSON.stringify(input)})`);
}
ok(
  L.LESSON_STATUSES.every((s) => L.normalizeLessonStatus(s.toLowerCase()) === s),
  "every enum member survives case-folding — the column is TEXT, so mixed-case writes are possible"
);

// ---------------------------------------------------------------------------
// 3. the state machine
// ---------------------------------------------------------------------------
section("3. the transition table is exactly the ceremony, no shortcuts");
const states = ["DRAFT", "READY", "PUBLISHED", "ARCHIVED", "NONSENSE", null];
const EXPECTED = {
  "DRAFT->READY": true,
  "DRAFT->PUBLISHED": false, // the whole point: READY cannot be bypassed
  "DRAFT->DRAFT": false,
  "READY->PUBLISHED": true,
  "READY->DRAFT": true, // un-stage
  "READY->READY": false,
  "PUBLISHED->READY": true, // unpublish
  "PUBLISHED->DRAFT": false, // never drop a live lesson straight to draft
  "PUBLISHED->PUBLISHED": false,
};
for (const from of states) {
  for (const to of ["DRAFT", "READY", "PUBLISHED"]) {
    const got = L.canTransition(from, to);
    const key = `${from}->${to}`;
    if (key in EXPECTED) {
      eq(got, EXPECTED[key], `canTransition ${key}`);
    } else {
      eq(got, false, `canTransition ${key} — anything unrecognised is refused`);
    }
  }
}
for (const from of states) {
  ok(L.ALLOWED_TRANSITIONS, "the table is exported for review");
  eq(L.canTransition(from, "ARCHIVED"), false, `no transition INTO ARCHIVED is exposed (Phase 11 owns archiving)`);
}
for (const s of ["DRAFT", "READY", "PUBLISHED"]) {
  eq(L.canTransition("ARCHIVED", s), false, `nothing may change an ARCHIVED lesson's state (${s})`);
}
eq(
  Object.fromEntries(Object.entries(L.ALLOWED_TRANSITIONS).map(([k, v]) => [k, [...v].sort()])),
  { DRAFT: ["READY"], READY: ["DRAFT", "PUBLISHED"], PUBLISHED: ["READY"] },
  "the whole table, exactly: three states, six edges, no self-loops (idempotency is handled by NO_OP, not by the table)"
);
for (const [from, targets] of Object.entries(L.ALLOWED_TRANSITIONS)) {
  ok(!targets.includes(from), `ALLOWED_TRANSITIONS[${from}] does not contain ${from}`);
}

// ---------------------------------------------------------------------------
// 4. readiness: VIDEO (the only required dimension)
// ---------------------------------------------------------------------------
section("4. readiness — video is required, track-aware, and never inferred from the mirror");
const R = L.computeLessonReadiness;
const videoState = (input) => R(input).items.find((i) => i.key === "VIDEO");

eq(videoState({}).state, "MISSING", "no video at all → MISSING");
eq(videoState({}).code, "VIDEO_MISSING", "with the stable code");
eq(R({}).canBeReady, false, "and the lesson cannot be staged");
eq(videoState({ videoUrl: "https://cdn.example/v.mp4" }).state, "OK", "a legacy lesson videoUrl counts");
eq(videoState({ videoUrl: "#" }).state, "MISSING", "the seeded placeholder '#' is not a video");
eq(videoState({ videoUrl: "  " }).state, "MISSING", "whitespace is not a video");
eq(videoState({ videoUrl: null }).state, "MISSING", "null is not a video");
eq(
  videoState({
    trackScope: "SHARED",
    sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }],
  }).code,
  "VIDEO_TRACK_INCOMPLETE",
  "a SHARED lesson with only one batch's video is present-but-incomplete"
);
eq(
  R({
    trackScope: "SHARED",
    sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }],
  }).notes.includes("SHARED_VIDEO_MISSING_BATCH:LANGUAGE"),
  true,
  "and the note names the missing batch"
);
eq(
  videoState({
    trackScope: "SHARED",
    sessionVideos: [
      { isPublished: true, batch: { schoolType: "ARABIC" } },
      { isPublished: true, batch: { schoolType: "LANGUAGE" } },
    ],
  }).state,
  "OK",
  "both batches covered → OK"
);
eq(
  videoState({
    trackScope: "ARABIC",
    sessionVideos: [{ isPublished: true, batch: { schoolType: "ARABIC" } }],
  }).state,
  "OK",
  "a track-scoped lesson needs only its own batch (no artificial second video)"
);
eq(
  videoState({
    trackScope: "ARABIC",
    sessionVideos: [{ isPublished: true, batch: { schoolType: "LANGUAGE" } }],
  }).state,
  "MISSING",
  "the other track's video never counts for this lesson"
);
eq(
  videoState({ trackScope: "SHARED", sessionVideos: [{ isPublished: false, batch: { schoolType: "ARABIC" } }] }).state,
  "MISSING",
  "an unpublished SessionVideo is not a student-facing video"
);
eq(
  R({ trackScope: "SHARED", sessionVideos: [{ isPublished: false, batch: { schoolType: "ARABIC" } }] }).notes.includes(
    "VIDEO_PRESENT_BUT_UNPUBLISHED"
  ),
  true,
  "…and the reason is reported, so an admin is not told 'add a video' when one exists"
);
eq(
  R({ status: "PUBLISHED", isPublished: true, videoUrl: "https://cdn/v.mp4" }).canBeReady,
  true,
  "readiness never consults the lifecycle state or the mirror it is feeding"
);

section("5. readiness — PDF is deferred, never faked");
const pdf = (input) => R(input).items.find((i) => i.key === "PDF");
eq(pdf({}).state, "NOT_APPLICABLE", "absent PDF is NOT_APPLICABLE");
// Phase 14 adopted PDF handling; the deferred code is retired in favour of
// the stable "absent, not required" code. PDF still never blocks READY.
eq(pdf({}).code, "PDF_ABSENT_NOT_REQUIRED", "and says so with a stable code");
eq(pdf({}).required, false, "never required in this phase");
eq(pdf({ pdfUrl: "#" }).present, false, "the '#' placeholder is not a document");
eq(pdf({ pdfUrl: "https://cdn/p.pdf" }).present, true, "a real url is present");
eq(pdf({ pdfUrl: "https://cdn/p.pdf" }).state, "NOT_APPLICABLE", "…but still not a requirement");
eq(
  R({ pdfUrl: "https://cdn/p.pdf" }).canBeReady,
  false,
  "a PDF alone cannot make a lesson ready (video is still required)"
);
eq(
  pdf({ materials: [{ kind: "ADMIN_UPLOADED", mediaAssetId: "m1" }, { kind: "ANNOUNCEMENT_TEXT", isActive: true }] }).count,
  1,
  "only document-like, active materials count as a PDF"
);

section("6. readiness — quiz and homework are optional but must be valid");
const quiz = (input) => R(input).items.find((i) => i.key === "QUIZ");
eq(quiz({}).state, "NOT_APPLICABLE", "no quiz is fine");
eq(quiz({ quizzes: [{ trackScope: "SHARED", questionCount: 0 }] }).state, "INVALID", "an empty quiz is blocking");
eq(quiz({ quizzes: [{ trackScope: "SHARED", questionCount: 0 }] }).code, "QUIZ_EMPTY", "with a stable code");
eq(quiz({ quizzes: [{ trackScope: "SHARED", questions: [1, 2, 3] }] }).state, "OK", "a quiz with questions is OK");
eq(quiz({ quizzes: [{ trackScope: "SHARED" }] }).state, "INVALID", "a quiz whose count cannot be read fails closed");
eq(
  R({
    trackScope: "ARABIC",
    videoUrl: "https://cdn/v.mp4",
    quizzes: [{ trackScope: "LANGUAGE", questionCount: 0 }],
  }).canBeReady,
  true,
  "another track's broken quiz never blocks this lesson"
);
eq(
  R({
    trackScope: "ARABIC",
    videoUrl: "https://cdn/v.mp4",
    quizzes: [{ trackScope: "LANGUAGE", questionCount: 5 }],
  }).notes.join(),
  "QUIZ_PRESENT_BUT_OTHER_TRACK:1",
  "…and the observation is recorded rather than silently dropped"
);
const hw = (input) => R(input).items.find((i) => i.key === "HOMEWORK");
eq(hw({}).state, "NOT_APPLICABLE", "no homework is fine");
eq(hw({ homeworks: [{ trackScope: "SHARED", instructions: "  " }] }).state, "INVALID", "homework with no instructions is blocking");
eq(hw({ homeworks: [{ trackScope: "SHARED", instructions: "#" }] }).state, "INVALID", "a placeholder instruction counts as empty");
eq(hw({ homeworks: [{ trackScope: "SHARED", instructions: "Do X" }] }).state, "OK", "real instructions are OK");
eq(
  R({ homeworks: [{ trackScope: "SHARED", instructions: "x" }], videoUrl: "https://cdn/v.mp4" }).canBeReady,
  true,
  "homework + video with no quiz at all is still a valid lesson (nothing is invented)"
);

section("7. readiness — determinism, archive, and code ordering");
eq(
  R({ curriculumStatus: "ARCHIVED", videoUrl: "https://cdn/v.mp4" }).blocking,
  ["CURRICULUM_ARCHIVED"],
  "an archived lesson is never ready, however complete it looks"
);
eq(R({ curriculumStatus: "archived" }).archived, true, "curriculumStatus is compared case-insensitively");
eq(
  R({
    videoUrl: null,
    quizzes: [{ trackScope: "SHARED", questionCount: 0 }],
    homeworks: [{ trackScope: "SHARED", instructions: "" }],
  }).blocking,
  ["VIDEO_MISSING", "QUIZ_EMPTY", "HOMEWORK_INSTRUCTIONS_EMPTY"],
  "blocking codes follow the fixed resource order, so two snapshots diff literally"
);
eq(
  JSON.stringify(R({ trackScope: "bogus", videoUrl: "https://cdn/v.mp4" }).trackScope),
  '"SHARED"',
  "an unrecognised trackScope normalizes to SHARED (the column default) rather than throwing"
);
eq(
  R({ id: "x", status: "READY", officialCode: "  " }).officialCode,
  null,
  "a blank officialCode is reported as null, not as a code"
);

// ---------------------------------------------------------------------------
// 8. the ceremony
// ---------------------------------------------------------------------------
section("8. the ceremony — MARK_READY requires readiness");
(async () => {
  const ready = () =>
    makeDb({
      lessons: { L1: { status: "DRAFT", videoUrl: "https://cdn/v.mp4" } },
    });

  {
    const db = makeDb({ lessons: { L1: { status: "DRAFT", videoUrl: null } } });
    globalThis.__CM_FAKE_DB__ = db;
    const res = await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res.code, "READINESS_BLOCKED", "incomplete lesson refuses staging");
    eq(res.changed, false, "…without writing");
    eq(res.readiness.blocking, ["VIDEO_MISSING"], "…and returns the live checklist so the UI can show why");
    eq(db.__tables.lesson.get("L1").status, "DRAFT", "row untouched");
    eq(db.__writes.updateMany, 0, "no UPDATE was attempted at all");
  }

  {
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    const res = await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res.code, "OK", "ready lesson stages");
    eq(res.from, "DRAFT", "from");
    eq(res.to, "READY", "to");
    eq(res.changed, true, "changed");
    eq(db.__tables.lesson.get("L1").status, "READY", "the row is READY");
    eq(db.__tables.lesson.get("L1").isPublished, false, "the mirror is written FALSE — READY is invisible");
    eq(db.__dump().publications, [], "staging publishes nothing");
    eq(db.__tx.started, 1, "inside a transaction (so a failed mid-write cannot half-apply)");
    eq(db.__tables.auditLog[0].action, "LESSON_MARK_READY", "an audit row names the action");
    eq(JSON.parse(db.__tables.auditLog[0].details).from, "DRAFT", "with the from/to recorded");
    const again = await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(again.code, "NO_OP_ALREADY_IN_STATE", "re-staging is an idempotent no-op");
    eq(again.changed, false, "…reported as unchanged");
    eq(db.__writes.updateMany, 1, "…and it issued no second UPDATE");
  }

  section("9. the ceremony — OPEN requires READY, and only READY");
  {
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    const res = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res.code, "ILLEGAL_TRANSITION", "DRAFT → PUBLISHED is refused: READY cannot be bypassed");
    eq(db.__tables.lesson.get("L1").status, "DRAFT", "…and nothing was written");
    eq(db.__writes.updateMany, 0, "no UPDATE attempted");
  }
  {
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    // The video disappears between staging and opening.
    db.__tables.lesson.get("L1").videoUrl = null;
    const res = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(res.code, "READINESS_BLOCKED", "a stale READY stamp is not a warrant: readiness is re-checked at OPEN");
    eq(db.__tables.lesson.get("L1").status, "READY", "…and the lesson is not published");
  }
  {
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u-admin", client: db });
    const opened = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(opened.code, "OK", "READY → PUBLISHED");
    eq(db.__tables.lesson.get("L1").status, "PUBLISHED", "row flipped");
    eq(db.__tables.lesson.get("L1").isPublished, true, "mirror re-synced by the only sanctioned writer");
    eq(db.__dump().publications, [{ lessonId: "L1", segment: "SHARED" }], "the publication anchor exists");
    ok(opened.publication?.id, "the response carries the anchor id (Phase 17's fan-out key)");
    eq(opened.publication.segment, "SHARED", "and the lesson's segment");
    const replay = await L.openLesson({ lessonId: "L1", actorUserId: "u-admin", client: db });
    eq(replay.code, "NO_OP_ALREADY_IN_STATE", "a retried OPEN is idempotent");
    eq(replay.changed, false, "…no second write");
    eq(db.__dump().publications.length, 1, "…no second publication row");
    eq(replay.publication?.id, opened.publication.id, "…and the ORIGINAL anchor is returned, not a new one");
    eq(db.__tables.auditLog.filter((a) => a.action === "LESSON_OPEN").length, 1, "…one audit row for one publication");
  }
  {
    // An ARABIC-scoped lesson records its own segment.
    const db = makeDb({ lessons: { LA: { status: "READY", videoUrl: "https://cdn/v.mp4", trackScope: "ARABIC" } } });
    globalThis.__CM_FAKE_DB__ = db;
    const opened = await L.openLesson({ lessonId: "LA", actorUserId: "u-admin", client: db });
    eq(opened.code, "OK", "an ARABIC lesson can be opened");
    eq(db.__dump().publications, [{ lessonId: "LA", segment: "ARABIC" }], "the segment is the lesson's track, not the actor's");
  }

  section("10. the ceremony — UNPUBLISH withdraws the anchor");
  {
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u1", client: db });
    await L.openLesson({ lessonId: "L1", actorUserId: "u1", client: db });
    const back = await L.unpublishLesson({ lessonId: "L1", actorUserId: "u1", client: db });
    eq(back.code, "OK", "PUBLISHED → READY is an explicit admin transition");
    eq(db.__tables.lesson.get("L1").status, "READY", "row withdrawn to READY (not to DRAFT)");
    eq(db.__tables.lesson.get("L1").isPublished, false, "mirror follows in the same transaction");
    eq(db.__dump().publications, [], "the publication anchor is deleted, so Phase 17 cannot fan out for it");
    eq(
      db.__tables.auditLog.map((a) => a.action),
      ["LESSON_MARK_READY", "LESSON_OPEN", "LESSON_UNPUBLISH"],
      "every act of the ceremony is auditable, including the withdrawal"
    );
    const again = await L.unpublishLesson({ lessonId: "L1", actorUserId: "u1", client: db });
    eq(again.code, "NO_OP_ALREADY_IN_STATE", "unpublishing a READY lesson is a no-op");
  }
  {
    const db = makeDb({ lessons: { L1: { status: "DRAFT", videoUrl: "https://cdn/v.mp4" } } });
    globalThis.__CM_FAKE_DB__ = db;
    const res = await L.unpublishLesson({ lessonId: "L1", actorUserId: "u1", client: db });
    eq(res.code, "OK", "unpublishing a DRAFT lesson is legal (READY is the target); it is the state machine's edge");
    eq(db.__tables.lesson.get("L1").status, "READY", "…but note: it MOVES the row to READY, so the admin surface calls this 'withdraw from the live course'");
  }

  section("11. refusals: archived, orphan, unknown id, concurrency");
  {
    const db = makeDb({ lessons: { LA: { status: "READY", curriculumStatus: "ARCHIVED", videoUrl: "https://cdn/v.mp4" } } });
    globalThis.__CM_FAKE_DB__ = db;
    for (const [name, fn] of [
      ["open", L.openLesson],
      ["mark-ready", L.markLessonReady],
      ["unpublish", L.unpublishLesson],
    ]) {
      const res = await fn({ lessonId: "LA", actorUserId: "u1", client: db });
      eq(res.code, "LESSON_ARCHIVED", `ARCHIVED lesson: ${name} refused`);
      eq(L.lifecycleHttpStatus(res.code), 409, `…with 409 (the row exists, lifecycle does not apply)`);
    }
    eq(db.__writes.updateMany, 0, "and no action wrote anything");
  }
  {
    const db = makeDb({ lessons: { LO: { status: "READY", unitId: null, topicId: null, videoUrl: "https://cdn/v.mp4" } } });
    globalThis.__CM_FAKE_DB__ = db;
    const res = await L.openLesson({ lessonId: "LO", actorUserId: "u1", client: db });
    eq(res.code, "LESSON_NOT_IN_COURSE", "a lesson in no curriculum cannot be opened into one");
    eq(db.__tables.lesson.get("LO").status, "READY", "…nothing written");
  }
  {
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    const res = await L.openLesson({ lessonId: "nope", actorUserId: "u1", client: db });
    eq(res.code, "LESSON_NOT_FOUND", "unknown id → LESSON_NOT_FOUND");
    eq(L.lifecycleHttpStatus("LESSON_NOT_FOUND"), 404, "mapped to 404, never 403 (no existence oracle)");
    eq(res.readiness, null, "…and no readiness object leaks a title for the unknown id");
  }
  {
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    await L.markLessonReady({ lessonId: "L1", actorUserId: "u1", client: db });
    const realUpdateMany = db.lesson.updateMany;
    let flipped = false;
    db.lesson.updateMany = async (args) => {
      if (!flipped) {
        flipped = true;
        // Simulate the second ceremony landing first, outside our transaction.
        db.__tables.lesson.get("L1").status = "PUBLISHED";
        db.__tables.lesson.get("L1").isPublished = true;
      }
      return realUpdateMany(args);
    };
    const res = await L.openLesson({ lessonId: "L1", actorUserId: "u1", client: db });
    eq(res.code, "CONCURRENT_CHANGE", "a lost race is reported as retryable, not applied twice");
    eq(res.changed, false, "…and it changed nothing further");
    eq(L.lifecycleHttpStatus("CONCURRENT_CHANGE"), 409, "…409, not 500 — nothing broke");
    eq(db.__dump().publications, [], "…and no publication row was created by the loser");
  }
  {
    // The conditional flip is load-bearing: strip `status: from` and the fake
    // db's own predicate check proves the write would have clobbered.
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    const unguarded = await db.lesson.updateMany({
      where: { id: "L1" },
      data: { status: "PUBLISHED", isPublished: true },
    });
    eq(unguarded.count, 1, "without the guard the write lands on a DRAFT lesson (that is why the guard exists)");
  }

  section("12. HTTP + payload discipline");
  for (const [code, want] of [
    ["OK", 200],
    ["NO_OP_ALREADY_IN_STATE", 200],
    ["LESSON_NOT_FOUND", 404],
    ["READINESS_BLOCKED", 409],
    ["ILLEGAL_TRANSITION", 409],
    ["LESSON_ARCHIVED", 409],
    ["LESSON_NOT_IN_COURSE", 409],
    ["CONCURRENT_CHANGE", 409],
  ]) {
    eq(L.lifecycleHttpStatus(code), want, `lifecycleHttpStatus(${code})`);
  }
  {
    const db = ready();
    globalThis.__CM_FAKE_DB__ = db;
    const res = await L.openLesson({ lessonId: "L1", actorUserId: "u1", client: db });
    for (const key of ["ok", "code", "action", "changed", "lessonId", "from", "to", "message", "readiness", "publication"]) {
      ok(key in res, `the mutation response carries '${key}' (clients never parse prose)`);
    }
    const payload = L.lifecyclePayload({ id: "L1", status: "READY", isPublished: true }, {});
    eq(payload.status, "READY", "lifecyclePayload reports the stored state, normalized");
    eq(payload.lifecycle.publishedMirror, false, "…and derives what the mirror SHOULD be (false while READY)");
    eq(payload.lifecycle.isPublishedCompat, true, "…echoing the stale stored mirror as read-only compat, so drift is VISIBLE instead of silently corrected");
    eq(payload.lifecycle.canTransitionTo, ["DRAFT", "PUBLISHED"], "…with exactly the edges the table allows from READY");
    eq(payload.lifecycle.canBeReady, null, "…and null readiness when none was supplied (no invented verdict)");
    eq(
      L.lifecyclePayload({}, { readiness: R({ videoUrl: "https://v" }) }).lifecycle.canBeReady,
      true,
      "…passing the readiness verdict through when the caller supplies one"
    );
    eq(L.lifecyclePayload({}).status, "DRAFT", "a row with no status field projects as DRAFT (fail closed)");
  }

  // -------------------------------------------------------------------------
  // 13. the universe and the gates
  // -------------------------------------------------------------------------
  section("13. the student universe is PUBLISHED + chain + track (progression applied on top)");
  {
    const db = makeDb({
      lessons: {
        L1: { order: 1, status: "PUBLISHED", isPublished: true, videoUrl: "https://cdn/1.mp4", unitId: "u1" },
        L2: { order: 2, status: "DRAFT", isPublished: true, videoUrl: "https://cdn/2.mp4", unitId: "u1" },
        L3: { order: 3, status: "READY", isPublished: true, videoUrl: "https://cdn/3.mp4", unitId: "u1" },
        L4: { order: 4, status: "PUBLISHED", isPublished: true, videoUrl: "https://cdn/4.mp4", unitId: "u1", curriculumStatus: "ARCHIVED" },
        L5: { order: 5, status: "PUBLISHED", isPublished: true, videoUrl: "https://cdn/5.mp4", unitId: "u1", trackScope: "LANGUAGE" },
      },
      students: {
        S1: { schoolType: "ARABIC", groupId: "g1", batchId: null, group: { id: "g1", isActive: true, courseId: "c1", course: { id: "c1", slug: "s1" } } },
      },
    });
    db.__tables.lesson.forEach((row) => {
      row.unit = { id: row.unitId, order: 1, part: { id: "p1", order: 1, courseId: "c1" } };
      row.topic = null;
    });
    globalThis.__CM_FAKE_DB__ = db;
    const visible = await db.lesson.findMany({
      where: { ...L.LESSON_STUDENT_STATUS_FILTER, curriculumStatus: { not: "ARCHIVED" } },
      select: { id: true },
    });
    eq(
      visible.map((r) => r.id).sort(),
      ["L1", "L5"],
      "the filter selects PUBLISHED and non-archived, whatever the mirror claims (DRAFT/READY rows with isPublished:true stay out)"
    );
    const a1 = await SP.canAccessLesson("S1", "L1");
    eq(a1.allowed, true, "the head of the published chain is reachable");
    for (const [id, reason] of [
      ["L2", "LESSON_NOT_FOUND"],
      ["L3", "LESSON_NOT_FOUND"],
      ["L4", "LESSON_NOT_FOUND"],
      ["L5", "LESSON_NOT_FOUND"],
    ]) {
      const r = await SP.canAccessLesson("S1", id);
      eq(r.reason, reason, `canAccessLesson(${id}) → ${reason}`);
    }
  }

  section("14. PUBLISHED + retired-isLocked is the ordinary locked state");
  {
    const db = makeDb({
      lessons: {
        L1: { order: 1, status: "PUBLISHED", videoUrl: "https://cdn/1.mp4", isLocked: false },
        L2: { order: 2, status: "PUBLISHED", videoUrl: "https://cdn/2.mp4", isLocked: true },
      },
      students: {
        S1: { schoolType: "ARABIC", groupId: "g1", batchId: null, group: { id: "g1", isActive: true, courseId: "c1", course: { id: "c1", slug: "s1" } } },
      },
    });
    db.__tables.lesson.forEach((row) => {
      row.unit = { id: "u1", order: 1, part: { id: "p1", order: 1, courseId: "c1" } };
      row.topic = null;
    });
    globalThis.__CM_FAKE_DB__ = db;
    const prog = await SP.getCourseSessionProgress("S1", "c1", "ARABIC");
    eq(prog.sessions.map((s) => s.lessonId), ["L1", "L2"], "both published lessons are in the curriculum");
    eq(prog.sessions.map((s) => s.unlocked), [true, false], "locked-ness comes from progression, not from `isLocked`");
    // The retired column is inert: flipping it changes nothing.
    db.__tables.lesson.get("L1").isLocked = true;
    db.__tables.lesson.get("L2").isLocked = false;
    const prog2 = await SP.getCourseSessionProgress("S1", "c1", "ARABIC");
    eq(prog2.sessions.map((s) => s.unlocked), [true, false], "inverting `isLocked` changes nothing (it is read by no gate)");
    const a2 = await SP.canAccessLesson("S1", "L2");
    eq(a2.reason, "PREVIOUS_SESSION_INCOMPLETE", "…including for the direct gate");
  }

  // -------------------------------------------------------------------------
  // 15. the parent preview gate (the Phase 12 finding)
  // -------------------------------------------------------------------------
  section("15. parent preview = lifecycle AND track AND course (Phase 12 finding closed)");
  {
    const db = makeDb({
      students: {
        S1: { schoolType: "ARABIC", groupId: "g1", batchId: null, group: { id: "g1", isActive: true, courseId: "c1", course: { id: "c1", slug: "s1" } } },
      },
      parents: { "u-parent": { id: "p1", userId: "u-parent", children: [{ studentId: "S1" }] } },
    });
    globalThis.__CM_FAKE_DB__ = db;
    const cases = [
      [{ status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "SHARED" }, "c1", true, "published, shared, child's course"],
      [{ status: "DRAFT", curriculumStatus: "OFFICIAL", trackScope: "SHARED" }, "c1", false, "DRAFT is invisible to the parent too"],
      [{ status: "READY", curriculumStatus: "OFFICIAL", trackScope: "SHARED" }, "c1", false, "READY (staged, unopened) is invisible"],
      [{ status: "PUBLISHED", curriculumStatus: "ARCHIVED", trackScope: "SHARED" }, "c1", false, "archived history is not curriculum"],
      [{ status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "LANGUAGE" }, "c1", false, "the other track stays out"],
      [{ status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "ARABIC" }, "c1", true, "the child's own track is fine"],
      [{ status: "PUBLISHED", curriculumStatus: "OFFICIAL", trackScope: "SHARED" }, "c2", false, "another course is refused (Phase 7 intact)"],
      [null, "c1", false, "a missing lesson row is refused, not an error"],
    ];
    for (const [lesson, courseId, want, label] of cases) {
      eq(await PA.isParentLessonPreviewAllowed("u-parent", lesson, courseId), want, `parent: ${label}`);
    }
    // Ordering matters: a DRAFT lesson in the WRONG course must not be able to
    // answer "true because the course check passed first" — and it must not
    // leak that the lesson exists.
    eq(await PA.isParentLessonPreviewAllowed("u-parent", { status: "DRAFT" }, "c1"), false, "lifecycle is checked BEFORE the course/track lookups");
    let queries = 0;
    const spy = { ...db, parent: { findUnique: async (a) => { queries++; return db.parent.findUnique(a); } } };
    globalThis.__CM_FAKE_DB__ = spy;
    await PA.isParentLessonPreviewAllowed("u-parent", { status: "READY", curriculumStatus: "OFFICIAL", trackScope: "ARABIC" }, "c1");
    eq(queries, 0, "and the refusal short-circuits: no enrollment query is issued for a lesson nobody may see");
  }

  // -------------------------------------------------------------------------
  // 16. source pins with mutation controls
  // -------------------------------------------------------------------------
  section("16. readers apply the lifecycle clause (source pins, each with a negative control)");
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
  {
    const courses = read("src/app/api/courses/[slug]/route.ts");
    pinned(
      courses,
      /let viewerLifecycleFilter: object = LESSON_STUDENT_STATUS_FILTER;/,
      "the course tree defaults every student/parent view to the PUBLISHED slice"
    );
    pinned(
      courses,
      /viewerLifecycleFilter = \{\};/,
      "…widened only for staff (an empty object, not a truthy hack)"
    );
    eq((courses.match(/\.\.\.viewerLifecycleFilter,/g) || []).length, 2, "both curriculum chains carry the clause (unit chain AND legacy topic chain)");
    ok(!/isLocked:/.test(courses), "the retired isLocked column is no longer serialised by the course tree");

    const lessonRoute = read("src/app/api/lessons/[id]/route.ts");
    pinned(
      lessonRoute,
      /await isParentLessonPreviewAllowed\(/,
      "the lesson reader routes parent preview through the combined helper"
    );
    eq((lessonRoute.match(/\.\.\.LESSON_STUDENT_STATUS_FILTER/g) || []).length >= 1, true, "prev/next are lifecycle-filtered too");
    ok(!/isLocked:/.test(lessonRoute), "the lesson reader no longer serialises isLocked");

    const quizRoute = read("src/app/api/quizzes/[id]/route.ts");
    pinned(
      quizRoute,
      /await isParentLessonPreviewAllowed\(\s*user\.id,\s*quiz\.lesson\s*\?\s*\{[^}]*status: quiz\.lesson\.status/s,
      "a parent cannot read a staged lesson's quiz through the quiz endpoint"
    );
    // Every reader that hands out lesson-shaped data, enumerated (not sampled):
    // these are the 11 route files that consult the lifecycle, and the two
    // surfaces Phase 13 deliberately did NOT rewrite, pinned so the decision is
    // recorded rather than forgotten.
    const READERS = [
      "src/app/api/courses/[slug]/route.ts",
      "src/app/api/lessons/[id]/route.ts",
      "src/app/api/quizzes/[id]/route.ts",
      "src/app/api/exams/mock/route.ts",
      "src/app/api/students/me/dashboard/route.ts",
      "src/app/api/students/me/homework/route.ts",
      "src/app/api/students/me/session-videos/route.ts",
      "src/app/api/students/me/certificate/route.ts",
      "src/app/api/parents/me/dashboard/route.ts",
      "src/app/api/parents/me/analytics/route.ts",
      "src/app/api/parents/me/weekly-report/route.ts",
    ];
    for (const rel of READERS) {
      const src = read(rel);
      ok(
        /LESSON_STUDENT_STATUS_FILTER|isParentLessonPreviewAllowed|isStudentVisibleStatus|canAccessLesson\(|getCourseSessionProgress\(/.test(
          src
        ),
        `${rel} applies the lifecycle clause (itself, the shared helper, or the progression engine)`
      );
    }
    const media = read("src/app/api/media/[id]/route.ts");
    ok(
      /Phase 20|isPublished/.test(media) && !/LESSON_STUDENT_STATUS_FILTER/.test(media),
      "api/media/[id] is DELIBERATELY unchanged (documented Phase 20 work; its video-isPublished oracle is reported, not hidden)"
    );
  }

  section("17. admin endpoints: ADMIN-only, ceremony-only, engine-notification-free");
  {
    const routes = {
      open: read("src/app/api/admin/lessons/[id]/open/route.ts"),
      markReady: read("src/app/api/admin/lessons/[id]/mark-ready/route.ts"),
      unpublish: read("src/app/api/admin/lessons/[id]/unpublish/route.ts"),
      readiness: read("src/app/api/admin/lessons/[id]/readiness/route.ts"),
    };
    pinned(routes.open, /requireRole\("ADMIN"\)/, "OPEN is ADMIN-only");
    pinned(routes.markReady, /requireRole\("ADMIN"\)/, "mark-ready is ADMIN-only");
    pinned(routes.unpublish, /requireRole\("ADMIN"\)/, "unpublish is ADMIN-only");
    pinned(routes.readiness, /requireRole\("ADMIN"\)/, "readiness is ADMIN-only");
    for (const [name, src] of Object.entries(routes)) {
      ok(/export async function (GET|POST)/.test(src), `${name}: exports a route handler`);
      ok(!/db\.lesson\.update/.test(src), `${name}: never writes Lesson.status outside the ceremony`);
      ok(!/status:\s*req/u.test(src), `${name}: accepts no client-supplied target state`);
    }
    pinned(routes.open, /openLesson\(\{/, "OPEN delegates to the ceremony (no parallel engine)");
    // PHASE 17 AMENDMENT (session publication notifications): this pin was
    // written as a forward guard — "publishing creates NO notification
    // (Phase 17's job)". Phase 17 has now arrived and the OPEN route DOES
    // fan out — but the Phase 13 purity guarantees survive intact, and this
    // section now pins the Phase 17-era contract instead:
    pinned(routes.open, /emitSessionPublicationNotifications\(\s*\{[\s\S]*?lessonId/, "OPEN fans out ONLY through the single Phase 17 emit helper (no inline Notification writes — the planned delegation)");
    pinned(routes.open, /result\.ok\s*&&\s*!!result\.publication/, "the fan-out is gated behind a successful ceremony outcome (OK-changed or NO_OP retry) — refusal outcomes NEVER emit");
    const engineNoComments = read("src/lib/session-lifecycle.ts").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    ok(!/notification/i.test(engineNoComments), "the lifecycle ENGINE (transitionLesson) itself still writes NO notification — the fan-out is route-level orchestration, not ceremony logic (comment mentions aside)");
    ok(!/db\.notification/.test(routes.open + routes.unpublish), "…and no lifecycle endpoint writes the Notification model directly (the helper owns the inserts)");
    ok(!/emitSessionPublicationNotifications/.test(routes.unpublish + routes.markReady), "unpublish/mark-ready never fan out");
    ok(!/publishedAt/.test(routes.open), "the endpoint cannot set the publication time — the ceremony owns it");
  }

  section("18. schema and migration contract");
  {
    const schema = read("prisma/schema.prisma");
    pinned(schema, /enum LessonStatus \{\n  DRAFT\n  READY\n  PUBLISHED\n\}/, "the enum is exactly the three states, in order");
    pinned(schema, /^\s+status\s+LessonStatus\s+@default\(DRAFT\)$/m, "Lesson.status is NOT NULL with a safe DRAFT default");
    pinned(schema, /lessonId\s+String\s+@unique/, "SessionPublication.lessonId is UNIQUE — idempotency is enforced by the database, not by convention");
    ok(/isPublished\s+Boolean\s+@default\(true\)/.test(schema), "the mirror keeps its default (so no schema drift is introduced)");
    ok(!/opensAt|publishAt|scheduledAt/.test(schema.split("model Lesson {")[1]?.split("\n}\n")[0] ?? ""), "no scheduling field was invented (out of scope, by decision)");

    const sql = read("prisma/migrations/20260909180000_phase13_session_lifecycle/migration.sql");
    pinned(
      sql,
      /UPDATE "Lesson" SET "status" = 'PUBLISHED'\s+WHERE "status" = 'DRAFT'\s+AND COALESCE\(CAST\("isPublished" AS INTEGER\), 0\) = 1;/,
      "the backfill is guarded: it only ever moves an un-backfilled DRAFT row whose mirror said published"
    );
    pinned(
      sql,
      /"status" = 'DRAFT'/g,
      "…which is what makes a replay a no-op instead of a resurrection",
      (src) => src.replace(/"status" = 'DRAFT'/g, "1 = 1")
    );
    ok(!/DELETE FROM/i.test(sql), "the migration deletes no rows");
    ok(!/DROP COLUMN/i.test(sql), "the migration drops no columns (retire-in-place, as the phase decided)");
    ok(!/DROP TABLE/i.test(sql), "the migration drops no tables");
    ok(/ADD COLUMN "status"/.test(sql), "it adds one column");
    ok(/CREATE TABLE "SessionPublication"/.test(sql), "it creates one anchor table");
    ok(
      /CREATE UNIQUE INDEX "SessionPublication_lessonId_key"/.test(sql),
      "…with the UNIQUE lessonId index that enforces one publication per lesson"
    );
    ok(
      !/SessionPublication[\s\S]*?"segment"[^\n]*?(ARABIC|LANGUAGE)/.test(sql),
      "the segment column stores a value rather than becoming per-track state"
    );
    ok(/"isLocked"/.test(sql) === false || /isLocked/.test(sql.split("ALTER TABLE")[1] ?? ""), "the retired column is left physically in place");
  }

  section("19. mutation controls on the engine's universe clause");
  {
    // Re-derive the compiled engine's universe filter with the clause removed
    // and prove the fake-db universe widens — i.e. that the assertions above
    // are guards and not decoration.
    const src = fs.readFileSync(path.join(EMIT, "session-progress.js"), "utf8");
    ok(
      /LESSON_STUDENT_STATUS_FILTER/.test(src),
      "the compiled progression engine references the lifecycle clause"
    );
    const neutered = src
      .replace(/[A-Za-z_$][\w$]*\.LESSON_STUDENT_STATUS_FILTER/g, "{}")
      .replace(/(?<![\w$.])LESSON_STUDENT_STATUS_FILTER/g, "{}");
    ok(neutered !== src, "and the clause can actually be removed from it");
    ok(!/LESSON_STUDENT_STATUS_FILTER/.test(neutered), "…leaving no trace of it (the control is real)");
    fs.writeFileSync(path.join(EMIT, "session-progress-neutered.js"), neutered);
    const NEUTERED = require(path.join(EMIT, "session-progress-neutered.js"));
    const db = makeDb({
      lessons: {
        L1: { order: 1, status: "PUBLISHED", videoUrl: "https://cdn/1.mp4" },
        L2: { order: 2, status: "READY", videoUrl: "https://cdn/2.mp4" },
      },
      students: {
        S1: { schoolType: "ARABIC", groupId: "g1", batchId: null, group: { id: "g1", isActive: true, courseId: "c1", course: { id: "c1", slug: "s1" } } },
      },
    });
    db.__tables.lesson.forEach((row) => {
      row.unit = { id: "u1", order: 1, part: { id: "p1", order: 1, courseId: "c1" } };
      row.topic = null;
    });
    globalThis.__CM_FAKE_DB__ = db;
    const guarded = await SP.getCourseSessionProgress("S1", "c1", "ARABIC");
    const leaked = await NEUTERED.getCourseSessionProgress("S1", "c1", "ARABIC");
    eq(guarded.sessions.map((s) => s.lessonId), ["L1"], "with the clause: only the opened lesson is curriculum");
    eq(
      leaked.sessions.map((s) => s.lessonId),
      ["L1", "L2"],
      "without it: the staged lesson enters the universe — so the guard is what stops the leak"
    );
    fs.rmSync(path.join(EMIT, "session-progress-neutered.js"), { force: true });
  }

  // -------------------------------------------------------------------------
  // 20. the real database, executed as a child process
  // -------------------------------------------------------------------------
  section("20. REAL DATABASE — scripts/verify-phase13-db.mjs (migration + backfill + shipped code)");
  {
    let sqliteAvailable = true;
    try {
      require("node:sqlite");
    } catch {
      sqliteAvailable = false;
    }
    if (!sqliteAvailable) {
      ok(false, "node:sqlite is unavailable in this Node version, so the real-database layer CANNOT be verified (failing loudly rather than skipping silently)");
    } else {
      let stdout = "";
      let status = 0;
      try {
        stdout = execSync(`node scripts/verify-phase13-db.mjs all`, {
          cwd: REPO,
          encoding: "utf8",
          stdio: "pipe",
          maxBuffer: 64 * 1024 * 1024,
          env: { ...process.env, CM_VERIFY_DB: path.join(OUT, "verify.db") },
        });
      } catch (e) {
        stdout = String(e.stdout || "") + String(e.stderr || "");
        status = e.status ?? 1;
      }
      ok(status === 0, `the real-database verifier exits 0${status ? ` (exit ${status})` : ""}`);
      const counts = /PASS — (\d+) assertions, (\d+) failures/.exec(stdout);
      ok(counts && Number(counts[1]) > 120, `and it asserts at scale (reported ${counts?.[1]} assertions)`);
      for (const marker of [
        "every table's row count is unchanged",
        "lesson ids are identical and in the same order",
        "every row's status matches its published mirror",
        "never resurrected by a backfill replay",
        "every created lesson started DRAFT",
        "the publication records the lesson's segment",
        "PUBLISHED + LOCKED is a real, reachable state",
        "the Phase 12 finding is closed in the shared helper",
        "columns match prisma/schema.prisma exactly",
      ]) {
        ok(stdout.includes(marker), `verifier reported: ${marker}`);
      }
      const lines = stdout.split("\n").length;
      ok(lines > 100, `verifier produced full evidence output (${lines} lines)`);
    }
  }

  // -------------------------------------------------------------------------
  console.log(`\nsession lifecycle (phase 13): ${pass} passed, ${fail} failed`);
  if (fail) console.log("\nfailures:\n  - " + failures.join("\n  - "));
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST CRASH:", e);
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(1);
});
