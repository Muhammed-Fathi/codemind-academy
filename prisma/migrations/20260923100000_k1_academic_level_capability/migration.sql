-- ===========================================================================
-- Multi-Level Expansion — Phase K1: AcademicLevel capability + backfill
-- (SQLite edition).
--
-- WHAT THIS DOES
--   1. Adds `academicLevel` (AcademicLevel, nullable) to Course, Student and
--      Lesson. SQLite stores enums as TEXT, so there is no type to create;
--      the value space is documented here for the record:
--        FIRST_SECONDARY
--        SECOND_SECONDARY
--      and the PostgreSQL twin creates the matching native type.
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
--   * ADDITIVE: three nullable columns, no table rebuild, no default, no
--     constraint change. The global `Lesson.officialCode` unique stays in
--     place (the composite [academicLevel, officialCode] uniqueness is
--     Phase K3 work, not K1).
--   * DATA: only the three new columns are written. Every existing ID,
--     relation, official code, progress row, attempt, submission, attendance
--     row, absence case, parent link, notification, subscription, payment,
--     session, batch, group and media reference is untouched. No DELETE, no
--     TRUNCATE, no DROP.
--   * BEHAVIOUR: the columns are inert for the current application code —
--     K1 changes no runtime behaviour (no UI, no gate, no engine change).
-- ===========================================================================

-- 1. Capability (nullable; required-ness and the final uniqueness are K3).
ALTER TABLE "Course" ADD COLUMN "academicLevel" TEXT;
ALTER TABLE "Student" ADD COLUMN "academicLevel" TEXT;
ALTER TABLE "Lesson" ADD COLUMN "academicLevel" TEXT;

-- 2. Backfill — Courses first (the lessons derive from them), then Students.
UPDATE "Course" SET "academicLevel" = 'SECOND_SECONDARY';
UPDATE "Student" SET "academicLevel" = 'SECOND_SECONDARY';

-- 3. Lessons via the canonical chain (Lesson→Unit→Part→Course).
UPDATE "Lesson" SET "academicLevel" = (
  SELECT c."academicLevel"
  FROM "Unit" u
  JOIN "Part" p ON p."id" = u."partId"
  JOIN "Course" c ON c."id" = p."courseId"
  WHERE u."id" = "Lesson"."unitId"
)
WHERE "Lesson"."unitId" IS NOT NULL;

-- 4. Lessons via the legacy chain (Lesson→Topic→Unit→Part→Course), only for
--    lessons without a canonical unit link (the canonical chain wins).
--    Lessons with neither link stay NULL: orphans, reported by the K1 gate.
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
