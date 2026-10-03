// CodeMind Academy — Phase M4.3: Parent child / context integrity.
//
// WHAT THIS SUITE PROVES (one section per M4.3 goal)
// ==================================================
//   A. One shared child context — `listLinkedChildRefs` (the reference every
//      Parent surface shares) resolves the child's canonical Academic Level
//      from the COURSE chain first and from the canonical assignment second.
//      The `Student.grade` mirror is never the source; a wrong mirror does not
//      change the level; two children whose NAMES and COURSE DISPLAY NAMES are
//      identical stay distinct by canonical id; a childless parent gets [].
//   B. `/api/parents/me/dashboard` — the child payload carries the canonical
//      `academicLevel` and the course's own `academicLevel`; the PARENT object
//      carries no level at all; a forged `?studentId=` is still 404.
//   C. `/api/parents/me/academics` — the shared child refs + the snapshot's
//      canonical level (child and course authority kept separate).
//   D. `/api/parents/me/analytics` — the child row carries the canonical level,
//      `?studentId=` is the request key, and a forged id is 404.
//   E. `/api/parents/me/weekly-report` — every card carries name + level +
//      course, ALL-CHILDREN stays the default (owner decision D5), and a
//      pinned request is still narrowed/404 like before.
//   F. `/api/absence-reviews` (parent branch) — the weak `{id,name}` child
//      shorthand is gone: the shared canonical refs are returned (id, name,
//      level, course), the case list stays LINK-SCOPED, a forged `?childId=`
//      never confirms anything and never returns a non-linked student's case.
//   G. Client source pins — the switcher prints name · level · course, is keyed
//      by canonical id, keeps horizontal scrolling and no longer forces
//      `dir="rtl"`; the dashboard card prints the canonical level instead of the
//      grade mirror; analytics/monthly/weekly clear stale state and sequence
//      their requests; no Parent level switcher or filter exists.
//
// The REAL route handlers run against the repository's migration-backed SQLite
// database with only the framework boundary shimmed (Prisma engine →
// sqlite-prisma-lite, auth → a script-controlled user, next/server shims).
//
// The fixture is adversarial for identity: TWO children share one NAME and one
// COURSE DISPLAY NAME while sitting in the two Academic Levels, and each
// carries a `Student.grade` mirror that contradicts their real level.
//
// Run: node tests/phase-m43-parent-child-context.test.js
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
    throw new Error(`M4.3 test made a network connection attempt: ${JSON.stringify(args[0])}`);
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
/**
 * Source pins that assert an ABSENCE (no forced RTL, no hard-coded fallback)
 * must look at CODE only — the M4.3 migration notes legitimately name the very
 * thing they removed, so a raw-text grep would report the comment as a hit.
 */
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

// ---------------------------------------------------------------------------
// 1. Scratch database: base DDL + every real migration.
// ---------------------------------------------------------------------------
const rawDb = new DatabaseSync(":memory:");
mig.applyMigrations(rawDb, { withBaseSchema: true, label: "M4.3: " });
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
  "src/app/api/parents/me/academics/route.ts",
  "src/app/api/parents/me/analytics/route.ts",
  "src/app/api/parents/me/weekly-report/route.ts",
  "src/app/api/absence-reviews/route.ts",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m43-parent-"));
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
  academics: route("parents/me/academics/route.js"),
  analytics: route("parents/me/analytics/route.js"),
  weekly: route("parents/me/weekly-report/route.js"),
  absences: route("absence-reviews/route.js"),
};
const PA = require(path.join(EMIT, "lib/parent-academics.js"));

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
// 4. Fixture — two children, ONE name, ONE course display name, TWO levels,
//    and a deliberately WRONG `Student.grade` mirror on each.
// ---------------------------------------------------------------------------
section("M4.3 fixture — same child name, same course name, two Academic Levels");

/** Both live levels ship a course with this ONE display name. */
const SHARED_COURSE_NAME = "البرمجة والذكاء الاصطناعي";

const COURSES = [
  { id: "c-first", slug: "m43-first", level: "FIRST_SECONDARY", name: SHARED_COURSE_NAME, code: "1-1" },
  { id: "c-second", slug: "m43-second", level: "SECOND_SECONDARY", name: SHARED_COURSE_NAME, code: "1-1" },
  // Same LEVEL as `c-first`, so it needs its own printed code.
  { id: "c-third", slug: "m43-third", level: "FIRST_SECONDARY", name: "كورس مختلف", code: "3-1" },
];
for (const c of COURSES) {
  ins("Course", {
    id: c.id,
    slug: c.slug,
    academicLevel: c.level,
    name: c.name,
    nameAr: c.name,
    description: "M4.3 fixture course",
    color: "#10b981",
    createdAt: NOW,
    updatedAt: NOW,
  });
  ins("Part", { id: `p-${c.id}`, courseId: c.id, title: "Part 1", titleAr: "الجزء الأول", order: 1 });
  ins("Unit", { id: `u-${c.id}`, partId: `p-${c.id}`, title: "Unit 1", titleAr: "الوحدة الأولى", order: 1 });
  ins("Group", {
    id: `g-${c.id}`,
    name: `Group ${c.id}`,
    courseId: c.id,
    capacity: 20,
    schedule: "Sat",
    isActive: 1,
    trackScope: "ARABIC",
    createdAt: NOW,
    updatedAt: NOW,
  });
  ins("Lesson", {
    id: `l-${c.id}`,
    unitId: `u-${c.id}`,
    officialCode: c.code,
    academicLevel: c.level,
    curriculumStatus: "OFFICIAL",
    trackScope: "SHARED",
    status: "PUBLISHED",
    title: "Session 1-1",
    titleAr: "الحصة ١-١",
    order: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

const USERS = [
  // One display name, TWO children — the switcher/tab/case identity test.
  { id: "u-child-a", name: "أحمد محمد", email: "child-a@m43.test", role: "STUDENT" },
  { id: "u-child-b", name: "أحمد محمد", email: "child-b@m43.test", role: "STUDENT" },
  { id: "u-child-c", name: "سارة علي", email: "child-c@m43.test", role: "STUDENT" },
  { id: "u-solo", name: "طفل وحيد", email: "solo@m43.test", role: "STUDENT" },
  // Owned by a student that has no group (the assignment fallback case).
  { id: "u-nogroup", name: "بلا مجموعة", email: "nogroup@m43.test", role: "STUDENT" },
  { id: "u-decoy", name: "طالب آخر", email: "decoy@m43.test", role: "STUDENT" },
  { id: "u-parent-two", name: "ولي أمر", email: "parent-two@m43.test", role: "PARENT" },
  { id: "u-parent-solo", name: "ولي أمر واحد", email: "parent-solo@m43.test", role: "PARENT" },
  { id: "u-parent-none", name: "ولي أمر بلا أبناء", email: "parent-none@m43.test", role: "PARENT" },
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

/**
 * Child A: course chain says FIRST_SECONDARY while `grade` claims the SECOND
 * level. Child B: the exact opposite. Nothing may read the mirror.
 */
const STUDENTS = [
  {
    id: "s-child-a",
    userId: "u-child-a",
    groupId: "g-c-first",
    level: "FIRST_SECONDARY",
    grade: "2nd Secondary",
  },
  {
    id: "s-child-b",
    userId: "u-child-b",
    groupId: "g-c-second",
    level: "SECOND_SECONDARY",
    grade: "1st Secondary",
  },
  {
    id: "s-child-c",
    userId: "u-child-c",
    groupId: "g-c-third",
    level: "FIRST_SECONDARY",
    grade: "2nd Secondary",
  },
  {
    id: "s-solo",
    userId: "u-solo",
    groupId: "g-c-first",
    level: "FIRST_SECONDARY",
    grade: "2nd Secondary",
  },
  {
    id: "s-decoy",
    userId: "u-decoy",
    groupId: "g-c-third",
    level: "FIRST_SECONDARY",
    grade: "2nd Secondary",
  },
];
for (const s of STUDENTS) {
  ins("Student", {
    id: s.id,
    userId: s.userId,
    groupId: s.groupId,
    academicLevel: s.level,
    schoolType: "ARABIC",
    grade: s.grade,
    enrolledAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
}

const PARENTS = [
  { id: "p-two", userId: "u-parent-two" },
  { id: "p-solo", userId: "u-parent-solo" },
  { id: "p-none", userId: "u-parent-none" },
];
for (const p of PARENTS) {
  ins("Parent", { id: p.id, userId: p.userId, createdAt: NOW, updatedAt: NOW });
}
// Links: parent `p-two` owns BOTH same-named children, `p-solo` owns one, the
// childless parent owns none, and `s-decoy` is linked to NOBODY (the forged
// target).
// `ParentStudentLink` carries no `updatedAt` column (links are append-only).
ins("ParentStudentLink", { id: "psl-1", parentId: "p-two", studentId: "s-child-a", relation: "FATHER", createdAt: at(30) });
ins("ParentStudentLink", { id: "psl-2", parentId: "p-two", studentId: "s-child-b", relation: "FATHER", createdAt: at(20) });
ins("ParentStudentLink", { id: "psl-3", parentId: "p-solo", studentId: "s-solo", relation: "MOTHER", createdAt: at(10) });

// One live session + one absence case per child (the absences surface).
for (const c of [
  { id: "ses-c-first", groupId: "g-c-first", lessonId: "l-c-first" },
  { id: "ses-c-second", groupId: "g-c-second", lessonId: "l-c-second" },
  { id: "ses-c-third", groupId: "g-c-third", lessonId: "l-c-third" },
]) {
  ins("LiveSession", {
    id: c.id,
    groupId: c.groupId,
    lessonId: c.lessonId,
    title: "Live Session",
    titleAr: "حصة مباشرة",
    startAt: at(600),
    duration: 60,
    status: "COMPLETED",
    createdAt: NOW,
    updatedAt: NOW,
  });
}
const CASES = [
  { id: "ar-a", studentId: "s-child-a", sessionId: "ses-c-first", groupId: "g-c-first", lessonId: "l-c-first" },
  { id: "ar-b", studentId: "s-child-b", sessionId: "ses-c-second", groupId: "g-c-second", lessonId: "l-c-second" },
  { id: "ar-c", studentId: "s-child-c", sessionId: "ses-c-third", groupId: "g-c-third", lessonId: "l-c-third" },
];
CASES.forEach((c, i) => {
  ins("Attendance", {
    id: `att-${c.id}`,
    studentId: c.studentId,
    sessionId: c.sessionId,
    status: "ABSENT",
    createdAt: at(500 + i),
  });
  ins("AbsenceReview", {
    id: c.id,
    attendanceId: `att-${c.id}`,
    studentId: c.studentId,
    sessionId: c.sessionId,
    groupId: c.groupId,
    lessonId: c.lessonId,
    status: "PENDING_REASON",
    createdAt: at(500 + i),
    updatedAt: at(500 + i),
  });
});

// A little activity so the analytics/weekly payloads are not empty shells.
ins("LessonProgress", {
  id: "lp-a",
  studentId: "s-child-a",
  lessonId: "l-c-first",
  isCompleted: 1,
  progress: 100,
  lastViewedAt: at(120),
});
ins("LessonProgress", {
  id: "lp-b",
  studentId: "s-child-b",
  lessonId: "l-c-second",
  isCompleted: 1,
  progress: 100,
  lastViewedAt: at(110),
});
// `Quiz` has no timestamps either (only `publishedAt`).
ins("Quiz", { id: "q-a", lessonId: "l-c-first", title: "Quiz 1", titleAr: "اختبار ١", status: "PUBLISHED", publishedAt: at(300) });
ins("Quiz", { id: "q-b", lessonId: "l-c-second", title: "Quiz 1", titleAr: "اختبار ١", status: "PUBLISHED", publishedAt: at(300) });
ins("QuizAttempt", {
  id: "qa-a",
  quizId: "q-a",
  studentId: "s-child-a",
  percentage: 80,
  passed: 1,
  startedAt: at(200),
  finishedAt: at(190),
});
ins("QuizAttempt", {
  id: "qa-b",
  quizId: "q-b",
  studentId: "s-child-b",
  percentage: 90,
  passed: 1,
  startedAt: at(210),
  finishedAt: at(205),
});

section("M4.3 fixture — inserted rows");
ok(count("ParentStudentLink") === 3, "three parent links exist (two for the same-named pair)");
ok(count("Student") === 5, "five students exist (one is linked to nobody)");

// ---------------------------------------------------------------------------
// A. The shared child reference.
// ---------------------------------------------------------------------------
(async () => {
try {
section("A. Shared child reference — canonical level, canonical identity");

const refsTwo = await PA.listLinkedChildRefs("u-parent-two", "ar");
eq(refsTwo.length, 2, "A1: the two-child parent has two references");
eq(refsTwo.map((c) => c.name), ["أحمد محمد", "أحمد محمد"], "A2: both children share ONE display name");
eq(
  new Set(refsTwo.map((c) => c.courseName)).size,
  1,
  "A3: both children share ONE course display name (so a name is not an identity)"
);
eq(
  refsTwo.map((c) => c.academicLevel),
  ["FIRST_SECONDARY", "SECOND_SECONDARY"],
  "A4: the canonical level is what distinguishes them"
);
eq(
  new Set(refsTwo.map((c) => c.id)).size,
  2,
  "A5: canonical studentIds stay distinct"
);
ok(
  refsTwo.every((c) => c.id.startsWith("s-child-")),
  "A6: the reference id IS the canonical studentId"
);

// The mirror contradicts the real level on BOTH children — and is ignored.
const studentA = rawDb.prepare(`SELECT grade, academicLevel FROM "Student" WHERE id = 's-child-a'`).get();
eq(studentA.grade, "2nd Secondary", "A7: child A's `grade` mirror claims the SECOND level");
eq(
  refsTwo[0].academicLevel,
  "FIRST_SECONDARY",
  "A8: …and the canonical level is still the course chain's FIRST_SECONDARY"
);
const studentB = rawDb.prepare(`SELECT grade, academicLevel FROM "Student" WHERE id = 's-child-b'`).get();
eq(studentB.grade, "1st Secondary", "A9: child B's `grade` mirror claims the FIRST level");
eq(
  refsTwo[1].academicLevel,
  "SECOND_SECONDARY",
  "A10: …and the canonical level is still SECOND_SECONDARY"
);

// The Assignment fallback: a child with no group answers from
// `Student.academicLevel`, never from `grade`.
ins("Student", {
  id: "s-nogroup",
  userId: "u-nogroup",
  groupId: null,
  academicLevel: "SECOND_SECONDARY",
  schoolType: "ARABIC",
  grade: "1st Secondary",
  enrolledAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
});
const orphanLevel = PA.childAcademicLevel({
  academicLevel: "SECOND_SECONDARY",
  group: null,
});
eq(orphanLevel, "SECOND_SECONDARY", "A11: no course → the canonical assignment answers");
eq(PA.childAcademicLevel({ academicLevel: undefined, group: null }), null, "A12: no level at all → null, never a guess");
eq(
  PA.childAcademicLevel({ academicLevel: "SECOND_SECONDARY", group: { course: { academicLevel: "FIRST_SECONDARY" } } }),
  "FIRST_SECONDARY",
  "A13: when both exist the COURSE chain wins (it owns the current curriculum)"
);
eq(
  refsTwo.every((c) => !Object.prototype.hasOwnProperty.call(c, "grade")),
  true,
  "A14: the reference carries no `grade` field at all"
);
// `s-nogroup` reuses a user that already has a student row (unique userId), so
// remove it again to keep the fixture honest for the remaining sections.
rawDb.prepare(`DELETE FROM "Student" WHERE id = 's-nogroup'`).run();

const refsSolo = await PA.listLinkedChildRefs("u-parent-solo", "ar");
eq(refsSolo.length, 1, "A15: the single-child parent has exactly one reference");
eq(refsSolo[0].academicLevel, "FIRST_SECONDARY", "A16: …with its canonical level");
const refsNone = await PA.listLinkedChildRefs("u-parent-none", "ar");
eq(refsNone, [], "A17: a childless parent gets an empty list (no invented child)");

// ---------------------------------------------------------------------------
// B. /api/parents/me/dashboard
// ---------------------------------------------------------------------------
section("B. Parent dashboard — canonical child context, unchanged authorization");

asUser({ id: "u-parent-two", name: "ولي أمر", role: "PARENT" });
const dash = await GET(R.dashboard, "http://localhost/api/parents/me/dashboard");
eq(dash.status, 200, "B1: the two-child parent gets 200");
eq(dash.json.children.length, 2, "B2: both linked children travel");
eq(
  dash.json.children.map((c) => c.academicLevel),
  ["FIRST_SECONDARY", "SECOND_SECONDARY"],
  "B3: each child carries its canonical level"
);
eq(
  dash.json.children.map((c) => c.group.course.academicLevel),
  ["FIRST_SECONDARY", "SECOND_SECONDARY"],
  "B4: the COURSE object carries the course's own level as well"
);
eq(
  new Set(dash.json.children.map((c) => c.group.course.name)).size,
  1,
  "B5: …while both courses share one display name"
);
ok(
  !Object.prototype.hasOwnProperty.call(dash.json.parent, "academicLevel"),
  "B6: the PARENT object carries no academicLevel (no Parent-level authority)"
);
eq(
  dash.json.children.every((c) => typeof c.grade === "string"),
  true,
  "B7: `grade` stays in the payload for compatibility only"
);
eq(dash.json.selectedStudentId, null, "B8: no id pinned → the whole link set is returned");

const dashPinned = await GET(R.dashboard, "http://localhost/api/parents/me/dashboard?studentId=s-child-b");
eq(dashPinned.status, 200, "B9: pinning a linked child is 200");
eq(dashPinned.json.children.length, 1, "B10: the pinned payload narrows to that child alone");
eq(dashPinned.json.children[0].id, "s-child-b", "B11: …identified by canonical id");
eq(dashPinned.json.selectedStudentId, "s-child-b", "B12: the echo is the canonical id");

const dashForged = await GET(R.dashboard, "http://localhost/api/parents/me/dashboard?studentId=s-decoy");
eq(dashForged.status, 404, "B13: an UNLINKED child id is still 404");
ok(JSON.stringify(dashForged.json).indexOf("طالب آخر") === -1, "B14: …and leaks nothing about that student");

asUser({ id: "u-parent-none", name: "ولي أمر بلا أبناء", role: "PARENT" });
const dashNone = await GET(R.dashboard, "http://localhost/api/parents/me/dashboard");
eq(dashNone.status, 200, "B15: a childless parent gets 200 with an empty set");
eq(dashNone.json.children, [], "B16: …and no invented child");
eq(dashNone.json.selectedStudentId, null, "B17: …and no selected child");

asUser({ id: "u-parent-solo", name: "ولي أمر واحد", role: "PARENT" });
const dashSolo = await GET(R.dashboard, "http://localhost/api/parents/me/dashboard");
eq(dashSolo.json.children.length, 1, "B18: the single-child parent sees exactly one child");
eq(dashSolo.json.children[0].academicLevel, "FIRST_SECONDARY", "B19: with the canonical level");

// ---------------------------------------------------------------------------
// C. /api/parents/me/academics
// ---------------------------------------------------------------------------
section("C. Academic follow-up — shared child refs + snapshot levels");

asUser({ id: "u-parent-two", name: "ولي أمر", role: "PARENT" });
const acad = await GET(R.academics, "http://localhost/api/parents/me/academics?studentId=s-child-a");
eq(acad.status, 200, "C1: the follow-up answers 200 for a linked child");
eq(acad.json.children.length, 2, "C2: the child refs travel with the snapshot");
eq(
  acad.json.children.map((c) => c.academicLevel),
  ["FIRST_SECONDARY", "SECOND_SECONDARY"],
  "C3: the refs carry the canonical levels"
);
eq(acad.json.selectedStudentId, "s-child-a", "C4: the selected child is the canonical id");
eq(acad.json.snapshot.student.academicLevel, "FIRST_SECONDARY", "C5: the snapshot's child level is canonical");
eq(acad.json.snapshot.student.grade, "2nd Secondary", "C6: the grade mirror still travels for compatibility");
eq(
  acad.json.snapshot.course.academicLevel,
  "FIRST_SECONDARY",
  "C7: the snapshot's COURSE level is the course authority"
);
ok(
  !Object.prototype.hasOwnProperty.call(acad.json.snapshot, "grade"),
  "C8: no second/global `grade` field was introduced on the snapshot"
);

const acadForged = await GET(R.academics, "http://localhost/api/parents/me/academics?studentId=s-decoy");
eq(acadForged.status, 404, "C9: a forged child id is still 404");

asUser({ id: "u-parent-none", name: "ولي أمر بلا أبناء", role: "PARENT" });
const acadNone = await GET(R.academics, "http://localhost/api/parents/me/academics");
eq(acadNone.status, 404, "C10: a childless parent has no child to follow (established 404)");

// ---------------------------------------------------------------------------
// D. /api/parents/me/analytics
// ---------------------------------------------------------------------------
section("D. Analytics — canonical child row, keyed request");

asUser({ id: "u-parent-two", name: "ولي أمر", role: "PARENT" });
const anAll = await GET(R.analytics, "http://localhost/api/parents/me/analytics");
eq(anAll.status, 200, "D1: the analytics collection answers 200");
eq(
  anAll.json.children.map((c) => c.academicLevel),
  ["FIRST_SECONDARY", "SECOND_SECONDARY"],
  "D2: each row carries its canonical level"
);
eq(
  new Set(anAll.json.children.map((c) => c.course)).size,
  1,
  "D3: the rows share one course display name (level is the differentiator)"
);
eq(
  new Set(anAll.json.children.map((c) => c.studentId)).size,
  2,
  "D4: rows are keyed by canonical studentId"
);

const anPinned = await GET(R.analytics, "http://localhost/api/parents/me/analytics?studentId=s-child-b");
eq(anPinned.status, 200, "D5: a pinned request is 200");
eq(anPinned.json.children.length, 1, "D6: the payload narrows to the requested child");
eq(anPinned.json.children[0].studentId, "s-child-b", "D7: …by canonical id");
eq(anPinned.json.children[0].academicLevel, "SECOND_SECONDARY", "D8: …with that child's own level");

const anForged = await GET(R.analytics, "http://localhost/api/parents/me/analytics?studentId=s-decoy");
eq(anForged.status, 404, "D9: a forged child id is still 404");
ok(JSON.stringify(anForged.json).indexOf("طالب آخر") === -1, "D10: …and no decoy data leaks");

// ---------------------------------------------------------------------------
// E. /api/parents/me/weekly-report
// ---------------------------------------------------------------------------
section("E. Weekly report — all children, each card identifiable");

asUser({ id: "u-parent-two", name: "ولي أمر", role: "PARENT" });
const wkAll = await GET(R.weekly, "http://localhost/api/parents/me/weekly-report");
eq(wkAll.status, 200, "E1: the weekly report answers 200");
eq(wkAll.json.reports.length, 2, "E2: ALL linked children remain the default (D5)");
eq(
  wkAll.json.reports.map((r) => r.academicLevel),
  ["FIRST_SECONDARY", "SECOND_SECONDARY"],
  "E3: every card carries its canonical level"
);
eq(
  wkAll.json.reports.map((r) => r.course),
  [SHARED_COURSE_NAME, SHARED_COURSE_NAME],
  "E4: …and its course"
);
eq(
  wkAll.json.reports.map((r) => r.name),
  ["أحمد محمد", "أحمد محمد"],
  "E5: two cards, ONE name — the card key must be the canonical id"
);
eq(
  new Set(wkAll.json.reports.map((r) => r.studentId)).size,
  2,
  "E6: …and the ids are what differ"
);

const wkPinned = await GET(R.weekly, "http://localhost/api/parents/me/weekly-report?studentId=s-child-a");
eq(wkPinned.status, 200, "E7: a pinned weekly request is 200");
eq(wkPinned.json.reports.length, 1, "E8: …narrowed to the selected child");
eq(wkPinned.json.reports[0].studentId, "s-child-a", "E9: …by canonical id");
const wkForged = await GET(R.weekly, "http://localhost/api/parents/me/weekly-report?studentId=s-decoy");
eq(wkForged.status, 404, "E10: a forged child id is still 404");

// ---------------------------------------------------------------------------
// F. /api/absence-reviews (parent branch)
// ---------------------------------------------------------------------------
section("F. Absences — shared canonical child refs, link-scoped cases");

asUser({ id: "u-parent-two", name: "ولي أمر", role: "PARENT" });
const absAll = await GET(R.absences, "http://localhost/api/absence-reviews");
eq(absAll.status, 200, "F1: the parent absence collection answers 200");
eq(absAll.json.scope, "parent", "F2: …in the parent scope");
eq(absAll.json.children.length, 2, "F3: the selector receives BOTH linked children");
eq(
  absAll.json.children.map((c) => c.id),
  ["s-child-a", "s-child-b"],
  "F4: keyed by canonical studentId"
);
ok(
  absAll.json.children.every((c) => "academicLevel" in c && "courseName" in c),
  "F5: each reference carries level + course (no `{id,name}` shorthand)"
);
eq(absAll.json.children.map((c) => c.academicLevel), ["FIRST_SECONDARY", "SECOND_SECONDARY"], "F6: …with the canonical levels");
eq(
  new Set(absAll.json.cases.map((c) => c.student.id)).size,
  2,
  "F7: both children's cases are listed for the unscoped request"
);
ok(
  absAll.json.cases.every((c) => c.student.id === "s-child-a" || c.student.id === "s-child-b"),
  "F8: …and ONLY linked children's cases (never another student's)"
);

const absKeyed = await GET(R.absences, "http://localhost/api/absence-reviews?childId=s-child-b");
eq(absKeyed.status, 200, "F9: a keyed request is 200");
eq(absKeyed.json.childId, "s-child-b", "F10: the echo is the canonical id that was scoped");
ok(
  absKeyed.json.cases.length > 0 && absKeyed.json.cases.every((c) => c.student.id === "s-child-b"),
  "F11: the cases are the requested child's own"
);

const absForged = await GET(R.absences, "http://localhost/api/absence-reviews?childId=s-decoy");
eq(absForged.status, 200, "F12: a forged child id does not crash the collection");
eq(absForged.json.childId, null, "F13: …and is never echoed back as a resolved child");
ok(
  absForged.json.cases.every((c) => c.student.id !== "s-decoy"),
  "F14: …and the unlinked student's case is never returned"
);
ok(
  absForged.json.children.every((c) => c.id !== "s-decoy"),
  "F15: …and the unlinked student is not offered as a child either"
);

asUser({ id: "u-parent-none", name: "ولي أمر بلا أبناء", role: "PARENT" });
const absNone = await GET(R.absences, "http://localhost/api/absence-reviews");
eq(absNone.status, 200, "F16: a childless parent gets 200");
eq(absNone.json.children, [], "F17: …with no children");
eq(absNone.json.cases, [], "F18: …and no cases");

// ---------------------------------------------------------------------------
// G. Client source pins
// ---------------------------------------------------------------------------
section("G. Client surfaces — level visible, canonical id keyed, no forced RTL");

const switcher = read("src/components/parent/child-switcher.tsx");
ok(
  /academicLevelLabelFor\(t, child\.academicLevel\)/.test(switcher),
  "G1: the switcher composes the level through the SHARED label vocabulary"
);
ok(/child\.courseName \? ` · \$\{child\.courseName\}` : ""/.test(switcher), "G2: …and appends the course name");
ok(!/dir="rtl"/.test(stripComments(switcher)), "G3: the switcher no longer forces RTL (direction follows the locale)");
ok(/overflow-x-auto/.test(switcher), "G4: horizontal scrolling is preserved");
ok(/key=\{child\.id\}/.test(switcher) && /onChange\(child\.id\)/.test(switcher), "G5: chips are keyed AND valued by canonical id");
ok(/items\.length <= 1\) return null/.test(switcher), "G6: a single child still renders no switcher");
ok(
  /stored && availableIds\.includes\(stored\) \? stored : \(availableIds\[0\] \?\? null\)/.test(switcher),
  "G7: the retained selection comes from the shared store and falls back by ID"
);

const pdash = read("src/components/parent/parent-dashboard.tsx");
ok(
  /academicLevelLabelFor\(tr, child\.academicLevel \?\? child\.group\?\.course\?\.academicLevel\)/.test(pdash),
  "G8: the child card prints the canonical level"
);
ok(!/\{child\.grade\}/.test(pdash), "G9: …and no longer prints the `grade` mirror as the level");
ok(
  /data\.children\.find\(\(c\) => c\.id === activeChildId\) \|\| data\.children\[0\]/.test(pdash),
  "G10: the rendered child is resolved by canonical id (never by name)"
);
ok(
  /academicLevel: c\.academicLevel \?\? c\.group\?\.course\?\.academicLevel \?\? null/.test(pdash),
  "G11: the switcher items receive the server-resolved level"
);

const followup = read("src/components/parent/academic-followup.tsx");
ok(
  /academicLevelLabelFor\(\s*\n\s*t,\s*\n\s*snapshot\.student\.academicLevel \?\? course\.academicLevel\s*\n\s*\)/.test(followup),
  "G12: the follow-up header names the canonical level"
);

const analytics = read("src/components/parent/analytics-view.tsx");
ok(/parentChildId/.test(analytics), "G13: analytics reads the SHARED child context");
ok(/setParentChildId/.test(analytics), "G14: …and writes it back when the parent switches");
ok(
  /\/api\/parents\/me\/analytics\?studentId=\$\{encodeURIComponent\(selectedId\)\}/.test(analytics),
  "G15: every child switch is a request KEYED by the canonical id"
);
ok(/new AbortController\(\)/.test(analytics), "G16: the previous request is aborted");
ok(/requestSeq\.current/.test(analytics), "G17: …and a sequence guard drops late responses");
ok(/rows\[selectedId\]/.test(analytics), "G18: rows are read from a map keyed by canonical id");
ok(/key=\{c\.studentId\}/.test(analytics), "G19: tabs are keyed by canonical id");
ok(/academicLevelLabelFor\(tr, c\.academicLevel\)/.test(analytics), "G20: tabs show the child's level");
ok(/setSelectedId\(c\.studentId\)/.test(analytics), "G21: switching selects by canonical id, never an index");
ok(!/findIndex\(\(c\) => c\.studentId/.test(analytics), "G22: the old index-based tab override is gone");

const monthly = read("src/components/parent/monthly-report.tsx");
ok(!/2nd Secondary/.test(stripComments(monthly)), "G23: the hard-coded \"2nd Secondary\" fallback is gone");
ok(/normalizeAcademicLevel\(child\.academicLevel\)/.test(monthly), "G24: the report level is the canonical one");
ok(!/child\.grade \|\|/.test(monthly), "G25: `Student.grade` is no longer a fallback");
ok(/academicLevelLabelFor\(tr, data\.academicLevel\)/.test(monthly), "G26: …and it renders through the shared vocabulary");
ok(/new AbortController\(\)/.test(monthly) && /requestSeq\.current/.test(monthly), "G27: the report aborts and sequences on child switch");
ok(
  /const isCurrent = loaded !== null && loaded\.key === requestKey;/.test(monthly) &&
    /loaded\.key === requestKey/.test(monthly),
  "G28: …and only the payload STAMPED with the current child can render (the previous child's report is cleared by construction)"
);
ok(!/Programming & AI/.test(stripComments(monthly)), "G29: no hard-coded course-name fallback either");

const weekly = read("src/components/parent/weekly-report.tsx");
ok(/academicLevelLabelFor\(t, report\.academicLevel\)/.test(weekly), "G30: weekly cards print the canonical level");
ok(/report\.course \? ` · \$\{report\.course\}`/.test(weekly), "G31: …and the course");
ok(/key=\{report\.studentId\}/.test(weekly), "G32: cards stay keyed by canonical id");
ok(/new AbortController\(\)/.test(weekly) && /requestSeq\.current/.test(weekly), "G33: the weekly fetch aborts + sequences");
ok(
  /const isCurrent = loaded !== null && loaded\.key === requestKey;/.test(weekly),
  "G33b: …and the weekly payload is stamped with the child it was fetched for"
);
ok(!/dataset\.level|levelFilter|academicLevelFilter/.test(weekly), "G34: no Parent level filter was introduced");

const absView = read("src/components/student/live-sessions-view.tsx");
ok(/ChildSwitcher/.test(absView), "G35: the absences screen uses the SHARED switcher");
ok(/parentChildId/.test(absView), "G36: …backed by the shared child context");
ok(
  /\/api\/absence-reviews\?childId=\$\{encodeURIComponent\(storedChildId\)\}/.test(absView),
  "G37: …and requests are keyed by the canonical child id"
);
ok(/new AbortController\(\)/.test(absView) && /requestSeq\.current/.test(absView), "G38: stale responses are aborted/ignored");
ok(
  /loaded !== null && loaded\.key === requestKey \? loaded : null;/.test(absView),
  "G39: cases are stamped with the child they were fetched for, so the previous child's cases can never render"
);
ok(/childContext\(item\.student\.id\)/.test(absView), "G40: each case header resolves context by canonical id");

// No Parent-level authority and no request-supplied level anywhere.
const parentRoutes = [
  "src/app/api/parents/me/dashboard/route.ts",
  "src/app/api/parents/me/academics/route.ts",
  "src/app/api/parents/me/analytics/route.ts",
  "src/app/api/parents/me/weekly-report/route.ts",
  "src/app/api/absence-reviews/route.ts",
];
for (const f of parentRoutes) {
  const src = read(f);
  ok(
    !/searchParams\.get\(\s*["'](level|academicLevel)["']\s*\)/.test(src),
    `G41: ${f} reads no client-supplied level`
  );
}
const paSrc = read("src/lib/parent-academics.ts");
ok(!/parent.*academicLevel\s*:/i.test(paSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")), "G42: no Parent-identity academicLevel is written");
ok(/childAcademicLevel/.test(paSrc), "G43: the ONE child-level rule lives in parent-academics.ts");
const dashSrc = read("src/app/api/parents/me/dashboard/route.ts");
ok(
  /parent: \{[\s\S]{0,320}?\}/.test(dashSrc) && !/parent:\s*\{[^}]*academicLevel/.test(dashSrc),
  "G44: the dashboard's parent block carries no level"
);

// ---------------------------------------------------------------------------
// H. Vocabulary + i18n
// ---------------------------------------------------------------------------
section("H. One vocabulary, one caption");

const labels = read("src/lib/academic-level-labels.ts");
ok(/export function academicLevelLabelFor/.test(labels), "H1: the shared label module is the single vocabulary");
const dictLegacy = read("src/lib/i18n-dict.ts");
ok(
  /"parent\.016": \{ ar: "الصف الدراسي", en: "Academic level" \}/.test(dictLegacy),
  "H2: the monthly report's field is captioned as the Academic Level"
);
for (const f of ["src/components/parent/child-switcher.tsx", "src/components/parent/parent-dashboard.tsx", "src/components/parent/academic-followup.tsx", "src/components/parent/analytics-view.tsx", "src/components/parent/monthly-report.tsx", "src/components/parent/weekly-report.tsx"]) {
  const src = read(f);
  ok(
    !/[A-Za-z]*[Ll]evel\s*=\s*["'][^"']*["']/.test(src) || /academicLevel/.test(src),
    `H3: ${f} composes level text through the shared module`
  );
}

// ---------------------------------------------------------------------------
console.log(`\nphase-m43 parent child context: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
} catch (err) {
  fail++;
  failures.push(`threw: ${err && err.stack ? err.stack.split("\n")[0] : err}`);
  console.error("\nUNEXPECTED ERROR:", err);
  console.log(`\nphase-m43 parent child context: ${pass} passed, ${fail} failed`);
}
process.exit(fail === 0 ? 0 : 1);
})();
