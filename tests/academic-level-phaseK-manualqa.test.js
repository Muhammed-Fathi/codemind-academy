// CodeMind Academy — Phase K manual-QA fix pass: LEVEL VISIBILITY in the
// admin UX without any new level authority.
//
//   A. UI SOURCE PINS — the admin views expose the academic level where the
//      manual QA found it missing: course create (REQUIRED selector, no
//      default), course edit/list (canonical Course.academicLevel + filter),
//      group/mock-exam course selectors ("name — level"), session
//      management (filter + badge, identity = level + code + title),
//      session videos (Group→Course→Level, level in lesson/session options),
//      question bank (derived context only + free-bank truth), students
//      (typed-level filter composing with track + status).
//   B. AUTHORITY PINS — no Group/MockExam/Question/QuestionBank/SessionVideo
//      level column, no Lesson.courseId, no new migration, officialCode
//      still nullable with the composite uniqueness, Lesson.academicLevel
//      still derived (never a list-write input).
//   C. i18n — the vocabulary exists in BOTH languages with the exact words.
//   D. PURE LIB — the session-video picker carries the course level per
//      group and per lesson (display context only).
//   E. RUNTIME — delegated to scripts/verify-k2-academic-level.mjs section I
//      (run by tests/academic-level-phaseK2.test.js): course re-level fails
//      closed (api.378), list endpoints expose level, filters compose, two
//      lessons with the same officialCode in two levels are unambiguous,
//      the question-bank level filter never invents a level.
//
// Run: node tests/academic-level-phaseK-manualqa.test.js
// Exit code: 0 = all pass, 1 = failure.

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

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
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), `${label} :: got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
section("A. UI source pins — level visible where the manual QA found it missing");
// ---------------------------------------------------------------------------
const dash = read("src/components/admin/admin-dashboard.tsx");
const ui = read("src/components/admin/academic-level-ui.tsx");
const mock = read("src/components/admin/mock-exams-view.tsx");
const sessions = read("src/components/admin/session-workflow-view.tsx");
const videos = read("src/components/admin/session-videos-view.tsx");

// Shared vocabulary component — one badge/filter used by every admin view.
ok(/export function AcademicLevelBadge/.test(ui) && /export function AcademicLevelFilterSelect/.test(ui), "A1: shared AcademicLevelBadge + AcademicLevelFilterSelect exist");
ok(/export const ACADEMIC_LEVEL_OPTIONS = \["FIRST_SECONDARY", "SECOND_SECONDARY"\] as const/.test(ui), "A1: selector options are the two enum values (never labels)");
ok(/export function courseWithLevelLabel/.test(ui) && /admin\.643/.test(ui) && /admin\.644/.test(ui) && /admin\.645/.test(ui) && /admin\.648/.test(ui), "A1: labels come from i18n keys (643/644/645/648)");
for (const f of ["admin-dashboard.tsx", "mock-exams-view.tsx", "session-workflow-view.tsx", "session-videos-view.tsx"]) {
  ok(/from "@\/components\/admin\/academic-level-ui"/.test(read(`src/components/admin/${f}`)), `A1: ${f} uses the shared level UI`);
}

// Course create: REQUIRED selector, no silent default, submit blocked.
const addCourse = dash.slice(dash.indexOf("function AddCourseDialog"), dash.indexOf("function EditCourseDialog"));
ok(/academicLevel: "",/.test(addCourse), "A2: course create form starts with NO level (no silent default)");
ok(/if \(!form\.academicLevel\) \{\s*toast\.error\(tr\("admin\.649"\)\);\s*return;/.test(addCourse), "A2: course create refuses to submit without a level");
ok(/disabled=\{saving \|\| !form\.academicLevel\}/.test(addCourse), "A2: the create button is disabled until a level is chosen");
ok(/ACADEMIC_LEVEL_OPTIONS\.map/.test(addCourse) && /tr\("admin\.642"\)/.test(addCourse), "A2: create modal renders the level selector under the الصف الدراسي label");

// Course edit: canonical level shown; sent only when changed; lock hint.
const editCourse = dash.slice(dash.indexOf("function EditCourseDialog"), dash.indexOf("// 6. Question Bank"));
ok(/<AcademicLevelBadge level=\{course\?\.academicLevel\} \/>/.test(editCourse), "A3: edit modal displays the canonical Course.academicLevel");
ok(/levelChanged \? \{ \.\.\.form, academicLevel \} : form/.test(editCourse), "A3: academicLevel is sent ONLY when the admin actually changed it");
ok(/admin\.651/.test(editCourse) && /levelLikelyLocked/.test(editCourse), "A3: edit modal warns that a course with dependants is locked (server remains the gate)");

// Course list: badge on every card + level filter.
const coursesView = dash.slice(dash.indexOf("function CoursesView"), dash.indexOf("function AddCourseDialog"));
ok(/visibleCourses\.map\(\(c\) =>/.test(coursesView) && /<AcademicLevelBadge level=\{c\.academicLevel\} \/>/.test(coursesView), "A4: every course card shows its level badge");
ok(/<AcademicLevelFilterSelect value=\{levelFilter\} onChange=\{setLevelFilter\} \/>/.test(coursesView), "A4: course list has a level filter (default = all levels)");
ok(/academicLevel\?: string \| null;/.test(dash.slice(dash.indexOf("type CourseRow = {"), dash.indexOf("type TreeLesson"))), "A4: CourseRow carries academicLevel from GET /api/admin/courses");

// Groups: course options carry the level; selected level visible; card badge;
// and STILL no Group.academicLevel anywhere in the group forms.
const groupsSlice = dash.slice(dash.indexOf("type GroupRow = {"), dash.indexOf("type CourseRow = {"));
ok(/courseWithLevelLabel\(tr, c\)/.test(groupsSlice), "A5: Create Group course options read \"name — level\"");
ok(/selectedCourse && \(/.test(groupsSlice) && /<AcademicLevelBadge level=\{selectedCourse\.academicLevel\} \/>/.test(groupsSlice), "A5: the selected course's level is visible in the Create Group form");
ok(/<AcademicLevelBadge level=\{g\.academicLevel\} \/>/.test(groupsSlice), "A5: group cards show the (course-derived) level badge");
ok(/<AcademicLevelBadge level=\{group\.academicLevel\} \/>/.test(groupsSlice), "A5: Manage Group shows Group → Course → Level context");
ok(!/academicLevel:\s*(form|trackScope|academicLevel)\b/.test(groupsSlice.slice(groupsSlice.indexOf("function CreateGroupDialog"))) && !/body: JSON\.stringify\(\{[^}]*academicLevel/.test(groupsSlice), "A5: no group write ever sends an academicLevel (Group has none)");

// Mock exams: course options with level; list shows course + level.
ok(/courseWithLevelLabel\(tr, c\)/.test(mock), "A6: mock exam course options read \"name — level\"");
ok(/<AcademicLevelBadge level=\{selectedCourse\.academicLevel\} \/>/.test(mock), "A6: the selected course's level is visible in the exam form");
ok(/<AcademicLevelBadge level=\{e\.course\.academicLevel\} \/>/.test(mock), "A6: exam list rows show course + level context");
ok(!/academicLevel:\s*form\./.test(mock) && !/MockExam\.academicLevel/.test(mock.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")), "A6: the exam form never sends its own academicLevel");

// Session management: filter + badge; identity = level + code + title.
ok(/academicLevel: string;/.test(sessions.slice(sessions.indexOf("type Filters = {"), sessions.indexOf("export function SessionWorkflowView"))), "A7: session list filters include academicLevel");
ok(/params\.set\("academicLevel", filters\.academicLevel\)/.test(sessions), "A7: the level filter is sent to the server (SQL filter, not client narrowing)");
ok(/<AcademicLevelBadge level=\{lesson\.academicLevel\} \/>/.test(sessions), "A7: every lesson row shows its level badge");
const rowSlice = sessions.slice(sessions.indexOf("<AcademicLevelBadge level={lesson.academicLevel} />"));
ok(rowSlice.indexOf("{lesson.officialCode}") > 0 && rowSlice.indexOf("{lesson.officialCode}") < rowSlice.indexOf("pickAuto(lesson.titleAr, lesson.title)"), "A7: row identity order is Level → officialCode → title");

// Session videos: Group→Course→Level; lesson + session options carry level.
ok(/academicLevelLabel\(tr, l\.academicLevel\)/.test(videos), "A8: lesson options carry level + officialCode + title");
ok(/academicLevelLabel\(tr, g\.courseAcademicLevel\)/.test(videos), "A8: picker groups read \"Course — Level · Unit n\"");
ok(/courseName \? ` \(\$\{s\.courseName\} — \$\{academicLevelLabel\(tr, s\.academicLevel\)\}\)` : ""/.test(videos), "A8: session (absence-source) options show group (course — level)");
ok(/<AcademicLevelBadge level=\{activeBatch\.course\.academicLevel\} \/>/.test(videos), "A8: a course-bound batch shows its course + level");
ok(/requiredPercent/.test(videos) && /requirementMode/.test(videos), "A8: 95% rule / requirement-mode fields untouched (still present)");

// Question bank: derived context only; free-bank truth; filter independent of track tabs.
const qb = dash.slice(dash.indexOf("// 6. Question Bank"));
ok(/academicLevel\?: string \| null;/.test(qb.slice(0, qb.indexOf("function QuestionBankView"))) && /DERIVED lesson level/.test(qb), "A9: question row's level lives under quiz.lesson (derived), never on the question");
ok(/<AcademicLevelBadge level=\{q\.quiz\.lesson\.academicLevel\} \/>/.test(qb), "A9: lesson-linked questions show the derived level badge");
ok(/tr\("admin\.650"\)/.test(qb), "A9: free-bank questions state they have no single level");
ok(/params\.set\("academicLevel", levelFilter\)/.test(qb) && /params\.set\("schoolType", bank\)/.test(qb), "A9: level filter is a separate server param from the track bank");

// Students: level filter uses the typed column and composes.
const students = dash.slice(dash.indexOf("function StudentsView"), dash.indexOf("function AddStudentDialog"));
ok(/params\.set\("academicLevel", academicLevel\)/.test(students) && /params\.set\("schoolType", schoolType\)/.test(students) && /params\.set\("status", status\)/.test(students), "A10: students query composes academicLevel + schoolType + status");
ok(/<AcademicLevelFilterSelect value=\{academicLevel\} onChange=\{setAcademicLevel\} \/>/.test(students), "A10: students view renders the level filter");

// ---------------------------------------------------------------------------
section("B. Authority pins — no new authority, no migration, contract intact");
// ---------------------------------------------------------------------------
const schema = read("prisma/schema.prisma");
const modelBody = (name) => {
  const m = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  return m ? m[1] : "";
};
for (const m of ["Group", "MockExam", "Question", "SessionVideo", "Teacher", "Batch", "LiveSession"]) {
  ok(!/\bacademicLevel\b/.test(modelBody(m)), `B1: ${m} has no academicLevel column`);
}
ok(!/\bcourseId\b/.test(modelBody("Lesson")), "B1: Lesson has no courseId");
ok(!/model QuestionBank\b/.test(schema), "B1: no QuestionBank model was invented");
ok(/officialCode\s+String\?/.test(modelBody("Lesson")) && /@@unique\(\[academicLevel, officialCode\]\)/.test(modelBody("Lesson")), "B2: officialCode stays nullable with the composite uniqueness");
const migrations = fs.readdirSync(path.join(REPO, "prisma", "migrations")).filter((d) => /^\d{14}_/.test(d)).sort();
eq(migrations[migrations.length - 1], "20260923180000_k3_academic_level_constraints", "B3: no migration added after K3 (UI/API wiring only)");
const pgMigrations = fs.existsSync(path.join(REPO, "prisma", "postgres", "migrations"))
  ? fs.readdirSync(path.join(REPO, "prisma", "postgres", "migrations")).filter((d) => /^\d{14}_/.test(d)).sort()
  : [];
ok(pgMigrations.length === 0 || /k3_academic_level_constraints$/.test(pgMigrations[pgMigrations.length - 1]), "B3: no PostgreSQL migration added after K3");

// Server: create requires a level; re-level fails closed with api.378 and
// counts students + lessons + enrollments; the UI filters are VIEW filters.
const coursesRoute = read("src/app/api/admin/courses/route.ts");
const courseIdRoute = read("src/app/api/admin/courses/[id]/route.ts");
ok(/requireAcademicLevel\(body\.academicLevel\)/.test(coursesRoute) && /api\.375/.test(coursesRoute), "B4: POST /api/admin/courses still requires a valid level (api.375)");
ok(/db\.enrollment\.count\(\{ where: \{ courseId: id \} \}\)/.test(courseIdRoute) && /members > 0 \|\| lessons > 0 \|\| enrollments > 0\) return err\(tApi\("api\.378"\), 409\)/.test(courseIdRoute), "B4: PATCH re-level fails closed (students | lessons | enrollments) with api.378 / 409");
ok(!/student\.updateMany|lesson\.updateMany/.test(courseIdRoute), "B4: the course route never rewrites Student/Lesson levels (no cascade)");
const studentsRoute = read("src/app/api/admin/students/route.ts");
ok(/where\.academicLevel = academicLevel;/.test(studentsRoute) && !/where\.grade/.test(studentsRoute), "B5: students filter uses Student.academicLevel, never the grade string");
ok(/return err\(tApi\("api\.371"\), 400\);/.test(studentsRoute.slice(0, studentsRoute.indexOf("export async function POST"))), "B5: an invalid level filter is refused (400), never ignored");
const lessonsRoute = read("src/app/api/admin/lessons/route.ts");
ok(/if \(levelFilter\) where\.academicLevel = levelFilter;/.test(lessonsRoute), "B6: lesson list filters on the derived cache (VIEW filter only)");
ok(/normalizeAcademicLevel\(levelRaw\)/.test(lessonsRoute) && /INVALID_ACADEMIC_LEVEL:academicLevel/.test(lessonsRoute), "B6: the level filter is validated in the route with the shared normalizer (400 on garbage)");
const adminSessions = read("src/lib/admin-sessions.ts");
ok(!/academicLevel/.test(adminSessions), "B6: the lesson input contract (admin-sessions.ts) stays level-free — level is derived, never an input (K2-A4 pin intact)");
const qbRoute = read("src/app/api/admin/question-bank/route.ts");
ok(/where\.quiz = \{ lesson: \{ academicLevel: level \} \};/.test(qbRoute), "B7: question-bank level filter derives through quiz → lesson only");
ok(!/where\.academicLevel/.test(qbRoute), "B7: the question-bank route never filters on a Question.academicLevel (there is none)");
const eligibleSessions = read("src/app/api/admin/session-videos/eligible-sessions/route.ts");
ok(/course: \{ select: \{ name: true, nameAr: true, academicLevel: true \} \}/.test(eligibleSessions) && /academicLevel: s\.group\?\.course\?\.academicLevel \?\? null/.test(eligibleSessions), "B8: session-video session options expose Group → Course → Level from the course");
const registration = read("src/app/api/registration/options/route.ts");
ok(!/SECOND_SECONDARY/.test(registration.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")) && !/"ARABIC"/.test(registration.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "")), "B9: registration options stay data-driven (no hard-coded level/track)");

// ---------------------------------------------------------------------------
section("C. i18n — exact vocabulary, both languages");
// ---------------------------------------------------------------------------
const dict = read("src/lib/i18n-dict-2026.ts");
const entry = (k) => {
  const m = dict.match(new RegExp(`"${k.replace(".", "\\.")}":\\s*\\{\\s*ar:\\s*"([^"]*)",\\s*en:\\s*"([^"]*)"`));
  return m ? { ar: m[1], en: m[2] } : null;
};
eq(entry("admin.642"), { ar: "الصف الدراسي", en: "Academic level" }, "C1: admin.642");
eq(entry("admin.643"), { ar: "أولى ثانوي", en: "First Secondary" }, "C1: admin.643");
eq(entry("admin.644"), { ar: "ثانية ثانوي", en: "Second Secondary" }, "C1: admin.644 uses the requested spelling ثانية ثانوي");
eq(entry("admin.648"), { ar: "كل الصفوف", en: "All Levels" }, "C1: admin.648 All Levels");
for (const k of ["admin.649", "admin.650", "admin.651", "api.378"]) {
  const e = entry(k);
  ok(e && e.ar.length > 0 && e.en.length > 0, `C2: ${k} exists in both languages`);
}
eq(entry("auth.231"), { ar: "ثانية ثانوي", en: "Second Secondary" }, "C3: registration label uses the same spelling");

// ---------------------------------------------------------------------------
section("D. Pure lib — the session-video picker carries the course level");
// ---------------------------------------------------------------------------
{
  const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-k-manualqa-"));
  fs.writeFileSync(
    path.join(OUT, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "es2020", module: "commonjs", strict: false, skipLibCheck: true, esModuleInterop: true, outDir: OUT, rootDir: REPO, baseUrl: REPO, paths: { "@/*": ["src/*"] }, types: [] },
      files: [
        "src/lib/session-video-picker.ts",
        "src/lib/session-video-link.ts",
        "src/lib/video-applicability.ts",
        "src/lib/media-storage.ts",
        "src/lib/school-type.ts",
        "src/lib/track-scope.ts",
      ].map((f) => path.join(REPO, f)),
    })
  );
  try {
    execFileSync(process.execPath, [path.join(REPO, "node_modules", "typescript", "lib", "tsc.js"), "-p", path.join(OUT, "tsconfig.json")], { cwd: REPO, stdio: "pipe" });
  } catch {
    // type noise is tolerated (no generated Prisma client); emission still happens
  }
  const EMIT = path.join(OUT, "src", "lib");
  const Module = require("module");
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    const m = /^@\/lib\/([\w-]+)$/.exec(request);
    if (m) {
      const compiled = path.join(EMIT, `${m[1]}.js`);
      if (fs.existsSync(compiled)) return compiled;
    }
    return originalResolve.call(this, request, ...rest);
  };
  const Picker = require(path.join(EMIT, "session-video-picker.js"));
  const TREE = [
    { id: "cA", name: "Course A", nameAr: "كورس أ", academicLevel: "SECOND_SECONDARY", parts: [{ id: "pA", units: [{ id: "uA", order: 1, lessons: [
      { id: "lA", title: "A", titleAr: "أ", officialCode: "1-1", trackScope: "SHARED", curriculumStatus: "OFFICIAL", academicLevel: "SECOND_SECONDARY" },
    ], topics: [] }] }] },
    { id: "cB", name: "Course B", nameAr: "كورس ب", academicLevel: "FIRST_SECONDARY", parts: [{ id: "pB", units: [{ id: "uB", order: 1, lessons: [
      { id: "lB", title: "B", titleAr: "ب", officialCode: "1-1", trackScope: "SHARED", curriculumStatus: "OFFICIAL", academicLevel: "FIRST_SECONDARY" },
    ], topics: [] }] }] },
    { id: "cL", name: "Legacy", nameAr: "قديم", parts: [{ id: "pL", units: [{ id: "uL", order: 2, lessons: [
      { id: "lL", title: "L", titleAr: "ل", officialCode: null, trackScope: "SHARED", curriculumStatus: "LEGACY" },
    ], topics: [] }] }] },
  ];
  const groups = Picker.buildLessonGroups(TREE, { id: "pool", schoolType: "ARABIC", course: null });
  eq(groups.map((g) => g.courseAcademicLevel), ["SECOND_SECONDARY", "FIRST_SECONDARY", null], "D1: each picker group carries its course's level (null = legacy, never guessed)");
  eq(groups.map((g) => g.lessons[0].academicLevel), ["SECOND_SECONDARY", "FIRST_SECONDARY", null], "D2: each picker lesson carries its derived level");
  const sameCode = groups.filter((g) => g.lessons.some((l) => l.officialCode === "1-1"));
  eq(new Set(sameCode.map((g) => g.courseAcademicLevel)).size, 2, "D3: two lessons with officialCode 1-1 are distinguishable by level");
  ok(groups.every((g) => !("academicLevel" in g)), "D4: no group-level authority field is introduced (only courseAcademicLevel context)");
}

// ---------------------------------------------------------------------------
console.log(`\nacademic-level-phaseK-manualqa: ${pass} passed, ${failures.length} failed`);
process.exit(failures.length === 0 ? 0 : 1);
