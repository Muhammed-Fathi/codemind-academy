# Phase 2 — Production Build & Type Safety

Status: **complete** (2026-09-07). Baseline `fce4821` (merged Phase 1 on `main`).

## Objective

Make the current CodeMind Academy repository capable of producing a reliable
production build with **real** TypeScript validation, and replace the
Unix-only build copy step with a cross-platform implementation — without
changing product behavior, the database, or the application design.

## Baseline

Verified on `fce4821` (working tree clean), not taken from prior reports:

- `next.config.ts`: `output: "standalone"`, `typescript.ignoreBuildErrors: true`,
  `reactStrictMode: false`.
- `package.json` build script:
  `next build && cp -r .next/static .next/standalone/.next/ && cp -r public .next/standalone/`
  (Unix-only; fails on Windows CMD after the `next build` step).
- No `typecheck` script existed.
- Prisma 6.x + SQLite, generator `prisma-client-js`. Lockfiles: `bun.lock`
  pins `prisma`/`@prisma/client` 6.19.2; the committed `package-lock.json`
  pins 6.19.3 (same 6.19 line, same engines commit `c2990dca…`). Untouched.
- `tsconfig.json`: `strict: true` with `noImplicitAny: false`. Left as-is
  (no deployment blocker required tightening it).
- Tests: 7 standalone suites (`node tests/*.test.js`), 337 assertions.
- No committed database file; repo setup relies on `db:push`.

## Initial Build State

- `bun run build` on Linux: **PASS** — but only because
  `ignoreBuildErrors: true` suppressed all type errors and `cp -r` exists on
  Linux. On Windows CMD the build itself succeeds and the `cp -r` step fails.
- The final standalone layout produced by the old script (and preserved by
  the new one): `.next/static` → `.next/standalone/.next/static` and
  `public` → `.next/standalone/public`.

## Initial Typecheck State

`npx tsc --noEmit` (no script existed): **67 errors across 13 files.**
All hidden by `ignoreBuildErrors: true` in production builds.

## Problems Found

All 67 errors trace to five root causes:

1. **Nullable `Lesson.topic` (≈55 errors, 10 files).** The Phase 3 domain
   migration made `Lesson.topicId` nullable (`Topic` is now a legacy
   compatibility wrapper; official lessons hang off `Lesson.unitId`). Code
   written when the relation was required still assumed
   `lesson.topic.unit.part.course…`. Several sites were latent *runtime*
   crash bugs, not merely type noise — e.g. `/api/lessons/[id]` dereferenced
   `lesson.topic.unit…` unconditionally, and `canAccessLesson`
   (`src/lib/session-progress.ts`) would throw on a topic-less lesson
   instead of denying access.
2. **`never[]` array inference (8 errors).** `const created = []` in
   `admin/ai-generate-quiz` and `const results = []` in
   `teacher/attendance` were inferred as `never[]`, making `.push(payload)`
   and subsequent property reads invalid.
3. **Duplicate object key (1 error, `admin/payments/import`).** A result
   row literal contained `status` twice (`status: validStatus` then
   `status: "created"`). The second key silently won at runtime, so
   removing the dead first key preserves the emitted JSON byte-for-byte
   (the UI checks `r.status === "failed"` / `"created"`).
4. **Missing select field (1 error, `parents/me/dashboard`).** The code read
   `s.homework?.deadline` but the Prisma `select` did not fetch `deadline`,
   so the fallback silently returned `undefined` at runtime. Fixed by
   adding `deadline: true` to the select (restores intended behavior).
5. **Untyped `Promise.all` branches (4 errors, `src/lib/session-progress.ts`).**
   `Promise.resolve([])` in the short-circuit branches widened the tuple
   elements to `any[]`, breaking `new Map(rows.map(...))` and the
   `lp?.videoPercent` reads.

## Changes Implemented

| File | Change |
| --- | --- |
| `next.config.ts` | Removed the `typescript.ignoreBuildErrors` override. Builds now perform genuine type validation. `reactStrictMode` and `output: "standalone"` untouched. |
| `package.json` | `build` → `prisma generate && next build && node scripts/copy-standalone-assets.mjs`; added `typecheck: tsc --noEmit`. No dependency changes. |
| `scripts/copy-standalone-assets.mjs` | New. ~40-line Node ESM script (runs identically under node or bun) using only `node:fs`/`node:path`. Replaces the `cp -r` chain; fails loudly if the standalone output is missing; idempotent on rebuilds. |
| `src/app/api/lessons/[id]/route.ts` | Guarded the prev/next sibling query and the response's `part`/`unit`/`topic`/`course` sections on `lesson.topic` (null when the legacy link is absent). |
| `src/app/api/teacher/lessons/route.ts` | Skip lessons without the legacy topic chain in the grouping loop (same as the pre-existing `if (!course) continue;`). |
| `src/app/api/admin/ai-generate-quiz/route.ts` | Optional chaining + `—` placeholders in the AI context string; `created: Question[]`. |
| `src/app/api/teacher/attendance/route.ts` | `results` typed as `Array<{studentId; sessionId; status: AttendanceStatus; note}>`. |
| `src/app/api/admin/payments/import/route.ts` | Removed the dead duplicate `status` key (emitted JSON unchanged). |
| `src/app/api/parents/me/dashboard/route.ts` | Added `deadline` to the homework `select` so the existing `s.homework?.deadline` read actually resolves. |
| `src/app/api/quizzes/[id]/route.ts` | `courseSlug` via `quiz.lesson.topic?.… ?? null`. |
| `src/app/api/teacher/homework/route.ts` | `course` section guarded on `hw.lesson.topic?.…`. |
| `src/app/api/teacher/homework/[id]/grade/route.ts` | Authorization check reads `hw.lesson.topic?.unit.part.courseId`; a lesson with no resolvable course is denied (403), as before. |
| `src/app/api/teacher/quizzes/route.ts` | Same pattern as teacher/homework for the course section and the teacher-course authorization check. |
| `src/app/api/students/me/dashboard/route.ts` | `continueLesson` `part`/`unit`/`topic`/`courseSlug` guarded on `continueLesson.topic`. |
| `src/lib/progress.ts` | `l.topic?.unit.part.courseId` with a skip (the query's `where` only returns topic-linked lessons, so no behavior change). |
| `src/lib/session-progress.ts` | Typed the three short-circuit `Promise.resolve([])` branches; `canAccessLesson` returns `LESSON_NOT_FOUND` instead of crashing when a lesson has no topic (still requires an ACTIVE group — invariant tests unchanged and passing). |
| `docs/DEPLOYMENT_GUIDE.md` | The "What `bun run build` does" section quoted the old `cp -r` command; updated to describe the new pipeline. |
| `docs/PHASE_2_BUILD_TYPE_SAFETY.md` | This document. |
| `docs/PROJECT_STATE.md` | Phase 2 status. |

No `any` casts were added, no TypeScript rules/compiler settings were
weakened, no errors were suppressed, and no dependency versions changed.

## Build Script Changes

`scripts/copy-standalone-assets.mjs` reproduces exactly the two copies the
`cp -r` chain performed, verified after the change:

```text
.next/static  →  .next/standalone/.next/static   ✓
public        →  .next/standalone/public         ✓
```

- Windows compatible (no shell, no POSIX commands; plain `node:fs.cpSync`).
- Linux/macOS compatible.
- No external dependencies.
- Exits non-zero with a clear message if `next build` did not produce the
  standalone output or an asset tree is missing.
- Node's `cpSync(recursive: true)` was verified to be deterministic for both
  a first copy and a re-copy over an existing target (rebuild scenario).

## TypeScript Fixes

Method: fix the smallest real cause per site.

- Nullable relation (`Lesson.topic`): optional chaining with explicit,
  intention-preserving fallbacks; authorization paths deny (403 / 404) a
  lesson whose course cannot be resolved rather than crashing. For the
  current data set (every seeded lesson has a topic) all responses are
  byte-identical to before.
- Inference gaps: explicit structural types on the two `[]` accumulators and
  the three short-circuit promise branches (typed empty arrays, not casts).
- Dead duplicate key removed; missing select field added.

## Prisma Generation

Pipeline order is now enforced by the build script itself:
`prisma generate` → `next build` (which type-checks) → standalone asset copy.
`bun run db:generate` passes. Generator, provider, schema, versions and
migrations untouched. `@prisma/client`'s own `postinstall` also generates the
client on fresh installs, so the explicit `prisma generate` in `build` is a
deterministic guarantee (also covers `--ignore-scripts` installs), not a new
mechanism.

> **Sandbox environment note.** The development sandbox's egress firewall
> blocks `binaries.prisma.sh` (and `bun install`'s TLS to the npm registry),
> so for local verification the Prisma query/schema engines were fetched
> from a public GitHub mirror of the official CDN artifacts
> (`owengretzinger/prisma-engines-mirror`, engines commit
> `c2990dca…` — the exact commit `@prisma/engines-version` pins) and their
> sha256 checksums verified against the CDN checksum files. The binaries
> live only in `node_modules` (never committed). Dependencies were installed
> with `npm ci` from the committed `package-lock.json`; `bun.lock` is
> untouched and remains canonical for the project's Bun workflow.

## Testing

- `bun run db:generate` — **PASS** (Prisma Client v6.19.3 generated).
- Test suites (the repository's own runner, `node tests/*.test.js`):
  - `authorization-invariants.test.js` — 93 passed, 0 failed
  - `migration-sql.test.js` — 15 passed, 0 failed
  - `mock-exam-grading-isolation.test.js` — 22 passed, 0 failed
  - `parent-monthly-report.test.js` — 67 passed, 0 failed
  - `platform-upgrade-2026-migration.test.js` — 98 passed, 0 failed
  - `registration-validators.test.js` — 24 passed, 0 failed
  - `seed-idempotency.test.js` — 18 passed, 0 failed

  Total: **337 passed, 0 failed** — identical to the Phase 1 baseline.
- Typecheck: `bun run typecheck` (`tsc --noEmit`) — **PASS, 0 errors**
  (baseline: 67 errors).
- Lint: `bun run lint` — 78 issues, **identical to baseline** (issue list
  diffed: zero added, zero removed). Existing state documented below.

## Production Build

`bun run build` (which now runs `prisma generate && next build &&
node scripts/copy-standalone-assets.mjs`):

```text
Typecheck:               PASS (tsc --noEmit, 0 errors; build runs its own
                               type validation with ignoreBuildErrors removed)
Compile:                 PASS (✓ Compiled successfully)
Page data collection:    PASS
Static generation:       PASS (62/62 static pages generated)
Standalone asset copy:   PASS (both copies logged by the script; verified
                               .next/standalone/.next/static and
                               .next/standalone/public exist)
Final build:             PASS (exit 0)
```

**Negative control:** with `ignoreBuildErrors` removed, a deliberately
introduced type error (`const x: number = "…"`) failed `next build` with
`error TS2322` — proving the build genuinely validates types now, not just
compiles.

## Production Startup

Verified with the standalone output (`.next/standalone/server.js`) under
both runtimes (node v22 and bun 1.4.2), against a throwaway local SQLite
database materialized from the committed schema (no `db:push`, no
`db:reset`, no new migrations — see note below):

- Server starts and stays up; no startup crash; logs clean.
- `/` → 200; `/logo.svg` (copied `public/` asset) → 200.
- `POST /api/auth/login` with unknown user → 401 JSON (proves the Prisma
  client initializes and queries the `User` table in the standalone bundle).
- `/api/auth/me` → 401; `/api/courses` → 401; `/api/lessons/abc` → 401;
  `/api/admin/overview` → 401 (auth guards intact end-to-end).

Production startup: **PASS** (node and bun).

## Remaining Issues

- **Lint (pre-existing, untouched by this phase):** 78 issues —
  38 × `@typescript-eslint/no-require-imports` (test-file `require()` calls)
  and ~40 × `react-hooks/set-state-in-effect` / related React-compiler rules
  across ~20 client components. None are in files changed by this phase.
  Per the phase scope, lint cleanup is deferred.
- **`start` script portability:** `"start": "NODE_ENV=production bun
  .next/standalone/server.js 2>&1 | tee server.log"` uses env-prefix and
  pipe syntax that Windows CMD does not support. Out of this phase's scope
  (the phase targets the *build* script); unchanged.
- **Lockfile drift (pre-existing):** `bun.lock` pins Prisma 6.19.2 while the
  committed `package-lock.json` pins 6.19.3 (same minor, same engines
  commit). Untouched.
- **No baseline migration (pre-existing):** `prisma/migrations` starts with
  an `ALTER TABLE` against tables created before migration tracking, so
  `prisma migrate deploy` alone cannot bootstrap an empty database; the
  documented setup path remains `db:push`. Untouched per the no-database-
  changes rule. (For the startup smoke test above, the schema SQL was
  materialized directly from `prisma/schema.prisma` with
  `prisma migrate diff --from-empty` into a throwaway gitignored file.)

## Deferred Work

- Lint cleanup phase (the 78 pre-existing issues above).
- Windows-compatible `start` script (env-prefix + `tee`).
- Curriculum seeding for the 23 official lessons (will make topic-less,
  unit-linked lessons reachable; the nullable-topic guards added here keep
  those lessons denied/crash-free until that approved phase resolves their
  course resolution).
- Aligning `bun.lock` and `package-lock.json` Prisma patch versions.
- A baseline Prisma migration so fresh environments can `migrate deploy`
  instead of `db push`.
