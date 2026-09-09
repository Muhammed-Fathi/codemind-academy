-- CodeMind Academy — Migration: Phase 12 Track Architecture
-- Date: 2026-09-09
-- Tables touched: Student (data-only normalisation), Lesson, Quiz, Homework
--
-- WHAT THIS DOES
--   1. Normalises the free-form `Student.schoolType` values into the two
--      canonical `SchoolType` enum values, BEFORE the column becomes an enum.
--   2. Adds `trackScope` (TrackScope, NOT NULL, DEFAULT 'SHARED') to Lesson,
--      Quiz and Homework — the content-eligibility dimension of the ONE shared
--      course.
--
-- SAFETY
--   * ADDITIVE for content: the three new columns are NOT NULL with a DEFAULT,
--     so every existing row is preserved and receives the default. Prisma's
--     SQLite table rebuild copies every pre-existing column verbatim
--     (INSERT ... SELECT) and never deletes a row.
--   * `Lesson.officialCode` stays UNIQUE and the official curriculum stays
--     2 Parts / 7 Units / 23 lessons: trackScope is metadata, not a second
--     curriculum universe, so no duplicate official lesson row can appear.
--   * No DROP of data, no DELETE, no TRUNCATE, no migration reset.
--   * The DROP TABLE statements below are the second half of Prisma's own
--     documented SQLite column-addition procedure (create new table -> copy
--     rows -> drop old -> rename), emitted verbatim by
--     `prisma migrate diff`. Foreign keys are deferred for the duration, so
--     no ON DELETE CASCADE fires and no referencing row is lost.
--
-- WHY THE NORMALISATION RUNS FIRST
--   Prisma maps a SQLite enum to a plain TEXT column: there is no database
--   level CHECK constraint, and the constraint is enforced by the Prisma
--   client, which THROWS when it reads a value outside the enum. An
--   un-normalised legacy value would therefore become a read-time failure for
--   that student. Normalising first means the enum column can never contain a
--   value the client cannot represent.

-- ---------------------------------------------------------------------------
-- 1. Student.schoolType normalisation
-- ---------------------------------------------------------------------------
-- The mapping below is EXACTLY `normalizeSchoolType()` from
-- src/lib/school-type.ts (the single source of truth): case/whitespace
-- insensitive ASCII aliases plus the two Arabic labels. NULL is preserved as
-- NULL — "unspecified" is a real state (the admin students screen has an
-- UNSPECIFIED tab) and it fails CLOSED for track purposes.

UPDATE "Student" SET "schoolType" = 'ARABIC'
WHERE "schoolType" IS NOT NULL
  AND (
    UPPER(TRIM("schoolType")) IN ('ARABIC', 'AR')
    OR TRIM("schoolType") = 'عربي'
  );

UPDATE "Student" SET "schoolType" = 'LANGUAGE'
WHERE "schoolType" IS NOT NULL
  AND (
    UPPER(TRIM("schoolType")) IN ('LANGUAGE', 'LANGUAGES', 'LANG')
    OR TRIM("schoolType") = 'لغات'
  );

-- Anything still present is NOT a recognised school type. It is explicitly
-- handled, never silently guessed at: it becomes NULL ("unspecified"), which
-- is a supported state that restricts the student to SHARED content. No value
-- is ever mapped to a school type it does not denote.
UPDATE "Student" SET "schoolType" = NULL
WHERE "schoolType" IS NOT NULL
  AND "schoolType" NOT IN ('ARABIC', 'LANGUAGE');

-- ---------------------------------------------------------------------------
-- 2. trackScope on Lesson / Quiz / Homework (Prisma-generated table rebuilds)
-- ---------------------------------------------------------------------------

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Lesson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT,
    "unitId" TEXT,
    "officialCode" TEXT,
    "curriculumStatus" TEXT NOT NULL DEFAULT 'LEGACY',
    "trackScope" TEXT NOT NULL DEFAULT 'SHARED',
    "title" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "description" TEXT,
    "summary" TEXT,
    "duration" INTEGER NOT NULL DEFAULT 90,
    "isLocked" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "videoUrl" TEXT,
    "pdfUrl" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Lesson_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Lesson_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Lesson" ("createdAt", "curriculumStatus", "description", "duration", "id", "isLocked", "isPublished", "officialCode", "order", "pdfUrl", "summary", "title", "titleAr", "topicId", "unitId", "updatedAt", "videoUrl") SELECT "createdAt", "curriculumStatus", "description", "duration", "id", "isLocked", "isPublished", "officialCode", "order", "pdfUrl", "summary", "title", "titleAr", "topicId", "unitId", "updatedAt", "videoUrl" FROM "Lesson";
DROP TABLE "Lesson";
ALTER TABLE "new_Lesson" RENAME TO "Lesson";
CREATE UNIQUE INDEX "Lesson_officialCode_key" ON "Lesson"("officialCode");
CREATE INDEX "Lesson_topicId_idx" ON "Lesson"("topicId");
CREATE INDEX "Lesson_unitId_order_idx" ON "Lesson"("unitId", "order");
CREATE TABLE "new_Quiz" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lessonId" TEXT NOT NULL,
    "trackScope" TEXT NOT NULL DEFAULT 'SHARED',
    "title" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "description" TEXT,
    "passMark" INTEGER NOT NULL DEFAULT 60,
    "timeLimit" INTEGER,
    "order" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "Quiz_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Quiz" ("description", "id", "lessonId", "order", "passMark", "timeLimit", "title", "titleAr") SELECT "description", "id", "lessonId", "order", "passMark", "timeLimit", "title", "titleAr" FROM "Quiz";
DROP TABLE "Quiz";
ALTER TABLE "new_Quiz" RENAME TO "Quiz";
CREATE INDEX "Quiz_lessonId_idx" ON "Quiz"("lessonId");
CREATE TABLE "new_Homework" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lessonId" TEXT NOT NULL,
    "trackScope" TEXT NOT NULL DEFAULT 'SHARED',
    "title" TEXT NOT NULL,
    "titleAr" TEXT NOT NULL,
    "instructions" TEXT,
    "deadline" DATETIME NOT NULL,
    "maxMarks" INTEGER NOT NULL DEFAULT 10,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Homework_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Homework" ("createdAt", "deadline", "id", "instructions", "lessonId", "maxMarks", "title", "titleAr") SELECT "createdAt", "deadline", "id", "instructions", "lessonId", "maxMarks", "title", "titleAr" FROM "Homework";
DROP TABLE "Homework";
ALTER TABLE "new_Homework" RENAME TO "Homework";
CREATE INDEX "Homework_lessonId_idx" ON "Homework"("lessonId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- ---------------------------------------------------------------------------
-- 3. Post-migration invariant
-- ---------------------------------------------------------------------------
-- ASSERTED OUTSIDE THIS FILE (SQLite's RAISE() is only legal inside a
-- trigger program, so it cannot be used as a migration-level assertion):
--   0 rows with Student.schoolType NOT IN ('ARABIC','LANGUAGE') or NULL
--   23 official lessons, 2 Parts, 7 Units, officialCode 1-1..7-3 unique
--   every Lesson/Quiz/Homework row carries a trackScope
-- Enforced by tests/track-architecture-phase12.test.js and by the Phase 12
-- verification run recorded in docs/PHASE_12_TRACK_ARCHITECTURE.md.
