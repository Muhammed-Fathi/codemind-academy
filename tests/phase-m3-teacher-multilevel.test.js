// CodeMind Academy — Phase M3.1 teacher KPI/history scope contract.
//
// The real dashboard and analytics route handlers run against the repository's
// migration-backed SQLite database. This fixture deliberately gives one
// current First Secondary student history in another same-level course, a
// different level, and a course owned by another teacher; none may bleed into
// that student's current Group/Course card or selected-scope activity.
//
// Run: node tests/phase-m3-teacher-multilevel.test.js

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { pathToFileURL } = require("url");
const { cleanupTempDir } = require("./helpers/temp-dir-cleanup.cjs");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-m31-kpi-"));
let passed = 0;
let failed = 0;
const failures = [];
let database = null;
let restoreResolver = null;

function ok(condition, message, detail) {
  if (condition) {
    passed++;
    console.log(`  ok   ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  FAIL ${message}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(actual, expected, message) {
  ok(
    actual === expected,
    message,
    actual === expected
      ? undefined
      : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
  );
}
function eqArray(actual, expected, message) {
  const left = [...actual].sort();
  const right = [...expected].sort();
  ok(
    JSON.stringify(left) === JSON.stringify(right),
    message,
    JSON.stringify(left) === JSON.stringify(right)
      ? undefined
      : `got ${JSON.stringify(left)}, want ${JSON.stringify(right)}`
  );
}
function section(title) {
  console.log(`\n${title}`);
}
function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

(async () => {
  try {
    // Compile and execute the real route modules (not copies of their logic).
    const ROUTES = [
      "src/app/api/teacher/dashboard/route.ts",
      "src/app/api/teacher/analytics/route.ts",
    ];
    fs.writeFileSync(
      path.join(OUT, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "es2020",
          module: "commonjs",
          strict: false,
          skipLibCheck: true,
          esModuleInterop: true,
          resolveJsonModule: true,
          types: ["node"],
          baseUrl: REPO,
          paths: { "@/*": ["src/*"] },
          typeRoots: [path.join(REPO, "node_modules/@types")],
          rootDir: REPO,
          outDir: OUT,
          noEmitOnError: false,
        },
        files: ROUTES.map((route) => path.join(REPO, route)),
      })
    );
    const TSC_BIN = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
    if (!fs.existsSync(TSC_BIN)) {
      throw new Error("TypeScript is not installed; run npm ci before this test.");
    }
    const compile = spawnSync(
      process.execPath,
      [TSC_BIN, "-p", path.join(OUT, "tsconfig.json")],
      { cwd: REPO, encoding: "utf8" }
    );
    if (compile.error) throw compile.error;
    const compileDiagnostics = `${compile.stdout || ""}\n${compile.stderr || ""}`;
    const changedRouteDiagnostic = compileDiagnostics.match(
      /src\/app\/api\/teacher\/(?:dashboard|analytics)\/route\.ts\(\d+,\d+\): error TS\d+/
    );
    if (changedRouteDiagnostic) {
      throw new Error(`Changed route failed TypeScript compilation: ${changedRouteDiagnostic[0]}`);
    }
    const EMIT = path.join(OUT, "src");
    const ROUTE_JS = Object.fromEntries(
      ROUTES.map((route) => [
        route,
        path.join(EMIT, route.replace(/^src\//, "").replace(/\.ts$/, ".js")),
      ])
    );
    for (const js of Object.values(ROUTE_JS)) {
      if (!fs.existsSync(js)) throw new Error(`tsc did not emit ${js}`);
    }

    // Real SQLite schema/migrations, with only unrelated framework services
    // (auth, i18n, video-progress) replaced at the route boundary.
    const { DatabaseSync } = require("node:sqlite");
    const { applyMigrations } = await import(
      pathToFileURL(path.join(REPO, "scripts/lib/migrate-sqlite.mjs")).href
    );
    const { createSqlitePrisma } = await import(
      pathToFileURL(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs")).href
    );

    global.__CM_DB__ = null;
    global.__USER__ = () => null;
    global.__TEACHER__ = null;
    const dbShim = path.join(OUT, "__db-shim__.js");
    fs.writeFileSync(dbShim, "module.exports = { get db() { return global.__CM_DB__; } };\n");
    const apiStub = path.join(OUT, "__api__.js");
    fs.writeFileSync(
      apiStub,
      [
        "module.exports = {",
        "  ok:(body,status)=>({status:status||200,body}),",
        "  err:(error,status)=>({status:status||400,body:{error}}),",
        "  requireUser:async()=>global.__USER__(),",
        "  getTeacherProfile:async()=>global.__TEACHER__,",
        "};",
      ].join("\n")
    );
    const i18nStub = path.join(OUT, "__i18n__.js");
    fs.writeFileSync(i18nStub, "module.exports = { getServerT: async () => (key) => key };\n");
    const nextStub = path.join(OUT, "__next__.js");
    fs.writeFileSync(
      nextStub,
      "module.exports = { NextRequest: class {}, NextResponse: { json:(body,init)=>({status:(init&&init.status)||200,body,json:async()=>body}) } };\n"
    );
    const progressStub = path.join(OUT, "__progress__.js");
    fs.writeFileSync(
      progressStub,
      "module.exports = { getVideoProgressForStudents: async () => new Map() };\n"
    );

    const origResolve = Module._resolveFilename;
    restoreResolver = () => {
      Module._resolveFilename = origResolve;
      restoreResolver = null;
    };
    Module._resolveFilename = function (request, ...rest) {
      if (request === "@/lib/db") return dbShim;
      if (request === "@/lib/api") return apiStub;
      if (request === "@/lib/i18n-server") return i18nStub;
      if (request === "@/lib/progress") return progressStub;
      if (request === "next/server") return nextStub;
      const alias = /^@\/lib\/([\w/-]+)$/.exec(request);
      if (alias) {
        const compiled = path.join(EMIT, "lib", `${alias[1]}.js`);
        if (fs.existsSync(compiled)) return compiled;
      }
      return origResolve.call(this, request, ...rest);
    };

    database = new DatabaseSync(path.join(OUT, "teacher-m31.db"));
    const originalLog = console.log;
    console.log = () => {};
    try {
      applyMigrations(database, { withBaseSchema: true, label: "" });
    } finally {
      console.log = originalLog;
    }
    global.__CM_DB__ = createSqlitePrisma({
      db: database,
      schemaPath: path.join(REPO, "prisma/schema.prisma"),
    });

    const NOW = Date.now();
    function ins(table, values) {
      const columns = Object.keys(values);
      database
        .prepare(
          `INSERT INTO "${table}" (${columns.map((c) => `"${c}"`).join(",")}) VALUES (${columns.map(() => "?").join(",")})`
        )
        .run(...columns.map((column) => values[column]));
    }

    const courses = [
      { id: "c-first-a", level: "FIRST_SECONDARY", slug: "m31-first-a" },
      { id: "c-first-b", level: "FIRST_SECONDARY", slug: "m31-first-b" },
      { id: "c-second", level: "SECOND_SECONDARY", slug: "m31-second" },
      { id: "c-foreign", level: "FIRST_SECONDARY", slug: "m31-foreign" },
    ];
    for (const course of courses) {
      ins("Course", {
        id: course.id,
        slug: course.slug,
        academicLevel: course.level,
        name: "Programming & AI",
        nameAr: "Programming & AI",
        description: "M3.1 test course",
        color: "#123456",
        createdAt: NOW,
        updatedAt: NOW,
      });
      ins("Part", {
        id: `p-${course.id}`,
        courseId: course.id,
        title: "Part",
        titleAr: "Part",
        order: 1,
      });
      ins("Unit", {
        id: `u-${course.id}`,
        partId: `p-${course.id}`,
        title: "Unit",
        titleAr: "Unit",
        order: 1,
      });
    }
    ins("Topic", {
      id: "topic-first-b",
      unitId: "u-c-first-b",
      title: "Legacy topic",
      titleAr: "Legacy topic",
      order: 1,
    });

    function lesson({ id, courseId, level, officialCode, topicId = null }) {
      ins("Lesson", {
        id,
        unitId: topicId ? null : `u-${courseId}`,
        topicId,
        officialCode,
        academicLevel: level,
        curriculumStatus: "OFFICIAL",
        trackScope: "SHARED",
        status: "PUBLISHED",
        title: id,
        titleAr: id,
        order: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    lesson({ id: "l-first-a", courseId: "c-first-a", level: "FIRST_SECONDARY", officialCode: "1-1" });
    lesson({
      id: "l-first-b",
      courseId: "c-first-b",
      level: "FIRST_SECONDARY",
      officialCode: "1-2",
      topicId: "topic-first-b",
    });
    lesson({ id: "l-second", courseId: "c-second", level: "SECOND_SECONDARY", officialCode: "1-1" });
    lesson({ id: "l-foreign", courseId: "c-foreign", level: "FIRST_SECONDARY", officialCode: "1-3" });

    for (const user of [
      { id: "u-main", name: "Main Teacher", email: "main@m31.test", role: "TEACHER" },
      { id: "u-other", name: "Other Teacher", email: "other@m31.test", role: "TEACHER" },
      { id: "u-second-only", name: "Second-only Teacher", email: "second@m31.test", role: "TEACHER" },
      { id: "u-first", name: "First Student", email: "first@m31.test", role: "STUDENT" },
      { id: "u-first-b", name: "First B Student", email: "first-b@m31.test", role: "STUDENT" },
      { id: "u-second", name: "Second Student", email: "second-student@m31.test", role: "STUDENT" },
      { id: "u-foreign", name: "Foreign Student", email: "foreign@m31.test", role: "STUDENT" },
      { id: "u-second-only-student", name: "Second-only Student", email: "second-only@m31.test", role: "STUDENT" },
    ]) {
      ins("User", {
        ...user,
        password: "test-hash",
        isActive: 1,
        status: "ACTIVE",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }
    for (const teacher of [
      { id: "t-main", userId: "u-main" },
      { id: "t-other", userId: "u-other" },
      { id: "t-second-only", userId: "u-second-only" },
    ]) {
      ins("Teacher", {
        ...teacher,
        specialty: "Computer Science",
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    const groups = [
      { id: "g-first-a", name: "First A", courseId: "c-first-a", teacherId: "t-main", trackScope: "LANGUAGE" },
      { id: "g-first-b", name: "First B", courseId: "c-first-b", teacherId: "t-main", trackScope: "ARABIC" },
      { id: "g-second", name: "Second", courseId: "c-second", teacherId: "t-main", trackScope: "LANGUAGE" },
      { id: "g-foreign", name: "Foreign", courseId: "c-foreign", teacherId: "t-other", trackScope: "ARABIC" },
      { id: "g-second-only", name: "Second-only", courseId: "c-second", teacherId: "t-second-only", trackScope: "ARABIC" },
    ];
    for (const group of groups) {
      ins("Group", {
        ...group,
        capacity: 20,
        schedule: "Sat",
        isActive: 1,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    const students = [
      { id: "s-first", userId: "u-first", groupId: "g-first-a", level: "FIRST_SECONDARY", schoolType: "LANGUAGE", grade: "1st Secondary" },
      { id: "s-first-b", userId: "u-first-b", groupId: "g-first-b", level: "FIRST_SECONDARY", schoolType: "ARABIC", grade: "1st Secondary" },
      { id: "s-second", userId: "u-second", groupId: "g-second", level: "SECOND_SECONDARY", schoolType: "LANGUAGE", grade: "2nd Secondary" },
      { id: "s-foreign", userId: "u-foreign", groupId: "g-foreign", level: "FIRST_SECONDARY", schoolType: "ARABIC", grade: "1st Secondary" },
      { id: "s-second-only", userId: "u-second-only-student", groupId: "g-second-only", level: "SECOND_SECONDARY", schoolType: "ARABIC", grade: "2nd Secondary" },
    ];
    for (const student of students) {
      ins("Student", {
        id: student.id,
        userId: student.userId,
        groupId: student.groupId,
        academicLevel: student.level,
        schoolType: student.schoolType,
        grade: student.grade,
        enrolledAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      });
    }

    function quiz({ id, lessonId, title, trackScope }) {
      ins("Quiz", {
        id,
        lessonId,
        title,
        titleAr: title,
        trackScope,
        passMark: 60,
        order: 1,
      });
    }
    quiz({ id: "q-first-a", lessonId: "l-first-a", title: "First A Quiz", trackScope: "SHARED" });
    quiz({ id: "q-first-b", lessonId: "l-first-b", title: "First B Quiz", trackScope: "ARABIC" });
    quiz({ id: "q-second", lessonId: "l-second", title: "Second Quiz", trackScope: "LANGUAGE" });
    quiz({ id: "q-foreign", lessonId: "l-foreign", title: "Foreign Quiz", trackScope: "SHARED" });

    function homework({ id, lessonId, title }) {
      ins("Homework", {
        id,
        lessonId,
        trackScope: "SHARED",
        title,
        titleAr: title,
        instructions: "M3.1 test",
        deadline: NOW,
        maxMarks: 10,
      });
    }
    homework({ id: "hw-first-a", lessonId: "l-first-a", title: "First A Homework" });
    homework({ id: "hw-first-a-pending", lessonId: "l-first-a", title: "First A Pending Homework" });
    homework({ id: "hw-first-b", lessonId: "l-first-b", title: "First B Homework" });
    homework({ id: "hw-second", lessonId: "l-second", title: "Second Homework" });
    homework({ id: "hw-foreign", lessonId: "l-foreign", title: "Foreign Homework" });

    function attempt({ id, quizId, studentId, percentage, passed, finishedAt, attemptNumber = 1, status }) {
      ins("QuizAttempt", {
        id,
        quizId,
        studentId,
        score: percentage,
        totalMarks: 100,
        percentage,
        passed: passed ? 1 : 0,
        startedAt: finishedAt === null ? NOW - 100 : finishedAt - 100,
        finishedAt,
        attemptNumber,
        status: status || (finishedAt === null ? "OPEN" : "SUBMITTED"),
      });
    }
    attempt({ id: "a-first-current", quizId: "q-first-a", studentId: "s-first", percentage: 80, passed: true, finishedAt: NOW - 1_000 });
    attempt({ id: "a-first-open", quizId: "q-first-a", studentId: "s-first", percentage: 0, passed: false, finishedAt: null, attemptNumber: 2, status: "OPEN" });
    // Same student, another teacher-owned course at the SAME academic level.
    attempt({ id: "a-first-other-course", quizId: "q-first-b", studentId: "s-first", percentage: 0, passed: false, finishedAt: NOW - 20_000 });
    // The student's old Second-level history belongs to a different group/course.
    attempt({ id: "a-first-other-level", quizId: "q-second", studentId: "s-first", percentage: 20, passed: false, finishedAt: NOW - 30_000 });
    // A historical record in a course/group owned by another teacher.
    attempt({ id: "a-first-foreign-teacher", quizId: "q-foreign", studentId: "s-first", percentage: 10, passed: false, finishedAt: NOW - 40_000 });
    attempt({ id: "a-first-b-current", quizId: "q-first-b", studentId: "s-first-b", percentage: 60, passed: true, finishedAt: NOW - 2_000 });
    attempt({ id: "a-second-current", quizId: "q-second", studentId: "s-second", percentage: 50, passed: false, finishedAt: NOW - 3_000 });
    attempt({ id: "a-second-only-current", quizId: "q-second", studentId: "s-second-only", percentage: 45, passed: false, finishedAt: NOW - 4_000 });

    function submission({ id, homeworkId, studentId, status, grade, submittedAt }) {
      ins("HomeworkSubmission", {
        id,
        homeworkId,
        studentId,
        content: "M3.1 test",
        submittedAt,
        grade: grade ?? null,
        status,
      });
    }
    submission({ id: "sub-first-current-graded", homeworkId: "hw-first-a", studentId: "s-first", status: "GRADED", grade: 8, submittedAt: NOW - 5_000 });
    submission({ id: "sub-first-current-pending", homeworkId: "hw-first-a-pending", studentId: "s-first", status: "SUBMITTED", submittedAt: NOW - 4_000 });
    // A different roster student's submission to the current course is not this group's pending work.
    submission({ id: "sub-non-roster-first-a", homeworkId: "hw-first-a", studentId: "s-second", status: "PENDING", submittedAt: NOW - 6_000 });
    submission({ id: "sub-first-other-course", homeworkId: "hw-first-b", studentId: "s-first", status: "GRADED", grade: 0, submittedAt: NOW - 40_000 });
    submission({ id: "sub-first-other-level", homeworkId: "hw-second", studentId: "s-first", status: "PENDING", submittedAt: NOW - 50_000 });
    submission({ id: "sub-first-foreign-teacher", homeworkId: "hw-foreign", studentId: "s-first", status: "GRADED", grade: 0, submittedAt: NOW - 60_000 });
    submission({ id: "sub-first-b-current", homeworkId: "hw-first-b", studentId: "s-first-b", status: "GRADED", grade: 9, submittedAt: NOW - 7_000 });
    submission({ id: "sub-second-current", homeworkId: "hw-second", studentId: "s-second", status: "PENDING", submittedAt: NOW - 8_000 });

    for (const session of [
      { id: "session-first-a", groupId: "g-first-a" },
      { id: "session-first-b", groupId: "g-first-b" },
      { id: "session-second", groupId: "g-second" },
      { id: "session-foreign", groupId: "g-foreign" },
      { id: "session-second-only", groupId: "g-second-only" },
    ]) {
      ins("LiveSession", {
        ...session,
        title: session.id,
        titleAr: session.id,
        startAt: NOW - 86_400_000,
        duration: 60,
        status: "COMPLETED",
        createdAt: NOW,
      });
    }
    for (const attendance of [
      { id: "att-first-current", studentId: "s-first", sessionId: "session-first-a", status: "PRESENT" },
      { id: "att-first-other-owned-group", studentId: "s-first", sessionId: "session-first-b", status: "ABSENT" },
      { id: "att-first-other-teacher", studentId: "s-first", sessionId: "session-foreign", status: "ABSENT" },
      { id: "att-first-b-current", studentId: "s-first-b", sessionId: "session-first-b", status: "PRESENT" },
      { id: "att-second-current", studentId: "s-second", sessionId: "session-second", status: "PRESENT" },
    ]) {
      ins("Attendance", { ...attendance, createdAt: NOW });
    }

    function studentForProfile(student, userName, email) {
      return {
        id: student.id,
        userId: student.userId,
        academicLevel: student.level,
        schoolType: student.schoolType,
        grade: student.grade,
        studentCode: `CM-${student.id}`,
        user: { id: student.userId, name: userName, email, avatarUrl: null },
      };
    }
    const profileStudents = {
      "s-first": studentForProfile(students[0], "First Student", "first@m31.test"),
      "s-first-b": studentForProfile(students[1], "First B Student", "first-b@m31.test"),
      "s-second": studentForProfile(students[2], "Second Student", "second-student@m31.test"),
      "s-second-only": studentForProfile(students[4], "Second-only Student", "second-only@m31.test"),
    };
    function profileGroup(groupId, courseId, level, roster) {
      const sourceGroup = groups.find((group) => group.id === groupId);
      const sourceCourse = courses.find((course) => course.id === courseId);
      return {
        id: groupId,
        name: sourceGroup.name,
        schedule: "Sat",
        capacity: 20,
        courseId,
        students: roster.map((studentId) => profileStudents[studentId]),
        course: {
          id: courseId,
          slug: sourceCourse.slug,
          name: "Programming & AI",
          nameAr: "Programming & AI",
          color: "#123456",
          academicLevel: level,
        },
      };
    }
    const mainProfile = {
      id: "t-main",
      user: { id: "u-main", name: "Main Teacher", email: "main@m31.test", avatarUrl: null, role: "TEACHER" },
      groups: [
        profileGroup("g-first-a", "c-first-a", "FIRST_SECONDARY", ["s-first"]),
        profileGroup("g-first-b", "c-first-b", "FIRST_SECONDARY", ["s-first-b"]),
        profileGroup("g-second", "c-second", "SECOND_SECONDARY", ["s-second"]),
      ],
    };
    const secondOnlyProfile = {
      id: "t-second-only",
      user: { id: "u-second-only", name: "Second-only Teacher", email: "second@m31.test", avatarUrl: null, role: "TEACHER" },
      groups: [profileGroup("g-second-only", "c-second", "SECOND_SECONDARY", ["s-second-only"])],
    };

    const dashboardRoute = require(ROUTE_JS[ROUTES[0]]);
    const analyticsRoute = require(ROUTE_JS[ROUTES[1]]);
    const req = (route, query = "") => ({
      url: `http://localhost/api/teacher/${route}${query}`,
      nextUrl: new URL(`http://localhost/api/teacher/${route}${query}`),
    });
    async function call(route, query = "", profile = mainProfile, userId = "u-main") {
      global.__USER__ = () => ({ id: userId, role: "TEACHER" });
      global.__TEACHER__ = profile;
      const handler = route === "dashboard" ? dashboardRoute : analyticsRoute;
      return handler.GET(req(route, query));
    }
    const payload = (response) => response.body || {};
    const groupDashboard = (response, id) =>
      (payload(response).groups || []).find((group) => group.id === id);
    const groupAnalytics = (response, id) =>
      (payload(response).groups || []).find((group) => group.groupId === id);

    section("M3.1 / dashboard: group KPI and activity scopes");
    const dashboardAll = await call("dashboard");
    eq(dashboardAll.status, 200, "dashboard ALL returns successfully");
    eqArray(
      (payload(dashboardAll).groups || []).map((group) => group.id),
      ["g-first-a", "g-first-b", "g-second"],
      "dashboard ownership remains the first boundary (foreign group stays hidden)"
    );
    eq(groupDashboard(dashboardAll, "g-first-a")?.stats.avgQuizScore, 80, "First A quiz KPI excludes same-level other-course, other-level, foreign-teacher, and open attempts");
    eq(groupDashboard(dashboardAll, "g-first-a")?.stats.attendancePct, 100, "First A attendance uses only its own roster/session records");
    eq(groupDashboard(dashboardAll, "g-first-a")?.stats.pendingHomework, 1, "First A pending homework is restricted to its own roster and course content");
    eq(groupDashboard(dashboardAll, "g-first-b")?.stats.avgQuizScore, 60, "same-level First B group retains its own quiz outcome");
    eq(groupDashboard(dashboardAll, "g-second")?.stats.avgQuizScore, 50, "Second group retains its own course outcome");
    eq(payload(dashboardAll).pendingHomeworkCount, 2, "dashboard ALL pending total sums scoped group counts, not all course submissions");

    const allActivity = payload(dashboardAll).recentActivity || [];
    ok(allActivity.some((item) => item.title === "Homework: First A Homework"), "current First A homework activity is present");
    ok(!allActivity.some((item) => /Foreign/.test(item.title)), "another teacher's homework/quiz activity is absent");
    const firstBActivity = allActivity.filter((item) => item.quizId === "q-first-b");
    eq(firstBActivity.length, 1, "same-level other-course quiz history is not copied into First A activity");
    eq(firstBActivity[0]?.studentName, "First B Student", "First B activity remains attached to its actual roster student");
    eq(firstBActivity[0]?.group?.id, "g-first-b", "activity row carries its teacher-authorized group context");
    eq(firstBActivity[0]?.course?.id, "c-first-b", "activity row carries its canonical course id");
    eq(firstBActivity[0]?.course?.academicLevel, "FIRST_SECONDARY", "activity row carries canonical Course.academicLevel");
    eq(allActivity.filter((item) => item.quizId === "q-first-a").length, 1, "the open First A attempt is not a quiz outcome/activity");
    ok(!allActivity.some((item) => item.title === "Homework: Foreign Homework"), "foreign-course submission title does not enter the recent feed");

    section("M3.1 / dashboard: academic-level narrowing follows the same scope");
    const dashboardFirst = await call("dashboard", "?academicLevel=FIRST_SECONDARY");
    eq(dashboardFirst.status, 200, "dashboard First filter returns successfully");
    eqArray((payload(dashboardFirst).groups || []).map((group) => group.id), ["g-first-a", "g-first-b"], "dashboard First filter isolates First groups");
    eq(groupDashboard(dashboardFirst, "g-first-a")?.stats.avgQuizScore, 80, "dashboard First filter preserves First A's course-scoped metric");
    eq(payload(dashboardFirst).pendingHomeworkCount, 1, "dashboard First filter totals only First group pending work");
    ok((payload(dashboardFirst).recentActivity || []).every((item) => item.course?.academicLevel === "FIRST_SECONDARY"), "dashboard First activity is consistently level-scoped");

    const dashboardSecond = await call("dashboard", "?academicLevel=SECOND_SECONDARY");
    eqArray((payload(dashboardSecond).groups || []).map((group) => group.id), ["g-second"], "dashboard Second filter isolates Second groups");
    eq(groupDashboard(dashboardSecond, "g-second")?.stats.avgQuizScore, 50, "dashboard Second filter computes its own course KPI");
    eq(payload(dashboardSecond).pendingHomeworkCount, 1, "dashboard Second pending count excludes First-level work");
    ok((payload(dashboardSecond).recentActivity || []).every((item) => item.course?.academicLevel === "SECOND_SECONDARY"), "dashboard Second activity is consistently level-scoped");

    section("M3.1 / analytics: Group/Course, session, and finished-attempt scope");
    const analyticsAll = await call("analytics");
    eq(analyticsAll.status, 200, "analytics ALL returns successfully");
    eqArray((payload(analyticsAll).groups || []).map((group) => group.groupId), ["g-first-a", "g-first-b", "g-second"], "analytics ownership remains the first boundary");

    const analyticsFirstA = groupAnalytics(analyticsAll, "g-first-a");
    eq(analyticsFirstA?.students[0]?.quizAvg, 80, "First A analytics excludes other-course and other-teacher history");
    eq(analyticsFirstA?.students[0]?.quizzesTaken, 1, "First A analytics counts only its finished quiz attempt");
    eq(analyticsFirstA?.students[0]?.quizzesPassed, 1, "open and unrelated failed attempts do not become First A outcomes");
    eq(analyticsFirstA?.quizPassRate, 100, "First A pass rate excludes its open attempt");
    eq(analyticsFirstA?.students[0]?.attendancePct, 100, "analytics First A attendance uses only First A group sessions");
    eq(analyticsFirstA?.students[0]?.homeworkTotal, 2, "First A homework total is scoped to its own course submissions");
    eq(analyticsFirstA?.students[0]?.homeworkGraded, 1, "First A graded count excludes same-level and foreign history");
    eq(analyticsFirstA?.homeworkCompletion, 50, "First A homework completion uses its own two submissions");
    eq(analyticsFirstA?.trackSplit.SHARED.attemptCount, 1, "First A Track split keeps the current SHARED quiz only");
    eq(analyticsFirstA?.trackSplit.ARABIC.attemptCount, 0, "First A Track split excludes the other course's ARABIC quiz history");

    eq(groupAnalytics(analyticsAll, "g-first-b")?.avgQuizScore, 60, "same-level First B course has its own analytics card");
    eq(groupAnalytics(analyticsAll, "g-second")?.avgQuizScore, 50, "Second course has its own analytics card");
    eq(payload(analyticsAll).overview.totalGroups, 3, "ALL analytics aggregates the teacher's three owned groups");
    eq(payload(analyticsAll).overview.totalStudents, 3, "ALL analytics counts the selected groups' rosters only");
    eq(payload(analyticsAll).overview.avgQuizScore, 63, "ALL average is derived from scoped group KPIs, not student lifetime history");
    const allTrackSplit = payload(analyticsAll).overview.trackSplit;
    eqArray(Object.keys(allTrackSplit), ["SHARED", "ARABIC", "LANGUAGE"], "Track buckets and their established vocabulary remain unchanged");
    eq(allTrackSplit.SHARED.attemptCount, 1, "ALL SHARED Track bucket contains only scoped finished attempts");
    eq(allTrackSplit.ARABIC.attemptCount, 1, "ALL ARABIC Track bucket retains First B's own attempt only");
    eq(allTrackSplit.LANGUAGE.attemptCount, 1, "ALL LANGUAGE Track bucket retains Second's own attempt only");

    const analyticsFirst = await call("analytics", "?academicLevel=FIRST_SECONDARY");
    eq(analyticsFirst.status, 200, "analytics First filter returns successfully");
    eqArray((payload(analyticsFirst).groups || []).map((group) => group.groupId), ["g-first-a", "g-first-b"], "analytics First filter isolates First-level groups");
    eq(payload(analyticsFirst).overview.totalStudents, 2, "First overview counts only First-level rosters");
    eq(payload(analyticsFirst).overview.avgQuizScore, 70, "First overview aggregates the two First group/course values");

    const analyticsSecond = await call("analytics", "?academicLevel=SECOND_SECONDARY");
    eqArray((payload(analyticsSecond).groups || []).map((group) => group.groupId), ["g-second"], "analytics Second filter isolates Second-level groups");
    eq(payload(analyticsSecond).overview.totalStudents, 1, "Second overview counts only the Second roster");
    eq(payload(analyticsSecond).overview.avgQuizScore, 50, "Second overview uses the Second course's finished outcome only");

    section("M3.1 / validation and fail-closed authorization");
    eq((await call("dashboard", "?academicLevel=THIRD_SECONDARY")).status, 400, "dashboard rejects an invalid academic level");
    eq((await call("analytics", "?academicLevel=THIRD_SECONDARY")).status, 400, "analytics rejects an invalid academic level");

    const unownedDashboard = await call(
      "dashboard",
      "?academicLevel=FIRST_SECONDARY",
      secondOnlyProfile,
      "u-second-only"
    );
    eq(unownedDashboard.status, 200, "a valid but unowned dashboard level stays a successful empty scope");
    eq((payload(unownedDashboard).groups || []).length, 0, "unowned dashboard level never widens to another teacher's groups");
    eq((payload(unownedDashboard).recentActivity || []).length, 0, "unowned dashboard level has no history/activity");
    eq(payload(unownedDashboard).pendingHomeworkCount, 0, "unowned dashboard level has no pending count");

    const unownedAnalytics = await call(
      "analytics",
      "?academicLevel=FIRST_SECONDARY",
      secondOnlyProfile,
      "u-second-only"
    );
    eq(unownedAnalytics.status, 200, "a valid but unowned analytics level stays a successful empty scope");
    eq((payload(unownedAnalytics).groups || []).length, 0, "unowned analytics level is empty rather than widened");
    eq(payload(unownedAnalytics).overview.totalGroups, 0, "unowned analytics overview remains empty");
    eq(payload(unownedAnalytics).overview.totalStudents, 0, "unowned analytics roster remains empty");

    console.log(`\nM3.1 focused route test: ${passed} passed, ${failed} failed.`);
    if (failures.length) {
      console.error("Failed assertions:\n" + failures.map((message) => `  - ${message}`).join("\n"));
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  } finally {
    if (restoreResolver) restoreResolver();
    if (database) {
      try {
        database.close();
      } catch {}
    }
    cleanupTempDir(OUT);
  }
})();
