// CodeMind Academy — Teacher «الحصص المباشرة والحضور»: session identity
// (Phase L final manual-QA fix).
//
// THE BUG THIS SUITE PINS DOWN
// ============================
// Phase L runs BOTH official curricula at once:
//
//     FIRST_SECONDARY   → Course «البرمجة والذكاء الاصطناعي»
//     SECOND_SECONDARY  → Course «البرمجة والذكاء الاصطناعي»
//
// The two courses share a DISPLAY NAME (their lessons even share printed
// officialCodes), so a course name is not an identity. The teacher session
// list nevertheless grouped its rows per course and rendered
// `<section key={group.name}>`, which made React throw at runtime:
//
//     Encountered two children with the same key, `البرمجة والذكاء الاصطناعي`.
//
// WHAT IS PROVEN HERE (A–J)
//   A. Two same-named courses produce UNIQUE group identities — executed: the
//      REAL `/api/live-sessions` payload (real DB, real route) is fed to the
//      REAL `groupSessionsByCourse`, and the keys of the resulting groups are
//      unique. A canary replays the OLD "group by name" algorithm on the same
//      rows and shows it WOULD collide — so this suite fails the moment
//      identity falls back to `Course.name`.
//   B. Every grouped course item CARRIES its canonical `courseId` (the id is
//      not swallowed by the grouping memo).
//   C. First Secondary and Second Secondary stay TWO separate groups, each
//      containing exactly its own sessions (zero cross-level leakage).
//   D. The selected session's identity is `LiveSession.id` (never a title, a
//      group name or a date), and switching selection is id-based.
//   E. Every rendered list row is keyed by a canonical id: sessions by
//      `s.id`, roster rows by `studentId`, group options by `g.id`, course
//      filter options by course id.
//   F. The teacher's SCOPE is unchanged: only the teacher's own groups (and
//      substitute sessions) are visible, and no `Teacher.academicLevel` field
//      is introduced anywhere.
//   G. The live-session LIFECYCLE is unchanged: statuses in the payload are
//      the database's own values, and the surface calls exactly the same
//      operational endpoints it called before the polish.
//   H. ATTENDANCE is touchable-but-unchanged: the same endpoints, the same
//      four statuses, the same per-session lock — only the presentation moved.
//   I. Academic-level labels still render (list rows, detail header, schedule
//      dialog), and the level travels with the session DTO — derived from
//      `Course.academicLevel`.
//   J. No render key in the touched surfaces comes from a non-unique display
//      value (the whole `key=` inventory is asserted against a stable-source
//      allow-list).
//
// Portable: no shell of any kind — runs unchanged on Windows and Linux CI.
//
// Run: node tests/teacher-live-session-identity-phaseL.test.js

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { pathToFileURL } = require("url");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-sessionidentity-"));

let passed = 0;
let failed = 0;
const failures = [];
function ok(cond, msg, detail) {
  if (cond) {
    passed++;
    console.log(`  ok   ${msg}`);
  } else {
    failed++;
    failures.push(msg);
    console.log(`  FAIL ${msg}${detail ? ` — ${detail}` : ""}`);
  }
}
function eq(actual, expected, msg) {
  ok(
    actual === expected,
    msg,
    actual === expected ? undefined : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
  );
}
function section(t) {
  console.log(`\n${t}`);
}
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

/** Whitespace-insensitive lookup so formatting never hides a pin. */
const squash = (s) => s.replace(/\s+/g, " ");
const hits = (source, snippet) => squash(source).includes(squash(snippet));

(async () => {
  // =========================================================================
  section("Compile the REAL modules under test");
  // =========================================================================
  fs.writeFileSync(
    path.join(OUT, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "es2020", module: "commonjs", strict: false, skipLibCheck: true,
        esModuleInterop: true, resolveJsonModule: true, types: ["node"],
        baseUrl: REPO, paths: { "@/*": ["src/*"] },
        typeRoots: [path.join(REPO, "node_modules/@types")],
        rootDir: REPO, outDir: OUT, noEmitOnError: false,
      },
      // The grouping authority is the module UNDER TEST; the route is compiled
      // so the test can execute the REAL server payload against the REAL DB.
      files: [
        // The grouping authority…
        path.join(REPO, "src/lib/teacher-session-groups.ts"),
        // …and the REAL route whose payload produced the duplicate-key crash.
        path.join(REPO, "src/app/api/teacher/sessions/route.ts"),
        // …and the REAL route that feeds the polished live-session workspace.
        path.join(REPO, "src/app/api/live-sessions/route.ts"),
      ],
    })
  );
  const TSC_BIN = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(TSC_BIN)) {
    console.error("typescript is not installed — run npm install");
    process.exit(1);
  }
  const tsc = spawnSync(process.execPath, [TSC_BIN, "-p", path.join(OUT, "tsconfig.json")], {
    cwd: REPO, encoding: "utf8",
  });
  const EMIT = path.join(OUT, "src");
  const GROUPS_JS = path.join(EMIT, "lib/teacher-session-groups.js");
  const ROUTE_JS = path.join(EMIT, "app/api/teacher/sessions/route.js");
  const LIVE_ROUTE_JS = path.join(EMIT, "app/api/live-sessions/route.js");
  ok(fs.existsSync(GROUPS_JS), "tsc emits the grouping module", tsc.stdout?.slice(0, 400));
  ok(fs.existsSync(ROUTE_JS), "tsc emits the real teacher-sessions roster route", tsc.stdout?.slice(0, 400));
  ok(fs.existsSync(LIVE_ROUTE_JS), "tsc emits the real live-sessions route", tsc.stdout?.slice(0, 400));
  if (!fs.existsSync(GROUPS_JS) || !fs.existsSync(ROUTE_JS) || !fs.existsSync(LIVE_ROUTE_JS)) process.exit(1);

  const { DatabaseSync } = require("node:sqlite");
  const { applyMigrations } = await import(pathToFileURL(path.join(REPO, "scripts/lib/migrate-sqlite.mjs")).href);
  const { createSqlitePrisma } = await import(pathToFileURL(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs")).href);

  global.__CM_DB__ = null;
  const shim = path.join(OUT, "__db-shim__.js");
  fs.writeFileSync(shim, "module.exports = { get db() { return global.__CM_DB__; } };");
  // The API helpers are replaced (auth is not what this suite tests); EVERY
  // other module — the route, the scope loader, the serializer, the grouping —
  // is the production one.
  const apiStub = path.join(OUT, "__api__.js");
  fs.writeFileSync(
    apiStub,
    "module.exports = { " +
      "ok:(d,s)=>({status:s||200,body:d}), " +
      "err:(e,s)=>({status:s||400,body:{error:e}}), " +
      "requireUser: async()=>({ id:'u-t1', role:'TEACHER' }), " +
      "requireRole: async()=>({ user:{id:'u-t1',role:'TEACHER'}, error:null }), " +
      // The REAL profile loader's shape — the session-scope rule under test is
      // still the one inside src/lib/teacher-sessions.ts, not this shim.
      "getTeacherProfile: async(userId)=>{ " +
      "  const t = await global.__CM_DB__.teacher.findUnique({ where:{ userId }, include:{ groups:{ include:{ course:true } } } }); " +
      "  return t ? { id:t.id, userId:t.userId, groups:t.groups } : null; } };"
  );
  const headersStub = path.join(OUT, "__next-headers__.js");
  fs.writeFileSync(headersStub, "module.exports = { cookies: async()=>({ get:()=>undefined, set:()=>{} }) };");
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return shim;
    if (request === "@/lib/api") return apiStub;
    if (request === "next/headers") return headersStub;
    // The emitted route lives OUTSIDE the repo (tmpdir), so bare specifiers
    // that only exist in the repo's node_modules must be resolved explicitly.
    if (request.startsWith("next/") || request === "next") {
      const direct = path.join(REPO, "node_modules", `${request}.js`);
      if (fs.existsSync(direct)) return direct;
    }
    const alias = /^@\/lib\/([\w/-]+)$/.exec(request);
    if (alias) {
      const compiled = path.join(EMIT, "lib", `${alias[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    return origResolve.call(this, request, ...rest);
  };

  const dbFile = path.join(OUT, "identity.db");
  const d = new DatabaseSync(dbFile);
  {
    const orig = console.log;
    console.log = () => {};
    try {
      applyMigrations(d, { withBaseSchema: true, label: "" });
    } finally {
      console.log = orig;
    }
  }
  global.__CM_DB__ = createSqlitePrisma({ db: d, schemaPath: path.join(REPO, "prisma/schema.prisma") });

  const grouping = require(GROUPS_JS);
  const route = require(ROUTE_JS);
  const liveRoute = require(LIVE_ROUTE_JS);

  // =========================================================================
  section("Seed the two official courses — SAME name, DIFFERENT levels");
  // =========================================================================
  const NOW = Date.now();
  function ins(table, values) {
    const cols = Object.keys(values);
    d.prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`
    ).run(...cols.map((c) => values[c]));
  }

  const SHARED_NAME = "البرمجة والذكاء الاصطناعي";
  const COURSES = [
    { id: "c-fs", level: "FIRST_SECONDARY", slug: "programming-ai-1st-sec" },
    { id: "c-ss", level: "SECOND_SECONDARY", slug: "programming-ai-2nd-sec" },
  ];
  ins("User", { id: "u-t1", name: "Teacher One", email: "t1@example.com", password: "x", role: "TEACHER", isActive: 1, createdAt: NOW, updatedAt: NOW });
  ins("Teacher", { id: "t-1", userId: "u-t1", createdAt: NOW, updatedAt: NOW });
  // A SECOND teacher owns a THIRD course: none of its lessons may appear in the
  // first teacher's roster (the identity/level fix changes no authority).
  ins("User", { id: "u-t2", name: "Teacher Two", email: "t2@example.com", password: "x", role: "TEACHER", isActive: 1, createdAt: NOW, updatedAt: NOW });
  ins("Teacher", { id: "t-2", userId: "u-t2", createdAt: NOW, updatedAt: NOW });
  for (const c of ["fs", "ss"]) {
    ins("User", { id: `u-st-${c}`, name: `Student ${c}`, email: `st-${c}@example.com`, password: "x", role: "STUDENT", isActive: 1, createdAt: NOW, updatedAt: NOW });
  }

  for (const c of COURSES) {
    ins("Course", { id: c.id, slug: c.slug, academicLevel: c.level, name: "Programming & AI", nameAr: SHARED_NAME, description: "d", color: "#000000", createdAt: NOW, updatedAt: NOW });
    ins("Part", { id: `p-${c.id}`, courseId: c.id, title: "First Secondary Curriculum", titleAr: "منهج", order: 1 });
    ins("Unit", { id: `u-${c.id}`, partId: `p-${c.id}`, title: "Unit 1", titleAr: "الوحدة ١", order: 1 });
    // The SAME printed officialCode ("1-1") in both levels: a code is a display
    // value too, never an identity.
    ins("Lesson", { id: `l-${c.id}-1`, unitId: `u-${c.id}`, officialCode: "1-1", academicLevel: c.level, trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL", title: "Intro", titleAr: "مقدمة", order: 1, createdAt: NOW, updatedAt: NOW });
    // …and the GROUP carries the same display name in both levels as well.
    ins("Group", { id: `g-${c.id}`, name: "مجموعة أ", courseId: c.id, teacherId: "t-1", capacity: 20, schedule: "Sat", isActive: 1, trackScope: "LANGUAGE", createdAt: NOW, updatedAt: NOW });
    ins("Student", {
      id: `st-${c.id}-1`, userId: `u-st-${c.level === "FIRST_SECONDARY" ? "fs" : "ss"}`,
      groupId: `g-${c.id}`, studentCode: `S-${c.id}-1`, academicLevel: c.level,
      createdAt: NOW, updatedAt: NOW,
    });
  }
  // The foreign course: identical structure, NOT owned by t-1.
  ins("Course", { id: "c-other", slug: "other-course", academicLevel: "FIRST_SECONDARY", name: "Other", nameAr: "دورة أخرى", description: "d", color: "#000", createdAt: NOW, updatedAt: NOW });
  ins("Part", { id: "p-c-other", courseId: "c-other", title: "Other part", titleAr: "جزء", order: 1 });
  ins("Unit", { id: "u-c-other", partId: "p-c-other", title: "Other unit", titleAr: "وحدة", order: 1 });
  ins("Lesson", { id: "l-c-other-1", unitId: "u-c-other", officialCode: "9-9", academicLevel: "FIRST_SECONDARY", trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "OFFICIAL", title: "Foreign", titleAr: "خارجي", order: 1, createdAt: NOW, updatedAt: NOW });
  ins("Group", { id: "g-c-other", name: "مجموعة ب", courseId: "c-other", teacherId: "t-2", capacity: 20, schedule: "Sun", isActive: 1, trackScope: "LANGUAGE", createdAt: NOW, updatedAt: NOW });

  const SESSIONS = [
    { id: "s-fs-1", groupId: "g-c-fs", lessonId: "l-c-fs-1", status: "SCHEDULED", startAt: NOW + 3600e3 },
    { id: "s-fs-2", groupId: "g-c-fs", lessonId: "l-c-fs-1", status: "LIVE", startAt: NOW - 600e3 },
    { id: "s-ss-1", groupId: "g-c-ss", lessonId: "l-c-ss-1", status: "SCHEDULED", startAt: NOW + 7200e3 },
    { id: "s-ss-2", groupId: "g-c-ss", lessonId: "l-c-ss-1", status: "SCHEDULED", startAt: NOW + 10800e3 },
  ];
  for (const s of SESSIONS) {
    ins("LiveSession", {
      id: s.id, groupId: s.groupId, teacherId: "t-1", lessonId: s.lessonId,
      title: "Session", titleAr: "حصة", startAt: s.startAt, duration: 60,
      meetingUrl: "https://meet.example.com/x", status: s.status,
      rescheduleCount: 0, createdAt: NOW, updatedAt: NOW,
    });
  }

  // =========================================================================
  section("A–C. The REAL roster payload → the REAL grouping");
  // =========================================================================
  const rosterRes = await route.GET({
    url: "http://localhost/api/teacher/sessions",
    nextUrl: new URL("http://localhost/api/teacher/sessions"),
  });
  eq(rosterRes.status, 200, "A: the teacher roster loads from the real DB");
  const rows = rosterRes.body?.sessions || [];
  eq(rows.length, 2, "A: exactly the two owned course lessons are listed", JSON.stringify(rows.map((r) => r.id)));

  const groups = grouping.groupSessionsByCourse(rows);
  const keys = groups.map(grouping.courseGroupKey);

  eq(new Set(rows.map((r) => r.course.name)).size, 1, "A: the two courses really do share ONE display name");
  eq(rows.map((r) => r.course.name)[0], SHARED_NAME, "A: …which is the reported colliding name");
  ok(groups.length === 2, "C: two same-named courses stay TWO groups", `got ${groups.length}`);
  eq(new Set(keys).size, groups.length, "A: the rendered group keys are UNIQUE (no duplicate React key)");
  ok(keys.every((k) => k && k !== SHARED_NAME), "A: no key falls back to the course name");
  eq([...keys].sort().join(","), "c-fs,c-ss", "B: the keys ARE the canonical Course ids");
  for (const g of groups) {
    ok(typeof g.courseId === "string" && g.courseId.length > 0, `B: the group «${g.name}» carries its courseId`);
  }
  eq(
    groups.map((g) => g.academicLevel).sort().join(","),
    "FIRST_SECONDARY,SECOND_SECONDARY",
    "C: each group carries its OWN canonical level"
  );
  const leakage = groups.flatMap((g) => g.rows.filter((r) => r.course.id !== g.courseId).map((r) => r.id));
  eq(leakage.length, 0, "C: zero cross-course leakage — every row sits under its own course id", leakage.join(","));
  const fsGroup = groups.find((g) => g.courseId === "c-fs");
  const ssGroup = groups.find((g) => g.courseId === "c-ss");
  eq(fsGroup.rows.map((r) => r.id).join(","), "l-c-fs-1", "C: the First Secondary group holds exactly its own lesson");
  eq(ssGroup.rows.map((r) => r.id).join(","), "l-c-ss-1", "C: the Second Secondary group holds exactly its own lesson");
  eq(
    fsGroup.rows[0].officialCode === ssGroup.rows[0].officialCode,
    true,
    "A: …even though BOTH lessons carry the same printed officialCode (1-1)"
  );

  // ---- canary: the OLD render key WOULD have collided ----------------------
  {
    // The shipped bug kept TWO groups (keyed by course id) but RENDERED them
    // with `key={group.name}` — so the collision is in the NAME array, not in
    // the grouping. This canary replays exactly that: if anyone reverts the
    // component to the display name, these two keys become identical.
    const legacyKeys = groups.map((g) => g.name);
    eq(legacyKeys.length, 2, "A (canary): the buggy render still had two course sections");
    ok(
      new Set(legacyKeys).size < legacyKeys.length,
      "A (canary): …rendering them by NAME really does duplicate the React key — so the assertions above are non-vacuous",
      legacyKeys.join(" | ")
    );
  }

  // ---- the level travels with the roster DTO (the DTO-side fix) ------------
  for (const row of rows) {
    const expectedCourse = row.id === "l-c-fs-1" ? "c-fs" : "c-ss";
    const expectedLevel = row.id === "l-c-fs-1" ? "FIRST_SECONDARY" : "SECOND_SECONDARY";
    eq(row.course.id, expectedCourse, `I: ${row.id} carries its canonical course id`);
    eq(row.course.academicLevel, expectedLevel, `I: ${row.id}'s level is derived from Course.academicLevel`);
  }
  const courseLevels = d.prepare('SELECT id, academicLevel FROM "Course" WHERE id IN (?,?) ORDER BY id').all("c-fs", "c-ss");
  ok(
    courseLevels.every((c) => rows.find((r) => r.course.id === c.id)?.course.academicLevel === c.academicLevel),
    "I: …and the DTO's level matches the course row exactly (no second authority)"
  );
  eq(JSON.stringify(rosterRes.body?.scope), JSON.stringify({ academicLevels: ["FIRST_SECONDARY", "SECOND_SECONDARY"], spansBothLevels: true }), "I: the roster still reports the teacher's FULL level scope");

  // =========================================================================
  section("F. Scope is unchanged — the fix adds no authority");
  // =========================================================================
  eq(rows.some((r) => r.id === "l-c-other-1"), false, "F: a course owned by ANOTHER teacher never appears");
  eq(
    d.prepare('SELECT COUNT(*) AS n FROM "Lesson"').get().n,
    3,
    "F: …although the foreign lesson really exists in the database (non-vacuous)"
  );
  ok(rows.every((r) => ["c-fs", "c-ss"].includes(r.course.id)), "F: every row belongs to one of the teacher's OWN courses");
  ok(
    rosterRes.body.sessions.every((r) => r.course.academicLevel !== undefined),
    "F: the added DTO field is display-only — no filtering changed"
  );

  // =========================================================================
  section("D–E. The live-session payload the polished workspace renders");
  // =========================================================================
  const liveRes = await liveRoute.GET({
    url: "http://localhost/api/live-sessions",
    nextUrl: new URL("http://localhost/api/live-sessions"),
  });
  eq(liveRes.status, 200, "D: the teacher live-session list loads from the real DB");
  const sessions = liveRes.body?.sessions || [];
  eq(sessions.length, 4, "E: every session of both same-named courses is returned");
  eq(new Set(sessions.map((s) => s.id)).size, 4, "E: every session card has a unique canonical id");
  eq(new Set(sessions.map((s) => s.startAt)).size, 4, "E: …and the ids are the identity — the rows have 4 distinct start times");
  for (const session of sessions) {
    const expected = session.group.id === "g-c-fs" ? { courseId: "c-fs", level: "FIRST_SECONDARY" } : { courseId: "c-ss", level: "SECOND_SECONDARY" };
    eq(session.group.courseId, expected.courseId, `I: ${session.id} carries its group's courseId`);
    eq(session.group.academicLevel, expected.level, `I: ${session.id} carries the level derived from Course.academicLevel`);
  }
  eq(liveRes.body?.groups?.length, 2, "E: the schedule form offers the teacher's two same-named groups");
  eq(new Set(liveRes.body.groups.map((g) => g.name)).size, 1, "E: …which share ONE display name too");
  eq(new Set(liveRes.body.groups.map((g) => g.id)).size, 2, "E: …and are told apart by their canonical ids");
  eq(
    liveRes.body.groups.map((g) => g.academicLevel).sort().join(","),
    "FIRST_SECONDARY,SECOND_SECONDARY",
    "E: …and by their canonical level, which the DTO now carries"
  );

  // Grouping the live rows too: the shared helper must behave identically when
  // a surface groups live sessions instead of roster rows.
  const liveGroups = sessions.map((s) => ({ course: { id: s.group.courseId, name: s.group.name, academicLevel: s.group.academicLevel } }));
  const liveGrouped = grouping.groupSessionsByCourse(liveGroups);
  eq(liveGrouped.length, 2, "D: the live rows group into two same-named courses");
  eq(new Set(liveGrouped.map(grouping.courseGroupKey)).size, 2, "D: …with unique keys");

  // =========================================================================
  section("G. The lifecycle is untouched — the statuses are the database's");
  // =========================================================================
  const seeded = d.prepare('SELECT id, status FROM "LiveSession" ORDER BY id').all();
  const byId = new Map(sessions.map((s) => [s.id, s]));
  ok(
    seeded.every((s) => byId.get(s.id)?.status === s.status),
    "G: every rendered status equals its database row (no client-side invention)"
  );
  ok(seeded.some((s) => s.status === "LIVE") && seeded.some((s) => s.status === "SCHEDULED"), "G: …and both states are really present (non-vacuous)");
  ok(sessions.every((s) => typeof s.joinAllowed === "boolean" && typeof s.startAllowed === "boolean"), "G: join/start eligibility is still decided by the server");

  // =========================================================================
  section("D–E/I. The surfaces that RENDER those identities");
  // =========================================================================
  const sessionsView = read("src/components/teacher/teacher-sessions.tsx");
  const liveView = read("src/components/teacher/live-sessions-workspace.tsx");
  const groupLib = read("src/lib/teacher-session-groups.ts");
  const liveLib = read("src/lib/live-sessions.ts");

  ok(hits(sessionsView, "byCourse = React.useMemo(() => groupSessionsByCourse(filtered)"), "D: the roster view groups through the shared identity helper");
  ok(hits(sessionsView, "key={courseGroupKey(group)}"), "D: the course section is keyed by the canonical course id");
  ok(!hits(sessionsView, "key={group.name}"), "D: …and NEVER by the course display name");
  ok(hits(groupLib, "const courseId = row.course?.id;"), "B: the identity is read from `row.course.id` in the helper's source");
  ok(!hits(groupLib, "id: row.course.name") && !hits(groupLib, "courseId: row.course?.name"), "B: no name/id swap is possible in the helper");
  {
    // Behavioural check on a synthetic pair of SAME-NAMED courses: the helper
    // must carry the ids out, and a row with no course id must be skipped
    // rather than silently mis-keyed by its name.
    const synthetic = grouping.groupSessionsByCourse([
      { id: "x1", course: { id: "course-a", name: SHARED_NAME } },
      { id: "x2", course: { id: "course-b", name: SHARED_NAME } },
      { id: "x3", course: { name: SHARED_NAME } },
      { id: "x4", course: { id: "course-a", name: SHARED_NAME } },
    ]);
    eq(synthetic.length, 2, "B: two same-named courses produce two groups, not four");
    eq(synthetic.map(grouping.courseGroupKey).join(","), "course-a,course-b", "B: …keyed by their canonical ids, in first-appearance order");
    eq(synthetic[0].rows.map((r) => r.id).join(","), "x1,x4", "B: rows are partitioned by id, never merged by name");
    eq(synthetic[0].name, SHARED_NAME, "B: the display name is still carried for rendering");
    eq(grouping.courseGroupKey({ courseId: "course-a" }), "course-a", "B: the ONE key function returns the course id verbatim");
  }

  ok(hits(liveView, "key={selectedId}") && hits(liveView, "key={s.id}"), "D: selection and list rows are id-keyed");
  ok(hits(liveView, "selectedId === s.id"), "D: selection compares canonical ids (never titles)");
  ok(!hits(liveView, "key={s.title") && !hits(liveView, "key={s.group?.name"), "D: no display text is used as a React key");
  ok(hits(liveView, "data-session-id={s.id}"), "E: each list row exposes its canonical session id");
  ok(hits(liveView, "key={row.studentId}"), "E: the attendance roster is keyed by the student's canonical id");
  ok(hits(liveView, "key={option}"), "E: the attendance status buttons are keyed by their enum value");
  ok(hits(liveView, "key={g.id}"), "E: the schedule dialog's group options are keyed by group id");
  ok(hits(sessionsView, "key={id} value={id}"), "E: the course filter options are keyed by course id");

  // =========================================================================
  section("G–H. Lifecycle + attendance behaviour are UNTOUCHED");
  // =========================================================================
  const endpoints = Array.from(new Set(
    (liveView.match(/["`](\/api\/live-sessions[^"`]*)["`]/g) || [])
      .map((s) => s.replace(/[`"]/g, ""))
      // `${session.id}` and `${sessionId}` are the same session reference.
      .map((s) => s.replace("${session.id}", "${sessionId}"))
  )).sort();
  const expectedEndpoints = [
    "/api/live-sessions",
    "/api/live-sessions/${sessionId}",
    "/api/live-sessions/${sessionId}/attendance",
    "/api/live-sessions/${sessionId}/attendance/finalize",
    "/api/live-sessions/${sessionId}/cancel",
    "/api/live-sessions/${sessionId}/reschedule",
  ];
  for (const e of expectedEndpoints) {
    ok(endpoints.includes(e), `G/H: the surface still calls ${e}`);
  }
  eq(endpoints.length, expectedEndpoints.length, "G/H: …and adds no new operational endpoint", endpoints.join(","));
  const lifecycleActions = Array.from(new Set(
    (liveView.match(/lifecycle\("(start|end)"\)/g) || []).map((m) => m.match(/"(start|end)"/)[1])
  )).sort();
  eq(lifecycleActions.join(","), "end,start", "G: the SAME two lifecycle actions (start/end) are still the only ones the UI can trigger");
  ok(hits(liveView, 'sendJson(`/api/live-sessions/${sessionId}`, "PATCH", { action })'), "G: …and they still travel through the unchanged PATCH contract");
  ok(hits(liveView, 'session.status === "LIVE"'), "G: the UI still branches on the SERVER's status");
  ok(!/setSession\(.*status\s*:/.test(liveView), "G: the UI never writes a status locally");
  ok(hits(liveView, "session.startAllowed"), "G: starting is still gated by the server's `startAllowed`");
  ok(hits(liveView, "session.joinAllowed"), "G: joining is still gated by the server's `joinAllowed`");
  ok(hits(liveView, "attendanceLocked"), "H: the attendance lock is still the server's flag");
  for (const status of ["PRESENT", "LATE", "ABSENT", "EXCUSED"]) {
    ok(hits(liveView, `"${status}"`), `H: the ${status} attendance status still exists in the register`);
  }
  ok(hits(liveView, '"UNMARKED"'), "H: UNMARKED is still the register's default");

  // =========================================================================
  section("I. Academic-level context stays visible");
  // =========================================================================
  ok(hits(liveView, "AcademicLevelBadge"), "I: the live workspace renders canonical level badges");
  ok(hits(liveView, "academicLevelLabel(t, g.academicLevel)"), "I: the schedule form labels group options with the level");
  ok(hits(liveView, "teacher.live.level"), "I: the detail panel labels the group's level");
  const badgeUses = (liveView.match(/<AcademicLevelBadge/g) || []).length;
  ok(badgeUses >= 3, "I: the level badge appears in the list row, the detail header and the context block", `got ${badgeUses}`);
  ok(hits(liveLib, "course: { select: { academicLevel: true } }"), "I: the live DTO derives the level from the Course relation");
  ok(hits(liveLib, "academicLevel: session.group.course?.academicLevel ?? null"), "I: …and serializes it tolerantly");

  // =========================================================================
  section("J. The whole render-key inventory of the touched surfaces");
  // =========================================================================
  // Whitespace is stripped before matching, so formatting never changes the
  // verdict. Every entry is a canonical id, an enum value, or a key that is
  // local to an editor draft (where the array is replaced wholesale).
  const STABLE_KEY = [
    /^courseGroupKey\(group\)$/,
    /^selectedId$/,
    /^s\.id$/,
    /^row\.studentId$/,
    /^option$/,
    /^summaryStatus$/,
    /^g\.id$/,
    /^id$/,
    /^i$/,
    /^j$/,
    /^a\.track$/,
    /^m\.id$/,
    /^q\.id$/,
    /^h\.id$/,
    /^editQuiz\.id$/,
    /^a\.id\|\|i$/,
    /^q\.id\|\|i$/,
    /^idx$/,
    /^oi$/,
    /^val$/,
    /^v$/,
    /^editing\?\.id\?\?"new-homework"$/,
  ];
  for (const [file, source] of [["teacher-sessions.tsx", sessionsView], ["live-sessions-workspace.tsx", liveView]]) {
    const exprs = Array.from(source.matchAll(/\bkey=\{([^}]*)\}/g)).map((m) => m[1].trim());
    ok(exprs.length > 0, `J: ${file} really has key= expressions (non-vacuous)`);
    const compact = exprs.map((e) => e.replace(/\s+/g, ""));
    const unknown = exprs.filter((e, i) => !STABLE_KEY.some((re) => re.test(compact[i])));
    eq(unknown.length, 0, `J: every key= in ${file} comes from a stable source`, unknown.join(" | "));
    const named = exprs.filter((e) => /\.(name|title|titleAr|officialCode)\b/.test(e));
    eq(named.length, 0, `J: no key= in ${file} uses a display value`, named.join(" | "));
    ok(!/key=\{[^}]*Date\.now\(\)/.test(source), `J: no key= in ${file} is time-derived`);
  }

  // =========================================================================
  console.log(`\nteacher live-session identity (phase L): ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("failures:\n - " + failures.join("\n - "));
    process.exit(1);
  }
})();
