// CodeMind Academy — M3.4 focused regression coverage.
//
// Pins the attendance/UI level boundary, analytics request sequencing, locale
// direction, the workspace Arabic prompt contract, targeted dialog direction,
// and mobile student-note access. The real-route attendance cases live beside
// the existing Phase L SQLite fixture in teacher-academic-level-phaseL.test.js.
//
// Run: node tests/teacher-m34-i18n-responsive.test.js

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

const REPO = path.join(__dirname, "..");
let passed = 0;
let failed = 0;

function ok(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ok   ${message}`);
  } else {
    failed++;
    console.error(`  FAIL ${message}`);
  }
}

function read(relativePath) {
  return fs.readFileSync(path.join(REPO, relativePath), "utf8");
}

function section(title) {
  console.log(`\n${title}`);
}

function between(source, start, end) {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `Missing section start: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `Missing section end: ${end}`);
  return source.slice(startAt, endAt);
}

function loadPureTypeScript(relativePath) {
  const source = read(relativePath);
  const output = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      strict: true,
    },
    fileName: relativePath,
  }).outputText;
  const module = { exports: {} };
  new Function("module", "exports", output)(module, module.exports);
  return module.exports;
}

try {
  section("Attendance identity and selected-level narrowing");
  const attendanceRoute = read("src/app/api/teacher/attendance/route.ts");
  const attendanceUi = read("src/components/teacher/teacher-dashboard.tsx");
  const attendanceView = between(attendanceUi, "function AttendanceView()", "function StudentNotesDialog");
  ok(/teacherGroupIds\.includes\(groupId\)/.test(attendanceRoute), "attendance still requires ownership of the selected group");
  ok(/loadSessionForTeacher\(scope, sessionId\)/.test(attendanceRoute), "attendance still authorizes the selected session");
  ok(/access\.session\.groupId !== groupId/.test(attendanceRoute), "attendance rejects an owned but mismatched group/session pair");
  ok(/academicLevelParamOf\(req\)/.test(attendanceRoute), "the API treats Academic Level as an optional narrowing constraint");
  ok(/withLevelQuery\([\s\S]*?\/api\/teacher\/attendance\?groupId=/.test(attendanceView), "the attendance roster request carries the selected Academic Level");
  ok(/sessionId=\$\{encodeURIComponent\(sessionId\)\}[\s\S]*?level\s*\)/.test(attendanceView), "the per-session attendance request carries the selected Academic Level");
  ok(/queryKey: \["teacher-attendance-group", groupId, level \|\| "ALL"\]/.test(attendanceView), "attendance cache identity includes the selected level and canonical group ID");
  const sessionAttendanceRoute = read("src/app/api/live-sessions/[id]/attendance/route.ts");
  ok(/loadSessionForTeacher\(actor\.scope!, id\)/.test(sessionAttendanceRoute), "the session-ID register keeps the separate owner/substitute authorization path");

  section("Analytics request sequence and failure state");
  const analytics = between(attendanceUi, "function AnalyticsView()", "function OverviewStat");
  ok(/latestRequestReducer/.test(analytics), "AnalyticsView uses the latest-request reducer");
  ok(/AbortController/.test(analytics), "changing Academic Level cancels the superseded request");
  ok(/requestId/.test(analytics) && /request\.key === requestKey/.test(analytics), "only the active request key/sequence is rendered");
  ok(/request\.status === "error"/.test(analytics) && /setRetryCount/.test(analytics), "analytics failures clear the payload and show a retryable error state");

  const { latestRequestReducer } = loadPureTypeScript("src/lib/latest-request-state.ts");
  const initial = {
    requestId: 0,
    key: "",
    status: "loading",
    data: null,
    error: null,
    metadata: null,
  };
  const firstLoading = latestRequestReducer(initial, { type: "start", requestId: 1, key: "FIRST_SECONDARY" });
  const secondLoading = latestRequestReducer(firstLoading, { type: "start", requestId: 2, key: "SECOND_SECONDARY" });
  const secondSuccess = latestRequestReducer(secondLoading, {
    type: "success",
    requestId: 2,
    key: "SECOND_SECONDARY",
    data: { overview: { totalStudents: 1 }, groups: [{ groupId: "g-ss" }] },
    metadata: { spansBothLevels: true },
  });
  const lateFirstResponse = latestRequestReducer(secondSuccess, {
    type: "success",
    requestId: 1,
    key: "FIRST_SECONDARY",
    data: { overview: { totalStudents: 90 }, groups: [{ groupId: "g-fs" }] },
  });
  assert.equal(lateFirstResponse, secondSuccess);
  ok(lateFirstResponse.data.groups[0].groupId === "g-ss", "out-of-order earlier-level success cannot replace the active level");
  const retryLoading = latestRequestReducer(secondSuccess, { type: "start", requestId: 3, key: "SECOND_SECONDARY" });
  ok(retryLoading.data === null && retryLoading.status === "loading", "starting a current refresh clears old analytics while loading");
  const currentError = latestRequestReducer(retryLoading, {
    type: "error",
    requestId: 3,
    key: "SECOND_SECONDARY",
    error: new Error("offline"),
  });
  ok(currentError.data === null && currentError.status === "error" && currentError.error.message === "offline", "current analytics failure clears data and records a visible error");
  const lateError = latestRequestReducer(currentError, {
    type: "error",
    requestId: 2,
    key: "SECOND_SECONDARY",
    error: new Error("late failure"),
  });
  assert.equal(lateError, currentError);
  ok(lateError.error.message === "offline", "a late error cannot replace the active request error");

  section("Arabic RTL, English LTR, and localized Teacher dialogs");
  const { localeDirection } = loadPureTypeScript("src/lib/locale-direction.ts");
  assert.equal(localeDirection("ar"), "rtl");
  assert.equal(localeDirection("en"), "ltr");
  ok(true, "the shared locale-direction helper maps Arabic to RTL and English to LTR");
  const i18nCore = read("src/lib/i18n-core.ts");
  ok(/document\.documentElement\.dir = localeDirection\(locale\)/.test(i18nCore), "global locale application uses the shared direction mapping");

  const sessions = read("src/components/teacher/teacher-sessions.tsx");
  const attemptsDialog = between(sessions, "function QuizAttemptsDialog(", "function QuizPreviewDialog(");
  const previewDialog = between(sessions, "function QuizPreviewDialog(", "// ------------------------------------------------------------\n// Quiz create");
  const authoring = read("src/components/teacher/teacher-authoring.tsx");
  const reviewDialog = between(authoring, "export function TeacherQuizAttemptReviewDialog(", "function QuestionRow(");
  const notesDialog = between(attendanceUi, "function StudentNotesDialog(", "function StatusButton(");
  const readiness = read("src/components/teacher/readiness-view.tsx");
  const reminderDialog = between(readiness, "<Dialog open={remindTarget !== null}", "</Dialog>");
  ok(/dir=\{direction\}/.test(attemptsDialog) && !/dir="rtl"/.test(attemptsDialog), "attempt results use locale direction instead of forced RTL");
  ok(/dir=\{direction\}/.test(previewDialog) && !/dir="rtl"/.test(previewDialog), "quiz preview uses locale direction instead of forced RTL");
  ok(/dir=\{direction\}/.test(reviewDialog) && !/dir="rtl"/.test(reviewDialog), "attempt detail uses locale direction instead of forced RTL");
  ok(/dir=\{direction\}/.test(notesDialog) && /dir="auto"/.test(notesDialog), "attendance notes dialog and free-text input respect locale/content direction");
  ok(/dir=\{direction\}/.test(reminderDialog) && !/dir="rtl"/.test(reminderDialog), "readiness reminder dialog follows the active locale direction");
  ok((read("src/components/teacher/live-sessions-workspace.tsx").match(/<DialogContent[^>]*dir=\{direction\}/g) || []).length >= 4, "live-session schedule, cancel, reschedule, and finalize dialogs follow locale direction");

  section("Bilingual quiz prompt and persistence contract");
  const questionDraft = between(sessions, "function QuestionDraftEditor(", "// Quiz metadata edit");
  const quizCreate = between(sessions, "function QuizCreateDialog(", "function QuestionDraftEditor(");
  const quizApi = read("src/app/api/teacher/quizzes/route.ts");
  ok(/promptAr:\s*string/.test(sessions), "the existing draft type retains promptAr");
  ok(/value=\{draft\.promptAr\}/.test(questionDraft), "the workspace authoring form renders the Arabic prompt value");
  ok(/onChange=\{\(e\) => onChange\(\{ promptAr: e\.target\.value \}\)\}/.test(questionDraft), "Arabic prompt edits update the existing draft field");
  ok(/dir="rtl"/.test(questionDraft) && /dir="ltr"/.test(questionDraft), "the Arabic and English prompt inputs have their respective directions");
  ok(/questions:\s*normalized\.map\(\(q\) => \(\{ \.\.\.q, schoolType: undefined \}\)\)/.test(quizCreate), "the create payload carries promptAr through the existing normalized question object");
  ok(/promptAr:\s*q\.promptAr/.test(quizApi), "the existing quiz create route persists each promptAr value");
  ok(/if \(!q\.prompt\.trim\(\)\)/.test(quizCreate), "the existing required English prompt validation remains authoritative");

  section("Narrow-screen student-note access");
  ok(/data-testid="attendance-student-note-mobile"/.test(attendanceView), "attendance rows expose a dedicated mobile note action");
  ok(/data-testid="attendance-student-note-mobile"[\s\S]*?className="sm:hidden[^\"]*shrink-0/.test(attendanceView), "the mobile action stays visible below sm and cannot shrink out of reach");
  ok(/hidden sm:table-cell/.test(attendanceView), "the original desktop notes column remains unchanged");
  ok(/overflow-x-auto/.test(read("src/components/ui/table.tsx")), "any table-width overflow remains contained inside the existing table scroller");

  console.log(`\nM3.4 i18n/responsive: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error("\nM3.4 test harness error:", error && error.stack ? error.stack : error);
  process.exitCode = 1;
}
