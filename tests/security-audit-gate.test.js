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
    enroll.indexOf("group.courseId !== course.id") <
      Math.min(
        ...[enroll.indexOf("db.$transaction"), enroll.indexOf("submitPaymentRequest(")].filter(
          (i) => i >= 0
        )
      ),
    "the binding is checked before the enrolment transaction runs (Phase 25 PR2a: the transaction body lives in submitPaymentRequest — the call site is the boundary)"
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
  // outbound network I/O is nodemailer (SMTP), the z-ai SDK, and the ONE
  // browser-side leg of the Phase 23 presigned direct upload (the pinned
  // carve-out below).
  // Original threat: server code (API routes / server components / server
  // actions) fetching a caller-influenced URL could reach cloud-metadata and
  // internal-network endpoints. The rule: every fetch() in a non-client src
  // file must target a LITERAL same-origin path. The single sanctioned
  // exception is pinned to its exact shape below — a blanket file exclusion
  // is NOT acceptable: the carve-out must fail on ANY shape deviation.
  const DIRECT_UPLOAD = "src/lib/direct-upload.ts";
  // Cross-platform enumeration of every .ts/.tsx file under src/, replacing
  // the former `find src -name '*.ts' -o -name '*.tsx' | head -400` pipeline
  // (Unix-only: Windows cmd has neither GNU find nor head). A pure fs/path
  // walk — no shell, no pipelines. Paths are repo-relative and normalized to
  // POSIX "/" so the exact-string carve-outs below ("src/lib/direct-upload.ts",
  // "src/lib/db-serialization.ts", the __ssrf_probe__ prefixes) match on every
  // platform, ordering is sorted (deterministic, unlike raw find), and the
  // same 400-file safety bound is applied to the sorted list.
  const listTsFiles = () => {
    const files = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else if (entry.isFile() && /\.tsx?$/.test(entry.name))
          files.push(path.relative(REPO, abs).split(path.sep).join("/"));
      }
    };
    walk(path.join(REPO, "src"));
    files.sort();
    return files.slice(0, 400); // head -400 safety bound, preserved
  };
  const srcFiles = listTsFiles();
  const isClientFile = (t) =>
    t.startsWith('"use client"') || t.includes('\n"use client"');
  const fetchArgsOf = (t) =>
    [...t.matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1].trim());
  const genericSsrfViolations = (files) => {
    const v = [];
    for (const f of files) {
      if (f === DIRECT_UPLOAD) continue; // pinned to its exact shape below — never skipped blind
      const t = read(f);
      if (isClientFile(t)) continue;
      // A server-side fetch is one whose target is not a literal same-origin path.
      for (const arg of fetchArgsOf(t)) {
        if (/^["'`]\//.test(arg)) continue; // "/api/..." — same-origin, not SSRF
        v.push(`${f}: fetch(${arg})`);
      }
    }
    return v;
  };
  const ssrfViolations = genericSsrfViolations(srcFiles);
  ok(
    ssrfViolations.length === 0,
    `no server-side fetch of a caller-supplied URL exists (SSRF non-exposure)${
      ssrfViolations.length ? " (" + ssrfViolations.slice(0, 3).join(", ") + ")" : ""
    }`
  );

  // Phase 23 PINNED carve-out: the browser-side direct-upload helper is the
  // ONLY src module that may fetch a non-literal URL, and only in exactly
  // this shape — each check below is a fail-closed pin:
  //   * a client-only module ("use client"), imported only by client
  //     components → no server-side execution path exists (a future server
  //     import would receive a client reference it cannot call);
  //   * legs 1/3: fixed POSTs to the literal same-origin endpoints
  //     /api/admin/media-uploads/init and .../complete (session-authenticated
  //     + rate-limited on the server), defaults locked to those literals;
  //   * leg 2: exactly ONE fetch of `upload.uploadUrl` — the short-lived
  //     presigned PUT grant returned by the init endpoint (method pinned to
  //     "PUT" server-side in src/lib/media-upload.ts);
  //   * no credentials option (browser default "same-origin" — the
  //     cross-origin R2 PUT carries no cookies), no redirect override, no
  //     other variable fetch anywhere in the file.
  const auditDirectUpload = (du) => {
    const v = [];
    const args = fetchArgsOf(du);
    if (!/^"use client";?\s*$/.test(du.split("\n")[0] ?? ""))
      v.push("missing the leading 'use client' directive");
    if (args.length !== 2)
      v.push(`expected exactly 2 fetch calls, found ${args.length}: ${args.join(", ")}`);
    if (!args.includes("upload.uploadUrl"))
      v.push("leg 2 no longer fetches the init-granted upload.uploadUrl");
    if (!args.includes("url"))
      v.push("postJson fetch target is no longer its endpoint parameter");
    if (!/fetch\(\s*upload\.uploadUrl\s*,\s*{\s*method:\s*upload\.method\s*\|\|\s*"PUT"/.test(du))
      v.push("leg 2 is not the fixed PUT (server-granted method, 'PUT' fallback)");
    if (!/fetch\(\s*url\s*,\s*{\s*method:\s*"POST"/.test(du))
      v.push("postJson is no longer a fixed POST");
    if (!/input\.initEndpoint\s*\?\?\s*"\/api\/admin\/media-uploads\/init"/.test(du))
      v.push("init endpoint default is no longer the same-origin literal");
    if (!/input\.completeEndpoint\s*\?\?\s*"\/api\/admin\/media-uploads\/complete"/.test(du))
      v.push("complete endpoint default is no longer the same-origin literal");
    const calls = [...du.matchAll(/\bpostJson\(\s*([A-Za-z_$][\w$]*)\s*,/g)].map((m) => m[1]);
    if (calls.length !== 2 || calls[0] !== "initEndpoint" || calls[1] !== "completeEndpoint")
      v.push(`postJson called with unpinned arguments: ${JSON.stringify(calls)}`);
    // The grant must be sourced from the INIT RESPONSE BODY and nothing else —
    // never from caller-controlled `input`, never from storage or config.
    //
    // This pin previously required the literal `init.data.upload`. That shape
    // is one the init endpoint has never returned (`ok(result.init)` puts the
    // grant at the TOP LEVEL), so the pin enforced a defect: every real
    // MEDIA_BACKEND=s3 upload failed at the init leg. The security property is
    // "the grant comes from the server's init response", which the shared
    // extractor preserves — it is pinned here instead, together with a
    // guarantee that it cannot read caller-controlled fields.
    if (!/const\s+upload\s*=\s*extractUploadGrant\(\s*init\.data\s*\)/.test(du))
      v.push("the upload grant is no longer sourced from the init response");
    const extractor = /function\s+extractUploadGrant\([\s\S]*?\n}/.exec(du)?.[0] ?? "";
    if (!extractor)
      v.push("extractUploadGrant is not defined in the browser helper");
    else {
      if (/\binput\b/.test(extractor))
        v.push("extractUploadGrant reads caller-controlled input");
      if (/\bprocess\.env\b/.test(extractor))
        v.push("extractUploadGrant reads environment/configuration");
      // It must still require BOTH a URL and a token before accepting a grant.
      if (!/typeof uploadUrl !== "string" \|\| !uploadUrl/.test(extractor))
        v.push("extractUploadGrant no longer requires a non-empty uploadUrl");
      if (!/typeof token !== "string" \|\| !token/.test(extractor))
        v.push("extractUploadGrant no longer requires a non-empty token");
    }
    if (/credentials\s*:/.test(du))
      v.push("a credentials option is attached to a fetch");
    if (/redirect\s*:/.test(du))
      v.push("redirect handling is overridden");

    // Media-upload UX follow-up: leg 2 may ALSO run over XMLHttpRequest — the
    // only browser transport that reports REAL upload byte progress (`fetch`
    // has no upload-progress event). Same fail-closed discipline, pinned to
    // the same guarantees:
    //   * exactly ONE XHR exists in the helper;
    //   * it is opened on the init-granted `upload.uploadUrl` with the
    //     server-granted method ("PUT" fallback) — never a caller-supplied URL;
    //   * it sends the server-granted Content-Type byte for byte;
    //   * the body is the caller's file and nothing else;
    //   * it carries NO credential to the storage origin (`withCredentials`
    //     stays at its false default), and no response handling is added that
    //     could echo storage internals back into the page.
    const xhrCount = [...du.matchAll(/new\s+XMLHttpRequest\s*\(\s*\)/g)].length;
    if (xhrCount !== 1)
      v.push(`expected exactly 1 XMLHttpRequest, found ${xhrCount}`);
    if (!/xhr\.open\(\s*upload\.method\s*\|\|\s*"PUT"\s*,\s*upload\.uploadUrl\s*,\s*true\s*\)/.test(du))
      v.push("the XHR transfer is not opened on the init-granted URL with the server-granted method");
    if (!/xhr\.setRequestHeader\(\s*"Content-Type"\s*,\s*upload\.contentType\s*\)/.test(du))
      v.push("the XHR transfer no longer sends the server-granted Content-Type");
    if (/withCredentials\s*=\s*true/.test(du))
      v.push("the XHR transfer sends credentials to the storage origin");
    if (/xhr\.send\(\s*(?!file\s*\))/.test(du))
      v.push("the XHR body is not the caller's file");
    if (/responseType\s*=/.test(du))
      v.push("XHR response handling was added (storage response bodies must not be surfaced)");
    if (/xhr\.setRequestHeader\(\s*["'](?!Content-Type["'])/i.test(du))
      v.push("the XHR transfer sends a header other than the granted Content-Type");
    // Both transfer implementations must be driven by the SAME grant object
    // extracted from the init response — never by caller-controlled input.
    if (!/putBytesWithProgress\(\s*upload\s*,\s*input\.file\s*,/.test(du))
      v.push("the XHR transfer is not driven by the init-granted upload object");
    if (!/putBytesWithFetch\(\s*upload\s*,\s*input\.file\s*,\s*signal\s*\)/.test(du))
      v.push("the fetch transfer fallback is not driven by the init-granted upload object");
    return v;
  };
  const duImporters = srcFiles.filter(
    (f) => f !== DIRECT_UPLOAD && /from\s+["']@\/lib\/direct-upload["']/.test(read(f))
  );
  ok(
    duImporters.length > 0 && duImporters.every((f) => isClientFile(read(f))),
    `direct-upload imported only by client components (${
      duImporters.length ? duImporters.join(", ") : "none found"
    })`
  );
  const duViolations = auditDirectUpload(read(DIRECT_UPLOAD));
  ok(
    duViolations.length === 0,
    `direct-upload is pinned to the approved browser direct-upload shape${
      duViolations.length ? " (" + duViolations.join("; ") + ")" : ""
    }`
  );
  const mediaUpload = read("src/lib/media-upload.ts");
  ok(
    /uploadUrl:\s*grant\.url/.test(mediaUpload) && /method:\s*"PUT"/.test(mediaUpload),
    "the init grant pins method 'PUT' and the presigned uploadUrl (server-issued, no credential)"
  );

  // Negative tests — the carve-out and the generic rule must still FAIL on
  // regressions. Production source is only READ here: in-memory mutations
  // prove the shape pins, and two throwaway probe files (created and removed
  // within this run) prove the end-to-end generic rule over the real tree.
  const duSrc = read(DIRECT_UPLOAD);
  ok(
    auditDirectUpload(duSrc.replace('method: upload.method || "PUT"', 'method: "GET"')).length > 0,
    "negative: changing leg 2 off the fixed PUT is caught"
  );
  ok(
    auditDirectUpload(duSrc.replace('method: upload.method || "PUT",', 'method: upload.method || "PUT",\n      credentials: "include",')).length > 0,
    "negative: attaching credentials to the transfer fetch is caught"
  );
  ok(
    auditDirectUpload(
      duSrc.replace(
        'xhr.open(upload.method || "PUT", upload.uploadUrl, true)',
        'xhr.open("PUT", input.uploadUrl, true)'
      )
    ).length > 0,
    "negative: an XHR transfer to a caller-provided URL is caught"
  );
  ok(
    auditDirectUpload(duSrc.replace('xhr.open(upload.method || "PUT"', 'xhr.open("GET"')).length > 0,
    "negative: changing the XHR transfer off the server-granted PUT is caught"
  );
  ok(
    auditDirectUpload(
      duSrc.replace(
        'xhr.setRequestHeader("Content-Type", upload.contentType)',
        'xhr.setRequestHeader("Content-Type", "application/octet-stream")'
      )
    ).length > 0,
    "negative: substituting the granted Content-Type on the XHR transfer is caught"
  );
  ok(
    auditDirectUpload(duSrc.replace("xhr.send(file);", "xhr.send(file);\n    xhr.withCredentials = true;")).length > 0,
    "negative: sending credentials on the XHR transfer is caught"
  );
  ok(
    auditDirectUpload(duSrc + "\nconst spare = new XMLHttpRequest();\n").length > 0,
    "negative: a second XHR inside the browser helper is caught"
  );
  ok(
    auditDirectUpload(duSrc.replace("fetch(upload.uploadUrl, {", "fetch(input.uploadUrl, {")).length > 0,
    "negative: a caller-provided transfer URL is caught"
  );
  ok(
    auditDirectUpload(duSrc.replace('input.initEndpoint ?? "/api/admin/media-uploads/init"', "input.initEndpoint")).length > 0,
    "negative: losing the same-origin init-endpoint default is caught"
  );
  ok(
    auditDirectUpload(duSrc + "\nexport async function rawFetch(u: string) { return fetch(u); }\n").length > 0,
    "negative: a new variable-URL fetch inside the helper is caught"
  );
  ok(
    auditDirectUpload(duSrc.replace('"use client";\n', "")).length > 0,
    "negative: dropping the 'use client' boundary is caught"
  );
  {
    const probeDir = path.join(REPO, "src", "app", "api", "__ssrf_probe__");
    const probeLib = path.join(REPO, "src", "__ssrf_probe__.ts");
    try {
      fs.mkdirSync(probeDir, { recursive: true });
      fs.writeFileSync(
        path.join(probeDir, "route.ts"),
        "export async function GET(req: Request) {\n" +
        "  const u = new URL(req.url).searchParams.get(\"u\") ?? \"\";\n" +
        "  const r = await fetch(u);\n" +
        "  return new Response(await r.text());\n" +
        "}\n"
      );
      fs.writeFileSync(
        probeLib,
        "export async function probeFetch(u: string) {\n  return fetch(u);\n}\n"
      );
      const probeViolations = genericSsrfViolations([
        ...srcFiles,
        "src/app/api/__ssrf_probe__/route.ts",
        "src/__ssrf_probe__.ts",
      ]);
      ok(
        probeViolations.some((x) => x.startsWith("src/app/api/__ssrf_probe__/route.ts:")),
        "negative: a server API route doing fetch(userUrl) is caught"
      );
      ok(
        probeViolations.some((x) => x.startsWith("src/__ssrf_probe__.ts:")),
        "negative: another src/ file adding fetch(variable) is caught"
      );
    } finally {
      fs.rmSync(probeDir, { recursive: true, force: true });
      fs.rmSync(probeLib, { force: true });
    }
  }

  // SQL injection: every query goes through the ORM. Phase 23 carve-out: the
  // presigned upload finalization takes a PostgreSQL TRANSACTION-SCOPED
  // ADVISORY LOCK on the exact storage key — lock-only raw SQL in exactly
  // one server module, provider-gated to a deliberate no-op on SQLite (no
  // data query anywhere is provider-specific). Any other raw SQL in src/ is
  // still a gate failure.
  const rawFiles = srcFiles.filter((f) =>
    /\$queryRaw|\$executeRaw|\$queryRawUnsafe|\$executeRawUnsafe/.test(read(f))
  );
  const rawCarveOut = rawFiles.filter((f) => f === "src/lib/db-serialization.ts");
  ok(
    rawFiles.length === rawCarveOut.length && rawCarveOut.length === 1,
    "raw SQL is confined to the provider-gated advisory-lock helper (all access is parameterised ORM)"
  );
  if (rawCarveOut.length === 1) {
    const ser = read("src/lib/db-serialization.ts");
    ok(
      /pg_advisory_xact_lock/.test(ser) &&
        !/INSERT|UPDATE\s+|DELETE\s+FROM|SELECT\s+\*/.test(ser),
      "the raw SQL is lock-only (no data reads/writes bypass the ORM)"
    );
    ok(
      /provider !== "postgresql"\s*\) return;/.test(ser),
      "the advisory lock never executes on SQLite (portability preserved)"
    );
  }

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
