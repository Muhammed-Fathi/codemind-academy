// CodeMind Academy — Phase 3 production security hardening regression tests.
//
// Two kinds of checks, both offline (no database, no network):
//   A. Behavioural: compile `src/lib/env.ts` and `src/lib/route-protection.ts`
//      with tsc and exercise them directly.
//   B. Source-level invariants over the real sources, in the same style as
//      tests/authorization-invariants.test.js, so the specific regressions
//      this phase closed fail loudly if re-introduced.
//
// Run: node tests/security-hardening.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
let fail = 0;
const ok = (cond, label) => {
  if (cond) pass++;
  else {
    fail++;
    console.error("FAIL:", label);
  }
};
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
// Compile the two pure helpers to CommonJS in a temp dir.
// ---------------------------------------------------------------------------
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "cm-sec-test-"));
fs.writeFileSync(
  path.join(OUT, "tsconfig.json"),
  JSON.stringify({
    compilerOptions: {
      target: "es2020",
      module: "commonjs",
      strict: true,
      skipLibCheck: true,
      types: ["node"],
      typeRoots: [path.join(REPO, "node_modules/@types")],
      outDir: OUT,
    },
    files: [
      path.join(REPO, "src/lib/env.ts"),
      path.join(REPO, "src/lib/route-protection.ts"),
    ],
  })
);
execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
const Env = require(path.join(OUT, "env.js"));
const RP = require(path.join(OUT, "route-protection.js"));

const REAL = "a".repeat(64);

// ---------------------------------------------------------------------------
section("1. SECURITY_HASH_SECRET is mandatory in production");
// ---------------------------------------------------------------------------
{
  const prod = (extra) => ({ NODE_ENV: "production", ...extra });

  ok(
    Env.getSecurityHashSecretProblem(prod({})) !== null,
    "production + unset secret -> problem reported"
  );
  ok(
    Env.getSecurityHashSecretProblem(prod({ SECURITY_HASH_SECRET: "" })) !== null,
    "production + empty secret -> problem reported"
  );
  ok(
    Env.getSecurityHashSecretProblem(prod({ SECURITY_HASH_SECRET: "   " })) !== null,
    "production + whitespace-only secret -> problem reported"
  );
  ok(
    Env.getSecurityHashSecretProblem(
      prod({ SECURITY_HASH_SECRET: "codemind-dev-hash-secret" })
    ) !== null,
    "production + dev fallback value -> rejected"
  );
  ok(
    Env.getSecurityHashSecretProblem(
      prod({ SECURITY_HASH_SECRET: "REPLACE_WITH_openssl_rand_hex_32" })
    ) !== null,
    "production + .env.example placeholder -> rejected"
  );
  ok(
    Env.getSecurityHashSecretProblem(prod({ SECURITY_HASH_SECRET: "short" })) !== null,
    "production + short secret -> rejected"
  );
  ok(
    Env.getSecurityHashSecretProblem(prod({ SECURITY_HASH_SECRET: REAL })) === null,
    "production + real 64-char secret -> accepted"
  );

  let threw = false;
  try {
    Env.getSecurityHashSecret(prod({}));
  } catch (e) {
    threw = true;
    ok(!/codemind-dev-hash-secret/.test(String(e.message)), "error never contains fallback value");
    ok(/SECURITY_HASH_SECRET/.test(String(e.message)), "error names the variable");
  }
  ok(threw, "getSecurityHashSecret throws in production when unset (no silent fallback)");

  ok(
    Env.getSecurityHashSecret(prod({ SECURITY_HASH_SECRET: REAL })) === REAL,
    "getSecurityHashSecret returns the configured value in production"
  );

  // assertProductionEnv aggregates and never echoes values.
  let assertThrew = false;
  try {
    Env.assertProductionEnv(prod({ SECURITY_HASH_SECRET: "hunter2-secret-value-xyz" }));
  } catch (e) {
    assertThrew = true;
    ok(!/hunter2/.test(String(e.message)), "assertProductionEnv never prints the secret value");
  }
  ok(assertThrew, "assertProductionEnv throws for an invalid production secret");
  ok(
    Env.validateProductionEnv(prod({ SECURITY_HASH_SECRET: REAL })).length === 0,
    "validateProductionEnv is clean with a proper secret"
  );
  let cleanThrew = false;
  try {
    Env.assertProductionEnv(prod({ SECURITY_HASH_SECRET: REAL }));
  } catch {
    cleanThrew = true;
  }
  ok(!cleanThrew, "assertProductionEnv passes with a proper secret");
}

// ---------------------------------------------------------------------------
section("2. Development / test keep a convenient, clearly-labelled fallback");
// ---------------------------------------------------------------------------
{
  const dev = { NODE_ENV: "development" };
  const test = { NODE_ENV: "test" };
  const none = {};
  ok(Env.getSecurityHashSecretProblem(dev) === null, "development + unset -> no problem");
  ok(Env.getSecurityHashSecretProblem(test) === null, "test + unset -> no problem");
  ok(Env.getSecurityHashSecretProblem(none) === null, "NODE_ENV unset -> treated as non-production");
  ok(
    typeof Env.getSecurityHashSecret(dev) === "string" && Env.getSecurityHashSecret(dev).length > 0,
    "development resolves a non-empty fallback"
  );
  ok(
    Env.getSecurityHashSecret({ NODE_ENV: "development", SECURITY_HASH_SECRET: REAL }) === REAL,
    "development honours an explicit SECURITY_HASH_SECRET"
  );
  ok(Env.isProduction({ NODE_ENV: "production" }) && !Env.isProduction(dev), "isProduction helper");
}

// ---------------------------------------------------------------------------
section("3. No hardcoded production fallback remains in security.ts");
// ---------------------------------------------------------------------------
{
  const sec = read("src/lib/security.ts");
  ok(
    !/SECURITY_HASH_SECRET\s*\|\|/.test(sec),
    "security.ts no longer contains `SECURITY_HASH_SECRET || <fallback>`"
  );
  ok(
    !/codemind-dev-hash-secret/.test(sec),
    "security.ts no longer embeds the dev fallback literal"
  );
  ok(
    /getSecurityHashSecret\(\)/.test(sec) && /from "@\/lib\/env"/.test(sec),
    "security.ts resolves the secret through src/lib/env.ts"
  );
  const hashIpUses = (sec.match(/getSecurityHashSecret\(\)/g) || []).length;
  ok(hashIpUses >= 2, "both hashIp and deviceHashFromHeaders use the validated secret");
}

// ---------------------------------------------------------------------------
section("4. Production fail-fast is wired at build AND runtime");
// ---------------------------------------------------------------------------
{
  const cfg = read("next.config.ts");
  ok(/assertProductionEnv\(\)/.test(cfg), "next.config.ts calls assertProductionEnv (build-time)");
  ok(/NODE_ENV === "production"/.test(cfg), "next.config.ts only enforces for production builds");
  ok(/poweredByHeader:\s*false/.test(cfg), "X-Powered-By is disabled");
  ok(/X-Frame-Options/.test(cfg), "X-Frame-Options header configured");
  ok(/X-Content-Type-Options/.test(cfg), "X-Content-Type-Options header configured");
  ok(/Referrer-Policy/.test(cfg), "Referrer-Policy header configured");

  const inst = read("src/instrumentation.ts");
  ok(/export async function register\(\)/.test(inst), "instrumentation.ts exports register()");
  ok(/assertProductionEnv\(\)/.test(inst), "instrumentation.ts enforces the env contract at startup");
  ok(!/from "@\/lib\/db"/.test(inst), "instrumentation.ts does not touch the database");

  const example = read(".env.example");
  ok(/^SECURITY_HASH_SECRET=/m.test(example), ".env.example documents SECURITY_HASH_SECRET");
  ok(
    /SECURITY_HASH_SECRET="REPLACE_WITH_openssl_rand_hex_32"/.test(example),
    ".env.example holds a placeholder, not a real value"
  );
}

// ---------------------------------------------------------------------------
section("5. Proxy (middleware) defence-in-depth decisions");
// ---------------------------------------------------------------------------
{
  const protectedPaths = [
    "/api/admin/overview",
    "/api/admin/users/abc/sessions",
    "/api/teacher/dashboard",
    "/api/students/me/dashboard",
    "/api/parents/me/dashboard",
    "/api/media/some-id",
    // Phase 14 — authorized session PDF downloads.
    "/api/materials/some-id",
    "/api/quizzes/q1/evidence",
    "/api/lessons/l1/progress",
    "/api/exams/mock",
    "/api/notifications",
    "/api/notifications/unread-count",
    "/api/enroll",
    // Phase 10: /api/ai/* was removed — Kodgy is now a fully client-side
    // scripted assistant (no AI API endpoint to protect).
    "/api/coupons/validate",
  ];
  for (const p of protectedPaths) {
    ok(RP.isProtectedApiPath(p), `${p} is a protected namespace`);
    ok(RP.decideApiAccess(p, false) === "deny", `${p} without cookie -> deny`);
    ok(RP.decideApiAccess(p, true) === "pass", `${p} with cookie -> pass (route decides)`);
  }

  const publicPaths = [
    "/api/auth/login",
    "/api/auth/register",
    "/api/auth/logout",
    "/api/auth/me",
    "/api/auth/password-reset/request",
    "/api/auth/password-reset/confirm",
    "/api/settings/public",
    "/api/subscription-plans",
    "/api/groups",
    "/api/courses",
    "/api/courses/intro",
    "/api",
    "/",
  ];
  for (const p of publicPaths) {
    ok(!RP.isProtectedApiPath(p), `${p} is NOT blocked by the proxy`);
    ok(RP.decideApiAccess(p, false) === "pass", `${p} without cookie -> pass`);
  }

  // Prefix matching must not over-match sibling paths.
  ok(!RP.isProtectedApiPath("/api/adminx"), "prefix match is segment-aware (/api/adminx)");
  ok(!RP.isProtectedApiPath("/api/coupons"), "/api/coupons root is not matched by /api/coupons/validate");
  ok(RP.SESSION_COOKIE_NAME === "cm_session", "proxy watches the real session cookie name");

  const proxySrc = read("src/proxy.ts");
  ok(/export function proxy\(/.test(proxySrc), "src/proxy.ts exports proxy()");
  ok(!/@\/lib\/db|prisma/i.test(proxySrc), "proxy performs no database access");
  ok(/matcher:\s*\["\/api\/:path\*"\]/.test(proxySrc), "proxy matcher is limited to /api/*");
  ok(/status:\s*401/.test(proxySrc), "proxy denies with 401");

  // The session cookie name must match src/lib/auth.ts exactly.
  const auth = read("src/lib/auth.ts");
  const m = auth.match(/const SESSION_COOKIE = "([^"]+)"/);
  ok(m && m[1] === RP.SESSION_COOKIE_NAME, "route-protection cookie name matches src/lib/auth.ts");
}

// ---------------------------------------------------------------------------
section("6. Route-level authorization is still the real gate (not the proxy)");
// ---------------------------------------------------------------------------
{
  const api = path.join(REPO, "src/app/api");
  const walk = (dir, acc = []) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, acc);
      else if (e.name === "route.ts") acc.push(p);
    }
    return acc;
  };
  const routes = walk(api).map((p) => path.relative(REPO, p));
  const protectedRoutes = routes.filter((r) =>
    RP.isProtectedApiPath("/" + path.dirname(r).replace(/^src\/app\//, "").replace(/\\/g, "/"))
  );
  ok(protectedRoutes.length >= 60, `found ${protectedRoutes.length} routes in protected namespaces`);
  for (const r of protectedRoutes) {
    const src = read(r);
    const guarded =
      /requireRole\s*\(/.test(src) ||
      /requireUser\s*\(/.test(src) ||
      /getCurrentUser(Detailed)?\s*\(/.test(src) ||
      // Re-export wrappers delegate to an already-guarded route.
      /^export \{[^}]+\} from "@\/app\/api\//m.test(src);
    ok(guarded, `${r} performs its own server-side authorization`);
  }
  const admin = protectedRoutes.filter((r) => r.startsWith("src/app/api/admin/"));
  for (const r of admin) {
    ok(/requireRole\("ADMIN"(,\s*"TEACHER")?\)/.test(read(r)), `${r} uses requireRole(ADMIN…)`);
  }
}

// ---------------------------------------------------------------------------
section("7. Session cookie flags & auth hygiene");
// ---------------------------------------------------------------------------
{
  const auth = read("src/lib/auth.ts");
  ok(/httpOnly:\s*true/.test(auth), "session cookie is httpOnly");
  ok(/sameSite:\s*"lax"/.test(auth), "session cookie is sameSite=lax");
  ok(/secure:\s*process\.env\.NODE_ENV === "production"/.test(auth), "session cookie is secure in production");
  ok(/expires,/.test(auth) || /expires:/.test(auth), "session cookie carries an expiry");
  ok(/tokenHash:\s*sha256\(token\)/.test(auth), "only the SHA-256 of the session token is stored");
  ok(/scryptSync/.test(auth) && /timingSafeEqual/.test(auth), "scrypt + constant-time password verification");

  const login = read("src/app/api/auth/[action]/route.ts");
  ok(
    /role === "TEACHER" \|\| role === "ADMIN"/.test(login),
    "self-registration as TEACHER/ADMIN remains blocked"
  );
  ok(/function safeUser/.test(login) && !/password/.test(login.split("function safeUser")[1]), "safeUser never returns the password hash");

  const reqReset = read("src/app/api/auth/password-reset/request/route.ts");
  ok(/checkRateLimit\(/.test(reqReset), "reset request is rate limited");
  ok(/Unknown identifier \(no account\)/.test(reqReset), "reset request keeps the generic path for unknown accounts");
  const confirm = read("src/app/api/auth/password-reset/confirm/route.ts");
  ok(/revokeAllSessions\(/.test(confirm), "reset confirm revokes every session");
  ok(/MAX_TOKEN_ATTEMPTS/.test(confirm), "reset confirm has a per-token attempt limit");
}

// ---------------------------------------------------------------------------
section("8. Public endpoints never serialise full User rows");
// ---------------------------------------------------------------------------
{
  const groups = read("src/app/api/groups/route.ts");
  ok(!/user:\s*true/.test(groups), "/api/groups (public) no longer includes the raw teacher User row");
  ok(/user:\s*\{\s*select:\s*\{\s*name:\s*true\s*\}\s*\}/.test(groups), "/api/groups selects only the teacher's name");
  ok(!/include:\s*\{/.test(groups), "/api/groups uses an explicit select, not include");

  // Every route in a PUBLIC namespace must avoid bare `user: true`.
  const publicRoutes = [
    "src/app/api/settings/public/route.ts",
    "src/app/api/subscription-plans/route.ts",
    "src/app/api/groups/route.ts",
    "src/app/api/route.ts",
  ];
  for (const r of publicRoutes) {
    ok(!/user:\s*true/.test(read(r)), `${r} does not include raw User rows`);
  }
}

// ---------------------------------------------------------------------------
section("9. Repository hygiene: examples excluded, secrets untracked");
// ---------------------------------------------------------------------------
{
  const tsconfig = JSON.parse(read("tsconfig.json"));
  ok(Array.isArray(tsconfig.exclude) && tsconfig.exclude.includes("examples"), "tsconfig excludes examples/");
  const gitignore = read(".gitignore");
  ok(/^\.env$/m.test(gitignore), ".env is ignored");
  ok(/^\/examples\/$/m.test(gitignore), "examples/ stays ignored (development reference only)");
  ok(!fs.existsSync(path.join(REPO, ".env")) || true, "(.env presence is a local matter, never tracked)");

  const tracked = execSync("git ls-files", { cwd: REPO, encoding: "utf8" }).split("\n");
  ok(!tracked.includes(".env"), ".env is not tracked by git");
  ok(!tracked.some((f) => /\.pem$|\.key$/.test(f)), "no private key files are tracked");
  ok(tracked.includes(".env.example"), ".env.example is tracked");

  const pkg = JSON.parse(read("package.json"));
  ok(!/NODE_ENV=production /.test(pkg.scripts.start), "start script no longer relies on shell env-prefix syntax");
  ok(/start-production\.mjs/.test(pkg.scripts.start), "start script uses the portable launcher");
  ok(fs.existsSync(path.join(REPO, "scripts/start-production.mjs")), "portable launcher exists");
}

console.log(`\nsecurity hardening: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
