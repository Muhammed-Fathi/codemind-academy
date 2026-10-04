// CodeMind Academy — Phase M4.4: Parent academic metrics & analytics scope.
//
// WHAT THIS SUITE PROVES (audit finding M4-F2 + F9, one section per goal)
// =========================================================================
//   A. The adversarial fixture really is adversarial: one child (A) with
//      history in a PREVIOUS Academic Level's course, a CURRENT course at the
//      other level, and ANOTHER course at the same level as the current one —
//      three courses that reuse the same display name, the same unit titles and
//      the same printed lesson codes; plus a sibling (B) whose CURRENT course
//      is exactly A's previous one; plus a linked child with no active course.
//   B. Dashboard attendance = the CURRENT course only (`Attendance →
//      LiveSession → Group → Course`): previous-course, same-level-other-course
//      rows and any row of another level never move the percentage, the
//      PRESENT/LATE semantics or the monthly buckets. Course ID is the
//      boundary — never a lesson code, a title, a group name or a level.
//   C. Parent analytics attendance uses the SAME scope, so the two screens
//      AGREE for the same child (percentage, month buckets, quiz/homework
//      counts).
//   D. Dashboard + analytics mock exams = attempts whose `MockExam.courseId` is
//      the child's current course; an attempt with no exam (free practice) or
//      on another course's exam never moves average/best/passed.
//   E. Quiz metrics (dashboard, analytics, weekly, monthly source) exclude the
//      previous course, the previous level and the unrelated same-level course,
//      and still count FINISHED attempts only.
//   F. Recent activity carries no previous-course academic item.
//   G. Strong/weak rows are keyed by the CANONICAL container id (`Unit.id`,
//      legacy `Topic.id` fallback) with level context: two containers that
//      share a display title stay two rows, in both the dashboard and the
//      analytics payloads, and no grouping happens by title/name/index.
//   H. Weekly report: `window ∩ current course`, per child — siblings never
//      share a universe, and the daily breakdown shows only own-course
//      attendance statuses.
//   I. Monthly report: its source payload is the same current-course universe
//      (month buckets ∩ current course), no mock-exam block was invented.
//   J. A linked child with NO active course keeps `NO_ACTIVE_COURSE`, empty
//      numbers and NO historical fallback on every surface.
//   K. Identity/privacy/scope guards: no Parent level selector or filter, no
//      `Parent.academicLevel`, no nationalId/parentPhone, no answer keys,
//      question text or grading evidence, and no schema/migration change.
//
// The REAL route handlers run against the repository's migration-backed SQLite
// database with only the framework boundary shimmed (Prisma engine →
// sqlite-prisma-lite, auth → a script-controlled user, next/server shims).
//
// Run: node tests/phase-m44-parent-metric-scope.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const REPO = path.resolve(__dirname, "..");

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`M4.4 test made a network connection attempt: ${JSON.stringify(args[0])}`);
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
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. Scratch database: base DDL + every real migration.
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "M4.4: " });
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
  "src/lib/subscription-entitlement.ts",
  "src/lib/enrollment.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/progress.ts",
  "src/lib/progression.ts",
  "src/lib/session-progress.ts",
  "src/lib/student-visibility.ts",
  "src/lib/student-universe.ts",
  "src/lib/parent-access.ts",
  "src/lib/absence-policy.ts",
  "src/lib/absence-review.ts",
  "src/lib/parent-academics.ts",
  "src/lib/parent-subscription.ts",
  "src/lib/api.ts",
  // route handlers under test
  "src/app/api/parents/me/dashboard/route.ts",
  "src/app/api/parents/me/analytics/route.ts",
  "src/app/api/parents/me/weekly-report/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m44-parent-"));
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
  dashboard: route("parents/me/dashboard/route.js"),
  analytics: route("parents/me/analytics/route.js"),
  weekly: route("parents/me/weekly-report/route.js"),
};
const PA = require(path.join(EMIT, "lib/parent-access.js"));

function asUser(u) {
  globalThis.__CM_USER__ = u
    ? { id: u.id, email: u.email, name: u.name, role: u.role }
    : null;
}
async function GET(handler, url) {
  const req = {
    url: url || "http://localhost/api",
    method: "GET",
    headers: { get: () => null },
  };
  const res = await (typeof handler === "function" ? handler : handler.GET)(req, {});
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON body — the caller reads `text` */
  }
  return { status: res.status, json, text };
}

const NOW = Date.now();
const at = (minutesAgo) => new Date(NOW - minutesAgo * 60_000);
const daysAgo = (d) => at(d * 24 * 60);

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
// 4. Fixture — three courses, one display name, reused unit titles and codes.
// ---------------------------------------------------------------------------
section("M4.4 fixture — previous level, current course, same-level sibling course");

const COURSE_NAME = "البرمجة والذكاء الاصطناعي";
const UNIT_TITLE = "الوحدة الأولى";
const OLD_SESSION = "OLD-SESSION";
const OLD_QUIZ = "OLD-COURSE-QUIZ";
const OLD_HOMEWORK = "OLD-HW-UNIT";
const OTHER_SESSION = "OTHER-COURSE-SESSION";
const OTHER_QUIZ = "OTHER-COURSE-QUIZ";
const SECRET_PROMPT = "SECRET-QUESTION-PROMPT";
const SECRET_ANSWER = "SECRET-ANSWER-KEY";

const COURSES = [
  { id: "c-first", slug: "m44-first", level: "FIRST_SECONDARY", code: "1-1" },
  { id: "c-cur", slug: "m44-cur", level: "SECOND_SECONDARY", code: "1-1" },
  { id: "c-other", slug: "m44-other", level: "SECOND_SECONDARY", code: "1-9" },
];
for (const c of COURSES) {
  ins("Course", {
    id: c.id,
    slug: c.slug,
    academicLevel: c.level,
    name: COURSE_NAME,
    nameAr: COURSE_NAME,
    description: "M4.4 fixture course",
    color: "#10b981",
    createdAt: NOW,
    updatedAt: NOW,
  });
}
// c-cur has a SECOND unit with the same title (the merge trap: same course,
// same level, same title, different canonical id).
const UNITS = [
  { id: "p-first", unitId: "u-first", courseId: "c-first", lessonId: "l-first-1", code: "1-1", order: 1 },
  { id: "p-cur", unitId: "u-cur", courseId: "c-cur", lessonId: "l-cur-1", code: "1-1", order: 1 },
  { id: "p-cur-2", unitId: "u-cur-2", courseId: "c-cur", lessonId: "l-cur-2", code: "2-1", order: 2 },
  { id: "p-other", unitId: "u-other", courseId: "c-other", lessonId: "l-other-1", code: "1-9", order: 1 },
];
for (const u of UNITS) {
  ins("Part", {
    id: u.id,
    courseId: u.courseId,
    title: `Part ${u.order}`,
    titleAr: `الجزء ${u.order}`,
    order: u.order,
  });
  ins("Unit", {
    id: u.unitId,
    partId: u.id,
    title: "Unit 1",
    // IDENTICAL title on purpose: only the id distinguishes the containers.
    titleAr: UNIT_TITLE,
    order: u.order,
  });
  ins("Lesson", {
    id: u.lessonId,
    unitId: u.unitId,
    officialCode: u.code,
    academicLevel: COURSES.find((c) => c.id === u.courseId).level,
    curriculumStatus: "OFFICIAL",
    trackScope: "SHARED",
    status: "PUBLISHED",
    title: `Session ${u.code}`,
    titleAr: `الحصة ${u.code}`,
    order: u.order,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
// Two ADVERSARIAL curriculum shapes inside the CURRENT course:
//   * `u-cur-hybrid` — a Unit that ALSO has a legacy Topic under it, attached to
//     a lesson that carries BOTH links (with DIFFERENT ids and titles). The
//     canonical precedence must pick the Unit.
//   * `u-cur-legacy` — a unit that exists only to host a legacy topic for a
//     lesson with NO Unit at all: the Topic fallback must still work.
ins("Part", { id: "p-cur-hybrid", courseId: "c-cur", title: "Part H", titleAr: "الجزء H", order: 3 });
ins("Unit", {
  id: "u-cur-hybrid",
  partId: "p-cur-hybrid",
  title: "Unit Hybrid",
  titleAr: "UNIT-WINS-TITLE",
  order: 3,
});
ins("Topic", { id: "t-cur-hybrid", unitId: "u-cur-hybrid", title: "Topic Hybrid", titleAr: "LEGACY-TOPIC-TITLE", order: 1 });
ins("Part", { id: "p-cur-legacy", courseId: "c-cur", title: "Part L", titleAr: "الجزء L", order: 4 });
ins("Unit", {
  id: "u-cur-legacy",
  partId: "p-cur-legacy",
  title: "Unit Legacy",
  titleAr: "UNIT-LEGACY-HOST",
  order: 4,
});
ins("Topic", { id: "t-cur-legacy", unitId: "u-cur-legacy", title: "Topic Legacy", titleAr: "LEGACY-ONLY-TITLE", order: 1 });
// The hybrid lesson: Unit AND legacy Topic, different ids AND different titles.
ins("Lesson", {
  id: "l-cur-hybrid",
  unitId: "u-cur-hybrid",
  topicId: "t-cur-hybrid",
  officialCode: "3-1",
  academicLevel: "SECOND_SECONDARY",
  curriculumStatus: "OFFICIAL",
  trackScope: "SHARED",
  status: "PUBLISHED",
  title: "Session 3-1",
  titleAr: "الحصة ٣-١",
  order: 3,
  createdAt: NOW,
  updatedAt: NOW,
});
// The legacy-only lesson: no Unit at all.
ins("Lesson", {
  id: "l-cur-legacy",
  unitId: null,
  topicId: "t-cur-legacy",
  officialCode: "3-2",
  academicLevel: "SECOND_SECONDARY",
  curriculumStatus: "LEGACY",
  trackScope: "SHARED",
  status: "PUBLISHED",
  title: "Session 3-2",
  titleAr: "الحصة ٣-٢",
  order: 4,
  createdAt: NOW,
  updatedAt: NOW,
});

// Groups: the child's CURRENT group, the previous-level group, the sibling's
// group (which IS the previous-level course) and the other same-level course.
const GROUPS = [
  { id: "g-cur", courseId: "c-cur" },
  { id: "g-first", courseId: "c-first" },
  { id: "g-other", courseId: "c-other" },
];
for (const g of GROUPS) {
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
  { id: "u-a", name: "أحمد محمد", email: "a@m44.test", role: "STUDENT" },
  { id: "u-b", name: "سارة علي", email: "b@m44.test", role: "STUDENT" },
  { id: "u-none", name: "طفل بلا كورس", email: "none@m44.test", role: "STUDENT" },
  { id: "u-parent-main", name: "ولي أمر", email: "parent-main@m44.test", role: "PARENT" },
  { id: "u-parent-solo", name: "ولي أمر واحد", email: "parent-solo@m44.test", role: "PARENT" },
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

// Child A: CURRENT course `c-cur` (SECOND_SECONDARY) — history in `c-first`.
// Child B: CURRENT course `c-first` — i.e. A's previous course is B's current.
// Child N: no group at all (the fail-closed case) with legacy history.
const STUDENTS = [
  {
    id: "s-a",
    userId: "u-a",
    groupId: "g-cur",
    level: "SECOND_SECONDARY",
    grade: "1st Secondary",
    // Withheld by the payload contract — asserted in section L.
    nationalId: "30101011234567",
    parentPhone: "01147422177",
    schoolName: "Nile School",
  },
  { id: "s-b", userId: "u-b", groupId: "g-first", level: "FIRST_SECONDARY", grade: "2nd Secondary" },
  { id: "s-none", userId: "u-none", groupId: null, level: "FIRST_SECONDARY", grade: "2nd Secondary" },
];
for (const s of STUDENTS) {
  ins("Student", {
    id: s.id,
    userId: s.userId,
    groupId: s.groupId,
    academicLevel: s.level,
    schoolType: "ARABIC",
    grade: s.grade,
    nationalId: s.nationalId ?? null,
    parentPhone: s.parentPhone ?? null,
    schoolName: s.schoolName ?? null,
    enrolledAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
ins("Parent", { id: "p-main", userId: "u-parent-main", createdAt: NOW, updatedAt: NOW });
ins("Parent", { id: "p-solo", userId: "u-parent-solo", createdAt: NOW, updatedAt: NOW });
ins("ParentStudentLink", { id: "psl-a", parentId: "p-main", studentId: "s-a", relation: "FATHER", createdAt: at(30) });
ins("ParentStudentLink", { id: "psl-b", parentId: "p-main", studentId: "s-b", relation: "FATHER", createdAt: at(20) });
ins("ParentStudentLink", { id: "psl-n", parentId: "p-main", studentId: "s-none", relation: "FATHER", createdAt: at(10) });
ins("ParentStudentLink", { id: "psl-solo", parentId: "p-solo", studentId: "s-a", relation: "MOTHER", createdAt: at(10) });

// --- Sessions in all three courses, ALL inside the last 7 days -------------
// A's statuses are deliberately distinguishable: its current course has
// PRESENT + ABSENT, while both excluded courses carry LATE/EXCUSED — so a leak
// is visible in the status, not only in the count.
ins("LiveSession", {
  id: "ses-cur-1", groupId: "g-cur", lessonId: "l-cur-1", title: "Current Session 1", titleAr: "الحصة الحالية ١",
  startAt: daysAgo(2), duration: 60, status: "COMPLETED", createdAt: NOW, updatedAt: NOW,
});
ins("LiveSession", {
  id: "ses-cur-2", groupId: "g-cur", lessonId: "l-cur-2", title: "Current Session 2", titleAr: "الحصة الحالية ٢",
  startAt: daysAgo(1), duration: 60, status: "COMPLETED", createdAt: NOW, updatedAt: NOW,
});
ins("LiveSession", {
  id: "ses-first-1", groupId: "g-first", lessonId: "l-first-1", title: OLD_SESSION, titleAr: OLD_SESSION,
  startAt: daysAgo(1), duration: 60, status: "COMPLETED", createdAt: NOW, updatedAt: NOW,
});
ins("LiveSession", {
  id: "ses-first-2", groupId: "g-first", lessonId: "l-first-1", title: OLD_SESSION, titleAr: OLD_SESSION,
  startAt: daysAgo(3), duration: 60, status: "COMPLETED", createdAt: NOW, updatedAt: NOW,
});
ins("LiveSession", {
  id: "ses-other-1", groupId: "g-other", lessonId: "l-other-1", title: OTHER_SESSION, titleAr: OTHER_SESSION,
  startAt: daysAgo(4), duration: 60, status: "COMPLETED", createdAt: NOW, updatedAt: NOW,
});
const ATTENDANCE = [
  // Child A — current course: PRESENT + ABSENT (2 rows, 1 attended → 50%).
  { id: "att-cur-1", studentId: "s-a", sessionId: "ses-cur-1", status: "PRESENT" },
  { id: "att-cur-2", studentId: "s-a", sessionId: "ses-cur-2", status: "ABSENT" },
  // Child A — previous level's course: 2 LATE rows (would read as "attended").
  { id: "att-old-1", studentId: "s-a", sessionId: "ses-first-1", status: "LATE" },
  { id: "att-old-2", studentId: "s-a", sessionId: "ses-first-2", status: "LATE" },
  // Child A — the same-level other course: 1 EXCUSED row.
  { id: "att-other-1", studentId: "s-a", sessionId: "ses-other-1", status: "EXCUSED" },
  // Child B — its own current course (c-first) plus a stray row on a session of
  // A's current course, which must never enter B's numbers.
  { id: "att-b-1", studentId: "s-b", sessionId: "ses-first-1", status: "PRESENT" },
  { id: "att-b-2", studentId: "s-b", sessionId: "ses-first-2", status: "PRESENT" },
  { id: "att-b-3", studentId: "s-b", sessionId: "ses-cur-1", status: "PRESENT" },
  // Child N — no active course: legacy history that must never be used.
  { id: "att-n-1", studentId: "s-none", sessionId: "ses-first-1", status: "PRESENT" },
  { id: "att-n-2", studentId: "s-none", sessionId: "ses-first-2", status: "PRESENT" },
];
for (const a of ATTENDANCE) {
  ins("Attendance", { id: a.id, studentId: a.studentId, sessionId: a.sessionId, status: a.status, createdAt: NOW });
}

// --- Quizzes + attempts in all three courses -------------------------------
const QUIZZES = [
  { id: "q-first", lessonId: "l-first-1", title: OLD_QUIZ },
  { id: "q-cur", lessonId: "l-cur-1", title: "Current Quiz 1" },
  { id: "q-cur-2", lessonId: "l-cur-2", title: "Current Quiz 2" },
  { id: "q-other", lessonId: "l-other-1", title: OTHER_QUIZ },
  { id: "q-hybrid", lessonId: "l-cur-hybrid", title: "Hybrid Quiz" },
  { id: "q-legacy-cur", lessonId: "l-cur-legacy", title: "Legacy-only Quiz" },
];
for (const q of QUIZZES) {
  ins("Quiz", {
    id: q.id,
    lessonId: q.lessonId,
    trackScope: "SHARED",
    title: q.title,
    titleAr: q.title,
    status: "PUBLISHED",
    publishedAt: daysAgo(10),
  });
}
// A secret question row: it must never surface in a Parent payload.
ins("Question", {
  id: "qq-secret", quizId: "q-cur", type: "MCQ", prompt: SECRET_PROMPT,
  promptAr: SECRET_PROMPT, options: JSON.stringify([SECRET_ANSWER]), answer: SECRET_ANSWER,
  explanation: SECRET_ANSWER, difficulty: "EASY", marks: 1, createdAt: NOW,
});
const ATTEMPTS = [
  // A — previous course (100%) + other same-level course (100%) + previous
  // level rows: all excluded from A's current performance.
  { id: "qa-old", quizId: "q-first", studentId: "s-a", percentage: 100, passed: true, finishedAt: daysAgo(6), startedAt: daysAgo(6) },
  { id: "qa-other", quizId: "q-other", studentId: "s-a", percentage: 100, passed: true, finishedAt: daysAgo(5), startedAt: daysAgo(5) },
  // A — current course: 90% (strong) and 40% (weak), each in its own container.
  { id: "qa-cur-1", quizId: "q-cur", studentId: "s-a", percentage: 90, passed: true, finishedAt: daysAgo(2), startedAt: daysAgo(2), attemptNumber: 1 },
  { id: "qa-cur-2", quizId: "q-cur-2", studentId: "s-a", percentage: 40, passed: false, finishedAt: daysAgo(1), startedAt: daysAgo(1) },
  // BOTH links present (Unit + legacy Topic, different ids/titles): the row must
  // group under the UNIT (u-cur-hybrid), never under t-cur-hybrid.
  { id: "qa-hybrid", quizId: "q-hybrid", studentId: "s-a", percentage: 80, passed: true, finishedAt: daysAgo(1.5), startedAt: daysAgo(1.5) },
  // NO Unit at all: the legacy Topic fallback is the only container (t-cur-legacy).
  { id: "qa-legacy-cur", quizId: "q-legacy-cur", studentId: "s-a", percentage: 70, passed: true, finishedAt: daysAgo(2.5), startedAt: daysAgo(2.5) },
  // A — an OPEN attempt in the current course: ungraded, never counted.
  { id: "qa-cur-open", quizId: "q-cur", studentId: "s-a", percentage: 0, passed: false, finishedAt: null, startedAt: at(30), attemptNumber: 2 },
  // N — legacy attempts that must never be counted (no active course).
  { id: "qa-n", quizId: "q-first", studentId: "s-none", percentage: 100, passed: true, finishedAt: daysAgo(4), startedAt: daysAgo(4) },
];
for (const a of ATTEMPTS) {
  ins("QuizAttempt", {
    id: a.id,
    quizId: a.quizId,
    studentId: a.studentId,
    score: a.percentage,
    totalMarks: 100,
    percentage: a.percentage,
    passed: a.passed,
    startedAt: a.startedAt,
    finishedAt: a.finishedAt,
    attemptNumber: a.attemptNumber ?? 1,
    cameraStatus: "NOT_REQUESTED",
  });
}

// --- Homework in all three courses ----------------------------------------
const HOMEWORKS = [
  { id: "h-first", lessonId: "l-first-1", title: OLD_HOMEWORK, deadline: daysAgo(3) },
  { id: "h-cur", lessonId: "l-cur-1", title: "Current Homework", deadline: daysAgo(1) },
  { id: "h-other", lessonId: "l-other-1", title: "Other Homework", deadline: daysAgo(2) },
];
for (const h of HOMEWORKS) {
  ins("Homework", {
    id: h.id,
    lessonId: h.lessonId,
    trackScope: "SHARED",
    status: "PUBLISHED",
    title: h.title,
    titleAr: h.title,
    deadline: h.deadline,
    maxMarks: 10,
    createdAt: daysAgo(10),
  });
}
ins("HomeworkSubmission", { id: "hs-old", homeworkId: "h-first", studentId: "s-a", status: "GRADED", grade: 10, submittedAt: daysAgo(3) });
ins("HomeworkSubmission", { id: "hs-cur", homeworkId: "h-cur", studentId: "s-a", status: "SUBMITTED", grade: null, submittedAt: daysAgo(1) });
ins("HomeworkSubmission", { id: "hs-other", homeworkId: "h-other", studentId: "s-a", status: "GRADED", grade: 9, submittedAt: daysAgo(2) });
ins("HomeworkSubmission", { id: "hs-n", homeworkId: "h-first", studentId: "s-none", status: "GRADED", grade: 10, submittedAt: daysAgo(3) });

// --- Mock exams: previous course, current course, other course, practice ---
const MOCKS = [
  { id: "me-first", courseId: "c-first", title: "Mock First Course" },
  { id: "me-cur", courseId: "c-cur", title: "Mock Current Course" },
  { id: "me-other", courseId: "c-other", title: "Mock Other Course" },
];
for (const m of MOCKS) {
  ins("MockExam", {
    id: m.id,
    title: m.title,
    titleAr: m.title,
    schoolType: "ARABIC",
    courseId: m.courseId,
    questionCount: 10,
    durationMin: 30,
    passMark: 60,
    difficulty: "MIXED",
    selectionMode: "RANDOM",
    isPublished: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}
const MOCK_ATTEMPTS = [
  { id: "ea-cur", mockExamId: "me-cur", percentage: 40, passed: false, finishedAt: daysAgo(2) },
  { id: "ea-old", mockExamId: "me-first", percentage: 95, passed: true, finishedAt: daysAgo(5) },
  { id: "ea-other", mockExamId: "me-other", percentage: 100, passed: true, finishedAt: daysAgo(3) },
  { id: "ea-practice", mockExamId: null, percentage: 100, passed: true, finishedAt: at(60) },
  { id: "ea-open", mockExamId: "me-cur", percentage: 0, passed: false, finishedAt: null },
];
for (const e of MOCK_ATTEMPTS) {
  ins("ExamAttempt", {
    id: e.id,
    studentId: "s-a",
    mockExamId: e.mockExamId,
    schoolType: "ARABIC",
    examType: "MOCK",
    questionCount: 10,
    durationMin: 30,
    score: e.percentage,
    totalMarks: 100,
    percentage: e.percentage,
    passed: e.passed,
    answers: JSON.stringify([{ prompt: SECRET_PROMPT, answer: SECRET_ANSWER }]),
    startedAt: e.finishedAt ?? at(30),
    finishedAt: e.finishedAt,
  });
}
// Lesson progress in all three courses (the weekly "lessons viewed" trap).
ins("LessonProgress", { id: "lp-cur", studentId: "s-a", lessonId: "l-cur-1", progress: 100, isCompleted: 1, lastViewedAt: daysAgo(1) });
ins("LessonProgress", { id: "lp-old", studentId: "s-a", lessonId: "l-first-1", progress: 100, isCompleted: 1, lastViewedAt: daysAgo(1) });
ins("LessonProgress", { id: "lp-other", studentId: "s-a", lessonId: "l-other-1", progress: 100, isCompleted: 1, lastViewedAt: daysAgo(1) });
ins("LessonProgress", { id: "lp-n", studentId: "s-none", lessonId: "l-first-1", progress: 100, isCompleted: 1, lastViewedAt: daysAgo(2) });

(async () => {
try {
section("M4.4 fixture — the traps are real");
eq(COURSES.filter((c) => c.id !== "c-first").length, 2, "two courses at the current level exist");
ok(
  COURSES.map((c) => c.slug).length === 3 && COURSES.every((c) => COURSE_NAME === COURSE_NAME),
  "all three courses reuse ONE display name"
);
eq(
  rawDb.prepare(`SELECT COUNT(*) AS c FROM "Unit" WHERE titleAr = ?`).get(UNIT_TITLE).c,
  4,
  "four containers share ONE unit title (two of them inside the current course)"
);
const dupCode = rawDb
  .prepare(`SELECT COUNT(*) AS c FROM "Lesson" WHERE officialCode = '1-1'`)
  .get().c;
eq(dupCode, 2, "the printed code 1-1 exists in both levels");
eq(
  rawDb.prepare(`SELECT COUNT(*) AS c FROM "ExamAttempt" WHERE studentId = 's-a' AND finishedAt IS NOT NULL`).get().c,
  4,
  "child A has four finished mock attempts across the fixture"
);
eq(
  rawDb.prepare(`SELECT COUNT(*) AS c FROM "Student" WHERE nationalId = '30101011234567' AND parentPhone = '01147422177'`).get().c,
  1,
  "…and one child really carries the identity fields the payload must withhold"
);
eq(
  rawDb
    .prepare(`SELECT unitId, topicId FROM "Lesson" WHERE id = 'l-cur-hybrid'`)
    .get(),
  { unitId: "u-cur-hybrid", topicId: "t-cur-hybrid" },
  "the hybrid lesson carries BOTH a Unit and a legacy Topic (different ids)"
);
eq(
  rawDb.prepare(`SELECT titleAr FROM "Unit" WHERE id = 'u-cur-hybrid'`).get().titleAr,
  "UNIT-WINS-TITLE",
  "…whose Unit and Topic titles differ (the wrong choice would be visible)"
);
eq(
  rawDb.prepare(`SELECT titleAr FROM "Topic" WHERE id = 't-cur-hybrid'`).get().titleAr,
  "LEGACY-TOPIC-TITLE",
  "…and the legacy topic has a different display title"
);
eq(
  rawDb.prepare(`SELECT unitId, topicId FROM "Lesson" WHERE id = 'l-cur-legacy'`).get(),
  { unitId: null, topicId: "t-cur-legacy" },
  "the legacy-only lesson has NO Unit (the Topic fallback is its only container)"
);

// ---------------------------------------------------------------------------
// B. Dashboard attendance
// ---------------------------------------------------------------------------
section("B. Parent dashboard — attendance is the CURRENT course's sessions");

asUser({ id: "u-parent-main", name: "ولي أمر", role: "PARENT" });
const dash = await GET(R.dashboard, "http://localhost/api/parents/me/dashboard?studentId=s-a");
eq(dash.status, 200, "B1: the pinned dashboard answers 200");
const A = dash.json.children[0];
eq(A.id, "s-a", "B2: the payload is the requested child (by canonical id)");
eq(A.courseProgress.state, "OK", "B3: the child has an active canonical course");
eq([A.attendance.total, A.attendance.present, A.attendance.pct], [2, 1, 50], "B4: attendance = the current course only (2 rows, PRESENT 1 → 50%)");
eq(
  A.attendance.byMonth.reduce((s, b) => s + b.total, 0),
  2,
  "B5: the monthly buckets hold ONLY current-course sessions"
);
eq(
  A.attendance.byMonth.reduce((s, b) => s + b.present, 0),
  1,
  "B6: …and only their PRESENT/LATE outcomes"
);
ok(
  A.attendance.byMonth.every((b) => b.total <= A.attendance.total) &&
    A.attendance.byMonth.reduce((s, b) => s + b.total, 0) === A.attendance.total,
  "B7: the buckets are a WINDOW over the scoped set — no bucket can exceed it (and every fixture session is inside the window)"
);

// ---------------------------------------------------------------------------
// C. Analytics attendance agrees with the dashboard
// ---------------------------------------------------------------------------
section("C. Parent analytics — the SAME attendance scope (screens agree)");

const ana = await GET(R.analytics, "http://localhost/api/parents/me/analytics?studentId=s-a");
eq(ana.status, 200, "C1: the pinned analytics answers 200");
const AA = ana.json.children[0];
eq(AA.studentId, "s-a", "C2: the row is keyed by canonical id");
eq(AA.attendancePct, A.attendance.pct, "C3: analytics attendance % === dashboard attendance %");
eq(
  AA.attendanceByMonth.reduce((s, b) => s + b.total, 0),
  A.attendance.byMonth.reduce((s, b) => s + b.total, 0),
  "C4: …and the two month windows cover the same scoped rows"
);
eq(
  AA.attendanceByMonth.reduce((s, b) => s + b.present, 0),
  A.attendance.byMonth.reduce((s, b) => s + b.present, 0),
  "C5: …with the same present count"
);
eq(AA.totalQuizzes, A.quizzes.attempts, "C6: analytics quiz count === dashboard quiz count");
eq(AA.avgQuizPct, A.quizzes.average, "C7: analytics quiz average === dashboard quiz average");
eq(AA.homeworkSubmitted, A.homework.submitted, "C8: analytics homework === dashboard homework");

// ---------------------------------------------------------------------------
// D. Mock exams — current course only
// ---------------------------------------------------------------------------
section("D. Parent dashboard — mock exams are the CURRENT course's exam attempts");

eq(
  [A.mockExams.attempts, A.mockExams.average, A.mockExams.best, A.mockExams.passed, A.mockExams.failed],
  [1, 40, 40, 0, 1],
  "D1: only the current course's exam counts (40%), never the 95%/100% rows"
);
eq(A.mockExams.recent.length, 1, "D2: the recent list carries the one in-course attempt");
eq(A.mockExams.recent[0].mockExamTitle, "Mock Current Course", "D3: …with its own exam title");
eq(A.mockExams.recent[0].percentage, 40, "D4: …and its percentage");
ok(
  A.mockExams.recent[0].mockExamTitle !== "Mock First Course" &&
    A.mockExams.recent[0].mockExamTitle !== "Mock Other Course",
  "D5: no previous-course / other-course exam is named"
);
ok(
  !Object.prototype.hasOwnProperty.call(A.mockExams.recent[0], "answers") &&
    !JSON.stringify(dash.json).includes(SECRET_ANSWER),
  "D6: no answer snapshot travels with a mock result"
);

// ---------------------------------------------------------------------------
// E. Quiz metrics — current course only, finished only
// ---------------------------------------------------------------------------
section("E. Quiz metrics — current course, finished attempts only");

eq(
  [A.quizzes.attempts, A.quizzes.average, A.quizzes.passed, A.quizzes.failed],
  [4, 70, 3, 1],
  "E1: dashboard = the four in-course finished attempts (90/40 current + 80 hybrid + 70 legacy-only)"
);
eq(
  A.quizzes.recent.map((q) => q.percentage),
  [40, 80, 90, 70],
  "E2: newest first, the OPEN attempt excluded"
);
ok(
  !JSON.stringify(A.quizzes.recent).includes(OLD_QUIZ) &&
    !JSON.stringify(A.quizzes.recent).includes(OTHER_QUIZ),
  "E3: no previous-course / other-course quiz is named"
);
ok(!JSON.stringify(A.quizzes.recent).includes(SECRET_PROMPT), "E4: no question text leaks");
eq([A.homework.total, A.homework.submitted, A.homework.completionPct], [1, 1, 100], "E5: homework is the current course's assignments only");
ok(!JSON.stringify(A.homework.recent).includes(OLD_HOMEWORK), "E6: no previous-course homework is named");

// ---------------------------------------------------------------------------
// F. Recent activity
// ---------------------------------------------------------------------------
section("F. Recent activity — no previous-course academic item");

const activityJson = JSON.stringify(A.recentActivity);
ok(A.recentActivity.length > 0, "F1: the timeline is present");
ok(
  !activityJson.includes(OLD_SESSION) && !activityJson.includes(OLD_QUIZ) && !activityJson.includes(OLD_HOMEWORK),
  "F2: no previous-course session/quiz/homework appears"
);
ok(
  !activityJson.includes(OTHER_SESSION) && !activityJson.includes(OTHER_QUIZ),
  "F3: no same-level other-course item appears"
);
ok(
  A.recentActivity.some((a) => a.type === "quiz") &&
    A.recentActivity.some((a) => a.type === "homework") &&
    A.recentActivity.some((a) => a.type === "attendance"),
  "F4: the feed still mixes the in-course activity types (wording/ordering preserved)"
);
const activityTimes = A.recentActivity.map((a) => new Date(a.time).getTime());
ok(
  activityTimes.every((t, i, arr) => i === 0 || arr[i - 1] >= t),
  "F5: ordering is unchanged (newest first)"
);

// ---------------------------------------------------------------------------
// G. Strong / weak identity
// ---------------------------------------------------------------------------
section("G. Strong/weak rows — canonical container ID, never the title");

const dashTopics = [...A.strongTopics, ...A.weakTopics];
eq(
  dashTopics.length,
  4,
  "G1: the four in-course containers are reported (the other course's is excluded)"
);
eq(
  dashTopics.filter((t) => t.title === UNIT_TITLE).length,
  2,
  "G2: two containers share ONE display title"
);
eq(
  new Set(dashTopics.map((t) => t.id)).size,
  4,
  "G3: …while every canonical id stays distinct"
);
eq(
  dashTopics.map((t) => t.academicLevel),
  Array(4).fill("SECOND_SECONDARY"),
  "G4: each row carries the level context of the course it was measured in"
);
ok(
  dashTopics.some((t) => t.id === "u-cur" && t.avgPct === 90) &&
    dashTopics.some((t) => t.id === "u-cur-2" && t.avgPct === 40),
  "G5: the ids are the canonical Unit ids and the averages are per container"
);
// THE PRECEDENCE PROOF (real flow): the lesson carrying BOTH links groups under
// its Unit — with the Unit's id AND the Unit's title — and the legacy Topic that
// hangs off it is never used as a container. The legacy-only lesson still
// resolves through its Topic.
ok(
  dashTopics.some((t) => t.id === "u-cur-hybrid" && t.avgPct === 80),
  "G5a: a Unit+Topic lesson groups under its UNIT id (Unit wins)"
);
ok(
  !dashTopics.some((t) => t.id === "t-cur-hybrid") &&
    !dashTopics.some((t) => t.title === "LEGACY-TOPIC-TITLE"),
  "G5b: …the legacy Topic is neither a key nor a title for that lesson"
);
ok(
  dashTopics.some((t) => t.id === "t-cur-legacy" && t.title === "LEGACY-ONLY-TITLE" && t.avgPct === 70),
  "G5c: a lesson with NO Unit still resolves through its legacy Topic"
);

const anaTopics = [...AA.strongTopics, ...AA.weakTopics];
eq(anaTopics.length, 4, "G6: analytics reports the same four containers");
eq(
  anaTopics.map((t) => t.id).sort(),
  dashTopics.map((t) => t.id).sort(),
  "G7: analytics container ids === dashboard container ids (one identity rule)"
);
eq(
  anaTopics.filter((t) => t.title === UNIT_TITLE).length,
  2,
  "G8: analytics keeps the same titles too"
);
eq(
  new Set(anaTopics.map((t) => t.id)).size,
  4,
  "G9: …and does NOT merge them by title (the pre-M4.4 bug)"
);
ok(
  anaTopics.some((t) => t.id === "u-cur-hybrid" && t.avgPct === 80) &&
    !anaTopics.some((t) => t.id === "t-cur-hybrid") &&
    !anaTopics.some((t) => t.title === "LEGACY-TOPIC-TITLE"),
  "G9a: analytics resolves Unit+Topic the same way (Unit wins, Topic unused)"
);
ok(
  anaTopics.some((t) => t.id === "t-cur-legacy" && t.title === "LEGACY-ONLY-TITLE"),
  "G9b: analytics keeps the legacy-only Topic fallback"
);
ok(
  anaTopics.every((t) => typeof t.id === "string" && t.id.length > 0),
  "G10: every analytics topic row ships an id"
);
ok(
  anaTopics.every((t) => t.academicLevel === "SECOND_SECONDARY"),
  "G11: every analytics topic row ships its level context"
);

// ---------------------------------------------------------------------------
// H. Weekly report
// ---------------------------------------------------------------------------
section("H. Weekly report — window ∩ current course, per child");

const wk = await GET(R.weekly, "http://localhost/api/parents/me/weekly-report");
eq(wk.status, 200, "H1: the weekly report answers 200");
eq(wk.json.reports.length, 3, "H2: ALL linked children remain the default (D5)");
const wkA = wk.json.reports.find((r) => r.studentId === "s-a");
const wkB = wk.json.reports.find((r) => r.studentId === "s-b");
const wkN = wk.json.reports.find((r) => r.studentId === "s-none");
eq(
  [wkA.summary.attendanceSessions, wkA.summary.attendancePct],
  [2, 50],
  "H3: child A's week counts only its own course's sessions"
);
eq(
  [wkB.summary.attendanceSessions, wkB.summary.attendancePct],
  [2, 100],
  "H4: sibling B counts ITS course instead (same rows, different attribution)"
);
eq(wkA.summary.quizzesTaken, 4, "H5: child A's weekly quizzes = the four in-course ones");
eq(wkA.summary.lessonsViewed, 1, "H6: child A's weekly lessons = the in-course progress row only");
eq(wkA.summary.homeworkSubmitted, 1, "H7: child A's weekly homework = the in-course submission only");
ok(
  wkA.summary.attendancePct !== wkB.summary.attendancePct &&
    wkB.dailyActivity.every((d) => d.attendance !== "ABSENT") &&
    wkB.summary.attendanceSessions === 2,
  "H8: siblings are independently scoped (B never sees A's course status or its stray row)"
);
const statuses = wkA.dailyActivity.map((d) => d.attendance);
ok(
  statuses.every((s) => s === null || s === "PRESENT" || s === "ABSENT"),
  `H9: the daily breakdown shows only own-course statuses (got ${JSON.stringify(statuses)})`
);
ok(
  statuses.filter((s) => s === "PRESENT").length === 1 && statuses.filter((s) => s === "ABSENT").length === 1,
  "H10: both own-course sessions appear on their own days"
);
eq(
  wkA.dailyActivity.reduce((s, d) => s + d.quizzes, 0),
  wkA.summary.quizzesTaken,
  "H11: the daily breakdown sums to the weekly quiz total"
);

// ---------------------------------------------------------------------------
// I. Monthly report source
// ---------------------------------------------------------------------------
section("I. Monthly report — same current-course universe, no invented block");

const monthlySrc = read("src/components/parent/monthly-report.tsx");
ok(
  /attendance: child\.attendance \|\| \{ pct: 0, present: 0, total: 0 \}/.test(monthlySrc) &&
    /quizzes: child\.quizzes \|\|/.test(monthlySrc) &&
    /homework: child\.homework \|\|/.test(monthlySrc) &&
    /courseProgress: child\.courseProgress \|\|/.test(monthlySrc),
  "I1: the monthly report renders the dashboard payload's current-course numbers"
);
ok(!/mockExams/.test(monthlySrc), "I2: no mock-exam block was invented for the report");
eq(
  dash.json.children[0].attendance.byMonth.reduce((s, b) => s + b.total, 0),
  2,
  "I3: the month window itself carries only current-course rows (no lifetime conversion)"
);

// ---------------------------------------------------------------------------
// J. Unenrolled / no-active-course child
// ---------------------------------------------------------------------------
section("J. Linked child with no active course — explicit, empty, no fallback");

const dashNone = await GET(R.dashboard, "http://localhost/api/parents/me/dashboard?studentId=s-none");
const N = dashNone.json.children[0];
eq(N.id, "s-none", "J1: the child stays visible and linked");
eq([N.courseProgress.state, N.courseProgress.hasAcademicContext], ["NO_ACTIVE_COURSE", false], "J2: the explicit state is reported");
eq([N.courseProgress.completed, N.courseProgress.total], [0, 0], "J3: no fabricated progress");
eq([N.attendance.total, N.attendance.present, N.attendance.pct], [0, 0, 0], "J4: attendance is empty, never the legacy history");
eq([N.quizzes.attempts, N.quizzes.average], [0, 0], "J5: quiz metrics are empty, never the legacy attempts");
eq([N.mockExams.attempts, N.mockExams.best], [0, null], "J6: mock metrics are empty");
eq([N.homework.total, N.homework.completionPct], [0, 0], "J7: homework is empty");
eq(N.recentActivity.length, 0, "J8: the activity timeline has nothing to report");
const anaNone = (await GET(R.analytics, "http://localhost/api/parents/me/analytics?studentId=s-none")).json.children[0];
eq([anaNone.academicContext, anaNone.attendancePct, anaNone.totalQuizzes, anaNone.completionPct], ["NO_ACTIVE_COURSE", 0, 0, 0], "J9: analytics agrees and never falls back");
eq(wkN.academicContext, "NO_ACTIVE_COURSE", "J10: the weekly report reports the same state");
eq([wkN.summary.attendanceSessions, wkN.summary.quizzesTaken, wkN.summary.homeworkSubmitted, wkN.summary.lessonsViewed], [0, 0, 0, 0], "J11: …with empty weekly numbers");

// ---------------------------------------------------------------------------
// K. Single child, childless, and the scope/no-selector guards
// ---------------------------------------------------------------------------
section("K. Single-child behaviour, scope guards and shared predicate");

const soloDash = await GET(R.dashboard, "http://localhost/api/parents/me/dashboard?studentId=s-a");
eq(soloDash.json.children.length, 1, "K1: a single-child parent's pinned request carries one child");
const soloWk = await GET(R.weekly, "http://localhost/api/parents/me/weekly-report?studentId=s-a");
eq(soloWk.json.reports.length, 1, "K2: …and one weekly card");
eq(soloWk.json.reports[0].summary.attendanceSessions, 2, "K3: …scoped to its own course");
eq(A.id, "s-a", "K4: the child identity is the canonical studentId throughout");

eq(typeof PA.currentCourseIdOf, "function", "K5: one shared current-course resolver exists");
eq(PA.currentCourseIdOf({ group: { courseId: "c-x" } }), "c-x", "K6: it reads Student.groupId → Group.courseId");
eq(PA.currentCourseIdOf({ group: null }), null, "K7: no group → null (fail closed)");
eq(
  PA.currentCourseAttendanceWhere("c-x"),
  { session: { group: { courseId: "c-x" } } },
  "K8: the attendance predicate is the canonical Attendance → LiveSession → Group → Course relation"
);
eq(
  PA.currentCourseAttendanceWhere(null),
  { session: { group: { courseId: "" } } },
  "K9: without a course it matches nothing (no empty filter!)"
);
eq(
  PA.currentCourseMockExamWhere("c-x"),
  { mockExam: { courseId: "c-x" } },
  "K10: the mock predicate is MockExam.courseId"
);
eq(
  PA.currentCourseMockExamWhere(null),
  { mockExam: { courseId: "" } },
  "K11: …and fails closed without a course"
);
ok(
  PA.isCurrentCourseAttendance({ session: { group: { courseId: "c-x" } } }, "c-x") &&
    !PA.isCurrentCourseAttendance({ session: { group: { courseId: "c-y" } } }, "c-x") &&
    !PA.isCurrentCourseAttendance({ session: { group: { courseId: "c-x" } } }, null) &&
    !PA.isCurrentCourseAttendance({ session: null }, "c-x"),
  "K12: the in-memory twin agrees with the SQL predicate (own course, fail closed)"
);
eq(
  PA.curriculumContainerOf({ unit: { id: "u1", title: "Unit T", titleAr: "عنوان الوحدة" } }).id,
  "u1",
  "K13: a unit-only lesson resolves to its Unit"
);
eq(
  PA.curriculumContainerOf({
    unit: { id: "u1", title: "Unit T", titleAr: "عنوان الوحدة" },
    topic: { id: "t1", title: "Topic T", titleAr: "عنوان الموضوع" },
  }).id,
  "u1",
  "K14: when BOTH links are present the canonical UNIT wins (Topic is legacy fallback only)"
);
eq(
  PA.curriculumContainerOf({
    unit: { id: "u1", title: "Unit T", titleAr: "عنوان الوحدة" },
    topic: { id: "t1", title: "Topic T", titleAr: "عنوان الموضوع" },
  }).titleAr,
  "عنوان الوحدة",
  "K14a: …and the Unit supplies the display title (never the legacy Topic's)"
);
eq(
  PA.curriculumContainerOf({ unit: null, topic: { id: "t1", title: "Topic T", titleAr: "عنوان الموضوع" } }).id,
  "t1",
  "K14b: the Topic is used ONLY when no Unit exists"
);
eq(
  PA.curriculumContainerOf({ topic: { id: "t1", title: "Topic T", titleAr: "عنوان الموضوع" } }).id,
  "t1",
  "K14c: a legacy-only lesson (no unit field at all) still resolves"
);
eq(
  PA.curriculumContainerOf({ unit: { id: "u1", title: "Unit T" }, topic: null }).id,
  "u1",
  "K14d: a lesson with no Topic uses its Unit"
);
eq(
  PA.curriculumContainerOf({ unit: { title: "no id" } }),
  null,
  "K15: a container without an id is dropped, never keyed by title"
);
{
  const resolverSrc = stripComments(read("src/lib/parent-access.ts"));
  ok(
    /lesson\?\.unit \?\? lesson\?\.topic \?\? null/.test(resolverSrc),
    "K15a: the resolver implements the documented Unit-first precedence"
  );
  ok(
    !/lesson\?\.topic \?\? lesson\?\.unit/.test(resolverSrc),
    "K15b: …and the inverted (Topic-first) precedence is gone"
  );
}

const dashboardSrc = read("src/app/api/parents/me/dashboard/route.ts");
const analyticsSrc = read("src/app/api/parents/me/analytics/route.ts");
const weeklySrc = read("src/app/api/parents/me/weekly-report/route.ts");
for (const [name, src] of [["dashboard", dashboardSrc], ["analytics", analyticsSrc], ["weekly", weeklySrc]]) {
  ok(
    !/searchParams\.get\(\s*["'](level|academicLevel)["']\s*\)/.test(src),
    `K16: the ${name} route reads no client-supplied level`
  );
  ok(
    /currentCourse(IdOf|AttendanceWhere|MockExamWhere)|isCurrentCourseAttendance/.test(src),
    `K17: the ${name} route composes the shared current-course helpers`
  );
}
ok(
  !/topicMap\.(get|set)\((?!container\.id)/.test(dashboardSrc) && !/topicMap\.(get|set)\((?!container\.id)/.test(analyticsSrc),
  "K18: neither route keys a container map by anything but the canonical id"
);
ok(
  /const key = container\.id|topicMap\.set\(container\.id/.test(dashboardSrc) &&
    /topicMap\.set\(container\.id/.test(analyticsSrc),
  "K19: both routes write the map under the container id"
);
const analyticsViewSrc = read("src/components/parent/analytics-view.tsx");
ok(!/key=\{t\.title\}/.test(analyticsViewSrc), "K20: the analytics view never keys a strong/weak row by title");
ok(/key=\{t\.id\}/.test(analyticsViewSrc), "K21: …it keys them by canonical id");
ok(
  /key=\{t\.id\}/.test(monthlySrc) && !/strongTopics\.map\(\(t, i\)/.test(monthlySrc),
  "K22: the monthly report keys its strong/weak rows by canonical id too"
);
ok(
  !/academicLevelFilter|levelFilter|levelSelector/.test(analyticsSrc + dashboardSrc + weeklySrc + monthlySrc),
  "K23: no Parent level selector/filter was introduced"
);
ok(
  !/parent:\s*\{[^}]*academicLevel/.test(dashboardSrc) &&
    !/parent.*academicLevel\s*:/i.test(stripComments(read("src/lib/parent-academics.ts"))),
  "K24: no `Parent.academicLevel` exists anywhere"
);

// ---------------------------------------------------------------------------
// L. Privacy + schema
// ---------------------------------------------------------------------------
section("L. Privacy, evidence and schema guards");

const dashJson = JSON.stringify(dash.json);
for (const [label, needle] of [
  ["nationalId", "30101011234567"],
  ["parentPhone", "01147422177"],
  ["answer key", SECRET_ANSWER],
  ["question prompt", SECRET_PROMPT],
]) {
  ok(!dashJson.includes(needle), `L1: the dashboard payload leaks no ${label}`);
}
ok(
  !Object.prototype.hasOwnProperty.call(A, "nationalId") &&
    !Object.prototype.hasOwnProperty.call(A, "parentPhone"),
  "L2: identity-grade fields stay withheld"
);
ok(!JSON.stringify(ana.json).includes(SECRET_ANSWER) && !JSON.stringify(wk.json).includes(SECRET_ANSWER), "L3: no analytics/weekly payload leaks an answer snapshot");
ok(
  !/answers/.test(JSON.stringify(A.mockExams)) && !/answers/.test(JSON.stringify(A.quizzes)),
  "L4: neither mock nor quiz payloads carry an answers field"
);

const migrationNames = fs
  .readdirSync(path.join(REPO, "prisma", "migrations"))
  .filter((d) => /^\d+_/.test(d))
  .sort();
eq(
  migrationNames[migrationNames.length - 1],
  "20260923180000_k3_academic_level_constraints",
  "L5: M4.4 added NO migration (the K3 constraint remains the newest)"
);
ok(
  !fs.existsSync(path.join(REPO, "prisma", "migrations", "phase_m44")),
  "L6: …and no M4.4 migration directory exists"
);
const schemaSrc = read("prisma/schema.prisma");
ok(
  /model Attendance \{[\s\S]*?studentId\s+String[\s\S]*?sessionId\s+String/.test(schemaSrc) &&
    /model ExamAttempt \{[\s\S]*?mockExamId\s+String\?/.test(schemaSrc),
  "L7: the attendance/exam relations are the pre-existing ones (scope is code-only)"
);

// ---------------------------------------------------------------------------
console.log(`\nphase-m44 parent metric scope: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
} catch (err) {
  fail++;
  failures.push(`threw: ${err && err.stack ? err.stack.split("\n")[0] : err}`);
  console.error("\nUNEXPECTED ERROR:", err);
  console.log(`\nphase-m44 parent metric scope: ${pass} passed, ${fail} failed`);
}
process.exit(fail === 0 ? 0 : 1);
})();
