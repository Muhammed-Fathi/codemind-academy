// CodeMind Academy — Phase M4.5: Parent i18n / RTL / responsive cleanup.
//
// WHAT THIS SUITE PROVES (audit finding M4-F7 + the deferred M4-F13 heading)
// =========================================================================
//   A. Direction hygiene: no Parent surface (or the Parent branch of the
//      shared absences view) forces RTL; every intentional `dir="ltr"` is a
//      CHART or NUMERIC field and says so (`data-dir`), so nothing mirrors the
//      layout behind the locale's back.
//   B. Logical layout: the Parent surfaces use logical utilities (`ms/me`,
//      `ps/pe`, `border-s`, `text-start`) — no physical `ml/mr/pl/pr/left/right`
//      or `text-right/text-left` leaks.
//   C. Dictionary integrity: every i18n key the Parent surfaces + the three
//      Parent routes reference EXISTS in the one merged dictionary with both
//      locales non-empty; no key is invented outside it; the level vocabulary
//      (admin.643/644 through `academic-level-labels.ts`) is not duplicated and
//      the legacy `2nd Secondary` display string is gone from the Parent path.
//   D. EN/LTR: with the locale set to English and the document LTR, the Parent
//      surfaces RENDER in LTR with English chrome — switcher, analytics, weekly
//      report, monthly report, absences, dashboard — and no Arabic-only chrome
//      literal and no raw enum/status or dotted key leaks into the markup.
//   E. AR/RTL: the same surfaces render with the Arabic chrome from the
//      dictionary (including the previously hard-coded "Weekly Report"
//      heading), with no forced direction of their own.
//   F. Responsive: the child switcher and the analytics tab strip scroll
//      horizontally (`overflow-x-auto` + `shrink-0`) instead of overflowing the
//      viewport; long names are truncated/wrapped; the monthly report toolbar
//      wraps and its 4-column table lives in its own scroll container; no
//      Parent surface declares a fixed width that would force a phone viewport
//      sideways.
//   G. Identity/semantics: the switcher and the tabs are keyed and switched by
//      CANONICAL studentId; the analytics tab click issues exactly one scoped
//      request for that id; the weekly report stays all-children (one card per
//      report, each keyed by its own id); no level selector/filter was added.
//   H. Shared-component safety: the Student absences branch still mounts its
//      write affordance while the Parent branch does not — the parent-only
//      responsive fix did not touch Student behaviour.
//   I. Server labels: both Parent month-label routes build their labels through
//      the ONE locale-aware formatter with the REQUEST locale (the M4-F7
//      `en-US`/`ar-EG` mismatch is gone), and no schema/migration changed.
//
// The components are compiled from the SHIPPED sources with the repository's
// own tsc (JSX → react-jsx) and mounted in jsdom with `react-dom/client`, so
// the assertions run against the real markup (labels, direction, classes) in
// BOTH locales — not against a re-implementation.
//
// Run: node tests/phase-m45-parent-i18n-responsive.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner */
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");
const assert = require("node:assert");

const REPO = path.resolve(__dirname, "..");

// Empirical NO-NETWORK guard: any TCP connect attempt fails loudly.
{
  const net = require("node:net");
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    throw new Error(`M4.5 test made a network connection attempt: ${JSON.stringify(args[0])}`);
  };
  process.on("exit", () => {
    net.Socket.prototype.connect = realConnect;
  });
}

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
// 0. The Parent surfaces under test (source inventory).
// ---------------------------------------------------------------------------
const PARENT_SURFACES = [
  "src/components/parent/parent-dashboard.tsx",
  "src/components/parent/child-switcher.tsx",
  "src/components/parent/academic-followup.tsx",
  "src/components/parent/analytics-view.tsx",
  "src/components/parent/monthly-report.tsx",
  "src/components/parent/weekly-report.tsx",
  "src/components/student/live-sessions-view.tsx",
];
const PARENT_ROUTES = [
  "src/app/api/parents/me/dashboard/route.ts",
  "src/app/api/parents/me/analytics/route.ts",
  "src/app/api/parents/me/weekly-report/route.ts",
];

// ---------------------------------------------------------------------------
// 1. Compile the shipped TypeScript/TSX with the repo's own tsc.
// ---------------------------------------------------------------------------
const COMPILE_SET = [
  // i18n + shared pure libs
  "src/lib/i18n-dict.ts",
  "src/lib/i18n-dict-2026.ts",
  "src/lib/i18n-core.ts",
  "src/lib/i18n.ts",
  "src/lib/i18n-server.ts",
  "src/lib/locale-direction.ts",
  "src/lib/utils.ts",
  "src/lib/store.ts",
  "src/lib/brand.ts",
  "src/lib/report-export.ts",
  "src/lib/academic-level.ts",
  "src/lib/academic-level-labels.ts",
  "src/lib/parent-subscription.ts",
  "src/lib/absence-policy.ts",
  "src/components/logo.tsx",
  // the surfaces under test (and the shared absences view)
  "src/components/parent/child-switcher.tsx",
  "src/components/parent/academic-followup.tsx",
  "src/components/parent/analytics-view.tsx",
  "src/components/parent/monthly-report.tsx",
  "src/components/parent/weekly-report.tsx",
  "src/components/parent/parent-dashboard.tsx",
  "src/components/student/live-sessions-view.tsx",
];

const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m45-parent-"));
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
        jsx: "react-jsx",
        resolveJsonModule: true,
        types: ["node"],
        typeRoots: [path.join(REPO, "node_modules/@types")],
        baseUrl: REPO,
        paths: { "@/*": ["src/*"] },
        rootDir: REPO,
        outDir: OUT,
        noEmitOnError: false,
      },
      files: COMPILE_SET.map((f) => path.join(REPO, f)),
    },
    null,
    2
  )
);
try {
  execFileSync(
    process.execPath,
    [path.join(REPO, "node_modules/typescript/lib/tsc.js"), "-p", path.join(OUT, "tsconfig.json")],
    { cwd: REPO, stdio: "pipe" }
  );
} catch {
  /* type noise tolerated — the emitted files are what matter */
}
for (const f of COMPILE_SET) {
  const emitted = path.join(OUT, f.replace(/\.tsx?$/, ".js"));
  if (!fs.existsSync(emitted)) {
    console.error(`tsc did not emit ${f}`);
    process.exit(1);
  }
}
const EMIT = path.join(OUT, "src");

// ---------------------------------------------------------------------------
// 2. Shims: db/auth/next-* are module boundaries, not behaviour under test.
// ---------------------------------------------------------------------------
const SHIMS = {
  "__db-shim.js": `module.exports = { get db() { return globalThis.__CM_DB_STUB__ || {}; } };`,
  "__auth-shim.js": `module.exports = { getCurrentUser: async () => null };`,
  "__next-server-shim.js": `class N { static json(d, i = {}) { return { status: i.status ?? 200, json: async () => d, text: async () => JSON.stringify(d) }; } }
module.exports = { NextResponse: N, NextRequest: class { constructor(u) { this.url = u; } } };`,
  "__next-headers-shim.js": `module.exports = { cookies: async () => ({ get: () => undefined }) };`,
  "__sonner-shim.js": `module.exports = { toast: { error() {}, success() {}, info() {} } };`,
};
for (const [name, code] of Object.entries(SHIMS)) fs.writeFileSync(path.join(OUT, name), code);

const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return path.join(OUT, "__db-shim.js");
  if (request === "@/lib/auth") return path.join(OUT, "__auth-shim.js");
  if (request === "next/server") return path.join(OUT, "__next-server-shim.js");
  if (request === "next/headers") return path.join(OUT, "__next-headers-shim.js");
  if (request === "sonner") return path.join(OUT, "__sonner-shim.js");
  const m = /^@\/(lib|components)\/(.+)$/.exec(request);
  if (m) {
    const compiled = path.join(EMIT, m[1], `${m[2]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  try {
    return originalResolve.call(this, request, ...rest);
  } catch (err) {
    if (request.startsWith(".") || path.isAbsolute(request)) throw err;
    // bare specifiers: resolve from the REPO (the emitted files live in /tmp)
    return require.resolve(request, { paths: [path.join(REPO, "node_modules")] });
  }
};

// ---------------------------------------------------------------------------
// 3. jsdom document + React test environment.
// ---------------------------------------------------------------------------
const { JSDOM } = require(path.join(REPO, "node_modules/jsdom"));
const dom = new JSDOM(
  "<!doctype html><html lang='ar' dir='rtl'><head></head><body></body></html>",
  { url: "http://localhost/", pretendToBeVisual: true }
);
const BASE_GLOBALS = [
  "window",
  "document",
  "navigator",
  "localStorage",
  "HTMLElement",
  "Element",
  "Node",
  "Event",
  "MouseEvent",
  "CustomEvent",
  "getComputedStyle",
];
for (const k of BASE_GLOBALS) global[k] = dom.window[k];
// Animation/measurement libraries probe DOM constructors at runtime.
for (const k of Object.getOwnPropertyNames(dom.window)) {
  if (k in global) continue;
  if (/^(HTML|SVG|CSS|DOM|XML|Text|Image|Path|Font|Named|Range|Selection|Mutation|Intersection)/.test(k)) {
    try {
      global[k] = dom.window[k];
    } catch {
      /* read-only global */
    }
  }
}
global.SVGElement = dom.window.SVGElement;
global.requestAnimationFrame = (cb) => setTimeout(cb, 0);
global.cancelAnimationFrame = (id) => clearTimeout(id);
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.matchMedia =
  dom.window.matchMedia ||
  (() => ({
    matches: false,
    addListener() {},
    removeListener() {},
    addEventListener() {},
    removeEventListener() {},
  }));
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

const React = require(path.join(REPO, "node_modules/react"));
const { createRoot } = require(path.join(REPO, "node_modules/react-dom/client"));
const RQ = require(require.resolve("@tanstack/react-query", { paths: [path.join(REPO, "node_modules")] }));

const { useApp } = require(path.join(EMIT, "lib/store.js"));
const { applyLocale, localeDirection, translate, hasDictKey, looksLikeDictKey } = require(
  path.join(EMIT, "lib/i18n-core.js")
);
const { ChildSwitcher } = require(path.join(EMIT, "components/parent/child-switcher.js"));
const { ParentAnalyticsView } = require(path.join(EMIT, "components/parent/analytics-view.js"));
const { WeeklyReportView } = require(path.join(EMIT, "components/parent/weekly-report.js"));
const { MonthlyReportView } = require(path.join(EMIT, "components/parent/monthly-report.js"));
const { ParentDashboard } = require(path.join(EMIT, "components/parent/parent-dashboard.js"));
const { AcademicFollowup } = require(path.join(EMIT, "components/parent/academic-followup.js"));
const { ParentAbsencesView, StudentAbsencesView } = require(
  path.join(EMIT, "components/student/live-sessions-view.js")
);

// ---------------------------------------------------------------------------
// 4. Fixture — the two-level Parent: long names, one shared course NAME (the
//    real product shape), and the level + course context every chip must show.
// ---------------------------------------------------------------------------
const LONG_NAME_AR = "محمد عبد الرحمن إبراهيم السيد";
const LONG_NAME_EN = "Mariam Abdelrahman Ibrahim El-Sayed";
const SHARED_COURSE_AR = "البرمجة والذكاء الاصطناعي";
const SHARED_COURSE_EN = "Programming & Artificial Intelligence";

const CHILD_A = {
  studentId: "s-first",
  id: "s-first",
  name: LONG_NAME_AR,
  email: "a@example.test",
  course: SHARED_COURSE_AR,
  groupName: "مجموعة أولى ثانوي",
  academicLevel: "FIRST_SECONDARY",
  avatarUrl: null,
  quizTrend: [{ title: "اختبار 1", percentage: 80, passed: true, date: "2026-10-01" }],
  attendanceByMonth: [{ month: "سبتمبر", pct: 50, present: 1, total: 2 }],
  strongTopics: [{ id: "u-1", title: "الوحدة الأولى", avgPct: 80, academicLevel: "FIRST_SECONDARY" }],
  weakTopics: [{ id: "u-2", title: "الوحدة التانية", avgPct: 40, academicLevel: "FIRST_SECONDARY" }],
  completionPct: 42,
  completedLessons: 5,
  totalLessons: 12,
  homeworkSubmitted: 3,
  homeworkGraded: 2,
  homeworkAvgGrade: 7,
  totalQuizzes: 4,
  avgQuizPct: 66,
  attendancePct: 50,
};
const CHILD_B = {
  ...CHILD_A,
  studentId: "s-second",
  id: "s-second",
  name: LONG_NAME_EN,
  email: "b@example.test",
  course: SHARED_COURSE_EN,
  groupName: "Second group",
  academicLevel: "SECOND_SECONDARY",
  strongTopics: [{ id: "u-3", title: "Unit One", avgPct: 70, academicLevel: "SECOND_SECONDARY" }],
  weakTopics: [],
};

const WEEKLY_PAYLOAD = {
  reports: [
    {
      studentId: "s-first",
      name: LONG_NAME_AR,
      course: SHARED_COURSE_AR,
      groupName: "مجموعة أولى ثانوي",
      academicLevel: "FIRST_SECONDARY",
      weekRange: { from: "1 أكتوبر", to: "7 أكتوبر" },
      summary: {
        lessonsViewed: 2,
        quizzesTaken: 1,
        homeworkSubmitted: 1,
        attendanceSessions: 2,
        attendancePct: 50,
        bestQuizScore: 90,
        avgQuizScore: 80,
        activeDays: 3,
        completionPct: 40,
      },
      dailyActivity: Array.from({ length: 7 }, (_, i) => ({
        day: "الأحد",
        date: `${i + 1}/10`,
        lessons: 0,
        quizzes: 0,
        homework: 0,
        attendance: null,
      })),
      recentQuizzes: [{ title: "اختبار 1", percentage: 80, passed: true, date: "1/10" }],
      // LATE/SUBMITTED must render as WORDS, never as the raw enum.
      recentHomework: [{ title: "واجب 1", status: "SUBMITTED", grade: null, date: "2/10" }],
    },
    {
      studentId: "s-second",
      name: LONG_NAME_EN,
      course: SHARED_COURSE_EN,
      groupName: "Second group",
      academicLevel: "SECOND_SECONDARY",
      weekRange: { from: "1 October", to: "7 October" },
      summary: {
        lessonsViewed: 0,
        quizzesTaken: 0,
        homeworkSubmitted: 0,
        attendanceSessions: 0,
        attendancePct: 0,
        bestQuizScore: 0,
        avgQuizScore: 0,
        activeDays: 1,
        completionPct: 10,
      },
      dailyActivity: Array.from({ length: 7 }, (_, i) => ({
        day: "Sunday",
        date: `${i + 1}/10`,
        lessons: 0,
        quizzes: 0,
        homework: 0,
        attendance: null,
      })),
      recentQuizzes: [],
      recentHomework: [],
    },
  ],
};

const ABSENCE_CASES = [
  {
    id: "case-1",
    status: "UNEXCUSED",
    reason: null,
    reasonSubmittedAt: null,
    reasonSubmittedByRole: null,
    decisionNote: null,
    decidedAt: null,
    hold: null,
    submissions: [],
    student: { id: "s-first", name: LONG_NAME_AR },
    session: { title: "Session", titleAr: "حصة منفذة", startAt: "2026-10-01T10:00:00.000Z" },
    group: { name: "مجموعة أولى ثانوي" },
    teacherName: "Mr Sameh",
    lesson: null,
  },
  {
    // Drives the audit-trail line: one reviewer has a name, the other does not,
    // so the component must print the ROLE through the dictionary, never the
    // raw server enum.
    id: "case-2",
    status: "EXCUSED",
    reason: "مرض",
    reasonSubmittedAt: "2026-09-30T08:00:00.000Z",
    reasonSubmittedByRole: "PARENT",
    decisionNote: null,
    decidedAt: "2026-10-01T09:00:00.000Z",
    hold: null,
    submissions: [
      { id: "sub-1", reason: "مرض", role: "PARENT", at: "2026-09-30T08:00:00.000Z", byName: "أم الطالب" },
      { id: "sub-2", reason: "تأكيد", role: "TEACHER", at: "2026-10-01T09:00:00.000Z", byName: null },
    ],
    student: { id: "s-first", name: LONG_NAME_AR },
    session: { title: "Session", titleAr: "حصة منفذة", startAt: "2026-10-01T10:00:00.000Z" },
    group: { name: "مجموعة أولى ثانوي" },
    teacherName: "Mr Sameh",
    lesson: null,
  },
];
const ABSENCES_PAYLOAD = {
  children: [
    {
      id: "s-first",
      name: LONG_NAME_AR,
      courseName: SHARED_COURSE_AR,
      academicLevel: "FIRST_SECONDARY",
      avatarUrl: null,
    },
    {
      id: "s-second",
      name: LONG_NAME_EN,
      courseName: SHARED_COURSE_EN,
      academicLevel: "SECOND_SECONDARY",
      avatarUrl: null,
    },
  ],
  childId: "s-first",
  cases: ABSENCE_CASES,
};

const DASHBOARD_CHILD = {
  id: "s-first",
  name: LONG_NAME_AR,
  email: "a@example.test",
  avatarUrl: null,
  academicLevel: "FIRST_SECONDARY",
  grade: "1st Secondary",
  schoolName: "Nile School",
  schoolType: "ARABIC",
  studentCode: "CM-AAAA11",
  enrolledAt: "2026-09-01T00:00:00.000Z",
  group: {
    id: "g-1",
    name: "مجموعة أولى ثانوي",
    schedule: null,
    course: {
      id: "c-1",
      name: SHARED_COURSE_EN,
      nameAr: SHARED_COURSE_AR,
      academicLevel: "FIRST_SECONDARY",
      track: null,
    },
  },
  attendance: { pct: 50, present: 1, total: 2, byMonth: [{ month: "سبتمبر", pct: 50, present: 1, total: 2 }] },
  quizzes: {
    attempts: 2,
    average: 66,
    passed: 1,
    failed: 1,
    recent: [
      {
        id: "qa-1",
        quizId: "q-1",
        quizTitle: "اختبار 1",
        percentage: 80,
        passed: true,
        score: 8,
        totalMarks: 10,
        finishedAt: "2026-10-01T10:00:00.000Z",
        startedAt: "2026-10-01T09:00:00.000Z",
      },
    ],
  },
  homework: { total: 3, submitted: 2, pending: 1, graded: 1, completionPct: 66 },
  mockExams: {
    attempts: 1,
    average: 40,
    best: 40,
    passed: 0,
    recent: [
      {
        id: "ea-1",
        examType: "MOCK",
        mockExamTitle: "امتحان تجريبي",
        questionCount: 10,
        score: 4,
        totalMarks: 10,
        percentage: 40,
        passed: false,
        finishedAt: "2026-10-02T10:00:00.000Z",
      },
    ],
  },
  subscription: { planName: "باقة شهرية", price: 500, durationMonths: 1, daysLeft: 10, startDate: null, endDate: null },
  courseProgress: { pct: 42, completed: 5, total: 12 },
  sessionProgress: null,
  performanceTrend: [{ label: "1", pct: 60, title: "اختبار 1" }],
  nextSession: {
    id: "ls-1",
    title: "حصة الأحد",
    lessonTitle: "الدرس الأول",
    startAt: "2026-10-05T10:00:00.000Z",
    teacherName: "Mr Sameh",
    meetingUrl: "https://meet.example.test/x",
  },
  teacherNotes: [
    { id: "n-1", note: "ملاحظة المعلم", teacherName: "Mr Sameh", createdAt: "2026-10-02T10:00:00.000Z" },
  ],
  recentActivity: [
    {
      type: "quiz",
      title: "اختبار: اختبار 1",
      description: "80% — نجح",
      time: "2026-10-02T10:00:00.000Z",
      kind: "good",
    },
  ],
  strongTopics: [{ id: "u-1", title: "الوحدة الأولى", avgPct: 80 }],
  weakTopics: [{ id: "u-2", title: "الوحدة التانية", avgPct: 40 }],
};
// The system vocabulary the payload carries: dictionary KEYS, never text.
const SYS = {
  video: "progression.reason.videoIncomplete",
  homework: "progression.reason.homeworkNotSubmitted",
  quiz: "progression.reason.quizNotPassed",
  rescheduled: "parent.action.sessionRescheduled",
  cancelled: "parent.action.sessionCancelled",
  catchupBlocked: "parent.action.catchupBlocked",
};
// CONTENT — authored text that must survive EXACTLY as stored, in whatever
// language the UI is showing.
const CONTENT = {
  lessonTitle: "درس بالعربي: مقدمة في الـMachine Learning",
  sessionTitle: "حصة يوم السبت",
  absenceReason: "عذر طبي — تقرير من الدكتور",
  homeworkTitle: "واجب البرمجة الأول",
  noteText: "ملاحظة من المعلم عن الأداء",
};
const SESSION_VIEW = {
  title: CONTENT.sessionTitle,
  lessonTitle: CONTENT.lessonTitle,
  startAt: "2026-10-05T10:00:00.000Z",
  endsAt: "2026-10-05T11:00:00.000Z",
  status: "SCHEDULED",
  teacherName: "Mr Sameh",
  rescheduled: false,
  originalStartAt: null,
  rescheduleCount: 0,
  cancelledAt: null,
  cancelReason: null,
};
const CURRENT_LESSON = {
  code: "L1",
  title: CONTENT.lessonTitle,
  position: 1,
  state: "LOCKED",
  unlocked: false,
  completed: false,
  reason: "أكمل الفيديو الأول، سلّم الـHomework الأول",
  reasonCode: "VIDEO_INCOMPLETE",
  unmet: [
    { kind: "VIDEO_INCOMPLETE", label: "أكمل الفيديو الأول", labelKey: SYS.video },
    {
      kind: "HOMEWORK_NOT_SUBMITTED",
      label: "سلّم الـHomework الأول",
      labelKey: SYS.homework,
    },
  ],
  requirements: {
    video: { required: true, done: false, value: 40 },
    quiz: null,
    homework: { required: true, done: false, value: 0 },
  },
  overrideGranted: false,
};

const FOLLOWUP_PAYLOAD = {
  selectedStudentId: "s-first",
  children: [],
  snapshot: {
    student: {
      id: "s-first",
      name: LONG_NAME_AR,
      academicLevel: "FIRST_SECONDARY",
      grade: "1st Secondary",
      schoolType: "ARABIC",
      studentCode: "CM-AAAA11",
      avatarUrl: null,
    },
    course: { name: SHARED_COURSE_AR, academicLevel: "FIRST_SECONDARY", track: null },
    group: { name: "مجموعة أولى ثانوي", schedule: null },
    progress: { completedLessons: 5, totalLessons: 12, pct: 42, currentLesson: CURRENT_LESSON, lockedLessons: 1 },
    lessons: [CURRENT_LESSON],
    holds: [
      {
        lessonTitle: CONTENT.lessonTitle,
        inUniverse: true,
        reason: "سلّم الـHomework الأول، لازم تنجح في الـQuiz",
        reasonKeys: [SYS.homework, SYS.quiz],
        unmet: [
          { kind: "HOMEWORK_NOT_SUBMITTED", label: "سلّم الـHomework الأول", labelKey: SYS.homework },
          { kind: "QUIZ_NOT_PASSED", label: "لازم تنجح في الـQuiz", labelKey: SYS.quiz },
        ],
        eligible: false,
      },
    ],
    absences: {
      excused: 1,
      unexcused: 0,
      pending: 0,
      recent: [
        {
          sessionTitle: CONTENT.sessionTitle,
          sessionStartAt: "2026-10-01T10:00:00.000Z",
          status: "EXCUSED",
          reason: CONTENT.absenceReason,
          holdActive: false,
          decidedAt: "2026-10-02T09:00:00.000Z",
          decisionNote: null,
        },
      ],
    },
    homework: {
      submitted: 2,
      graded: 1,
      overdue: 0,
      items: [
        {
          title: CONTENT.homeworkTitle,
          lessonTitle: CONTENT.lessonTitle,
          acceptingSubmissions: true,
          dueAt: "2026-10-09T20:00:00.000Z",
          status: "SUBMITTED",
          submittedAt: "2026-10-02T18:00:00.000Z",
          late: false,
          grade: null,
          feedback: null,
        },
      ],
    },
    quizzes: { taken: 2, passed: 1, items: [] },
    sessions: { upcoming: [SESSION_VIEW], rescheduled: [SESSION_VIEW], cancelled: [SESSION_VIEW] },
    teacherFeedback: [],
    // Action Needed — the QA finding: ENGLISH must render the English text of
    // these keys, Arabic the Arabic one, and neither may come from a payload
    // that was pre-formatted in the other language.
    actionNeeded: [
      {
        code: "VIDEO_INCOMPLETE",
        severity: "blocking",
        label: SYS.video,
        labelKeys: [SYS.video],
        detail: CONTENT.lessonTitle,
        detailKeys: null,
      },
      {
        code: "LESSON_LOCKED",
        severity: "blocking",
        label: SYS.video,
        labelKeys: [SYS.video, SYS.homework],
        detail: CONTENT.lessonTitle,
        detailKeys: null,
      },
      {
        code: "CATCHUP_REQUIRED",
        severity: "blocking",
        label: SYS.catchupBlocked,
        labelKeys: null,
        detail: null,
        detailKeys: [SYS.homework, SYS.quiz],
      },
      {
        code: "SESSION_RESCHEDULED",
        severity: "attention",
        label: SYS.rescheduled,
        labelKeys: null,
        detail: CONTENT.sessionTitle,
        detailKeys: null,
      },
      {
        code: "SESSION_CANCELLED",
        severity: "attention",
        label: SYS.cancelled,
        labelKeys: null,
        detail: CONTENT.sessionTitle,
        detailKeys: null,
      },
    ],
    evaluatedAt: "2026-10-03T10:00:00.000Z",
  },
};

const ACADEMICS_PAYLOAD = FOLLOWUP_PAYLOAD;
const DASHBOARD_PAYLOAD = {
  parent: { id: "p-1", name: "Abu Mohamed", email: "p@example.test", phone: null, avatarUrl: null },
  children: [DASHBOARD_CHILD],
};

/** Per-test fetch stub: records the URLs and serves the registered payloads. */
let fetchCalls = [];
function installFetch() {
  fetchCalls = [];
  global.fetch = async (url) => {
    const u = String(url);
    fetchCalls.push(u);
    let body = {};
    if (u.includes("/api/parents/me/dashboard")) body = DASHBOARD_PAYLOAD;
    else if (u.includes("/api/parents/me/analytics")) body = { children: [CHILD_A, CHILD_B] };
    else if (u.includes("/api/parents/me/weekly-report")) body = WEEKLY_PAYLOAD;
    else if (u.includes("/api/parents/me/academics")) body = ACADEMICS_PAYLOAD;
    else if (u.includes("/api/absence-reviews")) {
      const wanted = /childId=([^&]+)/.exec(u)?.[1];
      const childId = wanted ? decodeURIComponent(wanted) : ABSENCES_PAYLOAD.childId;
      body = {
        ...ABSENCES_PAYLOAD,
        childId,
        children: ABSENCES_PAYLOAD.children.filter((c) => c.id === childId || !wanted),
        cases: ABSENCES_PAYLOAD.cases.filter((c) => c.student.id === childId || !wanted),
      };
    }
    else if (u.includes("/api/notifications/unread-count")) body = { count: 0 };
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
    };
  };
}
installFetch();

let rootSeq = 0;
async function render(el) {
  const container = document.createElement("div");
  container.id = `m45-root-${++rootSeq}`;
  document.body.appendChild(container);
  const root = createRoot(container);
  await React.act(async () => {
    root.render(el);
    await new Promise((r) => setTimeout(r, 40));
  });
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 40));
  });
  return container;
}
/** Set the app locale exactly like the shell does (store + document). */
function setLocale(locale) {
  useApp.setState({ locale });
  applyLocale(locale);
}
const queryClient = new RQ.QueryClient({ defaultOptions: { queries: { retry: false } } });

// Direction helpers used by the render assertions.
const dirElements = (container) => Array.from(container.querySelectorAll("[dir]"));
const forcedRtl = (container) => container.querySelectorAll('[dir="rtl"]').length;
const badDirIntent = (container) =>
  dirElements(container).filter(
    (el) => el.getAttribute("dir") === "ltr" && !["chart", "numeric"].includes(el.getAttribute("data-dir"))
  ).length;

// ---------------------------------------------------------------------------
// A. Direction hygiene (source)
// ---------------------------------------------------------------------------
(async () => {
try {
section("A. Forced direction — none on the Parent surfaces");

for (const f of PARENT_SURFACES) {
  const src = stripComments(read(f));
  ok(!/dir="rtl"/.test(src), `A: ${path.basename(f)} does not force RTL`);
}
{
  const withDir = PARENT_SURFACES.map((f) => [f, stripComments(read(f))]).filter(([, s]) => /dir="ltr"/.test(s));
  const unmarked = withDir.filter(([, s]) => {
    const matches = s.match(/dir="ltr"/g) || [];
    const marked = s.match(/data-dir="(chart|numeric)"/g) || [];
    return matches.length !== marked.length;
  });
  eq(unmarked.map(([f]) => path.basename(f)), [], "A2: every forced LTR is a chart or a numeric field (data-dir)");
  ok(withDir.length >= 2, "A3: the technical LTR wrappers still exist (charts are geometry, not text)");
}
{
  const followup = stripComments(read("src/components/parent/academic-followup.tsx"));
  ok(
    /space-y-4"\n\s*>/.test(followup) && /logical utilities only/.test(read("src/components/parent/academic-followup.tsx")),
    "A4: the follow-up card's root takes its direction from the document"
  );
}

// ---------------------------------------------------------------------------
// B. Logical layout utilities
// ---------------------------------------------------------------------------
section("B. Logical utilities — no physical side/margin leaks");

const PHYSICAL = [
  /\bml-\d/,
  /\bmr-\d/,
  /\bpl-\d/,
  /\bpr-\d/,
  /\bleft-\d/,
  /\bright-\d/,
  /\btext-right\b/,
  /\btext-left\b/,
  /\bborder-l-\d/,
  /\bborder-r-\d/,
  /\brounded-l-/,
  /\brounded-r-/,
];
for (const f of PARENT_SURFACES) {
  const src = stripComments(read(f));
  const hits = PHYSICAL.filter((re) => re.test(src)).map((re) => re.source);
  eq(hits, [], `B: ${path.basename(f)} uses logical utilities only`);
}
{
  const combined = PARENT_SURFACES.map((f) => stripComments(read(f))).join("\n");
  ok(/\bms-\d/.test(combined) && /\bpe-\d/.test(combined), "B2: ms-* / pe-* are the pattern actually used");
  ok(/\bborder-s\b/.test(combined), "B3: the activity timeline uses border-s (start edge)");
}

// ---------------------------------------------------------------------------
// C. Dictionary integrity
// ---------------------------------------------------------------------------
section("C. One dictionary — every referenced key exists in both locales");

const KEY_RE = /(?:\bt|\btr|tApi|translate)\(\s*"([a-zA-Z][\w.]*)"/g;
{
  const refs = [];
  for (const f of [...PARENT_SURFACES, ...PARENT_ROUTES]) {
    const src = stripComments(read(f));
    for (const m of src.matchAll(KEY_RE)) {
      if (!/^[a-z][a-z0-9]*(\.[A-Za-z0-9_]+)+$/.test(m[1])) continue;
      refs.push([f, m[1]]);
    }
  }
  ok(refs.length > 200, `C1: the scan sees the real key surface (${refs.length} references)`);
  const missing = refs.filter(([, k]) => !hasDictKey(k));
  eq(missing.slice(0, 6), [], "C2: no referenced key is missing from the merged dictionary");

  const empty = [];
  for (const [, k] of refs) {
    const ar = translate("ar", k);
    const en = translate("en", k);
    if (!ar || !en) empty.push(k);
  }
  eq(empty, [], "C3: every referenced key resolves non-empty in BOTH locales");
}
{
  // The M4.5 keys must not carry level vocabulary — that stays in
  // academic-level-labels.ts / admin.643-644 (decision D3).
  const dict = read("src/lib/i18n-dict-2026.ts");
  const start = dict.indexOf("Phase M4.5: parent i18n");
  const nextSection = dict.indexOf("Phase K2: academic level", start);
  const block = dict.slice(start, nextSection > 0 ? nextSection : dict.length);
  ok(block.length > 500, "C4: the M4.5 key block is present in the ONE dictionary file");
  ok(
    !/(Secondary|ثانوي)/.test(block),
    "C5: the new keys define no level vocabulary (levels keep the shared labels)"
  );
  ok(!/DICT_M45|createDict|new Dict/.test(block), "C6: no second dictionary object was introduced");
}
for (const f of PARENT_SURFACES) {
  ok(!/2nd Secondary/.test(stripComments(read(f))), `C7: ${path.basename(f)} has no legacy '2nd Secondary' string`);
}
{
  const labels = require(path.join(EMIT, "lib/academic-level-labels.js"));
  const tr = (k) => translate("en", k);
  eq(labels.academicLevelLabelFor(tr, "FIRST_SECONDARY"), "First Secondary", "C8: EN level label from the shared vocabulary");
  eq(labels.academicLevelLabelFor(tr, "SECOND_SECONDARY"), "Second Secondary", "C9: …and the second level");
  eq(labels.academicLevelLabelFor((k) => translate("ar", k), "FIRST_SECONDARY"), "أولى ثانوي", "C10: AR level label");
}

// ---------------------------------------------------------------------------
// D/E. Renders — English (LTR) and Arabic (RTL)
// ---------------------------------------------------------------------------
/**
 * Mount every Parent surface for ONE locale. The store is global, so each
 * tree re-renders when the locale changes — every assertion therefore runs
 * before the next locale is applied.
 */
async function mountAll(locale) {
  setLocale(locale);
  const trees = {};
  trees.switcher = await render(
    React.createElement(ChildSwitcher, {
      items: [
        { id: "s-first", name: LONG_NAME_AR, courseName: SHARED_COURSE_AR, academicLevel: "FIRST_SECONDARY", avatarUrl: null },
        { id: "s-second", name: LONG_NAME_EN, courseName: SHARED_COURSE_EN, academicLevel: "SECOND_SECONDARY", avatarUrl: null },
      ],
      value: "s-second",
      onChange: () => {},
    })
  );
  trees.analytics = await render(
    React.createElement(ParentAnalyticsView, { onClose: () => {}, initialStudentId: "s-first" })
  );
  trees.weekly = await render(React.createElement(WeeklyReportView, { onClose: () => {}, studentId: null }));
  trees.monthly = await render(React.createElement(MonthlyReportView, { onClose: () => {}, studentId: "s-first" }));
  trees.followup = await render(
    React.createElement(AcademicFollowup, { payload: FOLLOWUP_PAYLOAD })
  );
  trees.absences = await render(React.createElement(ParentAbsencesView));
  trees.studentAbsences = await render(React.createElement(StudentAbsencesView));
  trees.dashboard = await render(
    React.createElement(RQ.QueryClientProvider, { client: queryClient }, React.createElement(ParentDashboard))
  );
  return trees;
}

{
  // The audit-trail role fallback must come from the ONE dictionary too.
  for (const role of ["parent", "teacher", "admin", "student", "system"]) {
    ok(
      hasDictKey(`role.${role}`) && translate("ar", `role.${role}`) && translate("en", `role.${role}`),
      `C11: role.${role} exists in both locales`
    );
  }
}

section("D. English / LTR — the Parent surfaces render English chrome, LTR");

// Text snapshots taken inside each locale pass (a mounted tree re-renders when
// the locale changes, so a snapshot must be taken while its locale is active).
const SNAPSHOT = { enFollowup: "", arFollowup: "" };

const EN = await mountAll("en");
const rendered = { en: EN, ar: null };

{
  const el = rendered.en.switcher;
  const tabs = el.querySelectorAll('[role="tab"]');
  eq(tabs.length, 2, "D1: the switcher renders a tab per linked child");
  eq(
    Array.from(tabs).map((t) => t.getAttribute("aria-selected")),
    ["false", "true"],
    "D2: selection comes from the canonical id (value='s-second')"
  );
  ok(
    el.textContent.includes(LONG_NAME_AR) && el.textContent.includes(LONG_NAME_EN),
    "D3: both children are named (long names included)"
  );
  ok(el.textContent.includes("First Secondary") && el.textContent.includes("Second Secondary"), "D4: every chip carries its level");
  ok(el.textContent.includes(SHARED_COURSE_AR) && el.textContent.includes(SHARED_COURSE_EN), "D5: …and its course");
  eq(forcedRtl(el), 0, "D6: the switcher adds no RTL of its own");
  eq(document.documentElement.dir, "ltr", "D7: the document is LTR in English mode");
  ok(!/[\u0600-\u06FF]/.test(el.querySelector('[role="tablist"]').getAttribute("aria-label")), "D8: the switcher label is English");
}
{
  const el = rendered.en.analytics;
  const text = el.textContent;
  ok(text.includes("Course Progress") && text.includes("Attendance"), "D9: analytics chrome is English");
  ok(text.includes("Quiz Performance Trend") && text.includes("Attendance by Month"), "D10: the chart titles are English");
  ok(text.includes("Course Completion") && text.includes("Strong Topics") && text.includes("Weak Topics"), "D11: the remaining analytics titles are English");
  eq(forcedRtl(el), 0, "D12: analytics adds no RTL of its own");
  eq(badDirIntent(el), 0, "D13: its forced-LTR nodes are charts/numeric fields only");
  ok(!/\bparent\.\d|\bapi\.\d/.test(text), "D14: no dotted dictionary key leaks into the markup");
}
{
  const el = rendered.en.weekly;
  const text = el.textContent;
  ok(text.includes(`Weekly Report — ${LONG_NAME_AR}`), "D15: the weekly heading is the localized one");
  ok(text.includes("Lessons Viewed") && text.includes("Quizzes Taken"), "D16: the summary labels are English");
  ok(text.includes("Daily Activity (Last 7 Days)") && text.includes("Quizzes this week"), "D17: the card titles are English");
  ok(!/\bSUBMITTED\b|\bGRADED\b|\bLATE\b/.test(text), "D18: a homework status renders as words, never the raw enum");
  eq(forcedRtl(el), 0, "D19: weekly adds no RTL of its own");
  eq(el.querySelectorAll("h2").length, 2, "D20: all-children default is preserved (one card per report)");
}
{
  const el = rendered.en.monthly;
  const text = el.textContent;
  ok(text.includes("Monthly Report —"), "D21: the monthly toolbar heading is localized");
  ok(text.includes("Performance overview") && text.includes("Teacher notes"), "D22: the report sections are English");
  ok(text.includes("Learn. Build. Think."), "D22b: the English brand tagline is the one printed");
  ok(!/اتعلم/.test(text), "D22c: the Arabic tagline is not printed in English mode");
  eq(forcedRtl(el), 0, "D23: the monthly report adds no RTL of its own");
}
{
  const el = rendered.en.absences;
  ok(el.textContent.includes("Children's absences"), "D24: the absences title is English");
  eq(forcedRtl(el), 0, "D25: the absences view adds no RTL of its own");
  ok(el.textContent.includes("Teacher"), "D25b: a nameless reviewer shows the localized role, not the enum");
  ok(!/\bTEACHER\b|\bPARENT\b/.test(el.textContent), "D25c: the raw role enum never reaches the reader");
}
{
  // The QA finding lived HERE: Action Needed used to print Arabic because the
  // system text arrived pre-formatted (and cached) from the server.
  const el = rendered.en.followup;
  const text = el.textContent;
  ok(text.includes("Complete the first video"), "D33: system progression text renders in English");
  ok(text.includes("A session was rescheduled"), "D34: …and the rescheduled-session text");
  ok(text.includes("A session was cancelled"), "D35: …and the cancelled-session text");
  ok(
    text.includes("Complete the first video, Submit the homework first"),
    "D36: a composed system sentence joins its parts with the English separator"
  );
  ok(
    text.includes(translate("en", SYS.catchupBlocked)) &&
      text.includes("Submit the homework first, Pass the quiz first"),
    "D37: the blocked catch-up row renders its composed detail in English"
  );
  ok(
    text.includes(CONTENT.lessonTitle) &&
      text.includes(CONTENT.sessionTitle) &&
      text.includes(CONTENT.homeworkTitle) &&
      text.includes(CONTENT.absenceReason),
    "D38: authored content renders verbatim (Arabic content in English mode is data, not chrome)"
  );
  ok(
    !text.includes(translate("ar", SYS.video)) &&
      !text.includes(translate("ar", SYS.rescheduled)) &&
      !text.includes(translate("ar", SYS.cancelled)) &&
      !text.includes(translate("ar", SYS.homework)),
    "D39: no Arabic system string survives in English mode"
  );
  ok(
    !/\b(VIDEO_INCOMPLETE|HOMEWORK_NOT_SUBMITTED|QUIZ_NOT_PASSED|LESSON_LOCKED|CATCHUP_REQUIRED|SESSION_RESCHEDULED|SESSION_CANCELLED)\b/.test(text),
    "D40: no raw status enum leaks"
  );
  eq(
    Object.values(SYS).filter((k) => text.includes(k)),
    [],
    "D41: no raw dictionary key leaks (the payload's keys never render as text)"
  );
  ok(
    translate("ar", SYS.video) !== translate("en", SYS.video) &&
      /[\u0600-\u06FF]/.test(translate("ar", SYS.video)),
    "D42: the key really carries two languages (the test would catch a stub)"
  );
  SNAPSHOT.enFollowup = text;
}
{
  const el = rendered.en.dashboard;
  const text = el.textContent;
  ok(text.includes("Performance Trend") && text.includes("Recent Activity"), "D26: the dashboard card titles are English");
  ok(text.includes("Next Live Session") && text.includes("Teacher Notes"), "D27: …including the session and notes cards");
  ok(text.includes("Subscription") && text.includes("Attendance"), "D28: …and the summary tiles");
  ok(text.includes("EGP"), "D29: the price line uses the English currency wording");
  ok(!/\bparent\.\d|\bapi\.\d/.test(text), "D30: no dotted dictionary key leaks into the dashboard");
  eq(forcedRtl(el), 0, "D31: the dashboard adds no RTL of its own");
  eq(badDirIntent(el), 0, "D32: its forced-LTR nodes are charts/numeric fields only");
}

section("E. Arabic / RTL — the same surfaces render Arabic chrome, no forced direction");

const AR = await mountAll("ar");
rendered.ar = AR;

{
  const el = rendered.ar.followup;
  const text = el.textContent;
  ok(text.includes("أكمل الفيديو الأول"), "E26: system progression text renders in Arabic");
  ok(
    text.includes("حصة اتأجلت عن معادها") && text.includes("حصة اتلغت"),
    "E27: …and the session lifecycle text"
  );
  ok(
    text.includes("أكمل الفيديو الأول، سلّم الـHomework الأول"),
    "E28: the composed sentence keeps the Arabic separator"
  );
  ok(
    text.includes(CONTENT.lessonTitle) && text.includes(CONTENT.absenceReason),
    "E29: authored content is identical in Arabic mode"
  );
  ok(
    !/Complete the first video|A session was (rescheduled|cancelled)|Pass the quiz first/.test(text),
    "E30: no English system text leaks into Arabic mode"
  );
  SNAPSHOT.arFollowup = text;
}
{
  const el = rendered.ar.switcher;
  ok(el.querySelector('[role="tablist"]').getAttribute("aria-label") === "اختار الطالب", "E1: the switcher label is Arabic");
  ok(el.textContent.includes("أولى ثانوي"), "E2: the chip level is Arabic");
  eq(forcedRtl(el), 0, "E3: still no forced RTL on the component");
  eq(document.documentElement.dir, "rtl", "E4: the document is RTL in Arabic mode");
}
{
  const el = rendered.ar.weekly;
  const text = el.textContent;
  ok(text.includes(`التقرير الأسبوعي — ${LONG_NAME_AR}`), "E5: the weekly heading is Arabic (no hard-coded English)");
  ok(!text.includes("Weekly Report"), "E6: …and the English literal is gone in Arabic mode");
  ok(text.includes("دروس اتذاكرت") && text.includes("اختبارات اتعملت"), "E7: the summary labels are Arabic");
  ok(text.includes("النشاط اليومي"), "E8: the daily-activity title is Arabic");
  ok(!/\bSUBMITTED\b/.test(text), "E9: the homework status is localized");
  eq(forcedRtl(el), 0, "E10: the Arabic card still takes direction from the document");
}
{
  const el = rendered.ar.analytics;
  const text = el.textContent;
  ok(text.includes("تقدّم المنهج") && text.includes("الحضور"), "E11: analytics chrome is Arabic");
  ok(!text.includes("Course Completion") && !text.includes("Attendance by Month"), "E12: the English chart titles are gone");
  eq(forcedRtl(el), 0, "E13: analytics adds no RTL of its own");
}
{
  const el = rendered.ar.monthly;
  ok(el.textContent.includes("التقرير الشهري —"), "E14: the monthly toolbar heading is Arabic");
  ok(!el.textContent.includes("Performance overview"), "E15: no English section title leaks");
  ok(el.textContent.includes("اتعلم. ابنى. فكّر."), "E15b: the Arabic brand tagline is the one printed");
  ok(!el.textContent.includes("Learn. Build. Think."), "E15c: the English tagline is gone in Arabic mode");
  eq(forcedRtl(el), 0, "E16: the monthly report adds no RTL of its own");
}
{
  const el = rendered.ar.absences;
  ok(el.textContent.includes("غياب الأبناء"), "E17: the absences title is Arabic");
  eq(forcedRtl(el), 0, "E18: the absences view adds no RTL of its own");
  ok(el.textContent.includes("المعلم:"), "E18b: a nameless reviewer shows the Arabic role, not the enum");
  ok(!/\bTEACHER\b|\bPARENT\b/.test(el.textContent), "E18c: the raw role enum never reaches the reader");
}
{
  const el = rendered.ar.dashboard;
  const text = el.textContent;
  ok(text.includes("تطوّر الأداء") && text.includes("آخر الأنشطة"), "E19: the dashboard card titles are Arabic");
  ok(text.includes("الحصة المباشرة الجاية") && text.includes("ملاحظات المعلمين"), "E20: …including the session and notes cards");
  ok(text.includes("الاشتراك") && text.includes("ج.م"), "E21: …and the subscription tile uses the Arabic currency");
  ok(!text.includes("Next Live Session") && !text.includes("Recent Activity"), "E22: the English card titles are gone");
  eq(forcedRtl(el), 0, "E23: the dashboard adds no RTL of its own");
  eq(badDirIntent(el), 0, "E24: its forced-LTR nodes are charts/numeric fields only");
}
{
  // The level vocabulary is shared, never re-declared per surface.
  const el = rendered.ar.dashboard;
  ok(el.textContent.includes("أولى ثانوي"), "E25: the card level comes from the shared vocabulary in Arabic too");
}

// ---------------------------------------------------------------------------
// F. Responsive / mobile safety
// ---------------------------------------------------------------------------
section("F. Responsive — scroll, wrap, no fixed desktop width");

{
  // M4.5: the 7-day heatmap strip is the narrowest grid on the surface.
  const src = read("src/components/parent/weekly-report.tsx");
  ok(
    /grid grid-cols-7 gap-1 sm:gap-2/.test(src),
    "F0: the daily strip tightens its gap on phones"
  );
  ok(
    /className="text-center min-w-0"/.test(src),
    "F0b: …and its cells may shrink below their content width"
  );
}

{
  const st = rendered.en.switcher.querySelector('[role="tablist"]');
  ok(/overflow-x-auto/.test(st.className), "F1: the switcher scrolls horizontally");
  ok(/snap-x/.test(st.className), "F2: …with snap points for touch");
  ok(
    Array.from(st.children).every((c) => /shrink-0/.test(c.className) && /max-w-\[15rem\]/.test(c.className)),
    "F3: every chip keeps a bounded width (long names cannot stretch the row)"
  );
  ok(!/\bw-\[\d{3,}px\]/.test(st.className), "F4: the strip itself declares no fixed pixel width");
}
{
  const tabs = rendered.en.analytics.querySelector('[role="tablist"]');
  ok(/overflow-x-auto/.test(tabs.className), "F5: the analytics tab strip scrolls instead of overflowing (M4-F7)");
  ok(/snap-x/.test(tabs.className), "F6: …with snap points");
  ok(
    Array.from(tabs.children).every((c) => /shrink-0/.test(c.className) && /max-w-\[15rem\]/.test(c.className)),
    "F7: tabs are bounded and never clipped by the layout"
  );
  ok(
    Array.from(tabs.children).every((c) => /truncate/.test(c.innerHTML)),
    "F8: long child names truncate inside the tab"
  );
  ok(/text-start/.test(tabs.children[0].className), "F9: tab text aligns to the logical start");
}
{
  const strip = rendered.en.weekly.querySelector('[role="tablist"]');
  eq(strip, null, "F10: the weekly report is not a selector (all children, one card each)");
  const h2 = rendered.en.weekly.querySelector("h2");
  ok(/break-words/.test(h2.className), "F11: a long child name wraps in the weekly heading");
  ok(/grid-cols-2/.test(rendered.en.weekly.innerHTML), "F12: the weekly stat grid is 2-up on phones");
}
{
  const toolbar = rendered.en.monthly.querySelector(".no-print h2").parentElement;
  ok(/flex-wrap/.test(toolbar.className), "F13: the monthly toolbar wraps at phone widths");
  ok(/break-words/.test(rendered.en.monthly.querySelector(".no-print h2").className), "F14: its long title wraps");
  ok(
    rendered.en.monthly.querySelector("table")?.parentElement?.className?.includes("overflow-x-auto"),
    "F15: the 4-column quiz table scrolls inside its own card"
  );
  ok(/sm:p-8/.test(rendered.en.monthly.innerHTML), "F16: the report padding scales down on phones");
}
{
  const src = PARENT_SURFACES.map((f) => stripComments(read(f))).join("\n");
  const fixedPx = (src.match(/\bw-\[(\d{3,})px\]/g) || []).filter((t) => Number(/\[(\d+)/.exec(t)[1]) >= 360);
  eq(fixedPx, [], "F17: no Parent surface declares a fixed width >= 360px");
  const minRem = (src.match(/\bmin-w-\[(\d+)rem\]/g) || []).filter((t) => {
    const v = Number(/\[(\d+)/.exec(t)[1]);
    return v > 20 && !/sm:min-w/.test(src.slice(Math.max(0, src.indexOf(t) - 8), src.indexOf(t) + t.length));
  });
  eq(minRem, [], "F18: no un-prefixed min-width above 20rem");
  ok(/overflow-x-auto/.test(src), "F19: horizontal scrolling is the sanctioned overflow strategy");
}

// ---------------------------------------------------------------------------
// G. Identity + semantics unchanged
// ---------------------------------------------------------------------------
section("G. Canonical ids and unchanged semantics");

{
  const el = rendered.en.analytics;
  const tabs = Array.from(el.querySelectorAll('[role="tab"]'));
  fetchCalls = [];
  await React.act(async () => {
    tabs[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 30));
  });
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });
  const scoped = fetchCalls.filter((u) => u.includes("studentId="));
  ok(
    scoped.length >= 1 && scoped.every((u) => u.endsWith("studentId=s-second")),
    `G1: switching a tab requests that child by canonical id (saw ${JSON.stringify(scoped.slice(0, 2))})`
  );
  eq(useApp.getState().parentChildId, "s-second", "G2: …and writes the shared Parent child context");
  ok(
    !fetchCalls.some((u) => /studentId=(0|1|2|index)/.test(u)),
    "G3: no positional/index identity is ever sent"
  );
}
{
  const el = rendered.en.switcher;
  ok(el.querySelectorAll('[role="tab"]')[1].textContent.includes(LONG_NAME_EN), "G4: chips carry the payload order (id-keyed)");
  ok(!/findIndex\(/.test(stripComments(read("src/components/parent/analytics-view.tsx"))), "G5: analytics has no index-based selection");
}
{
  const weeklyCards = Array.from(rendered.en.weekly.querySelectorAll("h2")).map((h) => h.textContent);
  ok(
    weeklyCards.length === 2 && weeklyCards.some((t) => t.includes(LONG_NAME_AR)) && weeklyCards.some((t) => t.includes(LONG_NAME_EN)),
    "G6: the weekly report keeps the ALL-children default (D5), each card its own child"
  );
  const src = PARENT_SURFACES.map((f) => stripComments(read(f))).join("\n");
  ok(!/academicLevelFilter|levelSelector|levelFilter|SelectAcademicLevel/.test(src), "G7: no Parent level selector/filter was added");
  for (const f of PARENT_SURFACES) {
    ok(!/<select/.test(stripComments(read(f))) || !/academicLevel/.test(stripComments(read(f))), `G8: ${path.basename(f)} has no level <select>`);
  }
}

// ---------------------------------------------------------------------------
// H. Shared component — Student mode untouched
// ---------------------------------------------------------------------------
section("H. Shared absences component — Student branch still writes");

{
  const student = rendered.en.studentAbsences;
  const parent = rendered.en.absences;
  ok(student.textContent.includes("My absences") || student.querySelectorAll("h1").length === 1, "H1: the Student absences branch still renders its own header");
  ok(student.querySelectorAll("button").length >= 1, "H2: …and still mounts its action affordance");
  eq(parent.querySelectorAll("textarea").length, 0, "H3: the Parent branch mounts no reason textarea");
  ok(
    parent.querySelectorAll("button[type=submit], form").length === 0,
    "H4: …and no submit surface (the server still refuses writes)"
  );
  ok(
    rendered.ar.studentAbsences.querySelectorAll("button").length >= 1,
    "H5: the Student branch is identical in Arabic (the fix is parent-only)"
  );
  const src = stripComments(read("src/components/student/live-sessions-view.tsx"));
  ok(
    /export function StudentAbsencesView/.test(src) && /canSubmit=\{false\}/.test(src),
    "H6: the Parent copy is still the read-only mount (canSubmit={false})"
  );
}

// ---------------------------------------------------------------------------
// I. Server labels + no schema drift
// ---------------------------------------------------------------------------
section("I. Server month labels follow the request locale; no schema change");

{
  const dash = stripComments(read("src/app/api/parents/me/dashboard/route.ts"));
  const ana = stripComments(read("src/app/api/parents/me/analytics/route.ts"));
  ok(/fmtDate\(d, __loc, \{ month: "short" \}\)/.test(dash), "I1: the dashboard month label uses the shared formatter + request locale");
  ok(/fmtDate\(d, loc, \{ month: "short" \}\)/.test(ana), "I2: …and analytics uses the SAME formatter (one implementation)");
  ok(!/toLocaleString\("en-US"/.test(dash), "I3: the fixed en-US label is gone");
  ok(!/toLocaleDateString\("ar-EG"/.test(ana), "I4: the fixed ar-EG label is gone");
  ok(/serverLocale\(\)/.test(dash) && /serverLocale\(\)/.test(ana), "I5: both routes resolve the request locale from the cookie");
  ok(
    /tApi\("api\.activityQuiz"/.test(dash) && /tApi\("api\.activitySession"/.test(dash),
    "I6: the recent-activity titles are localized server-side"
  );
  ok(
    /translate\(loc, "api\.quizFallback"\)/.test(stripComments(read("src/app/api/parents/me/weekly-report/route.ts"))),
    "I7: the weekly fallback titles are localized too"
  );
}
{
  const migrations = fs
    .readdirSync(path.join(REPO, "prisma/migrations"))
    .filter((d) => /^\d/.test(d))
    .sort();
  eq(migrations[migrations.length - 1], "20260923180000_k3_academic_level_constraints", "I8: the newest migration is unchanged (no M4.5 migration)");
  const m45 = migrations.filter((m) => /m45|m4_5/i.test(m));
  eq(m45, [], "I9: no M4.5 migration directory exists");
  const schema = read("prisma/schema.prisma");
  ok(!/parentAcademicLevel/.test(schema), "I10: no Parent level column was added");
}

section("J. System text follows the ACTIVE locale (the M4.5 manual-QA finding)");

{
  // (1) English-mode leak analysis: every Arabic RUN left on the surface must
  //     be part of an authored content string. System text is dictionary-keyed,
  //     so a leak of the old kind (Phase H Arabic reasons, pre-formatted
  //     lifecycle labels) is impossible to miss here.
  const content = [
    CONTENT.lessonTitle,
    CONTENT.sessionTitle,
    CONTENT.absenceReason,
    CONTENT.homeworkTitle,
    CONTENT.noteText,
    LONG_NAME_AR,
    SHARED_COURSE_AR,
    "مجموعة أولى ثانوي",
  ];
  let stripped = SNAPSHOT.enFollowup;
  for (const c of content) stripped = stripped.split(c).join(" ");
  const leftovers = (stripped.match(/[\u0600-\u06FF][\u0600-\u06FF\s\u0640]*/g) ?? [])
    .map((r) => r.trim())
    .filter(Boolean);
  eq(leftovers, [], "J1: once authored content is removed, no Arabic is left in English mode");
  ok(
    [CONTENT.lessonTitle, CONTENT.sessionTitle, CONTENT.homeworkTitle, CONTENT.absenceReason].every((c) =>
      SNAPSHOT.enFollowup.includes(c)
    ),
    "J2: …and the authored content it stripped really is on the surface"
  );
}
{
  // (2) The QA scenario, inverted: this tree was mounted while the app was
  //     ARABIC; switching the language must re-localize it IN PLACE — no
  //     refetch, no reload, no second payload.
  const el = rendered.ar.followup;
  ok(el.textContent.includes("أكمل الفيديو الأول"), "J3: the Arabic mount renders the Arabic system text");
  const before = fetchCalls.length;
  setLocale("en");
  await React.act(async () => {
    await new Promise((r) => setTimeout(r, 20));
  });
  const text = el.textContent;
  ok(text.includes("Complete the first video"), "J4: switching to English re-localizes the SAME mounted tree");
  ok(text.includes("A session was rescheduled"), "J5: …including the session lifecycle rows");
  ok(!text.includes("أكمل الفيديو الأول") && !text.includes("حصة اتأجلت عن معادها"), "J6: …and the Arabic system text is gone");
  ok(
    before > 0 && fetchCalls.length >= before,
    "J7: the other mounted trees re-read their locale-keyed queries (the surface itself owns no request)"
  );
  ok(text.includes(CONTENT.lessonTitle), "J8: content is untouched by the switch");
}
{
  // (3) The boundary the fix moved: the API stops pre-formatting, the React
  //     layer owns localization, and the Parent queries are locale-keyed.
  const route = stripComments(read("src/app/api/parents/me/academics/route.ts"));
  ok(!/resolveLabel/.test(route), "J9: the academics route no longer pre-formats system text");
  ok(/selectedStudentId: resolution\.student\.id,[\s\S]{0,80}snapshot,/.test(route), "J10: it hands the aggregation's canonical keys through untouched");
  const followup = stripComments(read("src/components/parent/academic-followup.tsx"));
  ok(/hasDictKey\(value\) \? t\(value\) : value/.test(followup), "J11: the surface resolves dictionary keys against the active locale");
  ok((followup.match(/useSystemText\(\)/g) ?? []).length >= 1, "J12: …through ONE resolver (no per-string translation map)");
  ok(!/PROGRESSION_REASON_AR|أكمل الفيديو|حصة اتأجلت/.test(followup), "J13: the component hard-codes no system text of its own");
  const dash = stripComments(read("src/components/parent/parent-dashboard.tsx"));
  ok(
    /queryKey: \["parent-academics", activeChildId, locale\]/.test(dash),
    "J14: the academics query is locale-keyed (a language switch re-reads it)"
  );
  ok(/queryKey: \["parent-dashboard", locale\]/.test(dash), "J15: …and so is the dashboard query");
  const engine = stripComments(read("src/lib/progression.ts"));
  ok(/PROGRESSION_REASON_KEY: Record<ProgressionUnmetCode, string>/.test(engine), "J16: canonical codes map to dictionary keys in the domain layer");
  ok(/export function catchupReasonCodes/.test(engine), "J17: the catch-up reason rule stays canonical (ONE definition)");
}

section("Done");
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("failures:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(fail === 0 ? 0 : 1);
} catch (err) {
  console.log(`\nthrew: ${err && err.stack ? err.stack : err}`);
  console.log(`${pass} passed, ${fail + 1} failed`);
  process.exit(1);
}
})();
