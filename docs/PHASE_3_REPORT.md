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
