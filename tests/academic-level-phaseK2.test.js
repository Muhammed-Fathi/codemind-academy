// CodeMind Academy — Phase K2: ACADEMIC LEVEL as a runtime authority.
//
//   A. SOURCE-LEVEL INVARIANTS — the multi-level contract stays in the
//      shipped code: no Group.academicLevel / Lesson.courseId / Teacher
//      level column; the registration DTO is offerings-shaped (never the
//      rejected { levels, tracks }); every assignment-producing write path
//      calls the shared I1 predicate; Lesson.academicLevel is derived, not
//      an input; mock exams require a course; the reconciler is
//      spec-parameterised with SECOND_SECONDARY_SPEC byte-pinning 2/7/23; K1
//      columns stay nullable (no K3 tightening); the K2 UI minimum exists.
//   B. THE MASTER GATE — scripts/verify-k2-academic-level.mjs runs the
//      shipped route handlers over a REAL SQLite database and must print
//      PHASE_K2_ACADEMIC_LEVEL_OK (registration offerings + revalidation,
//      student creation, group/enroll/approval gates, admin edits, the
//      reconciler, derived lesson level + drift detection, mock-exam pool
//      safety).
//
// Run: node tests/academic-level-phaseK2.test.js
// Exit code: 0 = all pass, 1 = failure. Requires Node >= 22 (node:sqlite).

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

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

// ---------------------------------------------------------------------------
section("K2-A0. Schema — no duplicated academic authority; K1 columns stay nullable");
// ---------------------------------------------------------------------------
{
  const schema = read("prisma/schema.prisma");
  const block = (name) => schema.slice(schema.indexOf(`model ${name} {`), schema.indexOf("\n}", schema.indexOf(`model ${name} {`)));
  ok(!/academicLevel/.test(block("Group")), "A0: no Group.academicLevel (level derives from Group.courseId → Course)");
  ok(!/academicLevel/.test(block("Teacher")), "A0: no Teacher.academicLevel (scope derives from groups)");
  ok(!/\bcourseId\b/.test(block("Lesson")), "A0: no Lesson.courseId (chain stays the only course link)");
  ok(/academicLevel\s+AcademicLevel\?/.test(block("Course")), "A0: Course.academicLevel still nullable (K3 tightens)");
  ok(/academicLevel\s+AcademicLevel\?/.test(block("Student")), "A0: Student.academicLevel still nullable (K3 tightens)");
  ok(/academicLevel\s+AcademicLevel\?/.test(block("Lesson")), "A0: Lesson.academicLevel still nullable (K3 tightens)");
  ok(/courseId\s+String\?/.test(block("MockExam")), "A0: MockExam.courseId still nullable in the DB (K2 = runtime rule; K3 = NOT NULL)");
  ok(/officialCode\s+String\?\s+@unique/.test(block("Lesson")), "A0: global Lesson.officialCode unique untouched (composite unique is K3)");
  const migs = fs.readdirSync(path.join(REPO, "prisma", "migrations")).filter((d) => fs.existsSync(path.join(REPO, "prisma", "migrations", d, "migration.sql")));
  ok(migs.length === 20 && migs[migs.length - 1] === "20260923100000_k1_academic_level_capability", "A0: K2 adds NO migration (history still ends at K1)");
}

// ---------------------------------------------------------------------------
section("K2-A1. Shared authority module (src/lib/academic-level.ts)");
// ---------------------------------------------------------------------------
{
  const src = read("src/lib/academic-level.ts");
  for (const fn of ["requireAcademicLevel", "normalizeAcademicLevel", "groupLevelEligible", "deriveLessonLevel", "computeRegistrationOfferings", "loadRegistrationOfferings", "auditLevelIntegrity", "gradeLabelFor"]) {
    ok(new RegExp(`export (async )?function ${fn}\\b`).test(src), `A1: exports ${fn}`);
  }
  ok(/FIRST_SECONDARY: "1st Secondary"/.test(src) && /SECOND_SECONDARY: "2nd Secondary"/.test(src), "A1: grade mirror map — '1st Secondary' / byte-identical '2nd Secondary'");
  ok(/if \(!s \|\| !c\) return false;\s*return s === c;/.test(src), "A1: groupLevelEligible is EXACT equality, fail-closed on NULL either side");
  ok(!/grade/.test(src.slice(src.indexOf("export function groupLevelEligible"), src.indexOf("export const LEVEL_MISMATCH_CODE"))), "A1: the level predicate never reads Student.grade");
  ok(!/schoolType/.test(src.slice(src.indexOf("export function groupLevelEligible"), src.indexOf("export const LEVEL_MISMATCH_CODE"))), "A1: the level predicate never infers from track");
}

// ---------------------------------------------------------------------------
section("K2-A2. Registration — offerings contract + server revalidation");
// ---------------------------------------------------------------------------
{
  const opt = read("src/app/api/registration/options/route.ts");
  ok(/loadRegistrationOfferings/.test(opt) && /ok\(\{ offerings \}\)/.test(opt), "A2: GET /api/registration/options returns { offerings } from the shared loader");
  const optCode = opt.replace(/^\s*\/\/.*$/gm, "");
  ok(!/levels:|tracks:\s*\[/.test(optCode), "A2: the rejected independent { levels, tracks } shape is not produced");
  const reg = read("src/app/api/auth/[action]/route.ts");
  ok(/requireAcademicLevel\(body\.academicLevel\)/.test(reg), "A2: registration requires a typed academicLevel");
  ok(/isOfferedPair\(offerings, academicLevel, schoolType\)/.test(reg), "A2: registration revalidates the submitted Level × Track pair against the recomputed offered set");
  ok(/grade: gradeLabelFor\(academicLevel\)/.test(reg), "A2: registration derives grade from the level");
  ok(!/grade: "2nd Secondary"/.test(reg), "A2: the hard-coded grade string is gone from registration");
  const ui = read("src/components/auth/auth-view.tsx");
  ok(/\/api\/registration\/options/.test(ui) && /availableTracks/.test(ui), "A2 UI: level select populated from offerings; track choices filtered by the selected level");
}

// ---------------------------------------------------------------------------
section("K2-A3. Every assignment-producing write path carries the I1 gate");
// ---------------------------------------------------------------------------
{
  const paths = {
    "src/app/api/enroll/route.ts": /groupLevelEligible\(student\.academicLevel, course\.academicLevel\)/,
    "src/lib/payment-transitions.ts": /fail\("GROUP_LEVEL_MISMATCH"\)/,
    "src/app/api/admin/students/route.ts": /groupLevelEligible\(academicLevel, group\.course\?\.academicLevel\)/,
    "src/app/api/admin/students/[id]/route.ts": /groupLevelEligible\(effectiveAcademicLevel, group\.course\?\.academicLevel\)/,
    "src/app/api/admin/groups/[id]/route.ts": /groupLevelEligible\(s\.academicLevel, effectiveCourseLevel\)/,
    "src/app/api/groups/route.ts": /course: \{ academicLevel \}/,
  };
  for (const [file, re] of Object.entries(paths)) ok(re.test(read(file)), `A3: ${file} enforces the level gate`);
  const tr = read("src/lib/payment-transitions.ts");
  ok(/"GROUP_LEVEL_MISMATCH",/.test(tr) && /GROUP_LEVEL_MISMATCH: 409/.test(tr) && /GROUP_LEVEL_MISMATCH: "api\.373"/.test(tr), "A3: GROUP_LEVEL_MISMATCH is a stable 409 domain code with bilingual copy");
  ok(tr.indexOf('fail("GROUP_LEVEL_MISMATCH")') < tr.indexOf("const needsSeat"), "A3: the approval level gate sits BEFORE the seat lock (nothing half-applies)");
  ok(/select: \{ id: true, name: true, isActive: true, courseId: true, capacity: true, trackScope: true \}/.test(tr), "A3: the 26B target-group select is unchanged (level read separately)");
  const g = read("src/app/api/admin/groups/[id]/route.ts");
  ok(/api\.377/.test(g) && /NOT: \{ academicLevel: level \}/.test(g), "A3: re-targeting a populated group to another level's course is refused (no auto-unassign)");
  const ps = read("src/app/api/admin/students/[id]/route.ts");
  ok(!/data: \{ grade: body\.grade \}/.test(ps), "A3: free-text grade write retired from admin student PATCH");
  ok(/grade: gradeLabelFor\(pendingAcademicLevel\)/.test(ps) && /api\.374/.test(ps), "A3: level change re-derives the grade and is refused while grouped cross-level");
  const pc = read("src/app/api/admin/students/route.ts");
  ok(!/const grade = body\.grade/.test(pc) && /grade: gradeLabelFor\(academicLevel\)/.test(pc), "A3: admin create derives grade from the typed level");
}

// ---------------------------------------------------------------------------
section("K2-A4. Derived lesson level + level-aware reconciler");
// ---------------------------------------------------------------------------
{
  const create = read("src/app/api/admin/lessons/route.ts");
  ok(/normalizeAcademicLevel\(unit\.part\.course\?\.academicLevel\)/.test(create) && /COURSE_LEVEL_REQUIRED/.test(create), "A4: admin lesson create derives the level from the unit's course and fails closed");
  const parser = read("src/lib/admin-sessions.ts");
  ok(!/academicLevel/.test(parser), "A4: academicLevel is NOT part of the lesson input contract");
  const rec = read("src/lib/official-curriculum.ts");
  ok(/export type LevelCurriculumSpec/.test(rec) && /export const SECOND_SECONDARY_SPEC/.test(rec) && /export function loadLevelCurriculumModel/.test(rec), "A4: reconciler is spec-parameterised");
  ok(/expectedCounts: EXPECTED_OFFICIAL_COUNTS/.test(rec) && /expectedCodes: OFFICIAL_LESSON_CODES/.test(rec) && /courseSlug: OFFICIAL_COURSE_SLUG/.test(rec), "A4: SECOND_SECONDARY_SPEC byte-pins slug / 2-7-23 / codes");
  ok(/Reconciliation refused: course/.test(rec) && /academicLevel: level,/.test(rec), "A4: G7 refuses spec/course level drift; every created lesson gets the spec level");
  ok(!/FIRST_SECONDARY_SPEC/.test(rec) && !fs.existsSync(path.join(REPO, "docs", "curriculum", "knowledge-model-1st-sec.json")), "A4: NO First Secondary spec / knowledge model in K2 (Phase L)");
}

// ---------------------------------------------------------------------------
section("K2-A5. Mock exams — course required; automatic pool fails closed");
// ---------------------------------------------------------------------------
{
  const create = read("src/app/api/admin/mock-exams/route.ts");
  ok(/if \(!courseId\) return err\(tApi\("api\.376"\), 400\);/.test(create), "A5: admin create requires courseId (api.376)");
  const patch = read("src/app/api/admin/mock-exams/[id]/route.ts");
  ok(/api\.376/.test(patch), "A5: PATCH refuses clearing the course / publishing course-less");
  const pool = read("src/lib/mock-exam-pool.ts");
  ok(/MULTI-LEVEL POOL SAFETY/.test(pool), "A5: pool safety contract documented");
  ok(!/unitId: \{ not: null \}/.test(pool), "A5: the 'every course' lesson fallback is removed");
  ok(/if \(!courseId\) return \[\];/.test(pool), "A5: loadMockExamLessonIds fails closed without a course");
  const student = read("src/app/api/exams/mock/route.ts");
  ok(/mockExamLessonWhere\(poolCourseId\)/.test(student) && /const poolCourseId = mockExam \? mockExam\.courseId : courseId;/.test(student), "A5: student attempt scopes the automatic pool to the EXAM's course (shared rule)");
  const ui = read("src/components/admin/mock-exams-view.tsx");
  ok(/courseMissing/.test(ui) && !/__all__/.test(ui), "A5 UI: course select is required; the 'all courses' option is gone");
}

// ---------------------------------------------------------------------------
section("K2-A6. Admin UI minimum + i18n + diagnostics");
// ---------------------------------------------------------------------------
{
  const dash = read("src/components/admin/admin-dashboard.tsx");
  ok(/academicLevel: "SECOND_SECONDARY" as "FIRST_SECONDARY" \| "SECOND_SECONDARY"/.test(dash), "A6: create form uses a typed level control");
  ok(!/onChange=\{\(e\) => setForm\(\{ \.\.\.form, grade: e\.target\.value \}\)\}/.test(dash), "A6: free-form grade input removed");
  ok(/levelMismatch/.test(dash) && /admin\.646/.test(dash), "A6: mismatch diagnostic shown in list + drawer");
  ok(/body: JSON\.stringify\(\{ academicLevel: level \}\)/.test(dash), "A6: drawer edits the typed level");
  const dict = read("src/lib/i18n-dict-2026.ts");
  for (const k of ["api.371", "api.372", "api.373", "api.374", "api.375", "api.376", "api.377", "admin.642", "admin.646", "admin.647", "auth.228", "auth.229"]) {
    ok(new RegExp(`"${k.replace(".", "\\.")}": \\{`).test(dict) || new RegExp(`"${k.replace(".", "\\.")}": \\{ ar:`).test(dict), `A6: bilingual copy ${k}`);
  }
  ok(fs.existsSync(path.join(REPO, "src/app/api/admin/level-mismatches/route.ts")), "A6: admin level-mismatch diagnostics endpoint exists");
  ok(/requireRole\("ADMIN"\)/.test(read("src/app/api/admin/level-mismatches/route.ts")), "A6: …and is ADMIN-only");
}

// ---------------------------------------------------------------------------
section("K2-A7. Windows-safe verifier");
// ---------------------------------------------------------------------------
{
  const v = read("scripts/verify-k2-academic-level.mjs");
  const dynamicImports = [...v.matchAll(/await import\(([^)]*)\)/g)].map((m) => m[1]);
  ok(dynamicImports.length > 0 && dynamicImports.every((arg) => /pathToFileURL\(/.test(arg)), "A7: every dynamic import() receives a file:// URL (never a raw filesystem path)");
}

// ---------------------------------------------------------------------------
section("K2-B. The master gate — real handlers over real SQLite");
// ---------------------------------------------------------------------------
{
  const script = path.join(REPO, "scripts", "verify-k2-academic-level.mjs");
  const r = spawnSync(process.execPath, [script], { cwd: REPO, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = `${r.stdout || ""}\n${r.stderr || ""}`;
  ok(r.status === 0, `B: verify-k2-academic-level.mjs exits 0 (got ${r.status})`);
  ok(/PHASE_K2_ACADEMIC_LEVEL_OK/.test(out), "B: verifier printed PHASE_K2_ACADEMIC_LEVEL_OK");
  if (r.status !== 0) console.error(out.split("\n").filter((l) => /FAIL|Error/.test(l)).slice(0, 40).join("\n"));
}

console.log(`\nacademic-level-phaseK2: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("failures:");
  for (const f of failures) console.log(" -", f);
}
process.exit(failures.length === 0 ? 0 : 1);
