-- ===========================================================================
-- Phase H — Canonical progression & access authority (PostgreSQL edition).
--
-- This is the PostgreSQL twin of the SQLite migration of the same name. The
-- two files are NOT copies: SQLite stores lifecycle states as TEXT columns and
-- emits the foreign keys inline, while PostgreSQL adds the same constraints
-- with the canonical Prisma names. What the two editions agree on is the
-- LOGICAL result: the same table, the same columns, the same defaults, the
-- same constraints and the same index names.
--
-- ADDITIVE ONLY. No table is rebuilt, no column is dropped, no row is deleted,
-- no default is backfilled destructively. The ONE new table is created empty,
-- so every pre-Phase-H row keeps its exact meaning.
-- NOT applied to Neon/production during Phase H implementation — local
-- rehearsal only.
--
-- Column purposes are documented in the SQLite twin; this file documents only
-- the PostgreSQL-specific shape.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. ProgressionOverride — the Admin exception over a progression boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE "ProgressionOverride" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "courseId" TEXT,
  "lessonId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "createdByUserId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3),
  "revokedAt" TIMESTAMPTZ(3),
  "revokedByUserId" TEXT,
  "revokeReason" TEXT,
  CONSTRAINT "ProgressionOverride_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProgressionOverride_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "ProgressionOverride_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 2. Indexes (Prisma-canonical names).
-- ---------------------------------------------------------------------------
CREATE INDEX "ProgressionOverride_studentId_lessonId_idx" ON "ProgressionOverride" ("studentId", "lessonId");
CREATE INDEX "ProgressionOverride_studentId_revokedAt_idx" ON "ProgressionOverride" ("studentId", "revokedAt");
CREATE INDEX "ProgressionOverride_lessonId_idx" ON "ProgressionOverride" ("lessonId");
CREATE INDEX "ProgressionOverride_expiresAt_idx" ON "ProgressionOverride" ("expiresAt");
