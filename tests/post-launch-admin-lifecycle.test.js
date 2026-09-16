/**
 * Post-launch ADMIN LIFECYCLE + PERF regression test.
 *
 * Pins the safety invariants added by the post-launch audit (Sections 2, 5
 * and 8), then runs the full lifecycle verifier (real compiled handlers over
 * real SQLite — the repo's standard harness).
 *
 * Run: node tests/post-launch-admin-lifecycle.test.js
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

// ---------------------------------------------------------------------------
// Source pins — lifecycle guards must remain in the codebase
// ---------------------------------------------------------------------------
const groupIdRoute = read("src/app/api/admin/groups/[id]/route.ts");
assert(groupIdRoute.includes("api.294"), "group DELETE must refuse while students exist (api.294)");
assert(groupIdRoute.includes("api.295"), "group DELETE must refuse while sessions exist (api.295)");
assert(groupIdRoute.includes("GROUP_DELETED"), "group DELETE must audit GROUP_DELETED");

const teacherIdRoute = read("src/app/api/admin/teachers/[id]/route.ts");
assert(teacherIdRoute.includes("api.296"), "teacher DELETE must refuse while history exists (api.296)");
assert(teacherIdRoute.includes("api.297"), "teacher PATCH must validate name (api.297)");
assert(teacherIdRoute.includes("ADMIN_TEACHER_EMAIL_CHANGED"), "teacher email change must revoke all sessions");
assert(teacherIdRoute.includes("TEACHER_DELETED"), "teacher DELETE must audit TEACHER_DELETED");
assert(teacherIdRoute.includes("userId: null"), "teacher DELETE must UNLINK (not delete) application history");
assert(teacherIdRoute.includes("ACCOUNT_DELETED"), "teacher DELETE must log the ACCOUNT_DELETED security event");

const courseIdRoute = read("src/app/api/admin/courses/[id]/route.ts");
assert(courseIdRoute.includes("api.298"), "course DELETE must refuse while referenced (api.298)");
assert(courseIdRoute.includes("COURSE_UPDATED"), "course PATCH must audit COURSE_UPDATED");
assert(courseIdRoute.includes("COURSE_DELETED"), "course DELETE must audit COURSE_DELETED");
assert(
  /const data: \{ name\?: string; nameAr\?: string; description\?: string; color\?: string \}/.test(courseIdRoute),
  "course PATCH must stay metadata-only (slug and curriculum structure are NOT editable)"
);

const questionIdRoute = read("src/app/api/admin/question-bank/[id]/route.ts");
assert(questionIdRoute.includes("api.245"), "question PATCH must lock grading fields under attempts (api.245)");
assert(questionIdRoute.includes("api.246"), "question DELETE must refuse FIXED exam pins (api.246)");
assert(questionIdRoute.includes("api.247"), "question DELETE must refuse frozen answer history (api.247)");
assert(questionIdRoute.includes("acquireQuizDestructiveLock"), "question DELETE must hold the quiz destructive lock (Phase 26D)");
assert(
  /loaded\.quiz \? loaded\.quiz\.trackScope : "SHARED"/.test(questionIdRoute),
  "question PATCH must validate bank-only questions against SHARED scope (never fail-closed on them)"
);

const schema = read("prisma/schema.prisma");
const teacherModel = /model Teacher \{[\s\S]*?\n\}/.exec(schema);
assert(teacherModel && /user\s+User\s+@relation\(fields: \[userId\], references: \[id\], onDelete: Cascade\)/.test(teacherModel[0]),
  "Teacher.userId must keep onDelete: Cascade so deleting an unused teacher's user removes the profile row");

// ---------------------------------------------------------------------------
// Source pins — Section 8 performance fixes (and the security floor)
// ---------------------------------------------------------------------------
const overviewRoute = read("src/app/api/admin/overview/route.ts");
const overviewScans = (overviewRoute.match(/db\.payment\.findMany/g) || []).length;
assert(overviewScans === 1, `admin overview must issue ONE approved-payments scan (found ${overviewScans})`);
assert(overviewRoute.includes("approvedSinceTrend"), "admin overview must bucket the 6-month trend in JS from the single scan");
assert(!/for \(let i = 5; i >= 0; i--\) \{[\s\S]{0,400}db\.payment\.findMany/.test(overviewRoute),
  "admin overview must not query payments per-month in a loop");

const dashRoute = read("src/app/api/teacher/dashboard/route.ts");
assert(dashRoute.includes("Concurrent read plan"), "teacher dashboard must keep its concurrent read plan");
assert(dashRoute.includes("groupsPromise") && dashRoute.includes("totalPendingPromise"),
  "teacher dashboard must run its read chains concurrently");
assert(!/nextSession = await db\.liveSession\.findFirst/.test(dashRoute),
  "teacher dashboard must derive nextSession from the group's sessions (no extra query per group)");

const authRoute = read("src/app/api/auth/[action]/route.ts");
assert(/Promise\.all\(\[\s*resetRateLimit\("login:id", loginIdKey\)/.test(authRoute),
  "login success path must run resetRateLimit + logSecurityEvent concurrently");
const ipCheckIdx = authRoute.indexOf('checkRateLimit(\n      "login:ip"');
const idCheckIdx = authRoute.indexOf('checkRateLimit(\n      "login:id"');
assert(ipCheckIdx >= 0 && idCheckIdx > ipCheckIdx,
  "login rate-limit CHECKS must stay sequential: IP first, then per-identity");

const authLib = read("src/lib/auth.ts");
assert((authLib.match(/scryptSync\(password, salt, 64\)/g) || []).length === 2,
  "password hashing must remain scrypt with a 64-byte key — never weakened for speed");

// ---------------------------------------------------------------------------
// Run the lifecycle verifier (real handlers + real SQLite)
// ---------------------------------------------------------------------------
console.log("[LIFECYCLE-TEST] running verify-post-launch-admin-lifecycle.mjs...");
try {
  execFileSync(process.execPath, [path.join(ROOT, "scripts/verify-post-launch-admin-lifecycle.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, SECURITY_HASH_SECRET: "lifecycle-test-secret-0123456789abcdef" },
    timeout: 180000,
  });
} catch (e) {
  console.error("[LIFECYCLE-TEST] verifier failed");
  process.exit(1);
}

console.log("[LIFECYCLE-TEST] PASS — all source pins and verifier checks passed");
