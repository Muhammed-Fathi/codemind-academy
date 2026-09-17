/**
 * Post-launch regression test — notifications fix, teacher→parent notes,
 * plan management lifecycle, footer contact redesign.
 *
 * Two halves, like the 26C/26D/26E suites:
 *   1. source pins for every post-launch fix, so a later refactor cannot
 *      silently drop one;
 *   2. the post-launch verifier itself
 *      (`scripts/verify-post-launch-notifications.mjs`) run against a REAL
 *      migrated SQLite database with the SHIPPED TypeScript compiled by the
 *      repo's own tsc — no mocks of the route bodies.
 *
 * The verifier is read-only by construction: it refuses to start against a
 * Postgres/Neon URL and works on a scratch in-memory database.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), "utf8");
}

// ---------------------------------------------------------------------------
// 1. NOTIFICATIONS FIX — one shared definition of "which views exist per role"
// ---------------------------------------------------------------------------
const viewRoles = read("src/lib/view-roles.ts");
assert(
  viewRoles.includes("export const VIEWS_BY_ROLE"),
  "view-roles must export VIEWS_BY_ROLE (single source of truth)"
);
assert(
  viewRoles.includes("export function isViewForRole"),
  "view-roles must export isViewForRole"
);
for (const role of ["STUDENT", "TEACHER", "PARENT", "ADMIN"]) {
  assert(
    viewRoles.includes(`${role}: [`),
    `view-roles must cover the ${role} role`
  );
}
assert(
  /TEACHER: \[[\s\S]*?"teacher-notifications"/.test(viewRoles),
  "teacher-notifications must be a whitelisted TEACHER view"
);
assert(
  /PARENT: \[[\s\S]*?"parent-notifications"/.test(viewRoles),
  "parent-notifications must be a whitelisted PARENT view"
);

const shell = read("src/components/dashboard/shell.tsx");
assert(
  shell.includes("NOTIFICATION_VIEW_BY_ROLE"),
  "shell must route the bell per role (NOTIFICATION_VIEW_BY_ROLE)"
);
assert(
  /TEACHER:\s*"teacher-notifications"/.test(shell),
  "the bell must send teachers to teacher-notifications"
);
assert(
  /PARENT:\s*"parent-notifications"/.test(shell),
  "the bell must send parents to parent-notifications"
);
assert(
  shell.includes("NOTIFICATIONS_CHANGED_EVENT"),
  "the bell must refresh on the shared changed-event (no polling)"
);
assert(
  /key: "teacher-notifications", label: "shell\.005"/.test(shell) &&
    /key: "parent-notifications", label: "shell\.005"/.test(shell),
  "teacher AND parent navs must expose a notifications item"
);

const appShell = read("src/components/app-shell.tsx");
assert(
  appShell.includes('from "@/lib/view-roles"'),
  "app-shell must import the shared role→view whitelist (no inline copy)"
);
assert(
  /case "teacher-notifications":\s*return <TeacherDashboard \/>;/.test(appShell),
  "app-shell must render teacher-notifications via TeacherDashboard"
);
assert(
  /case "parent-notifications":\s*return <ParentDashboard \/>;/.test(appShell),
  "app-shell must render parent-notifications via ParentDashboard"
);
assert(
  !/VIEWS_BY_ROLE\s*=\s*{/.test(appShell),
  "app-shell must NOT keep its own inline VIEWS_BY_ROLE copy"
);

// ---------------------------------------------------------------------------
// 2. SHARED PANEL — the single notifications UI
// ---------------------------------------------------------------------------
const panel = read("src/components/shared/notifications-panel.tsx");
assert(
  panel.includes("export function NotificationsPanel"),
  "the shared panel must export NotificationsPanel"
);
assert(
  panel.includes("export const NOTIFICATIONS_CHANGED_EVENT"),
  "the shared panel must export the changed-event constant"
);
assert(
  panel.includes("export function emitNotificationsChanged"),
  "the shared panel must export emitNotificationsChanged"
);
assert(
  panel.includes("resolveDeepLink") && panel.includes("isViewForRole"),
  "deep links must route ONLY through resolveDeepLink + isViewForRole"
);
assert(
  !panel.includes('navigate("student-notifications"'),
  "the shared panel must never hard-navigate to the student view"
);
for (const src of [
  "src/components/student/student-dashboard.tsx",
  "src/components/teacher/teacher-dashboard.tsx",
  "src/components/parent/parent-dashboard.tsx",
]) {
  const code = read(src);
  assert(
    code.includes("from \"@/components/shared/notifications-panel\""),
    `${src} must consume the shared NotificationsPanel`
  );
}

// ---------------------------------------------------------------------------
// 3. TEACHER → PARENT NOTES — write side of the existing TeacherNote model
// ---------------------------------------------------------------------------
const teacherNotesRoute = read("src/app/api/teacher/student-notes/route.ts");
assert(
  teacherNotesRoute.includes("getTeacherProfile"),
  "teacher notes must scope through the teacher's OWN groups"
);
assert(
  teacherNotesRoute.includes("createNotificationIfAllowed"),
  "each linked parent must be notified through the preference-aware helper"
);
assert(
  teacherNotesRoute.includes("TEACHER_NOTE_CREATE"),
  "note creation must be audit-logged"
);
assert(
  teacherNotesRoute.includes("boundedText"),
  "note input must be length-bounded at the edge"
);
assert(
  !/async function DELETE|async function PATCH/.test(teacherNotesRoute),
  "teacher notes are append-only history: no DELETE or PATCH route"
);
assert(
  /if \(!inScopeStudent\) return err\(tApi\("api\.299"\), 404\);/.test(
    teacherNotesRoute
  ),
  "out-of-scope students must fail closed with the SAME 404 as ghosts"
);

const teacherDash = read("src/components/teacher/teacher-dashboard.tsx");
assert(
  teacherDash.includes("StudentNotesDialog"),
  "the attendance surface must expose the notes dialog"
);
assert(
  teacherDash.includes("/api/teacher/student-notes"),
  "the teacher UI must call the scoped notes API"
);

const parentDash = read("src/components/parent/parent-dashboard.tsx");
assert(
  /view === "parent-notifications"/.test(parentDash),
  "the parent dashboard must route its own notifications view"
);
assert(
  parentDash.includes("enabled: view !== \"parent-notifications\""),
  "the parent dashboard query must not fire while in the notifications view"
);

// ---------------------------------------------------------------------------
// 4. PLAN LIFECYCLE — closed plans stay visible, unselectable, un-purchasable
// ---------------------------------------------------------------------------
const publicPlans = read("src/app/api/subscription-plans/route.ts");
assert(
  !publicPlans.includes("isActive: true"),
  "the public catalogue must NOT filter out closed plans"
);
assert(
  publicPlans.includes('{ isActive: "desc" }'),
  "the public catalogue must keep active plans first"
);

const planById = read("src/app/api/admin/plans/[id]/route.ts");
assert(
  planById.includes(
    "Cannot delete plan with active subscriptions — disable sale instead (isActive=false)"
  ) && planById.includes(", 409)"),
  "plan delete must still refuse active subscriptions (409)"
);
assert(
  planById.includes("Cannot hard-delete plan with history"),
  "plan delete must still refuse referenced history (409)"
);
assert(
  planById.includes("deleteSafe"),
  "the plan detail must surface whether hard delete is safe"
);
assert(
  planById.includes("requestedPlanId"),
  "plan delete must still count payment references"
);
assert(
  planById.includes("status: \"ACTIVE\"") &&
    planById.includes("anySubCount"),
  "the delete guard must count ACTIVE and ALL subscriptions separately"
);

const enroll = read("src/app/api/enroll/route.ts");
assert(
  /!plan\.isActive[\s\S]{0,120}api\.276|api\.276/.test(enroll),
  "enrollment must still refuse closed plans server-side (api.276)"
);

const adminDash = read("src/components/admin/admin-dashboard.tsx");
assert(
  adminDash.includes("PlanManagementCard"),
  "admin must have the full plan management card"
);
assert(
  adminDash.includes("PlanFormDialog"),
  "admin must be able to create and edit plans"
);
assert(
  adminDash.includes('"/api/admin/plans"'),
  "the plan card must hit the admin plans API"
);
assert(
  adminDash.includes("NotificationsPanel"),
  "the admin center must also show the admin's OWN notifications"
);

// ---------------------------------------------------------------------------
// 5. FOOTER — person + number travel together, from the single source of truth
// ---------------------------------------------------------------------------
const sections = read("src/components/landing/sections.tsx");
assert(
  sections.includes("SUPPORT_CONTACTS"),
  "the footer must use SUPPORT_CONTACTS (single source of truth)"
);
assert(
  sections.includes("tr(\"foot.001\")") &&
    sections.includes("tr(\"foot.002\")") &&
    sections.includes("tr(\"foot.003\")"),
  "the footer must use the i18n role labels (no hardcoded English)"
);
assert(
  !/>Technical Support</.test(sections),
  "the footer must not hardcode the English 'Technical Support' label"
);
assert(
  sections.includes("telLink(person.phoneDisplay)") &&
    sections.includes("whatsappLink(person.phoneIntl)"),
  "the footer must keep tel + WhatsApp actions on each contact row"
);

// ---------------------------------------------------------------------------
// 6. I18N — every new key must exist in the hand-maintained 2026 dict
// ---------------------------------------------------------------------------
const dict = read("src/lib/i18n-dict-2026.ts");
for (const key of [
  "api.299", "api.300", "api.301", "api.302",
  "teacher.205", "teacher.206", "teacher.207", "teacher.208", "teacher.209",
  "teacher.210", "teacher.211", "teacher.212", "teacher.213", "teacher.214",
  "plan.001", "plan.023", "plan.031", "plan.032", "plan.033",
  "foot.001", "foot.002", "foot.003",
  "notif.back", "notif.markAll", "notif.empty", "notif.retry",
  "notif.open", "notif.myTitle", "notif.unread", "notif.read",
  "notif.unreadCount", "notif.now", "notif.minAgo", "notif.hourAgo",
  "notif.dayAgo", "notif.loadError", "notif.emptyHint", "notif.markedAll",
]) {
  assert(
    dict.includes(`"${key}"`),
    `i18n key ${key} must exist in the 2026 dict`
  );
}

// ---------------------------------------------------------------------------
// 7. REAL DATABASE — run the shipped handlers end to end
// ---------------------------------------------------------------------------
console.log(
  "[POST-LAUNCH-TEST] running scripts/verify-post-launch-notifications.mjs ..."
);
try {
  execFileSync(
    process.execPath,
    [path.join(ROOT, "scripts/verify-post-launch-notifications.mjs")],
    {
      cwd: ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        SECURITY_HASH_SECRET:
          "post-launch-test-secret-0123456789abcdef",
      },
      timeout: 300000,
    }
  );
} catch (e) {
  console.error("[POST-LAUNCH-TEST] verifier failed");
  process.exit(1);
}

console.log(
  "[POST-LAUNCH-TEST] PASS — notifications, teacher notes, plans and footer are green"
);
