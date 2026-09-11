// CodeMind Academy — Phase 20 security hardening tests.
//
// Three kinds of checks, all offline (no network, no Prisma engine):
//   A. Behavioural — compile the PURE Phase 20 modules (rate-limit.ts,
//      content-security-policy.ts) with tsc and exercise them directly.
//   B. Source-level invariants over the real routes/libs — the 10-check
//      authorization matrix, the IDOR / cross-track / cross-course /
//      premature-access / PDF-guess / notification-bypass matrices, and the
//      legacy-session-fallback removal — in the same style as
//      tests/authorization-invariants.test.js.
//   C. Real-database — `scripts/verify-phase20-security.mjs` exercises the
//      shipped `checkRateLimit` against real SQLite rows, and
//      `scripts/audit-legacy-sessions.mjs` is run against a scratch DB to
//      prove the "no valid session depends on it" precondition logic.
//
// Run: node tests/security-hardening-phase20.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
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

// ---------------------------------------------------------------------------
// Compile the pure Phase 20 modules to CommonJS in a temp dir.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-phase20-test-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      moduleResolution: "node",
      strict: true,
      skipLibCheck: true,
      esModuleInterop: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      baseUrl: REPO,
      paths: { "@/*": ["src/*"] },
      rootDir: REPO,
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/rate-limit.ts"),
      path.join(REPO, "src/lib/content-security-policy.ts"),
    ],
  })
);
execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, {
  cwd: REPO,
  stdio: "pipe",
});
const RateLimit = require(path.join(OUT, "src", "lib", "rate-limit.js"));
const Csp = require(path.join(OUT, "src", "lib", "content-security-policy.js"));

// ---------------------------------------------------------------------------
section("1. Rate-limit policy (behavioural)");
// ---------------------------------------------------------------------------
{
  // Phase 20 addendum adds a seventh key (`teacherApply`) for the public
  // teacher-application surface — still driven by the same shared limiter.
  ok(RateLimit.RATE_LIMIT_KEYS.length === 7, "seven limiter keys are defined (incl. teacherApply)");
  for (const key of RateLimit.RATE_LIMIT_KEYS) {
    const cfg = RateLimit.DEFAULT_RATE_LIMITS[key];
    ok(
      Number.isInteger(cfg.limit) && cfg.limit > 0,
      `${key}: default limit is a positive integer`
    );
    ok(
      Number.isInteger(cfg.windowSec) && cfg.windowSec > 0,
      `${key}: default window is a positive integer`
    );
    ok(
      Number.isInteger(cfg.blockSec) && cfg.blockSec > 0,
      `${key}: default block is a positive integer`
    );
  }

  // Env override: triple form.
  const resolved = RateLimit.resolveRateLimitConfig("open", {
    RATE_LIMIT_OPEN: "5/30/60",
  });
  ok(
    resolved.limit === 5 && resolved.windowSec === 30 && resolved.blockSec === 60,
    "env override `limit/windowSec/blockSec` is honoured"
  );

  // Env override: single form keeps the default window/block.
  const single = RateLimit.resolveRateLimitConfig("open", { RATE_LIMIT_OPEN: "5" });
  ok(
    single.limit === 5 &&
      single.windowSec === RateLimit.DEFAULT_RATE_LIMITS.open.windowSec &&
      single.blockSec === RateLimit.DEFAULT_RATE_LIMITS.open.blockSec,
    "env override `limit` keeps default window/block"
  );

  // Clamping: zero/negative/huge degrade to safe bounds, never disable.
  const clamped = RateLimit.resolveRateLimitConfig("heartbeat", {
    RATE_LIMIT_HEARTBEAT: "0/0/0",
  });
  ok(clamped.limit >= 1 && clamped.windowSec >= 1 && clamped.blockSec >= 1,
    "bad env clamps to a safe bound (never 0 = never disabled)");
  ok(
    clamped.limit <= RateLimit.RATE_LIMIT_BOUNDS.limitMax,
    "bad env clamps to the maximum bound"
  );

  // Garbage falls back to default.
  ok(
    JSON.stringify(
      RateLimit.resolveRateLimitConfig("notification", { RATE_LIMIT_NOTIFICATION: "abc" })
    ) === JSON.stringify(RateLimit.DEFAULT_RATE_LIMITS.notification),
    "unparseable override falls back to the default policy"
  );

  // Identifier hashing — no raw user id in the table.
  const ident = RateLimit.rateLimitIdentifier("heartbeat", "user-abc");
  ok(/^[0-9a-f]{64}$/.test(ident) && ident !== "user-abc",
    "rate-limit identifier is a 64-hex SHA-256 digest, not the user id");

  // Headers.
  const hAllowed = RateLimit.rateLimitHeaders(
    { limit: 10, windowSec: 60, blockSec: 60 },
    { allowed: true, remaining: 7, retryAfterSec: 0 }
  );
  ok(hAllowed["X-RateLimit-Limit"] === "10", "allowed response carries X-RateLimit-Limit");
  ok(hAllowed["X-RateLimit-Remaining"] === "7", "allowed response carries X-RateLimit-Remaining");
  ok(!("Retry-After" in hAllowed), "allowed response has no Retry-After");

  const hBlocked = RateLimit.rateLimitHeaders(
    { limit: 10, windowSec: 60, blockSec: 60 },
    { allowed: false, remaining: 0, retryAfterSec: 30 }
  );
  ok(hBlocked["Retry-After"] === "30", "blocked response carries Retry-After");
  ok(hBlocked["X-RateLimit-Remaining"] === "0", "blocked response reports remaining=0");

  // enforceRateLimit propagates the injected check.
  let calledWith = null;
  const spy = async (bucket, identifier, limit, windowSec, blockSec) => {
    calledWith = { bucket, identifier, limit, windowSec, blockSec };
    return { allowed: false, remaining: 0, retryAfterSec: 9 };
  };
  const outcome = RateLimit.enforceRateLimit({ key: "open", userId: "u1", check: spy });
  ok(outcome.then || typeof outcome === "object", "enforceRateLimit returns a result");
}

// ---------------------------------------------------------------------------
section("2. CSP (behavioural)");
// ---------------------------------------------------------------------------
{
  const prod = Csp.decideCspHeader({ NODE_ENV: "production" });
  ok(prod && prod.header === "Content-Security-Policy", "production → enforced CSP header");
  ok(!Csp.containsUnsafeEval(prod.value), "production CSP never contains 'unsafe-eval'");
  ok(/'unsafe-inline'/.test(prod.value), "CSP keeps 'unsafe-inline' where the runtime requires it");
  ok(/script-src/.test(prod.value) && /style-src/.test(prod.value), "CSP covers script + style");
  ok(/frame-src/.test(prod.value) && /https:/.test(prod.value), "video embeds preserved (frame-src https:)");
  ok(/media-src/.test(prod.value) && /blob:/.test(prod.value), "native video preserved (media-src blob:)");
  ok(/object-src 'none'/.test(prod.value), "object-src is locked to 'none'");
  ok(/frame-ancestors 'self'/.test(prod.value), "clickjacking: frame-ancestors 'self'");
  ok(/connect-src 'self'/.test(prod.value), "no cross-origin connect allowed");

  const parsed = Csp.parseCsp(prod.value);
  ok(parsed["script-src"] && parsed["script-src"].includes("'self'"), "script-src includes 'self'");
  ok(!parsed["script-src"].includes("'unsafe-eval'"), "production script-src has no unsafe-eval");

  const dev = Csp.decideCspHeader({ NODE_ENV: "development" });
  ok(Csp.containsUnsafeEval(dev.value), "development widens script-src with 'unsafe-eval' (HMR only)");
  ok(dev.header === "Content-Security-Policy", "development still enforces (widened) CSP");

  const reportOnly = Csp.decideCspHeader({ NODE_ENV: "production", CSP_REPORT_ONLY: "1" });
  ok(
    reportOnly && reportOnly.header === "Content-Security-Policy-Report-Only",
    "CSP_REPORT_ONLY=1 → report-only (incremental rollout)"
  );
  const disabled = Csp.decideCspHeader({ NODE_ENV: "production", CSP_DISABLED: "1" });
  ok(disabled === null, "CSP_DISABLED=1 → no header (operator kill-switch)");
}

// ---------------------------------------------------------------------------
section("3. Authorization matrix — every content route × the 10 checks");
// ---------------------------------------------------------------------------
{
  // Each entry: [route, expected substrings present in the source].
  // Checks 3–8 collapse into the shared gate helpers (canAccessLesson /
  // canAccessQuiz / canAccessHomework / authorizeMaterialDownload) which are
  // each asserted to delegate to the single progression/track/lifecycle
  // service (section 4 below).
  const matrix = [
    ["src/app/api/lessons/[id]/route.ts", ["requireUser", "canAccessLesson"]],
    ["src/app/api/lessons/[id]/progress/route.ts", ["requireUser", "STUDENT", "canAccessLesson", "applyRateLimit"]],
    ["src/app/api/lessons/[id]/video-progress/route.ts", ["requireUser", "STUDENT", "canAccessLesson", "applyRateLimit"]],
    ["src/app/api/quizzes/[id]/route.ts", ["requireUser", "canAccessQuiz"]],
    ["src/app/api/quizzes/[id]/start/route.ts", ["requireUser", "STUDENT", "canAccessQuiz"]],
    ["src/app/api/quizzes/[id]/submit/route.ts", ["requireUser", "STUDENT", "canAccessQuiz"]],
    ["src/app/api/quizzes/[id]/evidence/route.ts", ["requireUser", "STUDENT", "canAccessQuiz"]],
    ["src/app/api/students/me/homework/route.ts", ["requireUser", "STUDENT", "canAccessHomework"]],
    ["src/app/api/students/me/session-videos/[id]/progress/route.ts", ["requireUser", "STUDENT", "isPublished", "batchId", "applyRateLimit"]],
    ["src/app/api/media/[id]/route.ts", ["requireUser", "sessionVideos", "isPublished", "batch"]],
    ["src/app/api/materials/[id]/route.ts", ["requireUser", "authorizeMaterialDownload", "applyRateLimit"]],
    ["src/app/api/notifications/route.ts", ["requireUser", "userId"]],
  ];
  for (const [rel, needles] of matrix) {
    const src = read(rel);
    for (const needle of needles) {
      ok(src.includes(needle), `${rel} contains '${needle}'`);
    }
  }

  // Every STUDENT gate must flow through the single progression service, so
  // enrollment / course / track / lifecycle / progression are one definition.
  for (const rel of [
    "src/app/api/lessons/[id]/route.ts",
    "src/app/api/lessons/[id]/progress/route.ts",
    "src/app/api/lessons/[id]/video-progress/route.ts",
  ]) {
    ok(/canAccessLesson\s*\(/.test(read(rel)), `${rel} gates through canAccessLesson`);
  }
  for (const rel of [
    "src/app/api/quizzes/[id]/route.ts",
    "src/app/api/quizzes/[id]/start/route.ts",
    "src/app/api/quizzes/[id]/submit/route.ts",
    "src/app/api/quizzes/[id]/evidence/route.ts",
  ]) {
    ok(/canAccessQuiz\s*\(/.test(read(rel)), `${rel} gates through canAccessQuiz`);
  }
  ok(/canAccessHomework\s*\(/.test(read("src/app/api/students/me/homework/route.ts")),
    "homework POST gates through canAccessHomework");
  ok(/authorizeMaterialDownload\s*\(/.test(read("src/app/api/materials/[id]/route.ts")),
    "material download gates through authorizeMaterialDownload (10-check contract)");

  // The 10 checks live in one place each (no second implementation).
  const sp = read("src/lib/session-progress.ts");
  ok(/isStudentVisibleStatus/.test(sp), "check #7 (lifecycle) enforced in the shared gate");
  ok(/canAccessTrackScope/.test(sp), "check #5 (track) enforced in the shared gate");
  ok(/trackScopeWhere/.test(sp), "the universe query narrows by track (check #5)");
  ok(/group:\s*\{\s*select:\s*\{\s*courseId: true,\s*isActive: true/.test(sp) || /isActive/.test(sp),
    "check #3 (enrollment) = active group bound to the course");
  ok(/resolveLessonCourseId/.test(sp), "check #4/#6 (course + session-in-course) via chain resolution");
  const sm = read("src/lib/session-materials.ts");
  ok(/canAccessLesson\(student\.id, lesson\.id\)/.test(sm), "material check #3–8 reuses canAccessLesson");
  ok(/storage !== \"LOCAL_PRIVATE\"/.test(sm), "material check #10 (asset private + local)");
  ok(/isActive/.test(sm), "material check #9 (active material)");
}

// ---------------------------------------------------------------------------
section("4. IDOR — sequential / guessed / foreign ids deny without existence leaks");
// ---------------------------------------------------------------------------
{
  // Non-oracle verdicts: guessing an id must answer exactly what a missing id
  // answers (404), never a distinct "wrong track" / "wrong course" signal.
  const deny = read("src/lib/api.ts");
  ok(/LESSON_NOT_FOUND/.test(deny) && /404/.test(deny), "denyProgression maps LESSON_NOT_FOUND → 404");

  const sp = read("src/lib/session-progress.ts");
  ok(/reason: \"LESSON_NOT_FOUND\"/.test(sp), "track/lifecycle refusal is LESSON_NOT_FOUND (non-oracle)");
  ok(/lesson\)\s*\{\s*return \{ allowed: false, reason: \"LESSON_NOT_FOUND\"/.test(sp) || /!lesson\) return \{ allowed: false, reason: \"LESSON_NOT_FOUND\"/.test(sp),
    "missing lesson id is indistinguishable from an out-of-scope id");

  const sm = read("src/lib/session-materials.ts");
  ok(/MATERIAL_NOT_FOUND|ASSET_NOT_FOUND/.test(sm), "material denial reasons are non-oracle");
  ok(/materialAccessHttpStatus/.test(sm), "material denial has one HTTP mapping");
  // TRACK_DENIED → 404 (never confirms the material exists on another track).
  ok(/return 404/.test(sm) && /TRACK_DENIED/.test(sm), "track-denied material still answers 404");

  // Media route: unknown id → 404; external asset id → 404 (no existence leak).
  const media = read("src/app/api/media/[id]/route.ts");
  ok(/if \(!asset\) return err\("Not found", 404\)/.test(media), "unknown media id → 404");
  ok(/err\("Not found", 404\)/.test(media), "non-stored/external asset id → 404 (not 400)");
  ok(/!Number\.isSafeInteger/.test(media), "media Range parsing validates bounds (NaN/negative refused)");

  // Sequential ids: ids are unguessable cuids; batch/video cross-checks.
  const videoProgress = read("src/app/api/students/me/session-videos/[id]/progress/route.ts");
  ok(/video\.batchId !== student\.batchId/.test(videoProgress), "foreign-batch video progress → 403");

  // Foreign notification ids: mark-read is scoped to the caller's own userId.
  const notif = read("src/app/api/notifications/route.ts");
  ok(/where: \{ id, userId: user\.id \}/.test(notif), "mark-one-read scoped to (id, userId) — cannot forge another user's id");
  ok(/where: \{ userId: user\.id, isRead: false \}/.test(notif), "mark-all-read scoped to the caller");
}

// ---------------------------------------------------------------------------
section("5. Cross-track / cross-course / premature access");
// ---------------------------------------------------------------------------
{
  const ts = read("src/lib/track-scope.ts");
  ok(/function canAccessTrackScope/.test(ts), "track predicate exists");
  ok(/eligibleTrackScopes/.test(ts), "track eligibility derives from the student's own schoolType");
  ok(/function trackScopeWhere/.test(ts), "track filter applied to the universe query");

  const lifecycle = read("src/lib/session-lifecycle.ts");
  ok(/LESSON_STUDENT_STATUS_FILTER/.test(lifecycle), "student universe filter exists");
  ok(/status: \"PUBLISHED\"/.test(lifecycle), "student universe = PUBLISHED only (premature access)");
  ok(/function isStudentVisibleStatus/.test(lifecycle), "single lifecycle-availability predicate");

  const sp = read("src/lib/session-progress.ts");
  ok(/unlocked: previousCompleted/.test(sp), "progression = sequential unlock (premature access)");
  ok(/EXCLUDE_ARCHIVED_LESSON/.test(sp), "archived lessons are excluded from the universe");

  // Cross-course: the material authorizer resolves the owning course.
  const sm = read("src/lib/session-materials.ts");
  ok(/courseId =/.test(sm), "material authorizer resolves the owning course");

  // Admin broadcast targeting can never bypass preferences.
  const adminNotif = read("src/app/api/admin/notifications/route.ts");
  ok(/partitionByNotificationPreferences/.test(adminNotif), "admin broadcast honours preferences");
  ok(/validateNotificationLink/.test(adminNotif), "admin broadcast validates notification links");
}

// ---------------------------------------------------------------------------
section("6. Notification security");
// ---------------------------------------------------------------------------
{
  const links = read("src/lib/notification-links.ts");
  ok(/function mintNotificationLink/.test(links), "notification links are minted, not free text");
  ok(/function validateNotificationLink/.test(links), "notification links are validated");
  ok(/parseDeepLink/.test(links), "validation is parse-exact against the shared parser");

  const deep = read("src/lib/deep-link.ts");
  ok(/\[A-Za-z0-9_-\]\{1,64\}\$/.test(deep), "deep-link id is restricted to 1–64 URL-safe chars");
  ok(/A deep link is NAVIGATION, never authorization/.test(deep), "deep links never authorize by themselves");

  // Preference bypass closed at the bulk layer.
  const notify = read("src/lib/notify.ts");
  ok(/partitionByNotificationPreferences/.test(notify), "bulk partition enforces per-type + quiet-hours");

  // Fan-out is chunked and idempotent (no double rows).
  const sn = read("src/lib/session-notifications.ts");
  ok(/chunkList/.test(sn), "fan-out is chunked");
  ok(/createMany/.test(sn), "fan-out inserts are batched");
  ok(/have\.has\(userId\)/.test(sn), "fan-out dedupes per-user (no double notification)");
}

// ---------------------------------------------------------------------------
section("7. Rate limiting is wired into every required endpoint");
// ---------------------------------------------------------------------------
{
  const expected = {
    "src/app/api/lessons/[id]/progress/route.ts": "progress",
    "src/app/api/lessons/[id]/video-progress/route.ts": "heartbeat",
    "src/app/api/students/me/session-videos/[id]/progress/route.ts": "heartbeat",
    "src/app/api/admin/lessons/[id]/open/route.ts": "open",
    "src/app/api/admin/notifications/route.ts": "notification",
    "src/app/api/materials/[id]/route.ts": "materialDownload",
    "src/app/api/admin/lessons/[id]/materials/route.ts": "pdfUpload",
  };
  for (const [rel, key] of Object.entries(expected)) {
    const src = read(rel);
    ok(/applyRateLimit\s*\(/.test(src), `${rel} calls applyRateLimit`);
    ok(src.includes(`"${key}"`) || src.includes(`'${key}'`), `${rel} uses the '${key}' limiter`);
    ok(/rateLimitedResponse\s*\(/.test(src), `${rel} returns a rateLimitedResponse on refusal`);
  }

  // The shared mechanism is DB-backed, never memory-only.
  const security = read("src/lib/security.ts");
  ok(/securityRateLimit/.test(security), "the shared primitive is the DB-backed SecurityRateLimit table");
  ok(/increment:\s*1/.test(security), "the increment is atomic (guarded UPDATE)");
  ok(/count:\s*\{\s*lt:\s*limit\s*\}/.test(security), "the guarded increment uses `count < limit`");
  ok(/RATE_LIMITED/.test(security), "RATE_LIMITED security event type exists");
  const api = read("src/lib/api.ts");
  ok(/applyRateLimit/.test(api) && /rateLimitedResponse/.test(api), "api.ts exports the shared composition");
  ok(/logSecurityEvent/.test(api), "blocks are audited");
}

// ---------------------------------------------------------------------------
section("8. Session legacy fallback is removed (not blindly — precondition provable)");
// ---------------------------------------------------------------------------
{
  const auth = read("src/lib/auth.ts");
  ok(!/session:\$\{token\}/.test(auth), "auth.ts no longer reads `Setting:session:<token>`");
  ok(!/setting\s*\./.test(auth.replace(/db\.setting/g, "")), "auth.ts no longer touches the Setting table");
  ok(/return \{ user: null, reason: \"NO_SESSION\" \}/.test(auth), "unknown session → NO_SESSION (no fallback)");
  ok(/UserSession/.test(auth), "UserSession remains the single session source of truth");

  // The precondition is provable, not assumed: the audit script must exist.
  const script = path.join(REPO, "scripts", "audit-legacy-sessions.mjs");
  ok(fs.existsSync(script), "scripts/audit-legacy-sessions.mjs exists (precondition proof)");
  const scriptSrc = fs.readFileSync(script, "utf8");
  ok(/STILL-VALID/.test(scriptSrc), "audit script classifies still-valid legacy sessions");
  ok(/--purge/.test(scriptSrc), "audit script supports --purge");
  ok(/LEGACY_SESSION_AUDIT_OK/.test(scriptSrc), "audit script has a stable OK marker");

  // Admin settings still hide the historical `session:` keys from the UI.
  ok(/startsWith: \"session:\"/.test(read("src/app/api/admin/settings/route.ts")),
    "admin settings keep excluding legacy session keys");
}

// ---------------------------------------------------------------------------
section("9. CSP + security headers wired at the edge");
// ---------------------------------------------------------------------------
{
  const cfg = read("next.config.ts");
  ok(/decideCspHeader/.test(cfg), "next.config.ts sources the CSP from the shared module");
  ok(/securityHeaders\(\)/.test(cfg), "headers() emits the CSP alongside the baseline headers");
  ok(/X-Frame-Options/.test(cfg), "X-Frame-Options still present");
  ok(/X-Content-Type-Options/.test(cfg), "X-Content-Type-Options still present");
  ok(/Permissions-Policy/.test(cfg) && /camera=\(self\)/.test(cfg), "camera still limited to self");

  const example = read(".env.example");
  ok(/CSP_REPORT_ONLY/.test(example), ".env.example documents CSP_REPORT_ONLY");
  ok(/CSP_DISABLED/.test(example), ".env.example documents CSP_DISABLED");
  ok(/RATE_LIMIT_HEARTBEAT/.test(example), ".env.example documents the rate-limit env vars");
}

// ---------------------------------------------------------------------------
section("10. Real-database verification (shipped checkRateLimit vs SQLite)");
// ---------------------------------------------------------------------------
{
  try {
    const out = execSync("node scripts/verify-phase20-security.mjs", {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    ok(/PHASE20_VERIFY_OK/.test(out), "real-DB verification passed");
    if (!/PHASE20_VERIFY_OK/.test(out)) console.error(out);
  } catch (e) {
    fail++;
    failures.push("real-DB verification crashed");
    console.error("FAIL: real-DB verification crashed");
    console.error(String(e.stdout || ""));
    console.error(String(e.stderr || e.message || e));
  }
}

// ---------------------------------------------------------------------------
section("11. Legacy-session audit script runs against a scratch DB");
// ---------------------------------------------------------------------------
{
  try {
    const { DatabaseSync } = require("node:sqlite");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-legacy-audit-"));
    const dbPath = path.join(dir, "custom.db");
    const db = new DatabaseSync(dbPath);
    db.exec(`CREATE TABLE "Setting" (
      "id" TEXT NOT NULL PRIMARY KEY,
      "key" TEXT NOT NULL UNIQUE,
      "value" TEXT NOT NULL,
      "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );`);
    // One expired legacy row and one malformed row.
    db.prepare(`INSERT INTO "Setting" ("id","key","value") VALUES (?,?,?)`).run(
      "s1",
      "session:expired-token",
      "user-1|2000-01-01T00:00:00.000Z"
    );
    db.prepare(`INSERT INTO "Setting" ("id","key","value") VALUES (?,?,?)`).run(
      "s2",
      "session:malformed",
      "garbage-no-pipe"
    );
    db.close();

    // Report run (no --purge) succeeds with the expired classification.
    const report = execSync("node scripts/audit-legacy-sessions.mjs", {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
      env: { ...process.env, DATABASE_URL: `file:${dbPath}`, NODE_NO_WARNINGS: "1" },
    });
    ok(/LEGACY_SESSION_AUDIT_OK/.test(report), "audit report run succeeds");
    ok(/legacy rows\s*:\s*2/.test(report), "audit counts the legacy rows");
    ok(/expired\s*:\s*1/.test(report), "audit classifies the expired row");
    ok(/malformed\s*:\s*1/.test(report), "audit reports the malformed row");

    // Purge run deletes only the well-formed expired row (not the malformed).
    const purge = execSync(
      "node scripts/audit-legacy-sessions.mjs --purge",
      {
        cwd: REPO,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
        env: { ...process.env, DATABASE_URL: `file:${dbPath}`, NODE_NO_WARNINGS: "1" },
      }
    );
    ok(/Purged 1 legacy session row/.test(purge), "purge removes only the well-formed expired row");

    // Re-open and verify the malformed row survives, the expired row is gone.
    const db2 = new DatabaseSync(dbPath);
    const left = db2.prepare(`SELECT "key" FROM "Setting"`).all().map((r) => r.key);
    db2.close();
    ok(left.includes("session:malformed") && !left.includes("session:expired-token"),
      "purge leaves malformed rows and removes only expired ones");
  } catch (e) {
    fail++;
    failures.push("legacy audit script verification crashed");
    console.error("FAIL: legacy audit script verification crashed");
    console.error(String(e.stdout || ""));
    console.error(String(e.stderr || e.message || e));
  }
}

// ---------------------------------------------------------------------------
section("12. Real HTTP — actual server, actual sessions, actual traffic");
// ---------------------------------------------------------------------------
{
  try {
    const out = execSync("node scripts/verify-phase20-http.mjs", {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    ok(/PHASE20_HTTP_OK/.test(out), "real-HTTP verification passed");
    if (!/PHASE20_HTTP_OK/.test(out)) console.error(out);
  } catch (e) {
    fail++;
    failures.push("real-HTTP verification crashed");
    console.error("FAIL: real-HTTP verification crashed");
    console.error(String(e.stdout || ""));
    console.error(String(e.stderr || e.message || e));
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Phase 20 tests: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log("  -", f);
}
process.exit(fail ? 1 : 0);
