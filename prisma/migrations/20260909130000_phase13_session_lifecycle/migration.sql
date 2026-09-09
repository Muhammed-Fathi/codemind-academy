-- CodeMind Academy — Migration: Phase 13 Session Lifecycle & Publishing Core
-- Date: 2026-09-09
-- Tables touched: Lesson (add status + publishedAt, backfill)
--
-- WHAT THIS DOES
--   1. Adds Lesson.status (LessonStatus enum, NOT NULL DEFAULT 'DRAFT') and
--      Lesson.publishedAt (nullable DateTime) — the authoritative lifecycle.
--   2. Backfills status from the deprecated isPublished boolean:
--        isPublished = 1  →  status = 'PUBLISHED'  (publishedAt = COALESCE(existing, updatedAt))
--        isPublished = 0  →  status = 'DRAFT'      (publishedAt = NULL)
--      The mapping is deterministic, idempotent and preserves row count/ids.
--   3. Keeps Lesson.isPublished as a read-only compatibility mirror — kept in
--      sync with status (isPublished = 1 iff status = 'PUBLISHED') so old
--      readers that still filter on isPublished continue to see the same rows
--      during the transitional period. New code MUST use status.
--   4. Creates an index on Lesson.status for the student curriculum universe
--      (status = 'PUBLISHED' is the common filter).
--
-- SAFETY
--   * ADD COLUMN with DEFAULT is SQLite-safe: every existing row receives the
--     default without a table rebuild and without deleting history.
--   * No DROP TABLE / DROP COLUMN / DELETE / TRUNCATE. No historical migration
--     edited. No prisma db push / reset.
--   * Backfill is two idempotent UPDATEs; re-running converges to the same state.
--   * publishedAt backfill uses updatedAt as a stand-in when no value exists —
--     it is informational only and never used as a gate.
--   * Row/relation preservation is ensured via additive DDL; foreign keys are
--     not touched, so no cascade fires.
--   * isLocked is NOT touched — inert legacy metadata, retired per Phase 13.
--
-- WHY THE ENUM IS TEXT
--   Prisma maps SQLite enums to TEXT; no CHECK constraint is emitted. The
--   constraint is enforced by the Prisma client and by the domain helpers in
--   src/lib/session-lifecycle.ts, which fail closed on unknown values.

-- 1. DDL — additive
ALTER TABLE "Lesson" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';
ALTER TABLE "Lesson" ADD COLUMN "publishedAt" DATETIME;

-- 2. Index for the published-curriculum hot path
CREATE INDEX "Lesson_status_idx" ON "Lesson"("status");

-- 3. Backfill status from deprecated isPublished (deterministic, idempotent)
UPDATE "Lesson" SET "status" = 'PUBLISHED' WHERE "isPublished" = 1 AND "status" = 'DRAFT';
UPDATE "Lesson" SET "status" = 'DRAFT' WHERE "isPublished" = 0;

-- 4. Backfill publishedAt for published lessons (informational, not a gate)
UPDATE "Lesson" SET "publishedAt" = "updatedAt" WHERE "status" = 'PUBLISHED' AND "publishedAt" IS NULL;

-- 5. Keep isPublished in sync with status (compatibility mirror — idempotent)
UPDATE "Lesson" SET "isPublished" = 1 WHERE "status" = 'PUBLISHED' AND "isPublished" = 0;
UPDATE "Lesson" SET "isPublished" = 0 WHERE "status" != 'PUBLISHED' AND "isPublished" = 1;

-- Post-migration invariants (asserted outside this file / in tests):
--   * SELECT COUNT(*) FROM Lesson WHERE status NOT IN ('DRAFT','READY','PUBLISHED') = 0
--   * SELECT COUNT(*) FROM Lesson WHERE status='PUBLISHED' = (prev isPublished=1 count)
--   * SELECT COUNT(*) FROM Lesson WHERE status='DRAFT' = (prev isPublished=0 count)
--   * 23 official lessons remain, 2 Parts, 7 Units, officialCode 1-1..7-3 unique
--   * every Lesson row carries status; trackScope/distinct counts unchanged
--   * no LessonProgress / QuizAttempt / HomeworkSubmission lost; FK check clean
