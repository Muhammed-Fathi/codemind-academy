// CodeMind Academy — Phase K3: final academic-level constraints at the DB.
//
//   A. SOURCE-LEVEL INVARIANTS — both Prisma schemas declare the three
//      academicLevel columns and MockExam.courseId REQUIRED, Lesson carries
//      @@unique([academicLevel, officialCode]) and no global officialCode
//      unique; the SQLite and PostgreSQL K3 migrations exist with the same
//      name, carry the seven named guards, never UPDATE/DELETE application
//      rows, and the PG twin is provider-safe (no SQLite-only syntax); the
//      derived PG baseline matches the schema (make-postgres-schema --check);
//      the migration chain lengths are 21 (SQLite) / 11 (PostgreSQL); every
//      officialCode lookup in shipped code is level-scoped; the K2 runtime
//      gates are untouched.
//   B. THE MASTER GATE — scripts/verify-k3-academic-level.mjs applies the
//      real chain, rehearses K3 over the real seed + every preserved data
//      class, proves each guard aborts without touching a row, and prints
//      PHASE_K3_ACADEMIC_LEVEL_OK.
//
// Run: node tests/academic-level-phaseK3.test.js
// Exit code: 0 = all pass, 1 = failure. Requires Node >= 22 (node:sqlite).

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

let pass = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    failures.push(label);
    console.error("FAIL:", label);
  }
};
const section = (t) => console.log(`\n${t}`);
const block = (schema, model) => {
  const m = new RegExp(`\\nmodel ${model} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  return m ? m[1] : "";
};

const K3 = "20260923180000_k3_academic_level_constraints";
const GUARDS = [
  "K3_G1_course_academicLevel_null",
  "K3_G2_student_academicLevel_null",
  "K3_G3_lesson_academicLevel_null",
  "K3_G4_lesson_level_chain_mismatch",
  "K3_G5_grouped_student_level_mismatch",
  "K3_G6_mockexam_courseId_null",
  "K3_G7_lesson_level_code_duplicate",
];

// ---------------------------------------------------------------------------
section("K3-A1. Prisma intent — both schemas");
for (const rel of ["prisma/schema.prisma", "prisma/postgres/schema.prisma"]) {
  const s = read(rel);
  ok(/academicLevel\s+AcademicLevel\s*$/m.test(block(s, "Course")), `${rel}: Course.academicLevel required`);
  ok(/academicLevel\s+AcademicLevel\s*$/m.test(block(s, "Student")), `${rel}: Student.academicLevel required`);
  ok(/academicLevel\s+AcademicLevel\s*$/m.test(block(s, "Lesson")), `${rel}: Lesson.academicLevel required`);
  ok(/officialCode\s+String\?\s*$/m.test(block(s, "Lesson")) && !/officialCode\s+String\??\s+@unique/.test(block(s, "Lesson")), `${rel}: Lesson.officialCode has no global @unique`);
  ok(/@@unique\(\[academicLevel, officialCode\]\)/.test(block(s, "Lesson")), `${rel}: Lesson @@unique([academicLevel, officialCode])`);
  ok(/courseId\s+String\s*$/m.test(block(s, "MockExam")) && /course\s+Course\s+@relation\(fields: \[courseId\], references: \[id\]/.test(block(s, "MockExam")), `${rel}: MockExam.courseId / course required`);
  ok(!/onDelete: SetNull/.test(block(s, "MockExam")), `${rel}: MockExam.course no longer SetNull`);
  ok(/@@index\(\[courseId\]\)/.test(block(s, "MockExam")), `${rel}: MockExam @@index([courseId])`);
  ok(!/courseId/.test(block(s, "Lesson")), `${rel}: no Lesson.courseId`);
  ok(!/academicLevel/.test(block(s, "Group")) && !/academicLevel/.test(block(s, "Teacher")), `${rel}: no Group/Teacher academicLevel`);
}

// ---------------------------------------------------------------------------
section("K3-A2. Migrations — both providers, same name, guards, no data rewrite");
const sqliteMig = `prisma/migrations/${K3}/migration.sql`;
const pgMig = `prisma/postgres/migrations/${K3}/migration.sql`;
ok(exists(sqliteMig) && exists(pgMig), "K3 migration exists for SQLite and PostgreSQL under the same name");
for (const rel of [sqliteMig, pgMig]) {
  const sql = read(rel);
  const body = sql.replace(/--[^\n]*/g, "");
  for (const g of GUARDS) ok(sql.includes(`CONSTRAINT "${g}" CHECK`), `${rel}: named guard ${g}`);
  ok(!/\bUPDATE\s+"/i.test(body) && !/\bDELETE\s+FROM\s+"(?!_k3_guard)/i.test(body) && !/\bTRUNCATE\b/i.test(body), `${rel}: no UPDATE/DELETE/TRUNCATE of application rows`);
  ok(/(CREATE UNIQUE INDEX "Lesson_academicLevel_officialCode_key" ON "Lesson"|ADD CONSTRAINT "Lesson_academicLevel_officialCode_key" UNIQUE)\s*\("academicLevel",\s*"officialCode"\)/.test(body), `${rel}: creates Lesson_academicLevel_officialCode_key (academicLevel, officialCode)`);
  ok(!/CREATE UNIQUE INDEX "Lesson_officialCode_key"/.test(body), `${rel}: never re-creates the global Lesson_officialCode_key`);
  ok(/MockExam_courseId_idx/.test(body), `${rel}: creates MockExam_courseId_idx`);
  ok(/ON DELETE RESTRICT/.test(body), `${rel}: MockExam.courseId FK ON DELETE RESTRICT`);
  ok(!/FIRST_SECONDARY/.test(body.replace(/\bacademicLevel\b/g, "")) || !/INSERT INTO "(Course|Lesson|Part|Unit|Student)"/.test(body), `${rel}: no First Secondary curriculum rows inserted`);
}
{
  const sql = read(sqliteMig);
  ok(/PRAGMA foreign_keys=OFF/.test(sql) && /PRAGMA foreign_keys=ON/.test(sql) && /PRAGMA defer_foreign_keys=ON/.test(sql), "SQLite K3: RedefineTables rebuild toggles FK enforcement around the rebuild");
  for (const t of ["Course", "Student", "Lesson", "MockExam"]) {
    ok(new RegExp(`CREATE TABLE "new_${t}"`).test(sql) && new RegExp(`INSERT INTO "new_${t}"`).test(sql) && new RegExp(`DROP TABLE "${t}"`).test(sql) && new RegExp(`ALTER TABLE "new_${t}" RENAME TO "${t}"`).test(sql), `SQLite K3: ${t} rebuilt via new_${t} copy → drop → rename`);
  }
  const body = sql.replace(/--[^\n]*/g, "");
  ok(/ALTER TABLE "Course" ALTER COLUMN "academicLevel" SET NOT NULL/.test(read(pgMig)), "PG K3: Course SET NOT NULL");
  ok(/ALTER TABLE "Student" ALTER COLUMN "academicLevel" SET NOT NULL/.test(read(pgMig)), "PG K3: Student SET NOT NULL");
  ok(/ALTER TABLE "Lesson" ALTER COLUMN "academicLevel" SET NOT NULL/.test(read(pgMig)), "PG K3: Lesson SET NOT NULL");
  ok(/ALTER TABLE "MockExam" ALTER COLUMN "courseId" SET NOT NULL/.test(read(pgMig)), "PG K3: MockExam.courseId SET NOT NULL");
  const pg = read(pgMig).replace(/--[^\n]*/g, "");
  ok(!/\bDATETIME\b|AUTOINCREMENT|PRAGMA|`/.test(pg), "PG K3: no SQLite-only syntax");
  ok(!/CREATE TABLE "new_/.test(pg), "PG K3: no table rebuild (in-place ALTERs)");
  ok(/DROP CONSTRAINT IF EXISTS "Lesson_officialCode_key"/.test(pg) && /DROP INDEX IF EXISTS "Lesson_officialCode_key"/.test(pg), "PG K3: drops ONLY the old global unique, in both physical forms");
  void body;
}
{
  const s = fs.readdirSync(path.join(REPO, "prisma", "migrations")).filter((d) => /^\d{14}_/.test(d)).sort();
  const p = fs.readdirSync(path.join(REPO, "prisma", "postgres", "migrations")).filter((d) => d === "0_init" || /^\d{14}_/.test(d)).sort();
  ok(s.length === 21 && s[s.length - 1] === K3, `SQLite chain is 21 migrations ending in K3 (got ${s.length})`);
  ok(p.length === 11 && p[p.length - 1] === K3, `PostgreSQL chain is 11 migrations (0_init + 10) ending in K3 (got ${p.length})`);
}

// ---------------------------------------------------------------------------
section("K3-A3. Derived PostgreSQL schema + baseline are current");
{
  const r = spawnSync(process.execPath, [path.join(REPO, "scripts", "db", "make-postgres-schema.mjs"), "--check"], { cwd: REPO, encoding: "utf8" });
  ok(r.status === 0, `make-postgres-schema --check passes (exit ${r.status}) ${(r.stderr || "").slice(0, 200)}`);
  const base = read("scripts/db/postgres-baseline.sql");
  ok(/"Lesson_academicLevel_officialCode_key" UNIQUE \("academicLevel", "officialCode"\)/.test(base) && !/Lesson_officialCode_key/.test(base), "baseline: composite unique, no global officialCode key");
  ok(/CREATE INDEX "MockExam_courseId_idx"/.test(base), "baseline: MockExam_courseId_idx");
  ok(/"MockExam_courseId_fkey" FOREIGN KEY \("courseId"\) REFERENCES "Course" \("id"\) ON UPDATE CASCADE ON DELETE RESTRICT/.test(base), "baseline: MockExam FK RESTRICT");
}

// ---------------------------------------------------------------------------
section("K3-A4. No ambiguous officialCode lookup remains in shipped code");
{
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (/\.(ts|tsx)$/.test(e.name)) acc.push(p);
    }
    return acc;
  };
  const offenders = [];
  for (const f of walk(path.join(REPO, "src")).concat(path.join(REPO, "scripts", "seed.ts"), path.join(REPO, "scripts", "setup-production.ts"))) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/where:\s*\{\s*officialCode:\s*[^}]*\}/g)) {
      // A bare `where: { officialCode: X }` — only legitimate when it is a
      // filter (findMany/deleteMany/count/updateMany) AND sits beside a level.
      const ctx = src.slice(Math.max(0, m.index - 200), m.index + m[0].length + 20);
      if (/findUnique|upsert|connect|findUniqueOrThrow|update\(|delete\(/.test(ctx) && !/academicLevel/.test(ctx)) offenders.push(`${path.relative(REPO, f)}: ${m[0].slice(0, 60)}`);
    }
    if (/academicLevel_officialCode/.test(src) === false && /findUnique\(\{\s*where:\s*\{\s*officialCode/.test(src)) offenders.push(`${path.relative(REPO, f)}: findUnique by officialCode alone`);
  }
  ok(offenders.length === 0, `no findUnique/upsert/connect keyed by officialCode alone (${offenders.join("; ") || "none"})`);
  const oc = read("src/lib/official-curriculum.ts");
  ok(/academicLevel_officialCode: \{ academicLevel: level, officialCode: lessonModel\.code \}/.test(oc), "reconciler upserts by the composite key");
  ok(/where: \{ academicLevel: level, officialCode: \{ in: officialCodes \} \}/.test(oc), "reconciler lifecycle sweep is level-scoped");
  const seed = read("scripts/seed.ts");
  ok(/academicLevel_officialCode:\s*\{/.test(seed) || /academicLevel:\s*"SECOND_SECONDARY",\s*officialCode:\s*"1-1"/.test(seed) || /officialCode: "1-1", academicLevel/.test(seed), "seed resolves lesson 1-1 through its level");
  ok(!/officialCode:\s*`[^`]*\$\{/.test(oc) && !/["'`]S2-|["'`]F1-|prefix/.test(block(read("prisma/schema.prisma"), "Lesson").toLowerCase().replace(/\/\/\/[^\n]*/g, "")), "no code prefixing scheme");
}

// ---------------------------------------------------------------------------
section("K3-A5. K2 runtime gates untouched");
{
  const reg = read("src/app/api/auth/[action]/route.ts");
  ok(/api\.371/.test(reg) && /api\.372/.test(reg), "registration still requires level + offered pair (api.371/372)");
  ok(/api\.375/.test(read("src/app/api/admin/courses/route.ts")), "admin course create still requires a level (api.375)");
  // Manual-QA pass: the COURSE re-level refusal carries its own precise
  // wording (api.378); the GROUP re-target gate keeps api.377. Both 409.
  ok(/err\(tApi\("api\.378"\), 409\)/.test(read("src/app/api/admin/courses/[id]/route.ts")) && /api\.377/.test(read("src/app/api/admin/groups/[id]/route.ts")), "re-level (api.378) / re-target (api.377) gates");
  ok(/GROUP_LEVEL_MISMATCH/.test(read("src/lib/payment-transitions.ts")) || /GROUP_LEVEL_MISMATCH/.test(read("src/app/api/admin/payments/[id]/approve/route.ts")), "payment approval level gate");
  ok(/api\.376/.test(read("src/app/api/admin/mock-exams/route.ts")), "mock exam create still requires courseId (api.376)");
  const pool = read("src/lib/mock-exam-pool.ts");
  ok(/if \(courseId\) \{/.test(pool) && /id: \{ in: \[\] \}/.test(pool), "mockExamLessonWhere(null) fails closed");
  ok(/api\.085/.test(read("src/app/api/enroll/route.ts")), "enroll level gate (api.085)");
}

// ---------------------------------------------------------------------------
section("K3-B. Master gate — scripts/verify-k3-academic-level.mjs");
{
  const v = read("scripts/verify-k3-academic-level.mjs");
  ok(/pathToFileURL\(/.test(v) && !/await import\(\s*["']\//.test(v), "verifier loads repo modules through pathToFileURL (Windows-safe)");
  for (const g of GUARDS) ok(v.includes(`"${g}"`), `verifier exercises ${g}`);
  const script = path.join(REPO, "scripts", "verify-k3-academic-level.mjs");
  const r = spawnSync(process.execPath, [script], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  ok(r.status === 0, `B: verify-k3-academic-level.mjs exits 0 (got ${r.status})`);
  ok(/PHASE_K3_ACADEMIC_LEVEL_OK/.test(out), "B: verifier printed PHASE_K3_ACADEMIC_LEVEL_OK");
  ok(!/^\s*FAIL /m.test(out), "B: verifier reported no FAIL line");
  if (r.status !== 0) console.error(out.split("\n").filter((l) => /FAIL|Error/.test(l)).slice(0, 40).join("\n"));
}

console.log(`\nacademic-level-phaseK3: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
