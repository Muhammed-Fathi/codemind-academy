# CodeMind Academy Project State

## Phase status
- **Deployment Readiness Audit (Phase 1):** completed (2026-09-07). Baseline `635de56`. See `docs/DEPLOYMENT_READINESS_AUDIT.md`.
  - 1 CRITICAL security fix (privilege escalation via registration)
  - 2 HIGH security fixes (quiz answer leakage, parent impersonation)
  - All 337 test assertions still pass
- Phase 2: completed; `docs/curriculum/knowledge-model.json` is the source-aligned curriculum contract.
- Phase 3: completed — Database & Domain Model Foundation (PR #14 merged).
- **Production Build & Type Safety (Phase 2 of current cycle): completed (2026-09-07). Baseline `fce4821`. See `docs/PHASE_2_BUILD_TYPE_SAFETY.md`.**
  - `ignoreBuildErrors` removed — `next build` performs real TypeScript validation (67 pre-existing hidden errors fixed; `tsc --noEmit` now clean).
  - Build script is cross-platform: `prisma generate && next build && node scripts/copy-standalone-assets.mjs` (replaces the Unix-only `cp -r` chain; same standalone layout preserved).
  - Added `bun run typecheck` (`tsc --noEmit`). All 337 test assertions still pass; lint state unchanged (78 pre-existing issues deferred); production startup verified under node and bun.
- **Production Security Hardening (Phase 3 of current cycle): completed (2026-09-07). Baseline `5bd041c`. See `docs/PHASE_3_SECURITY_HARDENING.md`.**
  - `SECURITY_HASH_SECRET` is now REQUIRED in production: `src/lib/env.ts` validates it, `next build` and server startup (`src/instrumentation.ts`) fail fast with a value-free message; the hardcoded dev fallback is gone from `security.ts` (M3 closed).
  - Defense-in-depth proxy added (`src/proxy.ts`, Next 16 name for middleware): cookie-presence 401 for protected `/api/*` namespaces only, no DB, routes remain the authorization source of truth (M4 closed). Baseline security headers + `poweredByHeader: false`.
  - HIGH fix: public `/api/groups` no longer serialises teachers' full `User` rows (password hash, phone, e-mail).
  - Dependencies: nodemailer 7→9.1.1, sharp 0.34→0.35.4, next 16.1→16.3.4 (minor; fixes proxy-bypass/DoS advisories); removed 6 unused direct deps (`next-auth`, `next-intl`, `@mdxeditor/editor`, `react-syntax-highlighter`, `uuid`, `@reactuses/core`). `npm audit` 12 → 4 high (only `xlsx` no-fix + prisma-CLI transitive). Prisma unchanged.
  - Phase 2 carry-over closed: `examples/` excluded from `tsconfig.json`.
  - `start` script replaced by dependency-free `scripts/start-production.mjs` (Windows-portable, same Linux behaviour).
  - Tests: 337 baseline + 242 new security assertions = 579 passing; typecheck 0 errors; build PASS.
- **Student Learning & Session Progression (Phase 4 of current cycle): completed (2026-09-08). Baseline `df81de4`. See `docs/PHASE_4_STUDENT_PROGRESSION.md`.**
  - CRITICAL fix: `/api/quizzes/[id]` (+ `/start`, `/submit`, `/evidence`) had **no session gate** — a student could `POST .../submit` with empty answers for a session two steps ahead, pre-satisfying the quiz requirement of every future session and receiving every correct answer/explanation. All four routes now go through the new `canAccessQuiz`.
  - Locked sessions no longer leak protected content: `/api/courses/[slug]` redacts `videoUrl`, `pdfUrl`, `summary`, `description`, `quiz`, `homework` and `requirements` (presence flags `hasQuiz`/`hasAssignment` remain for the UI badges); the `/api/lessons/[id]` 403 no longer echoes the requirement row; the dashboard `continueLesson.videoUrl` and the homework list are gated.
  - Deadlock fixed: no student-side homework submission endpoint existed (`POST /api/students/me/homework` → 405), so `assignmentDone` — one of the three unlock gates — was unreachable and any lesson with an assignment locked the course forever. Added `POST` (session-derived `studentId`, gated, `SUBMITTED`/`LATE`, graded submissions immutable, upsert on the unique pair) plus a minimal in-place submit form. Grading stays teacher-only.
  - Unlock rule reused unchanged: `unlocked[N+1] = video(≥95%) AND assignment AND quiz`, strictly sequential, missing components not required. No second progression system, no schema change, no new dependency.
  - Uniform denial helper `denyProgression()` in `src/lib/api.ts`: 404 for unknown/unverifiable resources (existence never confirmed), 403 + `code` otherwise, never a status row.
  - Phase 3 carry-over closed: the `process.exit(1) is not supported in the Edge Runtime` build warning is gone. Cause: `src/proxy.ts` runs on the Edge runtime so `instrumentation.ts` is bundled for both runtimes, and Next warns on any `process.<member>` call except `process.env`. The call now goes through `globalThis.process`; the production fail-fast is unchanged and was re-verified (build aborts, and the server exits 1, when `SECURITY_HASH_SECRET` is missing). Build now emits **0 warnings**.
  - Tests: 579 baseline + 89 new (`tests/session-progression.test.js`) = 668 passing; typecheck 0 errors; lint unchanged (44 pre-existing); production build PASS; 62/62 live API security assertions pass against the standalone production server (baseline: 8 failures).
- Next planned phase: only after explicit approval.

## Architecture summary
Next.js application with Prisma and SQLite. The database remains SQLite, while the schema uses portable relational concepts and stable IDs. Existing operational grouping (`Group`) remains separate from explicit student access (`Enrollment`).

## Phase 4 progression decisions
- `src/lib/session-progress.ts` stays the single source of truth. Phase 4 added *resource* gates (`canAccessQuiz`, `canAccessHomework`, `getUnlockedLessonIds`) that all resolve to the owning lesson and re-use `canAccessLesson` — there is still exactly one definition of "may this student open this session".
- A locked session is described by title/number/duration plus `hasQuiz`/`hasAssignment` presence booleans. Media URLs, material URLs, quiz/assignment identities, requirement breakdowns and summaries are server-side only; hiding them in the UI was never protection.
- Denials are uniform (`denyProgression`): 404 when a resource is unknown or not attached to a verifiable course (existence is never confirmed), 403 + machine-readable `code` otherwise, and never a requirement/status row.
- Assignment completion is still "a `HomeworkSubmission` exists with `submittedAt`". Phase 4 only made that row *reachable* by the student; it added no grading behaviour.
- Batch `SessionVideo`/`SessionVideoView` remain a separate, admin-published delivery channel gated by `batchId + isPublished`. They are deliberately **not** wired into lesson gating — doing so would create the second progression system this phase forbids.
- `LiveSession.meetingUrl` stays a group-calendar item, not a progression reward.
- `Lesson.isLocked` remains inert legacy metadata (the curriculum seed sets it for every non-first lesson, so enforcing it would deadlock the course).

## Authoritative curriculum
The four committed PDFs and the Phase 2 knowledge model are authoritative. The canonical hierarchy is Track → Course → Part → Unit → Lesson. The old Topic layer is retained only as a nullable legacy compatibility wrapper; official lessons use `Lesson.unitId`, `officialCode`, and `curriculumStatus=OFFICIAL`.

## Important architectural decisions
- Added explicit `Track`, `Enrollment`, and `Material` entities.
- Existing `Question` remains the central question record; `Quiz`, `ExamQuestion`, and mock links are assessment projections/legacy compatibility, not a second bank.
- `MediaAsset` is the storage abstraction. `SessionVideo` is the single video publication concept and `SessionVideoView` is student progress.
- `LiveSession`, `Homework`/submission, and `QuizAttempt` remain the existing operational domains and are lesson/session-linked.
- No Phase 4 runtime, curriculum reseed, randomization, upload UI, or progression behavior was implemented.

## Security decisions
This phase adds no authentication behavior. Material stores a storage key/media reference rather than trusting filenames; existing token hashing and audit structures remain unchanged. Foreign keys and restrictive media deletion protect historical references.

## Technical debt and known issues
The repository has no Phase 1 report at the requested path. Existing seed data still contains 36 synthetic lessons and must not be silently mapped. A later approved data migration must seed 23 official lessons using deterministic `officialCode` values and archive/unmap the remainder. Existing `Topic`, `Homework`, and `ExamQuestion` names require future compatibility cleanup, but were not destructively renamed.

## Dependencies and migration risks
Prisma 6.11.1, SQLite, and the existing migration history are dependencies. The Phase 3 migration is additive and does not backfill or delete data. SQLite's nullable unique semantics are relied on for optional legacy lesson codes; PostgreSQL migration should preserve explicit nullability and named indexes.

## Implementation status
Schema additions and migration are complete for the foundation. Documentation is complete; Phase 3 PR #14 is open and awaiting approval.

## Deployment Readiness Audit fixes (2026-09-07)
- **CRITICAL (C1):** Registration endpoint no longer allows self-registration as ADMIN/TEACHER.
- **HIGH (H1):** Quiz answers/explanations withheld from students until they have at least one finished attempt.
- **HIGH (H2):** Legacy email-based parent-student linking removed; all linking requires verified path (national ID + student code + parent phone).

## Known risks
- SQLite is not suitable for concurrent production use (M2 — deferred).
- ~~`ignoreBuildErrors: true` suppresses TypeScript errors during build (M1 — deferred).~~ **Resolved (2026-09-07, Phase 2 of current cycle):** the flag was removed; builds type-check for real and all 67 previously hidden errors were fixed.
- ~~`SECURITY_HASH_SECRET` falls back to a hardcoded value if not set (M3 — deferred).~~ **Resolved (2026-09-07, Phase 3):** required in production; build and startup fail fast.
- ~~No `middleware.ts` for edge-level route protection (M4 — deferred).~~ **Resolved (2026-09-07, Phase 3):** `src/proxy.ts` guards protected API namespaces (defense-in-depth only).
- `xlsx@0.18.5` has unfixable-on-npm advisories; exposure limited to the admin-only payments import (Phase 3 — documented, deferred).
