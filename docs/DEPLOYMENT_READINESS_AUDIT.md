# CodeMind Academy — Deployment Readiness Audit (Phase 1)

## Executive Summary

A complete audit of the CodeMind Academy platform at baseline `635de56` was performed. The audit focused on identifying and fixing deployment-blocking issues: build failures, security vulnerabilities, database inconsistencies, and critical integration problems.

**Key findings:**
- **1 CRITICAL security vulnerability** (privilege escalation via registration) — **FIXED**
- **2 HIGH security issues** (quiz answer leakage, parent impersonation) — **FIXED**
- **5 MEDIUM issues** identified — deferred to later phases
- **7 LOW issues** identified — deferred to later phases

All existing tests pass (337 assertions across 7 test suites). No regressions introduced.

## Baseline

- **Commit:** `635de56` — state *before* the Phase 1 fixes
- **Audited / final commit:** `b257a6c` (head of PR #18; merged into `main` as `fce4821`)
- **Branch:** `arena/01a07dd6-codemind-academy` (deleted after merge)
- **Date:** 2026-09-07

> **Reconciliation note.** Every number in this document was re-verified against `b257a6c`
> on 2026-09-07 and the incorrect figures were corrected in place. The corrections are
> documentation-only: no application code, schema, dependency, or migration was changed.
> See **“Reconciliation Against `b257a6c`”** at the end of this document for the full list.

## Architecture Reviewed

### Stack
- **Frontend:** Next.js 16 (declared `^16.1.1`), React 19, TypeScript, Tailwind CSS 4
- **Backend:** Next.js API routes (no separate backend), cookie-based sessions
- **Database:** SQLite via Prisma (declared `^6.11.1`)

`package.json` declares caret ranges, and the repository commits **two** lockfiles that resolve
those ranges to different versions. The declared range is the only version the repository
actually pins; the resolved version depends on which lockfile is used to install. See
**“Dependency Version Reconciliation”** in the reconciliation section for the exact numbers.
- **Auth:** Custom cookie-based sessions (no JWT, no NextAuth), scrypt password hashing
- **i18n:** next-intl, Arabic/English, RTL/LTR
- **Theming:** next-themes, dark/light mode

### File Structure
- 198 source files total
- ~70 API routes across admin, student, teacher, parent, auth namespaces
- ~40 React components
- ~25 library/service modules

## Existing Functionality

| Subsystem | Status | Classification |
|---|---|---|
| Authentication (register/login/logout/session) | Working | KEEP AS-IS |
| Password reset (email-based, rate-limited) | Working | KEEP AS-IS |
| Single-device enforcement | Working | KEEP AS-IS |
| Student registration + validation | Working | KEEP WITH SMALL FIXES |
| Parent registration + verified linking | Working | KEEP WITH SMALL FIXES |
| Course/Part/Unit/Topic/Lesson hierarchy | Working | KEEP AS-IS |
| Session progression (video 95% + quiz + homework) | Working | KEEP AS-IS |
| Quiz system (create, attempt, grade) | Working | KEEP WITH SMALL FIXES |
| Homework (assign, submit, grade) | Working | KEEP AS-IS |
| Mock exams (randomized, school-type isolated) | Working | KEEP AS-IS |
| Attendance tracking | Working | KEEP AS-IS |
| Subscription/payment flow (manual verification) | Working | KEEP AS-IS |
| Admin dashboard + management | Working | KEEP AS-IS |
| Teacher dashboard + management | Working | KEEP AS-IS |
| Parent dashboard + analytics | Working | KEEP AS-IS |
| Session videos (batch-based, private storage) | Working | KEEP AS-IS |
| Media asset management (private storage, authorized serving) | Working | KEEP AS-IS |
| Calendar/notifications | Working | DEFER |
| Gamification/leaderboard | Working | DEFER |
| AI quiz generation | Working | DEFER |
| PDF/materials | Working | DEFER |
| Kodgy integration | Stub | DEFER |

## Deployment Blockers

### CRITICAL

#### C1: Privilege Escalation via Self-Registration
- **Severity:** CRITICAL
- **Location:** `src/app/api/auth/[action]/route.ts` (register action)
- **Problem:** The registration endpoint accepted the `role` field from the request body. While STUDENT and PARENT had proper handling, TEACHER and ADMIN roles were processed by a fallthrough path that created a user with the client-requested role. Any anonymous user could register as ADMIN.
- **Impact:** Complete platform compromise. An attacker could create an admin account, access all data, modify all settings, approve payments, and manipulate grades.
- **Fix:** TEACHER and ADMIN self-registration is now blocked. These roles must be provisioned by an existing admin.
- **Fixed:** YES

### HIGH

#### H1: Quiz Answer Leakage to Students Before Submission
- **Severity:** HIGH
- **Location:** `src/app/api/quizzes/[id]/route.ts`, `src/app/api/lessons/[id]/route.ts`
- **Problem:** Both the quiz detail endpoint and the lesson detail endpoint returned quiz `answer` and `explanation` fields to ALL authenticated users, including students who had not yet attempted the quiz. The UI hid these fields, but they were fully visible in the network tab.
- **Impact:** Academic integrity compromise. Students could read the answer key before taking any quiz.
- **Fix:** Answers and explanations are now withheld from students until they have at least one finished attempt on the quiz. Teachers, admins, and parents continue to see answers.
- **Fixed:** YES

#### H2: Parent Impersonation via Email-Based Student Linking
- **Severity:** HIGH
- **Location:** `src/app/api/parents/me/link-student/route.ts`
- **Problem:** The legacy email-based linking path (`studentEmail`) allowed any authenticated parent to link to any student simply by knowing the student's email address. No verification of parent phone, national ID, or student code was required.
- **Impact:** Any parent account could access any student's data (grades, attendance, progress, personal information) by guessing or knowing the student's email.
- **Fix:** The legacy email-based linking path has been removed. All parent-student linking now requires the verified path (national ID + student code + parent phone matching).
- **Fixed:** YES

### MEDIUM

#### M1: TypeScript Build Errors Ignored
- **Severity:** MEDIUM
- **Location:** `next.config.ts` (`ignoreBuildErrors: true`)
- **Problem:** TypeScript errors are suppressed during build. Real type errors could be hidden.
- **Impact:** Potential runtime failures masked by build-time suppression.
- **Recommended solution:** Address in a later phase by enabling type checking and fixing all errors.
- **Fixed:** NO (deferred)

#### M2: SQLite Database for Production
- **Severity:** MEDIUM
- **Location:** `prisma/schema.prisma`, `.env.example`
- **Problem:** The database is SQLite, which is not suitable for concurrent production use. No WAL mode configuration.
- **Impact:** Concurrent writes may cause contention. Data loss risk under load.
- **Recommended solution:** Migrate to PostgreSQL for production deployment.
- **Fixed:** NO (deferred)

#### M3: Hardcoded Development Fallback Secret
- **Severity:** MEDIUM
- **Location:** `src/lib/security.ts` (`process.env.SECURITY_HASH_SECRET || "codemind-dev-hash-secret"`)
- **Problem:** If `SECURITY_HASH_SECRET` is not set, a hardcoded fallback is used for IP hashing and device fingerprinting. In production, this would be predictable.
- **Impact:** Device fingerprints and IP hashes would be deterministic across deployments using the default secret.
- **Recommended solution:** Remove the fallback and require the env var in production.
- **Fixed:** NO (deferred — not exploitable without additional access)

#### M4: No Next.js Middleware for Edge-Level Protection
- **Severity:** MEDIUM
- **Location:** No `src/middleware.ts` exists
- **Problem:** Route protection relies entirely on per-route server-side auth checks. While this is implemented correctly, there is no edge-level middleware as defense-in-depth.
- **Impact:** A missing auth check in any new route would not be caught by middleware.
- **Recommended solution:** Add middleware.ts with route protection in a later phase.
- **Fixed:** NO (deferred)

#### M5: npm Audit Vulnerabilities
- **Severity:** MEDIUM
- **Location:** `package.json` dependencies
- **Problem:** 12 npm audit vulnerabilities (4 moderate, 8 high).
- **Impact:** Potential security issues in transitive dependencies.
- **Recommended solution:** Review and update dependencies in a later phase.
- **Fixed:** NO (deferred)

### LOW

#### L1: Lint Errors in Test Files *and* Source Components
- **Severity:** LOW
- **Location:** All `tests/*.test.js` files, plus 5 source components
- **Problem:** `bun run lint` (which runs `eslint .`) reports **43 errors, 0 warnings** on the
  toolchain resolved by `bun.lock` (the project's runtime package manager):
  - **38 errors in test files** — all `@typescript-eslint/no-require-imports`, in the CJS test files
  - **5 errors in source components** — 4 × `react-hooks/preserve-manual-memoization`
    (`src/components/parent/monthly-report.tsx`, `src/components/student/bookmarks-view.tsx`,
    `src/components/student/gamification-panel.tsx`, `src/components/student/referral-view.tsx`)
    and 1 × `react-hooks/refs` (`src/components/student/student-dashboard.tsx`)
- **Note:** the total is toolchain-dependent, not source-dependent — the same file tree reports
  **77 errors, 1 warning** when the ESLint toolchain resolved by `package-lock.json` is installed.
  The “all in test files” wording was wrong under either toolchain; only the 38 test-file errors
  are `no-require-imports`. See the reconciliation section for the toolchain versions.
- **Fixed:** NO (deferred)

#### L2: React Strict Mode Disabled
- **Severity:** LOW
- **Location:** `next.config.ts` (`reactStrictMode: false`)
- **Problem:** Strict mode helps catch React issues during development.
- **Fixed:** NO (deferred)

#### L3: `noImplicitAny` Disabled
- **Severity:** LOW
- **Location:** `tsconfig.json` (`noImplicitAny: false`)
- **Problem:** Reduces type safety.
- **Fixed:** NO (deferred)

#### L4: ESLint Rules Over-Relaxed
- **Severity:** LOW
- **Location:** `eslint.config.mjs`
- **Problem:** Many useful rules disabled (`no-unused-vars`, `react-hooks/exhaustive-deps`, etc.)
- **Fixed:** NO (deferred)

#### L5: `bun-types` in devDependencies Despite npm Usage
- **Severity:** LOW
- **Location:** `package.json`
- **Problem:** `bun-types` is included but the project uses npm.
- **Fixed:** NO (deferred)

#### L6: No PR Description Template
- **Severity:** LOW
- **Location:** `.github/` directory missing
- **Fixed:** NO (deferred)

#### L7: `createStudentWithCode` Uses `(db as any)` Casts
- **Severity:** LOW
- **Location:** `src/app/api/auth/[action]/route.ts`, `src/lib/curriculum-seed.ts`
- **Problem:** Type casts suggest schema/client mismatch or Prisma client not generated.
- **Fixed:** NO (deferred)

## Security Findings

### Fixed in This Phase
1. **Privilege escalation** — registration no longer allows TEACHER/ADMIN role selection
2. **Quiz answer leakage** — answers withheld until student submits
3. **Parent impersonation** — email-based linking removed

### Verified Secure (Code-Reviewed)
- **Password hashing:** scrypt with random 16-byte salt, 64-byte output — secure
- **Session management:** httpOnly cookies, SHA-256 token hash in DB, 7-day TTL, device fingerprinting — secure
- **Password reset:** rate-limited per IP and per identifier, single-use tokens, SHA-256 hash storage, no account enumeration — secure
- **Single-device enforcement:** device hash based on stable browser/OS family (not volatile IP), 30-min idle grace — good quality
- **Admin endpoints:** all use `requireRole("ADMIN")` — verified
- **Teacher endpoints:** all check teacher role + group ownership — verified
- **Student endpoints:** all check student role + enrollment — verified
- **Parent endpoints:** all check parent role + linked children — verified
- **Media access:** authorized per-role, private storage, range support — verified
- **Video progress:** server-verified heartbeat with wall-clock credit — anti-tampering in place
- **Quiz evidence:** admin-only access, retention policy — verified
- **Enrollment isolation:** consistent across courses, lessons, exams — verified
- **School-type separation:** enforced in SQL, never from client — verified
- **No secrets in tracked files:** `.env` ignored, `.env.example` has placeholders only — verified
- **No hardcoded credentials:** SMTP credentials come from env, no API keys in source — verified

### Not Exploitable (Documented)
- `SECURITY_HASH_SECRET` fallback is a development convenience, not a direct attack vector
- No middleware is a defense-in-depth gap, not a direct vulnerability

## Database Findings

### Schema
- **3 migrations present, all additive** (verified by directory listing at `b257a6c`):
  1. `20260904090608_add_student_identity_fields`
  2. `20260906120000_platform_upgrade_2026`
  3. `20260907100000_phase3_domain_foundation`
- SQLite provider with proper relations, indexes, and constraints
- No missing foreign keys or orphan records in schema design
- Unique constraints properly defined (nationalId, studentCode, email, tokenHash)
- Cascade deletes appropriate (User → Student/Parent/Teacher → children)

### Migration Safety
- Migrations are additive and do not drop data
- `db push --accept-data-loss` in scripts is risky for production but not used in migrations
- **No migration lock file is tracked.** `prisma/migrations/migration_lock.toml` does not exist
  at `b257a6c` and is not in the git index. The earlier claim that a lock file was present was
  incorrect. With a single `sqlite` provider this has no practical effect today, but the file
  should be committed before any provider change is attempted (see M2).

### Issues
- SQLite is not suitable for concurrent production writes (M2)
- No PostgreSQL migration path defined (deferred)

## Authentication / Authorization Findings

| Check | Status |
|---|---|
| Role escalation (registration) | FIXED (C1) |
| IDOR on student data | SECURE (enrollment-scoped) |
| IDOR on course content | SECURE (enrollment check) |
| IDOR on quiz results | SECURE (student-scoped) |
| Parent-child isolation | FIXED (H2) |
| Teacher scope isolation | SECURE (group-scoped) |
| Protected file access | SECURE (media route auth) |
| Password reset security | SECURE |
| Session handling | SECURE |
| Client/server secret exposure | SECURE |
| Hardcoded credentials | NONE FOUND |
| .env handling | PROPER (ignored) |

## Student Flow Findings

The student flow was traced from registration through course access:

1. **Registration** → creates User + Student with unique code → FIXED (role escalation blocked)
2. **Login** → cookie-based session with device tracking → SECURE
3. **Enrollment** → manual payment → admin approval → subscription activated → SECURE
4. **Course access** → enrollment checked server-side → SECURE
5. **Session progression** → video 95% + quiz + homework gating → SECURE
6. **Lesson access** → `canAccessLesson()` enforced server-side → SECURE
7. **Quiz** → attempt creation → submission → grading → FIXED (answer leakage)
8. **Video progress** → heartbeat-based, wall-clock credit → SECURE
9. **Homework** → submit → teacher grade → SECURE
10. **Next session** → unlock based on progression rules → SECURE

## Production Configuration Findings

| Item | Status | Notes |
|---|---|---|
| `.env` in `.gitignore` | ✓ | Properly ignored |
| `.env.example` tracked | ✓ | Placeholders only |
| `output: "standalone"` | ✓ | Correct for containerized deploy |
| `ignoreBuildErrors: true` | ⚠️ | Should be false for production |
| Production start script | ✓ | Uses standalone server.js |
| Caddy reverse proxy | ✓ | Caddyfile present |
| `MEDIA_STORAGE_PATH` | ✓ | Outside web root |
| `reactStrictMode: false` | ⚠️ | Should be true for production |

## Testing Baseline

### Before Changes
All 7 test suites pass:
- `authorization-invariants.test.js`: 93 passed
- `migration-sql.test.js`: 15 passed
- `mock-exam-grading-isolation.test.js`: 22 passed
- `parent-monthly-report.test.js`: 67 passed
- `platform-upgrade-2026-migration.test.js`: 98 passed
- `registration-validators.test.js`: 24 passed
- `seed-idempotency.test.js`: 18 passed

**Total: 337 assertions, 0 failures**

### After Changes
All 7 test suites still pass with no regressions.

### Lint

Measured at `b257a6c` with `bun run lint` (`eslint .`) on the toolchain resolved by `bun.lock`:

| Scope | Errors | Warnings |
|---|---|---|
| Test files (`tests/*.test.js`) | 38 | 0 |
| Source / components (`src/**`) | 5 | 0 |
| **Total** | **43** | **0** |

- The 38 test-file errors are all `@typescript-eslint/no-require-imports` (CJS test files).
- The 5 source errors are React Compiler hook rules: 4 × `react-hooks/preserve-manual-memoization`
  and 1 × `react-hooks/refs`.

The same file tree reports **77 errors, 1 warning** (38 test-file + 39 source) when the ESLint
toolchain resolved by `package-lock.json` is installed instead. Both counts are pre-existing;
Phase 1 introduced none of them.

### Build

The build script is two separate things chained together:

```
"build": "next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/"
```

1. the **Next.js production build** (`next build`), and
2. a **POSIX shell copy step** (`cp -r …`) that stages the standalone output.

They fail independently, and only the second one fails on Windows.

**Next.js build — succeeds.**

| Stage | Result | Evidence |
|---|---|---|
| Compile | ✅ | Turbopack compiles successfully (~15s in this sandbox; ~1.8s in the original audit run) |
| Typecheck | ⚠️ skipped | `next.config.ts` sets `typescript.ignoreBuildErrors: true`, so `next build` runs no type validation. A standalone `tsc --noEmit` reports errors unless `prisma generate` has produced `@prisma/client` types. |
| Collecting page data | ✅ on a machine with a generated Prisma client | Confirmed locally on Windows |
| Generating static pages | ✅ | Confirmed locally on Windows |
| Finalizing optimization | ✅ | Confirmed locally on Windows |

**Copy step — fails on Windows.**

- ❌ `cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/` fails under
  **Windows CMD**, because `cp` is a POSIX command that CMD does not provide. This happens
  **after** the Next.js build has already produced a complete, successful production build.

**Accurate summary.** `bun run build` produces a **successful** Next.js production build
(compile → page data collection → static generation → optimization). The only failure is the
final `cp -r` copy step, which is a **shell-portability limitation of the npm script on
Windows** — not a TypeScript, Next.js, or Prisma defect. On Linux/macOS, or on Windows via a
POSIX shell (Git Bash, WSL, PowerShell with `cp` aliased), the full `bun run build` command
including the copy step completes. Fixing it is a build-script change and was deliberately
out of scope for this phase.

**Sandbox-only failure (not a repository defect).** In this sandbox, `next build` stops at
“Collecting page data” with `@prisma/client did not initialize yet` (`src/lib/db.ts:9`),
because `prisma generate` cannot download its engine binaries — `binaries.prisma.sh` is
unreachable from the sandbox. The Prisma client in `node_modules/.prisma/client/` is therefore
an uninitialized stub. Running `prisma generate` with network access resolves this; it is an
environment constraint, not a code defect. The earlier wording (“page data collection ❌”,
“full production build ❌”) described this sandbox limitation but read as a defect in the
repository, so it is corrected here.

## Implemented Fixes

| ID | File | Change |
|---|---|---|
| C1 | `src/app/api/auth/[action]/route.ts` | Blocked TEACHER/ADMIN self-registration |
| H1 | `src/app/api/quizzes/[id]/route.ts` | Conditional answer reveal based on attempt status |
| H1 | `src/app/api/lessons/[id]/route.ts` | Conditional answer reveal in lesson quiz section |
| H2 | `src/app/api/parents/me/link-student/route.ts` | Removed legacy email-based parent-student linking |

## Deferred Issues

| ID | Description | Recommended Phase |
|---|---|---|
| M1 | Enable TypeScript build errors | Phase 2 |
| M2 | SQLite → PostgreSQL migration | Phase 2 |
| M3 | Remove hardcoded secret fallback | Phase 2 |
| M4 | Add middleware.ts for edge protection | Phase 2 |
| M5 | Fix npm audit vulnerabilities | Phase 2 |
| L1-L7 | Lint/type issues, config improvements | Phase 2+ |

## Recommended Next Phase

**Phase 2 — Production Hardening:**
1. Enable `ignoreBuildErrors: false` and fix all TypeScript errors
2. Remove `SECURITY_HASH_SECRET` fallback, require env var in production
3. Add `middleware.ts` for defense-in-depth route protection
4. Enable `reactStrictMode: true`
5. Review and fix npm audit vulnerabilities
6. Plan SQLite → PostgreSQL migration
7. Relax ESLint rules incrementally

## Appendix: Files Changed

Source files changed by Phase 1 (PR #18):

```
 src/app/api/auth/[action]/route.ts           | 23 +++++++----------------
 src/app/api/lessons/[id]/route.ts            | 23 +++++++++++++++++++++++
 src/app/api/parents/me/link-student/route.ts | 16 +++++-----------
 src/app/api/quizzes/[id]/route.ts            | 14 +++++++++++---
 4 files changed, 46 insertions(+), 30 deletions(-)
```

The PR also changed two documentation files (`docs/DEPLOYMENT_READINESS_AUDIT.md` itself and
`docs/PROJECT_STATE.md`), for six changed files in total.

---

## Reconciliation Against `b257a6c` (2026-09-07)

This document was re-verified line by line against commit `b257a6c` — the head of PR #18,
merged into `main` as `fce4821`. The tree at `b257a6c` is identical to the tree at `fce4821`.

### Claim-by-claim result

| Item | Previously stated | Verified at `b257a6c` | Status |
|---|---|---|---|
| Migration count | "3 migrations present" | **3** — count was correct | ✅ correct, names added |
| Migration lock file | "Migration lock file present" | **Not tracked**; `migration_lock.toml` does not exist | ❌ corrected |
| Next.js version | 16.3.4 | Declared `^16.1.1`; `bun.lock` → **16.1.3**; `package-lock.json` → 16.3.4 | ❌ corrected |
| Prisma version | 6.11.1 | Declared `^6.11.1`; `bun.lock` → **6.19.2**; `package-lock.json` → 6.19.3 | ❌ corrected |
| Lint count | "77 errors, 1 warning — all in test files" | **43 errors, 0 warnings** (38 test + 5 source) on `bun.lock`; 77/1 on `package-lock.json`; never "all in test files" | ❌ corrected |
| Build | "page data collection ❌", "full production build ❌" | Next.js build **succeeds**; only the POSIX `cp -r` step fails, and only on Windows | ❌ corrected |
| Test assertions | 337 across 7 suites | **337** (93+15+22+67+98+24+18), 7 suites, all passing | ✅ correct |
| npm audit | 12 (4 moderate, 8 high) | **12** (4 moderate, 8 high) | ✅ correct |
| Source files | 198 | **198** tracked files under `src/` | ✅ correct |
| API routes | ~70 | 79 `route.ts` files | ⚠️ understated, left as approximate |
| Library modules | ~25 | 25 | ✅ correct |

Only the rows marked ❌ were changed in this document. No application code, schema,
dependency, or migration was touched.

### Dependency Version Reconciliation

`package.json` declares caret ranges; both lockfiles are committed at `b257a6c` and they
resolve those ranges differently:

| Package | `package.json` | `bun.lock` | `package-lock.json` |
|---|---|---|---|
| `next` | `^16.1.1` | **16.1.3** | 16.3.4 |
| `prisma` | `^6.11.1` | **6.19.2** | 6.19.3 |
| `@prisma/client` | `^6.11.1` | **6.19.2** | 6.19.3 |
| `react` | `^19.0.0` | 19.2.3 | 19.2.8 |

**Why the audit showed different versions.** The two figures came from two different files and
were mixed together:

- **Next.js 16.3.4** is the resolution recorded in `package-lock.json`.
- **Prisma 6.11.1** is not an installed version at all — it is the caret range `^6.11.1` in
  `package.json`, quoted as though it were the resolved version. Neither lockfile resolves
  Prisma to 6.11.1.

Because the project is installed and run with **bun** (`bun.lock`, `bun-types` in
devDependencies, `bun .next/standalone/server.js` in the `start` script), `bun.lock` is the
resolution that applies locally: **Next.js 16.1.3** and **Prisma 6.19.2**. Both lockfiles are
legitimate for this repository until one is designated authoritative; nothing was upgraded or
downgraded during this reconciliation.

### Lint Reconciliation

The two totals describe the same file tree measured with two different ESLint toolchains —
the same split seen in the dependency table:

| ESLint package | `bun.lock` | `package-lock.json` |
|---|---|---|
| `eslint` | 9.39.2 | 9.39.5 |
| `eslint-config-next` / `@next/eslint-plugin-next` | 16.1.3 | 16.3.4 |
| `typescript-eslint` / `@typescript-eslint/*` | 8.53.0 | 8.69.0 |
| `eslint-plugin-react-hooks` | 7.0.1 | 7.1.1 |

| Toolchain | Total | Errors in `tests/` | Errors in `src/` | Warnings |
|---|---|---|---|---|
| `bun.lock` (what `bun run lint` uses locally) | **43** | 38 | 5 | 0 |
| `package-lock.json` | 77 | 38 | 39 | 1 |

The 38 test-file errors are identical in both (all `@typescript-eslint/no-require-imports`).
The 34-error difference is entirely in `src/`: the newer `eslint-plugin-react-hooks` (7.1.1)
adds rules that fire across the component tree. Neither total is "all in test files".
