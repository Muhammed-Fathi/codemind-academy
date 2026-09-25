// CodeMind Academy — Teacher multi-level context + level filtering (Phase L manual-QA fix).
//
// WHAT IT PROVES
//   A teacher who legitimately teaches BOTH academic levels must be able to
//   (a) tell the levels apart on every selector they use, and (b) narrow a
//   lesson list to one level — with the narrowing enforced in the QUERY, never
//   by hiding rows in the browser.
//
//   O1. A teacher with an FS group AND an SS group gets lessons from both
//       levels, each labelled with its own canonical `Course.academicLevel`.
//   O2. `?academicLevel=FIRST_SECONDARY` returns ONLY First Secondary lessons
//       — server-side. No Second Secondary row is present in the payload.
//   O3. `?academicLevel=SECOND_SECONDARY` returns ONLY Second Secondary.
//   O4. The same printed officialCode in both levels does NOT collide: both
//       lessons exist with distinct ids, and each level filter returns exactly
//       one of them.
//   O5. An unknown level is rejected (400) and never guessed.
//   O6. Authorization is unchanged: a teacher who owns only SS groups gets
//       ZERO lessons when asking for FIRST_SECONDARY (the filter can only
//       NARROW the teacher's own course scope, never widen it).
//   O7. Track is independent of level: both a LANGUAGE and an ARABIC lesson of
//       the same course survive the level filter (level never filters track).
//   O8. The level is DERIVED from the Course relation — no `Teacher.academicLevel`
//       column exists anywhere in the schema.
//
//   O-E2E. SERVER-SIDE PROOF (fix #4 correction). Every teacher list route
//       (lessons, homework, quizzes, sessions, dashboard, analytics, attendance)
//       is compiled and executed against ONE real database holding BOTH
//       curricula, with a teacher who owns a group in each level:
//         * an unknown `?academicLevel=` is a 400 on every route;
//         * a level request returns ONLY that level's rows (ids asserted);
//         * an unfiltered request still returns both levels;
//         * `scope` accompanies every payload, including single-level teachers;
//         * a cross-level `group+level` pair yields NOTHING (no widening);
//         * attendance pairs an FS group with the SS level → 403, and a group
//           the teacher does not own is still refused;
//         * a Second-Secondary-only teacher asking for the FIRST level gets
//           empty payloads — never the other level's data — while a peer's
//           group of the SAME level stays invisible.
//
//   UI/SELECTOR CONTEXT (source pins — the reported defect was a selector that
//   could not tell the two levels apart):
//     * the teacher dashboard group selectors, group cards and analytics rows
//       carry the course level;
//     * the quiz/homework/lesson pickers render it in the option labels;
//     * the session-videos filter and the teacher session/readiness pickers use
//       the ONE shared level vocabulary (`academic-level-ui`), not a new one;
//     * FIX #4 CORRECTION: the separator is the SHARED `OptionalAcademicLevelFilter`,
//       which renders NOTHING unless the teacher's own scope spans both levels,
//       and it is wired on every multi-level surface (dashboard overview,
//       attendance, quizzes, homework, analytics, session roster, readiness
//       picker, authoring lesson picker) while single-level surfaces
//       (new-session dialog, per-student notes, templates) deliberately have none.
//
// The REAL route module is compiled with the repo's own tsc and executed
// against a REAL SQLite database built by the repo's own migration harness, so
// the filtering assertions exercise the shipped handler — not a copy of it.
//
// Portable: no shell of any kind — runs unchanged on Windows and Linux CI.
//
// Run: node tests/teacher-academic-level-phaseL.test.js

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { pathToFileURL } = require("url");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-teacherlevel-"));

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
function read(rel) {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

(async () => {
  // -------------------------------------------------------------------------
  // Compile the REAL route
  // -------------------------------------------------------------------------
  const ROUTE_REL = "src/app/api/teacher/lessons/route.ts";
  // Phase L manual-QA fix #4 — the corrections put the level separator on every
  // shared multi-level surface, so the test compiles and RUNS each of those
  // routes (not just the lesson picker) against one real database.
  const ROUTES = [
    "src/app/api/teacher/lessons/route.ts",
    "src/app/api/teacher/homework/route.ts",
    "src/app/api/teacher/quizzes/route.ts",
    "src/app/api/teacher/sessions/route.ts",
    "src/app/api/teacher/dashboard/route.ts",
    "src/app/api/teacher/analytics/route.ts",
    "src/app/api/teacher/attendance/route.ts",
  ];
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
      files: ROUTES.map((r) => path.join(REPO, r)),
    })
  );
  const TSC_BIN = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(TSC_BIN)) {
    console.error("typescript is not installed — run npm install");
    process.exit(1);
  }
  spawnSync(process.execPath, [TSC_BIN, "-p", path.join(OUT, "tsconfig.json")], { cwd: REPO, encoding: "utf8" });
  const EMIT = path.join(OUT, "src");
  const LESSONS_JS = path.join(EMIT, "app/api/teacher/lessons/route.js");
  const ROUTE_JS = {};
  for (const rel of ROUTES) {
    const js = path.join(EMIT, rel.replace(/^src\//, "").replace(/\.ts$/, ".js"));
    ROUTE_JS[rel] = js;
    if (!fs.existsSync(js)) {
      console.error(`tsc did not emit ${js}`);
      process.exit(1);
    }
  }

  // -------------------------------------------------------------------------
  // Real database + real handler
  // -------------------------------------------------------------------------
  const { DatabaseSync } = require("node:sqlite");
  const { applyMigrations } = await import(pathToFileURL(path.join(REPO, "scripts/lib/migrate-sqlite.mjs")).href);
  const { createSqlitePrisma } = await import(pathToFileURL(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs")).href);

  global.__CM_DB__ = null;
  global.__TEACHER__ = null;
  const shim = path.join(OUT, "__db-shim__.js");
  fs.writeFileSync(shim, "module.exports = { get db() { return global.__CM_DB__; } };");
  const apiStub = path.join(OUT, "__api__.js");
  fs.writeFileSync(
    apiStub,
    [
      "module.exports = {",
      "  ok:(d,s)=>({status:s||200,body:d}),",
      "  err:(e,s)=>({status:s||400,body:{error:e}}),",
      "  requireUser: async()=>global.__USER__(),",
      "  getTeacherProfile: async()=>global.__TEACHER__,",
      "};",
    ].join("\n")
  );
  const i18nStub = path.join(OUT, "__i18n__.js");
  fs.writeFileSync(i18nStub, "module.exports = { getServerT: async () => (k) => k };");
  const nextStub = path.join(OUT, "__next__.js");
  fs.writeFileSync(
    nextStub,
    "module.exports = { NextRequest: class {}, NextResponse: { json: (body, init) => ({ status: (init && init.status) || 200, body, json: async () => body }) } };"
  );
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return shim;
    if (request === "@/lib/api") return apiStub;
    if (request === "@/lib/i18n-server") return i18nStub;
    if (request === "next/server") return nextStub;
    const alias = /^@\/lib\/([\w/-]+)$/.exec(request);
    if (alias) {
      const compiled = path.join(EMIT, "lib", `${alias[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    return origResolve.call(this, request, ...rest);
  };

  const file = path.join(OUT, "teacher.db");
  const d = new DatabaseSync(file);
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

  const route = require(LESSONS_JS);
  const req = (qs) => ({
    // Both shapes: the route reads `url` (the fix-#4 level parameter), while
    // older callers/verifiers pass `nextUrl`.
    url: `http://localhost/api/teacher/lessons${qs || ""}`,
    nextUrl: new URL(`http://localhost/api/teacher/lessons${qs || ""}`),
  });
  const setUser = (u) => {
    global.__USER__ = () => u;
  };

  // -------------------------------------------------------------------------
  // Seed: TWO official courses (one per level) whose lessons SHARE printed
  // codes — the exact collision Phase L is about.
  // -------------------------------------------------------------------------
  const NOW = Date.now();
  function ins(table, values) {
    const cols = Object.keys(values);
    d.prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`
    ).run(...cols.map((c) => values[c]));
  }
  const COURSES = [
    { id: "c-fs", level: "FIRST_SECONDARY", slug: "programming-ai-1st-sec", name: "Programming & AI", nameAr: "البرمجة والذكاء الاصطناعي" },
    { id: "c-ss", level: "SECOND_SECONDARY", slug: "programming-ai-2nd-sec", name: "Programming & AI", nameAr: "البرمجة والذكاء الاصطناعي" },
  ];
  for (const c of COURSES) {
    for (const [i, level] of [c.level].entries()) {
      ins("Course", { id: c.id, slug: c.slug, academicLevel: level, name: c.name, nameAr: c.nameAr, description: "d", color: "#000000", createdAt: NOW, updatedAt: NOW });
      ins("Part", { id: `p-${c.id}`, courseId: c.id, title: "Curriculum", titleAr: "منهج", order: 1 });
      ins("Unit", { id: `u-${c.id}`, partId: `p-${c.id}`, title: "Unit 1", titleAr: "الوحدة ١", order: 1 + i });
    }
  }
  // The SAME printed code in both levels (the 18-collision reality), plus a
  // language and an arabic lesson in the FS course to prove track independence.
  ins("Lesson", { id: "l-fs-1", unitId: "u-c-fs", officialCode: "1-1", academicLevel: "FIRST_SECONDARY", trackScope: "SHARED", status: "PUBLISHED", title: "Intro", titleAr: "مقدمة", order: 1, createdAt: NOW, updatedAt: NOW });
  ins("Lesson", { id: "l-fs-2", unitId: "u-c-fs", officialCode: "1-2", academicLevel: "FIRST_SECONDARY", trackScope: "LANGUAGE", status: "PUBLISHED", title: "Loops", titleAr: "التكرار", order: 2, createdAt: NOW, updatedAt: NOW });
  ins("Lesson", { id: "l-fs-3", unitId: "u-c-fs", officialCode: "1-3", academicLevel: "FIRST_SECONDARY", trackScope: "ARABIC", status: "PUBLISHED", title: "Arrays", titleAr: "المصفوفات", order: 3, createdAt: NOW, updatedAt: NOW });
  ins("Lesson", { id: "l-ss-1", unitId: "u-c-ss", officialCode: "1-1", academicLevel: "SECOND_SECONDARY", trackScope: "SHARED", status: "PUBLISHED", title: "Intro", titleAr: "مقدمة", order: 1, createdAt: NOW, updatedAt: NOW });
  ins("Lesson", { id: "l-ss-2", unitId: "u-c-ss", officialCode: "2-5", academicLevel: "SECOND_SECONDARY", trackScope: "ARABIC", status: "PUBLISHED", title: "Trees", titleAr: "الأشجار", order: 2, createdAt: NOW, updatedAt: NOW });
  ins("Topic", { id: "t-1", unitId: "u-c-fs", title: "Topic", titleAr: "موضوع", order: 1 });
  ins("Lesson", { id: "l-legacy", unitId: null, topicId: "t-1", officialCode: null, academicLevel: "FIRST_SECONDARY", trackScope: "SHARED", status: "DRAFT", title: "Legacy", titleAr: "قديم", order: 9, createdAt: NOW, updatedAt: NOW });

  // Two teachers: one owns both levels, one owns Second Secondary only.
  //
  // The shape mirrors the REAL `getTeacherProfile` include
  // (`groups: { include: { course, students: { include: { user } } } }`), because
  // the dashboard/analytics aggregates read the students straight off it.
  const sfs = { id: "s-fs", academicLevel: "FIRST_SECONDARY", userId: "u-sfs", user: { id: "u-sfs", name: "FS Student", email: "sfs@x.test" } };
  const sss = { id: "s-ss", academicLevel: "SECOND_SECONDARY", userId: "u-sss", user: { id: "u-sss", name: "SS Student", email: "sss@x.test" } };
  const both = {
    id: "t-both",
    user: { id: "u-both", name: "Both", email: "both@x.test", role: "TEACHER" },
    groups: [
      { id: "g-fs", name: "FS group", courseId: "c-fs", trackScope: "LANGUAGE", capacity: 20, students: [sfs], course: { id: "c-fs", name: COURSES[0].name, nameAr: COURSES[0].nameAr, academicLevel: "FIRST_SECONDARY" } },
      { id: "g-ss", name: "SS group", courseId: "c-ss", trackScope: "ARABIC", capacity: 20, students: [sss], course: { id: "c-ss", name: COURSES[1].name, nameAr: COURSES[1].nameAr, academicLevel: "SECOND_SECONDARY" } },
    ],
  };
  const ssOnly = {
    id: "t-ss",
    user: { id: "u-ss", name: "SS", email: "ss@x.test", role: "TEACHER" },
    groups: [
      { id: "g-ss2", name: "SS group 2", courseId: "c-ss", trackScope: "ARABIC", capacity: 20, students: [sss], course: { id: "c-ss", name: COURSES[1].name, nameAr: COURSES[1].nameAr, academicLevel: "SECOND_SECONDARY" } },
    ],
  };

  const ids = (body) => (body.lessons || []).map((l) => l.id);
  const levelsOf = (body) => Array.from(new Set((body.lessons || []).map((l) => l.course && l.course.academicLevel)));

  // -------------------------------------------------------------------------
  // The rows every teacher LIST route reads: teachers with a real Group row in
  // EACH level (the level narrowing runs a REAL `Group` query, so the groups
  // must exist in the database), one student per group, and one piece of
  // level-specific content per surface.
  // -------------------------------------------------------------------------
  function seedSharedSurface() {
    // ---- rows the routes need beyond the lessons already seeded -----------
    ins("User", { id: "u-both", name: "Both", email: "both@x.test", password: "h", role: "TEACHER", createdAt: NOW, updatedAt: NOW });
    ins("User", { id: "u-ss", name: "SS", email: "ss@x.test", password: "h", role: "TEACHER", createdAt: NOW, updatedAt: NOW });
    ins("Teacher", { id: "t-both", userId: "u-both", specialty: "CS", createdAt: NOW, updatedAt: NOW });
    ins("Teacher", { id: "t-ss", userId: "u-ss", specialty: "CS", createdAt: NOW, updatedAt: NOW });
    ins("Group", { id: "g-fs", name: "FS group", courseId: "c-fs", teacherId: "t-both", capacity: 20, schedule: "Sat", isActive: 1, trackScope: "LANGUAGE", createdAt: NOW, updatedAt: NOW });
    ins("Group", { id: "g-ss", name: "SS group", courseId: "c-ss", teacherId: "t-both", capacity: 20, schedule: "Sat", isActive: 1, trackScope: "ARABIC", createdAt: NOW, updatedAt: NOW });
    ins("Group", { id: "g-ss2", name: "SS group 2", courseId: "c-ss", teacherId: "t-ss", capacity: 20, schedule: "Sun", isActive: 1, trackScope: "ARABIC", createdAt: NOW, updatedAt: NOW });
    ins("User", { id: "u-sfs", name: "FS Student", email: "sfs@x.test", password: "h", role: "STUDENT", createdAt: NOW, updatedAt: NOW });
    ins("Student", { id: "s-fs", userId: "u-sfs", groupId: "g-fs", academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE", grade: "1", studentCode: "CM-FS01", enrolledAt: NOW, createdAt: NOW, updatedAt: NOW });
    ins("User", { id: "u-sss", name: "SS Student", email: "sss@x.test", password: "h", role: "STUDENT", createdAt: NOW, updatedAt: NOW });
    ins("Student", { id: "s-ss", userId: "u-sss", groupId: "g-ss", academicLevel: "SECOND_SECONDARY", schoolType: "ARABIC", grade: "2", studentCode: "CM-SS01", enrolledAt: NOW, createdAt: NOW, updatedAt: NOW });
    ins("Homework", { id: "hw-fs", lessonId: "l-fs-1", trackScope: "SHARED", title: "HW FS", titleAr: "واجب ف", deadline: NOW });
    ins("Homework", { id: "hw-ss", lessonId: "l-ss-1", trackScope: "SHARED", title: "HW SS", titleAr: "واجب ث", deadline: NOW });
    ins("Quiz", { id: "qz-fs", lessonId: "l-fs-1", trackScope: "SHARED", title: "Q FS", titleAr: "اختبار ف" });
    ins("Quiz", { id: "qz-ss", lessonId: "l-ss-1", trackScope: "SHARED", title: "Q SS", titleAr: "اختبار ث" });
    ins("LiveSession", { id: "sess-fs", groupId: "g-fs", title: "FS live", titleAr: "حصة ف", startAt: NOW, duration: 60, status: "SCHEDULED", createdAt: NOW });
    ins("LiveSession", { id: "sess-ss", groupId: "g-ss", title: "SS live", titleAr: "حصة ث", startAt: NOW, duration: 60, status: "SCHEDULED", createdAt: NOW });
  }
  seedSharedSurface();

  // =========================================================================
  section("O1–O3. Level filtering is applied in the query, per level");
  // =========================================================================
  {
    setUser(both.user);
    global.__TEACHER__ = both;

    const all = await route.GET(req());
    eq(all.status, 200, "O1: the unfiltered picker loads");
    const allIds = ids(all.body);
    ok(allIds.includes("l-fs-1") && allIds.includes("l-ss-1"), "O1: a teacher with both levels sees BOTH levels' lessons");
    eq(levelsOf(all.body).sort().join(","), "FIRST_SECONDARY,SECOND_SECONDARY", "O1: each lesson carries its own canonical level");
    ok(
      (all.body.lessons || []).every((l) => !!l.course && "academicLevel" in l.course),
      "O1: every lesson row exposes the course level (the selector's label source)"
    );
    ok(allIds.includes("l-legacy"), "O1: legacy topic-chain lessons are still included (no regression)");

    const fs = await route.GET(req("?academicLevel=FIRST_SECONDARY"));
    eq(fs.status, 200, "O2: the First Secondary filter is accepted");
    eq(levelsOf(fs.body).join(","), "FIRST_SECONDARY", "O2: ONLY First Secondary lessons come back");
    ok(!ids(fs.body).includes("l-ss-1"), "O2: no Second Secondary lesson is present in the payload");
    ok(ids(fs.body).includes("l-fs-1") && ids(fs.body).includes("l-fs-2"), "O2: all of the teacher's First Secondary lessons are present");
    // The legacy topic-chain lesson is included by the UNFILTERED list (O1) —
    // whether the nested topic chain survives the extra course constraint is a
    // property of the query builder, so it is compared against the FS course's
    // own membership rather than asserted blindly.
    const fsFilteredHasLegacy = ids(fs.body).includes("l-legacy");
    const fsCourseHasLegacy = true; // l-legacy's topic → unit belongs to c-fs
    eq(fsFilteredHasLegacy, fsCourseHasLegacy, "O2: the legacy topic-chain lesson of the FS course follows the FS filter");

    const ss = await route.GET(req("?academicLevel=SECOND_SECONDARY"));
    eq(levelsOf(ss.body).join(","), "SECOND_SECONDARY", "O3: ONLY Second Secondary lessons come back");
    ok(!ids(ss.body).includes("l-fs-1"), "O3: no First Secondary lesson is present");
    eq(ids(ss.body).sort().join(","), "l-ss-1,l-ss-2", "O3: exactly the Second Secondary lessons are returned");

    const allParam = await route.GET(req("?academicLevel=all"));
    eq(levelsOf(allParam.body).length, 2, "O1: `all` restores the full list");
  }

  // =========================================================================
  section("O4–O5. Collisions and bad input");
  // =========================================================================
  {
    setUser(both.user);
    global.__TEACHER__ = both;
    const all = await route.GET(req());
    const shared = (all.body.lessons || []).filter((l) => l.officialCode === "1-1");
    eq(shared.length, 2, "O4: the SAME printed code exists in both levels");
    eq(new Set(shared.map((l) => l.id)).size, 2, "O4: …as two distinct lessons");
    eq(new Set(shared.map((l) => l.course.academicLevel)).size, 2, "O4: …distinguished by the canonical level");

    const fs = await route.GET(req("?academicLevel=FIRST_SECONDARY"));
    const fsShared = (fs.body.lessons || []).filter((l) => l.officialCode === "1-1");
    eq(fsShared.length, 1, "O4: under the First filter the code resolves to ONE lesson");
    eq(fsShared[0].id, "l-fs-1", "O4: …the First Secondary one");
    eq(fsShared[0].course.academicLevel, "FIRST_SECONDARY", "O4: …with its true level identity");

    const ss = await route.GET(req("?academicLevel=SECOND_SECONDARY"));
    const ssShared = (ss.body.lessons || []).filter((l) => l.officialCode === "1-1");
    eq(ssShared.length, 1, "O4: …and to the OTHER lesson under the Second filter");
    eq(ssShared[0].id, "l-ss-1", "O4: …which is the Second Secondary one");

    const bogus = await route.GET(req("?academicLevel=THIRD_SECONDARY"));
    eq(bogus.status, 400, "O5: an unknown level is rejected");
    ok(!!bogus.body.error, "O5: …with an explicit message instead of a guess");
  }

  // =========================================================================
  section("O6–O7. Authorization unchanged · Track independent of level");
  // =========================================================================
  {
    setUser(ssOnly.user);
    global.__TEACHER__ = ssOnly;

    eq(ids((await route.GET(req())).body).sort().join(","), "l-ss-1,l-ss-2", "O6: an SS-only teacher sees only their own course");
    const widened = await route.GET(req("?academicLevel=FIRST_SECONDARY"));
    eq(widened.status, 200, "O6: …and the request itself is still valid");
    eq(ids(widened.body).length, 0, "O6: …but asking for a level they do not teach returns NOTHING (no widening)");

    setUser(both.user);
    global.__TEACHER__ = both;
    const fs = await route.GET(req("?academicLevel=FIRST_SECONDARY"));
    const tracks = (fs.body.lessons || []).map((l) => l.trackScope).sort().join(",");
    ok(tracks.includes("LANGUAGE") && tracks.includes("ARABIC"), "O7: the level filter keeps both TRACKS (level ≠ track)", tracks);
  }

  // =========================================================================
  section("O8. The level is derived from Course — never stored on Teacher");
  // =========================================================================
  {
    const schema = read("prisma/schema.prisma");
    const teacherModel = /model Teacher \{[\s\S]*?\n\}/.exec(schema)[0];
    ok(!/academicLevel/.test(teacherModel), "O8: Teacher still has NO academicLevel column");
    ok(/academicLevel/.test(/model Course \{[\s\S]*?\n\}/.exec(schema)[0]), "O8: Course owns the level (the single authority)");
    const routeSrc = read(ROUTE_REL);
    ok(/teacherCourseIds\(/.test(routeSrc), "O8: the route still scopes by the teacher's own course ids");
    // Phase L manual-QA fix #4 — the narrowing is now ONE shared helper composed
    // by every teacher list route, and that helper derives the level through the
    // COURSE relation (`groupsOfLevelWhere` = `{ course: { academicLevel } }`),
    // never from the group itself and never from a stored teacher column.
    const scopeSrc = read("src/lib/teacher-academic-level.ts");
    ok(
      /groupsOfLevelWhere\(level\)/.test(scopeSrc),
      "O8: the level narrowing reads the COURSE relation through the ONE shared predicate"
    );
    ok(
      /client\.group\.findMany\(\{\s*where: \{ teacherId: teacher\.id, \.\.\.groupsOfLevelWhere\(level\) \}/.test(scopeSrc),
      "O8: …as an extra `where` on the teacher's OWN groups (a DB query, not an in-memory hide)"
    );
    ok(
      /scopedTeacherGroups\(teacher, levelParam\.level\)/.test(read("src/app/api/teacher/dashboard/route.ts")),
      "O8: the dashboard aggregates every number from that scoped group set"
    );
  }

  // =========================================================================
  section("O-E2E. Server-side level filtering on EVERY teacher list route");
  // =========================================================================
  // The corrections require proof that the separator is enforced IN THE QUERY,
  // not by hiding rows in React. Each route below is the REAL compiled handler
  // running against a REAL SQLite database holding BOTH curricula, while the
  // teacher owns a group in each level. A level request must return ONLY that
  // level's rows; an unfiltered request must return both; an unknown value must
  // be refused; and a teacher who owns only one level must never receive the
  // other level's data even when they ask for it.
  {
    // (Every row these routes read was seeded above, before the O sections.)
    const routes = {};
    for (const rel of ROUTES) routes[rel] = require(ROUTE_JS[rel]);

    const R_LESSONS = ROUTES[0];
    const R_HOMEWORK = "src/app/api/teacher/homework/route.ts";
    const R_QUIZZES = "src/app/api/teacher/quizzes/route.ts";
    const R_SESSIONS = "src/app/api/teacher/sessions/route.ts";
    const R_DASHBOARD = "src/app/api/teacher/dashboard/route.ts";
    const R_ANALYTICS = "src/app/api/teacher/analytics/route.ts";
    const R_ATTENDANCE = "src/app/api/teacher/attendance/route.ts";

    const call = async (rel, qs, teacher) => {
      global.__TEACHER__ = teacher;
      setUser(teacher.user);
      return routes[rel].GET({ url: `http://localhost/api/teacher/x${qs || ""}` });
    };
    /** The payload of a handler result (the api stub returns `{status, body}`). */
    const body = (res) => res.body || {};
    /** Deep array comparison — `eq` is strict identity, which arrays never are. */
    const eqArr = (actual, expected, msg) =>
      ok(
        JSON.stringify(actual) === JSON.stringify(expected),
        msg,
        JSON.stringify(actual) === JSON.stringify(expected)
          ? undefined
          : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`
      );
    const FS = "?academicLevel=FIRST_SECONDARY";
    const SS = "?academicLevel=SECOND_SECONDARY";
    const rid = (rel) => rel.replace("src/app/api/teacher/", "").replace("/route.ts", "");

    // ---- 1. every route refuses an unknown level (never a silent "all") ----
    for (const rel of ROUTES) {
      // Attendance validates the group FIRST (authz before parsing), so it is
      // asked with a group this teacher really owns.
      const qs =
        rel === R_ATTENDANCE
          ? "?groupId=g-fs&academicLevel=THIRD_SECONDARY"
          : "?academicLevel=THIRD_SECONDARY";
      const res = await call(rel, qs, both);
      eq(res.status, 400, `E2E/${rid(rel)}: an unknown academic level is refused with a 400`);
      eq(body(res).error, "Unknown academic level", `E2E/${rid(rel)}: …with the explicit reason`);
    }

    // ---- 2. the lessons picker (the original approved surface) -------------
    {
      const all = await call(R_LESSONS, "", both);
      const fs = await call(R_LESSONS, FS, both);
      const ss = await call(R_LESSONS, SS, both);
      eq(body(all).scope.spansBothLevels, true, "E2E/lessons: the payload reports that this teacher spans both levels");
      ok(!body(fs).lessons.some((l) => l.course.academicLevel !== "FIRST_SECONDARY"), "E2E/lessons: the FS request returns ONLY First Secondary lessons");
      ok(!body(ss).lessons.some((l) => l.course.academicLevel !== "SECOND_SECONDARY"), "E2E/lessons: the SS request returns ONLY Second Secondary lessons");
      ok(body(fs).lessons.length > 0 && body(ss).lessons.length > 0, "E2E/lessons: both levels are reachable");
      eq(body(fs).scope.spansBothLevels, true, "E2E/lessons: the scope still describes the FULL group set while a level is selected");
    }

    // ---- 3. homework -------------------------------------------------------
    {
      const all = await call(R_HOMEWORK, "", both);
      const fs = await call(R_HOMEWORK, FS, both);
      const ss = await call(R_HOMEWORK, SS, both);
      const ids = (res) => (body(res).homework || []).map((h) => h.id);
      ok(ids(all).includes("hw-fs") && ids(all).includes("hw-ss"), "E2E/homework: an unfiltered request still returns BOTH levels");
      eqArr(ids(fs), ["hw-fs"], "E2E/homework: FS returns only the First Secondary homework");
      eqArr(ids(ss), ["hw-ss"], "E2E/homework: SS returns only the Second Secondary homework");
      eq(body(fs).scope.spansBothLevels, true, "E2E/homework: the scope is present on the filtered payload");
      // The group filter COMPOSES with the level: pairing a group of one level
      // with the other level can never reach the other level's content.
      const crossed = await call(R_HOMEWORK, "?groupId=g-ss&academicLevel=FIRST_SECONDARY", both);
      eqArr((body(crossed).homework || []).map((h) => h.id), [], "E2E/homework: a cross-level group+level pair yields nothing (no widening)");
    }

    // ---- 4. quizzes --------------------------------------------------------
    {
      const fs = await call(R_QUIZZES, FS, both);
      const ss = await call(R_QUIZZES, SS, both);
      const ids = (res) => (body(res).quizzes || []).map((q) => q.id);
      eqArr(ids(fs), ["qz-fs"], "E2E/quizzes: FS returns only the First Secondary quiz");
      eqArr(ids(ss), ["qz-ss"], "E2E/quizzes: SS returns only the Second Secondary quiz");
      eq(body(fs).scope.spansBothLevels, true, "E2E/quizzes: the scope is present on the filtered payload");
    }

    // ---- 5. sessions (the lesson/session roster) ---------------------------
    {
      const fs = await call(R_SESSIONS, FS, both);
      const ss = await call(R_SESSIONS, SS, both);
      const courses = (res) =>
        Array.from(new Set((body(res).sessions || []).map((x) => x.course && x.course.id)));
      eqArr(courses(fs), ["c-fs"], "E2E/sessions: FS returns lessons of the First Secondary course only");
      eqArr(courses(ss), ["c-ss"], "E2E/sessions: SS returns lessons of the Second Secondary course only");
      eq(body(fs).scope.spansBothLevels, true, "E2E/sessions: the scope is present");
    }

    // ---- 6. dashboard (every aggregate follows the level) ------------------
    {
      const all = await call(R_DASHBOARD, "", both);
      const fs = await call(R_DASHBOARD, FS, both);
      const ss = await call(R_DASHBOARD, SS, both);
      const gids = (res) => (body(res).groups || []).map((g) => g.id);
      ok(gids(all).includes("g-fs") && gids(all).includes("g-ss"), "E2E/dashboard: an unfiltered request returns both groups");
      eqArr(gids(fs), ["g-fs"], "E2E/dashboard: FS returns only the First Secondary group");
      eqArr(gids(ss), ["g-ss"], "E2E/dashboard: SS returns only the Second Secondary group");
      eq(body(fs).scope.spansBothLevels, true, "E2E/dashboard: the scope is present");
      eq(body(fs).groups[0].studentsCount, 1, "E2E/dashboard: the FS headcount covers only the FS group's students");
      eq(body(ss).groups[0].studentsCount, 1, "E2E/dashboard: …and the SS headcount only the SS group's");
      ok(
        !JSON.stringify(body(fs)).includes("sess-ss"),
        "E2E/dashboard: the other level's live session never appears in the FS payload"
      );
      // Every aggregate is computed from the SCOPED groups: no SS value may
      // appear anywhere in the FS payload.
      const flat = JSON.stringify(body(fs));
      ok(!flat.includes("SS group") && !flat.includes("s-ss") && !flat.includes("CM-SS01"), "E2E/dashboard: no Second Secondary group/student leaks into the FS aggregates");
      eq(body(fs).groups[0].course.academicLevel, "FIRST_SECONDARY", "E2E/dashboard: the group rows still carry the canonical level");
    }

    // ---- 7. analytics ------------------------------------------------------
    {
      const fs = await call(R_ANALYTICS, FS, both);
      const ss = await call(R_ANALYTICS, SS, both);
      eq(fs.status, 200, "E2E/analytics: the FS analytics payload is served");
      eq(ss.status, 200, "E2E/analytics: the SS analytics payload is served");
      const gids = (res) => (body(res).groups || []).map((g) => g.groupId);
      eqArr(gids(fs), ["g-fs"], "E2E/analytics: FS returns only the First Secondary group's rows");
      eqArr(gids(ss), ["g-ss"], "E2E/analytics: SS returns only the Second Secondary group's rows");
      eq(body(fs).scope.spansBothLevels, true, "E2E/analytics: the scope is present");
      eq(body(fs).overview && body(fs).overview.totalStudents, 1, "E2E/analytics: the headline numbers are computed from the SCOPED groups");
      ok(!JSON.stringify(body(fs)).includes("SS group"), "E2E/analytics: no Second Secondary group row leaks into the FS analytics");
    }

    // ---- 8. attendance (roster + the mismatch guard) -----------------------
    {
      const fs = await call(R_ATTENDANCE, "?groupId=g-fs&sessionId=sess-fs&academicLevel=FIRST_SECONDARY", both);
      eq(fs.status, 200, "E2E/attendance: the FS group roster loads under the FS level");
      eqArr((body(fs).students || []).map((x) => x.id), ["s-fs"], "E2E/attendance: …and contains only the FS student");
      const mismatch = await call(R_ATTENDANCE, "?groupId=g-fs&sessionId=sess-fs&academicLevel=SECOND_SECONDARY", both);
      eq(mismatch.status, 403, "E2E/attendance: pairing an FS group with the SS level is REFUSED (403)");
      eq(body(mismatch).error, "api.156", "E2E/attendance: …through the existing ownership refusal");
      const foreign = await call(R_ATTENDANCE, "?groupId=g-ss2&sessionId=sess-fs", both);
      eq(foreign.status, 403, "E2E/attendance: a group this teacher does NOT own is still refused (authz unchanged)");
    }

    // ---- 9. a single-level teacher never receives the other level ---------
    {
      // `ssOnly` owns only `g-ss2` (Second Secondary). Asking for the FIRST
      // level must be an EMPTY (never a widened) result on every surface.
      for (const [rel, marker] of [
        [R_LESSONS, "l-fs"],
        [R_HOMEWORK, "hw-fs"],
        [R_QUIZZES, "qz-fs"],
        [R_SESSIONS, "c-fs"],
        [R_DASHBOARD, "g-fs"],
        [R_ANALYTICS, "g-fs"],
      ]) {
        const res = await call(rel, "?academicLevel=FIRST_SECONDARY", ssOnly);
        eq(res.status, 200, `E2E/${rid(rel)}: a level the teacher does not own is served as EMPTY, never an error`);
        eq(body(res).scope.spansBothLevels, false, `E2E/${rid(rel)}: …and the scope reports a single-level teacher`);
        ok(!JSON.stringify(body(res)).includes(marker), `E2E/${rid(rel)}: nothing from the First Secondary level leaks (no widening)`);
        ok(!JSON.stringify(body(res)).includes("c-fs"), `E2E/${rid(rel)}: …and the FS course id never appears either`);
      }
      // …while their OWN level keeps working, and returns nothing else.
      const own = await call(R_LESSONS, SS, ssOnly);
      ok(body(own).lessons.length > 0, "E2E/lessons: the single-level teacher still sees their own level");
      ok(body(own).lessons.every((l) => l.course.academicLevel === "SECOND_SECONDARY"), "E2E/lessons: …and nothing else");
      const ownGroups = await call(R_DASHBOARD, SS, ssOnly);
      eqArr((body(ownGroups).groups || []).map((g) => g.id), ["g-ss2"], "E2E/dashboard: …and only their own group is listed");
      // The OTHER teacher's group of the SAME level is still invisible.
      const bothSameLevel = await call(R_DASHBOARD, SS, both);
      eqArr((body(bothSameLevel).groups || []).map((g) => g.id), ["g-ss"], "E2E/dashboard: ownership is still enforced inside a level (a peer's group is not listed)");
    }
  }

  // =========================================================================
  section("O-UI. Every teacher selector that can mix levels shows the level");
  // =========================================================================
  {
    const authoring = read("src/components/teacher/teacher-authoring.tsx");
    ok(
      /academicLevelLabel/.test(authoring) && /OptionalAcademicLevelFilter/.test(authoring),
      "UI: the authoring lesson picker renders the SHARED, scope-aware level control"
    );
    ok(/function lessonLabel\([\s\S]{0,400}academicLevelLabel/.test(authoring),
      "UI: lesson labels lead with the canonical level (level · code · title)");

    const dashboard = read("src/components/teacher/teacher-dashboard.tsx");
    ok((dashboard.match(/academicLevelLabel/g) || []).length >= 3,
      "UI: the dashboard group selectors/cards/analytics rows all label the level");
    ok(/academicLevelLabel\(tr, g\.course\?\.academicLevel\)/.test(dashboard),
      "UI: group options label with the course level");

    ok(
      (authoring.match(/useTeacherLessons\(/g) || []).length >= 1 &&
        (dashboard.match(/useTeacherLessons\(/g) || []).length >= 1,
      "UI: the lesson pickers (authoring + dashboard) read the same level-aware list"
    );

    // ---------------------------------------------------------------------
    // FIX #4 CORRECTION — the separator must be present on EVERY surface where
    // both levels can appear, and absent where they cannot.
    // ---------------------------------------------------------------------
    const SEP = /OptionalAcademicLevelFilter/g;
    const ui = read("src/components/admin/academic-level-ui.tsx");
    ok(
      /const spans = typeof scope === "boolean" \? scope : !!scope\?\.spansBothLevels;\s*\n\s*if \(!spans\) return null;/.test(ui),
      "UI: the shared control renders NOTHING unless the teacher's own scope spans both levels"
    );
    ok(
      /data-academic-level-scope="BOTH"/.test(ui),
      "UI: …and marks itself so the rendered state is observable"
    );

    // Present on every multi-level surface.
    const separatorSurfaces = [
      ["src/components/teacher/teacher-dashboard.tsx", 5, "dashboard overview / attendance / quizzes / homework / analytics"],
      ["src/components/teacher/teacher-sessions.tsx", 1, "session roster"],
      ["src/components/teacher/readiness-view.tsx", 1, "readiness lesson picker"],
      ["src/components/teacher/teacher-authoring.tsx", 1, "authoring lesson picker"],
    ];
    for (const [file, min, label] of separatorSurfaces) {
      const count = (read(file).match(SEP) || []).length;
      ok(count >= min, `UI: the level separator is wired on the ${label} surface`, `found ${count}, want ≥ ${min}`);
    }
    // …and each of those surfaces narrows its data through the SERVER.
    const serverWired = [
      ["src/components/teacher/teacher-dashboard.tsx", /withLevelQuery\(/, "quizzes/homework lists"],
      ["src/components/teacher/teacher-dashboard.tsx", /levelQuery\(level\)/, "dashboard/analytics payloads"],
      ["src/components/teacher/teacher-sessions.tsx", /academicLevel=\$\{encodeURIComponent\(level\)\}/, "session roster"],
      ["src/components/teacher/readiness-view.tsx", /academicLevel=\$\{encodeURIComponent\(level\)\}/, "readiness picker"],
      ["src/components/teacher/teacher-authoring.tsx", /useTeacherLessons\(level \|\| undefined\)/, "authoring picker"],
    ];
    for (const [file, re, label] of serverWired) {
      ok(re.test(read(file)), `UI: the ${label} separator narrows the SERVER query (never a client-side hide)`);
    }

    // ABSENT on single-level surfaces — each with its reason.
    ok(
      !SEP.test(read("src/components/teacher/live-sessions-workspace.tsx")),
      "UI: the new-session dialog has NO separator (it is already scoped to ONE group = one level)"
    );
    const notes = dashboard.slice(dashboard.indexOf("function StudentNotesDialog"), dashboard.indexOf("function StatusButton"));
    ok(
      !SEP.test(notes) && /teacher-notes/.test("teacher-notes") === false ? true : !SEP.test(notes),
      "UI: the per-student notes dialog has NO separator (one student = one level)"
    );
    const attendanceWrite = dashboard.slice(dashboard.indexOf("function AttendanceView"), dashboard.indexOf("function StudentNotesDialog"));
    ok(
      (attendanceWrite.match(SEP) || []).length === 1,
      "UI: the attendance surface has exactly ONE separator (the picker); the WRITE path stays group-bound"
    );
    ok(
      !/academicLevel/.test(read("src/app/api/teacher/templates/route.ts")),
      "UI: lesson-plan templates stay level-free by design (a template has no course/lesson) — no separator there"
    );

    const sessions = read("src/components/teacher/teacher-sessions.tsx");
    ok(/academicLevelLabel/.test(sessions), "UI: the session list labels courses with their level");

    const readiness = read("src/components/teacher/readiness-view.tsx");
    ok(/academicLevelLabel/.test(readiness), "UI: the readiness lesson picker labels lessons with their level");

    const live = read("src/components/teacher/live-sessions-workspace.tsx");
    ok(/academicLevelLabel/.test(live), "UI: the live-session schedule form labels its group options with the level");
    const scope = read("src/lib/live-sessions.ts");
    ok(/academicLevel: g\.course\?\.academicLevel \?\? null/.test(scope),
      "UI: the group scope carries the level DERIVED from the group's course");

    // One vocabulary: every teacher surface imports the shared admin-free UI
    // helper instead of inventing its own Arabic/English level strings.
    for (const f of [
      "src/components/teacher/teacher-authoring.tsx",
      "src/components/teacher/teacher-dashboard.tsx",
      "src/components/teacher/teacher-sessions.tsx",
      "src/components/teacher/readiness-view.tsx",
      "src/components/teacher/live-sessions-workspace.tsx",
    ]) {
      ok(/from "@\/components\/admin\/academic-level-ui"/.test(read(f)),
        `UI: ${path.basename(f)} reuses the ONE shared level vocabulary`);
    }
  }

  // -------------------------------------------------------------------------
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`\nteacher academic level (phase L): ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nHARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
