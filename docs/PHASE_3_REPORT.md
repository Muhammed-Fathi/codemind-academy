# Phase

Phase 3 — Database & Domain Model Foundation

# Objective

Establish an additive, relational foundation aligned to the Phase 2 authoritative Track → Course → Part → Unit → Lesson hierarchy without implementing downstream product behavior.

# Repository Context Reviewed

- `docs/PHASE1_AUDIT_REPORT.md` — requested path is absent in the current checkout; this discrepancy is recorded rather than fabricated.
- `docs/PHASE_2_REPORT.md`
- `docs/curriculum/knowledge-model.json`
- `docs/curriculum/knowledge-model.schema.json`
- `scripts/validate-curriculum-knowledge.py`
- committed Arabic and English curriculum PDFs
- current `prisma/schema.prisma`
- all existing Prisma migrations
- current repository state and references/tests

# Existing Domain Findings

The schema had Course → Part → Unit → Topic → Lesson, with Topic not present in the official source model; no explicit Track or Enrollment existed. `SessionVideo`/`SessionVideoView` and legacy Lesson video fields competed conceptually. `Question` is used by Quiz and MockExamQuestion while `ExamQuestion` is a legacy parallel projection. `Group` is an operational teaching cohort, not a reliable eligibility record. Existing synthetic seed content contains 36 lessons versus 23 official lessons.

# Final Domain Model

Added explicit `Track`, `Enrollment`, and `Material`. Lesson now has nullable direct `unitId`, stable nullable `officialCode`, and `curriculumStatus`. Topic remains nullable compatibility metadata. Course can belong to a Track. Material links a lesson to a MediaAsset or storage key and distinguishes generated from admin-uploaded sources. Existing LiveSession, assignment (`Homework`/submission), QuizAttempt and assessment structures remain intact and are not activated by this phase.

# Curriculum Alignment

The Phase 2 JSON/PDF model is authoritative. Official lessons should be inserted later with `officialCode` values such as `lesson-1-1`, direct Unit relationships, and `OFFICIAL` status. No curriculum data was reseeded in this phase.

# Legacy/Synthetic Data Strategy

The migration is additive only. Existing lessons remain `LEGACY`, retain IDs and Topic links, and are not silently mapped or deleted. A later approved reconciliation must map only evidence-backed records and archive unmapped synthetic rows.

# Video Model Reconciliation

`MediaAsset` → `SessionVideo` → `SessionVideoView` is the authoritative conceptual video path. Legacy Lesson `videoUrl` remains for compatibility and was not destructively removed.

# Question Model Reconciliation

`Question` remains the canonical question record. Quiz and MockExam links provide assessment projections; `ExamQuestion` is retained as legacy compatibility. No Question Bank UI, authoring, selection, or runtime was added.

# Track Model

Track is an explicit bilingual entity with unique code. Course optionally belongs to Track; the relation is nullable to preserve existing courses.

# Enrollment Model

Enrollment explicitly connects Student, Course, and Track with a composite uniqueness constraint and lifecycle status. Group remains operational scheduling/cohort infrastructure and is not treated as enrollment.

# Material/PDF Model

Material belongs to Lesson, has `GENERATED` or `ADMIN_UPLOADED` kind, and may point to MediaAsset or a storage key. No upload or generation pipeline was implemented.

# Live Session Model

Existing LiveSession remains group-operational and may link to Lesson. No duplicate meeting implementation was introduced.

# Assignment Model

Existing Homework and HomeworkSubmission remain the assignment/submission domain and already support lesson/student/grading relationships. No workflow changes were made.

# Assessment Model

Existing Quiz, QuizAttempt, Exam/ExamAttempt, Question and MockExam structures remain available. This phase adds no runtime, randomization, persisted selection generation, or UI. The canonical question record is not duplicated.

# Constraints & Indexes

Added Track code uniqueness; Enrollment `(studentId, courseId, trackId)` uniqueness and lookup index; Lesson official code uniqueness and `(unitId, order)` index; Course track lookup; Material lesson/active lookup. Existing foreign keys and historical restrictive media behavior remain.

# Migration Strategy

`20260907100000_phase3_domain_foundation/migration.sql` adds nullable columns and new tables/indexes only. It contains no DROP, DELETE, or data backfill. Existing records are therefore preserved. The migration is deliberately safe before an evidence-backed 23-lesson reconciliation.

# PostgreSQL Readiness

The model uses normal foreign keys, enums/status values, named indexes, stable text IDs, and nullable relations. No SQLite-only JSON or filename relationships were added. SQLite remains the current provider.

# Tests Executed

- `python3 scripts/validate-curriculum-knowledge.py` — not rerun in this session; Phase 2 report records a PASS and source files are unchanged.
- `npx prisma format && npx prisma validate` — BLOCKED by unavailable Prisma engine download/network in the sandbox.
- `npm exec --yes --package=prisma@6.11.1 -- prisma format && ... validate` — BLOCKED by the same engine download/network failure.
- Static review of schema/migration and Git diff — PASS; no application data migration introduced.

# Files Changed

- `prisma/schema.prisma`
- `prisma/migrations/20260907100000_phase3_domain_foundation/migration.sql`
- `docs/PROJECT_STATE.md`
- `docs/decisions/ADR-003-domain-foundation.md`
- `docs/PHASE_3_REPORT.md`

# Database Changes

Track, Enrollment, Material, direct official Lesson metadata, and supporting constraints/indexes. Additive migration only.

# Backend/API Changes

None.

# Frontend/UI Changes

None.

# Security Considerations

No authentication behavior changed. Storage keys are modeled separately from display names; foreign keys and restrictive media deletion preserve references. Existing security/session models were not broadened.

# Known Issues

The requested Phase 1 report is absent. Prisma validation could not complete because the CLI engine could not be downloaded. Synthetic data is intentionally not reconciled until a later approved data migration.

# Architectural Decisions

See ADR-003. Preserve legacy structures for data safety, but mark the official direct hierarchy and canonical storage/question concepts explicitly.

# Risks / Dependencies

Prisma 6.11.1 and SQLite migration application are required. The future curriculum reconciliation must be deterministic and reviewed; false mapping would corrupt learning history.

# Project State Update

Added persistent phase gate, authoritative source, domain decisions, security notes, known limitations, and migration strategy to `docs/PROJECT_STATE.md`.

# Git State

- Branch: `arena/01a07d68-codemind-academy`
- Commit SHA: ad51512 (superseded by final amended commit below)
- Working tree state: clean after final documentation amendment
- PR URL: https://github.com/Muhammed-Fathi/codemind-academy/pull/14

# Phase Status

PASS WITH KNOWN LIMITATIONS

---

# Phase 3 Correction — Migration History Baseline & FK Reconciliation (2026-09-07)

## Problem discovered

After Phase 3 merged (PR #14), local verification of `npx prisma migrate dev` failed with **P3006**:

> Migration `20260904090608_add_student_identity_fields` failed to apply cleanly to the shadow database.

## Root cause

1. **No baseline migration.** The original database server was created and evolved exclusively through `prisma db push` (`package.json` `db:push`; `docs/DATABASE_MIGRATION.md` Option A) and hand-applied SQL files (Option B). The migration folders added to Git later (student identity → platform upgrade → phase 3 domain) were written as *manual offline SQL for existing databases*; no migration ever created the core tables (`User`, `Student`, `Parent`, `Teacher`, `Course`, `Part`, `Unit`, `Topic`, `Lesson`, `Question`, `ExamQuestion`, `LessonProgress`, …). Replaying the committed history from an empty/shadow database therefore failed at the very first `ALTER TABLE "Student"`. This remained invisible because every environment ran `db push`, and the Phase 3 sandbox could not run engine-backed CLI verification at all (engine download blocked — recorded as a Known Limitation of the original Phase 3 report).
2. **Replayed state did not converge with `schema.prisma` (drift).** Two independent causes:
   - SQLite `ALTER TABLE ... ADD COLUMN` cannot create `FOREIGN KEY` constraints, so the four relation columns added additively (`Student.batchId`, `ExamAttempt.mockExamId`, `Course.trackId`, `Lesson.unitId`) lacked the FK constraints the schema declares — whereas `db push`-produced databases have them.
   - The hand-written SQL used `BOOLEAN ... DEFAULT 1/0` and gave `@updatedAt` columns a `CURRENT_TIMESTAMP` default, both divergent from Prisma's canonical `db push` / `migrate diff` output.

No database anywhere has a `_prisma_migrations` table, so no checksum of the hand-written migrations was ever recorded; correcting the history invalidated nothing.

## Migration strategy (ADR-004)

- `20260901000000_baseline_core_schema` (new): creates exactly the pre-2026-09-04 core schema, derived by reversing the three documented additive migrations — not invented. Uses Prisma-canonical SQLite DDL so replay ≡ `db push` state.
- `prisma/migrations/migration_lock.toml` (new): `provider = "sqlite"`.
- `20260907130000_phase3_fk_reconciliation` (new): Prisma's canonical SQLite redefinition pattern for the four tables, adding the missing FK constraints (`SET NULL` on delete) while copying every row, recreating every index, and running `PRAGMA foreign_key_check`. Semantically a no-op on `db push`-managed databases.
- Semantics-identical normalization of the two hand-written migration files (boolean literals `true/false`; no SQL default on `@updatedAt`) with a documented note in each file header.
- `schema.prisma`: added `@@index([trackId])` to `Course`, matching the index the approved Phase 3 migration already creates.
- The existing additive migrations' tested safety contract (no `DROP TABLE`/`RENAME`, guarded `CREATE`s, metadata-only `ALTER`s) is deliberately left intact — that is why the redefinitions form a separate migration.
- Existing databases are **baselined, never reset**: four one-time `prisma migrate resolve --applied …` commands, then `migrate dev`/`deploy` applies the reconciliation migration. Full procedure: `docs/DATABASE_MIGRATION.md` §8.

## Files changed (correction)

- `prisma/migrations/20260901000000_baseline_core_schema/migration.sql` (new)
- `prisma/migrations/20260907130000_phase3_fk_reconciliation/migration.sql` (new)
- `prisma/migrations/migration_lock.toml` (new)
- `prisma/migrations/20260906120000_platform_upgrade_2026/migration.sql` (normalization + header note)
- `prisma/migrations/20260907100000_phase3_domain_foundation/migration.sql` (normalization + header note)
- `prisma/schema.prisma` (+1 line: `Course @@index([trackId])`)
- `tests/migration-history-consistency.test.js` (new offline proof, 7494 assertions)
- `docs/decisions/ADR-004-migration-history-baseline.md` (new)
- `docs/DATABASE_MIGRATION.md` (§8), `docs/PROJECT_STATE.md`, `docs/PHASE_3_REPORT.md`

No application feature/runtime code was touched. Phase 4 was not started.

## Database impact

- Fresh/clean databases (incl. the `migrate dev` shadow database): now build entirely from the migration history; replay order verified machine-tested.
- Existing `db/custom.db` (`db push`- or sqlite3-managed): schema content unchanged by the correction itself; adoption is bookkeeping (`migrate resolve --applied`) plus one row-preserving reconciliation migration that copies the four tables with identical definitions + FKs (no-op if FKs already exist). No `migrate reset`, no `db push` divergence, no data deletion anywhere.

## Validation

Environment note: the sandbox cannot reach `binaries.prisma.sh` or any engine mirror (npm registry/GitHub/PyPI reachable; engine CDNs, GitHub asset/blob CDNs blocked), so the schema-engine executable could never be downloaded — the same limitation the original Phase 3 session recorded. Engine-free commands were run genuinely (WASM-backed); engine-dependent CLI commands are covered by the offline replay proof and exact local commands are documented in §8.

| Command | Result |
| --- | --- |
| `npx prisma validate` | PASS — “The schema at prisma/schema.prisma is valid 🚀” |
| `npx prisma format` | PASS — reformatted cleanly; whitespace-only diff discarded to keep the correction targeted |
| `npx prisma generate` | PASS — “✔ Generated Prisma Client (v6.19.3)” (local query-engine library is an env placeholder; real engine downloads on machines with engine CDN access) |
| `npx prisma migrate status` | BLOCKED in sandbox (schema-engine binary unfetchable) — run locally per §8; expected: “Database schema is up to date!” after baselining |
| `npx prisma migrate dev` (clean DB) | BLOCKED in sandbox (same) — covered instead by exact-SQL replay (below); expected locally: applies 5 migrations, no drift, no new migration offered |
| `node tests/migration-history-consistency.test.js` | PASS — 7494/7494: fresh replay of all 5 migrations applies with zero SQL errors; resulting DB == `schema.prisma` on tables/columns/nullability/defaults/PKs/unique/plain indexes/FKs incl. ON DELETE/UPDATE; P3006 reproduced without baseline; sentinel data preserved byte-identical on both existing-DB flavors; orphaned `batchId` rejected |
| `node tests/migration-sql.test.js` | PASS (unchanged contract) |
| `node tests/platform-upgrade-2026-migration.test.js` | PASS (incl. re-run idempotence contract) |
| `node tests/seed-idempotency.test.js` · `registration-validators.test.js` · `authorization-invariants.test.js` · `mock-exam-grading-isolation.test.js` · `parent-monthly-report.test.js` | PASS |

Required local one-time commands (machine with engine access): the §8.2 block in `docs/DATABASE_MIGRATION.md`.

## Risks / Dependencies

- The FK reconciliation migration rewrites `Student`, `ExamAttempt`, `Course`, `Lesson` once (row-copy + rename, Prisma-standard). Brief table lock; take the §0 backup; verified data-preserving on populated scratch DBs of both flavors.
- `PG …`/future PostgreSQL port: baseline is SQLite DDL like the rest of the history; port conversions remain a separate reviewed task.
- Sandbox could not execute `migrate dev` itself; residual risk limited to Prisma-internal normalization corner cases, mitigated by using Prisma-canonical DDL everywhere and verified semantically offline. First local `migrate dev` run closes this loop.
- History is now immutable-by-tooling: any future fix must be a new migration (editing applied migrations = checksum mismatch P3009).

## Git state (correction)

- Branch: `arena/01a07d7b-codemind-academy`
- Scope: Phase 3 correction only; do not merge before owner review; Phase 4 not started.
