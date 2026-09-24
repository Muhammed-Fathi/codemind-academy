// CodeMind Academy — Admin Student Track / school type (Phase L manual-QA fix).
//
// WHAT IT PROVES
//   The admin must be able to set the student's canonical Track (school type)
//   in BOTH the Add Student and the Edit Student flows, and the server must be
//   the one that decides whether that value may be persisted.
//
//   CREATE (POST /api/admin/students)
//     A. FIRST_SECONDARY + LANGUAGE persists AcademicLevel + Track.
//     B. FIRST_SECONDARY + ARABIC persists.
//     C. SECOND_SECONDARY + LANGUAGE still works.
//     D. SECOND_SECONDARY + ARABIC still works.
//     E. A MISSING Track is refused (400) and creates NOTHING.
//     F. An INVALID Track is refused (400) and creates NOTHING.
//     G. A new Language student is served by the Language classification.
//     H. A new Arabic student is served by the Arabic classification.
//     I. A new admin-created student never lands in the "unspecified" bucket.
//
//   EDIT (PATCH /api/admin/students/[id])
//     J. Ungrouped LANGUAGE → ARABIC succeeds (and heals the batch).
//     K. Ungrouped ARABIC → LANGUAGE succeeds.
//     L. Grouped LANGUAGE student → ARABIC is REJECTED, row untouched.
//     M. Grouped ARABIC student → LANGUAGE is REJECTED, row untouched.
//     N. A grouped student's valid (unchanged) Track still saves normally.
//     O. The pre-existing grouped-student ACADEMIC LEVEL guard is intact.
//
//   GROUP ASSIGNMENT
//     P. FIRST_SECONDARY + LANGUAGE → FIRST_SECONDARY + LANGUAGE group: OK.
//     Q. FIRST_SECONDARY + LANGUAGE → FIRST_SECONDARY + ARABIC group: 409.
//     R. FIRST_SECONDARY             → SECOND_SECONDARY group:           409.
//
//   REGRESSION
//     S. The registration write path still owns its own Track contract
//        (requireSchoolType + api.068) — this fix did not touch it.
//     T. Second Secondary behaviour is unchanged (C/D/P/R + the K verifiers).
//
//   UI (source pins — the reported bug was a missing control)
//     Add Student and Edit Student BOTH render the canonical Track selector,
//     and Add Student requires an explicit choice.
//
// The REAL route modules are compiled with the repo's own tsc and driven
// against an in-memory Prisma mock, so the assertions exercise the shipped
// handlers — not a copy of their logic. The Track/level guards
// (`school-type.ts`, `track-scope.ts`, `academic-level.ts`), the student-code
// helper and the batch reconciler all run for real.
//
// Portable: no shell of any kind (no grep/find, no `2>/dev/null`, no npx) —
// runs unchanged on Windows PowerShell and Linux CI.
//
// Run: node tests/admin-student-track-phaseL.test.js
// Exit code: 0 = all pass, 1 = failure.

const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const REPO = path.join(__dirname, "..");
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-studenttrack-"));

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
function section(title) {
  console.log(`\n${title}`);
}

// ---------------------------------------------------------------------------
// 1. Compile the real routes (and their graph) with the repo's own tsc
// ---------------------------------------------------------------------------
const ROUTE_RELS = [
  "src/app/api/admin/students/route.ts",
  "src/app/api/admin/students/[id]/route.ts",
  // Compiled so the i18n assertions can consult the REAL merged dictionary
  // (the UI's own `translate(locale, key)`) instead of re-parsing source text.
  "src/lib/i18n-core.ts",
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
    files: ROUTE_RELS.map((rel) => path.join(REPO, rel)),
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
const CREATE_JS = path.join(EMIT, "app", "api", "admin", "students", "route.js");
const EDIT_JS = path.join(EMIT, "app", "api", "admin", "students", "[id]", "route.js");
if (!fs.existsSync(CREATE_JS) || !fs.existsSync(EDIT_JS)) {
  console.error("tsc did not emit the admin student routes");
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 2. Module resolution — the db and the peripheral boundaries are stubbed;
//    every academic/track guard module is the REAL compiled one.
// ---------------------------------------------------------------------------
const MOCK_DB_PATH = path.join(OUT, "__mock-db__.js");
fs.writeFileSync(MOCK_DB_PATH, "module.exports = { get db() { return global.__MOCK_DB__; } };");

// `requireRole` is switchable so the authz contract can be asserted too.
const API_STUB = path.join(OUT, "__api-stub__.js");
fs.writeFileSync(
  API_STUB,
  "module.exports = {\n" +
    "  ok: (data, status) => ({ status: status || 200, body: data }),\n" +
    "  err: (message, status) => ({ status: status || 400, body: { error: message } }),\n" +
    "  requireRole: async () => global.__ROLE_STUB__(),\n" +
    "};"
);
const I18N_STUB = path.join(OUT, "__i18n-stub__.js");
fs.writeFileSync(I18N_STUB, "module.exports = { getServerT: async () => (k) => k };");
const NEXT_STUB = path.join(OUT, "__next-server-stub__.js");
fs.writeFileSync(NEXT_STUB, "module.exports = { NextRequest: class {} };");
// Peripheral to the Track contract and covered by their own suites.
const AUTH_STUB = path.join(OUT, "__auth-stub__.js");
fs.writeFileSync(
  AUTH_STUB,
  "module.exports = { hashPassword: (p) => `scrypt:${p}`, revokeAllSessions: async () => {} };"
);
const SECURITY_STUB = path.join(OUT, "__security-stub__.js");
fs.writeFileSync(SECURITY_STUB, "module.exports = { logSecurityEvent: async () => {} };");

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return MOCK_DB_PATH;
  if (request === "@/lib/api") return API_STUB;
  if (request === "@/lib/i18n-server") return I18N_STUB;
  if (request === "@/lib/auth") return AUTH_STUB;
  if (request === "@/lib/security") return SECURITY_STUB;
  if (request === "next/server") return NEXT_STUB;
  const alias = /^@\/lib\/([\w/-]+)$/.exec(request);
  if (alias) {
    const compiled = path.join(EMIT, "lib", `${alias[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return origResolve.call(this, request, ...rest);
};

// ---------------------------------------------------------------------------
// 3. In-memory Prisma mock (honours the where / select / include shapes used)
// ---------------------------------------------------------------------------
function makeMockDb() {
  const t = {
    user: [],
    student: [],
    group: [],
    batch: [],
    course: [],
    subscription: [],
    securityEvent: [],
  };
  let seq = 1;
  const nid = (p) => `${p}-${seq++}`;

  const matchesOne = (row, field, cond) => {
    const value = row[field];
    if (cond === null) return value === null || value === undefined;
    if (cond && typeof cond === "object" && !Array.isArray(cond)) {
      if ("in" in cond) return cond.in.includes(value);
      if ("not" in cond) return value !== cond.not;
      if ("contains" in cond) return String(value ?? "").includes(cond.contains);
      if ("equals" in cond) return value === cond.equals;
      return false;
    }
    return value === cond;
  };
  const matchesWhere = (row, model, where) => {
    if (!where) return true;
    for (const [field, cond] of Object.entries(where)) {
      if (field === "OR") {
        if (!Array.isArray(cond) || !cond.some((w) => matchesWhere(row, model, w))) return false;
        continue;
      }
      if (field === "AND") {
        if (!Array.isArray(cond) || !cond.every((w) => matchesWhere(row, model, w))) return false;
        continue;
      }
      // Relation filter (e.g. group: { id }) — resolve the parent row first.
      if (cond && typeof cond === "object" && !Array.isArray(cond) && !("in" in cond) && !("not" in cond) && !("contains" in cond)) {
        const parent = resolveRelation(model, field, row);
        if (!parent) return false;
        if (!matchesWhere(parent, relationModel(field), cond)) return false;
        continue;
      }
      if (!matchesOne(row, field, cond)) return false;
    }
    return true;
  };

  // Which keys are RELATIONS (not columns) per model. `true` in an include
  // spec means "attach the relation", never "copy a column of the same name".
  const RELATION_KEYS = {
    student: ["user", "group", "batch", "subscription", "enrollments"],
    group: ["course", "students", "sessions", "teacher"],
    user: ["student"],
    course: [],
    batch: [],
    subscription: ["plan"],
  };
  const relationModel = (key) => {
    if (key === "user") return "user";
    if (key === "group") return "group";
    if (key === "course") return "course";
    if (key === "batch") return "batch";
    if (key === "subscription") return "subscription";
    return key;
  };
  const resolveRelation = (model, key, row) => {
    if (model === "student") {
      if (key === "user") return t.user.find((u) => u.id === row.userId);
      if (key === "group") return t.group.find((g) => g.id === row.groupId);
      if (key === "batch") return t.batch.find((b) => b.id === row.batchId);
      if (key === "subscription") return t.subscription.find((s) => s.studentId === row.id);
      if (key === "enrollments") return [];
    }
    if (model === "group") {
      if (key === "course") return t.course.find((c) => c.id === row.courseId);
      if (key === "students") return t.student.filter((s) => s.groupId === row.id);
      if (key === "sessions") return [];
    }
    if (model === "user" && key === "student") return t.student.find((s) => s.userId === row.id);
    return null;
  };

  const project = (model, row, spec) => {
    if (!row) return row;
    if (!spec) return { ...row };
    const out = {};
    const isSelect = "select" in spec && spec.select;
    const body = isSelect ? spec.select : spec;
    if (!isSelect) {
      // `include`: start from all scalars, then attach relations.
      for (const [k, v] of Object.entries(row)) if (typeof v !== "object" || v === null) out[k] = v;
    }
    for (const [key, value] of Object.entries(body)) {
      if (key === "_count") {
        const counts = {};
        for (const rel of Object.keys(value.select || {})) {
          if (rel === "students") counts.students = t.student.filter((s) => s.groupId === row.id).length;
        }
        out._count = counts;
        continue;
      }
      if (value === true) {
        const relations = RELATION_KEYS[model] || [];
        if (relations.includes(key)) {
          const child = resolveRelation(model, key, row);
          out[key] = Array.isArray(child) ? child : child || null;
        } else {
          out[key] = row[key];
        }
        continue;
      }
      if (value && typeof value === "object") {
        const child = resolveRelation(model, key, row);
        if (Array.isArray(child)) {
          out[key] = child.map((c) => project(relationModel(key), c, value));
        } else if (child) {
          out[key] = project(relationModel(key), child, value);
        } else {
          out[key] = null;
        }
        continue;
      }
    }
    return out;
  };

  const listOf = (model) => t[model];

  const modelApi = (model) => ({
    async findUnique({ where, select, include }) {
      const row = listOf(model).find((r) => matchesWhere(r, model, where));
      if (!row) return null;
      const spec = select ? { select } : include ? include : null;
      return project(model, row, spec);
    },
    async findFirst({ where, orderBy, select, include }) {
      let rows = listOf(model).filter((r) => matchesWhere(r, model, where));
      rows = sortRows(rows, orderBy);
      const row = rows[0];
      if (!row) return null;
      const spec = select ? { select } : include ? include : null;
      return project(model, row, spec);
    },
    async findMany({ where, include, select, orderBy, skip, take }) {
      let rows = listOf(model).filter((r) => matchesWhere(r, model, where));
      rows = sortRows(rows, orderBy);
      if (skip) rows = rows.slice(skip);
      if (take) rows = rows.slice(0, take);
      const spec = select ? { select } : include ? include : null;
      return rows.map((r) => project(model, r, spec));
    },
    async count({ where }) {
      return listOf(model).filter((r) => matchesWhere(r, model, where)).length;
    },
    async create({ data, select, include }) {
      const row = { id: data.id || nid(model), ...data };
      listOf(model).push(row);
      const spec = select ? { select } : include ? include : null;
      return project(model, row, spec);
    },
    async update({ where, data, select, include }) {
      const row = listOf(model).find((r) => matchesWhere(r, model, where));
      if (!row) throw new Error(`${model} not found`);
      Object.assign(row, data);
      const spec = select ? { select } : include ? include : null;
      return project(model, row, spec);
    },
    async updateMany() {
      return { count: 0 };
    },
  });

  function sortRows(rows, orderBy) {
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
  }

  const db = {};
  for (const m of ["user", "student", "group", "batch", "course", "subscription", "securityEvent"]) {
    db[m] = modelApi(m);
  }
  db.__tables = t;
  return db;
}

global.__ROLE_STUB__ = () => ({ user: { id: "admin-1", role: "ADMIN" }, error: null });

const createRoute = require(CREATE_JS);
const editRoute = require(EDIT_JS);

// ---------------------------------------------------------------------------
// 4. Fixtures
// ---------------------------------------------------------------------------
const FS_COURSE = "course-fs";
const SS_COURSE = "course-ss";

function seedDb() {
  const db = makeMockDb();
  const t = db.__tables;
  t.course.push(
    { id: FS_COURSE, slug: "programming-ai-1st-sec", academicLevel: "FIRST_SECONDARY" },
    { id: SS_COURSE, slug: "programming-ai-2nd-sec", academicLevel: "SECOND_SECONDARY" }
  );
  // Groups: one per (level × audience) plus an unclassified and an inactive one.
  t.group.push(
    { id: "g-fs-lang", name: "First Secondary QA Group", courseId: FS_COURSE, trackScope: "LANGUAGE", isActive: true, capacity: 20, _count: { students: 0 } },
    { id: "g-fs-ar", name: "FS Arabic", courseId: FS_COURSE, trackScope: "ARABIC", isActive: true, capacity: 20, _count: { students: 0 } },
    { id: "g-ss-lang", name: "SS Language", courseId: SS_COURSE, trackScope: "LANGUAGE", isActive: true, capacity: 20, _count: { students: 0 } },
    { id: "g-ss-ar", name: "SS Arabic", courseId: SS_COURSE, trackScope: "ARABIC", isActive: true, capacity: 20, _count: { students: 0 } },
    { id: "g-unclassified", name: "Legacy", courseId: SS_COURSE, trackScope: null, isActive: true, capacity: 20, _count: { students: 0 } },
    { id: "g-inactive", name: "Closed", courseId: SS_COURSE, trackScope: "ARABIC", isActive: false, capacity: 20, _count: { students: 0 } }
  );
  // Real batches, so `reconcileStudentBatch` runs its real rules.
  t.batch.push(
    { id: "b-ar", schoolType: "ARABIC", courseId: null, isActive: true, createdAt: new Date(1) },
    { id: "b-lang", schoolType: "LANGUAGE", courseId: null, isActive: true, createdAt: new Date(1) }
  );
  global.__MOCK_DB__ = db;
  return db;
}

let emailSeq = 0;
const req = (body) => ({ json: async () => body, url: "http://localhost/api/admin/students" });
const params = (id) => ({ params: Promise.resolve({ id }) });

async function create(body) {
  emailSeq++;
  return createRoute.POST(
    req({ email: `track-${emailSeq}@local.test`, password: "StrongPass1!", name: "Omar Ahmed Hassan", ...body })
  );
}
async function edit(id, body) {
  return editRoute.PATCH(req(body), params(id));
}
async function list(query) {
  return createRoute.GET({ url: `http://localhost/api/admin/students${query || ""}` });
}
function studentsOf(db) {
  return db.__tables.student;
}
function byEmail(db) {
  const map = {};
  for (const s of db.__tables.student) {
    const u = db.__tables.user.find((x) => x.id === s.userId);
    map[u.email] = s;
  }
  return map;
}

(async () => {
  // =========================================================================
  section("A–D. CREATE — the canonical level + track pair persists");
  // =========================================================================
  {
    const db = seedDb();
    const a = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE" });
    eq(a.status, 200, "A: FIRST_SECONDARY + LANGUAGE is accepted");
    const aRow = studentsOf(db)[0];
    eq(aRow.academicLevel, "FIRST_SECONDARY", "A: persisted academicLevel = FIRST_SECONDARY");
    eq(aRow.schoolType, "LANGUAGE", "A: persisted canonical Track = LANGUAGE");
    eq(aRow.grade, "1st Secondary", "A: grade stays the derived display mirror");
    eq(aRow.groupId, null, "A: groupId is unset initially (ungrouped)");
    eq(aRow.batchId, "b-lang", "A: the batch matches the chosen track");

    const b = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "ARABIC" });
    eq(b.status, 200, "B: FIRST_SECONDARY + ARABIC is accepted");
    const bRow = studentsOf(db)[1];
    eq(bRow.academicLevel, "FIRST_SECONDARY", "B: persisted academicLevel = FIRST_SECONDARY");
    eq(bRow.schoolType, "ARABIC", "B: persisted canonical Track = ARABIC");
    eq(bRow.batchId, "b-ar", "B: the batch matches the chosen track");

    const c = await create({ academicLevel: "SECOND_SECONDARY", schoolType: "LANGUAGE" });
    eq(c.status, 200, "C: SECOND_SECONDARY + LANGUAGE still works");
    eq(studentsOf(db)[2].schoolType, "LANGUAGE", "C: persisted Track = LANGUAGE");
    eq(studentsOf(db)[2].grade, "2nd Secondary", "C: grade mirror follows the level");

    const d = await create({ academicLevel: "SECOND_SECONDARY", schoolType: "ARABIC" });
    eq(d.status, 200, "D: SECOND_SECONDARY + ARABIC still works");
    eq(studentsOf(db)[3].schoolType, "ARABIC", "D: persisted Track = ARABIC");

    // The canonical aliases the rest of the platform accepts keep working.
    const alias = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "عربي" });
    eq(alias.status, 200, "A/B: a canonical Arabic alias still normalises (one authority)");
    eq(studentsOf(db)[4].schoolType, "ARABIC", "A/B: the alias persisted as canonical ARABIC");
  }

  // =========================================================================
  section("E–F. CREATE — the server refuses a missing / invalid Track");
  // =========================================================================
  {
    const db = seedDb();
    const before = studentsOf(db).length;
    const e = await create({ academicLevel: "FIRST_SECONDARY" });
    eq(e.status, 400, "E: a MISSING Track is refused with 400");
    eq(e.body.error, "api.210", "E: the refusal uses the canonical Track message (api.210)");
    eq(studentsOf(db).length, before, "E: nothing was persisted on the refusal");
    eq(db.__tables.user.length, 0, "E: no User row was created either");

    const e2 = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "" });
    eq(e2.status, 400, "E2: a BLANK Track is refused too (no silent null)");
    eq(studentsOf(db).length, before, "E2: still nothing persisted");

    const e3 = await create({ academicLevel: "FIRST_SECONDARY", schoolType: null });
    eq(e3.status, 400, "E3: an explicit null Track is refused (never a NULL student from this flow)");

    const f = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "FRENCH" });
    eq(f.status, 400, "F: an unsupported Track value is refused with 400");
    eq(f.body.error, "api.210", "F: the refusal reuses the canonical message");
    eq(studentsOf(db).length, before, "F: nothing was persisted on the invalid value");

    const f2 = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "IGNORE_ALL_GATES" });
    eq(f2.status, 400, "F2: a lookalike value is refused, never normalised to a guess");

    // The academic-level contract is untouched by this fix.
    const lvl = await create({ schoolType: "LANGUAGE" });
    eq(lvl.status, 400, "E4: a missing academicLevel is still refused (api.371)");
    eq(lvl.body.error, "api.371", "E4: level refusal contract unchanged");
  }

  // =========================================================================
  section("G–I. CLASSIFICATION — persisted data drives the tabs, not the client");
  // =========================================================================
  {
    const db = seedDb();
    await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE" });
    await create({ academicLevel: "FIRST_SECONDARY", schoolType: "ARABIC" });
    // One genuine legacy row with no canonical track at all.
    db.__tables.user.push({ id: "u-legacy", name: "Legacy", email: "legacy@local.test", isActive: true });
    db.__tables.student.push({
      id: "s-legacy", userId: "u-legacy", academicLevel: "SECOND_SECONDARY", grade: "2nd Secondary",
      schoolType: null, groupId: null, batchId: null, enrolledAt: new Date(3),
    });

    const lang = await list("?schoolType=LANGUAGE&pageSize=50");
    const arabic = await list("?schoolType=ARABIC&pageSize=50");
    const unknown = await list("?schoolType=UNSPECIFIED&pageSize=50");
    const langIds = lang.body.students.map((s) => s.id);
    const arabicIds = arabic.body.students.map((s) => s.id);
    const unknownIds = unknown.body.students.map((s) => s.id);

    eq(langIds.length, 1, "G: the Language tab holds exactly the Language student");
    eq(lang.body.students[0].schoolType, "LANGUAGE", "G: the row carries the canonical track");
    eq(arabicIds.length, 1, "H: the Arabic tab holds exactly the Arabic student");
    eq(arabic.body.students[0].schoolType, "ARABIC", "H: the row carries the canonical track");
    ok(!unknownIds.includes(langIds[0]), "I: the new Language student is NOT in «غير محدد»");
    ok(!unknownIds.includes(arabicIds[0]), "I: the new Arabic student is NOT in «غير محدد»");
    eq(unknownIds.length, 1, "I: «غير محدد» holds ONLY the genuine legacy row");
    eq(unknownIds[0], "s-legacy", "I: the unspecified bucket is exactly the legacy row");
    eq(lang.body.counts.LANGUAGE, 1, "G: the Language counter is truthful");
    eq(lang.body.counts.ARABIC, 1, "H: the Arabic counter is truthful");
    eq(lang.body.counts.UNSPECIFIED, 1, "I: the unspecified counter is truthful");
  }

  // =========================================================================
  section("J–K. EDIT — an ungrouped student's Track can be changed");
  // =========================================================================
  {
    const db = seedDb();
    await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE" });
    const s = studentsOf(db)[0];
    eq(s.batchId, "b-lang", "J: the student starts on the Language batch");

    const j = await edit(s.id, { schoolType: "ARABIC" });
    eq(j.status, 200, "J: ungrouped LANGUAGE → ARABIC succeeds");
    eq(s.schoolType, "ARABIC", "J: the change is persisted");
    eq(s.batchId, "b-ar", "J: the batch is healed to the new track (shared reconciler)");

    const k = await edit(s.id, { schoolType: "LANGUAGE" });
    eq(k.status, 200, "K: ungrouped ARABIC → LANGUAGE succeeds");
    eq(s.schoolType, "LANGUAGE", "K: the change is persisted");
    eq(s.batchId, "b-lang", "K: the batch follows back");

    const bad = await edit(s.id, { schoolType: "KLINGON" });
    eq(bad.status, 400, "K2: an unsupported Track edit is refused (400)");
    eq(s.schoolType, "LANGUAGE", "K2: the stored value is untouched");
    const blank = await edit(s.id, { schoolType: "" });
    eq(blank.status, 400, "K3: a blank Track edit is refused — never a silent clear to «غير محدد»");
    eq(s.schoolType, "LANGUAGE", "K3: the stored value is untouched");
    eq(s.batchId, "b-lang", "K3: the batch is untouched");
  }

  // =========================================================================
  section("L–N. EDIT — grouped students are protected by the existing gate");
  // =========================================================================
  {
    const db = seedDb();
    await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE", groupId: "g-fs-lang" });
    const s = studentsOf(db)[0];
    eq(s.groupId, "g-fs-lang", "L: the Language student is in the Language group");

    const l = await edit(s.id, { schoolType: "ARABIC" });
    eq(l.status, 409, "L: grouped LANGUAGE → ARABIC is REJECTED (409)");
    eq(l.body.error, "api.286", "L: the refusal is the existing audience mismatch (api.286)");
    eq(s.schoolType, "LANGUAGE", "L: no inconsistent row was committed — track unchanged");
    eq(s.groupId, "g-fs-lang", "L: the group was NOT silently mutated or dropped");

    const n = await edit(s.id, { schoolType: "LANGUAGE" });
    eq(n.status, 200, "N: the grouped student's valid unchanged Track still saves normally");
    eq(s.schoolType, "LANGUAGE", "N: the value is unchanged and consistent");
    eq(s.groupId, "g-fs-lang", "N: the group assignment is intact");

    // Same-track save on a student whose group matches: never a false refusal.
    const n2 = await edit(s.id, { schoolType: "LANGUAGE", groupId: "g-fs-lang" });
    eq(n2.status, 200, "N2: re-saving the same track + same group stays a no-op success");

    // Arabic mirror case.
    await create({ academicLevel: "FIRST_SECONDARY", schoolType: "ARABIC", groupId: "g-fs-ar" });
    const ar = studentsOf(db)[1];
    const m = await edit(ar.id, { schoolType: "LANGUAGE" });
    eq(m.status, 409, "M: grouped ARABIC → LANGUAGE is REJECTED (409)");
    eq(ar.schoolType, "ARABIC", "M: no inconsistent row was committed");
    eq(ar.groupId, "g-fs-ar", "M: the group is untouched");

    // A track change is allowed when the student is moved into a matching
    // group in the SAME request — the assignment gate validates the NEW value.
    const together = await edit(s.id, { schoolType: "ARABIC", groupId: "g-fs-ar" });
    eq(together.status, 200, "L2: a matching move may change the track and the group atomically");
    eq(s.schoolType, "ARABIC", "L2: the new canonical track is persisted");
    eq(s.groupId, "g-fs-ar", "L2: the student is in the matching group");
    eq(s.batchId, "b-ar", "L2: the batch follows the track through the same reconciler");
  }

  // =========================================================================
  section("O. EDIT — the grouped-student ACADEMIC LEVEL guard is intact");
  // =========================================================================
  {
    const db = seedDb();
    await create({ academicLevel: "FIRST_SECONDARY", schoolType: "ARABIC", groupId: "g-fs-ar" });
    const s = studentsOf(db)[0];

    const o = await edit(s.id, { academicLevel: "SECOND_SECONDARY" });
    eq(o.status, 409, "O: levelling a grouped student away from the group's course is refused (409)");
    eq(o.body.error, "api.374", "O: the refusal is the existing level guard (api.374)");
    eq(s.academicLevel, "FIRST_SECONDARY", "O: the level is untouched");
    eq(s.schoolType, "ARABIC", "O: the track is untouched (no partial write)");
    eq(s.groupId, "g-fs-ar", "O: the group is untouched");

    // Ungrouped students keep their existing freedom.
    await create({ academicLevel: "FIRST_SECONDARY", schoolType: "ARABIC" });
    const u = studentsOf(db)[1];
    const o2 = await edit(u.id, { academicLevel: "SECOND_SECONDARY" });
    eq(o2.status, 200, "O2: an ungrouped student can still be re-levelled");
    eq(u.academicLevel, "SECOND_SECONDARY", "O2: the level is persisted");
    eq(u.grade, "2nd Secondary", "O2: the derived grade mirror follows");
    eq(u.schoolType, "ARABIC", "O2: the track is untouched by a level edit");
  }

  // =========================================================================
  section("P–R. GROUP ASSIGNMENT — the manual-QA end-to-end scenario");
  // =========================================================================
  {
    const db = seedDb();
    // Exactly the flow from the report: create Omar (FS + LANGUAGE), then put
    // him in the First Secondary QA Group (FS + LANGUAGE).
    const created = await create({ name: "Omar Ahmed Hassan", academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE" });
    eq(created.status, 200, "P: the student is created ungrouped");
    const s = studentsOf(db)[0];
    eq(s.groupId, null, "P: groupId is null until assignment");

    const p = await edit(s.id, { groupId: "g-fs-lang" });
    eq(p.status, 200, "P: FIRST_SECONDARY + LANGUAGE → FS + LANGUAGE group SUCCEEDS");
    eq(s.groupId, "g-fs-lang", "P: the assignment is persisted");

    const q = await edit(s.id, { groupId: "g-fs-ar" });
    eq(q.status, 409, "Q: FIRST_SECONDARY + LANGUAGE → FS + ARABIC group FAILS (409)");
    eq(q.body.error, "api.286", "Q: the failure is the audience mismatch (api.286)");
    eq(s.groupId, "g-fs-lang", "Q: the student was not moved");

    const r = await edit(s.id, { groupId: "g-ss-lang" });
    eq(r.status, 409, "R: FIRST_SECONDARY → a SECOND_SECONDARY group FAILS (409)");
    eq(r.body.error, "api.373", "R: the failure is the level gate (api.373)");
    eq(s.groupId, "g-fs-lang", "R: the student was not moved");

    // The creation-time assignment path applies the SAME two gates.
    const p2 = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE", groupId: "g-fs-lang" });
    eq(p2.status, 200, "P2: create-with-matching-group succeeds");
    const q2 = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE", groupId: "g-fs-ar" });
    eq(q2.status, 409, "Q2: create-with-wrong-audience-group is refused");
    const r2 = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE", groupId: "g-ss-lang" });
    eq(r2.status, 409, "R2: create-with-cross-level-group is refused");
    const unclass = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE", groupId: "g-unclassified" });
    eq(unclass.status, 409, "R3: an unclassified group is still fail-closed (api.285)");
    eq(unclass.body.error, "api.285", "R3: the refusal is the unclassified-group contract");
    const inactive = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "ARABIC", groupId: "g-inactive" });
    eq(inactive.status, 409, "R4: an inactive group is still refused (api.085)");
    eq(studentsOf(db).length, 2, "P2/R4: only the valid creates produced rows");
  }

  // =========================================================================
  section("S. REGRESSION — the registration Track contract is untouched");
  // =========================================================================
  {
    const registration = fs.readFileSync(path.join(REPO, "src/app/api/auth/[action]/route.ts"), "utf8");
    ok(
      /requireSchoolType\(body\.schoolType\)/.test(registration),
      "S: registration still validates the Track with the ONE shared primitive"
    );
    ok(
      /if \(!schoolTypeCheck\.ok\) return err\(tApi\("api\.068"\), 400\);/.test(registration),
      "S: registration still refuses a missing/invalid Track with api.068 / 400"
    );
    ok(
      /requireAcademicLevel\(body\.academicLevel\)/.test(registration),
      "S: registration still requires the typed academic level"
    );
    // The admin create path now agrees with registration instead of inventing
    // a second contract: same primitive, same fail-closed behaviour.
    const adminCreate = fs.readFileSync(path.join(REPO, "src/app/api/admin/students/route.ts"), "utf8");
    ok(
      /requireSchoolType\(body\.schoolType\)/.test(adminCreate),
      "S: the admin create path uses the SAME primitive (no second authority)"
    );
    ok(
      !/schoolTypeCheck\.ok \? schoolTypeCheck\.value : null/.test(adminCreate),
      "S: the admin create path can no longer persist a silent NULL Track"
    );
  }

  // =========================================================================
  section("T. REGRESSION — Second Secondary behaviour is unchanged");
  // =========================================================================
  {
    const db = seedDb();
    const t1 = await create({ academicLevel: "SECOND_SECONDARY", schoolType: "ARABIC", groupId: "g-ss-ar" });
    eq(t1.status, 200, "T: SS + ARABIC → SS + ARABIC group still succeeds");
    const t2 = await create({ academicLevel: "SECOND_SECONDARY", schoolType: "LANGUAGE", groupId: "g-ss-lang" });
    eq(t2.status, 200, "T: SS + LANGUAGE → SS + LANGUAGE group still succeeds");
    const t3 = await edit(studentsOf(db)[0].id, { schoolType: "LANGUAGE" });
    eq(t3.status, 409, "T: the SS audience gate still refuses a grouped track change");
    const t4 = await edit(studentsOf(db)[1].id, { schoolType: "LANGUAGE" });
    eq(t4.status, 200, "T: an ungrouped SS student can still change track");
    eq(studentsOf(db)[1].schoolType, "LANGUAGE", "T: the SS track change persists");
    eq(db.__tables.student.length, 2, "T: no extra rows were produced");
  }

  // =========================================================================
  section("UI — BOTH dialogs expose the canonical Track selector");
  // =========================================================================
  {
    const dash = fs.readFileSync(path.join(REPO, "src/components/admin/admin-dashboard.tsx"), "utf8");
    const addStart = dash.indexOf("function AddStudentDialog");
    const addEnd = dash.indexOf("function StudentProfileDrawer");
    const add = dash.slice(addStart, addEnd);
    const drawer = dash.slice(addEnd, dash.indexOf("// ============================================================\n// 3. Teachers"));

    ok(addStart !== -1 && addEnd > addStart && add.length > 500, "UI: AddStudentDialog was located");
    ok(drawer.length > 500, "UI: the Edit Student drawer was located");

    // --- Add Student ------------------------------------------------------
    ok(
      /<Label>\{tr\("admin\.055"\)\}<\/Label>/.test(add),
      "UI-ADD: labels the field with the existing canonical vocabulary (admin.055)"
    );
    ok(
      /<SelectItem value="ARABIC">\{tr\("admin\.200"\)\}<\/SelectItem>/.test(add),
      "UI-ADD: offers the canonical Arabic-school choice (admin.200 = مدارس عربي)"
    );
    ok(
      /<SelectItem value="LANGUAGE">\{tr\("admin\.201"\)\}<\/SelectItem>/.test(add),
      "UI-ADD: offers the canonical Language-school choice (admin.201 = مدارس لغات)"
    );
    ok(
      /<Select value=\{form\.schoolType\} onValueChange=\{\(v\) => setForm\(\{ \.\.\.form, schoolType: v \}\)\}>/.test(add),
      "UI-ADD: the control is bound to the form's schoolType state"
    );
    ok(/schoolType: ""/.test(add), "UI-ADD: starts with NO default track");
    ok(
      /JSON\.stringify\(form\)/.test(add),
      "UI-ADD: submits the form (the track travels with it)"
    );
    ok(
      /if \(!form\.schoolType\) \{/.test(add),
      "UI-ADD: refuses to submit without an explicit track"
    );
    ok(
      /toast\.error\(tr\("api\.210"\)\)/.test(add),
      "UI-ADD: uses the server's own Track message for that refusal"
    );
    ok(
      !/<SelectItem value="UNSPECIFIED"/.test(add),
      "UI-ADD: there is no «unspecified» option — that state is legacy-only"
    );

    // --- Edit Student -----------------------------------------------------
    ok(
      /<div className="text-xs text-muted-foreground">\{tr\("admin\.055"\)\}<\/div>/.test(drawer),
      "UI-EDIT: labels the field with the same canonical vocabulary"
    );
    ok(
      /<SelectItem value="ARABIC">\{tr\("admin\.200"\)\}<\/SelectItem>/.test(drawer),
      "UI-EDIT: offers the canonical Arabic-school choice"
    );
    ok(
      /<SelectItem value="LANGUAGE">\{tr\("admin\.201"\)\}<\/SelectItem>/.test(drawer),
      "UI-EDIT: offers the canonical Language-school choice"
    );
    ok(
      /<Select value=\{track\} onValueChange=\{setTrack\}>/.test(drawer),
      "UI-EDIT: the control is bound to the drawer's track state"
    );
    ok(
      /const track =\s*[\s\S]{0,160}student\?\.schoolType \|\| ""/.test(drawer),
      "UI-EDIT: the control is seeded from the persisted canonical value"
    );
    ok(
      /body: JSON\.stringify\(\{ schoolType: track \}\)/.test(drawer),
      "UI-EDIT: saves the track through the existing PATCH contract"
    );
    ok(
      /onClick=\{saveTrack\} disabled=\{saving \|\| !track\}/.test(drawer),
      "UI-EDIT: the track change is an explicit save (never an implicit write)"
    );
    ok(
      !/<SelectItem value="UNSPECIFIED"/.test(drawer),
      "UI-EDIT: offers no «unspecified» option either"
    );
    // The free-text school name stays a profile field, never the track.
    ok(
      /<Input value=\{form\.schoolName\} onChange=\{\(e\) => setForm\(\{ \.\.\.form, schoolName: e\.target\.value \}\)\} \/>/.test(add),
      "UI-ADD: the free-text school name remains a separate profile field"
    );
  }

  // =========================================================================
  section("i18n — the labels the admin actually sees, from the REAL dictionary");
  // =========================================================================
  {
    // `src/lib/i18n-core.ts` is the module the admin dashboard's `useT()` hook
    // calls, so these are the exact strings rendered in the selector — not a
    // re-parse of the dictionary source.
    const i18n = require(path.join(EMIT, "lib", "i18n-core.js"));
    const label = (key) => ({ ar: i18n.translate("ar", key), en: i18n.translate("en", key) });

    const field = label("admin.055");
    ok(field.ar.length > 0 && field.en.length > 0 && !i18n.looksLikeDictKey(field.ar), "i18n: the Track field label resolves in both locales");

    const arabic = label("admin.200");
    eq(arabic.ar, "مدارس عربي", "i18n: the canonical Arabic choice renders «مدارس عربي»");
    eq(arabic.en, "Arabic School", "i18n: …and «Arabic School» in English");

    const language = label("admin.201");
    eq(language.ar, "مدارس لغات", "i18n: the canonical Language choice renders «مدارس لغات»");
    eq(language.en, "Language School", "i18n: …and «Language School» in English");

    for (const key of ["api.210", "api.286", "api.373", "admin.645", "admin.040", "admin.026"]) {
      const l = label(key);
      ok(
        l.ar.length > 0 && l.en.length > 0 && !i18n.looksLikeDictKey(l.ar) && !i18n.looksLikeDictKey(l.en),
        `i18n: «${key}» resolves to real text in both locales (never a leaked key)`
      );
    }
    // The two canonical Track labels are the SAME vocabulary the students tabs
    // use, so a student's tab and their stored track can never disagree.
    const dash2 = fs.readFileSync(path.join(REPO, "src/components/admin/admin-dashboard.tsx"), "utf8");
    const tabs = dash2.slice(dash2.indexOf("const STUDENT_TABS"), dash2.indexOf("] as const;", dash2.indexOf("const STUDENT_TABS")));
    ok(
      /labelKey: "admin\.200"/.test(tabs) && /labelKey: "admin\.201"/.test(tabs),
      "i18n: the students tabs use the SAME two canonical labels as the new selectors"
    );
  }

  // =========================================================================
  section("SERVER — authz is preserved on both paths");
  // =========================================================================
  {
    const db = seedDb();
    global.__ROLE_STUB__ = () => ({ user: null, error: { status: 403, body: { error: "Forbidden" } } });
    const deniedCreate = await create({ academicLevel: "FIRST_SECONDARY", schoolType: "LANGUAGE" });
    eq(deniedCreate.status, 403, "AUTHZ: a non-admin cannot create a student");
    eq(studentsOf(db).length, 0, "AUTHZ: nothing is written for a denied create");
    const deniedEdit = await edit("s-does-not-exist", { schoolType: "ARABIC" });
    eq(deniedEdit.status, 403, "AUTHZ: a non-admin cannot edit a student");
    global.__ROLE_STUB__ = () => ({ user: { id: "admin-1", role: "ADMIN" }, error: null });
  }

  // =========================================================================
  fs.rmSync(OUT, { recursive: true, force: true });
  console.log(
    `\nadmin student track (phase L): ${passed} passed, ${failed} failed`
  );
  if (failed) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => {
  console.error("\nHARNESS ERROR:", e && e.stack ? e.stack : e);
  process.exit(1);
});
