-- ===========================================================================
-- Multi-Level Expansion — Phase K3: final academic-level constraints
-- (PostgreSQL edition).
--
-- This is the PostgreSQL twin of the SQLite migration of the same name. The
-- two files are NOT copies: PostgreSQL can ALTER nullability and swap a
-- constraint in place, so there is no table rebuild here — only guarded,
-- canonical-named ALTER TABLE statements. The pre-flight proofs are the same
-- seven proofs in both editions.
--
-- WHAT THIS DOES (the durable DB twin of the K2 runtime rules)
--   1. Course.academicLevel   -> SET NOT NULL
--   2. Student.academicLevel  -> SET NOT NULL
--   3. Lesson.academicLevel   -> SET NOT NULL
--   4. Lesson: DROP the GLOBAL unique "Lesson_officialCode_key" and ADD the
--      LEVEL-SCOPED unique "Lesson_academicLevel_officialCode_key"
--      UNIQUE ("academicLevel", "officialCode")
--      (FIRST_SECONDARY and SECOND_SECONDARY may both hold "1-1", one level
--      may hold "1-1" only once, codes are never prefixed or rewritten)
--   5. MockExam.courseId      -> SET NOT NULL, and the FK "MockExam_courseId_fkey"
--      is re-created ON DELETE RESTRICT (was SET NULL: a course-less exam is
--      no longer a representable state, so detaching on course delete cannot
--      exist, and the admin route already refuses to delete a course that
--      still owns mock exams), plus the supporting index "MockExam_courseId_idx"
--
-- PRE-FLIGHT PROOFS (fail loudly, never rewrite)
--   No procedural DO block (keeps the file safe for every statement splitter,
--   native and driver-adapter alike). The proofs are ONE INSERT into a
--   throw-away guard table whose named CHECK constraints each demand a zero
--   count. If any offending rows exist the INSERT aborts with
--   'new row for relation "_k3_guard" violates check constraint
--   "K3_G<n>_<proof>"' and, because prisma migrate deploy runs the file as one
--   transaction, nothing else is applied. Nothing is UPDATEd, DELETEd or
--   guessed: an operator must repair the data explicitly (the Phase K2 admin
--   level-mismatch diagnostic lists the offending rows) and re-run.
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
-- CONSTRAINT NAMES
--   Canonical Prisma names throughout (the repository baseline is emitted
--   with these exact names by scripts/db/pg-lib.mjs, and the trusted PG17
--   catalog reference asserts them by name). The old unique is dropped by
--   its canonical name in BOTH physical forms it can legitimately take — a
--   table constraint (the 0_init baseline form) or a bare unique index (the
--   prisma db push form). Nothing else is dropped.
--
-- DATA SAFETY
--   No UPDATE, no DELETE, no TRUNCATE. The only DROP TABLE is the empty
--   guard table. IDs, progression rows, payments, parent links, quiz
--   attempts, homework submissions, SessionVideo rows, Phase H overrides and
--   notification records are untouched. No First Secondary curriculum rows
--   are created (Phase L).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 0. Pre-flight proofs
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
  --      (canonical Unit chain wins, legacy Topic chain otherwise)
  (SELECT COUNT(*) FROM "Lesson" l
    WHERE l."academicLevel" IS DISTINCT FROM (
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
    WHERE s."academicLevel" IS DISTINCT FROM c."academicLevel"),
  -- G6 — MockExam.courseId NULL rows (no automatic assignment, ever)
  (SELECT COUNT(*) FROM "MockExam" WHERE "courseId" IS NULL),
  -- G7 — the composite unique must already hold
  (SELECT COUNT(*) FROM (
     SELECT "academicLevel", "officialCode"
     FROM "Lesson"
     WHERE "officialCode" IS NOT NULL
     GROUP BY "academicLevel", "officialCode"
     HAVING COUNT(*) > 1
   ) dup)
);

DROP TABLE "_k3_guard";

-- ---------------------------------------------------------------------------
-- 1. Required-ness (proved NULL-free above)
-- ---------------------------------------------------------------------------
ALTER TABLE "Course" ALTER COLUMN "academicLevel" SET NOT NULL;
ALTER TABLE "Student" ALTER COLUMN "academicLevel" SET NOT NULL;
ALTER TABLE "Lesson" ALTER COLUMN "academicLevel" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Lesson official code: global unique -> level-scoped unique
-- ---------------------------------------------------------------------------
ALTER TABLE "Lesson" DROP CONSTRAINT IF EXISTS "Lesson_officialCode_key";
DROP INDEX IF EXISTS "Lesson_officialCode_key";
ALTER TABLE "Lesson" ADD CONSTRAINT "Lesson_academicLevel_officialCode_key" UNIQUE ("academicLevel", "officialCode");

-- ---------------------------------------------------------------------------
-- 3. MockExam owning course: required, RESTRICT on course delete, indexed
-- ---------------------------------------------------------------------------
ALTER TABLE "MockExam" ALTER COLUMN "courseId" SET NOT NULL;
ALTER TABLE "MockExam" DROP CONSTRAINT "MockExam_courseId_fkey";
ALTER TABLE "MockExam" ADD CONSTRAINT "MockExam_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON UPDATE CASCADE ON DELETE RESTRICT;
CREATE INDEX "MockExam_courseId_idx" ON "MockExam" ("courseId");
