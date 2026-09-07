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
- Next planned phase: only after explicit approval.

## Architecture summary
Next.js application with Prisma and SQLite. The database remains SQLite, while the schema uses portable relational concepts and stable IDs. Existing operational grouping (`Group`) remains separate from explicit student access (`Enrollment`).

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
- `SECURITY_HASH_SECRET` falls back to a hardcoded value if not set (M3 — deferred).
- No `middleware.ts` for edge-level route protection (M4 — deferred).
