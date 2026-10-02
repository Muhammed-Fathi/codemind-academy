// Phase M2 — Admin multi-level UX contracts.
// This suite executes the shared parser/label code and checks the server/UI
// boundaries that keep the Admin flows scoped. Database-backed route tests in
// the existing Phase K/L suites remain the authority for Prisma execution;
// these assertions specifically guard the M2 wiring from regressing to a
// cosmetic, name/code-based filter.
const fs = require("fs");
const path = require("path");
const Module = require("module");
const ts = require("typescript");

const ROOT = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
let passed = 0;
let failed = 0;
function check(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ok   ${message}`);
  } else {
    failed++;
    console.log(`  FAIL ${message}`);
  }
}

const cache = new Map();
function resolveTs(file) {
  const candidates = [file, `${file}.ts`, `${file}.tsx`, path.join(file, "index.ts")];
  const match = candidates.find((candidate) => fs.existsSync(path.join(ROOT, candidate)));
  if (!match) throw new Error(`Cannot resolve TypeScript module: ${file}`);
  return path.join(ROOT, match);
}

function loadTs(file) {
  const abs = resolveTs(file);
  if (cache.has(abs)) return cache.get(abs).exports;
  const source = fs.readFileSync(abs, "utf8");
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: abs,
  }).outputText;
  const mod = { exports: {} };
  cache.set(abs, mod);
  const req = Module.createRequire(abs);
  const localRequire = (specifier) => {
    if (specifier === "@/lib/db") return { db: {} };
    if (specifier === "@prisma/client") return {};
    if (specifier.startsWith("@/")) return loadTs(path.join("src", specifier.slice(2)));
    return req(specifier);
  };
  new Function("exports", "require", "module", "__filename", "__dirname", js)(
    mod.exports, localRequire, mod, abs, path.dirname(abs)
  );
  return mod.exports;
}

const query = loadTs("src/lib/academic-level-query.ts");
const labels = loadTs("src/lib/academic-level-labels.ts");
const tr = (key) => ({
  "admin.643": "First Secondary",
  "admin.644": "Second Secondary",
  "admin.645": "Unspecified",
}[key] || key);

console.log("\nM2-A — progression override identity and fail-closed scope");
for (const value of [undefined, "", "all", "ALL"]) {
  const result = query.parseAcademicLevelValue(value);
  check(result.ok && result.level === null, `${String(value)} means ALL/no narrowing`);
}
for (const [value, level] of [["FIRST_SECONDARY", "FIRST_SECONDARY"], ["second-secondary", "SECOND_SECONDARY"]]) {
  const result = query.parseAcademicLevelValue(value);
  check(result.ok && result.level === level, `${value} narrows to ${level}`);
}
check(query.parseAcademicLevelValue("THIRD_SECONDARY").ok === false, "unknown level is refused, not widened to ALL");
const firstLesson = labels.lessonLabelFor(tr, { academicLevel: "FIRST_SECONDARY", officialCode: "1-1", title: "Introduction" });
const secondLesson = labels.lessonLabelFor(tr, { academicLevel: "SECOND_SECONDARY", officialCode: "1-1", title: "Introduction" });
check(firstLesson !== secondLesson, "duplicate officialCode lessons have distinct visible labels");
check(firstLesson.includes("First Secondary") && secondLesson.includes("Second Secondary"), "lesson label shows academic level before code");
const progressionUi = read("src/components/admin/progression-override-section.tsx");
const lessonsRoute = read("src/app/api/admin/lessons/route.ts");
check(progressionUi.includes("studentId=${encodeURIComponent(studentId)}"), "override picker sends the selected Student id");
check(lessonsRoute.includes("studentId") && lessonsRoute.includes("student.group.courseId"), "lessons API derives Student → Group → Course scope server-side");
check(lessonsRoute.includes("where.AND") && lessonsRoute.includes("courseId: student.group.courseId"), "lesson query is narrowed by course relationship, not just hidden in React");
check(progressionUi.includes("key={l.id}") && progressionUi.includes("lessonId"), "override selection remains canonical lesson id based");

console.log("\nM2-B/G — group filters, eligibility, and invariant preservation");
const groupsRoute = read("src/app/api/admin/groups/route.ts");
const studentsRoute = read("src/app/api/admin/students/route.ts");
const groupUi = read("src/components/admin/admin-dashboard.tsx");
check(groupsRoute.includes("parseAcademicLevelParam") && groupsRoute.includes("where.course = { academicLevel: level.level }"), "Groups level filter is parsed and applied in the server query");
check(groupsRoute.includes("academicLevel: g.course?.academicLevel") && !groupsRoute.includes("academicLevel: g.academicLevel"), "Group level is derived from Course; no Group.academicLevel field is used");
check(studentsRoute.includes("eligibleForGroupId") && studentsRoute.includes("targetGroup.course?.academicLevel"), "eligible student search derives level from the target Group course");
check(studentsRoute.includes("where.schoolType = targetTrack"), "eligible student search keeps Track orthogonal to Academic Level");
check(groupUi.includes("groupId: group.id") && groupUi.includes("pageSize: \"20\"") && groupUi.includes("memberTotalPages"), "ManageGroupDialog uses server-side member pagination, not the first 20 global students");
check(groupUi.includes("updateMembership") && groupUi.includes("eligibleForGroupId"), "group management exposes server-filtered compatible student selection");
const groupMutation = read("src/app/api/admin/groups/[id]/route.ts");
const studentMutation = read("src/app/api/admin/students/[id]/route.ts");
check(groupMutation.includes("groupLevelEligible") && studentMutation.includes("groupLevelEligible"), "Student → Group academic-level compatibility remains server-enforced");
check(groupMutation.includes("requireRole(\"ADMIN\")") && studentMutation.includes("requireRole(\"ADMIN\")"), "group/student mutation authorization remains Admin-only");

console.log("\nM2-C/D/E/F — live ops, mock exams, questions, and courses");
const liveRoute = read("src/app/api/admin/live-ops/route.ts");
const liveService = read("src/lib/live-sessions.ts");
const liveUi = read("src/components/admin/live-ops-view.tsx");
check(liveRoute.includes("parseAcademicLevelParam") && liveRoute.includes("academicLevel: level.level"), "Live Ops passes the shared level filter to the server service");
check(liveService.includes("academicLevel?: string | null") && liveService.includes("where.group = { course: { academicLevel: options.academicLevel } }"), "Live Ops narrows sessions through Group → Course in the query");
check(liveRoute.includes("buildAdminOpsOverview({ now, academicLevel: level.level })") && liveRoute.includes("listSessionsNeedingReview({ now, academicLevel: level.level"), "Live Ops applies the level scope to KPIs and review queues, not only the main session list");
const absenceReview = read("src/lib/absence-review.ts");
check(absenceReview.includes("academicLevel?: string | null") && absenceReview.includes("course: { academicLevel: query.academicLevel }"), "Live Ops absence payloads and queue filtering carry Group → Course level context");
check(liveUi.includes("academicLevelLabel") && liveUi.includes("AcademicLevelFilterSelect"), "Live Ops labels mixed-level group options and offers a level filter");
const mockRoute = read("src/app/api/admin/mock-exams/route.ts");
const mockUi = read("src/components/admin/mock-exams-view.tsx");
check(mockRoute.includes("parseAcademicLevelParam") && mockRoute.includes("examWhere.course = { academicLevel"), "Mock Exams list filter is server-side through the required course");
check(mockRoute.includes("courseId = body.courseId") && mockRoute.includes("if (!courseId)"), "Mock Exam courseId remains required and authoritative");
check(mockUi.includes("courseWithLevelLabel") && mockUi.includes("AcademicLevelFilterSelect"), "Mock Exam course selectors and list use shared level vocabulary");
const questionRoute = read("src/app/api/admin/question-bank/route.ts");
const questionUi = read("src/components/admin/admin-dashboard.tsx");
check(questionRoute.includes("parseAcademicLevelParam") && questionRoute.includes("where.quiz = { lesson: { academicLevel"), "Question Bank level filter is server-side through quiz → lesson");
check(questionRoute.includes("schoolType") && questionRoute.includes("academicLevel"), "Question Bank keeps Track and Academic Level as separate filters");
check(questionUi.includes("AcademicLevelFilterSelect value={levelFilter}") && questionUi.includes("q.schoolType"), "Question Bank UI composes level with Track rather than replacing it");
const coursesRoute = read("src/app/api/admin/courses/route.ts");
check(coursesRoute.includes("parseAcademicLevelParam") && coursesRoute.includes("where: levelParam.level ? { academicLevel: levelParam.level }"), "Courses filter is server-side with shared ALL/FIRST/SECOND parser");
check(coursesRoute.includes("academicLevel: c.academicLevel"), "Courses response preserves canonical level identity");

console.log("\nM2-H/I — Overview integrity and decomposition");
const overviewRoute = read("src/app/api/admin/overview/route.ts");
const overviewUi = read("src/components/admin/admin-dashboard.tsx");
const integrityUi = read("src/components/admin/admin-integrity-card.tsx");
const diagnosticsRoute = read("src/app/api/admin/level-mismatches/route.ts");
check(overviewRoute.includes("${g.courseId}:${course?.academicLevel"), "Overview group distribution key includes course id and level");
check(overviewRoute.includes("groupAcademicLevel"), "Overview upcoming group context carries academic level");
check(overviewUi.includes("AdminIntegrityCard"), "Overview visibly mounts the integrity diagnostic");
check(integrityUi.includes("data-integrity-card={healthy ? \"healthy\" : \"warning\"}"), "integrity card has healthy and actionable warning states");
check(!integrityUi.includes("db.") && !integrityUi.includes("update("), "integrity card is read-only and cannot auto-fix data");
check(diagnosticsRoute.includes("requireRole(\"ADMIN\")"), "integrity diagnostics retain Admin authorization");
check(overviewUi.includes("view === \"admin-overview\"") && overviewUi.includes("view === \"admin-groups\""), "dashboard view keys remain unchanged");

console.log("\nM1 compatibility and scope guard");
check(read("src/components/admin/academic-level-ui.tsx").includes("ACADEMIC_LEVEL_OPTIONS = [\"FIRST_SECONDARY\", \"SECOND_SECONDARY\"]"), "shared M1 vocabulary still contains exactly the two levels");
for (const forbidden of ["Teacher.academicLevel", "Group.academicLevel", "MockExam.academicLevel", "AcademicLevel.GENERAL"]) {
  // The architecture comments document forbidden fields, but no schema field
  // may be introduced by the M2 implementation files.
  check(!read("prisma/schema.prisma").includes(forbidden.replace("Teacher.", "  academicLevel").replace("Group.", "  academicLevel").replace("MockExam.", "  academicLevel")), `${forbidden} was not added to the schema`);
}
check(read("src/app/api/admin/level-mismatches/route.ts").includes("export async function GET"), "diagnostic endpoint remains a GET-only read surface");

console.log(`\nPhase M2 checks: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
