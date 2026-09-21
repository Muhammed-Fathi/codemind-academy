// CodeMind Academy — teacher navigation regression pins.
//
// WHAT REGRESSED (local manual QA, after the Readiness integration)
//   The `teacher-readiness` case was inserted INTO the app-shell fall-through
//   group that serves the dashboard keys, so `teacher-dashboard`,
//   `teacher-attendance` (plus quizzes/homework/templates/analytics) all fell
//   through to `return <TeacherReadinessView />`. Dashboard (لوحة التحكم)
//   and Attendance (الحضور) rendered the readiness UI; the dashboard lost its
//   content and attendance lost its workflow.
//
// WHAT THIS PINS
//   A. teacher-dashboard renders TeacherDashboard, never Readiness.
//   B. teacher-attendance renders TeacherDashboard (attendance tab), never Readiness.
//   C. teacher-readiness renders TeacherReadinessView, with its OWN return.
//   D. The three sidebar destinations are distinct keys with distinct labels.
//   E. Attendance actions (PRESENT/ABSENT/EXCUSED + status writes) stay reachable.
//   F. Dashboard overview widgets + the view→tab mapping stay reachable.
//   G. Readiness filters/actions exist only in the readiness view.
//   H. Phase H selectors use the themed Select (dark-mode safe), never native.
//
// The dispatch checks simulate the switch (case → next return), so a shared
// fall-through group fails loudly instead of silently re-sweeping keys.
//
// Run: node tests/teacher-navigation-regression.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node runner, repo convention */
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const failures = [];
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(label);
    console.error("FAIL:", label);
  }
};
const section = (t) => console.log(`\n${t}`);
// Code-only view: documentation comments name excluded concepts on purpose.
const stripComments = (src) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");

/** Simulate the renderView switch: every `case "k":` maps to the next `return <C`. */
function dispatchMap(src) {
  const cases = [...src.matchAll(/case "(teacher-[a-z-]+)":/g)].map((m) => ({
    key: m[1],
    at: m.index,
  }));
  const returns = [...src.matchAll(/return <(\w+)/g)].map((m) => ({
    component: m[1],
    at: m.index,
  }));
  const map = {};
  for (const c of cases) {
    const next = returns.find((r) => r.at > c.at);
    map[c.key] = next ? next.component : null;
  }
  return map;
}

function main() {
  const shell = read("src/components/app-shell.tsx");
  const dashboard = read("src/components/teacher/teacher-dashboard.tsx");
  const sidebar = read("src/components/dashboard/shell.tsx");
  const readiness = read("src/components/teacher/readiness-view.tsx");
  const adminVideos = read("src/components/admin/session-videos-view.tsx");

  section("A/B/C — app-shell dispatch (fall-through simulated)");
  const dispatch = dispatchMap(shell);
  const dashboardKeys = [
    "teacher-dashboard",
    "teacher-attendance",
    "teacher-quizzes",
    "teacher-homework",
    "teacher-templates",
    "teacher-analytics",
    "teacher-notifications",
  ];
  for (const key of dashboardKeys) {
    ok(
      dispatch[key] === "TeacherDashboard",
      `${key} renders TeacherDashboard (got ${dispatch[key]})`
    );
  }
  ok(
    dispatch["teacher-readiness"] === "TeacherReadinessView",
    `teacher-readiness renders TeacherReadinessView (got ${dispatch["teacher-readiness"]})`
  );
  // The readiness case owns its return: no other teacher case may fall into
  // TeacherReadinessView (the exact regression shape).
  const readinessTargets = Object.entries(dispatch)
    .filter(([, c]) => c === "TeacherReadinessView")
    .map(([k]) => k);
  ok(
    readinessTargets.length === 1 && readinessTargets[0] === "teacher-readiness",
    `only teacher-readiness resolves to TeacherReadinessView (got [${readinessTargets}])`
  );
  ok(
    /case "teacher-readiness":\s*return <TeacherReadinessView \/>/.test(shell),
    "teacher-readiness case is immediately followed by its own return (no shared group)"
  );
  // Untouched neighbors stay put (the attendance authority + sessions workspace).
  ok(
    dispatch["teacher-live-sessions"] === "TeacherLiveSessionsWorkspace",
    "teacher-live-sessions still renders the live workspace (Phase F authority)"
  );
  ok(
    dispatch["teacher-sessions"] === "TeacherSessions",
    "teacher-sessions still renders the session workspace"
  );

  section("D — sidebar destinations are distinct");
  const navKeys = [...sidebar.matchAll(/\{ key: "(teacher-[a-z-]+)", label: "([^"]+)"/g)];
  const byKey = new Map(navKeys.map((m) => [m[1], m[2]]));
  ok(byKey.has("teacher-dashboard"), "sidebar has a teacher-dashboard destination");
  ok(byKey.has("teacher-attendance"), "sidebar has a teacher-attendance destination");
  ok(byKey.has("teacher-readiness"), "sidebar has a teacher-readiness destination");
  const labels = [byKey.get("teacher-dashboard"), byKey.get("teacher-attendance"), byKey.get("teacher-readiness")];
  ok(
    new Set(labels).size === 3,
    `the three destinations have distinct labels (got [${labels}])`
  );
  ok(byKey.get("teacher-readiness") === "shell.044", "readiness keeps its own label (shell.044)");

  section("E — attendance actions reachable");
  ok(
    dashboard.includes('{tabValue === "attendance" && <AttendanceView />}'),
    "dashboard renders AttendanceView on the attendance tab"
  );
  ok(
    dashboard.includes('view.startsWith("teacher-attendance")') &&
      dashboard.includes('? "attendance"'),
    "teacher-attendance view maps to the attendance tab"
  );
  ok(
    /type AttendanceStatus = "PRESENT" \| "ABSENT" \| "LATE" \| "EXCUSED"/.test(dashboard),
    "attendance status vocabulary (PRESENT/ABSENT/LATE/EXCUSED) intact"
  );
  ok(
    dashboard.includes('setStatus(s.id, "PRESENT")') &&
      dashboard.includes('setStatus(s.id, "ABSENT")') &&
      dashboard.includes("EXCUSED"),
    "per-student PRESENT/ABSENT/EXCUSED marking actions intact"
  );

  section("F — dashboard widgets reachable");
  ok(
    dashboard.includes('{tabValue === "overview" && <OverviewView />}'),
    "dashboard renders OverviewView on the overview tab"
  );
  ok(
    dashboard.includes('<TabsTrigger value="overview"') &&
      dashboard.includes('<TabsTrigger value="attendance"'),
    "overview + attendance tab triggers intact"
  );
  ok(
    /:\s*"overview";/.test(dashboard),
    "teacher-dashboard (default) maps to the overview tab"
  );
  ok(
    dashboard.includes('view.startsWith("teacher-quizzes")') &&
      dashboard.includes('view.startsWith("teacher-homework")'),
    "quiz/homework view→tab mapping intact"
  );

  section("G — readiness exists only where intended");
  ok(readiness.includes('id="readiness-lesson"'), "readiness has the lesson selector");
  ok(readiness.includes('id="readiness-group"'), "readiness has the group selector");
  ok(
    readiness.includes('"READY"') && readiness.includes('"NOT_READY"'),
    "readiness has the Ready / Not Ready filters"
  );
  ok(
    readiness.includes('tr("teacher.readiness.remind")'),
    "reminder action lives on the readiness flow"
  );
  const dashboardCode = stripComments(dashboard);
  ok(
    !dashboardCode.includes("TeacherReadinessView") &&
      !dashboardCode.includes("readiness-lesson") &&
      !dashboardCode.includes("readiness-group") &&
      !dashboardCode.includes("teacher.readiness."),
    "TeacherDashboard contains no readiness UI (no import, no selectors, no keys)"
  );

  section("H — themed selectors (dark-mode safe), no native popups");
  for (const [name, src] of [
    ["readiness-view", readiness],
    ["admin session-videos-view", adminVideos],
  ]) {
    ok(
      src.includes('from "@/components/ui/select"'),
      `${name} uses the themed Select component`
    );
    ok(
      src.includes("SelectTrigger") && src.includes("SelectContent") && src.includes("SelectItem"),
      `${name} renders SelectTrigger + SelectContent + SelectItem`
    );
    const code = stripComments(src);
    ok(
      !/<select[\s>]/.test(code) && !/<option[\s>]/.test(code) && !/<optgroup[\s>]/.test(code),
      `${name} has no native select/option/optgroup popups (code, comments stripped)`
    );
  }
  // The themed primitives themselves are token-driven (both modes by construction).
  const uiSelect = read("src/components/ui/select.tsx");
  ok(
    uiSelect.includes("bg-popover") && uiSelect.includes("text-popover-foreground"),
    "ui/select popup uses popover theme tokens (light + dark)"
  );

  console.log(`\nteacher-navigation-regression: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
