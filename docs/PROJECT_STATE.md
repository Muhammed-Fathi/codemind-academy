# CodeMind Academy Project State

## Phase status
- Phase 1: completed (the referenced `docs/PHASE1_AUDIT_REPORT.md` is not present in this checkout; current code and Phase 2 findings were used).
- Phase 2: completed; `docs/curriculum/knowledge-model.json` is the source-aligned curriculum contract.
- Phase 3: in progress — Database & Domain Model Foundation.
- Next planned phase: Phase 4 (only after explicit approval).

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
