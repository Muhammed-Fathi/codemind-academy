-- ===========================================================================
-- SessionVideo progression requirement (PG).
--
-- ADDITIVE ONLY. One new column with a static default. No table is rebuilt,
-- no row is deleted, no value is backfilled: every pre-existing SessionVideo
-- row reads isRequiredForProgression = false (OPTIONAL) the moment this
-- migration lands, which preserves the historical engine behaviour
-- (optional recordings are never progression inputs) byte-for-byte.
--
-- The logical change is identical to the SQLite edition of this migration
-- (same table, same column, same Prisma-canonical shape) with PostgreSQL
-- types. See the SQLite edition for the contract notes.
-- ===========================================================================

ALTER TABLE "SessionVideo" ADD COLUMN "isRequiredForProgression" BOOLEAN NOT NULL DEFAULT FALSE;
