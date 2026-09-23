-- ===========================================================================
-- Multi-Level Expansion — Phase K3: final academic-level constraints
-- (SQLite edition).
--
-- WHAT THIS DOES (the durable DB twin of the K2 runtime rules)
--   1. Course.academicLevel   -> NOT NULL
--   2. Student.academicLevel  -> NOT NULL
--   3. Lesson.academicLevel   -> NOT NULL
--   4. Lesson: the GLOBAL unique index "Lesson_officialCode_key" is REMOVED
--      and replaced by the LEVEL-SCOPED unique
--      "Lesson_academicLevel_officialCode_key" ON ("academicLevel","officialCode")
--      (FIRST_SECONDARY and SECOND_SECONDARY may both hold "1-1", one level
--      may hold "1-1" only once, codes are never prefixed or rewritten).
--   5. MockExam.courseId      -> NOT NULL, FK -> Course ON DELETE RESTRICT
--      (was SET NULL: a course-less exam is no longer a representable state,
--      so detaching on course delete cannot exist, the admin route already
--      refuses to delete a course that still owns mock exams), plus the
--      supporting index "MockExam_courseId_idx".
--
-- PRE-FLIGHT PROOFS (fail loudly, never rewrite)
--   SQLite has no procedural RAISE outside triggers, so the proofs are ONE
--   INSERT into a throw-away guard table whose named CHECK constraints each
--   demand a zero count. If any offending rows exist the INSERT aborts with
--   "CHECK constraint failed: K3_G<n>_<proof>" BEFORE any rebuild starts
--   (the guard section is the first thing in the file). Nothing is UPDATEd,
--   DELETEd or guessed: an operator must repair the data explicitly (Phase
--   K2's admin level-mismatch diagnostic lists the offending rows) and re-run
--   the deploy.
--     G1  no Course   with NULL academicLevel
--     G2  no Student  with NULL academicLevel
--     G3  no Lesson   with NULL academicLevel
--     G4  no Lesson whose stored academicLevel differs from its chain-derived
--         Course level (canonical Lesson→Unit→Part→Course, legacy
--         Lesson→Topic→Unit→Part→Course, canonical wins when both exist)
--     G5  no grouped Student whose academicLevel differs from
--         Group.course.academicLevel (invariant I1)
--     G6  no MockExam with NULL courseId (K3 assigns NOTHING automatically:
--         the only legitimate ways in are the K2 admin binding PATCH or a
--         deterministic operator backfill done BEFORE this migration)
--     G7  no (academicLevel, officialCode) duplicate among lessons with a code
--         (the new unique must be satisfiable before it is created)
--
-- SQLITE TABLE REBUILDS
--   SQLite cannot ALTER nullability or replace a UNIQUE index in place, so
--   Course, Student, Lesson and MockExam are rebuilt with the Prisma
--   "RedefineTables" pattern (new_X <- X, then DROP X, then RENAME). Each rebuild
--   preserves EVERY column (same names, types, defaults, primary key), every
--   foreign key (same targets and ON DELETE/ON UPDATE actions, except the ONE
--   intentional MockExam change above), every secondary index (re-created
--   under its canonical name) and every row/ID (INSERT ... SELECT of the full
--   column list). Foreign keys referencing the rebuilt tables from OTHER
--   tables survive the rename (PRAGMA foreign_keys=OFF during the rebuild,
--   legacy_alter_table stays OFF so child FKs are not rewritten to new_X).
--
-- DATA SAFETY
--   * No UPDATE, no DELETE, no TRUNCATE of application rows. The only
--     DROP TABLE statements are the rebuild's own (old copy after full copy,
--     plus the empty guard table).
--   * IDs, progression rows, payments, parent links, quiz attempts,
--     homework submissions, SessionVideo rows, Phase H overrides and
--     notification records are untouched (proved by the K3 verifier's
--     byte-identical preservation snapshot).
--   * No First Secondary curriculum rows are created (Phase L).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Pre-flight proofs — one row into a throw-away guard table whose named
--    CHECK constraints each demand a ZERO count. The first violated proof
--    aborts the migration with "CHECK constraint failed: K3_G<n>_<proof>".
--    On success the table never holds a row and is dropped immediately.
-- ---------------------------------------------------------------------------
CREATE TABLE "_k3_guard" (
  "g1" INTEGER NOT NULL CONSTRAINT "K3_G1_course_academicLevel_null" CHECK ("g1" = 0),
  "g2" INTEGER NOT NULL CONSTRAINT "K3_G2_student_academicLevel_null" CHECK ("g2" = 0),
  "g3" INTEGER NOT NULL CONSTRAINT "K3_G3_lesson_academicLevel_null" CHECK ("g3" = 0),
  "g4" INTEGER NOT NULL CONSTRAINT "K3_G4_lesson_level_chain_mismatch" CHECK ("g4" = 0),
  "g5" INTEGER NOT NULL CONSTRAINT "K3_G5_grouped_student_level_mismatch" CHECK ("g5" = 0),
  "g6" INTEGER NOT NULL CONSTRAINT "K3_G6_mockexam_courseId_null" CHECK ("g6" = 0),
  "g7" INTEGER NOT NULL CONSTRAINT "K3_G7_lesson_level_code_duplicate" CHECK ("g7" = 0)
);

INSERT INTO "_k3_guard" ("g1", "g2", "g3", "g4", "g5", "g6", "g7") VALUES (
  -- G1 — Course.academicLevel NULL rows
  (SELECT COUNT(*) FROM "Course" WHERE "academicLevel" IS NULL),
  -- G2 — Student.academicLevel NULL rows
  (SELECT COUNT(*) FROM "Student" WHERE "academicLevel" IS NULL),
  -- G3 — Lesson.academicLevel NULL rows (includes chain orphans left NULL by K1)
  (SELECT COUNT(*) FROM "Lesson" WHERE "academicLevel" IS NULL),
  -- G4 — Lesson.academicLevel must equal the chain-derived Course level
  --      (canonical Unit chain wins; legacy Topic chain otherwise)
  (SELECT COUNT(*) FROM "Lesson" l
    WHERE l."academicLevel" IS NOT (
      COALESCE(
        (SELECT c."academicLevel" FROM "Unit" u
           JOIN "Part" p ON p."id" = u."partId"
           JOIN "Course" c ON c."id" = p."courseId"
          WHERE u."id" = l."unitId"),
        (SELECT c."academicLevel" FROM "Topic" t
           JOIN "Unit" u ON u."id" = t."unitId"
           JOIN "Part" p ON p."id" = u."partId"
           JOIN "Course" c ON c."id" = p."courseId"
          WHERE t."id" = l."topicId")
      )
    )),
  -- G5 — grouped Student level == Group.course level (invariant I1)
  (SELECT COUNT(*) FROM "Student" s
     JOIN "Group" g ON g."id" = s."groupId"
     JOIN "Course" c ON c."id" = g."courseId"
    WHERE s."academicLevel" IS NOT c."academicLevel"),
  -- G6 — MockExam.courseId NULL rows (no automatic assignment, ever)
  (SELECT COUNT(*) FROM "MockExam" WHERE "courseId" IS NULL),
  -- G7 — the composite unique must already hold
  (SELECT COUNT(*) FROM (
     SELECT "academicLevel", "officialCode"
     FROM "Lesson"
     WHERE "officialCode" IS NOT NULL
     GROUP BY "academicLevel", "officialCode"
     HAVING COUNT(*) > 1
   ))
);

DROP TABLE "_k3_guard";

-- ---------------------------------------------------------------------------
-- 1. Table rebuilds (Prisma RedefineTables pattern)
-- ---------------------------------------------------------------------------
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;

-- 1a. Course — academicLevel NOT NULL. Every other column, default, the
--     UNIQUE(slug) and the trackId index are carried over verbatim. (The
--     historical table declares no FK to Track on this provider, none is
--     added — K3 tightens only what it owns.)
CREATE TABLE "new_Course" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "slug" TEXT NOT NULL,
  "academicLevel" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "iconUrl" TEXT,
  "color" TEXT NOT NULL DEFAULT '#10b981',
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "trackId" TEXT
);
INSERT INTO "new_Course" ("id", "slug", "academicLevel", "name", "nameAr", "description", "iconUrl", "color", "createdAt", "updatedAt", "trackId")
SELECT "id", "slug", "academicLevel", "name", "nameAr", "description", "iconUrl", "color", "createdAt", "updatedAt", "trackId" FROM "Course";
DROP TABLE "Course";
ALTER TABLE "new_Course" RENAME TO "Course";
CREATE UNIQUE INDEX "Course_slug_key" ON "Course"("slug");
CREATE INDEX "Course_trackId_idx" ON "Course"("trackId");

-- 1b. Student — academicLevel NOT NULL. Every column, default, the
--     UNIQUE(userId/nationalId/studentCode) keys and the three indexes are
--     carried over verbatim. (The historical table declares no FKs on this
--     provider, none is added.)
CREATE TABLE "new_Student" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "userId" TEXT NOT NULL,
  "grade" TEXT NOT NULL DEFAULT '2nd Secondary',
  "schoolName" TEXT,
  "schoolType" TEXT,
  "nationalId" TEXT,
  "parentPhone" TEXT,
  "studentCode" TEXT,
  "academicLevel" TEXT NOT NULL,
  "groupId" TEXT,
  "batchId" TEXT,
  "enrolledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Student" ("id", "userId", "grade", "schoolName", "schoolType", "nationalId", "parentPhone", "studentCode", "academicLevel", "groupId", "batchId", "enrolledAt", "createdAt", "updatedAt")
SELECT "id", "userId", "grade", "schoolName", "schoolType", "nationalId", "parentPhone", "studentCode", "academicLevel", "groupId", "batchId", "enrolledAt", "createdAt", "updatedAt" FROM "Student";
DROP TABLE "Student";
ALTER TABLE "new_Student" RENAME TO "Student";
CREATE UNIQUE INDEX "Student_userId_key" ON "Student"("userId");
CREATE UNIQUE INDEX "Student_nationalId_key" ON "Student"("nationalId");
CREATE UNIQUE INDEX "Student_studentCode_key" ON "Student"("studentCode");
CREATE INDEX "Student_schoolType_idx" ON "Student"("schoolType");
CREATE INDEX "Student_groupId_idx" ON "Student"("groupId");
CREATE INDEX "Student_batchId_idx" ON "Student"("batchId");

-- 1c. Lesson — academicLevel NOT NULL, the global officialCode unique is NOT
--     re-created, the level-scoped composite unique replaces it. Both FKs
--     (Topic / Unit, SET NULL) and the three secondary indexes are carried
--     over verbatim.
CREATE TABLE "new_Lesson" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "topicId" TEXT,
  "unitId" TEXT,
  "officialCode" TEXT,
  "academicLevel" TEXT NOT NULL,
  "curriculumStatus" TEXT NOT NULL DEFAULT 'LEGACY',
  "trackScope" TEXT NOT NULL DEFAULT 'SHARED',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
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
INSERT INTO "new_Lesson" ("id", "topicId", "unitId", "officialCode", "academicLevel", "curriculumStatus", "trackScope", "status", "title", "titleAr", "order", "description", "summary", "duration", "isLocked", "isPublished", "videoUrl", "pdfUrl", "createdAt", "updatedAt")
SELECT "id", "topicId", "unitId", "officialCode", "academicLevel", "curriculumStatus", "trackScope", "status", "title", "titleAr", "order", "description", "summary", "duration", "isLocked", "isPublished", "videoUrl", "pdfUrl", "createdAt", "updatedAt" FROM "Lesson";
DROP TABLE "Lesson";
ALTER TABLE "new_Lesson" RENAME TO "Lesson";
CREATE UNIQUE INDEX "Lesson_academicLevel_officialCode_key" ON "Lesson"("academicLevel", "officialCode");
CREATE INDEX "Lesson_topicId_idx" ON "Lesson"("topicId");
CREATE INDEX "Lesson_unitId_order_idx" ON "Lesson"("unitId", "order");
CREATE INDEX "Lesson_status_idx" ON "Lesson"("status");

-- 1d. MockExam — courseId NOT NULL, FK ON DELETE RESTRICT (intentional
--     change from SET NULL, see header), new courseId index. Every other
--     column/default and the schoolType+isPublished index are carried over.
CREATE TABLE "new_MockExam" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "description" TEXT,
  "schoolType" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "questionCount" INTEGER NOT NULL DEFAULT 10,
  "durationMin" INTEGER NOT NULL DEFAULT 30,
  "passMark" INTEGER NOT NULL DEFAULT 60,
  "difficulty" TEXT NOT NULL DEFAULT 'MIXED',
  "selectionMode" TEXT NOT NULL DEFAULT 'RANDOM',
  "isPublished" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MockExam_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_MockExam" ("id", "title", "titleAr", "description", "schoolType", "courseId", "questionCount", "durationMin", "passMark", "difficulty", "selectionMode", "isPublished", "createdAt", "updatedAt")
SELECT "id", "title", "titleAr", "description", "schoolType", "courseId", "questionCount", "durationMin", "passMark", "difficulty", "selectionMode", "isPublished", "createdAt", "updatedAt" FROM "MockExam";
DROP TABLE "MockExam";
ALTER TABLE "new_MockExam" RENAME TO "MockExam";
CREATE INDEX "MockExam_schoolType_isPublished_idx" ON "MockExam"("schoolType", "isPublished");
CREATE INDEX "MockExam_courseId_idx" ON "MockExam"("courseId");

PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
