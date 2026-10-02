// CodeMind Academy — Phase M1 — SHARED UX PRIMITIVES & ACADEMIC-LEVEL VOCABULARY.
//
// WHAT THIS PROVES (the M1 acceptance list, one section per property)
//   A. Compatibility — every pre-M1 export of `academic-level-ui` still exists
//      with its DOM contract byte-identical (`data-academic-level-filter`,
//      `data-academic-level-scope`, `aria-pressed`, the `w-44` select, the
//      pinned literal `ACADEMIC_LEVEL_OPTIONS`, the admin.643/644/645/648 keys).
//   B. Call sites — no admin/teacher surface changed its import or its usage;
//      the surfaces that must NOT have a level control still do not.
//   C. Query parsing — the ONE shared parser (`@/lib/academic-level-query`) is
//      EXECUTED here: absent/""/all ⇒ no narrowing, both canonical levels are
//      accepted (any case/spacing), anything else is refused. The teacher
//      helpers are executed too and must agree with it on every input a route
//      can produce.
//   D. Labels — the pure label vocabulary is EXECUTED and must reproduce the
//      five pinned call-site templates byte-for-byte, keep the unknown-level
//      fallback, and keep same-named courses / same-code lessons distinguishable.
//   E. New primitives — `async-state`, `filter-bar`, `data-table`, `status-badge`
//      exist, are structural (no data access), RTL-safe (no physical-direction
//      utilities) and NOT adopted yet (nothing outside `shared/` imports them).
//
// HOW THE TYPESCRIPT IS RUN
//   The three pure modules are transpiled with the repo's own `typescript` and
//   loaded with a tiny resolver that maps `@/lib/*` to the real sources and
//   stubs ONLY the database boundary (`@/lib/db`, `@prisma/client`) which the
//   pure modules never touch. Nothing is re-implemented: the assertions run the
//   shipped functions, and the pinned templates are recomputed from the same
//   dictionary the app uses.
//
// Run: node tests/phase-m-primitives.test.js
// Exit code: 0 = all pass, 1 = failure.

const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

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
    `got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`
  );
}
function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// Tiny TypeScript loader (transpile + alias resolution + DB-boundary stub)
// ---------------------------------------------------------------------------
const STUBS = {
  "@/lib/db": { db: {} },
  "@prisma/client": {},
};
const moduleCache = new Map();

function loadTs(absFile) {
  const file = absFile.endsWith(".ts") ? absFile : `${absFile}.ts`;
  if (moduleCache.has(file)) return moduleCache.get(file).exports;
  const source = read(path.relative(REPO, file));
  const js = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: file,
  }).outputText;
  const mod = { exports: {} };
  moduleCache.set(file, mod);
  const nodeRequire = Module.createRequire(file);
  const req = (spec) => {
    if (Object.prototype.hasOwnProperty.call(STUBS, spec)) return STUBS[spec];
    if (spec.startsWith("@/")) {
      return loadTs(path.join(REPO, "src", spec.slice(2)));
    }
    return nodeRequire(spec);
  };
  new Function("exports", "require", "module", "__filename", "__dirname", js)(
    mod.exports,
    req,
    mod,
    file,
    path.dirname(file)
  );
  return mod.exports;
}

/** The real dictionaries, merged the way `src/lib/i18n-core.ts` merges them. */
const DICT = { ...loadTs(path.join(REPO, "src/lib/i18n-dict.ts")).DICT, ...loadTs(path.join(REPO, "src/lib/i18n-dict-2026.ts")).DICT_2026 };
const en = (key, params) => {
  const entry = DICT[key];
  if (!entry) return key;
  let out = entry.en;
  for (const [k, v] of Object.entries(params || {})) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
};

const labels = loadTs(path.join(REPO, "src/lib/academic-level-labels.ts"));
const query = loadTs(path.join(REPO, "src/lib/academic-level-query.ts"));
const teacherScope = loadTs(path.join(REPO, "src/lib/teacher-academic-level.ts"));

/** Strip `//` and block comments so an RTL scan cannot trip on prose. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

// =========================================================================
section("A. Compatibility — the pre-M1 surface is intact");
// =========================================================================
{
  const ui = read("src/components/admin/academic-level-ui.tsx");

  for (const name of [
    "ACADEMIC_LEVEL_OPTIONS",
    "academicLevelLabel",
    "AcademicLevelBadge",
    "AcademicLevelFilterSelect",
    "AcademicLevelSegmentedFilter",
    "OptionalAcademicLevelFilter",
    "courseWithLevelLabel",
  ]) {
    ok(
      new RegExp(`export (function|const) ${name}\\b`).test(ui),
      `A1: legacy export ${name} still exists`
    );
  }
  ok(
    /export function AcademicLevelFilter\(/.test(ui),
    "A1: the ONE shared AcademicLevelFilter exists"
  );

  // Pinned literals (Phase K manual-QA suite).
  ok(
    /export const ACADEMIC_LEVEL_OPTIONS = \["FIRST_SECONDARY", "SECOND_SECONDARY"\] as const/.test(
      ui
    ),
    "A1: ACADEMIC_LEVEL_OPTIONS is still the literal pair of enum values"
  );
  ok(
    /admin\.643/.test(ui) && /admin\.644/.test(ui) && /admin\.645/.test(ui) && /admin\.648/.test(ui),
    "A1: the admin vocabulary keys (643/644/645/648) are still referenced in the file"
  );

  // Segmented DOM contract.
  ok(/role="group"/.test(ui), "A2: the segmented control is still a labelled group");
  ok(/aria-pressed=\{active\}/.test(ui), "A2: each chip still exposes aria-pressed");
  ok(
    /data-academic-level-filter=\{value \|\| "ALL"\}/.test(ui),
    "A2: the filter marker still carries the current value (ALL when unfiltered)"
  );
  ok(
    /rounded-lg border bg-muted\/30 p-0\.5/.test(ui) &&
      /bg-primary text-primary-foreground/.test(ui),
    "A2: the chip container/active-chip classes are unchanged"
  );
  ok(
    /\[[\s\S]{0,120}value: "", label: allLabel[\s\S]{0,120}ACADEMIC_LEVEL_OPTIONS\.map/.test(ui) ||
      /const chipOptions[\s\S]{0,200}value: "", label: allLabel/.test(ui),
    "A2: the chip order is still All → First → Second"
  );

  // Select DOM contract.
  ok(
    /value=\{value \|\| "all"\}/.test(ui) && /onValueChange=\{\(v\) => onChange\(v === "all" \? "" : v\)\}/.test(ui),
    "A3: the select still maps “all” ⇄ the empty filter value"
  );
  ok(/<SelectItem value="all">/.test(ui), "A3: the select still offers an explicit “all” option");
  ok(/className \|\| "w-44"/.test(ui), "A3: the select trigger keeps its historical width default");

  // Optional scope gate (pinned verbatim by the Phase L suite).
  ok(
    /const spans = typeof scope === "boolean" \? scope : !!scope\?\.spansBothLevels;\s*\n\s*if \(!spans\) return null;/.test(ui),
    "A4: the optional control still renders NOTHING unless the scope spans both levels"
  );
  ok(/data-academic-level-scope="BOTH"/.test(ui), "A4: …and still marks the rendered state");
  ok(
    /<AcademicLevelSegmentedFilter value=\{value\} onChange=\{onChange\} \/>/.test(ui),
    "A4: the optional wrapper still delegates to the segmented variant"
  );

  // The ONE control implements all three behaviours.
  ok(
    /variant = "segmented"/.test(ui) && /variant === "select"/.test(ui),
    "A5: AcademicLevelFilter defaults to segmented and implements select"
  );
  ok(
    /if \(scope !== undefined && !spansBothLevels\(scope\)\) return null;/.test(ui),
    "A5: the shared control hides itself when the scope cannot contain both levels"
  );
  ok(
    /allLabelKey = ADMIN_ALL_LEVELS_LABEL_KEY/.test(ui) && /ariaLabelKey = "admin\.642"/.test(ui),
    "A5: the shared control keeps the All-Levels default label and the level aria-label"
  );
}

// =========================================================================
section("B. Call sites — no surface changed its usage");
// =========================================================================
{
  const dash = read("src/components/admin/admin-dashboard.tsx");
  ok(
    /<AcademicLevelFilterSelect value=\{levelFilter\} onChange=\{setLevelFilter\} \/>/.test(dash),
    "B1: the course list still uses the dropdown with the same props"
  );
  ok(
    /<AcademicLevelFilterSelect value=\{academicLevel\} onChange=\{setAcademicLevel\} \/>/.test(dash),
    "B2: the students list still uses the dropdown with the same props"
  );

  const videos = read("src/components/admin/session-videos-view.tsx");
  ok(
    /<AcademicLevelSegmentedFilter/.test(videos) && !/AcademicLevelFilterSelect/.test(videos),
    "B3: session videos keep the SEGMENTED control and did NOT gain the dropdown"
  );

  const surfaces = [
    ["src/components/teacher/teacher-dashboard.tsx", 5],
    ["src/components/teacher/teacher-sessions.tsx", 1],
    ["src/components/teacher/readiness-view.tsx", 1],
    ["src/components/teacher/teacher-authoring.tsx", 1],
  ];
  for (const [file, min] of surfaces) {
    const src = read(file);
    const count = (src.match(/OptionalAcademicLevelFilter/g) || []).length;
    ok(count >= min, `B4: ${path.basename(file)} still wires the optional level control (≥${min})`);
    ok(
      /from "@\/components\/admin\/academic-level-ui"/.test(src) && /academicLevelLabel/.test(src),
      `B4: ${path.basename(file)} still imports the ONE shared level vocabulary`
    );
  }
  ok(
    !/OptionalAcademicLevelFilter/.test(read("src/components/teacher/live-sessions-workspace.tsx")),
    "B5: the live-sessions workspace still has NO level control (single group context)"
  );
  for (const serverSurface of [
    "src/app/api/teacher/templates/route.ts",
    "src/app/api/teacher/templates/[id]/route.ts",
  ]) {
    ok(
      !/OptionalAcademicLevelFilter|AcademicLevelFilter/.test(read(serverSurface)),
      `B5: ${path.basename(path.dirname(serverSurface))}/route.ts kept its level-free contract`
    );
  }
}

// =========================================================================
section("C. Query parsing — ONE contract, executed");
// =========================================================================
{
  const nullish = [
    [undefined, "undefined"],
    [null, "null"],
    ["", '""'],
    ["   ", "whitespace"],
    ["all", '"all"'],
    ["ALL", '"ALL" (any case)'],
    ["All", '"All"'],
  ];
  for (const [input, label] of nullish) {
    const parsed = query.parseAcademicLevelValue(input);
    ok(
      parsed.ok === true && parsed.level === null,
      `C1: ${label} ⇒ no narrowing`,
      JSON.stringify(parsed)
    );
  }

  for (const [input, expected] of [
    ["FIRST_SECONDARY", "FIRST_SECONDARY"],
    ["second_secondary", "SECOND_SECONDARY"],
    ["first-secondary", "FIRST_SECONDARY"],
    ["  Second Secondary  ", "SECOND_SECONDARY"],
  ]) {
    const parsed = query.parseAcademicLevelValue(input);
    ok(
      parsed.ok === true && parsed.level === expected,
      `C2: ${JSON.stringify(input)} ⇒ ${expected}`,
      JSON.stringify(parsed)
    );
  }

  for (const bad of ["GRADE_10", "first", "third_secondary", "0", "true"]) {
    const parsed = query.parseAcademicLevelValue(bad);
    ok(parsed.ok === false, `C3: ${JSON.stringify(bad)} is refused (caller → 400)`);
  }

  // Source shapes a route actually hands in.
  const url = new URL("https://x.test/api/admin/students?academicLevel=SECOND_SECONDARY");
  eq(query.parseAcademicLevelParam(url).level, "SECOND_SECONDARY", "C4: URL source is parsed");
  eq(
    query.parseAcademicLevelParam(url.searchParams).level,
    "SECOND_SECONDARY",
    "C4: URLSearchParams source is parsed"
  );
  eq(
    query.parseAcademicLevelParam({ url: url.toString() }).level,
    "SECOND_SECONDARY",
    "C4: { url } source is parsed"
  );
  // A bare string is the VALUE (the documented shape); a route hands its URL in
  // through `{ url }`, so the two can never be confused.
  eq(query.parseAcademicLevelParam("all").level, null, "C4: a bare string is read as the value");
  ok(
    query.parseAcademicLevelParam("https://x.test/api?academicLevel=all").ok === false,
    "C4: …so a URL-shaped string is refused rather than silently misread"
  );
  eq(query.parseAcademicLevelParam(null).level, null, "C4: null source ⇒ no narrowing");
  eq(
    query.parseAcademicLevelParam({ url: "not-a-url" }).level,
    null,
    "C4: a malformed url ⇒ no narrowing (never a crash, never a widening)"
  );

  // Repeated parameters must not contradict each other.
  const repeated = new URLSearchParams([
    ["academicLevel", "FIRST_SECONDARY"],
    ["academicLevel", "first_secondary"],
  ]);
  eq(
    query.parseAcademicLevelParams(repeated).level,
    "FIRST_SECONDARY",
    "C5: repeated identical levels are accepted"
  );
  const conflicting = new URLSearchParams([
    ["academicLevel", "FIRST_SECONDARY"],
    ["academicLevel", "SECOND_SECONDARY"],
  ]);
  ok(
    query.parseAcademicLevelParams(conflicting).ok === false,
    "C5: contradicting repeated levels are refused"
  );

  // The teacher helpers are adapters over the same rules: agreement everywhere
  // a route can reach (a query value is always string | null).
  const corpus = [
    undefined,
    null,
    "",
    "   ",
    "all",
    "ALL",
    "All",
    "aLL",
    "FIRST_SECONDARY",
    "first_secondary",
    "first-secondary",
    "First Secondary",
    "SECOND_SECONDARY",
    "  second secondary ",
    "GRADE_10",
    "first",
    "0",
    "شسيب",
  ];
  let disagreements = 0;
  for (const input of corpus) {
    const shared = query.parseAcademicLevelValue(input);
    const teacher = teacherScope.parseAcademicLevelQuery(input);
    if (JSON.stringify(shared) !== JSON.stringify(teacher)) {
      disagreements++;
      console.log(`     disagree on ${JSON.stringify(input)}: ${JSON.stringify(shared)} vs ${JSON.stringify(teacher)}`);
    }
  }
  eq(disagreements, 0, "C6: the teacher parser agrees with the shared parser on every reachable input");

  const urls = [
    "https://x.test/api/teacher/lessons",
    "https://x.test/api/teacher/lessons?academicLevel=all",
    "https://x.test/api/teacher/lessons?academicLevel=FIRST_SECONDARY",
    "https://x.test/api/teacher/lessons?academicLevel=first-secondary",
    "https://x.test/api/teacher/lessons?academicLevel=JUNK",
  ];
  let routeDisagreements = 0;
  for (const u of urls) {
    const shared = query.parseAcademicLevelParam({ url: u });
    const teacher = teacherScope.academicLevelParamOf({ url: u });
    if (JSON.stringify(shared) !== JSON.stringify(teacher)) {
      routeDisagreements++;
      console.log(`     disagree on ${u}`);
    }
  }
  eq(routeDisagreements, 0, "C7: academicLevelParamOf agrees with the shared URL parser");

  // The narrowing predicate itself is still the ONE shared course-relation one.
  const where = loadTs(path.join(REPO, "src/lib/academic-level.ts")).groupsOfLevelWhere("FIRST_SECONDARY");
  eq(
    JSON.stringify(where),
    JSON.stringify({ course: { academicLevel: "FIRST_SECONDARY" } }),
    "C8: the level predicate still narrows through the COURSE relation"
  );
  const scope = teacherScope.academicLevelScope([
    { course: { academicLevel: "SECOND_SECONDARY" } },
    { course: { academicLevel: "FIRST_SECONDARY" } },
    { course: { academicLevel: null } },
  ]);
  ok(
    scope.spansBothLevels === true &&
      JSON.stringify(scope.academicLevels) === JSON.stringify(["FIRST_SECONDARY", "SECOND_SECONDARY"]),
    "C8: the teacher scope still spans both levels, in canonical order"
  );
  eq(
    teacherScope.academicLevelScope([{ course: { academicLevel: "FIRST_SECONDARY" } }]).spansBothLevels,
    false,
    "C8: a single-level teacher still does NOT span both levels (no control)"
  );
}

// =========================================================================
section("D. Labels — pure, stable, and byte-identical to the pinned templates");
// =========================================================================
{
  const tr = (key, params) => en(key, params);

  eq(
    labels.academicLevelLabelFor(tr, "FIRST_SECONDARY"),
    "First Secondary",
    "D1: a known level resolves through its dictionary key"
  );
  eq(
    labels.academicLevelLabelFor(tr, "SECOND_SECONDARY"),
    "Second Secondary",
    "D1: the second level resolves through its key"
  );
  eq(
    labels.academicLevelLabelFor(tr, "JUNK"),
    "Unspecified",
    "D2: an unknown level keeps the unspecified fallback (never invented, never empty)"
  );
  eq(
    labels.academicLevelLabelFor(tr, null),
    "Unspecified",
    "D2: a legacy NULL level keeps the unspecified fallback"
  );
  eq(labels.academicLevelPrefixFor(tr, null), "", "D2: the prefix helper omits an unknown level");
  eq(
    labels.academicLevelPrefixFor(tr, "FIRST_SECONDARY"),
    "First Secondary · ",
    "D2: the prefix helper keeps the level separator"
  );

  // Stability: same inputs, same output (no locale/global state).
  const once = labels.lessonLabelFor(tr, { academicLevel: "FIRST_SECONDARY", officialCode: "1-1", title: "Variables" });
  const twice = labels.lessonLabelFor(tr, { academicLevel: "FIRST_SECONDARY", officialCode: "1-1", title: "Variables" });
  eq(once, twice, "D3: label helpers are deterministic");
  eq(
    labels.courseOptionLabelFor(tr, "البرمجة والذكاء الاصطناعي", "FIRST_SECONDARY"),
    labels.courseOptionLabelFor(tr, "البرمجة والذكاء الاصطناعي", "FIRST_SECONDARY"),
    "D3: course labels are deterministic"
  );

  // The two official courses share ONE display name — the level must separate them.
  const name = "البرمجة والذكاء الاصطناعي";
  const firstCourse = labels.courseOptionLabelFor(tr, name, "FIRST_SECONDARY");
  const secondCourse = labels.courseOptionLabelFor(tr, name, "SECOND_SECONDARY");
  ok(firstCourse !== secondCourse, "D4: same-named courses differ by level");
  eq(firstCourse, `${name} — First Secondary`, "D4: course label = name — level");
  eq(secondCourse, `${name} — Second Secondary`, "D4: …for the other level too");

  // Same printed officialCode at both levels — the lesson label must separate them.
  const firstLesson = labels.lessonLabelFor(tr, { academicLevel: "FIRST_SECONDARY", officialCode: "1-1", title: "Variables" });
  const secondLesson = labels.lessonLabelFor(tr, { academicLevel: "SECOND_SECONDARY", officialCode: "1-1", title: "Variables" });
  ok(firstLesson !== secondLesson, "D5: the same officialCode at two levels is distinguishable");
  eq(firstLesson, "First Secondary · 1-1 · Variables", "D5: lesson label = level · code · title");

  // The five pinned call-site templates, recomputed exactly.
  const lesson = { academicLevel: "SECOND_SECONDARY", officialCode: "7-3", title: "Photosynthesis" };
  // 1. teacher-authoring.lessonLabel
  const authoringBase = `${lesson.officialCode} · ${lesson.title}`;
  eq(
    labels.lessonLabelFor(tr, lesson),
    `${labels.academicLevelLabelFor(tr, lesson.academicLevel)} · ${authoringBase}`,
    "D6: teacher-authoring template reproduced"
  );
  eq(
    labels.lessonLabelFor(null, lesson),
    authoringBase,
    "D6: teacher-authoring keeps the bare base when no translator is available"
  );
  // 2. teacher-sessions.courseLabel
  eq(
    labels.levelFirstLabelFor(tr, name, "FIRST_SECONDARY"),
    `${labels.academicLevelLabelFor(tr, "FIRST_SECONDARY")} · ${name}`,
    "D6: teacher-sessions template reproduced"
  );
  eq(labels.levelFirstLabelFor(tr, name, null), name, "D6: …and drops the level for a legacy course");
  // 3. readiness-view template  (level? "L · " : "") + (code? "code — " : "") + title
  const readiness =
    (lesson.academicLevel ? `${labels.academicLevelLabelFor(tr, lesson.academicLevel)} · ` : "") +
    (lesson.officialCode ? `${lesson.officialCode} — ` : "") +
    lesson.title;
  eq(
    labels.lessonLabelFor(tr, lesson, { levelWhenUnknown: false, codeSeparator: " — " }),
    readiness,
    "D6: readiness-view template reproduced"
  );
  eq(
    labels.lessonLabelFor(tr, { ...lesson, academicLevel: null }, { levelWhenUnknown: false, codeSeparator: " — " }),
    `${lesson.officialCode} — ${lesson.title}`,
    "D6: readiness-view omits an unknown level"
  );
  // 4. session-videos-view lessonOptionLabel / videoLessonLabel
  const videoBase = `${tr("admin.594", { p1: lesson.officialCode })} — ${lesson.title}`;
  eq(
    labels.lessonLabelFor(tr, { ...lesson, officialCode: tr("admin.594", { p1: lesson.officialCode }) }, { codeSeparator: " — " }),
    `${labels.academicLevelLabelFor(tr, lesson.academicLevel)} · ${videoBase}`,
    "D6: session-videos lesson option template reproduced"
  );
  const unit = tr("admin.593", { p1: 2 });
  eq(
    labels.lessonLabelFor(
      tr,
      { ...lesson, officialCode: tr("admin.594", { p1: lesson.officialCode }), unitLabel: unit },
      { codeSeparator: " — " }
    ),
    `${labels.academicLevelLabelFor(tr, lesson.academicLevel)} · ${videoBase} · ${unit}`,
    "D6: session-videos video-lesson template (level · code — title · unit) reproduced"
  );
  // 5. live-sessions-workspace group option
  eq(
    labels.levelFirstLabelFor(tr, "Group A", "FIRST_SECONDARY"),
    `${labels.academicLevelLabelFor(tr, "FIRST_SECONDARY")} · Group A`,
    "D6: live-sessions group option template reproduced"
  );

  // Scope predicate: fail-closed on every non-positive shape.
  for (const [input, expected] of [
    [{ spansBothLevels: true }, true],
    [{ spansBothLevels: false }, false],
    [true, true],
    [false, false],
    [null, false],
    [undefined, false],
    [{}, false],
  ]) {
    eq(labels.spansBothLevels(input), expected, `D7: spansBothLevels(${JSON.stringify(input)})`);
  }
  // …and it agrees with the pinned inline expression in the UI component.
  const ui = read("src/components/admin/academic-level-ui.tsx");
  ok(
    /const spans = typeof scope === "boolean" \? scope : !!scope\?\.spansBothLevels;/.test(ui),
    "D7: the pinned inline expression and the shared predicate are the same rule"
  );
}

// =========================================================================
section("E. New shared primitives — present, structural, RTL-safe, opt-in");
// =========================================================================
{
  const files = {
    asyncState: "src/components/shared/async-state.tsx",
    filterBar: "src/components/shared/filter-bar.tsx",
    dataTable: "src/components/shared/data-table.tsx",
    statusBadge: "src/components/shared/status-badge.tsx",
  };
  for (const [name, rel] of Object.entries(files)) {
    ok(fs.existsSync(path.join(REPO, rel)), `E1: ${name} exists (${rel})`);
  }

  const asyncSrc = read(files.asyncState);
  ok(/export function LoadingBlock\(/.test(asyncSrc), "E2: LoadingBlock is exported");
  ok(/export function ErrorBlock\(/.test(asyncSrc), "E2: ErrorBlock is exported");
  ok(/export function EmptyBlock\(/.test(asyncSrc), "E2: EmptyBlock is exported");
  ok(/onRetry\?: \(\) => void/.test(asyncSrc), "E2: the retry affordance is optional");
  ok(/data-async-state="loading"/.test(asyncSrc) && /data-async-state="empty"/.test(asyncSrc), "E2: states are observable");

  const barSrc = read(files.filterBar);
  ok(/export function FilterBar\(/.test(barSrc), "E3: FilterBar is exported");
  ok(/export function FilterField\(/.test(barSrc), "E3: FilterField is exported");
  ok(/flex-wrap/.test(barSrc) && /min-w-0/.test(barSrc), "E3: the bar wraps and its cells can shrink");
  ok(/data-filter-bar=""/.test(barSrc) && /data-filter-field=""/.test(barSrc), "E3: filter markers exist");
  ok(
    /htmlFor=\{htmlFor\}/.test(barSrc) && /sr-only/.test(barSrc),
    "E3: labels are real <label> elements (visible or screen-reader only)"
  );

  const tableSrc = read(files.dataTable);
  ok(/export function DataTable</.test(tableSrc), "E4: DataTable is exported");
  ok(/overflow-x-auto/.test(tableSrc), "E4: the container is horizontally overflow-safe");
  ok(/sticky top-0/.test(tableSrc), "E4: sticky headers are supported");
  ok(/LoadingBlock|EmptyBlock|ErrorBlock/.test(tableSrc), "E4: loading/empty/error slots exist");
  ok(/data-data-table-footer=""/.test(tableSrc), "E4: a pagination footer slot exists");
  ok(/colSpan=\{columns\.length\}/.test(tableSrc), "E4: state rows span the full table width");
  ok(/text-start/.test(tableSrc), "E4: cells use logical alignment");

  const badgeSrc = read(files.statusBadge);
  ok(/export function StatusBadge\(/.test(badgeSrc), "E5: StatusBadge is exported");
  ok(/export const STATUS_TONE_CLASSES/.test(badgeSrc), "E5: the tone→class table is exported");
  ok(/data-status-tone=\{tone\}/.test(badgeSrc), "E5: the tone is observable");
  ok(/emerald-500\/15/.test(badgeSrc) && /amber-500\/15/.test(badgeSrc) && /red-500\/15/.test(badgeSrc), "E5: it reuses the EXISTING token classes");
  ok(/export function statusToneOf\(/.test(badgeSrc), "E5: a caller-owned status→tone lookup exists");

  // RTL: no physical-direction utilities anywhere in the new primitives.
  const PHYSICAL = /(^|[\s"'(])(?:ml|mr|pl|pr|left|right|text-left|text-right|border-l|border-r|rounded-l|rounded-r|space-x)-\S/;
  for (const [name, rel] of Object.entries(files)) {
    const clean = stripComments(read(rel));
    const m = PHYSICAL.exec(clean);
    ok(!m, `E6: ${name} uses no physical-direction utility`, m ? m[0].trim() : "");
  }

  // Structural purity: the primitives never reach the database or the API.
  for (const [name, rel] of Object.entries(files)) {
    const src = read(rel);
    ok(
      !/@\/lib\/db|@prisma\/client|fetch\(|@\/lib\/teacher-academic-level/.test(src),
      `E7: ${name} performs no data access`
    );
  }

  // Opt-in: M1 adopts nothing — no page/view imports the new primitives.
  const adopted = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(path.join(REPO, dir), { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "shared") continue; // the primitives themselves are allowed to know each other
        walk(rel);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        const src = read(rel);
        if (/@\/components\/shared\/(async-state|filter-bar|data-table|status-badge)/.test(src)) {
          adopted.push(rel);
        }
      }
    }
  };
  walk("src/components");
  walk("src/app");
  eq(adopted.length, 0, `E8: the new primitives are NOT adopted yet (${adopted.join(", ") || "none"})`);
}

// =========================================================================
console.log(
  `\nphase M1 shared primitives: ${passed} passed, ${failed} failed`
);
if (failed > 0) {
  console.log(`\nFailed checks:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
