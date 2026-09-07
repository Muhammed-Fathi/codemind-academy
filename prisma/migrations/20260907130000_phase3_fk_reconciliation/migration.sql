-- ============================================================================
-- CodeMind Academy — Phase 3 CORRECTION: FK reconciliation for ALTER-added
-- relation columns (2026-09-07)
-- ============================================================================
--
-- WHY (see ADR-004):
--   The additive migrations added four relation columns with plain
--   `ALTER TABLE ... ADD COLUMN`, which is metadata-only and safe on existing
--   production data — but SQLite cannot add a FOREIGN KEY via ALTER TABLE.
--   prisma/schema.prisma nevertheless declares those relations
--   (Student.batch, ExamAttempt.mockExam, Course.track, Lesson.unit), so a
--   database built by replaying the migration history was missing the four
--   FK constraints that a `prisma db push` managed database has. That made
--   the migration history internally inconsistent (drift for `migrate dev`).
--
-- WHAT:
--   Adds the missing FK constraints using Prisma's canonical SQLite
--   table-redefinition pattern (copy → drop → rename → recreate indexes),
--   which fully preserves every row, value, default, index and FK.
--   * Student.batchId       → Batch(id)    ON DELETE SET NULL
--   * ExamAttempt.mockExamId→ MockExam(id) ON DELETE SET NULL
--   * Course.trackId        → Track(id)    ON DELETE SET NULL
--   * Lesson.unitId         → Unit(id)     ON DELETE SET NULL
--
-- DATA SAFETY:
--   * `INSERT INTO "new_..." SELECT ... FROM ...` copies every column/row
--     verbatim; no data is transformed, filtered or deleted.
--   * `PRAGMA foreign_key_check` runs before foreign keys are re-enabled; a
--     pre-existing orphaned row would fail the migration loudly instead of
--     corrupting data.
--   * On databases created by `prisma db push` (FKs already present) this is
--     an effective no-op: the tables are recreated with identical definitions.
--   * Take the standard file backup first (docs/DATABASE_MIGRATION.md §0).
--
-- Databases managed through `prisma migrate deploy` / `migrate dev` run this
-- exactly once. DO NOT hand-apply it before recording history — see
-- docs/DATABASE_MIGRATION.md §8.
-- ============================================================================

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- Student: add FK Student_batchId_fkey → Batch(id) ON DELETE SET NULL
CREATE TABLE "new_Student" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "grade" TEXT NOT NULL DEFAULT '2nd Secondary',
    "schoolName" TEXT,
    "schoolType" TEXT,
    "nationalId" TEXT,
    "parentPhone" TEXT,
    "studentCode" TEXT,
    "groupId" TEXT,
    "batchId" TEXT,
    "enrolledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Student_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Student_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Student_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Student" ("id", "userId", "grade", "schoolName", "schoolType", "nationalId", "parentPhone", "studentCode", "groupId", "batchId", "enrolledAt", "createdAt", "updatedAt")
    SELECT "id", "userId", "grade", "schoolName", "schoolType", "nationalId", "parentPhone", "studentCode", "groupId", "batchId", "enrolledAt", "createdAt", "updatedAt" FROM "Student";
DROP TABLE "Student";
ALTER TABLE "new_Student" RENAME TO "Student";
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");
CREATE UNIQUE INDEX "Student_studentCode_key" ON "Student"("studentCode");
CREATE UNIQUE INDEX "Student_nationalId_key" ON "Student"("nationalId");
CREATE INDEX "Student_schoolType_idx" ON "Student"("schoolType");
CREATE INDEX "Student_groupId_idx" ON "Student"("groupId");
CREATE INDEX "Student_batchId_idx" ON "Student"("batchId");

-- ExamAttempt: add FK ExamAttempt_mockExamId_fkey → MockExam(id) ON DELETE SET NULL
CREATE TABLE "new_ExamAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "mockExamId" TEXT,
    "schoolType" TEXT,
    "examType" TEXT NOT NULL DEFAULT 'MOCK',
    "questionCount" INTEGER NOT NULL,
    "durationMin" INTEGER NOT NULL,
    "score" INTEGER NOT NULL DEFAULT 0,
    "totalMarks" INTEGER NOT NULL DEFAULT 0,
    "percentage" INTEGER NOT NULL DEFAULT 0,
    "passed" BOOLEAN NOT NULL DEFAULT false,
    "answers" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "ExamAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ExamAttempt_mockExamId_fkey" FOREIGN KEY ("mockExamId") REFERENCES "MockExam" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_ExamAttempt" ("id", "studentId", "mockExamId", "schoolType", "examType", "questionCount", "durationMin", "score", "totalMarks", "percentage", "passed", "answers", "startedAt", "finishedAt")
    SELECT "id", "studentId", "mockExamId", "schoolType", "examType", "questionCount", "durationMin", "score", "totalMarks", "percentage", "passed", "answers", "startedAt", "finishedAt" FROM "ExamAttempt";
DROP TABLE "ExamAttempt";
ALTER TABLE "new_ExamAttempt" RENAME TO "ExamAttempt";
CREATE INDEX "ExamAttempt_studentId_examType_idx" ON "ExamAttempt"("studentId", "examType");
CREATE INDEX "ExamAttempt_finishedAt_idx" ON "ExamAttempt"("finishedAt");
CREATE INDEX "ExamAttempt_mockExamId_idx" ON "ExamAttempt"("mockExamId");

-- Course: add FK Course_trackId_fkey → Track(id) ON DELETE SET NULL
CREATE TABLE "new_Course" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameAr" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "iconUrl" TEXT,
    "color" TEXT NOT NULL DEFAULT '#10b981',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "trackId" TEXT,
    CONSTRAINT "Course_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Course" ("id", "slug", "name", "nameAr", "description", "iconUrl", "color", "createdAt", "updatedAt", "trackId")
    SELECT "id", "slug", "name", "nameAr", "description", "iconUrl", "color", "createdAt", "updatedAt", "trackId" FROM "Course";
DROP TABLE "Course";
ALTER TABLE "new_Course" RENAME TO "Course";
CREATE UNIQUE INDEX "Course_slug_key" ON "Course"("slug");
CREATE INDEX "Course_trackId_idx" ON "Course"("trackId");

-- Lesson: add FK Lesson_unitId_fkey → Unit(id) ON DELETE SET NULL
CREATE TABLE "new_Lesson" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "topicId" TEXT,
    "unitId" TEXT,
    "officialCode" TEXT,
    "curriculumStatus" TEXT NOT NULL DEFAULT 'LEGACY',
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
INSERT INTO "new_Lesson" ("id", "topicId", "unitId", "officialCode", "curriculumStatus", "title", "titleAr", "order", "description", "summary", "duration", "isLocked", "isPublished", "videoUrl", "pdfUrl", "createdAt", "updatedAt")
    SELECT "id", "topicId", "unitId", "officialCode", "curriculumStatus", "title", "titleAr", "order", "description", "summary", "duration", "isLocked", "isPublished", "videoUrl", "pdfUrl", "createdAt", "updatedAt" FROM "Lesson";
DROP TABLE "Lesson";
ALTER TABLE "new_Lesson" RENAME TO "Lesson";
CREATE INDEX "Lesson_topicId_idx" ON "Lesson"("topicId");
CREATE INDEX "Lesson_unitId_order_idx" ON "Lesson"("unitId", "order");
CREATE UNIQUE INDEX "Lesson_officialCode_key" ON "Lesson"("officialCode");

PRAGMA foreign_key_check;
PRAGMA foreign_keys=ON;
