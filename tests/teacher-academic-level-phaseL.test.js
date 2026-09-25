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
//   UI/SELECTOR CONTEXT (source pins — the reported defect was a selector that
//   could not tell the two levels apart):
//     * the teacher dashboard group selectors, group cards and analytics rows
//       carry the course level;
//     * the quiz/homework/lesson pickers render it in the option labels;
//     * the session-videos filter and the teacher session/readiness pickers use
//       the ONE shared level vocabulary (`academic-level-ui`), not a new one.
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
      files: [path.join(REPO, ROUTE_REL)],
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
  if (!fs.existsSync(LESSONS_JS)) {
    console.error(`tsc did not emit ${LESSONS_JS}`);
    process.exit(1);
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
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return shim;
    if (request === "@/lib/api") return apiStub;
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
  const req = (qs) => ({ nextUrl: new URL(`http://localhost/api/teacher/lessons${qs || ""}`) });
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
  const both = {
    id: "t-both",
    user: { id: "u-both", name: "Both", email: "both@x.test", role: "TEACHER" },
    groups: [
      { id: "g-fs", name: "FS group", courseId: "c-fs", course: { id: "c-fs", name: COURSES[0].name, nameAr: COURSES[0].nameAr, academicLevel: "FIRST_SECONDARY" } },
      { id: "g-ss", name: "SS group", courseId: "c-ss", course: { id: "c-ss", name: COURSES[1].name, nameAr: COURSES[1].nameAr, academicLevel: "SECOND_SECONDARY" } },
    ],
  };
  const ssOnly = {
    id: "t-ss",
    user: { id: "u-ss", name: "SS", email: "ss@x.test", role: "TEACHER" },
    groups: [
      { id: "g-ss2", name: "SS group 2", courseId: "c-ss", course: { id: "c-ss", name: COURSES[1].name, nameAr: COURSES[1].nameAr, academicLevel: "SECOND_SECONDARY" } },
    ],
  };

  const ids = (body) => (body.lessons || []).map((l) => l.id);
  const levelsOf = (body) => Array.from(new Set((body.lessons || []).map((l) => l.course && l.course.academicLevel)));

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
    ok(/g\?\.course\?\.academicLevel/.test(routeSrc), "O8: the level narrowing reads the COURSE relation, not the group");
  }

  // =========================================================================
  section("O-UI. Every teacher selector that can mix levels shows the level");
  // =========================================================================
  {
    const authoring = read("src/components/teacher/teacher-authoring.tsx");
    ok(/academicLevelLabel/.test(authoring) && /AcademicLevelSegmentedFilter/.test(authoring),
      "UI: the authoring lesson picker renders the shared level control");
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
