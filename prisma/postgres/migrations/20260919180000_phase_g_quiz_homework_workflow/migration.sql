-- ===========================================================================
-- Phase G — Quiz / Homework operational workflow (PostgreSQL edition).
--
-- This is the PostgreSQL twin of the SQLite migration of the same name. The
-- two files are NOT copies: SQLite stores lifecycle states as TEXT columns
-- and cannot attach a foreign key to an existing table without rebuilding it,
-- while PostgreSQL adds the real FOREIGN KEY constraints here. What the two
-- editions agree on is the LOGICAL result: the same columns, the same
-- defaults, the same constraints and the same index names (none new — the
-- Phase G columns carry no @@index in the schema source).
--
-- ADDITIVE ONLY. No table is rebuilt, no column is dropped, no row is deleted,
-- no default is backfilled destructively. Every added column is nullable or
-- has a constant default, so existing production rows stay valid at apply
-- time. NOT applied to Neon/production during Phase G implementation — local
-- rehearsal only.
--
-- Column purposes are documented in the SQLite twin; this file documents only
-- the PostgreSQL-specific shape.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Quiz — lifecycle ('DRAFT' | 'PUBLISHED', TEXT like quizMode).
-- ---------------------------------------------------------------------------
ALTER TABLE "Quiz" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "Quiz" ADD COLUMN "publishedAt" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------
-- 2. Homework — lifecycle + teacher attachment.
-- ---------------------------------------------------------------------------
ALTER TABLE "Homework" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "Homework" ADD COLUMN "publishedAt" TIMESTAMPTZ(3);
ALTER TABLE "Homework" ADD COLUMN "attachmentId" TEXT;

-- ---------------------------------------------------------------------------
-- 3. HomeworkSubmission — student file + grader identity.
-- ---------------------------------------------------------------------------
ALTER TABLE "HomeworkSubmission" ADD COLUMN "attachmentId" TEXT;
ALTER TABLE "HomeworkSubmission" ADD COLUMN "gradedById" TEXT;
ALTER TABLE "HomeworkSubmission" ADD COLUMN "gradedAt" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------
-- 4. Foreign keys (the SQLite twin documents why these exist here only).
-- ---------------------------------------------------------------------------
ALTER TABLE "Homework" ADD CONSTRAINT "Homework_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "MediaAsset"("id") ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "HomeworkSubmission" ADD CONSTRAINT "HomeworkSubmission_attachmentId_fkey"
  FOREIGN KEY ("attachmentId") REFERENCES "MediaAsset"("id") ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE "HomeworkSubmission" ADD CONSTRAINT "HomeworkSubmission_gradedById_fkey"
  FOREIGN KEY ("gradedById") REFERENCES "User"("id") ON UPDATE CASCADE ON DELETE SET NULL;
