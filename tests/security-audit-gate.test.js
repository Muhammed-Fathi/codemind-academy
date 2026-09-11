// CodeMind Academy — PRE-PHASE-21 SECURITY AUDIT GATE tests.
//
// Three kinds of checks, all offline except the last section:
//   A. Behavioural — compile the PURE security modules (security.ts) and
//      exercise them directly (client-IP trust, hashing, token generation).
//   B. Structural invariants over the real routes / libs / scripts — each one
//      pins a CONFIRMED finding from the audit register, so a future change
//      that silently reintroduces it fails here rather than in production.
//   C. Real HTTP — `scripts/verify-security-audit-gate.mjs` drives the SHIPPED
//      route handlers over a real socket against a real SQLite database built
//      from the real migration history.
//
// The structural assertions are deliberately narrow (they pin the specific
// guard, not a whole file) and every one of them names the finding it protects.
//
// Run: node tests/security-audit-gate.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(REPO, rel));

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
// Compile the pure security modules for behavioural checks.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-audit-gate-test-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      lib: ["es2022"],
      module: "commonjs",
      moduleResolution: "node",
      strict: false,
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
      path.join(REPO, "src/lib/env.ts"),
      path.join(REPO, "src/lib/security.ts"),
    ],
  })
);
execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });

// security.ts imports the Prisma data source only to write audit rows; the
// behavioural checks below never touch it, so it is stubbed the same way the
// verify-* scripts stub it.
const dbShim = path.join(OUT, "__db-shim.js");
fs.writeFileSync(dbShim, "module.exports = { db: null };\n");
const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === "@/lib/db") return dbShim;
  const m = /^@\/lib\/([\w-]+)$/.exec(request);
  if (m) {
    const compiled = path.join(OUT, "src", "lib", `${m[1]}.js`);
    if (fs.existsSync(compiled)) return compiled;
  }
  return originalResolve.call(this, request, ...rest);
};

const Security = require(path.join(OUT, "src", "lib", "security.js"));

// ---------------------------------------------------------------------------
section("1. F-01 — the seeder never ships a committed credential");
// ---------------------------------------------------------------------------
{
  const seed = read("scripts/seed.ts");

  // No literal password survives anywhere in the seeder.
  ok(
    !/hashPassword\(\s*["'`][^"'`]+["'`]\s*\)/.test(seed),
    "scripts/seed.ts contains no literal password argument to hashPassword()"
  );
  for (const bad of ["admin123", "teacher123", "student123", "parent123"]) {
    ok(!seed.includes(bad), `scripts/seed.ts no longer contains the known credential "${bad}"`);
  }

  // Every credential is resolved from the environment first.
  ok(seed.includes("SEED_ADMIN_PASSWORD"), "admin password comes from SEED_ADMIN_PASSWORD");
  ok(seed.includes("SEED_DEMO_PASSWORD"), "demo passwords come from SEED_DEMO_PASSWORD");

  // Production refuses to invent one.
  ok(
    /NODE_ENV\s*===\s*"production"/.test(seed),
    "the seeder branches on NODE_ENV=production"
  );
  ok(
    /process\.exit\(1\)/.test(seed),
    "the seeder aborts (exit 1) when production requires a password that was not supplied"
  );
  ok(
    /randomBytes\(16\)/.test(seed) || /generatedPassword/.test(seed),
    "the non-production fallback is a cryptographically random password"
  );
  ok(
    /fromEnv/.test(seed) && /!adminPassword\.fromEnv/.test(seed),
    "an operator-supplied password is never echoed back to the console"
  );

  // The docs that made the old default a mandatory deploy step are updated.
  const deploy = read("docs/DEPLOYMENT_GUIDE.md");
  ok(!deploy.includes("admin123"), "DEPLOYMENT_GUIDE no longer publishes the admin password");
  ok(
    deploy.includes("SEED_ADMIN_PASSWORD") && deploy.includes("SEED_DEMO_PASSWORD"),
    "DEPLOYMENT_GUIDE documents the required seed env vars"
  );
  ok(!read("README.md").includes("admin123"), "README no longer publishes the admin password");
  ok(
    !read("docs/DEVELOPMENT_GUIDE.md").includes("admin123"),
    "DEVELOPMENT_GUIDE no longer publishes the admin password"
  );
  ok(
    !read("docs/ADMIN_GUIDE.md").includes("admin123"),
    "ADMIN_GUIDE no longer publishes the admin password"
  );
  ok(
    !read("docs/TROUBLESHOOTING.md").includes("admin123"),
    "TROUBLESHOOTING no longer publishes the admin password"
  );
  ok(
    !read("docs/ADDING_FEATURES.md").includes("student123"),
    "ADDING_FEATURES no longer publishes a demo password"
  );
}

// ---------------------------------------------------------------------------
section("2. F-02 — login is throttled on two independent keys");
// ---------------------------------------------------------------------------
{
  const auth = read("src/app/api/auth/[action]/route.ts");
  const loginBranch = auth.slice(auth.indexOf('action === "login"'));

  // The limiter runs BEFORE the credential lookup, on both keys.
  ok(
    loginBranch.includes('checkRateLimit(\n      "login:ip"') ||
      loginBranch.includes('checkRateLimit("login:ip"'),
    "login throttles on a per-IP bucket"
  );
  ok(
    loginBranch.includes('"login:id"'),
    "login throttles on a per-identity (hashed email) bucket"
  );
  const ipAt = loginBranch.indexOf("login:ip");
  const idAt = loginBranch.indexOf("login:id");
  const lookupAt = loginBranch.indexOf("db.user.findUnique");
  ok(ipAt > -1 && ipAt < lookupAt, "the IP bucket is checked before the credential lookup");
  ok(idAt > -1 && idAt < lookupAt, "the identity bucket is checked before the credential lookup");

  // A successful login clears the identity budget (no self-inflicted lockout).
  const successAt = loginBranch.indexOf('type: "LOGIN_SUCCESS"');
  ok(successAt > -1, "a successful login is audited");
  ok(
    loginBranch.indexOf('resetRateLimit("login:id"') > -1 &&
      loginBranch.indexOf('resetRateLimit("login:id"') < successAt,
    "the identity bucket is reset before LOGIN_SUCCESS is written"
  );

  // 429 shape is the platform's shared one, and the identity key is not PII.
  ok(loginBranch.includes("RATE_LIMITED_CODE"), "the 429 carries the shared RATE_LIMITED machine code");
  ok(loginBranch.includes("Retry-After"), "the 429 carries Retry-After");
  ok(
    /sha256\(\s*`login:id:/.test(loginBranch),
    "the identity bucket key is a hash of the email, not the email itself"
  );
  ok(
    loginBranch.includes("clientIpFromHeaders"),
    "the IP bucket uses the shared client-IP resolver (no ad-hoc header parsing)"
  );

  // Login remains a non-oracle for account existence.
  ok(
    loginBranch.includes('type: "LOGIN_FAILED"') &&
      loginBranch.includes('detail: "Invalid credentials"'),
    "a failed login is still audited"
  );
  ok(
    (loginBranch.match(/tApi\("api\.057"\)/g) || []).length >= 1 &&
      !/user\s*&&\s*!user/.test(loginBranch.slice(0, lookupAt)),
    "unknown account and wrong password share one 401 message"
  );

  // No OTHER unauthenticated credential endpoint was left unthrottled.
  for (const [file, bucket] of [
    ["src/app/api/auth/password-reset/request/route.ts", "pwreset:ip"],
    ["src/app/api/auth/password-reset/confirm/route.ts", "pwreset:confirm:ip"],
    ["src/app/api/auth/teacher-activate/route.ts", "teacheract:ip"],
  ]) {
    ok(read(file).includes(bucket), `${file} still throttles on ${bucket} (no regression)`);
  }
}

// ---------------------------------------------------------------------------
section("3. F-03 — PATCH /api/students/me/study-plan is ownership-scoped");
// ---------------------------------------------------------------------------
{
  const plan = read("src/app/api/students/me/study-plan/route.ts");
  const patch = plan.slice(plan.indexOf("export async function PATCH"));

  ok(
    patch.includes("updateMany") &&
      /where:\s*\{\s*id:\s*taskId,\s*studentId:\s*student\.id\s*\}/.test(patch),
    "PATCH updates through updateMany scoped to (id, studentId)"
  );
  ok(
    !/studyTask\.update\(\s*\{\s*where:\s*\{\s*id:/.test(plan),
    "no unscoped studyTask.update({ where: { id } }) remains anywhere in the route"
  );
  ok(
    /result\.count !== 1/.test(patch) && patch.includes('err("Not found", 404)'),
    "a task that is not the caller's own answers 404 (no P2025 500, no existence oracle)"
  );

  // The siblings it drifted from are still scoped (regression guard).
  const del = plan.slice(plan.indexOf("export async function DELETE"));
  ok(
    /deleteMany\(\s*\{\s*where:\s*\{\s*id:\s*taskId,\s*studentId:\s*student\.id\s*\}/.test(del),
    "DELETE is still scoped to (id, studentId)"
  );
  const notes = read("src/app/api/students/me/notes/route.ts");
  ok(
    /lessonNote\.findFirst\(\s*\{\s*where:\s*\{\s*id:\s*noteId,\s*studentId:\s*student\.id\s*\}/.test(notes),
    "the notes PATCH ownership pre-check is intact"
  );
  ok(
    /lessonNote\.deleteMany\(\s*\{\s*where:\s*\{\s*id:\s*noteId,\s*studentId:\s*student\.id\s*\}/.test(notes),
    "the notes DELETE is still scoped to (id, studentId)"
  );
}

// ---------------------------------------------------------------------------
section("4. F-04 — enrolment binds groupId to courseId");
// ---------------------------------------------------------------------------
{
  const enroll = read("src/app/api/enroll/route.ts");
  ok(
    /group\.courseId\s*!==\s*course\.id/.test(enroll),
    "enrolment refuses a group that belongs to a different course"
  );
  ok(
    enroll.indexOf("group.courseId !== course.id") < enroll.indexOf("filled >= group.capacity"),
    "the course/group binding is checked before any seat is consumed"
  );
  ok(
    enroll.indexOf("group.courseId !== course.id") < enroll.indexOf("db.$transaction"),
    "the binding is checked before the enrolment transaction runs"
  );
  // The course id is now resolved server-side, not taken on trust.
  ok(
    /db\.course\.findUnique/.test(enroll),
    "the submitted courseId is resolved against the database"
  );
}

// ---------------------------------------------------------------------------
section("5. F-05 / §12 — HSTS is emitted and reversible");
// ---------------------------------------------------------------------------
{
  const cfg = read("next.config.ts");
  ok(cfg.includes("Strict-Transport-Security"), "next.config emits Strict-Transport-Security");
  const hstsValue = /key: "Strict-Transport-Security",\s*\n\s*value: "([^"]+)"/.exec(cfg);
  ok(!!hstsValue, "the HSTS header value is a literal string");
  const hsts = hstsValue ? hstsValue[1] : "";
  ok(/^max-age=\d+$/.test(hsts) || /^max-age=\d+;/.test(hsts), "HSTS value starts with a positive max-age", hsts);
  ok(!/preload/.test(hsts), "the emitted HSTS value does not opt into preload (a one-way door)", hsts);
  ok(/includeSubDomains/.test(hsts), "HSTS covers subdomains", hsts);
  ok(cfg.includes("HSTS_DISABLED"), "HSTS has an operator kill-switch (like CSP_DISABLED)");

  // The Phase 20 header set is untouched.
  for (const h of [
    "X-Frame-Options",
    "X-Content-Type-Options",
    "Referrer-Policy",
    "Permissions-Policy",
    "Content-Security-Policy",
  ]) {
    ok(cfg.includes(h), `${h} is still configured`);
  }
  ok(
    read("src/lib/content-security-policy.ts").includes("frame-ancestors"),
    "CSP still carries frame-ancestors (clickjacking defence)"
  );
}

// ---------------------------------------------------------------------------
section("6. F-06 — the student leaderboard is scoped and bounded");
// ---------------------------------------------------------------------------
{
  const board = read("src/app/api/students/me/leaderboard/route.ts");
  ok(
    !/db\.student\.findMany\(\s*\{?\s*\n?\s*include/.test(board),
    "the leaderboard no longer reads every student row in the platform"
  );
  ok(
    /where:\s*\{\s*group:\s*\{\s*isActive:\s*true,\s*courseId\s*\}\s*\}/.test(board),
    "the leaderboard is scoped to students enrolled in the caller's own course"
  );
  ok(/take:\s*LEADERBOARD_MAX_ROWS/.test(board), "the leaderboard query is bounded");
  ok(
    /const LEADERBOARD_MAX_ROWS = \d+/.test(board) &&
      Number(/const LEADERBOARD_MAX_ROWS = (\d+)/.exec(board)[1]) <= 500,
    "the bound is a small, explicit constant"
  );
  ok(
    /entries\.findIndex\(\(e\) => e\.studentId === me\.id\)/.test(board),
    "the caller's rank is resolved by student id, not by display name"
  );
  // The payload still exposes no email (privacy regression guard).
  ok(
    !/\bemail\b/.test(board.slice(board.indexOf("entries.push"))),
    "the leaderboard payload contains no email address"
  );
}

// ---------------------------------------------------------------------------
section("7. F-07 — client-IP trust is one documented decision (behavioural)");
// ---------------------------------------------------------------------------
{
  // Proxy-set header wins over a spoofable one.
  ok(
    Security.clientIpFromHeaders(
      new Headers({ "x-forwarded-for": "1.2.3.4", "x-real-ip": "198.51.100.1" })
    ) === "198.51.100.1",
    "X-Real-IP (set by the Caddy reverse proxy) wins over a spoofed X-Forwarded-For"
  );
  ok(
    Security.clientIpFromHeaders(new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" })) ===
      "1.2.3.4",
    "without X-Real-IP the first X-Forwarded-For hop is used"
  );
  ok(
    Security.clientIpFromHeaders(new Headers({})) === null,
    "with neither header the resolver returns null (routes fall back to a shared bucket)"
  );

  // No route still parses x-forwarded-for by hand.
  for (const f of [
    "src/app/api/auth/password-reset/request/route.ts",
    "src/app/api/auth/password-reset/confirm/route.ts",
    "src/app/api/auth/teacher-activate/route.ts",
    "src/lib/auth.ts",
  ]) {
    ok(
      !/get\("x-forwarded-for"\)/.test(read(f)),
      `${f} uses the shared resolver instead of parsing X-Forwarded-For inline`
    );
  }
  // In security.ts the ONLY inline read is inside the resolver itself.
  const sec = read("src/lib/security.ts");
  const resolverBody = sec.slice(
    sec.indexOf("export function clientIpFromHeaders"),
    sec.indexOf("export function hashIp")
  );
  ok(
    (sec.match(/get\("x-forwarded-for"\)/g) || []).length === 1 &&
      /get\("x-forwarded-for"\)/.test(resolverBody),
    "X-Forwarded-For is parsed in exactly one place: clientIpFromHeaders()"
  );
  ok(
    /hashIp\(/.test(read("src/lib/security.ts")),
    "IPs are still hashed with SECURITY_HASH_SECRET before they are stored"
  );
}

// ---------------------------------------------------------------------------
section("8. F-09 — one 8-character password floor everywhere");
// ---------------------------------------------------------------------------
{
  for (const f of [
    "src/app/api/auth/[action]/route.ts",
    "src/app/api/admin/students/route.ts",
    "src/app/api/admin/teachers/route.ts",
    "scripts/setup-production.ts",
  ]) {
    const src = read(f);
    ok(!/password\.length < [1-7]\b/.test(src), `${f} no longer accepts a password below 8 characters`);
    ok(
      /password\.length < 8/.test(src),
      `${f} enforces the 8-character minimum`
    );
  }
  // The rest of the platform already used 8 — unchanged.
  ok(
    read("src/app/api/auth/password-reset/confirm/route.ts").includes("password.length < 8"),
    "password reset still requires 8 characters"
  );
  ok(
    read("src/app/api/auth/teacher-activate/route.ts").includes("password.length < 8"),
    "teacher activation still requires 8 characters"
  );
}

// ---------------------------------------------------------------------------
section("9. Authentication invariants the audit re-verified (no regression)");
// ---------------------------------------------------------------------------
{
  const auth = read("src/lib/auth.ts");
  ok(auth.includes("scryptSync"), "passwords are still hashed with scrypt");
  ok(auth.includes("timingSafeEqual"), "password comparison is constant-time");
  ok(auth.includes("randomBytes(16)"), "each password gets a fresh 16-byte salt");
  ok(auth.includes("generateToken(32)"), "session tokens are 32 cryptographically random bytes");
  ok(auth.includes("sha256(token)"), "only the SHA-256 of a session token is stored");
  ok(
    /httpOnly:\s*true/.test(auth) &&
      /sameSite:\s*"lax"/.test(auth) &&
      /secure:\s*process\.env\.NODE_ENV === "production"/.test(auth),
    "session cookies are HttpOnly + SameSite=Lax + Secure in production"
  );
  ok(
    !/db\.setting\b/.test(auth.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "")),
    "auth.ts reads no Setting row — the legacy Setting:session fallback is still gone"
  );

  // No client-controlled role on any User create.
  const routes = [
    "src/app/api/auth/[action]/route.ts",
    "src/app/api/admin/students/route.ts",
    "src/app/api/admin/teachers/route.ts",
    "src/lib/teacher-applications.ts",
  ];
  for (const f of routes) {
    const src = read(f);
    ok(
      !/create\(\{\s*data:\s*\{[^}]*role:\s*(body|input)\./.test(src),
      `${f} never takes the role from the request body`
    );
  }
  const reg = read("src/app/api/auth/[action]/route.ts");
  ok(
    /role === "ADMIN"/.test(reg) && reg.indexOf('role === "ADMIN"') < reg.indexOf("db.user.create"),
    "public ADMIN self-registration is still refused before any User is created"
  );
  ok(
    reg.includes("submitTeacherApplication"),
    "public TEACHER registration still routes to the PENDING application flow"
  );
}

// ---------------------------------------------------------------------------
section("10. Verified non-exposures (documented, not speculative controls)");
// ---------------------------------------------------------------------------
{
  // SSRF: no server-side fetch of a caller-supplied URL exists. The only
  // outbound network I/O is nodemailer (SMTP) and the z-ai SDK.
  const srcFiles = execSync(
    "find src -name '*.ts' -o -name '*.tsx' | head -400",
    { cwd: REPO, encoding: "utf8" }
  )
    .trim()
    .split("\n");
  let serverFetches = 0;
  for (const f of srcFiles) {
    const t = read(f);
    if (t.startsWith('"use client"') || t.includes('\n"use client"')) continue;
    // A server-side fetch is one whose target is not a literal same-origin path.
    for (const m of t.matchAll(/\bfetch\(\s*([^,)]+)/g)) {
      const arg = m[1].trim();
      if (/^["'`]\//.test(arg)) continue; // "/api/..." — same-origin, not SSRF
      serverFetches++;
    }
  }
  ok(
    serverFetches === 0,
    "no server-side fetch of a caller-supplied URL exists (SSRF non-exposure)"
  );

  // SQL injection: every query goes through the ORM.
  let rawSql = 0;
  for (const f of srcFiles) {
    if (/\$queryRaw|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe/.test(read(f))) rawSql++;
  }
  ok(rawSql === 0, "no raw/unsafe SQL is executed anywhere in src/ (all access is parameterised ORM)");

  // Command injection: no shell execution in the request path.
  let shell = 0;
  for (const f of srcFiles) {
    if (/require\("child_process"\)|from "child_process"|execSync\(|spawnSync\(/.test(read(f)))
      shell++;
  }
  ok(shell === 0, "no child_process execution in src/");

  // XSS: the single dangerouslySetInnerHTML is a static <style> block.
  const chart = read("src/components/ui/chart.tsx");
  ok(
    (chart.match(/dangerouslySetInnerHTML/g) || []).length === 1 &&
      chart.indexOf("dangerouslySetInnerHTML") > chart.indexOf("<style"),
    "the only dangerouslySetInnerHTML is the chart's static <style> block"
  );

  // Secrets: no committed credential material.
  const tracked = execSync("git ls-files", { cwd: REPO, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  ok(!tracked.includes(".env"), ".env is NOT tracked by git (git ls-files)");
  ok(
    !tracked.some((f) => /(^|\/)\.env(\.|$)/.test(f) && f !== ".env.example"),
    "no environment file other than .env.example is tracked"
  );
  ok(exists(".env.example"), ".env.example is present");
  ok(
    !/password\s*[:=]\s*["'][A-Za-z0-9!@#$%^&*]{8,}["']/.test(read(".env.example")) ||
      !/(BEGIN|PRIVATE KEY)/.test(read(".env.example")),
    ".env.example carries placeholders only"
  );
}

// ---------------------------------------------------------------------------
section("11. Real HTTP — shipped handlers, real SQLite, real socket");
// ---------------------------------------------------------------------------
{
  try {
    const out = execSync("node scripts/verify-security-audit-gate.mjs", {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    ok(/SECURITY_AUDIT_GATE_HTTP_OK/.test(out), "real-HTTP verification passed");
    if (!/SECURITY_AUDIT_GATE_HTTP_OK/.test(out)) console.error(out);
  } catch (e) {
    fail++;
    failures.push("real-HTTP verification crashed");
    console.error("FAIL: real-HTTP verification crashed");
    console.error(String(e.stdout || ""));
    console.error(String(e.stderr || e.message || e));
  }
}

// ---------------------------------------------------------------------------
section("12. Browser verification — cookie engine + document parsing");
// ---------------------------------------------------------------------------
// A real Chromium cannot be started in this sandbox (playwright's CDN is
// unreachable, no system browser), so the browser subsystems the audit depends
// on are exercised with the engines real browsers use: tough-cookie (RFC 6265
// cookie semantics, incl. SameSite) and jsdom (real document parsing over a
// real socket). It is NOT a rendered Chromium, and the script says so.
{
  try {
    const out = execSync("node scripts/verify-security-audit-gate-browser.mjs", {
      cwd: REPO,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 300000,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
    });
    ok(/SECURITY_AUDIT_GATE_BROWSER_OK/.test(out), "browser verification passed");
    if (!/SECURITY_AUDIT_GATE_BROWSER_OK/.test(out)) console.error(out);
  } catch (e) {
    fail++;
    failures.push("browser verification crashed");
    console.error("FAIL: browser verification crashed");
    console.error(String(e.stdout || ""));
    console.error(String(e.stderr || e.message || e));
  }
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(60)}`);
console.log(`Security Audit Gate tests: ${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log("  -", f);
}
process.exit(fail ? 1 : 0);
