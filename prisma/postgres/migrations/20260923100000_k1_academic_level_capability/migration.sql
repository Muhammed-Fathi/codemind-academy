-- ===========================================================================
-- Multi-Level Expansion — Phase K1: AcademicLevel capability + backfill
-- (PostgreSQL edition).
--
-- This is the PostgreSQL twin of the SQLite migration of the same name. The
-- two files are NOT copies: SQLite stores enums as TEXT and needs no type
-- DDL, while PostgreSQL creates the native enum. The backfill statements are
-- standard SQL and are intentionally identical in both editions.
--
-- WHAT THIS DOES
--   1. Creates the native enum:
--        FIRST_SECONDARY
--        SECOND_SECONDARY
--      and adds `academicLevel` (nullable) to Course, Student and Lesson.
--      Required-ness and the composite lesson uniqueness are Phase K3 work.
--   2. Backfills every existing row explicitly (the whole current platform
--      is Second Secondary — zero inference):
--        * Course  → SECOND_SECONDARY (curriculum authority)
--        * Student → SECOND_SECONDARY (declared level)
--        * Lesson  → the level of its resolved Course, through the canonical
--          chain Lesson→Unit→Part→Course, with the legacy fallback
--          Lesson→Topic→Unit→Part→Course for lessons that only carry a topic
--          link. A lesson that resolves to NO course is left NULL (an orphan)
--          — it is never guessed, and a non-zero orphan count is a K1 stop
--          condition (the K1 verification reports the orphan IDs/titles).
--
-- SAFETY
--   * ADDITIVE: one new type, three nullable columns, no constraint change.
--     The global `Lesson.officialCode` unique stays in place (the composite
--     [academicLevel, officialCode] uniqueness is Phase K3 work, not K1).
--   * DATA: only the three new columns are written. Every existing ID,
--     relation, official code, progress row, attempt, submission, attendance
--     row, absence case, parent link, notification, subscription, payment,
--     session, batch, group and media reference is untouched.
--   * BEHAVIOUR: the columns are inert for the current application code —
--     K1 changes no runtime behaviour (no UI, no gate, no engine change).
-- ===========================================================================

CREATE TYPE "AcademicLevel" AS ENUM ('FIRST_SECONDARY', 'SECOND_SECONDARY');

ALTER TABLE "Course" ADD COLUMN "academicLevel" "AcademicLevel";
ALTER TABLE "Student" ADD COLUMN "academicLevel" "AcademicLevel";
ALTER TABLE "Lesson" ADD COLUMN "academicLevel" "AcademicLevel";

-- Backfill — Courses first (the lessons derive from them), then Students.
UPDATE "Course" SET "academicLevel" = 'SECOND_SECONDARY';
UPDATE "Student" SET "academicLevel" = 'SECOND_SECONDARY';

-- Lessons via the canonical chain (Lesson→Unit→Part→Course).
UPDATE "Lesson" SET "academicLevel" = (
  SELECT c."academicLevel"
  FROM "Unit" u
  JOIN "Part" p ON p."id" = u."partId"
  JOIN "Course" c ON c."id" = p."courseId"
  WHERE u."id" = "Lesson"."unitId"
)
WHERE "Lesson"."unitId" IS NOT NULL;

-- Lessons via the legacy chain (Lesson→Topic→Unit→Part→Course), only for
-- lessons without a canonical unit link (the canonical chain wins).
-- Lessons with neither link stay NULL: orphans, reported by the K1 gate.
UPDATE "Lesson" SET "academicLevel" = (
  SELECT c."academicLevel"
  FROM "Topic" t
  JOIN "Unit" u ON u."id" = t."unitId"
  JOIN "Part" p ON p."id" = u."partId"
  JOIN "Course" c ON c."id" = p."courseId"
  WHERE t."id" = "Lesson"."topicId"
)
WHERE "Lesson"."topicId" IS NOT NULL
  AND "Lesson"."unitId" IS NULL;
