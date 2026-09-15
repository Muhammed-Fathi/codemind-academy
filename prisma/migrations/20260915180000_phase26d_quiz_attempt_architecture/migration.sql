-- CodeMind Academy — Migration: Phase 26D Lesson Quiz attempt architecture
-- Date: 2026-09-15
-- Tables touched: QuizRetryGrant (NEW), Quiz, QuizAttempt, QuizAnswer
--
-- WHAT THIS DOES
--   Makes the Lesson Quiz an assessment with a server-owned attempt lifecycle:
--
--     1. `QuizRetryGrant` — the ONLY way a student may hold more than one
--        attempt. Admin-issued, single-use, attributed, auditable.
--     2. `Quiz` blueprint columns — a Lesson Quiz becomes a SELECTION RULE
--        (mode / count / difficulty plan / shuffle) instead of always serving
--        its whole fixed question list to everyone.
--     3. `QuizAttempt.attemptNumber` + `status` + `retryGrantId` — an explicit
--        sequence, an explicit state, and retry lineage.
--     4. `QuizAnswer` snapshot columns — the frozen wording, options, answer
--        key, marks, difficulty and track tag of each question AT ATTEMPT
--        START, so a later Question Bank edit can never rewrite a result.
--
-- WHY A SCHEMA CHANGE WAS UNAVOIDABLE
--   Discovery (docs/PHASE_26D_TEACHER_FULL_FLOW_QA.md §3) found that the
--   existing models cannot express any of the four. `QuizAnswer` pinned only
--   `questionId`/`selected`/`isCorrect` and every other field was read from the
--   LIVE `Question` row at serve time and at grading time — so requirement 2C
--   ("bank edits must NOT rewrite historical attempts") was structurally
--   impossible, not merely unimplemented. Likewise there was no place to record
--   an attempt sequence, no place to record a granted retry, and no place to
--   record a selection rule.
--
-- SAFETY
--   * ADDITIVE ONLY. Every change is `ADD COLUMN` or `CREATE TABLE`/`CREATE
--     INDEX`. There is no DROP, no DELETE, no TRUNCATE, no table rebuild, no
--     reset, and no data rewrite beyond the two documented backfills below.
--   * Every new column on an EXISTING table either carries a constant DEFAULT
--     (so old rows get a meaningful value with no invention) or is NULLABLE
--     (so old rows keep behaving exactly as they did before).
--   * All ten `QuizAnswer` snapshot columns are NULLABLE ON PURPOSE: NULL means
--     "this attempt predates the snapshot", and the reader falls back to the
--     live `Question` row — i.e. precisely the pre-26D behaviour, for precisely
--     the rows that always relied on it. NO historical attempt is backfilled,
--     regraded, or reinterpreted.
--   * `Quiz.maxAttempts` DEFAULT 1 is the one intentional behaviour change: the
--     unlimited student retake it replaces is a launch blocker (Phase 26D §35).
--     It changes no stored row.
--   * Old `QuizAttempt` rows stay fully readable: `finishedAt` remains the
--     historical source of truth and `status` is backfilled from it, so nothing
--     that read `finishedAt` changes meaning.
--   * SQLite allows adding a column with a constant default, and adding a
--     nullable column, WITHOUT a table rebuild — so no `INSERT ... SELECT`
--     copy, no deferred-foreign-key window, no cascade risk.
--   * Per docs/POSTGRES_CUTOVER_RUNBOOK.md, PostgreSQL is baselined from
--     `scripts/db/postgres-baseline.sql` (regenerated from the CURRENT schema,
--     which already carries every object below) and old SQLite migrations are
--     never replayed there. This file therefore only ever runs on SQLite; it is
--     nevertheless written in plain ANSI so the shapes converge.

-- ---------------------------------------------------------------------------
-- 1. QuizRetryGrant — created FIRST, because QuizAttempt.retryGrantId below
--    references it and SQLite requires the parent table to exist.
-- ---------------------------------------------------------------------------
CREATE TABLE "QuizRetryGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" DATETIME,
    "reason" TEXT,
    CONSTRAINT "QuizRetryGrant_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuizRetryGrant_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "QuizRetryGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX "QuizRetryGrant_studentId_quizId_idx"
  ON "QuizRetryGrant"("studentId", "quizId");
CREATE INDEX "QuizRetryGrant_quizId_idx"
  ON "QuizRetryGrant"("quizId");
CREATE INDEX "QuizRetryGrant_grantedByUserId_idx"
  ON "QuizRetryGrant"("grantedByUserId");

-- ---------------------------------------------------------------------------
-- 2. Quiz — the blueprint. A pre-26D row reads FIXED / NULL / 1 / false / NULL,
--    which is exactly the behaviour it had before (see resolveQuizBlueprint).
-- ---------------------------------------------------------------------------
ALTER TABLE "Quiz" ADD COLUMN "quizMode" TEXT NOT NULL DEFAULT 'FIXED';
ALTER TABLE "Quiz" ADD COLUMN "questionCount" INTEGER;
ALTER TABLE "Quiz" ADD COLUMN "maxAttempts" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "Quiz" ADD COLUMN "shuffleOptions" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Quiz" ADD COLUMN "difficultyPlan" TEXT;

-- ---------------------------------------------------------------------------
-- 3. QuizAttempt — sequence, state, lineage.
-- ---------------------------------------------------------------------------
ALTER TABLE "QuizAttempt" ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "QuizAttempt" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN';
-- Inline (unnamed) REFERENCES: SQLite's `ALTER TABLE … ADD COLUMN` accepts a
-- column-level REFERENCES clause but NOT a table-level `CONSTRAINT … FOREIGN
-- KEY` clause, and the alternative — Prisma's usual create-new-table /
-- INSERT…SELECT / DROP / RENAME rebuild of "QuizAttempt" — is exactly the
-- destructive rewrite this phase forbids on a table holding real results. The
-- referential action is therefore identical (SET NULL on grant delete) and only
-- the constraint's NAME differs from what `prisma migrate diff` would emit.
-- PostgreSQL is baselined from scripts/db/postgres-baseline.sql, which carries
-- the properly named constraint, so the two shapes still converge.
ALTER TABLE "QuizAttempt" ADD COLUMN "retryGrantId" TEXT
  REFERENCES "QuizRetryGrant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- BACKFILL 1/2 — attempt sequence.
--
-- Every pre-26D attempt arrived with the column default of 1, which is correct
-- only for a student's FIRST attempt on a quiz. Retakes (which the old
-- unlimited-retake flow happily created) must be renumbered 2, 3, … or the
-- UNIQUE index created below would reject the migration outright.
--
-- The ordering is `startedAt ASC`, tie-broken by `id ASC` so the numbering is
-- total and deterministic: re-running the statement produces the same numbers.
-- It is a pure renumbering — no row is created, updated in any other column,
-- or removed, and no score changes.
UPDATE "QuizAttempt"
SET "attemptNumber" = (
  SELECT COUNT(*) + 1
  FROM "QuizAttempt" AS "earlier"
  WHERE "earlier"."quizId" = "QuizAttempt"."quizId"
    AND "earlier"."studentId" = "QuizAttempt"."studentId"
    AND (
      "earlier"."startedAt" < "QuizAttempt"."startedAt"
      OR ("earlier"."startedAt" = "QuizAttempt"."startedAt"
          AND "earlier"."id" < "QuizAttempt"."id")
    )
);

-- BACKFILL 2/2 — attempt state, derived from the pre-existing truth.
--
-- `finishedAt IS NULL` was, and remains, the definition of an unfinished
-- attempt. `status` is a projection of it so the state is queryable and so the
-- one state `finishedAt` alone cannot express (EXPIRED, set by the Phase 18
-- timeout path from now on) has somewhere to live. Nothing here reinterprets a
-- historical result.
UPDATE "QuizAttempt"
SET "status" = CASE WHEN "finishedAt" IS NULL THEN 'OPEN' ELSE 'SUBMITTED' END;

-- The structural half of "one attempt per student per quiz by default": the
-- entitlement ceiling is enforced in the API, but this index is what makes a
-- duplicate attempt NUMBER impossible even under a race. Safe to create only
-- because BACKFILL 1/2 above made the numbers distinct.
CREATE UNIQUE INDEX "QuizAttempt_quizId_studentId_attemptNumber_key"
  ON "QuizAttempt"("quizId", "studentId", "attemptNumber");

-- ---------------------------------------------------------------------------
-- 4. QuizAnswer — the frozen question snapshot (all NULLABLE, see SAFETY).
-- ---------------------------------------------------------------------------
ALTER TABLE "QuizAnswer" ADD COLUMN "orderIndex" INTEGER;
ALTER TABLE "QuizAnswer" ADD COLUMN "questionType" TEXT;
ALTER TABLE "QuizAnswer" ADD COLUMN "promptSnapshot" TEXT;
ALTER TABLE "QuizAnswer" ADD COLUMN "promptArSnapshot" TEXT;
ALTER TABLE "QuizAnswer" ADD COLUMN "optionsSnapshot" TEXT;
ALTER TABLE "QuizAnswer" ADD COLUMN "answerSnapshot" TEXT;
ALTER TABLE "QuizAnswer" ADD COLUMN "explanationSnapshot" TEXT;
ALTER TABLE "QuizAnswer" ADD COLUMN "difficultySnapshot" TEXT;
ALTER TABLE "QuizAnswer" ADD COLUMN "marksSnapshot" INTEGER;
ALTER TABLE "QuizAnswer" ADD COLUMN "schoolTypeSnapshot" TEXT;
