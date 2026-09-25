// CodeMind Academy — Admin → Session Videos: one-click ACADEMIC LEVEL filter
// (Phase L manual-QA fix).
//
// WHAT IT PROVES
//   The session-video picker used to mix First Secondary and Second Secondary
//   lessons in one list (their printed officialCodes even collide), so the
//   admin had no way to pick "the 1-1 of the First Secondary curriculum".
//
//   N1. With the filter on `[ الكل ]` (ALL) the picker shows BOTH levels.
//   N2. `[ أولى ثانوي ]` (FIRST_SECONDARY) returns ONLY First Secondary
//       lessons — no Part/Unit/lesson of the other level leaks in.
//   N3. `[ ثانية ثانوي ]` (SECOND_SECONDARY) returns ONLY Second Secondary.
//   N4. The SAME printed officialCode in both levels does not collide: both
//       exist, and each filter resolves the code to exactly one lesson id.
//   N5. `[ TRACK ]` composition still works: the track filter is applied by the
//       batch (schoolType) and is independent of the level — a level filter
//       keeps every track that the batch already allows.
//   N6. Selection identity is the lesson ID, so a First Secondary lesson can
//       never resolve to a Second Secondary lesson with the same code.
//   N7. The filter is applied on the CANONICAL relation (`Course.academicLevel`
//       as returned by the real admin course tree) — not on the lesson title,
//       not on an officialCode prefix, not on static ids.
//   N8. The UI renders the one-click SEGMENTED control above the picker (not
//       another dropdown), reusing the shared level vocabulary, and clears a
//       now-ineligible selection when the level changes.
//
// The REAL admin course-tree route is compiled with the repo's own tsc and run
// against a REAL SQLite database, and its payload is fed to the REAL
// `buildLessonGroups` picker. Nothing is re-implemented here.
//
// Portable: no shell of any kind — runs unchanged on Windows and Linux CI.
//
// Run: node tests/session-videos-level-filter-phaseL.test.js

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { pathToFileURL } = require("url");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-videolevel-"));

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

(async () => {
  // -------------------------------------------------------------------------
  // Compile the REAL tree route (and, through it, the picker library)
  // -------------------------------------------------------------------------
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
      // The picker is compiled explicitly: it is the module UNDER TEST, not a
      // transitive dependency of the route.
      files: [
        path.join(REPO, "src/app/api/admin/courses/route.ts"),
        path.join(REPO, "src/lib/session-video-picker.ts"),
      ],
    })
  );
  const TSC_BIN = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
  if (!fs.existsSync(TSC_BIN)) {
    console.error("typescript is not installed — run npm install");
    process.exit(1);
  }
  spawnSync(process.execPath, [TSC_BIN, "-p", path.join(OUT, "tsconfig.json")], { cwd: REPO, encoding: "utf8" });
  const EMIT = path.join(OUT, "src");
  const COURSES_JS = path.join(EMIT, "app/api/admin/courses/route.js");
  if (!fs.existsSync(COURSES_JS)) {
    console.error(`tsc did not emit ${COURSES_JS}`);
    process.exit(1);
  }

  const { DatabaseSync } = require("node:sqlite");
  const { applyMigrations } = await import(pathToFileURL(path.join(REPO, "scripts/lib/migrate-sqlite.mjs")).href);
  const { createSqlitePrisma } = await import(pathToFileURL(path.join(REPO, "scripts/lib/sqlite-prisma-lite.mjs")).href);

  global.__CM_DB__ = null;
  const shim = path.join(OUT, "__db-shim__.js");
  fs.writeFileSync(shim, "module.exports = { get db() { return global.__CM_DB__; } };");
  const apiStub = path.join(OUT, "__api__.js");
  fs.writeFileSync(
    apiStub,
    "module.exports = { ok:(d,s)=>({status:s||200,body:d}), err:(e,s)=>({status:s||400,body:{error:e}}), requireRole: async()=>({ user:{id:'admin-1',role:'ADMIN'}, error:null }) };"
  );
  const headersStub = path.join(OUT, "__next-headers__.js");
  fs.writeFileSync(headersStub, "module.exports = { cookies: async()=>({ get:()=>undefined, set:()=>{} }) };");
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === "@/lib/db") return shim;
    if (request === "@/lib/api") return apiStub;
    if (request === "next/headers") return headersStub;
    const alias = /^@\/lib\/([\w/-]+)$/.exec(request);
    if (alias) {
      const compiled = path.join(EMIT, "lib", `${alias[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    return origResolve.call(this, request, ...rest);
  };

  const dbFile = path.join(OUT, "videos.db");
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

  const coursesRoute = require(COURSES_JS);

  // -------------------------------------------------------------------------
  // Seed both official curricula with COLLIDING printed codes
  // -------------------------------------------------------------------------
  const NOW = Date.now();
  function ins(table, values) {
    const cols = Object.keys(values);
    d.prepare(
      `INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES (${cols.map(() => "?").join(",")})`
    ).run(...cols.map((c) => values[c]));
  }
  const LEVELS = [
    { id: "c-fs", level: "FIRST_SECONDARY", slug: "programming-ai-1st-sec", nameAr: "البرمجة والذكاء الاصطناعي" },
    { id: "c-ss", level: "SECOND_SECONDARY", slug: "programming-ai-2nd-sec", nameAr: "البرمجة والذكاء الاصطناعي" },
  ];
  for (const c of LEVELS) {
    ins("Course", { id: c.id, slug: c.slug, academicLevel: c.level, name: "Programming & AI", nameAr: c.nameAr, description: "d", color: "#000000", createdAt: NOW, updatedAt: NOW });
    ins("Part", { id: `p-${c.id}`, courseId: c.id, title: "First Secondary Curriculum", titleAr: "منهج", order: 1 });
    ins("Unit", { id: `u-${c.id}`, partId: `p-${c.id}`, title: "Unit 1", titleAr: "الوحدة ١", order: 1 });
    // The SAME printed codes in both levels — the real 18-collision shape.
    ins("Lesson", { id: `l-${c.id}-1`, unitId: `u-${c.id}`, officialCode: "1-1", academicLevel: c.level, trackScope: "SHARED", status: "PUBLISHED", title: "Intro", titleAr: "مقدمة", order: 1, createdAt: NOW, updatedAt: NOW });
    ins("Lesson", { id: `l-${c.id}-2`, unitId: `u-${c.id}`, officialCode: "1-2", academicLevel: c.level, trackScope: "SHARED", status: "PUBLISHED", title: "Sec", titleAr: "ثاني", order: 2, createdAt: NOW, updatedAt: NOW });
  }
  // Track-scoped lessons: the Arabic/Language axis must stay INDEPENDENT of
  // the level axis (a level filter never becomes a track filter).
  ins("Lesson", { id: "l-c-fs-lang", unitId: "u-c-fs", officialCode: "1-3", academicLevel: "FIRST_SECONDARY", trackScope: "LANGUAGE", status: "PUBLISHED", title: "Lang", titleAr: "لغة", order: 3, createdAt: NOW, updatedAt: NOW });
  ins("Lesson", { id: "l-c-fs-ar", unitId: "u-c-fs", officialCode: "1-4", academicLevel: "FIRST_SECONDARY", trackScope: "ARABIC", status: "PUBLISHED", title: "Ar", titleAr: "عربي", order: 4, createdAt: NOW, updatedAt: NOW });
  // An ARCHIVED lesson must never appear under any filter.
  ins("Lesson", { id: "l-c-fs-arch", unitId: "u-c-fs", officialCode: "1-5", academicLevel: "FIRST_SECONDARY", trackScope: "SHARED", status: "PUBLISHED", curriculumStatus: "ARCHIVED", title: "Old", titleAr: "قديم", order: 5, createdAt: NOW, updatedAt: NOW });

  // -------------------------------------------------------------------------
  // The REAL tree payload → the REAL picker
  // -------------------------------------------------------------------------
  const picker = require(path.join(EMIT, "lib/session-video-picker.js"));

  const treeRes = await coursesRoute.GET({ url: "http://localhost/api/admin/courses?tree=1", nextUrl: new URL("http://localhost/api/admin/courses?tree=1") });
  const courses = treeRes.body.courses || treeRes.body.data || [];
  const allGroups = (batch, level) => picker.buildLessonGroups(courses, batch, level);
  const idsOf = (groups) => groups.flatMap((g) => g.lessons.map((l) => l.id)).sort();
  const levelsOf = (groups) => Array.from(new Set(groups.map((g) => g.courseAcademicLevel))).sort();
  const codesOf = (groups) => groups.flatMap((g) => g.lessons.map((l) => l.officialCode));

  // REAL batches always carry a canonical school type: `lessonFitsBatch` is
  // fail-closed for anything else (a batch with no audience can never be sold).
  // A pool batch (no course bound) sees every course, so the two batches below
  // separate the TRACK axis (LANGUAGE vs ARABIC) from the LEVEL axis.
  const poolBatch = { id: "b-lang", name: "Language pool", course: null, schoolType: "LANGUAGE" };
  const arabicBatch = { id: "b-ar", name: "Arabic pool", course: null, schoolType: "ARABIC" };

  // =========================================================================
  section("N1. [ الكل ] — both levels are offered");
  // =========================================================================
  {
    eq(treeRes.status, 200, "the real admin course tree loads");
    ok(courses.length === 2, "the tree carries both official courses", `got ${courses.length}`);
    if (process.env.CM_DUMP_TREE === "1") {
      console.log("TREE:", JSON.stringify(courses.map((c) => ({
        id: c.id, level: c.academicLevel, parts: (c.parts || []).map((p) => ({ units: (p.units || []).map((u) => ({ id: u.id, lessons: (u.lessons || []).map((l) => l.id), topics: (u.topics || []).length })) })),
      })), null, 1));
    }

    const all = allGroups(poolBatch, "");
    eq(levelsOf(all).join(","), "FIRST_SECONDARY,SECOND_SECONDARY", "N1: ALL shows BOTH levels");
    const ids = idsOf(all);
    ok(ids.includes("l-c-fs-1") && ids.includes("l-c-ss-1"), "N1: …including the colliding 1-1 lessons of both levels");
    ok(ids.includes("l-c-fs-arch") === false, "N1: archived lessons stay excluded");
    // Non-vacuous: the archived lesson IS in the tree, so the line above is a
    // real exclusion rather than an empty list.
    const treeLessonIds = courses.flatMap((c) => (c.parts || []).flatMap((p2) => (p2.units || []).flatMap((u) => (u.lessons || []).map((l) => l.id))));
    ok(treeLessonIds.includes("l-c-fs-arch"), "N1: …and it really is in the course tree");

    const undef = allGroups(poolBatch, undefined);
    eq(idsOf(undef).join(","), ids.join(","), "N1: the default (no filter) is identical to ALL");
  }

  // =========================================================================
  section("N2–N3. One click narrows to exactly one level");
  // =========================================================================
  {
    const fsGroups = allGroups(poolBatch, "FIRST_SECONDARY");
    eq(levelsOf(fsGroups).join(","), "FIRST_SECONDARY", "N2: FIRST_SECONDARY returns only First Secondary nodes");
    const fsIds = idsOf(fsGroups);
    ok(!fsIds.some((id) => id.startsWith("l-c-ss")), "N2: no Second Secondary lesson leaks in");
    eq(fsIds.join(","), "l-c-fs-1,l-c-fs-2,l-c-fs-lang", "N2: exactly the First Secondary lessons the batch fits are offered");

    const ssGroups = allGroups(poolBatch, "SECOND_SECONDARY");
    eq(levelsOf(ssGroups).join(","), "SECOND_SECONDARY", "N3: SECOND_SECONDARY returns only Second Secondary nodes");
    const ssIds = idsOf(ssGroups);
    ok(!ssIds.some((id) => id.startsWith("l-c-fs")), "N3: no First Secondary lesson leaks in");
    eq(ssIds.join(","), "l-c-ss-1,l-c-ss-2", "N3: exactly the Second Secondary lessons are offered");

    // An unknown value can never widen the list (fail-closed).
    eq(idsOf(allGroups(poolBatch, "THIRD_SECONDARY")).length, 0, "N2: an unrecognised level offers NOTHING (fail-closed)");
  }

  // =========================================================================
  section("N4–N6. Collisions, identity and track composition");
  // =========================================================================
  {
    const all = allGroups(poolBatch, "");
    const colliding = codesOf(all).filter((c) => c === "1-1");
    eq(colliding.length, 2, "N4: the same printed code appears twice under ALL");

    const fsLesson = idsOf(allGroups(poolBatch, "FIRST_SECONDARY")).filter((id) => id === "l-c-fs-1");
    const ssLesson = idsOf(allGroups(poolBatch, "SECOND_SECONDARY")).filter((id) => id === "l-c-ss-1");
    eq(fsLesson.join(","), "l-c-fs-1", "N4: the First filter resolves 1-1 to the First lesson");
    eq(ssLesson.join(","), "l-c-ss-1", "N4: the Second filter resolves 1-1 to the Second lesson");
    ok(fsLesson[0] !== ssLesson[0], "N6: the two lessons have different identities (selection is by ID)");

    // Selection identity: the flattened eligible ids of a level filter can only
    // ever contain that level's lessons — so a stale selection cannot silently
    // point at the same-coded lesson of the other level.
    const fsEligible = Array.from(picker.flattenEligibleLessonIds(allGroups(poolBatch, "FIRST_SECONDARY")));
    ok(fsEligible.includes("l-c-fs-1") && !fsEligible.includes("l-c-ss-1"), "N6: a First Secondary selection can never resolve to the Second Secondary 1-1");
    const ssEligible = Array.from(picker.flattenEligibleLessonIds(allGroups(poolBatch, "SECOND_SECONDARY")));
    ok(ssEligible.includes("l-c-ss-1") && !ssEligible.includes("l-c-fs-1"), "N6: …and vice versa");

    // Track composition: the TRACK is chosen by the batch (schoolType) and is
    // an axis of its own — the level filter never becomes a track filter.
    const langFs = idsOf(allGroups(poolBatch, "FIRST_SECONDARY"));
    ok(langFs.includes("l-c-fs-lang"), "N5: a LANGUAGE batch keeps LANGUAGE lessons");
    ok(langFs.includes("l-c-fs-1"), "N5: …and SHARED lessons");
    ok(!langFs.includes("l-c-fs-ar"), "N5: …and still excludes ARABIC lessons");

    const arFs = idsOf(allGroups(arabicBatch, "FIRST_SECONDARY"));
    ok(arFs.includes("l-c-fs-ar"), "N5: an ARABIC batch keeps ARABIC lessons");
    ok(arFs.includes("l-c-fs-1"), "N5: …and SHARED lessons");
    ok(!arFs.includes("l-c-fs-lang"), "N5: …and still excludes LANGUAGE lessons");
    eq(levelsOf(allGroups(arabicBatch, "FIRST_SECONDARY")).join(","), "FIRST_SECONDARY", "N5: the level axis stays intact under either track batch");
    eq(idsOf(allGroups(arabicBatch, "SECOND_SECONDARY")).join(","), "l-c-ss-1,l-c-ss-2", "N5: …and the level filter is identical for both tracks");
  }

  // =========================================================================
  section("N7. Canonical relationship, not labels or static ids");
  // =========================================================================
  {
    // The very same lesson objects, but with the level MOVED on the course:
    // the filter must follow `Course.academicLevel`, which is the only thing
    // that decides the outcome.
    const swapped = JSON.parse(JSON.stringify(courses));
    for (const c of swapped) c.academicLevel = c.id === "c-fs" ? "SECOND_SECONDARY" : "FIRST_SECONDARY";
    const moved = picker.buildLessonGroups(swapped, poolBatch, "FIRST_SECONDARY");
    const movedIds = idsOf(moved);
    ok(movedIds.includes("l-c-ss-1") && !movedIds.includes("l-c-fs-1"),
      "N7: the filter follows Course.academicLevel (proved by swapping the two courses)");

    // Titles/codes lie — a lesson whose CODE says '1-1' but whose course is
    // Second Secondary must be offered under Second Secondary, not First.
    eq(picker.courseMatchesLevel("FIRST_SECONDARY", "FIRST_SECONDARY"), true, "N7: courseMatchesLevel matches exactly");
    eq(picker.courseMatchesLevel("SECOND_SECONDARY", "FIRST_SECONDARY"), false, "N7: …and never by prefix");
    eq(picker.courseMatchesLevel(null, ""), true, "N7: legacy unlevelled courses stay visible under ALL");
    eq(picker.courseMatchesLevel(null, "FIRST_SECONDARY"), false, "N7: …and are excluded by an explicit level (fail-closed)");

    const src = read("src/lib/session-video-picker.ts");
    ok(/Course\.academicLevel/.test(src), "N7: the picker documents the canonical Course.academicLevel authority");
    ok(!/officialCode\.startsWith|title\.includes\(.*أولى|title\.includes\(.*ثانية/.test(src),
      "N7: no title/code heuristic is used to decide a level");
  }

  // =========================================================================
  section("N8. The admin UI wires the one-click segmented control");
  // =========================================================================
  {
    const view = read("src/components/admin/session-videos-view.tsx");
    ok(/AcademicLevelSegmentedFilter/.test(view), "N8: the session-videos view uses the shared segmented control");
    ok(!/AcademicLevelFilterSelect/.test(view), "N8: …and NOT a second generic dropdown (the requested UX)");
    const filterIdx = view.indexOf("<AcademicLevelSegmentedFilter");
    const selectIdx = view.indexOf("<Select", filterIdx);
    ok(filterIdx > -1, "N8: the control is rendered");
    ok(selectIdx > filterIdx, "N8: …ABOVE the lesson/session picker");
    ok(/data-academic-level-filter|ACADEMIC_LEVEL_OPTIONS/.test(read("src/components/admin/academic-level-ui.tsx")),
      "N8: the control is the shared level vocabulary (no bespoke one)");
    ok(/levelFilter/.test(view) && /\[batch\.id, levelFilter\]/.test(view),
      "N8: a selection is cleared when the level changes (no cross-level stale selection)");
    ok(/buildLessonGroups\([\s\S]{0,200}levelFilter/.test(view),
      "N8: the filter is passed INTO the canonical picker");
  }

  // -------------------------------------------------------------------------
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(`\nsession-videos academic level filter (phase L): ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nHARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
