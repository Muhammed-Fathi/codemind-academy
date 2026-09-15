-- CodeMind Academy — Migration: Phase 26D Lesson Quiz attempt architecture
-- Date: 2026-09-15
-- Tables touched: QuizRetryGrant (NEW), Quiz, QuizAttempt, QuizAnswer
--
-- THIS IS THE POSTGRESQL EDITION of the Phase 26D migration.
-- prisma/schema.prisma (SQLite) has its own edition in prisma/migrations/
-- with the same timestamp and the same end state. The two providers keep
-- SEPARATE migration histories:
--     SQLite      prisma/migrations                      (this file is NOT there)
--     PostgreSQL  prisma/postgres/migrations             (this file)
-- because Prisma reads the migrations directory NEXT TO the schema file,
-- and one SQL dialect cannot express both (SQLite has no TIMESTAMPTZ,
-- PostgreSQL has no DATETIME — the exact mismatch that failed the first
-- production deploy of this phase with `type "datetime" does not exist`).
--
-- WHAT THIS DOES (identical to the SQLite edition)
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
-- SAFETY (identical guarantees to the SQLite edition)
--   * ADDITIVE ONLY. Every change is `ADD COLUMN`, `CREATE TABLE`,
--     `CREATE INDEX` or `ADD CONSTRAINT`. There is no DROP, no DELETE, no
--     TRUNCATE, no table rebuild, no reset, and no data rewrite beyond the
--     two documented backfills below.
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
--   * PostgreSQL adds NOT NULL columns with constant defaults and nullable
--     columns without a table rewrite — no `INSERT … SELECT` copy, no
--     deferred-FK window, no cascade risk.
--
-- CONVERGENCE CONTRACT
--   The end state of 0_init + this file is EXACTLY the schema generated from
--   prisma/schema.prisma by scripts/db/pg-lib.mjs (scripts/db/postgres-
--   baseline.sql). Constraint and index NAMES match that generator's output
--   (`*_pkey`, `*_fkey`, `*_key`, `*_idx`) so `prisma migrate status` on the
--   production PostgreSQL schema never reports drift. This is enforced by
--   tests/migration-providers.test.js against a real PostgreSQL.

-- ---------------------------------------------------------------------------
-- 1. QuizRetryGrant. Created FIRST: QuizAttempt.retryGrantId references it.
--    TIMESTAMPTZ(3) is what prisma/schema.prisma's DateTime maps to on
--    PostgreSQL (see pg-lib emitPostgresDdl) — DATETIME does not exist here.
-- ---------------------------------------------------------------------------
CREATE TABLE "QuizRetryGrant" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "quizId" TEXT NOT NULL,
    "grantedByUserId" TEXT NOT NULL,
    "grantedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "consumedAt" TIMESTAMPTZ(3),
    "reason" TEXT,
    CONSTRAINT "QuizRetryGrant_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "QuizRetryGrant_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "QuizRetryGrant_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
    CONSTRAINT "QuizRetryGrant_grantedByUserId_fkey" FOREIGN KEY ("grantedByUserId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE CASCADE
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
ALTER TABLE "Quiz" ADD COLUMN "shuffleOptions" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "Quiz" ADD COLUMN "difficultyPlan" TEXT;

-- ---------------------------------------------------------------------------
-- 3. QuizAttempt — sequence, state, lineage.
--    The FK is added as a SEPARATE named constraint: PostgreSQL's ADD COLUMN
--    accepts inline REFERENCES, but only the separate ADD CONSTRAINT lets the
--    constraint carry the canonical name the baseline generator emits
--    ("QuizAttempt_retryGrantId_fkey"), keeping `migrate status` drift-free.
--    The referential action matches the SQLite edition: ON DELETE SET NULL —
--    deleting a grant row can never delete attempt history.
-- ---------------------------------------------------------------------------
ALTER TABLE "QuizAttempt" ADD COLUMN "attemptNumber" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "QuizAttempt" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'OPEN';
ALTER TABLE "QuizAttempt" ADD COLUMN "retryGrantId" TEXT;

ALTER TABLE "QuizAttempt"
  ADD CONSTRAINT "QuizAttempt_retryGrantId_fkey"
  FOREIGN KEY ("retryGrantId") REFERENCES "QuizRetryGrant"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- BACKFILL 1/2 — attempt sequence.
--
-- Every pre-26D attempt arrived with the column default of 1, which is correct
-- only for a student's FIRST attempt on a quiz. Retakes (which the old
-- unlimited-retake flow happily created) must be renumbered 2, 3, … or the
-- UNIQUE constraint created below would reject the migration outright.
--
-- The ordering is `startedAt ASC`, tie-broken by `id ASC` so the numbering is
-- total and deterministic: re-running the statement produces the same numbers.
-- It is a pure renumbering — no row is created, updated in any other column,
-- or removed, and no score changes. The subquery references only startedAt/id
-- (never the column being written), so the result is identical on every
-- engine regardless of statement-snapshot visibility rules.
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
-- entitlement ceiling is enforced in the API, but this unique constraint is
-- what makes a duplicate attempt NUMBER impossible even under a race. Safe to
-- create only because BACKFILL 1/2 above made the numbers distinct. A table
-- constraint (not a bare unique index) so its name is exactly the one the
-- schema generator emits and Prisma expects for @@unique.
ALTER TABLE "QuizAttempt"
  ADD CONSTRAINT "QuizAttempt_quizId_studentId_attemptNumber_key"
  UNIQUE ("quizId", "studentId", "attemptNumber");

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
