-- ===========================================================================
-- SessionVideo requirement modes + absence-linked recordings (PostgreSQL).
--
-- Provider twin of prisma/migrations/20260921180000_session_video_requirement_modes:
-- same additive shape (new enum type, two new columns, one backfill of the
-- NEW column only, one FK, one index). See the SQLite edition for the full
-- contract. The backfill is meaning-preserving: legacy
-- `isRequiredForProgression = TRUE` rows ("required for every eligible
-- student") become ALL_STUDENTS ("required for every eligible student").
-- The legacy flag column is KEPT (deprecated, dual-written).
-- ===========================================================================

CREATE TYPE "SessionVideoRequirementMode" AS ENUM ('OPTIONAL', 'ALL_STUDENTS', 'ABSENT_STUDENTS');
ALTER TABLE "SessionVideo" ADD COLUMN "requirementMode" "SessionVideoRequirementMode" NOT NULL DEFAULT 'OPTIONAL';
ALTER TABLE "SessionVideo" ADD COLUMN "liveSessionId" TEXT;
UPDATE "SessionVideo" SET "requirementMode" = 'ALL_STUDENTS' WHERE "isRequiredForProgression" = TRUE;
ALTER TABLE "SessionVideo" ADD CONSTRAINT "SessionVideo_liveSessionId_fkey" FOREIGN KEY ("liveSessionId") REFERENCES "LiveSession"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "SessionVideo_liveSessionId_idx" ON "SessionVideo"("liveSessionId");
