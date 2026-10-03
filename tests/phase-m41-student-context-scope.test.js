// CodeMind Academy — Phase M4.1: Student canonical context & history scope.
//
// The REAL student route handlers (dashboard, current-course, enrollment,
// certificate, leaderboard, gamification) run against the repository's
// migration-backed SQLite database, with only the framework boundary shimmed
// (Prisma engine → sqlite-prisma-lite, auth → a script-controlled user,
// next/server + next/headers). No route logic is copied here.
//
// The fixture is a transfer story, and it is deliberately adversarial:
//
//   * `s-main` (LANGUAGE, FIRST_SECONDARY) now studies course `c-cur`. Their
//     history also exists in course `c-old` (SECOND_SECONDARY — the level they
//     came from) and in course `c-same` (FIRST_SECONDARY — a DIFFERENT course
//     at the SAME level). Old rows carry the NEWEST timestamps, so any leak
//     would surface as "previous course is the latest activity".
//   * All three courses share the display name "Programming & AI"; `l-cur` and
//     `l-old` share the printed lesson code "1-1" and every lesson shares the
//     title "Session 1-1" (the `(academicLevel, officialCode)` unique makes
//     the same code at two levels the natural case). Identity must therefore
//     be the canonical relation chain — never a name, title or code.
//   * `s-decoy` is an ARABIC student in the SAME course with the SAME display
//     name as `s-main` and a higher XP total: the leaderboard must identify
//     "me" by student id (a name match would hand over the wrong rank), and
//     per-row activity must use each row's OWN track (ARABIC rows count for
//     the Arabic peer, not for the Arabic-vs-Language caller).
//   * Lifecycle is preserved: a DRAFT and an ARCHIVED lesson in the current
//     course stay outside every student universe.
//
// Run: node tests/phase-m41-student-context-scope.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO = path.resolve(__dirname, "..");
process.env.SECURITY_HASH_SECRET = "m41".padEnd(64, "0");

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`M4.1 test made a network connection attempt: ${JSON.stringify(args[0])}`);
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
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "M4.1: " });
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
  "src/lib/rate-limit.ts",
  "src/lib/api.ts",
  "src/lib/brand.ts",
  "src/lib/gamification.ts",
  "src/lib/payment-submission.ts",
  "src/lib/lesson-content.ts",
  "src/lib/unit-counts.ts",
  "src/app/api/students/me/dashboard/route.ts",
  "src/app/api/students/me/current-course/route.ts",
  "src/app/api/students/me/enrollment/route.ts",
  "src/app/api/students/me/certificate/route.ts",
  "src/app/api/students/me/leaderboard/route.ts",
  "src/app/api/students/me/gamification/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m41-scope-"));
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
  /* type noise tolerated — the emitted files are what matter (see README gate) */
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
  dashboard: route("students/me/dashboard/route.js"),
  currentCourse: route("students/me/current-course/route.js"),
  enrollment: route("students/me/enrollment/route.js"),
  certificate: route("students/me/certificate/route.js"),
  leaderboard: route("students/me/leaderboard/route.js"),
  gamification: route("students/me/gamification/route.js"),
};
const gamification = require(path.join(EMIT, "lib/gamification.js"));

function asUser(u) {
  globalThis.__CM_USER__ = u
    ? { id: u.id, email: u.email, name: u.name, role: u.role }
    : null;
}
async function GET(handler, url) {
  const req = { url: url || "http://localhost/api", method: "GET", headers: { get: () => null } };
  const res = await (typeof handler === "function" ? handler : handler.GET)(req);
  return { status: res.status, json: await res.json() };
}

const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000);

// node:sqlite binds neither booleans nor Dates: the migration DDL stores
// booleans as 0/1 and DateTime as epoch milliseconds (the same representation
// the repo's own test fixtures and sqlite-prisma-lite use).
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

// ---------------------------------------------------------------------------
// 4. Fixture — one transfer story, three courses, two tracks, one homonym.
// ---------------------------------------------------------------------------
section("M4.1 fixture — transfer student, same codes across levels, homonym peer");

const COURSES = [
  { id: "c-cur", slug: "m41-current", level: "FIRST_SECONDARY" },
  { id: "c-old", slug: "m41-left-behind", level: "SECOND_SECONDARY" },
  { id: "c-same", slug: "m41-same-level", level: "FIRST_SECONDARY" },
  // A pure history course: nothing here is anyone's CURRENT course, so it only
  // ever shows up through ACADEMY-LIFETIME metrics (XP), never as activity.
  { id: "c-hist", slug: "m41-history", level: "SECOND_SECONDARY" },
];
for (const c of COURSES) {
  // Identical display name on all three: identity must not come from a label.
  ins("Course", {
    id: c.id,
    slug: c.slug,
    academicLevel: c.level,
    name: "Programming & AI",
    nameAr: "Programming & AI",
    description: "M4.1 fixture course",
    color: "#10b981",
    createdAt: NOW,
    updatedAt: NOW,
  });
  ins("Part", { id: `p-${c.id}`, courseId: c.id, title: "Part 1", titleAr: "Part 1", order: 1 });
  ins("Unit", { id: `u-${c.id}`, partId: `p-${c.id}`, title: "Unit 1", titleAr: "Unit 1", order: 1 });
}

function lesson({ id, courseId, level, officialCode, trackScope = "SHARED", status = "PUBLISHED", curriculumStatus = "OFFICIAL" }) {
  ins("Lesson", {
    id,
    unitId: `u-${courseId}`,
    officialCode,
    academicLevel: level,
    curriculumStatus,
    trackScope,
    status,
    title: "Session 1-1", // identical title everywhere on purpose
    titleAr: "Session 1-1",
    order: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
// Current course (FIRST_SECONDARY): two LANGUAGE-visible lessons + track and
// lifecycle decoys that must never enter a LANGUAGE student's universe.
lesson({ id: "l-cur", courseId: "c-cur", level: "FIRST_SECONDARY", officialCode: "1-1" });
lesson({ id: "l-cur-lang", courseId: "c-cur", level: "FIRST_SECONDARY", officialCode: "1-2", trackScope: "LANGUAGE" });
lesson({ id: "l-cur-ar", courseId: "c-cur", level: "FIRST_SECONDARY", officialCode: "1-3", trackScope: "ARABIC" });
lesson({ id: "l-cur-ar2", courseId: "c-cur", level: "FIRST_SECONDARY", officialCode: "1-4", trackScope: "ARABIC" });
lesson({ id: "l-cur-draft", courseId: "c-cur", level: "FIRST_SECONDARY", officialCode: "1-5", status: "DRAFT" });
lesson({ id: "l-cur-arch", courseId: "c-cur", level: "FIRST_SECONDARY", officialCode: "1-6", curriculumStatus: "ARCHIVED" });
// The level the student came from — SAME printed code "1-1", same title.
lesson({ id: "l-old", courseId: "c-old", level: "SECOND_SECONDARY", officialCode: "1-1" });
// A different course at the SAME level.
lesson({ id: "l-same", courseId: "c-same", level: "FIRST_SECONDARY", officialCode: "2-1" });
// History-only lessons in the pure-history course (the Arabic peer outranks
// the caller on ACADEMY-LIFETIME XP through rows like these — they must never
// appear in anyone's current-course counters).
for (let i = 2; i <= 6; i++) {
  lesson({ id: `l-hist-${i}`, courseId: "c-hist", level: "SECOND_SECONDARY", officialCode: `2-${i}` });
}

const GROUPS = [
  { id: "g-cur", courseId: "c-cur" },
  { id: "g-cur2", courseId: "c-cur" }, // same course, different classroom
  { id: "g-old", courseId: "c-old" },
  { id: "g-same", courseId: "c-same" },
];
for (const g of GROUPS) {
  ins("Group", {
    id: g.id,
    name: `Group ${g.id}`,
    courseId: g.courseId,
    capacity: 20,
    schedule: "Sat",
    isActive: 1,
    trackScope: "LANGUAGE",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

const USERS = [
  { id: "u-main", name: "Same Name", email: "main@m41.test", role: "STUDENT" },
  { id: "u-decoy", name: "Same Name", email: "decoy@m41.test", role: "STUDENT" },
  { id: "u-left", name: "Left Behind", email: "left@m41.test", role: "STUDENT" },
  { id: "u-other", name: "Other Course", email: "other@m41.test", role: "STUDENT" },
  { id: "u-teacher", name: "A Teacher", email: "teacher@m41.test", role: "TEACHER" },
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

const STUDENTS = [
  { id: "s-main", userId: "u-main", groupId: "g-cur", level: "FIRST_SECONDARY", schoolType: "LANGUAGE", grade: "1st Secondary" },
  { id: "s-decoy", userId: "u-decoy", groupId: "g-cur2", level: "FIRST_SECONDARY", schoolType: "ARABIC", grade: "1st Secondary" },
  { id: "s-left", userId: "u-left", groupId: "g-old", level: "SECOND_SECONDARY", schoolType: "LANGUAGE", grade: "2nd Secondary" },
  { id: "s-other", userId: "u-other", groupId: "g-same", level: "FIRST_SECONDARY", schoolType: "LANGUAGE", grade: "1st Secondary" },
];
for (const s of STUDENTS) {
  ins("Student", {
    id: s.id,
    userId: s.userId,
    groupId: s.groupId,
    academicLevel: s.level,
    schoolType: s.schoolType,
    grade: s.grade,
    enrolledAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

function session({ id, groupId, lessonId, minutesAgo }) {
  ins("LiveSession", {
    id,
    groupId,
    lessonId,
    title: "Session",
    titleAr: "Session",
    startAt: at(minutesAgo),
    duration: 120,
    status: "COMPLETED",
    createdAt: NOW,
  });
}
session({ id: "ses-cur1", groupId: "g-cur", lessonId: "l-cur", minutesAgo: 600 });
session({ id: "ses-cur2", groupId: "g-cur", lessonId: "l-cur", minutesAgo: 540 });
session({ id: "ses-old", groupId: "g-old", lessonId: "l-old", minutesAgo: 5 });
session({ id: "ses-same", groupId: "g-same", lessonId: "l-same", minutesAgo: 6 });

function attendance(id, studentId, sessionId, status) {
  ins("Attendance", { id, studentId, sessionId, status, createdAt: NOW });
}
attendance("att-cur1", "s-main", "ses-cur1", "PRESENT");
attendance("att-cur2", "s-main", "ses-cur2", "ABSENT");
attendance("att-old", "s-main", "ses-old", "PRESENT"); // previous LEVEL
attendance("att-same", "s-main", "ses-same", "PRESENT"); // same level, other course

function quiz({ id, lessonId, trackScope }) {
  ins("Quiz", {
    id,
    lessonId,
    trackScope,
    title: "Quiz",
    titleAr: "Quiz",
    passMark: 60,
    order: 1,
    status: "PUBLISHED",
  });
}
quiz({ id: "q-cur", lessonId: "l-cur", trackScope: "SHARED" });
quiz({ id: "q-cur-ar", lessonId: "l-cur-ar", trackScope: "ARABIC" });
quiz({ id: "q-old", lessonId: "l-old", trackScope: "SHARED" });
quiz({ id: "q-same", lessonId: "l-same", trackScope: "SHARED" });

function attempt({ id, quizId, studentId, percentage, passed, minutesAgo, attemptNumber }) {
  ins("QuizAttempt", {
    id,
    quizId,
    studentId,
    score: percentage,
    totalMarks: 100,
    percentage,
    passed: passed ? 1 : 0,
    startedAt: at(minutesAgo + 5),
    finishedAt: at(minutesAgo),
    attemptNumber,
    status: "SUBMITTED",
  });
}
attempt({ id: "qa-cur-1", quizId: "q-cur", studentId: "s-main", percentage: 60, passed: false, minutesAgo: 20, attemptNumber: 1 });
attempt({ id: "qa-cur-2", quizId: "q-cur", studentId: "s-main", percentage: 80, passed: true, minutesAgo: 18, attemptNumber: 2 });
attempt({ id: "qa-old", quizId: "q-old", studentId: "s-main", percentage: 100, passed: true, minutesAgo: 2, attemptNumber: 1 });
attempt({ id: "qa-same", quizId: "q-same", studentId: "s-main", percentage: 100, passed: true, minutesAgo: 5, attemptNumber: 1 });
attempt({ id: "qa-decoy-ar", quizId: "q-cur-ar", studentId: "s-decoy", percentage: 100, passed: true, minutesAgo: 30, attemptNumber: 1 });

function homework({ id, lessonId, status = "PUBLISHED", minutesAgo = 10_000 }) {
  ins("Homework", {
    id,
    lessonId,
    trackScope: "SHARED",
    title: "Homework",
    titleAr: "Homework",
    deadline: at(-minutesAgo),
    maxMarks: 10,
    status,
    createdAt: NOW,
  });
}
homework({ id: "h-cur", lessonId: "l-cur" });
homework({ id: "h-old", lessonId: "l-old" });
homework({ id: "h-same", lessonId: "l-same" });

function submission({ id, homeworkId, studentId, status, grade, minutesAgo }) {
  ins("HomeworkSubmission", {
    id,
    homeworkId,
    studentId,
    status,
    grade,
    submittedAt: at(minutesAgo),
  });
}
submission({ id: "hs-cur", homeworkId: "h-cur", studentId: "s-main", status: "SUBMITTED", grade: null, minutesAgo: 30 });
submission({ id: "hs-old", homeworkId: "h-old", studentId: "s-main", status: "GRADED", grade: 10, minutesAgo: 3 });
submission({ id: "hs-same", homeworkId: "h-same", studentId: "s-main", status: "GRADED", grade: 10, minutesAgo: 6 });

function progress({ id, studentId, lessonId, isCompleted, minutesAgo }) {
  ins("LessonProgress", {
    id,
    studentId,
    lessonId,
    progress: isCompleted ? 100 : 40,
    isCompleted: isCompleted ? 1 : 0,
    lastViewedAt: minutesAgo === null ? null : at(minutesAgo),
  });
}
progress({ id: "lp-cur", studentId: "s-main", lessonId: "l-cur", isCompleted: true, minutesAgo: 10 });
progress({ id: "lp-cur-lang", studentId: "s-main", lessonId: "l-cur-lang", isCompleted: true, minutesAgo: null });
progress({ id: "lp-old", studentId: "s-main", lessonId: "l-old", isCompleted: true, minutesAgo: 1 });
progress({ id: "lp-same", studentId: "s-main", lessonId: "l-same", isCompleted: true, minutesAgo: 4 });
// The other-level student's own completion, so their certificate is real.
progress({ id: "lp-left", studentId: "s-left", lessonId: "l-old", isCompleted: true, minutesAgo: 7 });
// The Arabic peer's own rows (same course, other track).
progress({ id: "lp-decoy-1", studentId: "s-decoy", lessonId: "l-cur", isCompleted: true, minutesAgo: 25 });
progress({ id: "lp-decoy-2", studentId: "s-decoy", lessonId: "l-cur-ar", isCompleted: true, minutesAgo: 20 });
progress({ id: "lp-decoy-3", studentId: "s-decoy", lessonId: "l-cur-ar2", isCompleted: true, minutesAgo: 15 });
// Five completed lessons the Arabic peer left behind in the other level: the
// fixture's way of making their ACADEMY-LIFETIME XP higher than the caller's.
for (let i = 2; i <= 6; i++) {
  progress({ id: `lp-decoy-hist-${i}`, studentId: "s-decoy", lessonId: `l-hist-${i}`, isCompleted: true, minutesAgo: 60 + i });
}
ins("StudentBadge", { id: "sb-main", studentId: "s-main", code: "first-lesson", earnedAt: NOW });
ins("StudentBadge", { id: "sb-decoy", studentId: "s-decoy", code: "first-lesson", earnedAt: NOW });

// ---------------------------------------------------------------------------
// 5. Assertions
// ---------------------------------------------------------------------------
(async () => {
  try {
    const mainUser = USERS[0];

    // -----------------------------------------------------------------------
    section("1. dashboard — canonical context is exposed, never taken from the client");
    asUser(mainUser);
    const dash = await GET(R.dashboard, "http://localhost/api/students/me/dashboard");
    eq(dash.status, 200, "dashboard answers 200 for the student");
    eq(dash.json.studentAcademicLevel, "FIRST_SECONDARY", "student level = Student.academicLevel");
    eq(dash.json.group.course.academicLevel, "FIRST_SECONDARY", "course level = Course.academicLevel");
    eq(dash.json.historyScope, "CURRENT_COURSE", "the payload names the history scope");
    eq(dash.json.student.grade, "1st Secondary", "Student.grade is preserved for existing callers");

    const dashWithParams = await GET(
      R.dashboard,
      "http://localhost/api/students/me/dashboard?academicLevel=SECOND_SECONDARY&level=SECOND_SECONDARY&courseId=c-old&studentId=s-left"
    );
    eq(
      dashWithParams.json.studentAcademicLevel,
      "FIRST_SECONDARY",
      "a client-supplied level never becomes the student level"
    );
    eq(
      dashWithParams.json.group.course.academicLevel,
      "FIRST_SECONDARY",
      "a client-supplied level never becomes the course level"
    );
    eq(
      dashWithParams.json.courseProgress,
      dash.json.courseProgress,
      "a client-supplied course id cannot widen the progress ring"
    );
    eq(
      dashWithParams.json.attendance,
      dash.json.attendance,
      "a client-supplied course id cannot widen attendance"
    );
    eq(
      dashWithParams.json.latestQuizResult?.quizId,
      dash.json.latestQuizResult?.quizId,
      "a client-supplied course id cannot change the latest quiz"
    );

    // -----------------------------------------------------------------------
    section("2. dashboard attendance — current course only (previous level + same-level course excluded)");
    eq(dash.json.attendance.total, 2, "attendance totals only the CURRENT course's sessions");
    eq(dash.json.attendance.present, 1, "present count is the current course's");
    eq(dash.json.attendance.percentage, 50, "attendance percentage is the current course's");

    // -----------------------------------------------------------------------
    section("3. dashboard latest quiz + recent activity — current course only");
    eq(dash.json.latestQuizResult.quizId, "q-cur", "latest quiz is the newest CURRENT-course attempt");
    eq(dash.json.latestQuizResult.attemptId, "qa-cur-2", "…and the newest attempt on it");
    eq(
      dash.json.recentActivity.map((a) => a.meta.lessonId || a.meta.quizId || a.meta.homeworkId).sort(),
      ["h-cur", "l-cur", "q-cur", "q-cur"],
      "recent activity lists exactly the current-course lesson/quiz attempts/homework"
    );
    eq(
      dash.json.recentActivity.map((a) => a.type).sort(),
      ["homework", "lesson", "quiz", "quiz"],
      "…both attempts are on the current course's quiz"
    );
    eq(
      dash.json.recentActivity
        .map((a) => a.meta.lessonId || a.meta.quizId || a.meta.homeworkId)
        .filter((id) => ["l-old", "q-old", "h-old", "l-same", "q-same", "h-same"].includes(id)),
      [],
      "no previous-level or same-level-other-course row survives into recent activity"
    );

    // -----------------------------------------------------------------------
    section("4. dashboard progress ring — same printed code at another level cannot widen it");
    eq(dash.json.courseProgress.totalLessons, 2, "denominator = the current course's LANGUAGE universe (2), not 6 lessons of other courses");
    ok(
      dash.json.courseProgress.completedLessons <= 2,
      "numerator cannot exceed the current course's universe"
    );
    eq(dash.json.continueLesson ? dash.json.continueLesson.courseSlug : null, "m41-current", "continue lesson belongs to the current course");

    // -----------------------------------------------------------------------
    section("5. current-course + enrollment — read-only level context");
    const cc = await GET(R.currentCourse, "http://localhost/api/students/me/current-course");
    eq(cc.status, 200, "current-course answers 200");
    eq(cc.json.studentAcademicLevel, "FIRST_SECONDARY", "current-course exposes Student.academicLevel");
    eq(cc.json.course.academicLevel, "FIRST_SECONDARY", "current-course exposes Course.academicLevel");
    eq(cc.json.course.id, "c-cur", "current-course resolves the canonical course id");
    const ccParams = await GET(
      R.currentCourse,
      "http://localhost/api/students/me/current-course?academicLevel=SECOND_SECONDARY&courseId=c-old"
    );
    eq(ccParams.json.course.id, "c-cur", "current-course ignores a client course id");
    eq(ccParams.json.course.academicLevel, "FIRST_SECONDARY", "current-course ignores a client level");

    const enr = await GET(R.enrollment, "http://localhost/api/students/me/enrollment");
    eq(enr.status, 200, "enrollment answers 200");
    eq(enr.json.studentAcademicLevel, "FIRST_SECONDARY", "enrollment exposes Student.academicLevel");
    eq(enr.json.course.academicLevel, "FIRST_SECONDARY", "enrollment exposes Course.academicLevel");
    eq(enr.json.course.id, "c-cur", "enrollment resolves the current course");

    // The ARABIC peer: same course, same level, DIFFERENT track — the track is
    // an independent dimension from the level.
    asUser(USERS[1]);
    const enrAr = await GET(R.enrollment, "http://localhost/api/students/me/enrollment");
    eq(enrAr.json.studentAcademicLevel, "FIRST_SECONDARY", "the Arabic peer has the same student level");
    eq(enrAr.json.course.academicLevel, "FIRST_SECONDARY", "…and the same course level");
    eq(enrAr.json.course.id, "c-cur", "…and the same canonical course");

    // -----------------------------------------------------------------------
    section("6. certificate — current course aggregates + passive level context");
    asUser(mainUser);
    const cert = await GET(R.certificate, "http://localhost/api/students/me/certificate");
    eq(cert.status, 200, "certificate answers 200");
    eq(cert.json.studentAcademicLevel, "FIRST_SECONDARY", "certificate exposes the student-level authority");
    eq(cert.json.totalLessons, 2, "certificate denominator = current course LANGUAGE universe");
    eq(cert.json.completedLessons, 2, "certificate numerator excludes previous-course completions (4 exist lifetime)");
    eq(cert.json.progressPct, 100, "the 80% threshold is computed from the scoped counts");
    eq(cert.json.eligible, true, "…and the certificate is issued");
    eq(cert.json.certificate.academicLevel, "FIRST_SECONDARY", "the certificate carries the COURSE-level authority");
    eq(cert.json.certificate.metricsScope, "CURRENT_COURSE", "the certificate names its metrics scope");
    eq(cert.json.certificate.avgQuizScore, 70, "quiz average covers only current-course attempts (60 + 80, not the 100s)");
    eq(cert.json.certificate.attendanceRate, 50, "attendance rate covers only current-course sessions");

    const certAgain = await GET(R.certificate, "http://localhost/api/students/me/certificate");
    eq(
      certAgain.json.certificate.certificateId,
      cert.json.certificate.certificateId,
      "the certificate reference is deterministic (stable per student + course)"
    );
    ok(
      /^CM-[0-9A-F]{8}-[0-9A-F]{4}$/.test(cert.json.certificate.certificateId),
      `the reference keeps the CM- shape (${cert.json.certificate.certificateId})`
    );
    ok(
      !/^\d{4}-\d{2}-\d{2}T/.test(cert.json.certificate.certificateId),
      "…and carries no timestamp"
    );

    const certParams = await GET(
      R.certificate,
      "http://localhost/api/students/me/certificate?academicLevel=SECOND_SECONDARY&courseId=c-old"
    );
    eq(certParams.json.studentAcademicLevel, "FIRST_SECONDARY", "a client level never reaches the certificate");
    eq(certParams.json.progressPct, 100, "a client course id never widens the certificate metrics");

    // The Arabic peer's universe is the SHARED + ARABIC slice of the SAME
    // course at the SAME level: level and track are orthogonal.
    asUser(USERS[1]);
    const certAr = await GET(R.certificate, "http://localhost/api/students/me/certificate");
    eq(certAr.json.totalLessons, 3, "the Arabic peer counts the SHARED + ARABIC lessons of the same course (3)");
    eq(certAr.json.studentAcademicLevel, "FIRST_SECONDARY", "…still at first-secondary level");
    eq(certAr.json.certificate.academicLevel, "FIRST_SECONDARY", "…same course level");

    // A student still in the course the transfer left: their own level and
    // course are authoritative — nothing from this fixture leaks sideways.
    asUser(USERS[2]);
    const certLeft = await GET(R.certificate, "http://localhost/api/students/me/certificate");
    eq(certLeft.json.studentAcademicLevel, "SECOND_SECONDARY", "the other-level student's OWN level is reported");
    eq(certLeft.json.certificate.academicLevel, "SECOND_SECONDARY", "…with their own course's level");
    eq(certLeft.json.totalLessons, 1, "…and their own course's universe (same code 1-1, different level)");
    ok(
      certLeft.json.certificate.certificateId !== cert.json.certificate.certificateId,
      "the reference is per (student, course)"
    );

    // -----------------------------------------------------------------------
    section("7. leaderboard — identity by student id, activity scoped to the course, XP lifetime");
    asUser(mainUser);
    const board = await GET(R.leaderboard, "http://localhost/api/students/me/leaderboard");
    eq(board.status, 200, "leaderboard answers 200");
    eq(board.json.courseId, "c-cur", "the board names the caller's course");
    eq(
      board.json.leaderboard.map((e) => e.studentId).sort(),
      ["s-decoy", "s-main"],
      "the cohort is the course roster (the same-level other-course student is absent)"
    );
    eq(
      board.json.leaderboard.map((e) => e.name),
      ["Same Name", "Same Name"],
      "the fixture really does contain a same-name peer"
    );
    const lifetimeXpMainPre = gamification.computeXp(await gamification.buildStats("s-main"));
    const lifetimeXpDecoyPre = gamification.computeXp(await gamification.buildStats("s-decoy"));
    ok(
      lifetimeXpDecoyPre > lifetimeXpMainPre,
      `fixture precondition: the same-name peer outranks the caller on lifetime XP (${lifetimeXpDecoyPre} > ${lifetimeXpMainPre})`
    );
    eq(board.json.myStats.studentId, "s-main", "myStats identifies the caller by student id");
    eq(board.json.myStats.rank, 2, "the homonym with more XP keeps rank 1; my rank is my own");
    eq(board.json.myRank, 2, "…and myRank agrees");
    eq(board.json.leaderboard[0].studentId, "s-decoy", "rank 1 is the decoy, by id");

    const lifetimeXp = gamification.computeXp(await gamification.buildStats("s-main"));
    eq(board.json.myStats.xp, lifetimeXp, "XP is still academy-lifetime (includes the old course's rows)");
    eq(
      board.json.metricsScope,
      {
        xp: "ACADEMY_LIFETIME",
        level: "ACADEMY_LIFETIME",
        badgeCount: "ACADEMY_LIFETIME",
        streak: "ACADEMY_LIFETIME",
        lessonsCompleted: "CURRENT_COURSE",
        quizzesPassed: "CURRENT_COURSE",
      },
      "every metric declares its scope"
    );
    const mine = board.json.leaderboard.find((e) => e.studentId === "s-main");
    const theirs = board.json.leaderboard.find((e) => e.studentId === "s-decoy");
    eq(mine.lessonsCompleted, 2, "my activity counter counts the CURRENT course only (4 are completed lifetime)");
    eq(mine.quizzesPassed, 1, "my passed-quiz counter counts the current course's passed attempt only");
    eq(
      theirs.lessonsCompleted,
      3,
      "the Arabic peer's counter uses THEIR own track (l-cur + the two ARABIC lessons) — the caller's LANGUAGE universe would give 1"
    );
    eq(theirs.badgeCount, 1, "badges stay academy-lifetime");
    ok(mine.avatarUrl === null || mine.avatarUrl === undefined, "no avatar leak in the fixture");
    ok(!("email" in mine), "the board never projects an email");

    // -----------------------------------------------------------------------
    section("8. gamification — lifetime scope stays, and says so");
    const gam = await GET(R.gamification, "http://localhost/api/students/me/gamification");
    eq(gam.status, 200, "gamification answers 200");
    eq(gam.json.scope, "ACADEMY_LIFETIME", "the gamification payload declares its scope");

    // -----------------------------------------------------------------------
    section("9. authorization is unchanged on every touched route");
    asUser(null);
    for (const [name, handler, url] of [
      ["dashboard", R.dashboard, "http://localhost/api/students/me/dashboard"],
      ["current-course", R.currentCourse, "http://localhost/api/students/me/current-course"],
      ["enrollment", R.enrollment, "http://localhost/api/students/me/enrollment"],
      ["certificate", R.certificate, "http://localhost/api/students/me/certificate"],
      ["leaderboard", R.leaderboard, "http://localhost/api/students/me/leaderboard"],
      ["gamification", R.gamification, "http://localhost/api/students/me/gamification"],
    ]) {
      const res = await GET(handler, url);
      eq(res.status, 401, `${name}: anonymous is 401`);
    }
    asUser(USERS[4]);
    for (const [name, handler, url] of [
      ["dashboard", R.dashboard, "http://localhost/api/students/me/dashboard"],
      ["current-course", R.currentCourse, "http://localhost/api/students/me/current-course"],
      ["enrollment", R.enrollment, "http://localhost/api/students/me/enrollment"],
      ["certificate", R.certificate, "http://localhost/api/students/me/certificate"],
      ["leaderboard", R.leaderboard, "http://localhost/api/students/me/leaderboard"],
    ]) {
      const res = await GET(handler, url);
      eq(res.status, 403, `${name}: a teacher is 403`);
    }

    // -----------------------------------------------------------------------
    section("10. source pins — one universe definition, no client level, id-based identity");
    const universeSrc = read("src/lib/student-universe.ts");
    ok(
      /normalizeAcademicLevel\(student\.academicLevel\)/.test(universeSrc) &&
        /normalizeAcademicLevel\(group\?\.course\?\.academicLevel\)/.test(universeSrc),
      "the shared module reads BOTH authorities from their own columns"
    );
    ok(
      /courseId: group\?\.course\?\.id \?\? group\?\.courseId \?\? null/.test(universeSrc),
      "course identity is the Student.groupId → Group.courseId relation chain"
    );
    for (const rel of [
      "src/app/api/students/me/dashboard/route.ts",
      "src/app/api/students/me/current-course/route.ts",
      "src/app/api/students/me/enrollment/route.ts",
      "src/app/api/students/me/certificate/route.ts",
      "src/app/api/students/me/leaderboard/route.ts",
    ]) {
      ok(
        !/searchParams|nextUrl/.test(read(rel)),
        `${rel} reads no request parameters (no client level can be authority)`
      );
    }
    ok(
      /studentAttendanceUniverse\(courseId\)/.test(read("src/app/api/students/me/dashboard/route.ts")),
      "the dashboard scopes attendance through the shared course relation"
    );
    ok(
      /isMe = entry\.studentId === myStats\?\.studentId/.test(
        read("src/components/student/leaderboard-view.tsx")
      ),
      "the leaderboard UI highlights me by canonical student id"
    );
    ok(
      /student\.251/.test(read("src/components/student/gamification-panel.tsx")) &&
        /student\.252/.test(read("src/components/student/leaderboard-view.tsx")),
      "lifetime metrics carry their own scope label in both panels"
    );
    ok(
      !/groupCourseMatch/.test(read("src/app/api/students/me/dashboard/route.ts")),
      "the dead cross-course matcher is gone"
    );
  } catch (e) {
    fail++;
    failures.push(`unexpected: ${e && e.message}`);
    console.error("\nUNEXPECTED ERROR:", e);
  } finally {
    console.log("");
    if (fail === 0) {
      console.log(`Phase M4.1 student context & history scope: ${pass} passed, 0 failed`);
    } else {
      console.log(`Phase M4.1 student context & history scope: ${pass} passed, ${fail} failed`);
      for (const f of failures) console.log(`  - ${f}`);
    }
    process.exitCode = fail === 0 ? 0 : 1;
  }
})();
