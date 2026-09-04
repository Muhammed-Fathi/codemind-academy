-- CodeMind Academy — Migration: add student identity fields
-- Date: 2026-09-05
-- Tables touched: Student ONLY (4 new NULLABLE columns + 2 unique indexes)
--
-- SAFETY:
--  * ALTER TABLE ... ADD COLUMN with no DEFAULT is metadata-only in SQLite:
--    no table rewrite, no row is modified, existing values are untouched.
--  * All new columns are NULLABLE, so every pre-existing row stays valid.
--  * SQLite permits unlimited NULLs in UNIQUE indexes, so the two new
--    UNIQUE indexes succeed even with existing rows (all NULL).
--  * Contains NO DROP / DELETE / TRUNCATE / UPDATE / data-migration steps.
--  * Idempotent-ish: re-running fails on "duplicate column name" WITHOUT
--    changing anything (all statements before the failure already applied
--    are pure ADDs). Prefer the sqlite3 CLI steps in
--    docs/DATABASE_MIGRATION.md which guard with PRAGMA table_info checks.
--
-- If you use `prisma db push` instead, it auto-generates exactly these
-- changes from prisma/schema.prisma — applying this file manually is the
-- offline equivalent.

ALTER TABLE "Student" ADD COLUMN "studentCode" TEXT;
ALTER TABLE "Student" ADD COLUMN "nationalId" TEXT;
ALTER TABLE "Student" ADD COLUMN "parentPhone" TEXT;
ALTER TABLE "Student" ADD COLUMN "schoolType" TEXT;

CREATE UNIQUE INDEX "Student_studentCode_key" ON "Student"("studentCode");
CREATE UNIQUE INDEX "Student_nationalId_key" ON "Student"("nationalId");
