// CodeMind Academy — Seeder safety tests (offline, no database required).
// Compiles src/lib/{registration,curriculum,curriculum-seed}.ts with tsc,
// injects an in-memory mock Prisma client, and verifies:
//   1. First run restores the full curriculum tree (2 parts / 36 lessons).
//   2. Second run creates NOTHING (idempotent, no duplicates).
//   3. Unrelated data (other courses, their parts, other students) is untouched.
//   4. backfillStudentCodes fills ONLY NULL/"" codes with unique valid codes.
//   5. createStudentWithCode survives a forced UNIQUE collision (P2002 retry).
//   6. Partial-seed guard: if parts already exist, content creation is skipped.
//
// Run: node tests/seed-idempotency.test.js
// Exit code: 0 = all pass, 1 = failure.

const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-seed-test-"));

// ---- Compile the three lib files (offline; type errors would fail here) ----
const TSCONFIG = path.join(OUT, "tsconfig.json");
fs.writeFileSync(
  TSCONFIG,
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      typeRoots: [path.join(REPO, "node_modules/@types")],
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/registration.ts"),
      path.join(REPO, "src/lib/curriculum.ts"),
      path.join(REPO, "src/lib/curriculum-seed.ts"),
    ],
  })
);
execSync(`npx tsc -p ${TSCONFIG}`, { cwd: REPO, stdio: "pipe" });

// ---- Redirect @/lib/* imports: db -> mock, curriculum -> compiled ----
const MOCK_DB_PATH = path.join(OUT, "__mock-db__.js");
fs.writeFileSync(MOCK_DB_PATH, "module.exports = { db: global.__MOCK_DB__ };");
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return MOCK_DB_PATH;
  if (request === "@/lib/curriculum")
    return path.join(OUT, "curriculum.js");
  if (request === "@/lib/registration")
    return path.join(OUT, "registration.js");
  return origResolve.call(this, request, ...rest);
};

// ---- In-memory mock Prisma client (enforces UNIQUE like SQLite) ----
function makeMockDb() {
  const tables = {
    course: [],
    part: [],
    unit: [],
    topic: [],
    lesson: [],
    student: [],
  };
  let seq = 1;
  const nid = (p) => `${p}-${seq++}`;
  const p2002 = () => {
    const e = new Error("Unique constraint failed");
    e.code = "P2002";
    return e;
  };

  const db = {
    __tables: tables,
    course: {
      async upsert({ where, update, create }) {
        let row = tables.course.find((c) => c.slug === where.slug);
        if (row) Object.assign(row, update);
        else {
          row = { id: nid("c"), ...create };
          tables.course.push(row);
        }
        return { ...row };
      },
    },
    part: {
      async count({ where }) {
        return tables.part.filter((p) => !where || p.courseId === where.courseId).length;
      },
      async create({ data }) {
        const row = { id: nid("p"), ...data };
        tables.part.push(row);
        return { ...row };
      },
    },
    unit: {
      async create({ data }) {
        const row = { id: nid("u"), ...data };
        tables.unit.push(row);
        return { ...row };
      },
    },
    topic: {
      async create({ data }) {
        const row = { id: nid("t"), ...data };
        tables.topic.push(row);
        return { ...row };
      },
    },
    lesson: {
      async count({ where }) {
        const cid = where?.topic?.unit?.part?.courseId;
        const partIds = new Set(tables.part.filter((p) => p.courseId === cid).map((p) => p.id));
        const unitIds = new Set(tables.unit.filter((u) => partIds.has(u.partId)).map((u) => u.id));
        const topicIds = new Set(tables.topic.filter((t) => unitIds.has(t.unitId)).map((t) => t.id));
        return tables.lesson.filter((l) => topicIds.has(l.topicId)).length;
      },
      async create({ data }) {
        const row = { id: nid("l"), ...data };
        tables.lesson.push(row);
        return { ...row };
      },
    },
    student: {
      async findMany({ where, select }) {
        let rows = tables.student;
        if (where?.OR) {
          rows = rows.filter((s) =>
            where.OR.some((cond) =>
              Object.entries(cond).every(([k, v]) =>
                v === null ? s[k] === null || s[k] === undefined : s[k] === v
              )
            )
          );
        }
        if (select) rows = rows.map((s) => Object.fromEntries(Object.keys(select).map((k) => [k, s[k]])));
        return rows.map((r) => ({ ...r }));
      },
      async findUnique({ where, select }) {
        const key = Object.keys(where)[0];
        const row = tables.student.find((s) => s[key] === where[key]);
        if (!row) return null;
        if (select) return Object.fromEntries(Object.keys(select).map((k) => [k, row[k]]));
        return { ...row };
      },
      async create({ data }) {
        if (data.studentCode != null && tables.student.some((s) => s.studentCode === data.studentCode)) throw p2002();
        if (data.nationalId != null && tables.student.some((s) => s.nationalId === data.nationalId)) throw p2002();
        const row = { id: nid("s"), ...data };
        tables.student.push(row);
        return { ...row };
      },
      async update({ where, data }) {
        const row = tables.student.find((s) => s.id === where.id);
        if (!row) throw new Error("not found");
        if (data.studentCode != null && tables.student.some((s) => s.id !== row.id && s.studentCode === data.studentCode)) throw p2002();
        Object.assign(row, data);
        return { ...row };
      },
    },
  };
  return db;
}

global.__MOCK_DB__ = makeMockDb();
const seed = require(path.join(OUT, "curriculum-seed.js"));
const registration = require(path.join(OUT, "registration.js"));

let pass = 0,
  fail = 0;
const ok = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.error("FAIL:", l);
  }
};

(async () => {
  const db = global.__MOCK_DB__;

  // Seed unrelated production-like data BEFORE running the seeder.
  db.__tables.course.push({ id: "c-other", slug: "other-course", name: "Other", nameAr: "أخرى", description: "x", color: "#000" });
  db.__tables.part.push({ id: "p-other", courseId: "c-other", title: "O", titleAr: "أ", order: 1 });
  db.__tables.student.push(
    { id: "st-1", userId: "u-1", studentCode: null, nationalId: null },
    { id: "st-2", userId: "u-2", studentCode: "", nationalId: null },
    { id: "st-3", userId: "u-3", studentCode: null, nationalId: null },
    { id: "st-4", userId: "u-4", studentCode: "CM-KEEPME", nationalId: "29901010101010" }
  );

  // ---- 1. First run restores full tree ----
  const r1 = await seed.seedCurriculumFromFile(db);
  ok(r1.created === true, "first run reports created=true");
  ok(r1.message.includes("2 parts") && r1.message.includes("36 lessons"), `counts message (${r1.message})`);
  ok(db.__tables.part.filter((p) => p.courseId === r1.courseId).length === 2, "2 parts created");
  ok(db.__tables.unit.length === 7, "7 units created");
  ok(db.__tables.topic.length === 17, "17 topics created");
  ok(db.__tables.lesson.length === 36, "36 lessons created");

  // ---- 2. Second run creates nothing ----
  const before = JSON.stringify(db.__tables);
  const r2 = await seed.seedCurriculumFromFile(db);
  ok(r2.created === false, "second run reports created=false");
  ok(JSON.stringify(db.__tables) === before, "second run changed zero rows");

  // ---- 3. Unrelated data untouched ----
  ok(db.__tables.course.length === 2, "other course still present");
  ok(db.__tables.part.some((p) => p.id === "p-other"), "other course part untouched");

  // ---- 4. Backfill fills only NULL/"" codes ----
  const filled = await seed.backfillStudentCodes(db);
  ok(filled === 3, `backfilled 3 students (got ${filled})`);
  const codes = db.__tables.student.map((s) => s.studentCode);
  ok(new Set(codes).size === 4, "all 4 codes unique");
  ok(codes.every((c) => registration.isValidStudentCode(c)), "all codes match CM-XXXXXX");
  ok(db.__tables.student.find((s) => s.id === "st-4").studentCode === "CM-KEEPME", "pre-existing code never rewritten");
  const filledAgain = await seed.backfillStudentCodes(db);
  ok(filledAgain === 0, "backfill re-run fills 0");

  // ---- 5. Forced UNIQUE collision is retried transparently ----
  const realGen = registration.generateStudentCode;
  let calls = 0;
  const takenCode = db.__tables.student[0].studentCode;
  registration.generateStudentCode = () => (++calls === 1 ? takenCode : realGen());
  // NOTE: curriculum-seed captured the module object, so the stub applies.
  const created = await seed.createStudentWithCode(db, { userId: "u-99" });
  ok(calls >= 2 && registration.isValidStudentCode(created.studentCode), "collision retried with fresh code");
  ok(created.studentCode !== takenCode, "colliding code not reused");
  registration.generateStudentCode = realGen;

  // ---- 6. Partial-seed guard: existing parts => skip creation ----
  const partsBefore = db.__tables.lesson.length;
  const r3 = await seed.seedCurriculumFromFile(db);
  ok(r3.created === false && db.__tables.lesson.length === partsBefore, "partial state never duplicates");

  console.log(`\nseed idempotency: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(1);
});
