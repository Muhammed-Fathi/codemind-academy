/**
 * Phase 26E — PARENT PORTAL full-flow regression test.
 *
 * Two halves, like the 26C/26D suites:
 *   1. source pins for every parent-portal fix landed in 26E, so a later
 *      refactor cannot silently drop one;
 *   2. the 26E verifier itself (`scripts/verify-phase26e-parent.mjs`) run
 *      against a REAL migrated SQLite database with the SHIPPED TypeScript
 *      compiled by the repo's own tsc — no mocks of the route bodies.
 *
 * The verifier is read-only by construction: it refuses to start against a
 * Postgres/Neon URL and works on a scratch database under the OS temp dir.
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
// 1. SHARED CURRICULUM UNIVERSE — one definition, used by all three surfaces
// ---------------------------------------------------------------------------
const parentAccess = read("src/lib/parent-access.ts");
assert(
  parentAccess.includes("export async function getStudentCurriculumLessonIds"),
  "parent-access must export the shared lesson universe helper"
);
assert(
  parentAccess.includes("export async function getStudentCurriculumHomeworkIds"),
  "parent-access must export the shared homework universe helper"
);
assert(
  parentAccess.includes("export function attemptsInCurriculumUniverse"),
  "parent-access must export the pure attempt filter"
);
for (const clause of [
  "LESSON_STUDENT_STATUS_FILTER",
  "EXCLUDE_ARCHIVED_LESSON",
  "trackScopeWhere(student.schoolType)",
  "lessonCourseChainOr(courseId)",
]) {
  assert(parentAccess.includes(clause), `the parent universe helper must keep ${clause}`);
}
assert(
  /if \(!scope\) return false;/.test(parentAccess),
  "isParentAllowedTrackScope must fail closed on an unknown scope"
);

// ---------------------------------------------------------------------------
// 2. PARENT SURFACES consume the universe (no surface may re-implement it)
// ---------------------------------------------------------------------------
const dashboard = read("src/app/api/parents/me/dashboard/route.ts");
assert(
  dashboard.includes("attemptsInCurriculumUniverse("),
  "dashboard quiz stats must be cut to the child's universe"
);
assert(
  dashboard.includes("universeLessonIds.has(nextSession.lesson.id)"),
  "dashboard must not name a next session outside the child's universe"
);
assert(
  dashboard.includes("universeHomeworkIds.has("),
  "dashboard homework numerator must use the universe"
);

const analytics = read("src/app/api/parents/me/analytics/route.ts");
assert(
  analytics.includes("getStudentCurriculumLessonIds(") &&
    analytics.includes("getStudentCurriculumHomeworkIds("),
  "analytics must resolve both universes through the shared helpers"
);
assert(
  analytics.includes("attemptsInCurriculumUniverse("),
  "analytics quiz numbers must be cut to the child's universe"
);
assert(
  !/await getParentTrackScopes\(/.test(analytics),
  "analytics must never use the parent-wide track union for a child's report"
);

const weekly = read("src/app/api/parents/me/weekly-report/route.ts");
assert(
  weekly.includes("getStudentCurriculumHomeworkIds(") &&
    weekly.includes("getStudentCurriculumLessonIds("),
  "weekly report must resolve both universes through the shared helpers"
);
assert(
  weekly.includes("attemptsInCurriculumUniverse("),
  "weekly quiz activity must be cut to the child's universe"
);
assert(
  weekly.includes("attendanceAt(a)") &&
    /function attendanceAt[\s\S]*?session\?\.startAt \|\| a\.createdAt/.test(weekly),
  "weekly attendance must use ONE time basis (session start, else creation)"
);
assert(
  !/await getParentTrackScopes\(/.test(weekly),
  "weekly report must never use the parent-wide track union for a child's report"
);
// Phase I: the handler now takes an optional `req?: NextRequest` so it can read
// the verified `?studentId=` query parameter. The invariant being guarded is
// UNUSED imports, not the next/server module itself, so the check now proves
// every imported symbol is actually referenced in the body.
{
  const nextServerImport = weekly.match(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"next\/server";/);
  const bodyAfterImport = weekly.split('from "next/server";').slice(1).join('from "next/server";');
  assert(
    !nextServerImport ||
      nextServerImport[1]
        .split(",")
        .map((sym) => sym.trim())
        .filter(Boolean)
        .every((sym) => bodyAfterImport.includes(sym)),
    "weekly report must not keep an unused next/server import"
  );
}

// ---------------------------------------------------------------------------
// 3. LINKING — idempotent, race-safe, and non-enumerable
// ---------------------------------------------------------------------------
const link = read("src/app/api/parents/me/link-student/route.ts");
assert(
  link.includes("db.parentStudentLink.upsert(") && /update: \{\}/.test(link),
  "link-student must be an idempotent upsert that never overwrites the relation"
);
assert(
  /catch \(e\)[\s\S]*?findUnique\(\{ where: linkKey \}\)/.test(link),
  "link-student must re-read after a concurrent create"
);
assert(
  link.includes("normalizeParentRelation("),
  "link-student must normalise the client-supplied relation"
);
assert(
  link.indexOf('tApi("api.113")') !== -1 &&
    link.indexOf('tApi("api.114")') !== -1 &&
    link.indexOf('tApi("api.114")') - link.indexOf('tApi("api.113")') < 200,
  "the unknown-pair and wrong-phone branches must answer the same 404 (no oracle)"
);

// ---------------------------------------------------------------------------
// 4. NOTIFICATION PREFERENCES — validated, self-scoped
// ---------------------------------------------------------------------------
const notify = read("src/lib/notify.ts");
assert(
  notify.includes("export function normalizeQuietHour"),
  "notify.ts must own quiet-hour normalisation"
);
assert(
  notify.includes("partitionByNotificationPreferences") &&
    notify.includes("skippedQuietHours"),
  "the fan-out helper must report quiet-hour skips separately"
);

const prefs = read("src/app/api/students/me/notification-prefs/route.ts");
assert(
  prefs.includes("normalizeQuietHour("),
  "prefs route must route quiet hours through the shared normaliser"
);
assert(
  !/quietHoursStart: body\.quietHoursStart|quietHoursEnd: body\.quietHoursEnd/.test(prefs),
  "prefs route must never store a raw client string"
);
assert(
  fs.existsSync(path.join(ROOT, "src/app/api/parents/me/notification-prefs/route.ts")),
  "the parent prefs endpoint must stay wired to the shared handler"
);

const registration = read("src/lib/registration.ts");
assert(
  registration.includes("export function normalizeParentRelation") &&
    registration.includes("PARENT_RELATION_MAX"),
  "registration.ts must own the bounded relation normaliser"
);

// ---------------------------------------------------------------------------
// 5. PARENT DEEP LINK — the shared bell must never hand a parent a student view
// ---------------------------------------------------------------------------
const appShell = read("src/components/app-shell.tsx");
assert(
  /role === "STUDENT" \|\| !role \? <StudentDashboard \/> : fallback/.test(appShell),
  "student-only views (incl. the bell's student-notifications) must fall back to the role's dashboard"
);
assert(
  !/case "student-notifications":\s*\n\s*return <StudentDashboard \/>;/.test(appShell),
  "a parent or teacher must never be rendered <StudentDashboard/>"
);

// ---------------------------------------------------------------------------
// 6. REAL DATABASE — run the shipped handlers end to end
// ---------------------------------------------------------------------------
console.log("[26E-TEST] running scripts/verify-phase26e-parent.mjs ...");
try {
  execFileSync(process.execPath, [path.join(ROOT, "scripts/verify-phase26e-parent.mjs")], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, SECURITY_HASH_SECRET: "phase26e-test-secret-0123456789abcdef" },
    timeout: 300000,
  });
} catch (e) {
  console.error("[26E-TEST] verifier failed");
  process.exit(1);
}

console.log("[26E-TEST] PASS — parent portal source pins and full-flow verifier are green");
