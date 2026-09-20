-- ===========================================================================
-- Phase H — Canonical progression & access authority (SQLite edition).
--
-- ADDITIVE ONLY. No table is rebuilt, no column is dropped, no row is
-- deleted, no default is backfilled destructively. The ONE new table is
-- created empty, so every pre-Phase-H row keeps its exact meaning and every
-- pre-Phase-H student keeps their exact progression.
--
-- WHY A NEW TABLE AT ALL (the Phase H audit)
-- ==========================================
-- Phase H consolidates Lesson LOCKED / UNLOCKED / COMPLETED onto one
-- server-authoritative engine (src/lib/progression-engine.ts). Almost all of
-- the state it needs was ALREADY represented:
--
--   * video completion       LessonProgress.videoPercent / videoCompleted
--                            (+ SessionVideoView.percent for batch recordings)
--   * quiz pass              QuizAttempt.passed (Phase 26D / Phase G grading)
--   * homework completion    HomeworkSubmission.submittedAt (Phase G)
--   * absence hold           AbsenceHold (Phase F output, never enforced there)
--   * track eligibility      Student.schoolType + Lesson.trackScope (Phase 12)
--
-- The single thing with NO authoritative home was the ADMIN EXCEPTION: an
-- unlock a human grants on purpose, with a mandatory reason, an actor, an
-- instant and an optional expiry. Phase H must not fabricate academic facts
-- (no fake quiz pass, no fake submission, no rewritten attendance), and it
-- must not destroy an AbsenceHold — so the exception cannot be stored as a
-- mutation of any of the tables above. `ProgressionOverride` is the smallest
-- additive model that can hold it.
--
-- PROVIDER ASYMMETRY (documented, not hidden — the same rule as the Phase F
-- `LiveSession.substituteTeacherId` and Phase G `Homework.attachmentId`
-- precedents): the PostgreSQL edition attaches the two FOREIGN KEY
-- constraints; SQLite can only add a foreign key to an EXISTING table by
-- rebuilding it, and a brand-new table is created WITH its references here
-- (no rebuild of anything that already holds production rows).
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. ProgressionOverride — the Admin exception over a progression boundary.
-- ---------------------------------------------------------------------------
CREATE TABLE "ProgressionOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "courseId" TEXT,
    "lessonId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,
    CONSTRAINT "ProgressionOverride_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressionOverride_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 2. Indexes (Prisma-canonical names, so a later `migrate dev` drift check
--    sees no difference).
-- ---------------------------------------------------------------------------
CREATE INDEX "ProgressionOverride_studentId_lessonId_idx" ON "ProgressionOverride"("studentId", "lessonId");
CREATE INDEX "ProgressionOverride_studentId_revokedAt_idx" ON "ProgressionOverride"("studentId", "revokedAt");
CREATE INDEX "ProgressionOverride_lessonId_idx" ON "ProgressionOverride"("lessonId");
CREATE INDEX "ProgressionOverride_expiresAt_idx" ON "ProgressionOverride"("expiresAt");
