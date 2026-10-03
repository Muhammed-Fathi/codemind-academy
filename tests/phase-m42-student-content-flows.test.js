// CodeMind Academy — Phase M4.2: Student learning & content flows.
//
// WHAT THIS SUITE PROVES (one section per M4.2 goal)
// =================================================
//   A. Lesson navigation — the ONE rule: the `lesson:<id>` notification and
//      the Homework list's "open lesson" CTA (and every other student entry
//      point) move the FETCH KEY first, so the exact canonical lesson opens
//      and a stale previous selection can never win. Parsing + role gating are
//      reused unchanged; a malformed / foreign-role link opens nothing.
//   B. Course / lesson Academic Level context — `/api/courses/[slug]` and
//      `/api/lessons/[id]` expose the canonical `Course.academicLevel`, and a
//      client-supplied level never becomes it.
//   C. Bookmarks — canonical `Lesson → Unit → Part` context first, the legacy
//      `Topic → Unit → Part` chain as the fallback; the printed code is
//      context, the lesson id is identity.
//   D. Study plan — `StudyTask.lessonId` is validated server-side against the
//      student's visible CURRENT-course curriculum: foreign course, foreign
//      level (corrupted cache), archived, draft, foreign track and unknown ids
//      all fail closed and NOTHING is written; a visible id is accepted; PATCH
//      is validated the same way and `null` clears the link.
//   E. Export progress — still LIFETIME (not silently narrowed) and every row
//      is attributable to its own course + Academic Level.
//   F. Session videos — read-only level/course context; authorization,
//      applicability, `requirementMode`, watch progress and lifecycle
//      semantics unchanged (draft-linked and narrowed-out rows still vanish).
//   G. Mock exams — strict `MockExam.courseId` scope unchanged, plus the
//      display context (level, lesson code in the served/review payload).
//   H. Certificate — the passive M4.1 level context is RENDERED; the
//      certificate authority (threshold, metrics scope, reference id) is not
//      touched.
//
// The REAL route handlers run against the repository's migration-backed SQLite
// database with only the framework boundary shimmed (Prisma engine →
// sqlite-prisma-lite, auth → a script-controlled user, next/server shims).
//
// The fixture is adversarial: three courses, two Academic Levels, ONE display
// name shared by two of them, and printed codes ("1-1") reused across levels —
// so any leak would surface as "the other level's content, by code".
//
// Run: node tests/phase-m42-student-content-flows.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO = path.resolve(__dirname, "..");
process.env.SECURITY_HASH_SECRET = "m42".padEnd(64, "0");

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`M4.2 test made a network connection attempt: ${JSON.stringify(args[0])}`);
  };
  process.on("exit", () => {
    net.Socket.prototype.connect = realConnect;
  });
}

const { DatabaseSync } = require("node:sqlite");
const mig = require(path.join(REPO, "scripts", "lib", "migrate-sqlite.mjs"));
const { createSqlitePrisma } = require(path.join(REPO, "scripts", "lib", "sqlite-prisma-lite.mjs"));

let pass = 0;
let fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log(`  ok   ${label}`);
  } else {
    fail++;
    failures.push(label);
    console.log(`  FAIL ${label}`);
  }
}
function eq(got, want, label) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  ok(a === b, `${label}${a === b ? "" : ` (got ${a}, want ${b})`}`);
}
function section(title) {
  console.log(`\n${title}`);
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ---------------------------------------------------------------------------
// 1. Scratch database: base DDL + every real migration.
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "M4.2: " });
const client = createSqlitePrisma({
  db: rawDb,
  schemaPath: path.join(REPO, "prisma", "schema.prisma"),
});
globalThis.__CM_DB_CLIENT__ = client;

// ---------------------------------------------------------------------------
// 2. Compile the shipped TypeScript with the repo's own tsc; load with shims.
// ---------------------------------------------------------------------------
const REAL_CODE_MODULES = [
  "src/lib/school-type.ts",
  "src/lib/track-scope.ts",
  "src/lib/academic-level.ts",
  "src/lib/academic-level-labels.ts",
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n-server.ts",
  "src/lib/env.ts",
  "src/lib/security.ts",
  "src/lib/media.ts",
  "src/lib/storage-quotas.ts",
  "src/lib/subscription-entitlement.ts",
  "src/lib/enrollment.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/progression.ts",
  "src/lib/session-progress.ts",
  "src/lib/student-visibility.ts",
  "src/lib/student-universe.ts",
  "src/lib/curriculum-visibility.ts",
  "src/lib/parent-access.ts",
  "src/lib/session-materials.ts",
  "src/lib/session-quiz.ts",
  "src/lib/quiz-blueprint.ts",
  "src/lib/lesson-content.ts",
  "src/lib/unit-counts.ts",
  "src/lib/video-applicability.ts",
  "src/lib/mock-exam-pool.ts",
  "src/lib/rate-limit.ts",
  "src/lib/api.ts",
  "src/lib/brand.ts",
  "src/lib/student-navigation.ts",
  "src/lib/deep-link.ts",
  "src/lib/view-roles.ts",
  // route handlers under test
  "src/app/api/courses/[slug]/route.ts",
  "src/app/api/lessons/[id]/route.ts",
  "src/app/api/students/me/bookmarks/route.ts",
  "src/app/api/students/me/study-plan/route.ts",
  "src/app/api/students/me/export-progress/route.ts",
  "src/app/api/students/me/session-videos/route.ts",
  "src/app/api/students/me/mock-exams/route.ts",
  "src/app/api/exams/mock/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m42-flows-"));
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
        noEmitOnError: false,
      },
      files: REAL_CODE_MODULES.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
try {
  execFileSync(
    process.execPath,
    [
      path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"),
      "-p",
      path.join(OUT, "tsconfig.json"),
    ],
    { cwd: REPO, stdio: "pipe" }
  );
} catch (e) {
  /* type noise tolerated — the emitted files are what matter */
}
for (const f of REAL_CODE_MODULES) {
  const emitted = path.join(OUT, f.replace(/\.ts$/, ".js"));
  if (!fs.existsSync(emitted)) {
    console.error(`tsc did not emit ${f}`);
    process.exit(1);
  }
}
const EMIT = path.join(OUT, "src");

// ---------------------------------------------------------------------------
// 3. Shims: db → the real sqlite client, auth → the script-controlled user.
// ---------------------------------------------------------------------------
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
    return JSON.parse(String(this._body));
  }
  async text() {
    return String(this._body ?? "");
  }
}
class NextRequest {
  constructor(url) {
    this.url = url;
  }
}
module.exports = { NextResponse, NextRequest };
`;
const SHIM_FILES = {
  "__db-shim.js": `module.exports = { get db() { return globalThis.__CM_DB_CLIENT__; } };`,
  "__auth-shim.js": `module.exports = { getCurrentUser: async () => globalThis.__CM_USER__ ?? null };`,
  "__next-server-shim.js": NEXT_SERVER_SHIM,
  "__next-headers-shim.js": `module.exports = { cookies: async () => ({ get: () => undefined }) };`,
};
for (const [name, code] of Object.entries(SHIM_FILES)) {
  fs.writeFileSync(path.join(OUT, name), code);
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "__db-shim.js");
  if (request === "@/lib/auth") return path.join(OUT, "__auth-shim.js");
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  try {
    return originalResolve.call(this, request, ...rest);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};

const route = (p) => require(path.join(OUT, "src/app/api", p));
const R = {
  course: route("courses/[slug]/route.js"),
  lesson: route("lessons/[id]/route.js"),
  bookmarks: route("students/me/bookmarks/route.js"),
  studyPlan: route("students/me/study-plan/route.js"),
  exportProgress: route("students/me/export-progress/route.js"),
  videos: route("students/me/session-videos/route.js"),
  mockExams: route("students/me/mock-exams/route.js"),
  exam: route("exams/mock/route.js"),
};
const NAV = require(path.join(EMIT, "lib/student-navigation.js"));
const DEEP = require(path.join(EMIT, "lib/deep-link.js"));

function asUser(u) {
  globalThis.__CM_USER__ = u
    ? { id: u.id, email: u.email, name: u.name, role: u.role }
    : null;
}
const jsonReq = (body, url) => ({
  url: url || "http://localhost/api",
  method: "POST",
  headers: { get: () => null },
  json: async () => body,
});
async function GET(handler, url, params) {
  const req = { url: url || "http://localhost/api", method: "GET", headers: { get: () => null } };
  // Dynamic routes receive `{ params: Promise<...> }` (the Next 15 contract).
  const ctx = { params: Promise.resolve(params || {}) };
  const res = await (typeof handler === "function" ? handler : handler.GET)(req, ctx);
  return { status: res.status, json: await res.json() };
}
async function CALL(handler, req, params) {
  const ctx = { params: Promise.resolve(params || {}) };
  const res = await (typeof handler === "function" ? handler : handler[req.method])(req, ctx);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body (the CSV export) — the caller reads `text` */
  }
  return { status: res.status, json, text };
}

const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000);

// node:sqlite binds neither booleans nor Dates.
function bindable(value) {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  return value;
}
function ins(table, values) {
  const columns = Object.keys(values);
  for (const c of columns) values[c] = bindable(values[c]);
  rawDb
    .prepare(
      `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns
        .map(() => "?")
        .join(",")})`
    )
    .run(...columns.map((c) => values[c]));
}
function count(table, where = "", args = []) {
  return rawDb.prepare(`SELECT COUNT(*) AS c FROM "${table}" ${where}`).get(...args).c;
}

// ---------------------------------------------------------------------------
// 4. Fixture — three courses, two levels, one shared display name, reused codes.
// ---------------------------------------------------------------------------
section("M4.2 fixture — two levels, one course name, one printed code");

const COURSES = [
  { id: "c-first", slug: "m42-first", level: "FIRST_SECONDARY", name: "البرمجة والذكاء الاصطناعي" },
  { id: "c-second", slug: "m42-second", level: "SECOND_SECONDARY", name: "البرمجة والذكاء الاصطناعي" },
  { id: "c-other", slug: "m42-other", level: "FIRST_SECONDARY", name: "كورس تاني" },
];
for (const c of COURSES) {
  ins("Course", {
    id: c.id,
    slug: c.slug,
    academicLevel: c.level,
    name: c.name,
    nameAr: c.name,
    description: "M4.2 fixture course",
    color: "#10b981",
    createdAt: NOW,
    updatedAt: NOW,
  });
  ins("Part", { id: `p-${c.id}`, courseId: c.id, title: "Part 1", titleAr: "Part 1", order: 1 });
  ins("Unit", { id: `u-${c.id}`, partId: `p-${c.id}`, title: "Unit 1", titleAr: "Unit 1", order: 1 });
  ins("Batch", {
    id: `b-${c.id}`,
    name: `Batch ${c.id}`,
    nameAr: `Batch ${c.id}`,
    schoolType: "ARABIC",
    courseId: c.id,
    isActive: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
// Legacy topic chain under the current course's unit.
ins("Topic", { id: "tpc-first", unitId: "u-c-first", title: "Topic 1", titleAr: "Topic 1", order: 1 });

function lesson({
  id,
  courseId,
  level,
  officialCode,
  trackScope = "SHARED",
  status = "PUBLISHED",
  curriculumStatus = "OFFICIAL",
  topicId = null,
}) {
  ins("Lesson", {
    id,
    unitId: topicId ? null : `u-${courseId}`,
    topicId,
    officialCode,
    academicLevel: level,
    curriculumStatus,
    trackScope,
    status,
    // Identical titles on purpose: only the id and the level distinguish rows.
    title: "Session 1-1",
    titleAr: "Session 1-1",
    order: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
lesson({ id: "l-f1", courseId: "c-first", level: "FIRST_SECONDARY", officialCode: "1-1" });
lesson({ id: "l-f2", courseId: "c-first", level: "FIRST_SECONDARY", officialCode: "1-2" });
lesson({ id: "l-legacy", courseId: "c-first", level: "FIRST_SECONDARY", officialCode: "1-3", curriculumStatus: "LEGACY", topicId: "tpc-first" });
lesson({ id: "l-arch", courseId: "c-first", level: "FIRST_SECONDARY", officialCode: "1-4", curriculumStatus: "ARCHIVED" });
lesson({ id: "l-draft", courseId: "c-first", level: "FIRST_SECONDARY", officialCode: "1-5", status: "DRAFT" });
lesson({ id: "l-lang", courseId: "c-first", level: "FIRST_SECONDARY", officialCode: "1-6", trackScope: "LANGUAGE" });
lesson({ id: "l-other", courseId: "c-other", level: "FIRST_SECONDARY", officialCode: "2-1" });
// Same printed code as `l-f1`, at the OTHER level (the natural K3 case).
lesson({ id: "l-second", courseId: "c-second", level: "SECOND_SECONDARY", officialCode: "1-1" });
// ADVERSARIAL: a row in the student's OWN course whose denormalized cache says
// the other level — the attach gate must fail closed on it (M4.2). Its code is
// different from `l-second`'s because the database still enforces
// `@@unique([academicLevel, officialCode])` — the mismatch itself is the point.
lesson({ id: "l-mismatch", courseId: "c-first", level: "SECOND_SECONDARY", officialCode: "1-9" });

for (const g of [
  { id: "g-first", courseId: "c-first" },
  { id: "g-second", courseId: "c-second" },
  { id: "g-other", courseId: "c-other" },
]) {
  ins("Group", {
    id: g.id,
    name: `Group ${g.id}`,
    courseId: g.courseId,
    capacity: 20,
    schedule: "Sat",
    isActive: 1,
    trackScope: "ARABIC",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

const USERS = [
  { id: "u-main", name: "Main Student", email: "main@m42.test", role: "STUDENT" },
  { id: "u-second", name: "Second Level", email: "second@m42.test", role: "STUDENT" },
  { id: "u-other", name: "Other Course", email: "other@m42.test", role: "STUDENT" },
  { id: "u-teacher", name: "A Teacher", email: "teacher@m42.test", role: "TEACHER" },
];
for (const u of USERS) {
  ins("User", {
    id: u.id,
    email: u.email,
    password: "test-hash",
    name: u.name,
    role: u.role,
    isActive: 1,
    status: "ACTIVE",
    createdAt: NOW,
    updatedAt: NOW,
  });
}
ins("Teacher", { id: "t-1", userId: "u-teacher", specialty: "CS", createdAt: NOW, updatedAt: NOW });

for (const s of [
  { id: "s-main", userId: "u-main", groupId: "g-first", level: "FIRST_SECONDARY", batchId: "b-c-first" },
  { id: "s-second", userId: "u-second", groupId: "g-second", level: "SECOND_SECONDARY", batchId: "b-c-second" },
  { id: "s-other", userId: "u-other", groupId: "g-other", level: "FIRST_SECONDARY", batchId: "b-c-other" },
]) {
  ins("Student", {
    id: s.id,
    userId: s.userId,
    groupId: s.groupId,
    batchId: s.batchId,
    academicLevel: s.level,
    schoolType: "ARABIC",
    grade: s.level === "FIRST_SECONDARY" ? "1st Secondary" : "2nd Secondary",
    enrolledAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

// Media + session videos (the student's own batch only).
ins("MediaAsset", {
  id: "m-1",
  kind: "VIDEO",
  storage: "EXTERNAL_URL",
  externalUrl: "https://example.test/video.mp4",
  isPrivate: 0,
  durationSec: 600,
  createdAt: NOW,
});
function video({ id, lessonId, batchId = "b-c-first", isPublished = true }) {
  ins("SessionVideo", {
    id,
    batchId,
    lessonId,
    mediaAssetId: "m-1",
    title: "Recording",
    titleAr: "Recording",
    requiredPercent: 95,
    isRequiredForProgression: 0,
    requirementMode: "OPTIONAL",
    isPublished: isPublished ? 1 : 0,
    publishedAt: isPublished ? at(30) : null,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
video({ id: "sv-f1", lessonId: "l-f1" });
// The OTHER level's student has a recording of THEIR "1-1" — the same printed
// code and the same title, in a different batch: level + id must tell them
// apart (cross-student assertion in section F).
video({ id: "sv-second", lessonId: "l-second", batchId: "b-c-second" });
video({ id: "sv-draft", lessonId: "l-draft" }); // linked to a non-PUBLISHED session → must vanish
video({ id: "sv-lessonless", lessonId: null }); // legacy batch recording → stays, no lesson context
video({ id: "sv-unpublished", lessonId: "l-f2", isPublished: false });

// Bookmarks: canonical chain + legacy chain.
ins("LessonBookmark", { id: "bm-canon", studentId: "s-main", lessonId: "l-f1", createdAt: at(10) });
ins("LessonBookmark", { id: "bm-legacy", studentId: "s-main", lessonId: "l-legacy", createdAt: at(20) });
ins("LessonBookmark", { id: "bm-second", studentId: "s-second", lessonId: "l-second", createdAt: at(5) });

// Study progress (lifetime export rows): the student has history in the OTHER
// level as well, so the export must attribute each row to its own course/level.
ins("LessonProgress", {
  id: "lp-f1",
  studentId: "s-main",
  lessonId: "l-f1",
  progress: 100,
  isCompleted: 1,
  lastViewedAt: at(10),
});
ins("LessonProgress", {
  id: "lp-second",
  studentId: "s-main",
  lessonId: "l-second",
  progress: 100,
  isCompleted: 1,
  lastViewedAt: at(3),
});

// Attendance through the session's OWN group (not the student's current one).
ins("LiveSession", {
  id: "ses-first",
  groupId: "g-first",
  lessonId: "l-f1",
  title: "Session",
  titleAr: "Session",
  startAt: at(600),
  duration: 120,
  status: "COMPLETED",
  createdAt: NOW,
});
ins("LiveSession", {
  id: "ses-second",
  groupId: "g-second",
  lessonId: "l-second",
  title: "Session",
  titleAr: "Session",
  startAt: at(5),
  duration: 120,
  status: "COMPLETED",
  createdAt: NOW,
});
ins("Attendance", { id: "att-first", studentId: "s-main", sessionId: "ses-first", status: "PRESENT", createdAt: NOW });
ins("Attendance", { id: "att-second", studentId: "s-main", sessionId: "ses-second", status: "ABSENT", createdAt: NOW });

// Mock exams: one per course + one unpublished.
function mockExam({ id, courseId, isPublished = true }) {
  ins("MockExam", {
    id,
    title: `Exam ${id}`,
    titleAr: `Exam ${id}`,
    schoolType: "ARABIC",
    courseId,
    questionCount: 3,
    durationMin: 30,
    passMark: 60,
    difficulty: "MIXED",
    selectionMode: "RANDOM",
    isPublished: isPublished ? 1 : 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
mockExam({ id: "mx-first", courseId: "c-first" });
mockExam({ id: "mx-other", courseId: "c-other" });
mockExam({ id: "mx-draft", courseId: "c-first", isPublished: false });

// Question pool: a lesson-linked quiz question + a lesson-linked exam question.
ins("Quiz", {
  id: "qz-f1",
  lessonId: "l-f1",
  trackScope: "SHARED",
  title: "Quiz",
  titleAr: "Quiz",
  passMark: 60,
  order: 1,
  status: "PUBLISHED",
});
ins("Question", {
  id: "qn-f1",
  quizId: "qz-f1",
  type: "MCQ",
  prompt: "Q1",
  promptAr: "Q1",
  options: JSON.stringify(["A", "B"]),
  answer: "0",
  difficulty: "MEDIUM",
  marks: 2,
  schoolType: "ARABIC",
  createdAt: NOW,
});
ins("ExamQuestion", {
  id: "eq-f1",
  lessonId: "l-f1",
  examType: "UNIT",
  prompt: "Q2",
  promptAr: "Q2",
  options: JSON.stringify(["A", "B"]),
  answer: "0",
  difficulty: "MEDIUM",
  marks: 2,
  schoolType: "ARABIC",
});

// ---------------------------------------------------------------------------
// 5. Assertions
// ---------------------------------------------------------------------------
(async () => {
  try {
    const main = USERS[0];
    const second = USERS[1];

    // -----------------------------------------------------------------------
    section("A. Lesson navigation — one rule, exact canonical lesson, no stale target");
    // -----------------------------------------------------------------------
    {
      const calls = [];
      const nav = {
        setLessonId: (id) => calls.push(["setLessonId", id]),
        setView: (v) => calls.push(["setView", v]),
        setNavParam: (p) => calls.push(["setNavParam", p]),
      };
      eq(NAV.openStudentLesson(nav, "l-target"), true, "A1: a canonical id opens the lesson");
      eq(
        calls,
        [
          ["setLessonId", "l-target"],
          ["setView", "student-lesson"],
          ["setNavParam", "l-target"],
        ],
        "A2: the FETCH KEY moves first, then the view (which clears navParam), then the target"
      );

      // A stale selection is a fixture precondition, not a parameter: the rule
      // writes the NEW id over it and never reads the old one.
      const nav2 = {
        setLessonId: (id) => calls.push(["setLessonId", id]),
        setView: (v) => calls.push(["setView", v]),
        setNavParam: (p) => calls.push(["setNavParam", p]),
      };
      calls.length = 0;
      NAV.openStudentLesson(nav2, "l-exact");
      eq(nav2 === nav2 && calls.every((c) => !String(c[1]).includes("l-prev")), true, "A3: a stale previous lesson is never written");
      eq(calls[0], ["setLessonId", "l-exact"], "A3b: the store's fetch key IS the target id");

      const empty = [];
      const nav3 = {
        setLessonId: (id) => empty.push(["setLessonId", id]),
        setView: (v) => empty.push(["setView", v]),
        setNavParam: (p) => empty.push(["setNavParam", p]),
      };
      for (const bad of [null, undefined, "", "   ", "has space", "a/b", "a:b", "x".repeat(65), 42, {}]) {
        eq(NAV.openStudentLesson(nav3, bad), false, `A4: malformed target opens nothing (${String(JSON.stringify(bad)).slice(0, 24)})`);
      }
      eq(empty, [], "A4: failed navigation touches no store key");

      // The notification half of the rule: strict parse + role gate, reused.
      eq(NAV.studentLessonIdFromNotificationLink("lesson:l-target", "STUDENT"), "l-target", "A5: lesson:<id> resolves to the exact id");
      const notifCalls = [];
      NAV.openStudentLesson(
        {
          setLessonId: (id) => notifCalls.push(["setLessonId", id]),
          setView: (v) => notifCalls.push(["setView", v]),
          setNavParam: (p) => notifCalls.push(["setNavParam", p]),
        },
        NAV.studentLessonIdFromNotificationLink("lesson:l-target", "STUDENT")
      );
      eq(notifCalls[0], ["setLessonId", "l-target"], "A6: the notification path moves the fetch key to the link's lesson");
      eq(
        nav3 && NAV.studentLessonIdFromNotificationLink("lesson:l-target", "TEACHER"),
        null,
        "A7: role gating is unchanged — a teacher's lesson link opens nothing"
      );
      for (const bad of ["video:v1", "quiz:q1", "homework:h1", "live:l1", "absence:a1", "lesson:", "lesson:a b", "student-homework", null, 7]) {
        eq(
          NAV.studentLessonIdFromNotificationLink(bad, "STUDENT"),
          null,
          `A8: only a well-formed lesson: link is a lesson target (${JSON.stringify(bad)})`
        );
      }
      eq(NAV.studentLessonIdFromNotificationLink("lesson:l-target", null), null, "A9: no role ⇒ no navigation");
      eq(DEEP.resolveDeepLink("lesson:l-target"), { view: "student-lesson", navParam: "l-target" }, "A10: the Phase 16 deep-link contract is unchanged");

      // Source pins: every student lesson entry point uses the ONE rule, and
      // the pinned Phase 16 / manual-QA shapes are preserved.
      const panel = read("src/components/shared/notifications-panel.tsx");
      ok(panel.includes("studentLessonIdFromNotificationLink(n.link, user.role)"), "A11: the notification panel resolves the lesson id through the shared rule");
      ok(panel.includes("openStudentLesson(useApp.getState(), lessonId)"), "A12: the notification panel opens it through `openStudentLesson`");
      ok(panel.includes("navigateDeepLink(n.link, useApp.getState())"), "A13: other deep-link kinds keep the pinned navigateDeepLink contract");
      ok(panel.includes("resolveDeepLinkForRole(n.link, user.role)"), "A14: the pinned role resolution is untouched");

      const dash = read("src/components/student/student-dashboard.tsx");
      ok(dash.includes("openStudentLesson(useApp.getState(), lessonId)"), "A15: the dashboard lesson card uses the shared rule");
      ok(dash.includes("openStudentLesson(useApp.getState(), h.lessonId)"), "A16: the Homework list CTA uses the shared rule (canonical lessonId)");
      ok(!/setView\("student-lesson"\);\s*\n\s*setNavParam\(h\.lessonId\)/.test(dash), "A17: no entry point sets view+navParam and skips the fetch key");

      const course = read("src/components/course/student-course.tsx");
      ok(course.includes("openStudentLesson(useApp.getState(), lesson.id)"), "A18: the course tree uses the shared rule");
      const bookmarksView = read("src/components/student/bookmarks-view.tsx");
      ok(bookmarksView.includes("openStudentLesson(useApp.getState(), b.lessonId)"), "A19: bookmarks use the shared rule");
      const lessonView = read("src/components/course/student-lesson.tsx");
      ok(lessonView.includes("const activeLessonId = lessonId"), "A20: the lesson view still fetches by the store's lessonId (the pinned contract)");
      ok(/const gotoLesson = \(id: string\) => \{[\s\S]*?setLessonId\(id\);[\s\S]*?setView\("student-lesson"\);[\s\S]*?\};/.test(lessonView), "A21: prev/next keeps its pinned order (setLessonId first)");
      const navSrc = read("src/lib/student-navigation.ts");
      ok(!/officialCode|\.title\b|order\b/.test(navSrc.replace(/\/\/.*$/gm, "")), "A22: the navigation rule never derives an id from a label/code/title");
    }

    // -----------------------------------------------------------------------
    section("B. Course / lesson Academic Level context — canonical Course.academicLevel only");
    // -----------------------------------------------------------------------
    asUser(main);
    const tree = await GET(R.course, "http://localhost/api/courses/m42-first", { slug: "m42-first" });
    eq(tree.status, 200, "B1: the course tree answers for the enrolled student");
    eq(tree.json.course.academicLevel, "FIRST_SECONDARY", "B2: the tree carries the canonical Course.academicLevel");
    eq(tree.json.course.id, "c-first", "B3: …of the canonical course");

    const treeParams = await GET(
      R.course,
      "http://localhost/api/courses/m42-first?academicLevel=SECOND_SECONDARY&level=SECOND_SECONDARY",
      { slug: "m42-first" }
    );
    eq(treeParams.json.course.academicLevel, "FIRST_SECONDARY", "B4: a client-supplied level never becomes the course level");

    const otherTree = await GET(R.course, "http://localhost/api/courses/m42-other", { slug: "m42-other" });
    ok(otherTree.status >= 400, "B5: another course is still refused (authorization unchanged)");

    const lv = await GET(R.lesson, "http://localhost/api/lessons/l-f1", { id: "l-f1" });
    eq(lv.status, 200, "B6: the lesson view answers for a visible lesson");
    eq(lv.json.course?.academicLevel, "FIRST_SECONDARY", "B7: the lesson carries its CANONICAL course level");
    eq(lv.json.course?.id, "c-first", "B8: …resolved through the chain");

    const lvSecond = await GET(R.lesson, "http://localhost/api/lessons/l-second", { id: "l-second" });
    ok(lvSecond.status >= 400, "B9: another level's lesson (same code, other course) is still not openable by this student");
    asUser(second);
    const lvSecondOwn = await GET(R.lesson, "http://localhost/api/lessons/l-second", { id: "l-second" });
    eq(lvSecondOwn.status, 200, "B10: the other level's student opens THEIR OWN lesson");
    eq(lvSecondOwn.json.course?.academicLevel, "SECOND_SECONDARY", "B11: with their own course's level");
    eq(lvSecondOwn.json.lesson?.officialCode, lv.json.lesson?.officialCode, "B12: the two lessons share the printed code — level + id keep them apart");
    ok(lvSecondOwn.json.lesson?.id !== lv.json.lesson?.id, "B13: …and the ids differ");

    // -----------------------------------------------------------------------
    section("C. Bookmarks — canonical chain first, legacy fallback, code is context");
    // -----------------------------------------------------------------------
    asUser(main);
    const bm = await GET(R.bookmarks, "http://localhost/api/students/me/bookmarks");
    eq(bm.status, 200, "C1: bookmarks answer for the student");
    const byLesson = Object.fromEntries(bm.json.bookmarks.map((b) => [b.lessonId, b]));
    const canon = byLesson["l-f1"];
    const legacy = byLesson["l-legacy"];
    eq(canon?.context?.chain, "UNIT", "C2: the canonical (Unit→Part) chain wins when it exists");
    eq(canon?.context?.part?.id, "p-c-first", "C3: …and names the part");
    eq(canon?.context?.unit?.id, "u-c-first", "C4: …and the unit");
    eq(canon?.context?.course?.academicLevel, "FIRST_SECONDARY", "C5: …and the course's canonical level");
    eq(canon?.lesson?.officialCode, "1-1", "C6: the printed code travels as context");
    eq(legacy?.context?.chain, "TOPIC", "C7: the legacy topic chain is the fallback");
    eq(legacy?.context?.unit?.id, "u-c-first", "C8: …and still resolves the unit/part");
    eq(legacy?.lesson?.officialCode, "1-3", "C9: legacy row keeps its own code");
    ok(
      bm.json.bookmarks.every((b) => typeof b.lessonId === "string" && b.lessonId.length > 0),
      "C10: the canonical lesson id is the identity of every row"
    );
    ok(
      !bm.json.bookmarks.some((b) => b.lessonId === "l-second"),
      "C11: the other level's bookmark is not listed for this student"
    );
    asUser(second);
    const bmSecond = await GET(R.bookmarks, "http://localhost/api/students/me/bookmarks");
    eq(bmSecond.json.bookmarks[0]?.lessonId, "l-second", "C12: the other student sees their OWN bookmark");
    eq(
      bmSecond.json.bookmarks[0]?.context?.course?.academicLevel,
      "SECOND_SECONDARY",
      "C13: …with their own level (same printed code as the first student's row)"
    );

    // -----------------------------------------------------------------------
    section("D. Study plan — server-side lessonId validation (fail closed)");
    // -----------------------------------------------------------------------
    asUser(main);
    const post = (body) => CALL(R.studyPlan, jsonReq(body, "http://localhost/api/students/me/study-plan"));
    const tasksBefore = count("StudyTask");

    const good = await post({ title: "T", scheduledDate: new Date(NOW).toISOString(), lessonId: "l-f1" });
    eq(good.status, 200, "D1: a VISIBLE current-course lesson is accepted");
    eq(good.json.task?.lessonId, "l-f1", "D2: …and stored as the canonical lesson id");
    const goodLegacy = await post({ title: "T", scheduledDate: new Date(NOW).toISOString(), lessonId: "l-legacy" });
    eq(goodLegacy.status, 200, "D3: a legacy topic-linked lesson of the current course is accepted too (documented fallback)");
    const noLesson = await post({ title: "T", scheduledDate: new Date(NOW).toISOString() });
    eq(noLesson.status, 200, "D4: a task with no lessonId still works (the field stays optional)");
    eq(noLesson.json.task?.lessonId, null, "D5: …and stores NULL");

    const rejects = [
      ["another course", "l-other"],
      ["another level (the other course's lesson)", "l-second"],
      ["a corrupted level cache in the student's own course", "l-mismatch"],
      ["an ARCHIVED lesson", "l-arch"],
      ["a DRAFT (unpublished) lesson", "l-draft"],
      ["a foreign-track lesson", "l-lang"],
      ["an unknown id", "l-does-not-exist"],
    ];
    for (const [why, lessonId] of rejects) {
      const bad = await post({ title: "T", scheduledDate: new Date(NOW).toISOString(), lessonId });
      eq(bad.status, 400, `D6: ${why} is rejected`);
      ok(!bad.json?.task, `D6: ${why} writes no task`);
    }
    eq(count("StudyTask"), tasksBefore + 3, "D7: exactly the three valid creates were written — every rejection was fail-closed");

    // PATCH: same gate on update; null clears.
    const patch = (body) =>
      CALL(R.studyPlan, {
        url: "http://localhost/api/students/me/study-plan",
        method: "PATCH",
        headers: { get: () => null },
        json: async () => body,
      });
    const taskId = good.json.task.id;
    const patchForeign = await patch({ taskId, lessonId: "l-other" });
    eq(patchForeign.status, 400, "D8: PATCH to a foreign-course lesson is rejected");
    eq(
      rawDb.prepare(`SELECT "lessonId" AS l FROM "StudyTask" WHERE id = ?`).get(taskId).l,
      "l-f1",
      "D9: …and the stored id is unchanged (no partial write)"
    );
    const patchOwn = await patch({ taskId, lessonId: "l-f2" });
    eq(patchOwn.status, 200, "D10: PATCH to another VISIBLE current-course lesson is accepted");
    eq(
      rawDb.prepare(`SELECT "lessonId" AS l FROM "StudyTask" WHERE id = ?`).get(taskId).l,
      "l-f2",
      "D11: …and the canonical id is stored"
    );
    const patchClear = await patch({ taskId, lessonId: null });
    eq(patchClear.status, 200, "D12: PATCH null clears the link");
    eq(
      rawDb.prepare(`SELECT "lessonId" AS l FROM "StudyTask" WHERE id = ?`).get(taskId).l,
      null,
      "D13: …and the column is NULL again"
    );
    const patchStatusOnly = await patch({ taskId, status: "DONE" });
    eq(patchStatusOnly.status, 200, "D14: a PATCH without lessonId keeps working (no lesson clause fires)");
    eq(
      rawDb.prepare(`SELECT "status" AS s FROM "StudyTask" WHERE id = ?`).get(taskId).s,
      "DONE",
      "D15: …and the update landed"
    );

    // Other students cannot smuggle their own curriculum in.
    asUser(second);
    const secondForeign = await post({ title: "T", scheduledDate: new Date(NOW).toISOString(), lessonId: "l-f1" });
    eq(secondForeign.status, 400, "D16: the other level's student cannot attach THIS level's lesson");
    const secondOwn = await post({ title: "T", scheduledDate: new Date(NOW).toISOString(), lessonId: "l-second" });
    eq(secondOwn.status, 200, "D17: …but their own curriculum's lesson is accepted");

    const planSrc = read("src/app/api/students/me/study-plan/route.ts");
    ok(/export async function POST[\s\S]*canStudentAttachLesson\(student\.id, attachedLessonId\)/.test(planSrc), "D18: POST validates through the shared gate");
    ok(/export async function PATCH[\s\S]*canStudentAttachLesson\(student\.id, patchLessonId\)/.test(planSrc), "D19: PATCH validates through the SAME gate");
    ok(!/lessonId: lessonId \|\| null/.test(planSrc), "D20: the raw client id is no longer stored unvalidated");

    // -----------------------------------------------------------------------
    section("E. Export progress — lifetime rows, every row attributed");
    // -----------------------------------------------------------------------
    asUser(main);
    const csv = await CALL(R.exportProgress, { url: "http://localhost/api/students/me/export-progress", method: "GET", headers: { get: () => null } });
    eq(csv.status, 200, "E1: the export answers");
    const lines = csv.text.replace(/^\uFEFF/, "").trim().split("\n").map((l) => l.slice(1, -1).split('","'));
    const header = lines[0];
    eq(header.slice(0, 6), ["Type", "Title", "Topic/Lesson", "Date", "Score/Status", "Details"], "E2: the original columns keep their order");
    eq(header.slice(6), ["Course", "Level"], "E3: Course + Level are appended");
    const rows = lines.slice(1).map((cells) => Object.fromEntries(header.map((h, i) => [h, cells[i]])));
    ok(rows.length >= 4, "E4: the export still carries every activity type");
    const lessonRows = rows.filter((r) => r.Type === "Lesson");
    eq(lessonRows.length, 2, "E5: both lifetime lesson rows are exported (nothing is narrowed to the current course)");
    const rowFor = (lessonTitle, level) =>
      lessonRows.find((r) => r.Level === level && r.Course) || null;
    {
      const current = lessonRows.find((r) => r.Level === "FIRST_SECONDARY");
      const previous = lessonRows.find((r) => r.Level === "SECOND_SECONDARY");
      eq(current?.Course, "البرمجة والذكاء الاصطناعي", "E6: a current-course row names its course");
      eq(previous?.Course, "البرمجة والذكاء الاصطناعي", "E7: a previous-level row names ITS course (same display name, different course)");
      ok(current && previous && current.Course === previous.Course, "E8: the two rows are distinguishable only by Level — which is exactly why Level is exported");
      ok(previous?.Level === "SECOND_SECONDARY", "E9: the previous level's row carries its own canonical level");
    }
    const attendanceRows = rows.filter((r) => r.Type === "Attendance");
    eq(attendanceRows.length, 2, "E10: both attendance rows are exported");
    ok(attendanceRows.every((r) => r.Course && r.Level), "E11: every attendance row is attributed through Session.group.course");
    ok(
      rows.every((r) => (r.Course === "" && r.Level === "") || (r.Course !== "" && r.Level !== "") || r.Type === "Attendance"),
      "E12: no row invents a level without a course"
    );
    ok(rows.every((r) => r.Level === "" || r.Level === "FIRST_SECONDARY" || r.Level === "SECOND_SECONDARY"), "E13: Level is the canonical value or empty — never a translated label");
    ok(!csv.text.includes("Mock Exam Mode"), "E14: no hard-coded English label leaks into the export");
    void rowFor;

    // -----------------------------------------------------------------------
    section("F. Session videos — read-only level/course context, semantics unchanged");
    // -----------------------------------------------------------------------
    const vids = await GET(R.videos, "http://localhost/api/students/me/session-videos");
    eq(vids.status, 200, "F1: the library answers");
    const vidsById = Object.fromEntries(vids.json.videos.map((v) => [v.id, v]));
    ok(vidsById["sv-f1"], "F2: a published recording of an accessible session is listed");
    eq(vidsById["sv-f1"].lesson?.id, "l-f1", "F3: the recording still names its canonical lesson id");
    eq(vidsById["sv-f1"].lesson?.officialCode, "1-1", "F4: …and its printed code (context)");
    eq(vidsById["sv-f1"].lesson?.course?.academicLevel, "FIRST_SECONDARY", "F5: the canonical COURSE level is attached (M4.2)");
    eq(vidsById["sv-f1"].lesson?.course?.id, "c-first", "F6: …with the course itself");
    ok(!vidsById["sv-draft"], "F7: a recording linked to a non-PUBLISHED session is still dropped (Phase 13 clause)");
    ok(!vidsById["sv-unpublished"], "F8: an unpublished recording is still dropped");
    ok(vidsById["sv-lessonless"], "F9: a legacy batch recording with no lesson is still listed");
    eq(vidsById["sv-lessonless"].lesson, null, "F10: …with no lesson context at all");
    eq(
      vidsById["sv-f1"].requirementMode,
      "OPTIONAL",
      "F11: requirementMode is still reported from the row (unchanged)"
    );
    eq(vidsById["sv-f1"].applicable, false, "F12: the OPTIONAL verdict is unchanged");
    eq(vidsById["sv-f1"].progress?.percent, 0, "F13: watch progress is still the student's own (0 here)");
    eq(vidsById["sv-f1"].src, "https://example.test/video.mp4", "F14: EXTERNAL_URL delivery is unchanged (never a storageKey)");

    // The duplicate printed code across levels: the SECONDARY student's own
    // recording carries the SAME code and title — and is distinguishable only
    // by the canonical lesson id + the course level, which is exactly why the
    // payload now carries them.
    asUser(second);
    const vidsSecond = await GET(R.videos, "http://localhost/api/students/me/session-videos");
    const other = vidsSecond.json.videos.find((v) => v.id === "sv-second");
    ok(!!other, "F15: the other level's student sees THEIR OWN recording");
    eq(other?.lesson?.officialCode, vidsById["sv-f1"].lesson?.officialCode, "F16: …under the same printed code");
    ok(other?.lesson?.id !== vidsById["sv-f1"].lesson?.id, "F16b: …and a different canonical lesson id");
    eq(other?.lesson?.course?.academicLevel, "SECOND_SECONDARY", "F17: …and their own course's level");
    ok(
      !vidsSecond.json.videos.some((v) => v.id === "sv-f1"),
      "F18: the first level's recording never crosses into the other student's list"
    );
    asUser(main);

    const narrowed = await GET(R.videos, "http://localhost/api/students/me/session-videos?lessonId=l-f1");
    eq(narrowed.json.videos.map((v) => v.id), ["sv-f1"], "F19: ?lessonId= still narrows to that session's recordings");
    const narrowedForeign = await GET(R.videos, "http://localhost/api/students/me/session-videos?lessonId=l-second");
    eq(narrowedForeign.json.videos, [], "F20: another level's lesson yields NO videos (the narrowing gate is unchanged)");

    const videosSrc = read("src/app/api/students/me/session-videos/route.ts");
    ok(videosSrc.includes("canAccessLesson(student.id, lessonId)"), "F21: the Phase B lesson gate is intact");
    ok(videosSrc.includes("...videoTrackFilter(enrollment.schoolType)"), "F22: the track gate is intact");
    ok(videosSrc.includes("{ lesson: LESSON_STUDENT_STATUS_FILTER }"), "F23: the published-session clause is intact");
    ok(videosSrc.includes("effectiveRequirementMode(v)") && videosSrc.includes("loadVideoApplicability("), "F24: requirement verdicts still come from the one authority");

    // -----------------------------------------------------------------------
    section("G. Mock exams — course scope unchanged, display context added");
    // -----------------------------------------------------------------------
    const list = await GET(R.mockExams, "http://localhost/api/students/me/mock-exams");
    eq(list.status, 200, "G1: the exam list answers");
    eq(list.json.exams.map((e) => e.id), ["mx-first"], "G2: only the enrolled course's PUBLISHED exam is listed");
    const listed = list.json.exams[0];
    eq(listed.academicLevel, "FIRST_SECONDARY", "G3: the exam row carries its course's canonical level");
    eq(listed.courseName, "البرمجة والذكاء الاصطناعي", "G4: …and the course name");
    eq(listed.courseId, "c-first", "G5: the strict courseId scope is still reported");

    const paper = await GET(R.exam, "http://localhost/api/exams/mock?mockExamId=mx-first&count=3");
    eq(paper.status, 200, "G6: the paper answers");
    ok(Array.isArray(paper.json.exam?.questions) && paper.json.exam.questions.length >= 1, "G7: the exam's course pool serves questions");
    ok(
      paper.json.exam.questions.every((q) => "lessonCode" in q),
      "G8: every served question carries its lesson code (display context)"
    );
    ok(
      paper.json.exam.questions.every((q) => !("correctIndex" in q) && !("answer" in q)),
      "G9: the served draft still carries NO answer key"
    );
    ok(
      paper.json.exam.questions.some((q) => q.lessonCode === "1-1"),
      "G10: …and the code is the lesson's own printed code"
    );
    const foreignPaper = await GET(R.exam, "http://localhost/api/exams/mock?mockExamId=mx-other&count=3");
    eq(foreignPaper.status, 404, "G11: a foreign-course exam is still a 404 (course authority unchanged)");
    const draftPaper = await GET(R.exam, "http://localhost/api/exams/mock?mockExamId=mx-draft&count=3");
    eq(draftPaper.status, 404, "G12: an unpublished exam is still refused");

    const examSrc = read("src/app/api/exams/mock/route.ts");
    ok(examSrc.includes("mockExamRandomScopeWhere(lessonIds, mockExam?.id ?? null)"), "G13: the RANDOM scope rule is untouched");
    ok(examSrc.includes("if (mockExam.courseId !== courseId)"), "G14: the course-binding check is untouched");
    const examUi = read("src/components/student/mock-exam.tsx");
    ok(examUi.includes('{tr("student.253")}'), "G15: the hard-coded “Mock Exam Mode” label is now localized");
    ok(!examUi.includes("Mock Exam Mode"), "G16: …and the English literal is gone");
    ok(examUi.includes("academicLevelLabelFor(tr, e.academicLevel)"), "G17: the exam list renders the level through the shared vocabulary");
    ok(examUi.includes("q.lessonCode ? `${q.lessonCode} · ` : \"\""), "G18: the question/review caption pairs the code with the title");

    // -----------------------------------------------------------------------
    section("H. Certificate — passive level rendered, authority untouched");
    // -----------------------------------------------------------------------
    const certView = read("src/components/student/certificate-view.tsx");
    ok(certView.includes("academicLevelLabelFor(t, cert.academicLevel)"), "H1: the certificate renders the M4.1 level context");
    ok(!certView.includes("pct >= 80"), "H2: the client still does not re-decide eligibility");
    const certRoute = read("src/app/api/students/me/certificate/route.ts");
    ok(certRoute.includes("const eligible = pct >= 80;"), "H3: the 80% threshold is unchanged");
    ok(certRoute.includes('metricsScope: "CURRENT_COURSE"'), "H4: the metrics scope is unchanged");
    ok(certRoute.includes("certificateReference(student.id, course.id)"), "H5: the certificate id is still secret-keyed and course-bound");
    ok(certRoute.includes("academicLevel: academic.courseAcademicLevel"), "H6: …and still exposes the course level it was graded at");

    // -----------------------------------------------------------------------
    section("I. Shared vocabulary — no competing level label (D3)");
    // -----------------------------------------------------------------------
    for (const file of [
      "src/components/student/bookmarks-view.tsx",
      "src/components/course/session-videos-view.tsx",
      "src/components/course/student-course.tsx",
      "src/components/course/student-lesson.tsx",
      "src/components/student/mock-exam.tsx",
      "src/components/student/certificate-view.tsx",
    ]) {
      const src = read(file);
      ok(src.includes("academicLevelLabelFor"), `${file} composes levels through the ONE label module`);
      ok(!/أولى ثانوي|ثانية ثانوي/.test(src), `${file} does not inline the level vocabulary`);
    }
    const routesWithLevel = [
      "src/app/api/courses/[slug]/route.ts",
      "src/app/api/lessons/[id]/route.ts",
      "src/app/api/students/me/bookmarks/route.ts",
      "src/app/api/students/me/session-videos/route.ts",
      "src/app/api/students/me/mock-exams/route.ts",
      "src/app/api/students/me/export-progress/route.ts",
      "src/app/api/students/me/study-plan/route.ts",
    ];
    for (const file of routesWithLevel) {
      const src = read(file);
      ok(!/req\.(json|url)[\s\S]{0,200}academicLevel/.test(src) || !src.includes("body.academicLevel"), `${file} reads no client-supplied level`);
    }
  } catch (err) {
    fail++;
    failures.push(`threw: ${err && err.stack ? err.stack.split("\n")[0] : err}`);
    console.error("\nUNEXPECTED ERROR:", err);
  }

  console.log(`\nphase-m42 student content flows: ${pass} passed, ${fail} failed`);
  if (failures.length) {
    console.log("\nfailures:");
    for (const f of failures) console.log(` - ${f}`);
  }
  process.exit(fail === 0 ? 0 : 1);
})();
