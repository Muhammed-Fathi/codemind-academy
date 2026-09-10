// CodeMind Academy — Official curriculum reconciliation tests (Phase 11).
// Offline, no database required. Compiles
// src/lib/{official-curriculum,session-progress,progress}.ts with tsc,
// injects an in-memory mock Prisma client, and verifies:
//   1. Model contract: knowledge-model.json loads as 2 parts / 7 units /
//      23 lessons with the exact official code set (1-1..7-3) and globally
//      ordered units 1..7; corrupt models fail closed (throw).
//   2. Fresh DB: reconcile creates the course + full official tree
//      (OFFICIAL, published, unit-linked, topic-less) and archives nothing.
//   3. Idempotency: a second run performs ZERO writes and reports no changes.
//   4. Legacy R1 DB: positional adoption (P2 units 1,2,3 adopted in place and
//      renumbered 5,6,7 — no duplicate units), legacy lessons ARCHIVED with
//      ids/media/history markers intact, other courses and unknown
//      officialCodes untouched (unknown codes warned, never modified).
//   5. Extra parts/units are left untouched and produce warnings; their
//      code-less lessons still archive (reachable through the course chain).
//   6. Reader universe: the shared progression predicate
//      (EXCLUDE_ARCHIVED_LESSON + dual-chain OR) resolves to EXACTLY the 23
//      official lessons over the reconciled legacy DB.
//
// Run: node tests/curriculum-reconciliation-phase11.test.js
// Exit code: 0 = all pass, 1 = failure.

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-reconcile-test-"));

// ---- Compile the lib files (offline; type errors would fail here) ----
const TSCONFIG = path.join(OUT, "tsconfig.json");
fs.writeFileSync(
  TSCONFIG,
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
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/official-curriculum.ts"),
      path.join(REPO, "src/lib/session-progress.ts"),
      path.join(REPO, "src/lib/progress.ts"),
      // Phase 12: session-progress now imports these.
      path.join(REPO, "src/lib/track-scope.ts"),
      path.join(REPO, "src/lib/school-type.ts"),
      path.join(REPO, "src/lib/enrollment.ts"),
    ],
  })
);
// Same convention as tests/session-progression.test.js: type errors in the
// graph are tolerated here (`npm run typecheck` is the real gate — and it is
// baseline-identical); what matters is that the JS under test was emitted.
try {
  execSync(`npx tsc -p ${TSCONFIG}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* fall through: check the emitted files instead */
}
// NOTE: the JSON import drags tsc's inferred rootDir up to the repo root,
// so the emit lands under OUT/src/lib (not OUT/ like the other suites).
const EMIT = path.join(OUT, "src", "lib");
for (const f of ["official-curriculum.js", "session-progress.js", "progress.js"]) {
  if (!fs.existsSync(path.join(EMIT, f))) {
    throw new Error(`tsc did not emit ${f}`);
  }
}

// ---- Redirect @/lib/* imports + the knowledge-model JSON ----
const MOCK_DB_PATH = path.join(OUT, "__mock-db__.js");
fs.writeFileSync(MOCK_DB_PATH, "module.exports = { db: global.__MOCK_DB__ };");
const REAL_MODEL_PATH = path.join(REPO, "docs/curriculum/knowledge-model.json");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return MOCK_DB_PATH;
  // Phase 12: any aliased lib resolves to its own compiled output in EMIT, so
  // newly imported siblings (track-scope, school-type, enrollment) need no
  // per-file entry here.
  const alias = /^@\/lib\/([\w-]+)$/.exec(request);
  if (alias) {
    const compiled = path.join(EMIT, `${alias[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  if (request.endsWith("knowledge-model.json")) return REAL_MODEL_PATH;
  return origResolve.call(this, request, ...rest);
};

const reconciler = require(path.join(EMIT, "official-curriculum.js"));
const engine = require(path.join(EMIT, "session-progress.js"));
// Phase 13: the student universe is defined by the lifecycle module, not by the
// progression engine — so the universe query below has to read the constant from
// where it lives (this is the whole point of the phase: one source of truth).
const lifecycle = require(path.join(EMIT, "session-lifecycle.js"));
const UNIVERSE = { status: "PUBLISHED" };

// ---- In-memory mock Prisma client (evaluates the reconciler's `where`) ----
// ---------------------------------------------------------------------------
// Phase 12 REGRESSION GATE for the Phase 11 post-merge defect.
//
// `reconcileOfficialCurriculum` used to order Part/Unit by `createdAt` — a
// column those two models DO NOT HAVE. The real Prisma client rejects that
// with `PrismaClientValidationError: Unknown argument \`createdAt\``, but this
// suite's mock client ignored `orderBy` entirely and even fabricated
// `createdAt` values, so 51 green assertions never caught it: the reconciler
// only failed against a real database.
//
// The mock now validates `orderBy` against the field list parsed straight out
// of prisma/schema.prisma, so it behaves like the real client for this class
// of bug. Re-introducing an ordering key that is not a column of the model
// fails HERE, offline, before it can fail in production.
// ---------------------------------------------------------------------------
function parseModelFields(modelName) {
  const schema = fs.readFileSync(path.join(REPO, "prisma/schema.prisma"), "utf8");
  const start = schema.indexOf(`model ${modelName} {`);
  if (start < 0) throw new Error(`prisma/schema.prisma has no model ${modelName}`);
  const end = schema.indexOf("\n}", start);
  const body = schema.slice(start, end);
  const fields = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("//") || line.startsWith("///")) continue;
    if (line.startsWith("@@") || line.startsWith("model ")) continue;
    const m = /^(\w+)\s+\S+/.exec(line);
    if (m) fields.push(m[1]);
  }
  return fields;
}

const SCHEMA_FIELDS = {
  part: parseModelFields("Part"),
  unit: parseModelFields("Unit"),
};

/** Mirror PrismaClientValidationError for an orderBy key that is not a column. */
function assertOrderByIsSchemaValid(modelName, orderBy) {
  const entries = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  for (const entry of entries) {
    for (const key of Object.keys(entry || {})) {
      if (!SCHEMA_FIELDS[modelName].includes(key)) {
        throw new Error(
          `Unknown argument \`${key}\` on ${modelName}.orderBy — not a column in ` +
            `prisma/schema.prisma (available: ${SCHEMA_FIELDS[modelName].join(", ")})`
        );
      }
    }
  }
}

function makeMockDb() {
  const tables = { course: [], part: [], unit: [], topic: [], lesson: [] };
  let seq = 1;
  const nid = (p) => `${p}-${seq++}`;
  const writes = { create: 0, update: 0, updateMany: 0, upsert: 0 };
  const byId = (t, id) => tables[t].find((r) => r.id === id);

  function matchCond(value, cond) {
    if (cond === null || cond === undefined)
      return value === null || value === undefined;
    if (typeof cond !== "object" || Array.isArray(cond)) return value === cond;
    if ("in" in cond)
      return Array.isArray(cond.in) && cond.in.includes(value);
    if ("not" in cond) return !matchCond(value, cond.not);
    throw new Error(`mock: unsupported condition ${JSON.stringify(cond)}`);
  }

  function matchPartChain(partId, chain) {
    const p = byId("part", partId);
    if (!p) return false;
    return Object.entries(chain).every(([k, v]) => matchCond(p[k], v));
  }

  function matchLesson(l, where) {
    if (!where) return true;
    for (const [k, v] of Object.entries(where)) {
      if (k === "OR") {
        if (!v.some((c) => matchLesson(l, c))) return false;
        continue;
      }
      if (k === "NOT") {
        if (matchLesson(l, v)) return false;
        continue;
      }
      if (k === "unit") {
        const u = l.unitId ? byId("unit", l.unitId) : null;
        if (!u || !v.part || !matchPartChain(u.partId, v.part)) return false;
        continue;
      }
      if (k === "topic") {
        const t = l.topicId ? byId("topic", l.topicId) : null;
        const u = t ? byId("unit", t.unitId) : null;
        if (!u || !v.unit || !v.unit.part || !matchPartChain(u.partId, v.unit.part))
          return false;
        continue;
      }
      if (!matchCond(l[k], v)) return false;
    }
    return true;
  }

  const sortByOrder = (rows) =>
    [...rows].sort((a, b) => a.order - b.order || (a.createdAt < b.createdAt ? -1 : 1));

  const db = {
    __tables: tables,
    __writes: writes,
    __resetWrites() {
      writes.create = 0;
      writes.update = 0;
      writes.updateMany = 0;
      writes.upsert = 0;
    },
    course: {
      async findUnique({ where }) {
        return tables.course.find((c) => c.slug === where.slug) || null;
      },
      async upsert({ where, update, create }) {
        let row = tables.course.find((c) => c.slug === where.slug);
        if (row) {
          const changed = Object.entries(update).some(([k, v]) => row[k] !== v);
          Object.assign(row, update);
          if (changed) writes.upsert++;
        } else {
          row = { id: nid("course"), ...create };
          tables.course.push(row);
          writes.create++;
        }
        return { ...row };
      },
    },
    part: {
      async findMany({ where, orderBy }) {
        assertOrderByIsSchemaValid("part", orderBy);
        return sortByOrder(
          tables.part.filter((p) => !where || p.courseId === where.courseId)
        ).map((r) => ({ ...r }));
      },
      async create({ data }) {
        const row = { id: nid("part"), createdAt: `t${seq}`, ...data };
        delete row.createdAt;
        row.createdAt = `t${seq}`;
        tables.part.push(row);
        writes.create++;
        return { ...row };
      },
      async update({ where, data }) {
        const row = byId("part", where.id);
        Object.assign(row, data);
        writes.update++;
        return { ...row };
      },
    },
    unit: {
      async findMany({ where, orderBy }) {
        assertOrderByIsSchemaValid("unit", orderBy);
        return sortByOrder(
          tables.unit.filter((u) => !where || u.partId === where.partId)
        ).map((r) => ({ ...r }));
      },
      async create({ data }) {
        const row = { id: nid("unit"), ...data, createdAt: `t${seq}` };
        tables.unit.push(row);
        writes.create++;
        return { ...row };
      },
      async update({ where, data }) {
        const row = byId("unit", where.id);
        Object.assign(row, data);
        writes.update++;
        return { ...row };
      },
    },
    lesson: {
      async findUnique({ where }) {
        if (where.officialCode !== undefined)
          return (
            tables.lesson.find((l) => l.officialCode === where.officialCode) || null
          );
        if (where.id !== undefined)
          return tables.lesson.find((l) => l.id === where.id) || null;
        throw new Error("mock: lesson.findUnique needs officialCode or id");
      },
      async findMany({ where }) {
        return tables.lesson.filter((l) => matchLesson(l, where)).map((r) => ({ ...r }));
      },
      async create({ data }) {
        if (
          data.officialCode &&
          tables.lesson.some((l) => l.officialCode === data.officialCode)
        ) {
          const e = new Error("Unique constraint failed");
          e.code = "P2002";
          throw e;
        }
        const row = { id: nid("lesson"), createdAt: `t${seq}`, ...data };
        tables.lesson.push(row);
        writes.create++;
        return { ...row };
      },
      async update({ where, data }) {
        const row = byId("lesson", where.id);
        Object.assign(row, data);
        writes.update++;
        return { ...row };
      },
      async updateMany({ where, data }) {
        let count = 0;
        for (const row of tables.lesson) {
          if (matchLesson(row, where)) {
            Object.assign(row, data);
            count++;
          }
        }
        writes.updateMany++;
        return { count };
      },
    },
  };
  return db;
}

// Legacy R1-style row factories (topic-linked, no officialCode).
let legacySeq = 1;
function legacyLesson(topicId, overrides = {}) {
  return {
    id: `legacy-${legacySeq++}`,
    unitId: null,
    topicId,
    title: `Legacy ${legacySeq}`,
    titleAr: `درس قديم ${legacySeq}`,
    description: "legacy description",
    order: 1,
    duration: 90,
    videoUrl: null,
    pdfUrl: null,
    summary: null,
    curriculumStatus: "DRAFT",
    officialCode: null,
    // Phase 13: a legacy row that was `isPublished: true` before the split is
    // exactly what the migration backfill turns into `status: "PUBLISHED"`.
    // The retired `isLocked` column is deliberately NOT modelled here: no
    // access decision may read it any more.
    isPublished: true,
    status: "PUBLISHED",
    createdAt: `legacy-t${legacySeq}`,
    ...overrides,
  };
}

(async () => {
  let pass = 0;
  let fail = 0;
  const ok = (cond, msg) => {
    if (cond) {
      pass++;
    } else {
      fail++;
      console.error(`FAIL: ${msg}`);
    }
  };

  // ================= 1. Model contract =================
  const model = reconciler.loadOfficialCurriculumModel();
  ok(model.parts.length === 2, `model has 2 parts (got ${model.parts.length})`);
  const unitCount = model.parts.reduce((n, p) => n + p.units.length, 0);
  ok(unitCount === 7, `model has 7 units (got ${unitCount})`);
  const allLessons = model.parts.flatMap((p) => p.units.flatMap((u) => u.lessons));
  ok(allLessons.length === 23, `model has 23 lessons (got ${allLessons.length})`);
  const codes = new Set(allLessons.map((l) => l.code));
  ok(
    codes.size === 23 &&
      [...reconciler.OFFICIAL_LESSON_CODES].every((c) => codes.has(c)),
    "lesson codes are exactly 1-1..7-3"
  );
  const unitOrders = model.parts.flatMap((p) => p.units.map((u) => u.order));
  ok(
    JSON.stringify(unitOrders) === JSON.stringify([1, 2, 3, 4, 5, 6, 7]),
    `unit orders are global 1..7 (got ${JSON.stringify(unitOrders)})`
  );
  ok(
    allLessons.every((l) => typeof l.description === "string" && l.description.length > 0),
    "every official lesson carries a description (knowledge summary)"
  );
  ok(
    typeof model.schemaVersion === "string" && model.schemaVersion.length > 0,
    "model carries a schema version"
  );
  ok(
    reconciler.OFFICIAL_COURSE_SLUG === "programming-ai-2nd-sec",
    "official course slug is programming-ai-2nd-sec"
  );

  // ---- 1b. Corrupt models fail closed ----
  const realFile = JSON.parse(fs.readFileSync(REAL_MODEL_PATH, "utf8"));
  const expectThrow = (mutate, re, label) => {
    const clone = JSON.parse(JSON.stringify(realFile));
    mutate(clone);
    try {
      reconciler.loadOfficialCurriculumModel(clone);
      ok(false, `${label} (did NOT throw)`);
    } catch (e) {
      ok(re.test(e.message), `${label} (threw: ${e.message})`);
    }
  };
  expectThrow((m) => m.parts.pop(), /exactly 2 parts/, "part removed fails");
  expectThrow(
    (m) => m.parts[0].units.pop(),
    /exactly 7 units/,
    "unit removed fails"
  );
  expectThrow(
    (m) => m.parts[1].units[2].lessons.pop(),
    /exactly 23 lessons/,
    "lesson removed fails"
  );
  expectThrow(
    (m) => {
      m.parts[1].units[2].lessons[0].code = "1-1";
    },
    /Duplicate lesson code/,
    "duplicate code fails"
  );
  expectThrow(
    (m) => {
      m.parts[1].units[2].lessons[0].code = "8-1";
    },
    /Unexpected lesson code/,
    "unexpected code fails"
  );
  expectThrow(
    (m) => {
      delete m.parts[0].units[0].lessons[0].titleAr;
    },
    /bilingual titles/,
    "missing Arabic title fails"
  );

  // ================= 2. Fresh DB =================
  const fresh = makeMockDb();
  const r1 = await reconciler.reconcileOfficialCurriculum(fresh);
  ok(r1.courseCreated === true, "fresh run creates the course");
  ok(r1.partsCreated === 2 && r1.partsReconciled === 2, "fresh run creates 2 parts");
  ok(r1.unitsCreated === 7 && r1.unitsReconciled === 7, "fresh run creates 7 units");
  ok(r1.lessonsCreated === 23 && r1.lessonsUpdated === 0, "fresh run creates 23 lessons");
  ok(r1.archivedLessonIds.length === 0, "fresh run archives nothing");
  ok(r1.warnings.length === 0, "fresh run warns nothing");
  ok(r1.officialLessonCodes.length === 23, "report lists 23 official codes");
  const officialRows = fresh.__tables.lesson;
  ok(
    officialRows.every(
      (l) =>
        l.curriculumStatus === "OFFICIAL" &&
        // Phase 13: reconciling STAGES a lesson, it does not publish one. A new
        // official row enters the lifecycle at DRAFT and stays invisible until
        // an admin runs the READY → OPEN ceremony.
        l.status === "DRAFT" &&
        typeof l.unitId === "string" &&
        (l.topicId === null || l.topicId === undefined)
    ),
    "official rows are OFFICIAL + DRAFT (staged, not published) + unit-linked + topic-less"
  );
  ok(
    officialRows.every((l) => l.isPublished === false && l.isLocked === undefined)
    // Parity by construction: `isPublished` is written only so that a DRAFT row
    // never carries the column's `@default(true)`; `isLocked` is not written at
    // all because Phase 13 retired it.
    ,
    "the reconciler writes the mirror as false and never touches the retired `isLocked`"
  );
  const freshCourse = fresh.__tables.course[0];
  ok(
    freshCourse.slug === "programming-ai-2nd-sec" &&
      freshCourse.nameAr === "البرمجة والذكاء الاصطناعي",
    "course row carries canonical display fields"
  );

  // ================= 3. Idempotent re-run: zero writes =================
  fresh.__resetWrites();
  const r2 = await reconciler.reconcileOfficialCurriculum(fresh);
  const w2 = fresh.__writes;
  ok(
    w2.create === 0 && w2.update === 0 && w2.updateMany === 0 && w2.upsert === 0,
    `re-run performs zero writes (got ${JSON.stringify(w2)})`
  );
  ok(
    r2.lessonsCreated === 0 && r2.lessonsUpdated === 0 && r2.archivedLessonIds.length === 0,
    "re-run reports no changes"
  );
  ok(
    JSON.stringify(r2.officialLessonCodes) === JSON.stringify(r1.officialLessonCodes),
    "re-run reports the same official code set"
  );

  // ================= 4. Legacy R1 DB =================
  const legacy = makeMockDb();
  legacy.__tables.course.push({
    id: "course-r1",
    slug: "programming-ai-2nd-sec",
    name: "Old name",
    nameAr: "اسم قديم",
    description: "old",
    color: "#000000",
  });
  legacy.__tables.part.push(
    { id: "p1", courseId: "course-r1", title: "R1 P1", titleAr: "قديم 1", description: null, order: 1, createdAt: "t1" },
    { id: "p2", courseId: "course-r1", title: "R1 P2", titleAr: "قديم 2", description: null, order: 2, createdAt: "t2" }
  );
  // P1: 4 legacy units (orders 1..4) x 1 topic x 3 lessons = 12 lessons.
  // P2: 3 legacy units (orders 1,2,3 — the R1 per-part numbering) x 1 topic x 2 = 6.
  const p2UnitIdsBefore = [];
  let topicSeq = 1;
  for (const [partId, unitTotal] of [["p1", 4], ["p2", 3]]) {
    for (let i = 1; i <= unitTotal; i++) {
      const uid = `r1-${partId}-u${i}`;
      if (partId === "p2") p2UnitIdsBefore.push(uid);
      legacy.__tables.unit.push({
        id: uid, partId, title: `R1 ${uid}`, titleAr: `وحدة ${uid}`,
        order: i, icon: null, createdAt: `t-${uid}`,
      });
      const tid = `r1-topic-${topicSeq++}`;
      legacy.__tables.topic.push({ id: tid, unitId: uid, title: "T", titleAr: "م", order: 1 });
      const perTopic = partId === "p1" ? 3 : 2;
      for (let k = 0; k < perTopic; k++) {
        legacy.__tables.lesson.push(legacyLesson(tid, { order: k + 1 }));
      }
    }
  }
  // A legacy lesson with media + a history marker (simulates attached history).
  legacy.__tables.lesson[0].videoUrl = "https://video.example/keep-me";
  legacy.__tables.lesson[0].historyMarker = "progress-row-7";
  const mediaLessonId = legacy.__tables.lesson[0].id;
  // An already-archived legacy lesson: must stay archived but NOT be re-reported.
  legacy.__tables.lesson[1].curriculumStatus = "ARCHIVED";
  const preArchivedId = legacy.__tables.lesson[1].id;
  // Another course's lesson: must never be touched.
  legacy.__tables.course.push({ id: "course-other", slug: "other-course", name: "O", nameAr: "أ", description: "", color: "#fff" });
  legacy.__tables.part.push({ id: "op1", courseId: "course-other", title: "OP", titleAr: "أ", description: null, order: 1, createdAt: "t0" });
  legacy.__tables.unit.push({ id: "ou1", partId: "op1", title: "OU", titleAr: "و", order: 1, icon: null, createdAt: "t0" });
  legacy.__tables.topic.push({ id: "ot1", unitId: "ou1", title: "OT", titleAr: "م", order: 1 });
  legacy.__tables.lesson.push(legacyLesson("ot1", { id: "other-lesson" }));
  // A lesson with an UNKNOWN officialCode on the reconciled course: warned,
  // untouched. Unpublished so it stays out of the progression universe (the
  // universe test below would otherwise count this data error as curriculum).
  legacy.__tables.lesson.push(
    legacyLesson("r1-topic-1", {
      id: "stray-lesson",
      officialCode: "9-9",
      curriculumStatus: "OFFICIAL",
      isPublished: false,
      status: "DRAFT",
      title: "Stray",
    })
  );

  const r3 = await reconciler.reconcileOfficialCurriculum(legacy);
  ok(r3.courseCreated === false, "legacy run adopts the existing course");
  ok(r3.partsCreated === 0, "legacy run creates no parts (positional adoption)");
  ok(r3.unitsCreated === 0, "legacy run creates no units (positional adoption)");
  ok(r3.lessonsCreated === 23, `legacy run creates 23 official lessons (got ${r3.lessonsCreated})`);
  // 18 legacy in-course lessons, 1 pre-archived → 17 newly archived.
  ok(
    r3.archivedLessonIds.length === 17,
    `legacy run archives 17 lessons (got ${r3.archivedLessonIds.length})`
  );
  ok(!r3.archivedLessonIds.includes(preArchivedId), "pre-archived lesson is not re-reported");
  const mediaRow = legacy.__tables.lesson.find((l) => l.id === mediaLessonId);
  ok(mediaRow.curriculumStatus === "ARCHIVED", "legacy lesson flipped to ARCHIVED");
  ok(mediaRow.videoUrl === "https://video.example/keep-me", "archived lesson keeps its media URL");
  ok(mediaRow.historyMarker === "progress-row-7", "archived lesson keeps history markers (ids stable)");
  // Positional adoption: P2 unit ROWS reused, orders rewritten to 5,6,7.
  const p2UnitsAfter = legacy.__tables.unit
    .filter((u) => u.partId === "p2")
    .sort((a, b) => a.order - b.order);
  ok(
    JSON.stringify(p2UnitsAfter.map((u) => u.id)) === JSON.stringify(p2UnitIdsBefore),
    "P2 legacy unit rows adopted in place (ids reused, no duplicates)"
  );
  ok(
    JSON.stringify(p2UnitsAfter.map((u) => u.order)) === JSON.stringify([5, 6, 7]),
    "P2 unit orders rewritten to global 5,6,7"
  );
  const otherRow = legacy.__tables.lesson.find((l) => l.id === "other-lesson");
  ok(otherRow.curriculumStatus === "DRAFT", "other course's lesson untouched");
  const strayRow = legacy.__tables.lesson.find((l) => l.id === "stray-lesson");
  ok(
    strayRow.curriculumStatus === "OFFICIAL" && strayRow.title === "Stray",
    "unknown officialCode lesson never modified"
  );
  ok(
    r3.warnings.some((w) => w.includes("9-9")),
    "unknown officialCode produces a warning"
  );
  // Official rows point at adopted units of the right part.
  const p2UnitIds = new Set(p2UnitsAfter.map((u) => u.id));
  const p2Official = legacy.__tables.lesson.filter((l) =>
    ["5-1", "5-2", "5-3", "6-1", "6-2", "6-3", "7-1", "7-2", "7-3"].includes(l.officialCode)
  );
  ok(
    p2Official.length === 9 && p2Official.every((l) => p2UnitIds.has(l.unitId)),
    "P2 official lessons link to the adopted P2 units"
  );

  // ================= 5. Extra parts/units =================
  const extra = makeMockDb();
  extra.__tables.course.push({ id: "c-x", slug: "programming-ai-2nd-sec", name: "C", nameAr: "ك", description: "", color: "#000" });
  extra.__tables.part.push(
    { id: "xp1", courseId: "c-x", title: "X1", titleAr: "١", description: null, order: 1, createdAt: "t1" },
    { id: "xp2", courseId: "c-x", title: "X2", titleAr: "٢", description: null, order: 2, createdAt: "t2" },
    { id: "xp3", courseId: "c-x", title: "EXTRA PART", titleAr: "زائد", description: null, order: 3, createdAt: "t3" }
  );
  // xp1 gets 5 units (model wants 4) — the 5th is extra.
  for (let i = 1; i <= 5; i++) {
    extra.__tables.unit.push({ id: `xu1-${i}`, partId: "xp1", title: `U${i}`, titleAr: `و${i}`, order: i, icon: null, createdAt: `tu${i}` });
  }
  for (let i = 1; i <= 3; i++) {
    extra.__tables.unit.push({ id: `xu2-${i}`, partId: "xp2", title: `U${i}`, titleAr: `و${i}`, order: i, icon: null, createdAt: `tv${i}` });
  }
  extra.__tables.unit.push({ id: "xu3-1", partId: "xp3", title: "XU", titleAr: "و", order: 1, icon: null, createdAt: "tx" });
  extra.__tables.topic.push(
    { id: "xtra-unit-topic", unitId: "xu1-5", title: "XT", titleAr: "م", order: 1 },
    { id: "xtra-part-topic", unitId: "xu3-1", title: "XT", titleAr: "م", order: 1 }
  );
  extra.__tables.lesson.push(
    legacyLesson("xtra-unit-topic", { id: "extra-unit-lesson" }),
    legacyLesson("xtra-part-topic", { id: "extra-part-lesson" })
  );
  const r4 = await reconciler.reconcileOfficialCurriculum(extra);
  ok(
    r4.warnings.some((w) => w.includes("extras left untouched")),
    "extra units/parts produce warnings"
  );
  ok(
    extra.__tables.part.find((p) => p.id === "xp3").title === "EXTRA PART",
    "extra part row left untouched"
  );
  ok(
    extra.__tables.unit.find((u) => u.id === "xu1-5").title === "U5",
    "extra unit row left untouched"
  );
  ok(
    extra.__tables.lesson.find((l) => l.id === "extra-unit-lesson").curriculumStatus === "ARCHIVED" &&
      extra.__tables.lesson.find((l) => l.id === "extra-part-lesson").curriculumStatus === "ARCHIVED",
    "code-less lessons under extras still archive (reachable via course chain)"
  );

  // ================= 6. Reader universe = exactly the 23 official =================
  ok(
    JSON.stringify(engine.EXCLUDE_ARCHIVED_LESSON) ===
      JSON.stringify({ curriculumStatus: { not: "ARCHIVED" } }),
    "EXCLUDE_ARCHIVED_LESSON has the documented shape"
  );
  ok(
    JSON.stringify(engine.lessonCourseChainOr("c1")) ===
      JSON.stringify([
        { unit: { part: { courseId: "c1" } } },
        { topic: { unit: { part: { courseId: "c1" } } } },
      ]),
    "lessonCourseChainOr builds the dual-chain OR"
  );
  ok(
    JSON.stringify(engine.lessonCoursesChainOr(["c1", "c2"])) ===
      JSON.stringify([
        { unit: { part: { courseId: { in: ["c1", "c2"] } } } },
        { topic: { unit: { part: { courseId: { in: ["c1", "c2"] } } } } },
      ]),
    "lessonCoursesChainOr builds the multi-course dual-chain OR"
  );
  // Phase 13: the universe clause is the LIFECYCLE state, not the mirror.
  ok(
    JSON.stringify(lifecycle.LESSON_STUDENT_STATUS_FILTER) ===
      JSON.stringify(UNIVERSE),
    "the student universe filter is exactly { status: \"PUBLISHED\" }"
  );
  ok(
    /LESSON_STUDENT_STATUS_FILTER/.test(
      fs.readFileSync(path.join(EMIT, "session-progress.js"), "utf8")
    ),
    "and the progression engine really applies it"
  );
  // Simulate the progression-universe query over the reconciled legacy DB.
  let universeRows = await legacy.lesson.findMany({
    where: {
      ...lifecycle.LESSON_STUDENT_STATUS_FILTER,
      ...engine.EXCLUDE_ARCHIVED_LESSON,
      OR: engine.lessonCourseChainOr("course-r1"),
    },
  });
  // Right after reconciliation the legacy database holds its 23 official rows at
  // DRAFT, so the student universe is EMPTY — that is Phase 13's point (staging
  // is not publishing), and it is the property the "invisible" check below pins.
  ok(
    universeRows.length === 0,
    `a reconciled-but-unopened curriculum is invisible in the legacy DB too (got ${universeRows.length})`
  );
  for (const row of legacy.__tables.lesson) {
    // Only rows the model actually owns: the stray `9-9` lesson above is
    // OFFICIAL-tagged data, is warned about and left untouched, and must stay
    // out of the universe (it is still DRAFT).
    if (reconciler.OFFICIAL_LESSON_CODES.includes(row.officialCode)) {
      row.status = "PUBLISHED";
      row.isPublished = true;
    }
  }
  const openedLegacyRows = await legacy.lesson.findMany({
    where: {
      ...lifecycle.LESSON_STUDENT_STATUS_FILTER,
      ...engine.EXCLUDE_ARCHIVED_LESSON,
      OR: engine.lessonCourseChainOr("course-r1"),
    },
  });
  universeRows = openedLegacyRows;
  const universeCodes = universeRows.map((l) => l.officialCode).sort();
  ok(
    universeRows.length === 23,
    `after the ceremony the universe is exactly 23 lessons (got ${universeRows.length})`
  );
  ok(
    JSON.stringify(universeCodes) ===
      JSON.stringify([...reconciler.OFFICIAL_LESSON_CODES].sort()),
    "progression universe is exactly the official code set"
  );

  // A freshly reconciled curriculum is staged, not published: the same query
  // over the fresh database must find nothing until the ceremony opens it.
  const stagedUniverse = await fresh.lesson.findMany({
    where: {
      ...lifecycle.LESSON_STUDENT_STATUS_FILTER,
      ...engine.EXCLUDE_ARCHIVED_LESSON,
      OR: engine.lessonCourseChainOr(freshCourse.id),
    },
  });
  ok(
    stagedUniverse.length === 0,
    `a reconciled-but-unopened curriculum is invisible to students (got ${stagedUniverse.length})`
  );
  for (const row of fresh.__tables.lesson) {
    row.status = "PUBLISHED";
    row.isPublished = true;
  }
  const openedUniverse = await fresh.lesson.findMany({
    where: {
      ...lifecycle.LESSON_STUDENT_STATUS_FILTER,
      ...engine.EXCLUDE_ARCHIVED_LESSON,
      OR: engine.lessonCourseChainOr(freshCourse.id),
    },
  });
  ok(
    openedUniverse.length === 23,
    `opening all 23 makes the same universe complete (got ${openedUniverse.length})`
  );

  console.log(`\ncurriculum reconciliation (phase 11): ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(1);
});
