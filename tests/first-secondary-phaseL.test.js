// CodeMind Academy — Phase L: First Secondary curriculum through the EXISTING
// academic engine (offline, no database, no network).
//
// WHAT IT PROVES (17 groups, L1 … L17)
//   L1  Structure: 1 Course / 1 synthetic Part / 13 Units / 62 Lessons /
//       0 Topics, every lesson OFFICIAL + unit-linked + topic-less + DRAFT.
//   L2  Bilingual titles are SOURCE-BACKED: every Unit/Lesson title matches the
//       approved manifest (docs/curriculum/first-secondary/
//       first-secondary-curriculum.json) exactly, in both locales.
//   L3  The canonical code is the ENGLISH CHAPTER-FIRST form ("1-1" … "13-12");
//       codes are derived from the chapter/lesson position, not copied text.
//   L4  `arabicPrintedCode` is PROVENANCE ONLY: present in the manifest, absent
//       from the runtime model, absent from the Prisma schema, unused by src/.
//   L5  The duplicated Arabic badge "1-2" (printed twice in the AR edition)
//       cannot affect identity: the two lessons stay two distinct canonical
//       codes, and reconciliation creates exactly the canonical set.
//   L6  All 18 codes shared with Second Secondary COEXIST as distinct rows.
//   L7  FIRST_SECONDARY "1-1" and SECOND_SECONDARY "1-1" are fully independent.
//   L8  Both reconciliations are idempotent (second run performs zero writes).
//   L9  No cross-level mutation: neither run touches the other level's rows,
//       and the archive sweep stays inside the course it reconciles.
//   L10 Zero progression/session/quiz/homework/video leakage: the shared
//       course-chain predicates partition the lessons exactly, and a quiz /
//       homework / session-video attached to one level's lesson is unreachable
//       from the other level's identically-coded lesson.
//   L11 MockExam pools are Course-scoped (fail closed without a course).
//   L12 Parent data is child/course-scoped (lesson lookup by id, never by code).
//   L13 Registration stays OFFERING-driven: an FS Course row alone advertises
//       nothing; only an ACTIVE, CLASSIFIED group makes (level, track) appear.
//   L14 Kodgy is level-aware: no level-free code lookup exists, the SS
//       grounding keeps its exact 23 codes/titles, FS answers stay unauthored.
//   L15 Zero executable references to the pre-relocation global path
//       `docs/curriculum/knowledge-model.json` remain anywhere.
//   L16 The reconciler is level-aware and never resolves a lesson by code
//       alone (bare-code lookups are refused), and refuses level drift.
//   L17 Manifest ↔ runtime-model integrity: the model is a faithful projection
//       of the approved manifest, and the manifest's own checks all pass.
//
// Run: node tests/first-secondary-phaseL.test.js
// Exit code: 0 = all pass, 1 = failure.

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phaseL-"));

const FS_MODEL = path.join(REPO, "docs/curriculum/first-secondary/knowledge-model.json");
const FS_MANIFEST = path.join(REPO, "docs/curriculum/first-secondary/first-secondary-curriculum.json");
const SS_MODEL = path.join(REPO, "docs/curriculum/second-secondary/knowledge-model.json");
// Built from parts on purpose: this suite must not itself contain the path it
// forbids, so the executable-reference scan below stays honest.
const OLD_GLOBAL_MODEL = path.join(REPO, "docs", "curriculum", "knowledge-model" + ".json");

// ---------------------------------------------------------------------------
// 1. Compile the modules under test (the real ones — no copies)
// ---------------------------------------------------------------------------
const FILES = [
  "src/lib/official-curriculum.ts",
  "src/lib/session-progress.ts",
  "src/lib/session-lifecycle.ts",
  "src/lib/track-scope.ts",
  "src/lib/school-type.ts",
  "src/lib/enrollment.ts",
  "src/lib/academic-level.ts",
  "src/lib/mock-exam-pool.ts",
  "src/lib/kodgy/response-engine.ts",
  "src/lib/i18n-core.ts",
  "src/lib/parent-academics.ts",
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
    files: FILES.map((f) => path.join(REPO, f)),
  })
);
try {
  execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
} catch {
  /* transitive type noise is tolerated; emission below is the real check */
}
// The JSON model import drags tsc's inferred rootDir to the repo root, so the
// emit lands under OUT/src/lib.
const EMIT = path.join(OUT, "src", "lib");
for (const f of [
  "official-curriculum.js",
  "session-progress.js",
  "session-lifecycle.js",
  "academic-level.js",
  "mock-exam-pool.js",
  path.join("kodgy", "response-engine.js"),
  "parent-academics.js",
]) {
  if (!fs.existsSync(path.join(EMIT, f))) {
    console.error(`tsc did not emit ${f}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// 2. Module resolution: @/lib/db → the in-memory mock; models → their level
// ---------------------------------------------------------------------------
const MOCK_DB_PATH = path.join(OUT, "__mock-db__.js");
// Live getter: each section installs its own in-memory database, so the shim
// must read `global.__MOCK_DB__` at CALL time, not at require time.
fs.writeFileSync(MOCK_DB_PATH, "module.exports = { get db() { return global.__MOCK_DB__; } };");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return MOCK_DB_PATH;
  const alias = /^@\/lib\/([\w-]+)$/.exec(request);
  if (alias) {
    const compiled = path.join(EMIT, `${alias[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  if (request.endsWith("knowledge-model.json")) {
    return request.includes("first-secondary") ? FS_MODEL : SS_MODEL;
  }
  return origResolve.call(this, request, ...rest);
};

// ---------------------------------------------------------------------------
// 3. In-memory mock Prisma client (schema-derived orderBy validation included)
// ---------------------------------------------------------------------------
function parseModelFields(modelName) {
  const schema = fs.readFileSync(path.join(REPO, "prisma/schema.prisma"), "utf8");
  const start = schema.indexOf(`model ${modelName} {`);
  if (start < 0) throw new Error(`prisma/schema.prisma has no model ${modelName}`);
  const body = schema.slice(start, schema.indexOf("\n}", start));
  const fields = [];
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("//") || line.startsWith("///")) continue;
    if (line.startsWith("@@") || line.startsWith("model ")) continue;
    const m = /^(\w+)\s+\S+/.exec(line);
    if (m) fields.push(m[1]);
  }
  return fields;
}
const SCHEMA_FIELDS = { part: parseModelFields("Part"), unit: parseModelFields("Unit") };
function assertOrderByIsSchemaValid(modelName, orderBy) {
  const entries = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
  for (const entry of entries) {
    for (const key of Object.keys(entry || {})) {
      if (!SCHEMA_FIELDS[modelName].includes(key)) {
        throw new Error(
          `Unknown argument \`${key}\` on ${modelName}.orderBy — not a column in prisma/schema.prisma`
        );
      }
    }
  }
}

function matchCond(value, cond) {
  if (cond === null || cond === undefined) return value === null || value === undefined;
  if (typeof cond !== "object" || Array.isArray(cond)) return value === cond;
  if ("in" in cond) return Array.isArray(cond.in) && cond.in.includes(value);
  if ("not" in cond) return !matchCond(value, cond.not);
  throw new Error(`mock: unsupported condition ${JSON.stringify(cond)}`);
}

function makeMockDb() {
  const tables = {
    course: [], part: [], unit: [], topic: [], lesson: [],
    group: [], quiz: [], homework: [], sessionVideo: [], student: [],
  };
  let seq = 1;
  const nid = (p) => `${p}-${seq++}`;
  const writes = { create: 0, update: 0, updateMany: 0, upsert: 0 };
  const byId = (t, id) => (id ? tables[t].find((r) => r.id === id) : null);
  const levelOf = (l) => l.academicLevel ?? "SECOND_SECONDARY";

  const matchPartChain = (partId, cond) => {
    const p = byId("part", partId);
    if (!p) return false;
    return Object.entries(cond || {}).every(([k, v]) => matchCond(p[k], v));
  };

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
        const u = byId("unit", l.unitId);
        if (!u || !v.part || !matchPartChain(u.partId, v.part)) return false;
        continue;
      }
      if (k === "topic") {
        const t = byId("topic", l.topicId);
        const u = t ? byId("unit", t.unitId) : null;
        if (!u || !v.unit || !v.unit.part || !matchPartChain(u.partId, v.unit.part)) return false;
        continue;
      }
      if (!matchCond(l[k], v)) return false;
    }
    return true;
  }

  const orderKey = (r) => `${String(r.order).padStart(6, "0")}|${r.id}`;
  const sortRows = (rows) => [...rows].sort((a, b) => (orderKey(a) < orderKey(b) ? -1 : 1));
  const clone = (r) => JSON.parse(JSON.stringify(r));

  const db = {
    __tables: tables,
    __writes: writes,
    __matchLesson: matchLesson,
    __byId: byId,
    __resetWrites() {
      writes.create = 0; writes.update = 0; writes.updateMany = 0; writes.upsert = 0;
    },
    course: {
      async findUnique({ where }) {
        return clone(tables.course.find((c) => c.slug === where.slug) || null);
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
        return clone(row);
      },
    },
    part: {
      async findMany({ where, orderBy }) {
        assertOrderByIsSchemaValid("part", orderBy);
        return sortRows(tables.part.filter((p) => !where || p.courseId === where.courseId)).map(clone);
      },
      async create({ data }) {
        const row = { id: nid("part"), ...data };
        tables.part.push(row);
        writes.create++;
        return clone(row);
      },
      async update({ where, data }) {
        const row = byId("part", where.id);
        Object.assign(row, data);
        writes.update++;
        return clone(row);
      },
    },
    unit: {
      async findMany({ where, orderBy }) {
        assertOrderByIsSchemaValid("unit", orderBy);
        return sortRows(tables.unit.filter((u) => !where || u.partId === where.partId)).map(clone);
      },
      async create({ data }) {
        const row = { id: nid("unit"), ...data };
        tables.unit.push(row);
        writes.create++;
        return clone(row);
      },
      async update({ where, data }) {
        const row = byId("unit", where.id);
        Object.assign(row, data);
        writes.update++;
        return clone(row);
      },
    },
    topic: {
      async findMany({ where }) {
        return tables.topic.filter((t) => !where || t.unitId === where.unitId).map(clone);
      },
      async create({ data }) {
        // Phase L: First Secondary has ZERO official topics (ADR-003). If the
        // engine ever created one, this suite must fail loudly.
        const row = { id: nid("topic"), ...data };
        tables.topic.push(row);
        writes.create++;
        return clone(row);
      },
    },
    lesson: {
      async findUnique({ where }) {
        if (where.academicLevel_officialCode !== undefined) {
          const { academicLevel, officialCode } = where.academicLevel_officialCode;
          if (!academicLevel || !officialCode) {
            throw new Error("mock: academicLevel_officialCode needs both parts");
          }
          return clone(
            tables.lesson.find((l) => l.officialCode === officialCode && levelOf(l) === academicLevel) || null
          );
        }
        if (where.officialCode !== undefined) {
          // Phase K3/L: code alone is NOT a unique key any more.
          throw new Error("mock: lesson.findUnique by bare officialCode is not a unique key after K3");
        }
        if (where.id !== undefined) return clone(byId("lesson", where.id));
        throw new Error("mock: lesson.findUnique needs academicLevel_officialCode or id");
      },
      async findMany({ where }) {
        return tables.lesson.filter((l) => matchLesson(l, where)).map(clone);
      },
      async create({ data }) {
        if (
          data.officialCode &&
          tables.lesson.some(
            (l) => l.officialCode === data.officialCode && levelOf(l) === levelOf(data)
          )
        ) {
          const e = new Error("Unique constraint failed");
          e.code = "P2002";
          throw e;
        }
        const row = { id: nid("lesson"), ...data };
        tables.lesson.push(row);
        writes.create++;
        return clone(row);
      },
      async update({ where, data }) {
        const row = byId("lesson", where.id);
        Object.assign(row, data);
        writes.update++;
        return clone(row);
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
    group: {
      async findMany({ where }) {
        return tables.group
          .filter((g) => {
            if (!where) return true;
            if (where.isActive !== undefined && g.isActive !== where.isActive) return false;
            if (where.trackScope !== undefined && !matchCond(g.trackScope, where.trackScope)) return false;
            return true;
          })
          .map((g) => ({
            trackScope: g.trackScope,
            course: byId("course", g.courseId)
              ? { academicLevel: byId("course", g.courseId).academicLevel }
              : null,
          }));
      },
    },
  };
  return db;
}

// ---------------------------------------------------------------------------
// 4. Helpers
// ---------------------------------------------------------------------------
const fsSpec = JSON.parse(fs.readFileSync(FS_MODEL, "utf8"));
const manifest = JSON.parse(fs.readFileSync(FS_MANIFEST, "utf8"));

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

function manifestLessonIndex() {
  const byCode = new Map();
  const byPrinted = new Map();
  for (const u of manifest.units) {
    for (const l of u.lessons) {
      byCode.set(l.officialCode, { ...l, unitOrder: u.order, unitTitleEn: u.titleEn, unitTitleAr: u.titleAr });
      if (!byPrinted.has(l.arabicPrintedCode)) byPrinted.set(l.arabicPrintedCode, []);
      byPrinted.get(l.arabicPrintedCode).push(l.officialCode);
    }
  }
  return { byCode, byPrinted };
}

const modelLessons = () => {
  const out = [];
  for (const p of fsSpec.parts) {
    for (const u of p.units) for (const l of u.lessons) out.push({ ...l, unit: u, part: p });
  }
  return out;
};

(async () => {
  const engine = require(path.join(EMIT, "official-curriculum.js"));
  const progression = require(path.join(EMIT, "session-progress.js"));
  const lifecycle = require(path.join(EMIT, "session-lifecycle.js"));
  const academicLevel = require(path.join(EMIT, "academic-level.js"));
  const mockPool = require(path.join(EMIT, "mock-exam-pool.js"));
  const kodgy = require(path.join(EMIT, "kodgy", "response-engine.js"));
  const parentAcademics = require(path.join(EMIT, "parent-academics.js"));

  const SS_SPEC = engine.SECOND_SECONDARY_SPEC;
  const FS_SPEC = engine.FIRST_SECONDARY_SPEC;

  // ================= L1. Structure: 1/1/13/62/0 =================
  {
    const db = makeMockDb();
    global.__MOCK_DB__ = db;
    const report = await engine.reconcileOfficialCurriculum(db, FS_SPEC);

    eq(FS_SPEC.expectedCounts, { parts: 1, units: 13, lessons: 62 }, "L1: FS spec pins 1 part / 13 units / 62 lessons");
    eq(report.partsReconciled, 1, "L1: exactly ONE (synthetic) Part is reconciled");
    eq(report.unitsReconciled, 13, "L1: 13 Units are reconciled");
    eq(report.officialLessonCodes.length, 62, "L1: 62 official lesson codes are reconciled");
    eq(db.__tables.topic.length, 0, "L1: ZERO Topic rows exist (ADR-003)");
    eq(db.__tables.part.length, 1, "L1: one Part row");
    eq(db.__tables.unit.length, 13, "L1: 13 Unit rows");
    eq(db.__tables.lesson.length, 62, "L1: 62 Lesson rows");

    const part = db.__tables.part[0];
    eq([part.title, part.titleAr], ["First Secondary Curriculum", "منهج الصف الأول الثانوي"], "L1: Part titles are the approved synthetic ones");
    ok(part.order === 1, "L1: the synthetic Part is ordered first");

    const everyOfficial = db.__tables.lesson.every(
      (l) =>
        l.curriculumStatus === "OFFICIAL" &&
        !!l.unitId &&
        l.topicId === null &&
        l.academicLevel === "FIRST_SECONDARY" &&
        typeof l.officialCode === "string" &&
        !!l.title &&
        !!l.titleAr
    );
    ok(everyOfficial, "L1: every lesson is OFFICIAL, unit-linked, topic-less, levelled and bilingual");
    ok(
      db.__tables.lesson.every((l) => String(l.status).toUpperCase() === "DRAFT"),
      "L1: a reconciled curriculum is STAGED, not published (all 62 DRAFT)"
    );
    eq([report.lessonsPublished, report.lessonsAwaitingOpen], [0, 62], "L1: report says 0 published / 62 awaiting open");
    eq(report.lessonsCreated, 62, "L1: report says 62 created");
    eq(report.warnings, [], "L1: no warnings on a clean reconcile");
  }

  // ================= L2. Bilingual titles vs the approved manifest =================
  {
    const { byCode } = manifestLessonIndex();
    const lessons = modelLessons();
    eq(manifest.units.length, 13, "L2: the manifest defines 13 units");
    eq(byCode.size, 62, "L2: the manifest defines 62 lessons");
    eq(lessons.length, 62, "L2: the runtime model defines 62 lessons");

    let titleMismatch = 0;
    let missing = 0;
    for (const l of lessons) {
      const row = byCode.get(l.code);
      if (!row) { missing++; continue; }
      if (row.titleEn !== l.title || row.titleAr !== l.titleAr) titleMismatch++;
    }
    eq(missing, 0, "L2: every runtime-model lesson exists in the manifest by canonical code");
    eq(titleMismatch, 0, "L2: every runtime-model lesson title matches the manifest (EN + AR)");

    let unitMismatch = 0;
    for (const p of fsSpec.parts) {
      for (const u of p.units) {
        const mu = manifest.units.find((x) => x.order === u.order);
        if (!mu) { unitMismatch++; continue; }
        if (mu.titleEn !== u.title || mu.titleAr !== u.titleAr) unitMismatch++;
      }
    }
    eq(unitMismatch, 0, "L2: every unit title matches the manifest (EN + AR)");

    eq(fsSpec.parts[0].title, fsSpec.parts[0].titleAr && fsSpec.parts[0].title, "L2: part title present");
    ok(
      lessons.every((l) => l.title.trim() && l.titleAr.trim()),
      "L2: no lesson falls back to English in the Arabic field"
    );
    ok(
      manifest.units.every((u) => u.lessons.every((l) => l.titleArStatus === "source-backed")),
      "L2: every manifest Arabic title is source-backed (no inferred/fallback titles)"
    );
    ok(
      manifest.units.every((u) => u.titleArStatus === "source-backed"),
      "L2: every manifest Arabic unit title is source-backed"
    );
  }

  // ================= L3. Chapter-first canonical code =================
  {
    const lessons = modelLessons();
    const expected = [];
    for (const u of fsSpec.parts[0].units) for (const l of u.lessons) expected.push(l.code);
    eq(expected.length, 62, "L3: 62 codes walked in curriculum order");
    ok(
      fsSpec.parts[0].units.every((u) => Number.isInteger(u.order) && u.order >= 1 && u.order <= 13),
      "L3: units are ordered 1..13 (chapter numbers)"
    );

    let derived = 0;
    let perUnitOrderOk = true;
    for (const u of fsSpec.parts[0].units) {
      const chapter = u.order;
      u.lessons.forEach((l, i) => {
        if (l.code === `${chapter}-${i + 1}`) derived++;
        if (l.order !== i + 1) perUnitOrderOk = false;
      });
    }
    eq(derived, 62, "L3: every canonical code is chapter-first '<chapter>-<lesson>' from its position");
    ok(perUnitOrderOk, "L3: lessons are ordered 1..n inside their unit");
    eq(engine.FIRST_SECONDARY_LESSON_CODES.length, 62, "L3: the spec's code set has 62 entries");
    eq([...engine.FIRST_SECONDARY_LESSON_CODES], expected, "L3: the spec's code set equals the model walk order");
    ok(
      fsSpec.parts[0].units[12].lessons.every((l) => l.code.startsWith("13-")),
      "L3: chapter 13 lessons keep chapter-first codes (13-1 … 13-12)"
    );

    // The DB rows carry the same canonical code — not a badge, not a title.
    const db = makeMockDb();
    global.__MOCK_DB__ = db;
    await engine.reconcileOfficialCurriculum(db, FS_SPEC);
    const dbCodes = db.__tables.lesson.map((l) => l.officialCode).sort();
    eq(dbCodes, [...expected].sort(), "L3: every persisted Lesson.officialCode is a canonical chapter-first code");
  }

  // ================= L4. Arabic badge is provenance only =================
  {
    const { byPrinted } = manifestLessonIndex();
    eq(byPrinted.size, 61, "L4: the manifest keeps 61 distinct printed badges (62 lessons)");
    const printedPattern = [...byPrinted.keys()].every((c) => /^\d+-\d+$/.test(c));
    ok(printedPattern, "L4: every printed badge is stored as a '<n>-<n>' provenance string");

    const modelRaw = fs.readFileSync(FS_MODEL, "utf8");
    ok(!/arabicPrintedCode|printedCode|printedBadge/i.test(modelRaw), "L4: the runtime model carries NO printed-badge field");
    ok(
      !/arabicPrintedCode/.test(fs.readFileSync(path.join(REPO, "prisma/schema.prisma"), "utf8")),
      "L4: no `Lesson.arabicPrintedCode` column exists (no schema migration in Phase L)"
    );

    const srcHits = execSync(
      `grep -rn "arabicPrintedCode" src scripts 2>/dev/null || true`,
      { cwd: REPO, encoding: "utf8" }
    ).trim();
    eq(srcHits, "", "L4: no runtime/script code reads the printed badge");

    // Reverse convention proof: the AR edition prints '<lesson>-<unit>'.
    const u1l1 = manifest.units[0].lessons[0];
    const u13l1 = manifest.units[12].lessons[0];
    eq(u1l1.arabicPrintedCode, "1-1", "L4: unit 1 lesson 1 prints 1-1 (both conventions agree)");
    eq(u13l1.arabicPrintedCode, "1-13", "L4: unit 13 lesson 1 prints 1-13 — REVERSED from the canonical 13-1");
    ok(u13l1.officialCode === "13-1", "L4: …and its canonical identity stays chapter-first (13-1)");
  }

  // ================= L5. Duplicate Arabic "1-2" cannot affect identity =================
  {
    const { byPrinted, byCode } = manifestLessonIndex();
    const dup = byPrinted.get("1-2");
    eq(dup.length, 2, "L5: the Arabic edition prints the badge '1-2' twice (accepted source defect)");
    eq([...dup].sort(), ["1-2", "2-1"], "L5: those two pages are two distinct canonical lessons");

    ok(byCode.get("1-2").unitOrder === 1, "L5: canonical 1-2 is unit 1 / lesson 2");
    ok(byCode.get("2-1").unitOrder === 2, "L5: canonical 2-1 is unit 2 / lesson 1");
    ok(
      byCode.get("2-1").arabicPrintedCode === "1-2",
      "L5: the printed badge and the canonical code disagree — exactly why the badge is not identity"
    );

    const db = makeMockDb();
    global.__MOCK_DB__ = db;
    await engine.reconcileOfficialCurriculum(db, FS_SPEC);
    const withBadge1_2 = db.__tables.lesson.filter((l) => l.officialCode === "1-2");
    eq(withBadge1_2.length, 1, "L5: the duplicated badge created exactly ONE canonical lesson 1-2");
    eq(
      db.__tables.lesson.filter((l) => l.officialCode === "2-1").length,
      1,
      "L5: …and exactly one canonical lesson 2-1"
    );
    ok(
      db.__tables.lesson.every((l) => !/^\d+-\d+$/.test(l.officialCode) || l.officialCode.split("-")[0] !== "0"),
      "L5: no '0-x' or badge-shaped identity leaked into the DB"
    );
    // A code set walk proves no reversed code was ever adopted.
    const canonical = new Set(engine.FIRST_SECONDARY_LESSON_CODES);
    ok(
      db.__tables.lesson.every((l) => canonical.has(l.officialCode)),
      "L5: every persisted code is in the canonical set (no reversed/<lesson>-<unit> code)"
    );
  }

  // ================= L6. All 18 cross-level collisions coexist =================
  const SNAPSHOT = () => ({
    course: JSON.parse(JSON.stringify(mock.__tables.course)),
    part: JSON.parse(JSON.stringify(mock.__tables.part)),
    unit: JSON.parse(JSON.stringify(mock.__tables.unit)),
    lesson: JSON.parse(JSON.stringify(mock.__tables.lesson)),
  });
  const mock = makeMockDb();
  global.__MOCK_DB__ = mock;
  const ssReport1 = await engine.reconcileOfficialCurriculum(mock, SS_SPEC);
  const fsReport1 = await engine.reconcileOfficialCurriculum(mock, FS_SPEC);
  {
    const ssCodes = new Set(ssReport1.officialLessonCodes);
    const fsCodes = new Set(fsReport1.officialLessonCodes);
    const shared = [...ssCodes].filter((c) => fsCodes.has(c));
    eq(shared.length, 18, "L6: exactly 18 codes are shared between the two curricula");
    eq(
      [...shared].sort(),
      manifest.crossLevel.sharedOfficialCodesWithSecondSecondary.slice().sort(),
      "L6: the shared set equals the manifest's declared cross-level overlap"
    );

    let coexisting = 0;
    for (const code of shared) {
      const rows = mock.__tables.lesson.filter((l) => l.officialCode === code);
      if (
        rows.length === 2 &&
        rows[0].id !== rows[1].id &&
        rows[0].unitId !== rows[1].unitId &&
        new Set(rows.map((r) => r.academicLevel)).size === 2
      ) {
        coexisting++;
      }
    }
    eq(coexisting, 18, "L6: all 18 shared codes exist as two DISTINCT rows (level + unit differ)");

    eq(mock.__tables.lesson.length, 85, "L6: 23 + 62 rows total (no adoption, no merge)");
    eq(new Set(mock.__tables.lesson.map((l) => l.officialCode)).size, 67, "L6: 67 distinct canonical codes (85 rows − 18 duals)");
    eq(mock.__tables.course.length, 2, "L6: two separate courses exist");
    eq(
      mock.__tables.course.map((c) => [c.slug, c.academicLevel]).sort((a, b) => (a[0] < b[0] ? -1 : 1)),
      [["programming-ai-1st-sec", "FIRST_SECONDARY"], ["programming-ai-2nd-sec", "SECOND_SECONDARY"]],
      "L6: the two official courses keep their own slug + level"
    );
  }

  // ================= L7. FS "1-1" vs SS "1-1" are independent =================
  {
    const fs11 = await mock.lesson.findUnique({
      where: { academicLevel_officialCode: { academicLevel: "FIRST_SECONDARY", officialCode: "1-1" } },
    });
    const ss11 = await mock.lesson.findUnique({
      where: { academicLevel_officialCode: { academicLevel: "SECOND_SECONDARY", officialCode: "1-1" } },
    });
    ok(!!fs11 && !!ss11, "L7: both levels own a lesson coded 1-1");
    ok(fs11.id !== ss11.id, "L7: they are different rows");
    ok(fs11.unitId !== ss11.unitId, "L7: they hang off different units");
    eq(fs11.title, "Information and Media", "L7: FS 1-1 carries the First Secondary title");
    eq(ss11.title, "Development of Information Technology and Social Transformation", "L7: SS 1-1 keeps its own title");
    ok(
      (await mock.lesson.findUnique({
        where: { academicLevel_officialCode: { academicLevel: "FIRST_SECONDARY", officialCode: "1-1" } },
      })).title === fs11.title,
      "L7: the level-scoped lookup is deterministic"
    );

    // Independence in both directions: touch one, the other is byte-identical.
    const before = JSON.stringify(ss11);
    await mock.lesson.update({ where: { id: fs11.id }, data: { title: "L7 mutation probe" } });
    const ssAfter = await mock.lesson.findUnique({ where: { id: ss11.id } });
    eq(JSON.stringify(ssAfter), before, "L7: mutating FS 1-1 leaves SS 1-1 untouched");
    await mock.lesson.update({ where: { id: fs11.id }, data: { title: fs11.title } });

    let bareCodeRefused = false;
    try {
      await mock.lesson.findUnique({ where: { officialCode: "1-1" } });
    } catch {
      bareCodeRefused = true;
    }
    ok(bareCodeRefused, "L7: a bare-code lookup is refused at the client level (no ambiguous identity)");
  }

  // ================= L8. Both reconciliations are idempotent =================
  {
    const ssSnapshot = JSON.stringify(SNAPSHOT().lesson.filter((l) => l.academicLevel === "SECOND_SECONDARY"));
    const fsSnapshot = JSON.stringify(SNAPSHOT().lesson.filter((l) => l.academicLevel === "FIRST_SECONDARY"));

    mock.__resetWrites();
    const ssReport2 = await engine.reconcileOfficialCurriculum(mock, SS_SPEC);
    eq(mock.__writes, { create: 0, update: 0, updateMany: 0, upsert: 0 }, "L8: the 2nd SS run performs ZERO writes");
    eq([ssReport2.lessonsCreated, ssReport2.lessonsUpdated, ssReport2.archivedLessonIds.length], [0, 0, 0], "L8: the 2nd SS run reports no change");

    mock.__resetWrites();
    const fsReport2 = await engine.reconcileOfficialCurriculum(mock, FS_SPEC);
    eq(mock.__writes, { create: 0, update: 0, updateMany: 0, upsert: 0 }, "L8: the 2nd FS run performs ZERO writes");
    eq([fsReport2.lessonsCreated, fsReport2.lessonsUpdated, fsReport2.archivedLessonIds.length], [0, 0, 0], "L8: the 2nd FS run reports no change");

    eq(fsReport2.officialLessonCodes.length, 62, "L8: re-running still reconciles the full 62-lesson set");
    eq(
      JSON.stringify(SNAPSHOT().lesson.filter((l) => l.academicLevel === "SECOND_SECONDARY")),
      ssSnapshot,
      "L8: SS rows are byte-identical after its own re-run"
    );
    eq(
      JSON.stringify(SNAPSHOT().lesson.filter((l) => l.academicLevel === "FIRST_SECONDARY")),
      fsSnapshot,
      "L8: FS rows are byte-identical after its own re-run"
    );
  }

  // ================= L9. No cross-level mutation =================
  {
    const db = makeMockDb();
    global.__MOCK_DB__ = db;
    await engine.reconcileOfficialCurriculum(db, SS_SPEC);
    // Legacy rows in BOTH courses, reachable only through their own chain.
    const ssCourse = db.__tables.course.find((c) => c.slug === "programming-ai-2nd-sec");
    const ssUnit = db.__tables.unit.find((u) => u.partId === db.__tables.part.find((p) => p.courseId === ssCourse.id).id);
    const ssTopic = { id: "topic-ss", unitId: ssUnit.id, title: "legacy", titleAr: "قديم", order: 99 };
    db.__tables.topic.push(ssTopic);
    db.__tables.lesson.push({
      id: "legacy-ss", unitId: null, topicId: ssTopic.id, title: "Legacy SS", titleAr: "قديم",
      order: 98, curriculumStatus: "DRAFT", officialCode: null, academicLevel: "SECOND_SECONDARY",
      status: "DRAFT",
    });

    const ssBefore = JSON.stringify(
      db.__tables.lesson.filter((l) => l.academicLevel === "SECOND_SECONDARY").map((l) => ({ ...l }))
    );
    const fsReportOnSharedDb = await engine.reconcileOfficialCurriculum(db, FS_SPEC);
    const ssAfter = JSON.stringify(
      db.__tables.lesson.filter((l) => l.academicLevel === "SECOND_SECONDARY").map((l) => ({ ...l }))
    );
    eq(ssAfter, ssBefore, "L9: an FS reconcile leaves EVERY Second Secondary row byte-identical");
    eq(fsReportOnSharedDb.archivedLessonIds, [], "L9: the FS archive sweep archives nothing outside its own course");
    eq(
      db.__tables.lesson.find((l) => l.id === "legacy-ss").curriculumStatus,
      "DRAFT",
      "L9: the SS legacy lesson is untouched by the FS run"
    );

    const ssTopicsBefore = JSON.stringify(db.__tables.topic.filter((t) => t.id === ssTopic.id));
    const fsSnapshot = JSON.stringify(db.__tables.lesson.filter((l) => l.academicLevel === "FIRST_SECONDARY"));
    const ssOwnReport = await engine.reconcileOfficialCurriculum(db, SS_SPEC);
    eq(
      JSON.stringify(db.__tables.lesson.filter((l) => l.academicLevel === "FIRST_SECONDARY")),
      fsSnapshot,
      "L9: an SS reconcile leaves EVERY First Secondary row byte-identical"
    );
    eq(JSON.stringify(db.__tables.topic.filter((t) => t.id === ssTopic.id)), ssTopicsBefore, "L9: legacy topics survive untouched");
    eq(ssOwnReport.archivedLessonIds, ["legacy-ss"], "L9: the SS reconcile archives ONLY its own course's legacy lesson");

    // And an FS-side legacy row is archived by the FS run, not by the SS run.
    const db2 = makeMockDb();
    global.__MOCK_DB__ = db2;
    await engine.reconcileOfficialCurriculum(db2, FS_SPEC);
    const fsCourse = db2.__tables.course.find((c) => c.slug === "programming-ai-1st-sec");
    const fsUnit = db2.__tables.unit.find((u) => u.partId === db2.__tables.part.find((p) => p.courseId === fsCourse.id).id);
    db2.__tables.topic.push({ id: "topic-fs", unitId: fsUnit.id, title: "legacy", titleAr: "قديم", order: 99 });
    db2.__tables.lesson.push({
      id: "legacy-fs", unitId: null, topicId: "topic-fs", title: "Legacy FS", titleAr: "قديم",
      order: 98, curriculumStatus: "DRAFT", officialCode: null, academicLevel: "FIRST_SECONDARY",
      status: "DRAFT",
    });
    await engine.reconcileOfficialCurriculum(db2, SS_SPEC);
    eq(
      db2.__tables.lesson.find((l) => l.id === "legacy-fs").curriculumStatus,
      "DRAFT",
      "L9: the SS reconcile does NOT archive a First Secondary legacy lesson"
    );
    const fsOwnReport = await engine.reconcileOfficialCurriculum(db2, FS_SPEC);
    eq(fsOwnReport.archivedLessonIds, ["legacy-fs"], "L9: the FS reconcile archives ONLY its own legacy lesson");
  }

  // ================= L10. Zero progression/session/quiz/homework/video leakage =================
  {
    const db = mock;
    global.__MOCK_DB__ = db;
    const fsCourse = db.__tables.course.find((c) => c.slug === "programming-ai-1st-sec");
    const ssCourse = db.__tables.course.find((c) => c.slug === "programming-ai-2nd-sec");
    // Publish both curricula (the ceremony is an admin decision; the reader
    // universe is the PUBLISHED slice).
    for (const l of db.__tables.lesson) {
      if (l.officialCode) { l.status = "PUBLISHED"; l.isPublished = true; }
    }

    // The SHARED predicates the whole platform reads (progression, navigation,
    // quizzes, homework, certificates) — course chain + lifecycle + archived.
    const whereFor = (courseId) => ({
      ...lifecycle.LESSON_STUDENT_STATUS_FILTER,
      ...progression.EXCLUDE_ARCHIVED_LESSON,
      OR: progression.lessonCourseChainOr(courseId),
    });
    const rowsFor = (courseId) => db.__tables.lesson.filter((l) => db.__matchLesson(l, whereFor(courseId)));
    const fsRows = rowsFor(fsCourse.id);
    const ssRows = rowsFor(ssCourse.id);

    eq(fsRows.length, 62, "L10: the FS reader universe is exactly 62 lessons");
    eq(ssRows.length, 23, "L10: the SS reader universe is exactly 23 lessons");
    const fsIds = new Set(fsRows.map((l) => l.id));
    const ssIds = new Set(ssRows.map((l) => l.id));
    eq([...fsIds].filter((id) => ssIds.has(id)).length, 0, "L10: the two universes share ZERO lesson ids");
    eq(fsIds.size, 62, "L10: FS universe ids are unique");
    ok(
      ssRows.every((l) => l.officialCode === null || new Set(ssReport1.officialLessonCodes).has(l.officialCode)),
      "L10: no FS lesson leaks into the SS progression/session/quiz universe"
    );

    // Quiz / homework / session-video rows are attached BY LESSON ID. The
    // shared codes are distinct rows, so payload cannot cross levels.
    const fs11 = fsRows.find((l) => l.officialCode === "1-1");
    const ss11 = ssRows.find((l) => l.officialCode === "1-1");
    ok(fs11 && ss11 && fs11.id !== ss11.id, "L10: FS and SS '1-1' lessons are distinct rows in the live set");

    db.__tables.quiz.push({ id: "quiz-fs", lessonId: fs11.id, title: "FS quiz", titleAr: "اختبار" });
    db.__tables.quiz.push({ id: "quiz-ss", lessonId: ss11.id, title: "SS quiz", titleAr: "اختبار" });
    db.__tables.homework.push({ id: "hw-fs", lessonId: fs11.id, title: "FS hw", titleAr: "واجب" });
    db.__tables.homework.push({ id: "hw-ss", lessonId: ss11.id, title: "SS hw", titleAr: "واجب" });
    db.__tables.sessionVideo.push({ id: "sv-fs", lessonId: fs11.id, url: "s3://fs" });
    db.__tables.sessionVideo.push({ id: "sv-ss", lessonId: ss11.id, url: "s3://ss" });

    // A quiz/homework list for a course is "rows whose lesson is in THIS
    // course's universe" — the shape every reader uses.
    const lessonIdsOf = (courseId) => new Set(rowsFor(courseId).map((l) => l.id));
    const attachedTo = (table, courseId) =>
      table.filter((r) => lessonIdsOf(courseId).has(r.lessonId));
    eq(attachedTo(db.__tables.quiz, fsCourse.id).map((q) => q.id), ["quiz-fs"], "L10: the FS course reads only its own quiz");
    eq(attachedTo(db.__tables.quiz, ssCourse.id).map((q) => q.id), ["quiz-ss"], "L10: the SS course reads only its own quiz");
    eq(attachedTo(db.__tables.homework, fsCourse.id).map((h) => h.id), ["hw-fs"], "L10: homework is lesson/course scoped per level");
    eq(attachedTo(db.__tables.homework, ssCourse.id).map((h) => h.id), ["hw-ss"], "L10: …in both directions");
    eq(
      db.__tables.sessionVideo.filter((v) => v.lessonId === fs11.id).map((v) => v.id),
      ["sv-fs"],
      "L10: an FS session video is attached to the FS lesson row only"
    );
    eq(
      db.__tables.sessionVideo.filter((v) => v.lessonId === ss11.id).map((v) => v.id),
      ["sv-ss"],
      "L10: …and the SS lesson keeps its own video"
    );
    eq(
      db.__tables.sessionVideo.filter((v) => v.lessonId === fs11.id || v.lessonId === ss11.id).length,
      2,
      "L10: two identically-coded lessons carry two independent videos"
    );
  }

  // ================= L11. MockExam pools are Course-scoped =================
  {
    const db = mock;
    global.__MOCK_DB__ = db;
    const fsCourse = db.__tables.course.find((c) => c.slug === "programming-ai-1st-sec");
    const ssCourse = db.__tables.course.find((c) => c.slug === "programming-ai-2nd-sec");

    const whereFs = mockPool.mockExamLessonWhere(fsCourse.id);
    const whereSs = mockPool.mockExamLessonWhere(ssCourse.id);
    const poolFs = db.__tables.lesson.filter((l) => db.__matchLesson(l, whereFs));
    const poolSs = db.__tables.lesson.filter((l) => db.__matchLesson(l, whereSs));
    eq(poolFs.length, 62, "L11: the FS mock-exam pool contains exactly the FS lessons");
    eq(poolSs.length, 23, "L11: the SS pool contains exactly the SS lessons");
    eq(poolFs.filter((l) => poolSs.some((s) => s.id === l.id)).length, 0, "L11: the two pools are disjoint");

    const poolNone = db.__tables.lesson.filter((l) => db.__matchLesson(l, mockPool.mockExamLessonWhere(null)));
    eq(poolNone.length, 0, "L11: a course-less exam pool matches NOTHING (fail closed, no cross-level bank)");
    ok(JSON.stringify(whereFs).includes('"courseId"'), "L11: the pool predicate is anchored on courseId");
  }

  // ================= L12. Parent data is child/course-scoped =================
  {
    eq(
      await parentAcademics.loadCanonicalCourseProgress("child-1", null),
      { state: "NO_ACTIVE_COURSE" },
      "L12: no active course ⇒ NO_ACTIVE_COURSE (never a code-derived fallback)"
    );
    const src = fs.readFileSync(path.join(REPO, "src/lib/parent-academics.ts"), "utf8");
    ok(
      /loadCourseProgression\(studentId, courseId/.test(src),
      "L12: the child snapshot measures the CHILD's enrolled course"
    );
    ok(
      /where: \{ id: \{ in: lessonIds \} \}/.test(src),
      "L12: lesson titles are read by lesson ID (the ids come from the course-scoped progression)"
    );
    ok(
      !/where:\s*\{[^}]*officialCode/.test(src),
      "L12: no query filters lessons by officialCode — identity is the id, never a code"
    );
    ok(
      /select: \{ id: true, title: true, titleAr: true, officialCode: true \}/.test(src),
      "L12: officialCode is read only as a DISPLAY field beside the title, inside the id-scoped query"
    );
    const fsIds = new Set(mock.__tables.lesson.filter((l) => l.academicLevel === "FIRST_SECONDARY").map((l) => l.id));
    const ssIds = new Set(mock.__tables.lesson.filter((l) => l.academicLevel === "SECOND_SECONDARY").map((l) => l.id));
    eq([...fsIds].filter((id) => ssIds.has(id)).length, 0, "L12: the id space cannot bleed a sibling level's lesson title");
  }

  // ================= L13. Registration is offering-driven =================
  {
    const db = makeMockDb();
    global.__MOCK_DB__ = db;
    const summary = await engine.reconcileAllOfficialCurricula(db);
    eq(summary.courseSlugs, ["programming-ai-2nd-sec", "programming-ai-1st-sec"], "L13: the fan-out reconciles both levels, SS first");
    eq(summary.officialLessonCodes.length, 85, "L13: the summary aggregates 85 official codes (23 + 62)");

    // A Course row alone advertises nothing: no group yet.
    eq(await academicLevel.loadRegistrationOfferings(), [], "L13: two reconciled Course rows offer NOTHING without a group");

    // A group that is inactive or unclassified still offers nothing.
    const fsCourse = db.__tables.course.find((c) => c.slug === "programming-ai-1st-sec");
    const ssCourse = db.__tables.course.find((c) => c.slug === "programming-ai-2nd-sec");
    db.__tables.group.push({ id: "g-inactive", courseId: fsCourse.id, isActive: false, trackScope: "ARABIC" });
    db.__tables.group.push({ id: "g-unclassified", courseId: fsCourse.id, isActive: true, trackScope: "SHARED" });
    eq(await academicLevel.loadRegistrationOfferings(), [], "L13: inactive / unclassified groups advertise nothing");

    // A real, active, classified FS group is what makes FS selectable.
    db.__tables.group.push({ id: "g-fs-ar", courseId: fsCourse.id, isActive: true, trackScope: "ARABIC" });
    db.__tables.group.push({ id: "g-ss-lang", courseId: ssCourse.id, isActive: true, trackScope: "LANGUAGE" });
    eq(
      await academicLevel.loadRegistrationOfferings(),
      [
        { academicLevel: "FIRST_SECONDARY", tracks: ["ARABIC"] },
        { academicLevel: "SECOND_SECONDARY", tracks: ["LANGUAGE"] },
      ],
      "L13: offerings follow ACTIVE classified groups, per level"
    );
    ok(
      academicLevel.isOfferedPair(await academicLevel.loadRegistrationOfferings(), "FIRST_SECONDARY", "LANGUAGE") === false,
      "L13: a (level, track) pair without a group is not offered"
    );
  }

  // ================= L14. Kodgy is level/course aware =================
  {
    eq(kodgy.CURRICULUM_GROUNDING.length, 23, "L14: the Second Secondary grounding keeps its 23 sessions");
    eq(kodgy.CURRICULUM_GROUNDING_BY_LEVEL.FIRST_SECONDARY.length, 0, "L14: no First Secondary Kodgy answers are fabricated");
    eq(kodgy.curriculumGroundingForLevel("SECOND_SECONDARY").length, 23, "L14: the SS level exposes the grounded set");
    ok(
      typeof kodgy.curriculumSessionForLevel === "function",
      "L14: session resolution is level-scoped"
    );
    ok(
      typeof kodgy.sessionForCode === "undefined" && typeof kodgy.curriculumSessionForCode === "undefined",
      "L14: NO level-free code lookup exists (the 18-code ambiguity cannot be resolved by code alone)"
    );
    const ss11 = kodgy.curriculumSessionForLevel("SECOND_SECONDARY", "1-1");
    ok(ss11 && ss11.code === "1-1" && ss11.titleEn.includes("Information Technology"), "L14: SS 1-1 resolves inside its level");
    eq(kodgy.curriculumSessionForLevel("FIRST_SECONDARY", "1-1"), null, "L14: FS 1-1 resolves to NOTHING (no unauthored answer, no SS bleed)");
    eq(kodgy.curriculumSessionForLevel("SECOND_SECONDARY", "13-12"), null, "L14: SS cannot resolve an FS-only code");
    eq(kodgy.curriculumSessionForLevel("SECOND_SECONDARY", ""), null, "L14: an empty code resolves to nothing");

    // SS behaviour preserved: the same 23 codes/titles as the live SS model.
    const ssModel = JSON.parse(fs.readFileSync(SS_MODEL, "utf8"));
    const titleByCode = new Map();
    for (const p of ssModel.parts) for (const u of p.units) for (const l of u.lessons) titleByCode.set(l.code, l);
    ok(
      kodgy.CURRICULUM_GROUNDING.every(
        (g) => titleByCode.get(g.code)?.title === g.titleEn && titleByCode.get(g.code)?.titleAr === g.titleAr
      ),
      "L14: grounding titles still match the live SS model exactly (AR + EN)"
    );
    const groundedCodes = new Set(kodgy.CURRICULUM_GROUNDING.map((g) => g.code));
    ok(
      [...groundedCodes].every((c) => SS_SPEC.expectedCodes.includes(c)),
      "L14: every grounded code belongs to the Second Secondary spec"
    );
    const r = kodgy.match("ما هو الذكاء الاصطناعي؟");
    ok(r.matched, "L14: the matcher still answers Second Secondary questions unchanged");
  }

  // ================= L15. Zero executable refs to the old global model path =================
  {
    ok(!fs.existsSync(OLD_GLOBAL_MODEL), "L15: the pre-relocation global model path does not exist (no compat copy)");
    ok(fs.existsSync(SS_MODEL), "L15: the Second Secondary model lives at its per-level path");
    ok(fs.existsSync(FS_MODEL), "L15: the First Secondary model lives at its per-level path");
    ok(
      !fs.existsSync(path.join(REPO, "docs/curriculum/knowledge-model-1st-sec.json")),
      "L15: no stray root-level First Secondary model"
    );

    // EXECUTABLE references only: a comment may name the historical path (this
    // suite does, to explain the relocation), code may not. `docs/*.md` are
    // historical phase records, not code, so they are out of scope here.
    const scan = (dirs) =>
      execSync(
        `grep -rn "knowledge-model\\\\.json" ${dirs} 2>/dev/null || true`,
        { cwd: REPO, encoding: "utf8" }
      )
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const m = /^([^:]+):(\d+):(.*)$/.exec(line);
          return m ? { file: m[1], line: Number(m[2]), text: m[3] } : { file: line, line: 0, text: line };
        });

    const executableOffenders = scan("src scripts tests")
      .map((h) => ({ ...h, code: h.text.split("//")[0] }))
      .filter((h) => /curriculum\/knowledge-model\.json/.test(h.code))
      .filter((h) => !/first-secondary\/knowledge-model\.json/.test(h.code))
      .filter((h) => !/second-secondary\/knowledge-model\.json/.test(h.code))
      // A deliberate "this file must NOT exist" guard is the enforcement of the
      // rule, not a reference to a relocated model.
      .filter((h) => !/!fs\.existsSync\([^)]*knowledge-model/.test(h.code));
    eq(
      executableOffenders,
      [],
      "L15: ZERO executable references to the pre-relocation global model path remain in src/ scripts/ tests/"
    );

    // The adjacent-segment form (`path.join(..., "curriculum", "knowledge-model.json")`)
    // is the same defect spelled differently.
    const segmentOffenders = scan("src scripts tests")
      .map((h) => ({ ...h, code: h.text.split("//")[0] }))
      .filter((h) => /"curriculum",\s*"knowledge-model\.json"/.test(h.code))
      .filter((h) => !/!fs\.existsSync\([^)]*knowledge-model/.test(h.code));
    eq(segmentOffenders, [], "L15: no resolver targets the flat pre-relocation path by segments");

    // Every bare-filename resolver picks a LEVEL FOLDER, so the two models can
    // never shadow each other (this is the Phase L repair of the old 1:1 hook).
    const resolvers = [
      "tests/curriculum-reconciliation-phase11.test.js",
      "tests/session-lifecycle-phase13.test.js",
      "scripts/verify-k1-academic-level.mjs",
      "scripts/verify-k3-academic-level.mjs",
      "scripts/verify-phase13-db.mjs",
      "scripts/verify-k2-academic-level.mjs",
      "scripts/phase22-reconcile.mjs",
    ];
    for (const rel of resolvers) {
      const text = fs.readFileSync(path.join(REPO, rel), "utf8");
      ok(
        /first-secondary/.test(text) && /second-secondary/.test(text),
        `L15: ${rel} distinguishes the two per-level models`
      );
    }

    // The committed curriculum artifacts point at real, per-level sources.
    eq(
      manifest.authoritativeSources.map((s) => path.dirname(s.path)),
      ["docs/curriculum/first-secondary", "docs/curriculum/first-secondary"],
      "L15: the manifest's authoritative sources live beside the per-level model"
    );
    ok(
      manifest.authoritativeSources.every((s) => fs.existsSync(path.join(REPO, s.path))),
      "L15: every declared source file exists at its declared path"
    );
  }

  // ================= L16. Level-aware reconciler + fail-closed drift =================
  {
    eq(
      engine.LEVEL_CURRICULUM_SPECS.map((s) => s.academicLevel),
      ["SECOND_SECONDARY", "FIRST_SECONDARY"],
      "L16: the registry holds both levels, in order"
    );
    eq(engine.specForLevel("FIRST_SECONDARY"), FS_SPEC, "L16: specForLevel resolves FS");
    eq(engine.specForLevel("SECOND_SECONDARY"), SS_SPEC, "L16: specForLevel resolves SS");
    eq(engine.specForLevel("GRADE_9"), null, "L16: an unknown level has no spec (no guessing)");
    ok(
      engine.loadOfficialCurriculumModel().parts.length === 2,
      "L16: the legacy default loader still resolves the Second Secondary model"
    );

    // Level drift is refused BEFORE any write.
    const db = makeMockDb();
    global.__MOCK_DB__ = db;
    db.__tables.course.push({
      id: "c-drift", slug: "programming-ai-1st-sec", name: "x", nameAr: "س",
      description: "", color: "#000", academicLevel: "SECOND_SECONDARY",
    });
    let refused = null;
    try {
      await engine.reconcileOfficialCurriculum(db, FS_SPEC);
    } catch (e) {
      refused = e;
    }
    ok(refused && /refused/i.test(String(refused.message)), "L16: a stored-level/spec mismatch is REFUSED");
    eq(db.__tables.part.length, 0, "L16: …and the refused run wrote nothing (parts)");
    eq(db.__tables.lesson.length, 0, "L16: …and the refused run wrote nothing (lessons)");
  }

  // ================= L17. Manifest ↔ runtime model integrity =================
  {
    eq(manifest.manifestType, "curriculum-extraction-manifest", "L17: the approved artifact is an extraction manifest");
    eq(manifest.manifestVersion, "0.2.0", "L17: manifest v0.2.0 (superseding 0.1.0)");
    eq(manifest.academicLevel, "FIRST_SECONDARY", "L17: the manifest declares the First Secondary level");
    eq(manifest.expectedCounts, { parts: 1, units: 13, lessons: 62, topics: 0 }, "L17: expected counts are 1/13/62/0");
    // Structural checks all PASS. The ONE non-PASS entry is the accepted
    // Arabic duplicate badge — REPORTED as a source defect, never "fixed" in
    // the data (the manifest keeps the exact printed value).
    const notPassing = manifest.integrity.validationChecks.filter((c) => c.result !== "PASS");
    eq(notPassing.length, 1, "L17: exactly one integrity check is not PASS (the reported AR badge defect)");
    ok(
      /duplicate printed badge/i.test(notPassing[0].check) && /REPORTED, NOT RECONCILED/.test(notPassing[0].result),
      "L17: the non-PASS check is the AN-2 duplicate badge, reported not reconciled"
    );
    ok(
      manifest.sourceAnomalies.some((a) => a.id === "AN-2" && /printed twice|duplicate/i.test(a.finding)),
      "L17: the anomaly register documents AN-2"
    );
    eq(
      manifest.units.flatMap((u) => u.lessons).filter((l) => l.arabicPrintedCode === "1-2").length,
      2,
      "L17: the printed badge '1-2' is preserved verbatim on BOTH lessons (data not 'fixed')"
    );
    eq(manifest.authoritativeSources.length, 2, "L17: two authoritative PDFs (EN + AR)");
    ok(
      manifest.authoritativeSources.every((s) => /^[a-f0-9]{64}$/.test(s.sha256)),
      "L17: every source carries a sha256 (provenance is checkable)"
    );
    eq(
      manifest.units.map((u) => u.lessonCount),
      [2, 3, 5, 1, 3, 10, 3, 5, 3, 6, 4, 5, 12],
      "L17: per-chapter lesson counts are {2,3,5,1,3,10,3,5,3,6,4,5,12}"
    );

    // The runtime model is a FAITHFUL projection of the manifest — field by
    // field, in order, for all 13 units and all 62 lessons.
    const { byCode } = manifestLessonIndex();
    const rebuilt = [];
    for (const u of fsSpec.parts[0].units) {
      for (const l of u.lessons) rebuilt.push(l);
    }
    eq(rebuilt.length, 62, "L17: the model walk yields 62 lessons");
    const manifestOrder = manifest.units.flatMap((u) => u.lessons.map((l) => l.officialCode));
    eq(rebuilt.map((l) => l.code), manifestOrder, "L17: the model's lesson order equals the manifest's document order");
    ok(
      rebuilt.every((l) => {
        const m = byCode.get(l.code);
        return m && m.titleEn === l.title && m.titleAr === l.titleAr && m.id === l.id;
      }),
      "L17: ids + bilingual titles are identical between manifest and runtime model"
    );
    ok(
      fsSpec.parts[0].units.every((u, i) => {
        const mu = manifest.units[i];
        return u.code === String(mu.officialChapterNumber) && u.order === mu.order && u.title === mu.titleEn && u.titleAr === mu.titleAr && u.icon === null;
      }),
      "L17: units mirror the manifest (code = chapter number, titles, no invented icon)"
    );
    eq(fsSpec.parts[0].synthetic, true, "L17: the model marks its single Part as synthetic");
    eq(
      fsSpec.parts[0].title,
      manifest.part.titleCandidates[0].titleEn,
      "L17: the Part title is the approved candidate (not 'Part 1')"
    );
    ok(
      fsSpec.parts[0].title !== "Part 1" && fsSpec.parts[0].titleAr !== "الجزء الأول",
      "L17: the synthetic Part does not impersonate a Ministry chapter"
    );
    eq(manifest.part.official, false, "L17: the manifest agrees the Part is not official");
    eq(manifest.course.slug, FS_SPEC.courseSlug, "L17: the manifest and the spec agree on the course slug");
    eq(
      [manifest.course.name, manifest.course.nameAr],
      [FS_SPEC.course.name, FS_SPEC.course.nameAr],
      "L17: the manifest and the spec agree on bilingual course names"
    );
    eq(manifest.course.academicLevel, FS_SPEC.academicLevel, "L17: the manifest and the spec agree on the level");
  }

  // -------------------------------------------------------------------------
  console.log(`\nfirst secondary (phase L): ${pass} passed, ${fail} failed`);
  fs.rmSync(OUT, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
