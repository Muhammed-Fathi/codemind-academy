# Phase 3 — Production Security Hardening

Date: 2026-09-07
Branch: `arena/01a07e2f-codemind-academy` → PR against `main`

# Objective

Strengthen the platform for production: eliminate the unsafe development
fallback for the security hash secret, add a minimal defense-in-depth layer,
review and fix dependency vulnerabilities without framework churn, review
authentication / authorization / secrets, make production startup portable,
and close the Phase 2 carry-over (`examples/` breaking `tsc`).

No product features, no database/schema changes, no PostgreSQL migration, no
Prisma version change.

# Baseline

Verified before any change:

| Item | Result |
|---|---|
| `main` HEAD | `5bd041c` (Merge PR #19 — Phase 2 build & type safety) — matches the approved baseline |
| Working branch | `arena/01a07e2f-codemind-academy`, branched from `5bd041c`, clean tree |
| `bun run typecheck` | PASS, 0 errors (in this checkout `examples/` is absent because it is git-ignored — see carry-over) |
| Tests (`node tests/*.test.js`, 7 suites) | 337 passed, 0 failed |
| `bun run lint` | 78 problems with lockfile versions (`eslint-config-next` 16.1.3); 50 with the updated toolchain — all pre-existing, see Testing |
| `bun run build` | PASS (Prisma generate → real type validation → compile → 62 pages → standalone asset copy) |
| `npm audit` (package-lock) | 12 vulnerabilities (4 moderate, 8 high) — exactly the figure from the previous audit |
| `bun audit` (bun.lock) | 93 vulnerabilities (1 critical, 49 high, 37 moderate, 6 low) — bun's audit also walks dev-only transitive trees |

Environment note: the sandbox cannot reach `binaries.prisma.sh` (TLS blocked),
so the Prisma *engine binaries* could not be downloaded. `prisma generate`
(client + types) and everything that depends on it ran with
`PRISMA_SCHEMA_ENGINE_BINARY/PRISMA_QUERY_ENGINE_LIBRARY` stubbed. Consequences
are called out under Testing → Production Startup. No repository file was
altered to work around this.

# Phase 2 Carry-over

**Finding.** `examples/websocket/{frontend.tsx,server.ts}` are demo files that
import `socket.io` / `socket.io-client`. They are already git-ignored
(`/examples/` in `.gitignore`) and not part of the application, but on any
developer machine where the directory exists the broad `"**/*.ts", "**/*.tsx"`
include in `tsconfig.json` pulled them into `tsc --noEmit` and produced
"Cannot find module" errors. ESLint already ignored `examples/**`.

**Fix.** `tsconfig.json` → `"exclude": ["node_modules", "examples"]`.

- Examples preserved as examples (still ignored, still untouched).
- No dependency added; no runtime behaviour changed.
- Verified by recreating `examples/websocket/frontend.tsx` with the
  `socket.io-client` import locally: `bun run typecheck` passes, and the
  directory was removed again (it is not tracked).

**Result: Resolved.**

# Security Findings

| # | Severity | Finding | Status |
|---|---|---|---|
| F1 | HIGH | `src/lib/security.ts` fell back to the literal `"codemind-dev-hash-secret"` when `SECURITY_HASH_SECRET` was unset — in production this would key every IP hash and device fingerprint with a public constant (device-fingerprint forgery, de-anonymisable audit log). | **Fixed** (build + runtime fail-fast) |
| F2 | HIGH | `GET /api/groups` (public, unauthenticated, used by the enrolment picker) used `include: { teacher: { include: { user: true } } }`, serialising the teacher's **entire `User` row including the scrypt password hash, phone and e-mail** to anonymous callers. | **Fixed** (explicit `select`, name only) |
| F3 | MEDIUM | No request-level guard: an accidentally unguarded handler in `/api/admin/*` etc. would be reachable anonymously; anonymous probing of protected namespaces always hit route code + DB. | **Fixed** (proxy defense-in-depth) |
| F4 | MEDIUM | No baseline security headers; `X-Powered-By: Next.js` fingerprint exposed. | **Fixed** (`next.config.ts` headers) |
| F5 | MEDIUM | Dependency vulnerabilities (nodemailer SMTP/CRLF injections, sharp/libvips CVEs, Next.js proxy bypass + DoS, several transitive ReDoS/prototype-pollution issues). | **Fixed where safe** — see Dependency Audit |
| F6 | LOW | `start` script not portable to Windows CMD. | **Fixed** (dependency-free launcher) |
| F7 | INFO | `xlsx@0.18.5` has two advisories with no fix on the npm registry. | **Documented** (admin-only, see Remaining Risks) |

Reviewed and found **sound** (no change needed): session cookie flags, scrypt
password hashing with constant-time compare, session token hashing, password
reset flow (enumeration-safe, rate-limited, single-use, session revocation),
registration role lock-down, admin/teacher/student/parent route authorization
patterns, media authorization, quiz-evidence admin-only access.

# SECURITY_HASH_SECRET

New module `src/lib/env.ts` (server-only, pure, no DB):

- `getSecurityHashSecret()` — **production**: requires `SECURITY_HASH_SECRET`,
  rejects empty/whitespace, values `< 32` chars, the dev fallback literal and
  the `.env.example` placeholder; throws a message that names the variable and
  never includes any value. **development/test**: returns the variable if set,
  otherwise the clearly-labelled dev fallback (so `bun run dev` and the
  offline test suites keep working with zero configuration).
- `validateProductionEnv()` / `assertProductionEnv()` — aggregate check.

Wired in three places:

1. `src/lib/security.ts` — `hashIp()` and `deviceHashFromHeaders()` now call
   `getSecurityHashSecret()`; the `|| "codemind-dev-hash-secret"` fallbacks are
   gone.
2. `next.config.ts` — `assertProductionEnv()` runs when `NODE_ENV=production`
   (i.e. every `next build`), so a production build fails immediately with a
   clear message. `SKIP_PRODUCTION_ENV_CHECK=1` exists only for CI build hosts
   that intentionally hold no secrets; the runtime check still applies.
3. `src/instrumentation.ts` — Next.js `register()` hook runs once at server
   start (Node runtime only), calls `assertProductionEnv()` and exits the
   process with code 1 on failure (Next would otherwise keep serving 500s).

`.env.example` documents the variable with a placeholder
(`REPLACE_WITH_openssl_rand_hex_32`) and generation commands. The placeholder
itself is on the production reject-list.

Verified: production build without the variable → fails at config load with
the message; standalone server without it → prints the message and exits 1;
with a real value → boots and serves.

# Middleware

**Added — as `src/proxy.ts`** (Next.js 16 renamed the `middleware` file
convention to `proxy`; the build reports it as "ƒ Proxy (Middleware)").

Architecture review first: the app is a single-page shell — the only page
route is `/`; every portal (admin/teacher/student/parent) is a client-side view
whose data comes exclusively from `/api/*`, and every API route already does
server-side authorization via `requireUser` / `requireRole` plus scope checks.
Therefore:

- There are **no page routes to redirect** (`/admin`, `/teacher`, … do not
  exist); page-level middleware would be dead code. Documented in
  `src/lib/route-protection.ts`.
- The proxy guards **API namespaces only**: `/api/admin`, `/api/teacher`,
  `/api/students`, `/api/parents`, `/api/media`, `/api/quizzes`,
  `/api/lessons`, `/api/exams`, `/api/notifications`, `/api/enroll`,
  `/api/ai`, `/api/coupons/validate`. A request with **no `cm_session`
  cookie** gets the same `{ "error": "Unauthorized" }` 401 the routes return.
- It performs **no database access and no role logic** — the cookie's presence
  proves nothing; the route still validates the session and role. It is
  strictly an additional layer.
- Public surface untouched: `/`, `/api/auth/*` (login/register/logout/me/
  password-reset), `/api/settings/public`, `/api/subscription-plans`,
  `/api/groups`, `/api/courses`, `/api`.
- Matcher limited to `/api/:path*`; static assets and pages are not evaluated.

Verified live against the standalone build: `/` 200; `/api/auth/me` 401 (route,
not proxy); admin/teacher/student/parent/media/notifications endpoints 401
without a cookie; with a bogus cookie the request reaches the route, which
rejects it itself.

# Dependency Audit

Method: `npm audit` (package-lock) and `bun audit` (bun.lock) on the actual
lockfiles; each finding classified; only safe/compatible changes applied.
**Prisma untouched (6.19.x). React untouched. No major framework upgrade.**

| Package | Was → Now | Class | Decision |
|---|---|---|---|
| `nodemailer` | 7.0.13 → **9.1.1** | direct, runtime, **directly used** (`src/lib/mailer.ts` SMTP) | Upgrade. The two majors between are non-breaking for us: 8.0.0 only renamed error code `NoAuth`→`ENOAUTH` (not referenced), 9.0.0 only makes remote-content/OAuth2 TLS validation strict (we use none of it). 9.1.1 covers all 6 advisories. `@types/nodemailer` 7→8 to match. |
| `sharp` | 0.34.5 → **0.35.4** | direct (Next image optimiser) | Upgrade; only Node ≥ 20.9 required (already required by Next 16). libvips CVEs fixed. |
| `next` | 16.1.3 → **16.3.4** | direct, framework | **Minor** upgrade inside `^16` — fixes the *Middleware/Proxy bypass via segment-prefetch routes* (directly relevant now that a proxy exists), RSC DoS, CSP-nonce XSS, redirect cache poisoning. `eslint-config-next` moved in lock-step. |
| `next-auth` | 4.24.13 → **removed** | direct, **unused** (zero imports; app has its own cookie sessions) | Remove. Was the source of the *critical* advisory and pulled in vulnerable `uuid@8`, `nodemailer` peer. |
| `next-intl` | 4.7.0 → **removed** | direct, **unused** (custom i18n in `src/lib/i18n*.ts`) | Remove (open-redirect + prototype-pollution advisories). |
| `@mdxeditor/editor` | 3.52.3 → **removed** | direct, **unused** | Remove (vulnerable `js-yaml`, `diff`, `prismjs` trees). |
| `react-syntax-highlighter` | 15.6.6 → **removed** | direct, **unused** | Remove (vulnerable `prismjs`/`refractor`). |
| `uuid`, `@reactuses/core` | **removed** | direct, **unused** | Remove (uuid bounds-check advisory; `js-cookie`/`lodash-es` advisories). |
| `postcss`, `nanoid`, `picomatch`, `brace-expansion`, `minimatch`, `flatted`, `browserslist`, `js-yaml`, `lodash`, `@humanfs/node` | patch/minor bumps **within existing ranges** | transitive (build/dev tooling, recharts) | `bun update` — no range changes. |
| `deepmerge-ts`, `effect` | unchanged | transitive via `prisma > @prisma/config` (CLI/dev-time config loader) | **Deferred**: fixing requires a Prisma bump, explicitly out of scope. Not reachable at runtime (CLI only). |
| `ajv@6`, `@babel/core@7` | unchanged | transitive, dev-only (`eslint`, `eslint-plugin-react-hooks`) | Deferred: fix needs a major of `eslint`/babel toolchain; lint-time only. |
| `xlsx` | 0.18.5 unchanged | direct, runtime, **used** (`/api/admin/payments/import`) | **No fix on npm** (SheetJS publishes fixed builds only from its own CDN). Exposure limited to the admin-only import endpoint; documented risk. |

Result:

- `npm audit`: 12 (4 moderate, 8 high) → **4 high** (`xlsx` ×2 no-fix,
  `deepmerge-ts` via prisma, its parent chain) — nothing fixable without a
  Prisma bump or an off-registry package.
- `bun audit`: 93 → **6** (4 high, 1 moderate, 1 low): `xlsx` ×2,
  `deepmerge-ts`, `effect` (both prisma CLI), `ajv` (eslint), `@babel/core`
  (eslint plugin).

Lockfiles: `bun.lock` and `package-lock.json` both regenerated from the same
`package.json` and verified (`bun install --frozen-lockfile` → no changes;
package-lock resolves identical versions). Removed packages were confirmed
unreferenced with `git grep` across `src/`, `scripts/`, `tests/`, configs.

# Authentication / Session Review

| Area | Finding |
|---|---|
| Login | Generic "invalid credentials" for unknown user *and* wrong password; failed attempts audit-logged. Suspended / inactive checked after credential verification. No change. |
| Logout | Revokes the server session row and deletes the cookie. No change. |
| Session creation | 32-byte random token, only SHA-256 stored; 7-day expiry; single-device policy with idle grace. No change. |
| Session expiration | Enforced server-side on every resolution; throttled `lastSeenAt`. No change. |
| Cookie flags | `httpOnly: true`, `sameSite: "lax"`, `secure: NODE_ENV==="production"`, explicit `expires`, `path: "/"`. **Confirmed correct.** |
| Password hashing | scrypt (N default, 64-byte key, 16-byte salt) + `timingSafeEqual`. Adequate. No change. |
| Password reset | Email-only; identical generic response for all outcomes; per-email and per-IP DB-backed rate limits; token hashed; single live token; TTL; per-token attempt cap; transactional consume; all sessions revoked afterwards. No change. |
| Account enumeration | Reset request and login are enumeration-safe. Registration returns 409 for an existing e-mail (standard, low value, unchanged). |
| Rate limiting | Reset flows limited. Login relies on scrypt cost + audit log; no lockout. **Not CRITICAL/HIGH** → documented in Remaining Risks rather than adding a new mechanism in this phase. |
| Device/session enforcement | Device hash now keyed by a guaranteed-real secret in production (F1). |

# Authorization Review

Representative routes reviewed (server-side checks confirmed intact after
Phase 2):

- **Admin** — all 29 `/api/admin/**` handlers call `requireRole("ADMIN")`
  (`ai-generate-quiz` allows `ADMIN|TEACHER` by design). Session inspection
  returns metadata only, never tokens. Now enforced by a test
  (`security-hardening` §6).
- **Teacher** — dashboard/lessons/quizzes/homework/attendance/templates check
  `role === "TEACHER"` and scope queries by the teacher's own groups/courses;
  homework grading verifies the homework belongs to the teacher's course;
  template deletion is scoped to `teacherId`.
- **Student** — `/api/students/me/**`, lessons, quizzes and session-video
  progress resolve the student from the session (`getStudentProfile(user.id)`),
  never from a client-supplied id; lesson access goes through
  `canAccessLesson`; video progress checks batch + published.
- **Parent** — analytics/dashboard/weekly-report iterate `parent.children`
  from the verified link table; linking requires national ID + student code +
  parent phone (email path stays disabled); parents cannot stream media.
- **Protected media** — `/api/media/[id]` re-authorises per role; quiz
  evidence remains ADMIN-only and audit-logged.
- **Quiz results** — answers withheld from students without a finished attempt
  (Phase 1 H1 still in place).
- **IDOR / privilege escalation** — no client-controlled ownership ids found
  in student/parent routes; self-registration as TEACHER/ADMIN still blocked.

Only defect found: **F2** (public `/api/groups` leaking full `User` rows) —
fixed. A source-level test now asserts no public route uses `user: true`.

# Secret / Environment Review

- `.env` ignored (`.gitignore`: `.env`, `.env.local`, `.env.*.local`); only
  `.env.example` tracked — confirmed via `git ls-files`.
- Tracked files searched for passwords / API keys / tokens / SMTP credentials /
  private keys / cloud key patterns: **none found**. Seed scripts contain
  well-known demo credentials for local seeding only (documented as demo data).
- No client component reads `process.env`; the only `NEXT_PUBLIC_*` variable
  is `NEXT_PUBLIC_URL` (public by design). `SECURITY_HASH_SECRET` is consumed
  only by server modules (`src/lib/env.ts`, `security.ts`, instrumentation,
  next.config) and is never logged or returned.
- No production secret fallback remains (asserted by test).

# Production Start Review

`start` was `NODE_ENV=production bun .next/standalone/server.js 2>&1 | tee
server.log` — env-prefix syntax and `tee` do not exist in Windows CMD.

Implemented `scripts/start-production.mjs` (node:* only, zero dependencies;
`start` → `bun scripts/start-production.mjs`):

- sets `NODE_ENV=production` for the child (respects an explicit value),
- spawns `.next/standalone/server.js` with the same runtime that launched the
  script (bun stays bun; `node scripts/start-production.mjs` works too),
- mirrors stdout/stderr to the console and appends to `server.log`
  (`SERVER_LOG_FILE` to relocate / `0` to disable),
- forwards SIGINT/SIGTERM/SIGHUP with a 10 s force-kill fallback, exits with
  the server's status.

Behaviour on Linux is identical to before; the systemd unit in
`DEPLOYMENT_GUIDE.md` (which calls `server.js` directly) is unaffected except
for the new required `SECURITY_HASH_SECRET` line that was added.

# Changes Implemented

| File | Change |
|---|---|
| `tsconfig.json` | Exclude `examples/` from type checking (carry-over). |
| `src/lib/env.ts` | **New.** Production env contract; validated secret resolution; no values in messages. |
| `src/lib/security.ts` | Use `getSecurityHashSecret()`; hardcoded fallbacks removed. |
| `src/instrumentation.ts` | **New.** Startup fail-fast (exit 1) when production env is invalid. |
| `next.config.ts` | Build-time `assertProductionEnv()`; `poweredByHeader: false`; `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy`, `Permissions-Policy` on all routes. |
| `src/proxy.ts` | **New.** Cookie-presence gate for protected API namespaces (401), no DB. |
| `src/lib/route-protection.ts` | **New.** Protected prefix map + pure decision helpers shared with tests. |
| `src/app/api/groups/route.ts` | Explicit `select`; teacher exposed as `{ id, user: { name } }` only. |
| `scripts/start-production.mjs` | **New.** Portable production launcher. |
| `package.json` | `start` script; deps: nodemailer 9, sharp 0.35, next/eslint-config-next 16.3.4, @types/nodemailer 8; removed 6 unused packages. |
| `bun.lock`, `package-lock.json` | Regenerated for the above. |
| `.env.example` | `SECURITY_HASH_SECRET` (placeholder) + `SKIP_PRODUCTION_ENV_CHECK` docs. |
| `tests/security-hardening.test.js` | **New.** 242 assertions (see below). |
| `docs/DEPLOYMENT_GUIDE.md` | Start-script section, systemd unit and go-live env list updated for the new launcher and required secret. |
| `docs/PHASE_3_SECURITY_HARDENING.md`, `docs/PROJECT_STATE.md` | This report / status. |

Not changed: Prisma schema, migrations, provider, any product feature, UI
components, authentication or authorization logic beyond F2.

# Testing

**Typecheck** — `bun run typecheck`: **PASS, 0 errors** (also passes with a
recreated `examples/websocket/frontend.tsx` importing `socket.io-client`).

**Tests** — `node tests/*.test.js`, 8 suites:

| Suite | Result |
|---|---|
| authorization-invariants | 93 passed |
| migration-sql | 15 passed |
| mock-exam-grading-isolation | 22 passed |
| parent-monthly-report | 67 passed |
| platform-upgrade-2026-migration | 98 passed |
| registration-validators | 24 passed |
| seed-idempotency | 18 passed |
| **security-hardening (new)** | **242 passed** |

Baseline 337 unchanged (0 regressions) + 242 new = **579 passed, 0 failed**.

The new suite covers: production secret requirement (unset/empty/whitespace/
placeholder/short/valid; error text never contains the value; dev fallback
behaviour), no fallback literal left in `security.ts`, build+runtime wiring,
security headers, proxy decisions for 14 protected and 13 public paths
(segment-aware prefixing, cookie name matches `auth.ts`, no DB in proxy),
every route in a protected namespace still performs its own authorization and
every admin route uses `requireRole`, session cookie flags, password hashing,
reset-flow properties, registration role lock, public endpoints never
serialising `User` rows, tsconfig exclusion, `.env` untracked, portable start
script.

**Lint** — `bun run lint`: 44 problems (43 errors, 1 warning), **all
pre-existing**; 0 in files touched by Phase 3. Composition: 38 ×
`@typescript-eslint/no-require-imports` in the existing plain-node test files,
6 React-compiler rules (`preserved`/`render`/`no-location-assign-relative-
destination`) in 6 pre-existing components. The count moved from 78 → 44
purely because `eslint-config-next` 16.3.4 retired/renamed several React
rules; no lint clean-up was performed (out of scope). The new test file carries
a single file-level `eslint-disable` for `no-require-imports`, matching how it
must be run (`node tests/…`).

**Production build** — `bun run build`: **PASS**. Prisma generate ✓ → Next.js
16.3.4 compile ✓ → "Finished TypeScript" (real validation) ✓ → page data
collection ✓ → 62/62 static pages ✓ → `ƒ Proxy (Middleware)` registered ✓ →
`copy-standalone-assets` ✓ → exit 0. Negative case verified: without
`SECURITY_HASH_SECRET` the build exits 1 at config load with the expected
message.

**Production startup** — standalone `server.js` via the new launcher
(`node`/`bun`):

| Check | Result |
|---|---|
| Missing secret | prints the value-free error, **exits 1** (server never listens) |
| Valid secret | listens on `0.0.0.0:3000` |
| `GET /` | 200 (HTML shell) with the four security headers, no `X-Powered-By` |
| `GET /api` | 200 |
| `GET /api/auth/me` (no cookie) | 401 from the route |
| `/api/admin/overview`, `/api/teacher/dashboard`, `/api/students/me/dashboard`, `/api/parents/me/dashboard`, `/api/media/abc`, `/api/notifications` (no cookie) | 401 from the proxy |
| Same with a bogus `cm_session` cookie | passes the proxy, rejected by the route |
| SIGTERM to launcher | forwarded; server exits; launcher exit 0; `server.log` written |

Limitation: DB-backed endpoints (`/api/settings/public`, login POST, …)
returned 500 in the sandbox **solely because the Prisma query engine binary
cannot be downloaded here** (`binaries.prisma.sh` blocked). This is an
environment restriction, not a code path changed by this phase; Phase 2 had
verified the same startup flow with a working engine and no DB-facing code was
modified.

# Remaining Risks

- `xlsx@0.18.5` — prototype pollution + ReDoS, no fix on the npm registry.
  Reachable only by ADMIN via `/api/admin/payments/import` with an admin-chosen
  file. Mitigation options: install the vendor CDN build, or replace the
  library. Deferred (needs a product decision).
- Transitive `deepmerge-ts` / `effect` under `prisma > @prisma/config` —
  CLI-time only; will clear with the next approved Prisma bump.
- Dev-only `ajv@6` / `@babel/core@7` under ESLint tooling — lint-time only.
- No login-attempt lockout / throttling (scrypt cost + audit log only).
  Recommended as a small follow-up using the existing `checkRateLimit`.
- No Content-Security-Policy yet (client-rendered app with inline styles and
  a video iframe; an untested CSP would break the product). Candidate for a
  dedicated pass with report-only mode first.
- `SECURITY_HASH_SECRET` rotation invalidates device fingerprints (users may
  need to log in again). Documented in `.env.example`.
- Proxy is cookie-presence only by design; the route layer remains the single
  source of authorization truth.

# Deferred Work

- SQLite → PostgreSQL migration (separate approved phase).
- Prisma upgrade (clears `@prisma/config` transitive advisories).
- `xlsx` replacement / vendor build.
- Login rate limiting; CSP (report-only first).
- Lint clean-up of the 44 pre-existing issues.
- Windows CMD end-to-end smoke test of `bun run start` on a real Windows host
  (launcher is dependency-free and uses only node APIs, but was exercised on
  Linux only in this environment).
