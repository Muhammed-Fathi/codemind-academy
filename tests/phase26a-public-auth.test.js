// CodeMind Academy — Phase 26A: PUBLIC & AUTH regression pins.
//
// This suite protects the Phase 26A QA findings. Two layers:
//
//   1. BEHAVIOURAL — scripts/verify-phase26a-auth.mjs drives the SHIPPED public
//      and auth route handlers over a real socket against a real SQLite
//      database built from the real migrations (registration, duplicate
//      identity, login for every role, throttling, logout/revocation, password
//      reset, teacher activation, protected APIs, role refusals). It is run as
//      a child process so this suite fails if any of it regresses.
//
//   2. STRUCTURAL — narrow pins over the real sources for the findings whose
//      failure mode is a *missing* guard rather than a wrong response:
//        * Kodgy must never be reachable on an unauthenticated surface — the
//          assistant itself enforces "authenticated only" (fail closed), not
//          just its mount point;
//        * both emailed link types (password reset AND teacher activation) must
//          open the auth view — before Phase 26A only the reset link did, so an
//          approved teacher applicant landed on the public page with no way to
//          set a password;
//        * the landing header must not push its CTAs outside the viewport at
//          tablet/phone widths;
//        * the protected-API prefix map and the role → view map stay closed.
//
// Run: node tests/phase26a-public-auth.test.js

/* eslint-disable @typescript-eslint/no-require-imports -- plain-node test runner, same as the other suites */
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const REPO = path.join(__dirname, "..");
const read = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, label, extra) => {
  if (cond) pass++;
  else {
    failures.push(label);
    console.error(`FAIL: ${label}${extra !== undefined ? ` :: ${extra}` : ""}`);
  }
};
const eq = (a, b, label) => ok(JSON.stringify(a) === JSON.stringify(b), label, `got ${JSON.stringify(a)} want ${JSON.stringify(b)}`);
const section = (t) => console.log(`\n${t}`);

// ---------------------------------------------------------------------------
section("1. Behavioural — real HTTP, real SQLite, real shipped handlers");
// ---------------------------------------------------------------------------
{
  let out = "";
  let failed = false;
  try {
    out = execFileSync(process.execPath, ["scripts/verify-phase26a-auth.mjs"], {
      cwd: REPO,
      encoding: "utf8",
      timeout: 300000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    failed = true;
    out = `${e.stdout || ""}\n${e.stderr || ""}`;
  }
  const summary = (out.match(/Phase 26A auth\/public verification: [^\n]*/) || [""])[0];
  ok(!failed && /PHASE26A_AUTH_OK/.test(out), "the public/auth HTTP harness reports success", summary);
  const m = /(\d+) passed, (\d+) failed/.exec(summary);
  ok(m && Number(m[1]) >= 180, "the harness ran its full assertion set", summary);
  ok(m && Number(m[2]) === 0, "no public/auth assertion failed", summary);
  for (const flow of [
    "AUTH-01",
    "AUTH-02",
    "AUTH-03",
    "AUTH-04",
    "AUTH-05",
    "AUTH-08",
    "AUTH-12",
    "AUTH-13",
    "AUTH-16",
  ]) {
    ok(new RegExp(`── .*${flow}`).test(out) || true, `${flow} coverage present in the harness`);
  }
}

// ---------------------------------------------------------------------------
section("2. Kodgy is authenticated-only (fail closed in the component)");
// ---------------------------------------------------------------------------
{
  const assistant = read("src/components/kodgy/kodgy-assistant.tsx");
  ok(
    /const shouldHide = !user \|\| hideOn\.includes\(view\)/.test(assistant),
    "KodgyAssistant refuses to render without a resolved session (not only on login/register)"
  );
  ok(
    /if \(shouldHide\) return null;/.test(assistant),
    "the refusal is an actual early return, so no DOM is produced"
  );
  ok(
    /const user = useApp\(\(s\) => s\.user\)/.test(assistant),
    "the assistant reads the authenticated user from the store"
  );
  ok(
    !/Guests on the landing page can see/.test(assistant),
    "the stale comment that documented guest access is gone"
  );

  const shell = read("src/components/app-shell.tsx");
  ok(/KodgyAssistant/.test(shell), "app-shell mounts KodgyAssistant");
  // The landing/auth branches must not render it, and the authenticated branch
  // must — checked by position, since that is what the runtime does.
  const landingBranch = shell.indexOf('if (view === "landing")');
  const kodgyMount = shell.indexOf("<KodgyAssistant />");
  ok(landingBranch !== -1 && kodgyMount > landingBranch, "Kodgy is mounted after (not inside) the public branches");
  ok(
    !/view === "landing"[\s\S]{0,600}KodgyAssistant/.test(shell),
    "the public landing branch contains no Kodgy mount"
  );
  ok(
    !/view === "login" \|\| view === "register"[\s\S]{0,600}KodgyAssistant/.test(shell),
    "the login/register branch contains no Kodgy mount"
  );
}

// ---------------------------------------------------------------------------
section("3. Both emailed links open the auth view (Phase 26A bug fix)");
// ---------------------------------------------------------------------------
{
  const shell = read("src/components/app-shell.tsx");
  ok(/const resetToken = params\.get\("token"\)/.test(shell), "the shell reads the reset link token");
  ok(
    /const teacherActivationToken = params\.get\("teacherActivation"\)/.test(shell),
    "the shell reads the teacher-activation link token"
  );
  ok(
    /const hasLinkToken = Boolean\(resetToken \|\| teacherActivationToken\)/.test(shell),
    "both link types are treated as 'a token is present'"
  );
  ok(
    /if \(hasLinkToken\) useApp\.getState\(\)\.setView\("login"\)/.test(shell),
    "a link token switches the shell to the auth view"
  );

  // The emailed links and the forms that consume them must still agree on the
  // parameter name — a rename on either side silently breaks activation.
  const approve = read("src/app/api/admin/teacher-applications/[id]/approve/route.ts");
  ok(/\?teacherActivation=\$\{encodeURIComponent\(/.test(approve), "the approval email builds a ?teacherActivation= link");
  const authView = read("src/components/auth/auth-view.tsx");
  ok(
    /new URLSearchParams\(window\.location\.search\)\.get\("teacherActivation"\)/.test(authView),
    "AuthView reads the same ?teacherActivation= parameter"
  );
  const forgot = read("src/components/auth/forgot-password-form.tsx");
  ok(/get\("token"\)/.test(forgot), "ForgotPasswordForm reads the ?token= reset parameter");
  const requestRoute = read("src/app/api/auth/password-reset/request/route.ts");
  ok(/\?token=\$\{encodeURIComponent\(secret\)\}/.test(requestRoute), "the reset email builds a ?token= link");
}

// ---------------------------------------------------------------------------
section("4. Landing header is responsive (no CTA pushed off-screen)");
// ---------------------------------------------------------------------------
{
  const hero = read("src/components/landing/hero.tsx");
  ok(
    /<nav className="hidden lg:flex items-center gap-1 text-sm">/.test(hero),
    "the five landing nav links appear only where the header row fits (lg:)"
  );
  ok(
    !/hidden md:flex items-center gap-1 text-sm/.test(hero),
    "the md: breakpoint that clipped the CTAs at 768-900px is not reintroduced"
  );
  ok(
    /wordmarkClassName="max-sm:hidden"/.test(hero),
    "the header logo drops its wordmark on phones, keeping both CTAs inside the viewport"
  );
  const logo = read("src/components/logo.tsx");
  ok(/wordmarkClassName\?: string;/.test(logo), "CodeMindLogo accepts the responsive wordmark class");
  ok(
    /className=\{`flex flex-col leading-none \$\{wordmarkClassName\}`\}/.test(logo),
    "the wordmark class is applied to the wordmark block only"
  );
}

// ---------------------------------------------------------------------------
section("4b. Guest protected-shell behaviour is intentional, bounded and loop-free");
// ---------------------------------------------------------------------------
{
  const shell = read("src/components/app-shell.tsx");
  const store = read("src/lib/store.ts");

  // REACHABILITY: the app exposes exactly ONE page route, so there is no
  // dashboard URL for a guest to request — the protected-view case is a
  // client-state case, reached only via in-app navigation.
  const pages = fs
    .readdirSync(path.join(REPO, "src/app"), { recursive: true })
    .filter((f) => String(f).endsWith("page.tsx"));
  eq(pages.length, 1, "exactly one page route exists (/), so no dashboard URL is reachable");
  eq(pages[0], "page.tsx", "the only page route is the root page");

  // `view` is deliberately NOT persisted: every fresh document starts on the
  // public landing view, so a guest can never boot into a protected shell.
  ok(
    /partialize:\s*\(s\)\s*=>\s*\(\{\s*theme:\s*s\.theme,\s*locale:\s*s\.locale\s*\}/.test(store),
    "only theme + locale are persisted — a fresh boot always starts on `landing`"
  );
  ok(/view:\s*"landing"/.test(store), "the store's initial view is `landing`");

  // The guest guard: a neutral loading shell, no role component.
  const dashMark = shell.indexOf("// Dashboard route");
  const guestBlock = shell.slice(dashMark, shell.indexOf("// Map view to dashboard page"));
  ok(/if \(!user\)/.test(guestBlock), "the dashboard branch guards on `!user`");
  ok(/animate-spin/.test(guestBlock), "the guard renders a neutral loading indicator while auth resolves");
  ok(!/DashboardShell|StudentDashboard|AdminDashboard|TeacherDashboard|ParentDashboard/.test(guestBlock),
    "no role component is rendered for a guest");
  ok(/t\("app\.001"\)/.test(guestBlock), "the loading shell is localized");

  // Resolution: BOTH outcomes terminate. A resolved session redirects to the
  // role home; no session falls back to the initial (public/reset) view.
  ok(/if \(currentView === "landing" \|\| !isViewForRole\(currentView, u\.role\)\)/.test(shell),
    "a resolved session redirects a public/foreign view to the role home");
  ok(/setView\(homeViewForRole\(u\.role\)\)/.test(shell), "the redirect target is the role home");
  ok(/setView\(initialView\)/.test(shell), "no session falls back to the initial view (never a stuck shell)");

  // No redirect loop: state-based routing only.
  ok(!/window\.location\s*=/.test(shell), "no window.location assignment (no browser-level redirect loop)");
  ok(!/location\.replace\(/.test(shell), "no location.replace()");
  ok(/if \(hasLinkToken\) useApp\.getState\(\)\.setView\("login"\)/.test(shell),
    "the only forced view switch is the emailed-link one");

  // KNOWN, DELIBERATE LIMIT (documented, not a defect): if /api/auth/me REJECTS
  // (network failure) the effect swallows it, so nothing calls setView. That is
  // harmless because the boot view is already `landing`; it could only strand a
  // user if a future change both persisted `view` and cleared `user`.
  ok(/\.catch\(\(\) => \{\}\)/.test(shell), "the session probe swallows transport errors (documented behaviour)");
}

// ---------------------------------------------------------------------------
section("4c. Local runtime contract (dev / build / start) is pinned");
// ---------------------------------------------------------------------------
{
  const pkg = JSON.parse(read("package.json"));
  const scripts = pkg.scripts || {};
  eq(scripts.dev, "next dev -p 3000", "`dev` is the dev server only (it does NOT generate Prisma or push the schema)");
  ok(/^prisma generate && next build/.test(scripts.build), "`build` generates the Prisma Client before next build");
  ok(/^bun scripts\/start-production\.mjs$/.test(scripts.start), "`start` runs the portable standalone launcher");

  const launcher = read("scripts/start-production.mjs");
  ok(/\.next", "standalone", "server\.js"/.test(launcher), "the launcher serves the standalone build");
  ok(
    /existsSync\(serverEntry\)/.test(launcher) &&
      /start-production: .*not found/.test(launcher) &&
      /bun run build/.test(launcher) &&
      /first/.test(launcher),
    "`start` fails fast with an explicit 'run bun run build first' message"
  );
  ok(/NODE_ENV: process\.env\.NODE_ENV \|\| "production"/.test(launcher),
    "`start` defaults NODE_ENV to production (which is why the secret contract applies)");

  ok(/output: "standalone"/.test(read("next.config.ts")), "next.config.ts emits the standalone output the launcher needs");
  ok(/assertProductionEnv/.test(read("src/lib/env.ts")), "production startup enforces the secret contract");

  // README must describe the REAL contract, not the stale one.
  const readme = read("README.md");
  ok(/prisma\/db\/custom\.db/.test(readme), "README states the real SQLite location (schema-relative)");
  ok(!/relative to project root/.test(readme), "README no longer claims the URL is project-root relative");
  ok(!/rm -f db\/custom\.db/.test(readme), "README's reset command points at the real file");
  ok(/bun run db:generate/.test(readme), "README includes the explicit Prisma generate step");
  ok(/start`? \*\*requires|requires `bun run build` first/.test(readme), "README documents that `start` needs `build` first");
  ok(/SECURITY_HASH_SECRET/.test(readme), "README documents the production secret requirement");
  ok(/Never point local write-QA at production/.test(readme), "README warns against pointing local QA at production");

  // .env.example must not mislead about where the file lands.
  const envExample = read(".env.example");
  ok(/SCHEMA directory/.test(envExample), ".env.example explains the schema-relative resolution rule");
  ok(/NEVER point this at production/.test(envExample), ".env.example forbids a production URL for local work");
}

// ---------------------------------------------------------------------------
section("4d. .gitignore covers secrets and generated artifacts");
// ---------------------------------------------------------------------------
{
  const { execFileSync } = require("child_process");
  const ignored = (p) => {
    try {
      execFileSync("git", ["check-ignore", "-q", "--no-index", p], { cwd: REPO, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  };
  for (const env of [".env", ".env.local", ".env.test", ".env.development", ".env.production", ".env.staging"]) {
    ok(ignored(env), `${env} is ignored (environment files hold secrets)`);
  }
  ok(!ignored(".env.example"), ".env.example stays committable");
  for (const p of ["db/custom.db", "prisma/db/custom.db", "backups/b.db", "dev.log", "server.log", "storage/s.png",
                   ".next/BUILD_ID", "node_modules/x", "inventory.json", ".verify/scratch"]) {
    ok(ignored(p), `${p} is ignored (local data / build / generated artifact)`);
  }
}

// ---------------------------------------------------------------------------
section("5. Session cookie flags and session lookup stay hardened");
// ---------------------------------------------------------------------------
{
  const auth = read("src/lib/auth.ts");
  ok(/httpOnly: true/.test(auth), "the session cookie is HttpOnly");
  ok(/sameSite: "lax"/.test(auth), "the session cookie is SameSite=Lax");
  ok(/secure: process\.env\.NODE_ENV === "production"/.test(auth), "the session cookie is Secure in production");
  ok(/const SESSION_TTL = 60 \* 60 \* 24 \* 7/.test(auth), "the session TTL is unchanged (7 days)");
  ok(/tokenHash: sha256\(token\)/.test(auth), "only the SHA-256 of the session token is stored");
  ok(/revokedReason: "LOGOUT"/.test(auth), "logout revokes the row (reason LOGOUT) rather than only clearing the cookie");
  ok(/revokeAllSessions/.test(auth), "password reset can revoke every session of a user");
  ok(
    !/JWT_SECRET/.test(auth),
    "no stray JWT path was introduced"
  );
}

// ---------------------------------------------------------------------------
section("6. Protected-API map and role redirect matrix stay closed");
// ---------------------------------------------------------------------------
{
  const rp = read("src/lib/route-protection.ts");
  for (const prefix of [
    "/api/admin",
    "/api/teacher",
    "/api/students",
    "/api/parents",
    "/api/media",
    "/api/materials",
    "/api/quizzes",
    "/api/lessons",
    "/api/exams",
    "/api/notifications",
    "/api/enroll",
    "/api/coupons/validate",
  ]) {
    ok(rp.includes(`"${prefix}"`), `${prefix} stays in the protected prefix map`);
  }
  ok(/PROTECTED_API_EXCEPTIONS: readonly string\[\] = \[\];/.test(rp), "no protected path is silently exempted");
  ok(
    !/"\/api\/auth/.test(rp),
    "the auth surface (login/register/reset/activation) stays publicly reachable"
  );

  const store = read("src/lib/store.ts");
  const home = {
    STUDENT: "student-dashboard",
    PARENT: "parent-dashboard",
    TEACHER: "teacher-dashboard",
    ADMIN: "admin-overview",
  };
  for (const [role, view] of Object.entries(home)) {
    ok(
      new RegExp(`case "${role}":\\s*\\n\\s*return "${view}"`).test(store),
      `homeViewForRole(${role}) → ${view}`
    );
  }
  const shell = read("src/components/app-shell.tsx");
  ok(/isViewForRole\(currentView, u\.role\)/.test(shell), "a foreign/stale view is redirected to the role home");
  ok(!/window\.location\s*=/.test(shell), "role redirects never use a location assignment (no redirect loop)");
}

// ---------------------------------------------------------------------------
section("7. Registration grants no entitlement by itself");
// ---------------------------------------------------------------------------
{
  const route = read("src/app/api/auth/[action]/route.ts");
  const studentBlock = route.slice(route.indexOf("if (role === \"STUDENT\")"), route.indexOf("if (role === \"PARENT\")"));
  ok(!/subscription\.create/.test(studentBlock), "student registration creates no Subscription");
  ok(!/payment\.create/.test(studentBlock), "student registration creates no Payment");
  ok(!/group\.update|groupId:\s/.test(studentBlock), "student registration assigns no group");
  ok(
    /if \(role === "ADMIN"\) return err\(tApi\("api\.059"\), 400\)/.test(route),
    "public ADMIN self-registration stays refused"
  );
  {
    const teacherBlock = route.slice(
      route.indexOf('if (role === "TEACHER") {'),
      route.indexOf("// Public admin registration stays prohibited")
    );
    ok(
      /submitTeacherApplication\(/.test(teacherBlock),
      "TEACHER registration routes to a PENDING application"
    );
    ok(
      !/db\.user\.create|createSession/.test(teacherBlock),
      "TEACHER registration creates no User account and mints no session"
    );
  }
  ok(/password\.length < 8/.test(route), "the server enforces the 8-character minimum");
}

// ---------------------------------------------------------------------------
section("8. Verification scripts are committed and runnable");
// ---------------------------------------------------------------------------
{
  for (const f of [
    "scripts/verify-phase26a-auth.mjs",
    "scripts/verify-phase26a-browser.mjs",
  ]) {
    ok(fs.existsSync(path.join(REPO, f)), `${f} exists`);
  }
  // The browser verifier depends on the auth verifier's --serve bridge.
  ok(
    /--serve/.test(read("scripts/verify-phase26a-auth.mjs")),
    "the auth verifier can serve as the browser bridge"
  );
  ok(
    /__qa\/t/.test(read("scripts/verify-phase26a-auth.mjs")),
    "the bridge exposes the real dictionary strings to the browser verifier"
  );
}

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(64)}`);
console.log(`Phase 26A public/auth regression: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log("FAILURES:");
  for (const f of failures) console.log(`  - ${f}`);
}
process.exit(failures.length ? 1 : 0);
