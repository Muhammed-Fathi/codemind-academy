// CodeMind Academy — Admin Course-card / API count contract (Phase L manual-QA fix).
//
// WHAT IT PROVES
//   The Admin → Courses cards read `partsCount` / `lessonsCount` /
//   `activeLessonsCount` from `GET /api/admin/courses`. Those counters MUST be
//   relations-derived and truthful in EVERY mode:
//
//     C1  FIRST_SECONDARY fixture (1 Part / 13 Units / 62 Lessons)
//         → the API reports Parts = 1, Lessons = 62.
//     C2  SECOND_SECONDARY fixture (2 Parts / 7 Units / 23 Lessons)
//         → the API reports Parts = 2, Lessons = 23.
//     C3  Per-course isolation: a course can never receive another course's
//         numbers (two courses at the SAME level stay independent), and an
//         empty course reports 0 / 0 / 0 without special-casing.
//     C4  Counts come from RELATIONS, not from hard-coded level totals: adding
//         a Part/Unit/Lesson to one course changes only that course's numbers.
//     C5  The historical semantics are preserved exactly:
//           * legacy Topic-chain lessons are counted too;
//           * a lesson linked through BOTH chains is counted ONCE;
//           * `lessonsCount` is the full catalogue, `activeLessonsCount`
//             excludes ARCHIVED history.
//     C6  Structural edge cases: a Part with no Units and a Unit with no
//         Lessons contribute nothing.
//     C7  The `tree=1` mode returns the SAME counts plus the full tree; the
//         plain list mode omits `parts` entirely (payload contract unchanged).
//     C8  Payload discipline: the list mode's count-only projection requests
//         lesson ids + curriculumStatus ONLY (no titles/media), so counting
//         never ships the curriculum tree.
//     C9  The counters read THIS course's chain — an `academicLevel`-wide
//         aggregate or an `officialCode`-prefix count would fail these cases.
//     C10 The single-course branch (`?id=`) still returns the full tree.
//
// The REAL route module is compiled with the repo's own tsc and executed against
// an in-memory Prisma mock, so the assertions exercise the shipped handler, not
// a copy of its logic.
//
// Portable: no shell of any kind (no grep/find, no `2>/dev/null`, no npx) —
// runs unchanged on Windows PowerShell and Linux CI.
//
// Run: node tests/admin-course-counts-phaseL.test.js
// Exit code: 0 = all pass, 1 = failure.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-coursecounts-"));

// ---------------------------------------------------------------------------
// 1. Compile the real route (and its graph) with the repo's tsc
// ---------------------------------------------------------------------------
const ROUTE_REL = "src/app/api/admin/courses/route.ts";
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
    files: [path.join(REPO, ROUTE_REL)],
  })
);
const TSC_BIN = path.join(REPO, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(TSC_BIN)) {
  console.error("typescript is not installed — run npm install");
  process.exit(1);
}
spawnSync(process.execPath, [TSC_BIN, "-p", path.join(OUT, "tsconfig.json")], {
  cwd: REPO,
  encoding: "utf8",
});
const EMIT = path.join(OUT, "src");
const ROUTE_JS = path.join(EMIT, "app", "api", "admin", "courses", "route.js");
if (!fs.existsSync(ROUTE_JS)) {
  console.error("tsc did not emit the admin courses route");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Module resolution: db → mock, libs → compiled siblings, models → real files
// ---------------------------------------------------------------------------
const MOCK_DB_PATH = path.join(OUT, "__mock-db__.js");
fs.writeFileSync(MOCK_DB_PATH, "module.exports = { get db() { return global.__MOCK_DB__; } };");
const API_STUB = path.join(OUT, "__api-stub__.js");
fs.writeFileSync(
  API_STUB,
  "module.exports = {\n" +
    "  ok: (data, status) => ({ status: status || 200, body: data }),\n" +
    "  err: (message, status) => ({ status: status || 400, body: { error: message } }),\n" +
    "  requireRole: async () => ({ error: null }),\n" +
    "};"
);
const I18N_STUB = path.join(OUT, "__i18n-stub__.js");
fs.writeFileSync(
  I18N_STUB,
  "module.exports = { getServerT: async () => (k) => k };"
);
const NEXT_STUB = path.join(OUT, "__next-server-stub__.js");
fs.writeFileSync(NEXT_STUB, "module.exports = { NextRequest: class {} };");

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return MOCK_DB_PATH;
  if (request === "@/lib/api") return API_STUB;
  if (request === "@/lib/i18n-server") return I18N_STUB;
  if (request === "next/server") return NEXT_STUB;
  const alias = /^@\/lib\/([\w/-]+)$/.exec(request);
  if (alias) {
    const compiled = path.join(EMIT, "lib", `${alias[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  if (request.endsWith("knowledge-model.json")) {
    return request.includes("first-secondary")
      ? path.join(REPO, "docs/curriculum/first-secondary/knowledge-model.json")
      : path.join(REPO, "docs/curriculum/second-secondary/knowledge-model.json");
  }
  return origResolve.call(this, request, ...rest);
};

// ---------------------------------------------------------------------------
// 3. In-memory Prisma mock that HONOURS the requested select/include shape
// ---------------------------------------------------------------------------
const requestedSpecs = [];

function makeMockDb({ courses }) {
  const tables = {
    course: [],
    part: [],
    unit: [],
    topic: [],
    lesson: [],
    group: [],
  };
  let seq = 1;
  const nid = (p) => `${p}-${seq++}`;

  const sortRows = (rows, orderBy) => {
    if (!orderBy) return [...rows];
    const keys = Array.isArray(orderBy) ? orderBy : [orderBy];
    return [...rows].sort((a, b) => {
      for (const k of keys) {
        for (const [field, dir] of Object.entries(k)) {
          const av = a[field];
          const bv = b[field];
          if (av === bv) continue;
          const cmp = av > bv ? 1 : -1;
          return dir === "desc" ? -cmp : cmp;
        }
      }
      return 0;
    });
  };

  // Children of a row for the four curriculum relations.
  const childrenOf = (kind, row, relation) => {
    if (relation === "parts") return tables.part.filter((p) => p.courseId === row.id);
    if (relation === "units") return tables.unit.filter((u) => u.partId === row.id);
    if (relation === "topics") return tables.topic.filter((t) => t.unitId === row.id);
    if (relation === "lessons") {
      if (kind === "unit") return tables.lesson.filter((l) => l.unitId === row.id);
      if (kind === "topic") return tables.lesson.filter((l) => l.topicId === row.id);
      return [];
    }
    return [];
  };

  const relationName = (relation) => {
    if (relation === "parts") return "part";
    if (relation === "units") return "unit";
    if (relation === "topics") return "topic";
    if (relation === "lessons") return "lesson";
    return relation;
  };
  const isRelationSpec = (value) =>
    !!value && typeof value === "object" && !Array.isArray(value) &&
    ("include" in value || "select" in value || "orderBy" in value);

  /** Resolve a relation of `row` against the nested spec the route asked for. */
  const resolveRelation = (kind, row, relation, spec) => {
    const children = sortRows(childrenOf(kind, row, relation), spec.orderBy);
    return children.map((child) => resolveRow(relationName(relation), child, spec));
  };

  /**
   * Resolve one row against the spec the route actually asked for.
   * `{ select: { a: true, rel: {…} } }` → ONLY those keys (payload discipline).
   * `{ include: { rel: {…} }, orderBy }` → every column + the relations.
   */
  const resolveRow = (kind, row, spec) => {
    requestedSpecs.push({ kind, spec });
    const isSelect = !!spec.select;
    const shape = isSelect ? spec.select : spec.include || {};
    const out = {};
    for (const [key, value] of Object.entries(shape)) {
      if (value === true) {
        out[key] = row[key];
        continue;
      }
      if (isRelationSpec(value)) out[key] = resolveRelation(kind, row, key, value);
    }
    if (!isSelect) return { ...row, ...out };
    return out;
  };

  // Fixture loading: `courses` describes the whole curriculum per course id.
  for (const c of courses) {
    tables.course.push({
      id: c.id,
      slug: c.slug,
      name: c.name,
      nameAr: c.nameAr,
      description: c.description || "",
      color: c.color || "#10b981",
      academicLevel: c.academicLevel ?? null,
      createdAt: `t-${c.id}`,
    });
    c.parts.forEach((p, pi) => {
      const part = { id: `${c.id}-part-${pi + 1}`, courseId: c.id, title: p.title || `P${pi + 1}`, order: pi + 1 };
      tables.part.push(part);
      (p.units || []).forEach((u, ui) => {
        const unit = { id: `${part.id}-unit-${ui + 1}`, partId: part.id, title: u.title || `U${ui + 1}`, order: ui + 1 };
        tables.unit.push(unit);
        (u.lessons || []).forEach((l, li) => {
          tables.lesson.push({
            id: `${unit.id}-lesson-${li + 1}`,
            unitId: unit.id,
            topicId: null,
            title: `Lesson ${li + 1}`,
            titleAr: `درس ${li + 1}`,
            order: li + 1,
            curriculumStatus: l.curriculumStatus || "OFFICIAL",
            officialCode: l.officialCode ?? null,
          });
        });
        (u.topics || []).forEach((t, ti) => {
          const topic = { id: `${unit.id}-topic-${ti + 1}`, unitId: unit.id, title: t.title || `T${ti + 1}`, order: ti + 1 };
          tables.topic.push(topic);
          (t.lessons || []).forEach((l, li) => {
            tables.lesson.push({
              id: `${topic.id}-lesson-${li + 1}`,
              unitId: l.unitId ?? null, // dual-linked fixture support
              topicId: topic.id,
              title: `Legacy ${li + 1}`,
              titleAr: `قديم ${li + 1}`,
              order: li + 1,
              curriculumStatus: l.curriculumStatus || "DRAFT",
              officialCode: null,
            });
          });
        });
        // A handful of groups so `_count.groups` is exercised per course.
        for (let g = 0; g < (c.groups || 0); g++) {
          tables.group.push({ id: nid("group"), courseId: c.id });
        }
      });
    });
  }

  const findManyCourses = async ({ include, orderBy }) =>
    sortRows(tables.course, orderBy).map((c) => ({
      ...c,
      ...(include && include.parts ? { parts: resolveRelation("course", c, "parts", include.parts) } : {}),
      _count: { groups: tables.group.filter((g) => g.courseId === c.id).length },
    }));

  return {
    __tables: tables,
    course: {
      findMany: findManyCourses,
      async findUnique({ where, include }) {
        const c = tables.course.find((x) => x.id === where.id);
        if (!c) return null;
        return {
          ...c,
          ...(include && include.parts ? { parts: resolveRelation("course", c, "parts", include.parts) } : {}),
          _count: { groups: tables.group.filter((g) => g.courseId === c.id).length },
        };
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Fixtures
// ---------------------------------------------------------------------------
const countLessons = (parts) =>
  parts.reduce((n, p) => n + (p.units || []).reduce((m, u) => m + (u.lessons || []).length, 0), 0);

/** FIRST_SECONDARY: 1 Part / 13 Units / 62 Lessons (per-chapter {2,3,5,1,3,10,3,5,3,6,4,5,12}). */
function firstSecondaryCourse(id = "course-fs") {
  const perChapter = [2, 3, 5, 1, 3, 10, 3, 5, 3, 6, 4, 5, 12];
  return {
    id,
    slug: "programming-ai-1st-sec",
    name: "Programming & AI",
    nameAr: "البرمجة والذكاء الاصطناعي",
    academicLevel: "FIRST_SECONDARY",
    parts: [
      {
        title: "First Secondary Curriculum",
        units: perChapter.map((n, i) => ({
          title: `Unit ${i + 1}`,
          lessons: Array.from({ length: n }, (_, li) => ({ officialCode: `${i + 1}-${li + 1}` })),
        })),
      },
    ],
  };
}

/** SECOND_SECONDARY: 2 Parts / 7 Units / 23 Lessons (P1 = units 1–4 / 14, P2 = units 5–7 / 9). */
function secondSecondaryCourse(id = "course-ss") {
  const perChapter = [4, 3, 3, 4, 3, 3, 3];
  const units = perChapter.map((n, i) => ({
    title: `Unit ${i + 1}`,
    lessons: Array.from({ length: n }, (_, li) => ({ officialCode: `${i + 1}-${li + 1}` })),
  }));
  return {
    id,
    slug: "programming-ai-2nd-sec",
    name: "Programming & AI",
    nameAr: "البرمجة والذكاء الاصطناعي",
    academicLevel: "SECOND_SECONDARY",
    parts: [{ title: "Part 1", units: units.slice(0, 4) }, { title: "Part 2", units: units.slice(4) }],
  };
}

// ---------------------------------------------------------------------------
// 5. Harness
// ---------------------------------------------------------------------------
let pass = 0;
let fail = 0;
const ok = (cond, msg) => {
  if (cond) pass++;
  else {
    fail++;
    console.error(`FAIL: ${msg}`);
  }
};
const eq = (got, want, msg) =>
  ok(
    JSON.stringify(got) === JSON.stringify(want),
    `${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`
  );

const routes = require(ROUTE_JS);

/** Drive the REAL GET handler. `params` are query-string entries. */
async function get(params = "") {
  const res = await routes.GET({ url: `http://localhost/api/admin/courses${params}` });
  return res;
}
const byId = (body, id) => (body.courses || []).find((c) => c.id === id);

(async () => {
  // -------------------------------------------------------------------------
  // C1 + C2 — the reported bug: FS 1/62 and SS 2/23 must be reported as such.
  // -------------------------------------------------------------------------
  {
    requestedSpecs.length = 0;
    const fs = firstSecondaryCourse();
    const ss = secondSecondaryCourse();
    ok(countLessons(fs.parts) === 62, `fixture sanity: FS holds 62 lessons (got ${countLessons(fs.parts)})`);
    ok(countLessons(ss.parts) === 23, `fixture sanity: SS holds 23 lessons (got ${countLessons(ss.parts)})`);

    global.__MOCK_DB__ = makeMockDb({ courses: [ss, fs] });
    const res = await get();
    eq(res.status, 200, "C1: GET /api/admin/courses answers 200");
    const fsRow = byId(res.body, "course-fs");
    const ssRow = byId(res.body, "course-ss");

    eq([fsRow.partsCount, fsRow.lessonsCount, fsRow.activeLessonsCount], [1, 62, 62], "C1: FIRST_SECONDARY card reports Parts=1, Lessons=62");
    eq(fsRow.academicLevel, "FIRST_SECONDARY", "C1: the FS card still carries its level");
    eq([ssRow.partsCount, ssRow.lessonsCount, ssRow.activeLessonsCount], [2, 23, 23], "C2: SECOND_SECONDARY card reports Parts=2, Lessons=23");
    eq(ssRow.academicLevel, "SECOND_SECONDARY", "C2: the SS card still carries its level");

    // The card renders `activeLessonsCount ?? lessonsCount`; both must agree.
    ok(
      fsRow.activeLessonsCount === fsRow.lessonsCount && ssRow.activeLessonsCount === ssRow.lessonsCount,
      "C1/C2: no phantom '(N total)' suffix on a fully-active catalogue"
    );
  }

  // -------------------------------------------------------------------------
  // C3 — per-course isolation, including two courses of the SAME level.
  // -------------------------------------------------------------------------
  {
    const fs = firstSecondaryCourse("course-fs");
    const ss = secondSecondaryCourse("course-ss");
    const twin = secondSecondaryCourse("course-ss-twin"); // same level, different size
    twin.parts = [{ title: "P1", units: [{ title: "U1", lessons: [{}, {}, {}, {}, {}] }] }];
    const empty = {
      id: "course-empty",
      slug: "empty-course",
      name: "Empty",
      nameAr: "فارغ",
      academicLevel: "FIRST_SECONDARY",
      parts: [],
    };
    global.__MOCK_DB__ = makeMockDb({ courses: [fs, ss, twin, empty] });
    const res = await get();

    eq(byId(res.body, "course-fs").lessonsCount, 62, "C3: FS keeps 62 while other courses exist");
    eq(byId(res.body, "course-ss").lessonsCount, 23, "C3: SS keeps 23 (no cross-course inflation)");
    eq(
      [byId(res.body, "course-ss-twin").partsCount, byId(res.body, "course-ss-twin").lessonsCount],
      [1, 5],
      "C3: a second course at the SAME level reports its OWN 1/5 (never the level's total)"
    );
    eq(
      [
        byId(res.body, "course-empty").partsCount,
        byId(res.body, "course-empty").lessonsCount,
        byId(res.body, "course-empty").activeLessonsCount,
      ],
      [0, 0, 0],
      "C3: a course with zero Parts reports 0/0/0 without special-casing"
    );
    eq(res.body.courses.length, 4, "C3: every course is returned");
  }

  // -------------------------------------------------------------------------
  // C4 — relation-derived, never hard-coded.
  // -------------------------------------------------------------------------
  {
    const fs = firstSecondaryCourse("course-fs");
    const ss = secondSecondaryCourse("course-ss");
    fs.parts.push({
      title: "Extra Part",
      units: [{ title: "U", lessons: [{}, {}, {}] }],
    });
    global.__MOCK_DB__ = makeMockDb({ courses: [fs, ss] });
    const res = await get();
    eq(
      [byId(res.body, "course-fs").partsCount, byId(res.body, "course-fs").lessonsCount],
      [2, 65],
      "C4: adding a Part + 3 Lessons moves FS to 2/65 (counts follow the rows)"
    );
    eq(
      [byId(res.body, "course-ss").partsCount, byId(res.body, "course-ss").lessonsCount],
      [2, 23],
      "C4: …and leaves SS at its own 2/23"
    );
  }

  // -------------------------------------------------------------------------
  // C5 — legacy Topic chain + dedupe + archived semantics (unchanged contract).
  // -------------------------------------------------------------------------
  {
    const fs = firstSecondaryCourse("course-fs");
    // A legacy Topic under unit 1 carrying 2 lessons: one ARCHIVED history row
    // and one live (DRAFT) row. The live one is ALSO attached to the unit, so
    // the same row is reachable through BOTH chains.
    fs.parts[0].units[0].topics = [
      {
        title: "Legacy topic",
        lessons: [
          { curriculumStatus: "ARCHIVED" },
          { curriculumStatus: "DRAFT" },
        ],
      },
    ];
    const db = makeMockDb({ courses: [fs] });
    global.__MOCK_DB__ = db;
    const fsUnit1 = db.__tables.unit[0];
    const dualLinked = db.__tables.lesson.find((l) => l.topicId && l.curriculumStatus === "DRAFT");
    dualLinked.unitId = fsUnit1.id; // the dual link

    // Test-side bookkeeping (the API values are what we assert below):
    //   rows         = every distinct Lesson row reachable from the course
    //   occurrences  = how many times those rows appear across BOTH chains
    const rows = db.__tables.lesson.filter(
      (l) => l.unitId || l.topicId
    );
    const occurrences =
      db.__tables.unit.reduce(
        (n, u) => n + db.__tables.lesson.filter((l) => l.unitId === u.id).length,
        0
      ) +
      db.__tables.topic.reduce(
        (n, t) => n + db.__tables.lesson.filter((l) => l.topicId === t.id).length,
        0
      );
    ok(!!dualLinked, "C5: the fixture has a legacy lesson attached through BOTH chains");
    eq(rows.length, 64, "C5: fixture sanity — 62 canonical + 2 legacy Lesson ROWS");
    eq(occurrences, 65, "C5: …but 65 chain OCCURRENCES (one row is linked twice)");

    const res = await get();
    const fsRow = byId(res.body, "course-fs");
    eq(
      fsRow.lessonsCount,
      64,
      "C5: legacy Topic lessons count, and the dual-linked row counts ONCE (64, not 65 occurrences)"
    );
    ok(
      fsRow.lessonsCount === rows.length && fsRow.lessonsCount < occurrences,
      "C5: distinct-row semantics proven — the count equals the row count and is below the occurrence count"
    );
    // 3 of the 64 are active legacy? No: the ARCHIVED legacy row is the only
    // inactive one → 64 - 1 = 63 active.
    eq(fsRow.activeLessonsCount, 63, "C5: ARCHIVED history is excluded from activeLessonsCount");
    ok(
      fsRow.activeLessonsCount < fsRow.lessonsCount,
      "C5: the card's '(N total)' suffix is therefore meaningful, not a lie"
    );
  }

  // -------------------------------------------------------------------------
  // C6 — structural edge cases: empty Part / empty Unit.
  // -------------------------------------------------------------------------
  {
    const fs = firstSecondaryCourse("course-fs");
    fs.parts.push({ title: "Empty Part", units: [] });
    fs.parts[0].units.push({ title: "Empty Unit", lessons: [] });
    global.__MOCK_DB__ = makeMockDb({ courses: [fs] });
    const res = await get();
    const row = byId(res.body, "course-fs");
    eq(row.partsCount, 2, "C6: a Part with no Units still counts as a Part");
    eq(row.lessonsCount, 62, "C6: an empty Unit contributes zero lessons");
  }

  // -------------------------------------------------------------------------
  // C7 — tree=1 parity, and the list payload still omits the tree.
  // -------------------------------------------------------------------------
  {
    const fs = firstSecondaryCourse("course-fs");
    const ss = secondSecondaryCourse("course-ss");
    global.__MOCK_DB__ = makeMockDb({ courses: [fs, ss] });

    const list = await get();
    eq(byId(list.body, "course-fs").parts, undefined, "C7: the plain list omits `parts` (payload contract unchanged)");
    const tree = await get("?tree=1");
    const treeFs = byId(tree.body, "course-fs");
    eq(
      [treeFs.partsCount, treeFs.lessonsCount, treeFs.activeLessonsCount],
      [1, 62, 62],
      "C7: tree=1 reports the SAME counts as the list"
    );
    ok(Array.isArray(treeFs.parts) && treeFs.parts.length === 1, "C7: tree=1 still returns the full tree");
    eq(treeFs.parts[0].units.length, 13, "C7: the tree keeps its 13 units");
    eq(treeFs.parts[0].units.reduce((n, u) => n + u.lessons.length, 0), 62, "C7: …and its 62 lessons");
    ok(!!treeFs.parts[0].units[0].lessons[0].title, "C7: tree lessons carry their full columns");
  }

  // -------------------------------------------------------------------------
  // C8 — payload discipline: counting must not ship the curriculum tree.
  // -------------------------------------------------------------------------
  {
    const fs = firstSecondaryCourse("course-fs");
    global.__MOCK_DB__ = makeMockDb({ courses: [fs] });
    requestedSpecs.length = 0;
    await get();
    const lessonSpecs = requestedSpecs.filter((r) => r.kind === "lesson");
    ok(lessonSpecs.length > 0, "C8: the list mode hydrated lessons (that is what makes the counts true)");
    const listModeSelect = lessonSpecs[0].spec.select || lessonSpecs[0].spec.include || {};
    ok(
      Object.keys(listModeSelect).sort().join(",") === "curriculumStatus,id",
      `C8: list mode requests ONLY id + curriculumStatus (got ${Object.keys(listModeSelect).join(",")})`
    );
    for (const heavy of ["title", "titleAr", "description", "videoUrl", "pdfUrl", "summary"]) {
      ok(!(heavy in listModeSelect), `C8: list mode does NOT request \`${heavy}\``);
    }

    requestedSpecs.length = 0;
    await get("?tree=1");
    const treeLessonSpecs = requestedSpecs.filter((r) => r.kind === "lesson");
    ok(treeLessonSpecs.length > 0, "C8: tree mode hydrates lessons too");
    ok(
      !("select" in treeLessonSpecs[0].spec),
      "C8: tree mode hydrates FULL rows (no projection) — the admin tree is unchanged"
    );
    ok(
      treeLessonSpecs[0].spec.orderBy !== undefined,
      "C8: tree mode keeps its deterministic ordering"
    );
  }

  // -------------------------------------------------------------------------
  // C9 — the counters are chain-derived, NOT level- or code-aggregated.
  // -------------------------------------------------------------------------
  {
    // Two curricula whose officialCodes overlap entirely for "1-x": if the
    // implementation counted by code prefix or by academicLevel it would
    // double or merge. Titled fixtures differ per course so a level-wide
    // aggregate cannot pass.
    const fs = firstSecondaryCourse("course-fs");
    const ss = secondSecondaryCourse("course-ss");
    global.__MOCK_DB__ = makeMockDb({ courses: [fs, ss] });
    const res = await get();
    const fsRow = byId(res.body, "course-fs");
    const ssRow = byId(res.body, "course-ss");

    const sharedCodes = new Set(
      fs.parts
        .flatMap((p) => p.units.flatMap((u) => u.lessons.map((l) => l.officialCode)))
        .filter((c) => ss.parts.some((p) => p.units.some((u) => u.lessons.some((l) => l.officialCode === c))))
    );
    ok(sharedCodes.size === 18, `C9: the fixtures genuinely share 18 codes (got ${sharedCodes.size})`);
    eq(fsRow.lessonsCount, 62, "C9: FS counts 62 of its own rows, not 62 + 23 shared-code rows");
    eq(ssRow.lessonsCount, 23, "C9: SS counts 23 of its own rows");
    ok(
      fsRow.lessonsCount + ssRow.lessonsCount === 85,
      "C9: the two cards sum to the platform total only because each is chain-scoped"
    );
  }

  // -------------------------------------------------------------------------
  // C10 — the single-course branch (`?id=`) still returns the full tree.
  // -------------------------------------------------------------------------
  {
    const fs = firstSecondaryCourse("course-fs");
    global.__MOCK_DB__ = makeMockDb({ courses: [fs] });
    const res = await get("?id=course-fs");
    eq(res.status, 200, "C10: ?id= answers 200");
    ok(!!res.body.course, "C10: ?id= returns the single course (openTree contract)");
    eq(res.body.course.parts.length, 1, "C10: …with its full parts");
    eq(
      res.body.course.parts[0].units.reduce((n, u) => n + u.lessons.length, 0),
      62,
      "C10: …and all 62 lessons for the tree view"
    );
    const missing = await get("?id=nope");
    eq(missing.status, 404, "C10: an unknown id is still a 404");
  }

  console.log(`\nadmin course counts (phase L): ${pass} passed, ${fail} failed`);
  Module._resolveFilename = origResolve;
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
