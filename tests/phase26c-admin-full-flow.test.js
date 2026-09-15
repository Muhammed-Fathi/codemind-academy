/**
 * Phase 26C — ADMIN FULL FLOW regression test.
 * Pins critical safety invariants introduced in 26C.
 * Runs the 26C verifier (real SQLite + real handlers) and checks source pins.
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// Source pins — ensure fixes remain in codebase
const studentPatch = fs.readFileSync(path.join(ROOT, "src/app/api/admin/students/[id]/route.ts"), "utf8");
assert(studentPatch.includes("pendingSchoolType"), "student PATCH must pre-parse pendingSchoolType");
assert(studentPatch.includes("api.285"), "student PATCH must enforce unclassified guard api.285");
assert(studentPatch.includes("api.286"), "student PATCH must enforce audience match api.286");
assert(studentPatch.includes("api.085"), "student PATCH must enforce inactive group api.085");
assert(studentPatch.includes("api.274"), "student PATCH must enforce capacity api.274");
assert(studentPatch.includes("effectiveSchoolType"), "student PATCH must use effectiveSchoolType");

const groupPatch = fs.readFileSync(path.join(ROOT, "src/app/api/admin/groups/[id]/route.ts"), "utf8");
assert(groupPatch.includes("UNCLASSIFIED") || groupPatch.includes("api.285") || groupPatch.includes("trackScope"), "group PATCH must handle unclassified");

const plansRoute = fs.readFileSync(path.join(ROOT, "src/app/api/admin/plans/route.ts"), "utf8");
assert(plansRoute.includes("isActive"), "plans route must handle isActive toggle");
assert(plansRoute.includes("PLAN_CREATE"), "plans route must audit PLAN_CREATE");

const plansIdRoute = fs.readFileSync(path.join(ROOT, "src/app/api/admin/plans/[id]/route.ts"), "utf8");
assert(plansIdRoute.includes("PLAN_ENABLED") || plansIdRoute.includes("PLAN_DISABLED"), "plans [id] must audit enable/disable");
assert(plansIdRoute.includes("active subscriptions") || plansIdRoute.includes("ACTIVE"), "plans DELETE must guard active subs");

const teacherRoute = fs.readFileSync(path.join(ROOT, "src/app/api/admin/teachers/[id]/route.ts"), "utf8");
assert(teacherRoute.includes("isActive"), "teacher [id] must handle isActive");
assert(teacherRoute.includes("ACCOUNT_DEACTIVATED") || teacherRoute.includes("TEACHER_DEACTIVATED"), "teacher deactivation must log security/audit");

const dashboard = fs.readFileSync(path.join(ROOT, "src/components/admin/admin-dashboard.tsx"), "utf8");
assert(dashboard.includes("Subscription Plans") || dashboard.includes("Sale Control"), "SubscriptionsView must include plan toggle UI");
assert(dashboard.includes("/api/admin/plans"), "dashboard must call /api/admin/plans");
assert(dashboard.includes("Deactivate") || dashboard.includes("Reactivate"), "TeachersView must include deactivate/reactivate");

// Run the 26C verifier
console.log("[26C-TEST] running verify-phase26c-admin.mjs...");
try {
  execFileSync(process.execPath, [path.join(ROOT, "scripts/verify-phase26c-admin.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, SECURITY_HASH_SECRET: "phase26c-test-secret-0123456789abcdef" },
    timeout: 120000,
  });
} catch (e) {
  console.error("[26C-TEST] verifier failed");
  process.exit(1);
}

console.log("[26C-TEST] PASS — all source pins and verifier passed");
