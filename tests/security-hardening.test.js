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
      // Phase 26G review: the origin contract (src/lib/app-url.ts) is now
      // exercised DIRECTLY as well as through env.ts, so the accept/reject
      // table is pinned at the module that owns it.
      path.join(REPO, "src/lib/app-url.ts"),
    ],
  })
);
execSync(`npx tsc -p ${path.join(OUT, "tsconfig.json")}`, { cwd: REPO, stdio: "pipe" });
const Env = require(path.join(OUT, "env.js"));
const RP = require(path.join(OUT, "route-protection.js"));
const AppUrl = require(path.join(OUT, "app-url.js"));

const REAL = "a".repeat(64);

// ---------------------------------------------------------------------------
section("1. SECURITY_HASH_SECRET is mandatory in production");
// ---------------------------------------------------------------------------
{
  const prod = (extra) => ({ NODE_ENV: "production", ...extra });
  // Phase 26G: the production contract gained the application ORIGIN
  // (src/lib/app-url.ts). `PROD_OK` is therefore the smallest environment that
  // satisfies BOTH halves — every existing secret assertion below keeps its
  // original subject and strength; only the "otherwise clean" baseline grew.
  const PROD_URL = "https://codemind.example.academy";
  const PROD_OK = { SECURITY_HASH_SECRET: REAL, NEXT_PUBLIC_URL: PROD_URL };

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
    Env.validateProductionEnv(prod(PROD_OK)).length === 0,
    "validateProductionEnv is clean with a proper secret and a proper origin"
  );
  let cleanThrew = false;
  try {
    Env.assertProductionEnv(prod(PROD_OK));
  } catch {
    cleanThrew = true;
  }
  ok(!cleanThrew, "assertProductionEnv passes with a proper secret and origin");

  // ---- Phase 26G: the application origin is part of the production contract.
  // Without it in production, every emailed reset/activation link resolves to
  // http://localhost:3000 — delivered, valid, and unusable — while the route
  // reports success. These pins hold that failure at build/startup instead.
  ok(
    Env.validateProductionEnv(prod({ SECURITY_HASH_SECRET: REAL })).some((p) =>
      /NEXT_PUBLIC_URL/.test(p)
    ),
    "production + unset NEXT_PUBLIC_URL is reported as a problem"
  );
  ok(
    Env.validateProductionEnv(
      prod({ SECURITY_HASH_SECRET: REAL, NEXT_PUBLIC_URL: "   " })
    ).some((p) => /NEXT_PUBLIC_URL/.test(p)),
    "production + blank NEXT_PUBLIC_URL is reported as a problem"
  );
  ok(
    Env.validateProductionEnv(
      prod({ SECURITY_HASH_SECRET: REAL, NEXT_PUBLIC_URL: "http://localhost:3000" })
    ).some((p) => /NEXT_PUBLIC_URL/.test(p)),
    "production + a localhost origin is rejected (emailed links would be dead)"
  );
  ok(
    Env.validateProductionEnv(
      prod({ SECURITY_HASH_SECRET: REAL, NEXT_PUBLIC_URL: "not-a-url" })
    ).some((p) => /NEXT_PUBLIC_URL/.test(p)),
    "production + a non-absolute origin is rejected"
  );
  ok(
    Env.validateProductionEnv(
      prod({ SECURITY_HASH_SECRET: REAL, NEXT_PUBLIC_URL: "javascript:alert(1)" })
    ).some((p) => /NEXT_PUBLIC_URL/.test(p)),
    "production + a non-http(s) scheme origin is rejected"
  );
  ok(
    Env.validateProductionEnv(
      prod({ SECURITY_HASH_SECRET: REAL, NEXT_PUBLIC_URL: PROD_URL })
    ).length === 0,
    "production + a real https origin has no origin problem"
  );
  // Non-production keeps the localhost fallback the suites rely on.
  ok(
    Env.validateProductionEnv({ NODE_ENV: "development" }).length === 0 &&
      Env.validateProductionEnv({}).length === 0,
    "non-production never requires NEXT_PUBLIC_URL"
  );
  // No problem message may ever echo a configured value back.
  ok(
    Env.validateProductionEnv(
      prod({ SECURITY_HASH_SECRET: REAL, NEXT_PUBLIC_URL: "http://127.0.0.1:3000" })
    ).every((p) => !/127\.0\.0\.1/.test(p)),
    "origin problems name the variable, never its value"
  );

  // =========================================================================
  // Phase 26G REVIEW — PRODUCTION ORIGIN IS HTTPS-ONLY.
  //
  // The first pass of 26G accepted any absolute non-loopback http(s) origin.
  // That still permits `http://codemind.example.com` in production, and this
  // origin is the PREFIX of every password-reset and teacher-activation link
  // — URLs that carry a single-use credential in the query string. Over plain
  // http that token is readable and rewritable by anyone on the path, and any
  // https->http hop leaks it in a Referer. Both flows are account-takeover /
  // account-creation surfaces, so the contract is tightened to `https:` only
  // and the build/boot check FAILS CLOSED. These pins hold that line.
  // =========================================================================
  const originProblem = (value) =>
    AppUrl.getAppUrlProblem(prod({ NEXT_PUBLIC_URL: value }));

  // ---- ACCEPTED in production (the whole accept table) --------------------
  for (const good of [
    "https://codemind.academy",
    "https://app.codemind.academy",
    "https://codemind.academy:8443",
    // A base-path deployment is legitimate: appUrl() appends after it.
    "https://codemind.academy/app",
    "https://codemind.academy/app/",
    "https://codemind.vercel.app",
  ]) {
    ok(
      originProblem(good) === null,
      `production accepts the https origin ${good}`
    );
  }

  // ---- REJECTED in production (the whole reject table) --------------------
  // The core of the review: a PUBLIC host over plain http is still rejected.
  for (const bad of [
    "http://codemind.academy", // <-- the exact misconfiguration under review
    "http://app.codemind.academy",
    "http://codemind.example.com",
    "http://codemind.vercel.app",
    "http://localhost:3000",
    "https://localhost:3000", // https does NOT rescue a loopback host
    "http://127.0.0.1:3000",
    "https://127.0.0.1:3000",
    "https://127.0.0.2", // the whole 127/8 block, not just .0.1
    "https://[::1]",
    "https://[::ffff:127.0.0.1]",
    "https://0.0.0.0",
    "https://internal.local",
    "https://box.localhost",
    "ftp://codemind.academy",
    "file:///etc/passwd",
    "mailto:admin@codemind.academy",
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "not-a-url",
    "//codemind.academy", // protocol-relative: not an absolute origin
    "/codemind.academy",
    "codemind.academy", // bare host, no scheme
    "https://", // no host
    // Embedded credentials in a "public" origin variable.
    "https://user:pass@codemind.academy",
    "https://user@codemind.academy",
    // A query string or fragment in the base would collide with / swallow the
    // token that appUrl() appends.
    "https://codemind.academy/?a=1",
    "https://codemind.academy/#frag",
    "https://codemind.academy/app?a=1",
    "https://codemind.academy/app#frag",
  ]) {
    ok(
      originProblem(bad) !== null,
      `production rejects the origin ${JSON.stringify(bad)}`
    );
  }

  // Missing / blank, and the error never echoes a value.
  ok(
    originProblem(undefined) !== null && originProblem("") !== null &&
      originProblem("   ") !== null,
    "production rejects a missing, empty or whitespace-only origin"
  );
  // The rejection text quotes a GENERIC example ("https://codemind.academy"),
  // so the real invariant is that the operator's own value is never echoed.
  // A distinctive host proves it: if the message replayed the input, this
  // would contain "secret-internal-host".
  const ECHO_MSG = originProblem("http://secret-internal-host.example") || "";
  ok(
    !/secret-internal-host/.test(ECHO_MSG),
    "the http rejection message names the variable, never the configured value"
  );
  ok(
    /https/i.test(originProblem("http://codemind.academy") || ""),
    "the http rejection message tells the operator what to use instead"
  );

  // ---- resolveAppUrl: throws in production, never silently falls back -----
  for (const bad of ["http://codemind.academy", "https://localhost:3000", undefined]) {
    let threw = false;
    try {
      AppUrl.resolveAppUrl(prod(bad === undefined ? {} : { NEXT_PUBLIC_URL: bad }));
    } catch {
      threw = true;
    }
    ok(
      threw,
      `resolveAppUrl throws in production for ${JSON.stringify(bad)} (no silent localhost fallback)`
    );
  }
  // Trailing slash is normalized away, so appUrl() cannot mint "//x".
  ok(
    AppUrl.resolveAppUrl(prod({ NEXT_PUBLIC_URL: "https://codemind.academy///" })) ===
      "https://codemind.academy",
    "a trailing slash on the configured origin is removed"
  );
  ok(
    AppUrl.appUrl("/reset-password?token=abc", prod({ NEXT_PUBLIC_URL: PROD_URL })) ===
      "https://codemind.example.academy/reset-password?token=abc",
    "appUrl() mints an https link from a server-owned path in production"
  );
  ok(
    AppUrl.appUrl("/reset-password?token=abc", {
      NODE_ENV: "production",
      NEXT_PUBLIC_URL: "https://codemind.academy/app/",
    }) === "https://codemind.academy/app/reset-password?token=abc",
    "appUrl() honours an https base path without doubling the separator"
  );

  // ---- DEV / TEST keep the localhost HTTP fallback -------------------------
  // Nothing above may leak into development: that is the whole point of the
  // split contract, and the offline verifiers depend on it.
  for (const env of [
    { NODE_ENV: "development" },
    { NODE_ENV: "test" },
    {}, // unset NODE_ENV (offline verifiers)
  ]) {
    ok(
      AppUrl.getAppUrlProblem(env) === null,
      `non-production never requires an origin (NODE_ENV=${env.NODE_ENV || "unset"})`
    );
    ok(
      AppUrl.resolveAppUrl(env) === "http://localhost:3000",
      `non-production keeps the http://localhost:3000 fallback (NODE_ENV=${env.NODE_ENV || "unset"})`
    );
  }
  ok(
    AppUrl.getAppUrlProblem({ NODE_ENV: "development", NEXT_PUBLIC_URL: "http://localhost:4000" }) === null,
    "development still accepts a plain http origin"
  );
  ok(
    AppUrl.resolveAppUrl({ NODE_ENV: "development", NEXT_PUBLIC_URL: "http://localhost:4000" }) ===
      "http://localhost:4000",
    "development honours an explicitly configured http origin"
  );
  ok(
    AppUrl.appUrl("/reset-password?token=abc", { NODE_ENV: "test" }) ===
      "http://localhost:3000/reset-password?token=abc",
    "appUrl() still mints the localhost link in test"
  );

  // ---- Source-level: no call site may re-introduce the old fallback --------
  const APP_URL_SRC = read("src/lib/app-url.ts");
  ok(
    !/url\.protocol\s*===\s*"http:"/.test(APP_URL_SRC) &&
      !/url\.protocol\s*!==\s*"http:"/.test(APP_URL_SRC),
    "the validator contains no `http:` acceptance branch"
  );
  ok(
    (APP_URL_SRC.match(/url\.protocol !== "https:"/g) || []).length === 1,
    "exactly one scheme gate, and it requires https"
  );
  ok(
    /url\.username \|\| url\.password/.test(APP_URL_SRC),
    "embedded credentials in the configured origin are rejected"
  );
  ok(
    /url\.search/.test(APP_URL_SRC) && /url\.hash/.test(APP_URL_SRC),
    "a query string or fragment in the configured origin is rejected"
  );
  for (const rel of [
    "src/app/api/auth/password-reset/request/route.ts",
    "src/app/api/admin/teacher-applications/[id]/approve/route.ts",
    "src/app/api/students/me/referral/route.ts",
  ]) {
    const src = read(rel);
    ok(
      !/localhost:3000/.test(src.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")),
      `${rel} no longer hardcodes a localhost origin in code`
    );
    ok(/appUrl\(/.test(src), `${rel} builds absolute links through appUrl()`);
  }
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
  // PORTABILITY (Phase 26G): normalise to POSIX separators BEFORE stripping
  // the `src/app/` prefix, and store the NORMALISED form in `routes`.
  //
  // On Windows `path.relative` yields `src\app\api\admin\...`. The old code
  // tried to strip `src/app/` FIRST and only then rewrote `\` -> `/`, so the
  // prefix never matched and `isProtectedApiPath` was handed
  // `/src/app/api/...` — a path that is not under any protected namespace.
  // The suite then reported `found 0 routes in protected namespaces` and
  // exited 1 on every Windows checkout while passing on Linux/macOS.
  //
  // Normalising once, here, fixes the discovery AND every downstream
  // `startsWith("src/app/api/...")` filter below (they compare against
  // POSIX-style prefixes too).
  const routes = walk(api).map((p) =>
    path.relative(REPO, p).split(path.sep).join("/")
  );
  ok(
    routes.length > 0 && routes.every((r) => !r.includes("\\")),
    `discovered route paths are separator-normalised (${routes.length} routes)`
  );
  // POSIX-only directory name. `path.dirname` cannot be used here: on Windows
  // `path.win32.dirname("src/app/api/admin/overview")` hands back
  // "src\\app\\api\\admin", which re-introduces the very backslashes the
  // normalisation above removed. Splitting the already-normalised string is
  // identical on every platform.
  const routeDir = (r) => r.split("/").slice(0, -1).join("/");
  const protectedRoutes = routes.filter((r) =>
    RP.isProtectedApiPath("/" + routeDir(r).replace(/^src\/app\//, ""))
  );
  ok(protectedRoutes.length >= 60, `found ${protectedRoutes.length} routes in protected namespaces`);
  ok(
    protectedRoutes.every((r) => r.startsWith("src/app/api/")),
    "every discovered protected route keeps its src/app/api prefix (no double-prefixed /src/app/api/… paths)"
  );
  // Regression pin for the exact symptom the Windows defect produced: the
  // discovery collapsed to ZERO routes, so every namespace was empty at once.
  // Requiring at least one hit per namespace fails loudly on a separator
  // regression instead of silently disabling §6's per-route authorization
  // sweep (which would otherwise pass vacuously over an empty list).
  ok(
    ["admin", "students", "parents", "teacher"].every((ns) =>
      protectedRoutes.some((r) => r.startsWith(`src/app/api/${ns}/`))
    ),
    "route discovery finds at least one route in every protected namespace (admin, students, parents, teacher)"
  );
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
    /if \(role === "ADMIN"\) return err\(tApi\("api\.059"\), 400\)/.test(login),
    "self-registration as ADMIN remains blocked"
  );
  // Phase 20 addendum: TEACHER self-registration now submits a PENDING
  // application — it must still never create a session or a User account.
  ok(
    /submitTeacherApplication\(/.test(login),
    "TEACHER self-registration submits a teacher application"
  );
  const teacherBranch = login.slice(
    login.indexOf('if (role === "TEACHER")'),
    login.indexOf("// Public admin registration")
  );
  ok(!/createSession\(/.test(teacherBranch), "TEACHER self-registration never creates a session");
  ok(!/db\.user\.create/.test(teacherBranch), "TEACHER self-registration never creates a User");
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
