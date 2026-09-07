# CodeMind Academy Project State

## Phase status
- Phase 1: completed (the referenced `docs/PHASE1_AUDIT_REPORT.md` is not present in this checkout; current code and Phase 2 findings were used).
- Phase 2: completed; `docs/curriculum/knowledge-model.json` is the source-aligned curriculum contract.
- Phase 3: completed (PR #14 merged); a targeted **Phase 3 correction** (migration-history baseline + FK reconciliation, ADR-004) is applied — see `docs/PHASE_3_REPORT.md` “Phase 3 Correction”.
- Next planned phase: Phase 4 (only after explicit approval; **not started**).

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
Prisma (^6.11.1, locked 6.19.3) and SQLite are dependencies. The Prisma **migration history is now complete and replayable from an empty database**: baseline `20260901000000_baseline_core_schema` plus the three additive migrations plus `20260907130000_phase3_fk_reconciliation`, guarded by `tests/migration-history-consistency.test.js` (ADR-004). Existing `db push`-managed databases must be baselined once with `prisma migrate resolve --applied` per `docs/DATABASE_MIGRATION.md` §8 — no reset, no data loss. The Phase 3 migration itself is additive and does not backfill or delete data. SQLite's nullable unique semantics are relied on for optional legacy lesson codes; PostgreSQL migration should preserve explicit nullability and named indexes.

## Implementation status
Phase 3 domain foundation merged (PR #14). Migration history corrected and machine-verified offline (replay ≡ schema, FKs reconciled, data-preservation proven); `prisma validate`/`generate` pass, engine-dependent CLI commands (`migrate dev/status`) could not run in the sandbox (engine CDN unreachable) and are documented for one-time local execution in §8 of `docs/DATABASE_MIGRATION.md`. Phase 4 is NOT started.
