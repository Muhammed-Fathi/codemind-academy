-- CodeMind Academy — Migration: Phase 5 question-bank / session-quiz hardening
-- Date: 2026-09-08
-- Tables touched: QuizAnswer ONLY (deduplicate + one unique index)
--
-- WHY (genuine Phase 5 requirement, not speculative):
--   Phase 5 persists the attempt's question set as QuizAnswer rows at the
--   moment the attempt is created (attempt immutability / refresh stability).
--   "One answer per (attempt, question)" therefore becomes a structural
--   invariant the database must guarantee, exactly like
--   HomeworkSubmission's @@unique([homeworkId, studentId]).
--
-- SAFETY:
--   * Step 1 removes only PROVABLY duplicate rows: extra rows of an
--     (attemptId, questionId) pair, keeping the most recently inserted one
--     (MAX(rowid)). In the historical flow (answers were deleteMany'd and
--     recreated in one transaction) duplicates could only ever come from an
--     interleaved concurrent submit — garbage rows. Nothing else is touched.
--   * Step 2 adds a unique index; every remaining row is distinct by
--     construction, so the index cannot fail on intact data.
--   * Contains NO DROP TABLE / DELETE of attempts / question data / user data.
-- Writable-CTE free, SQLite-safe dedup keeping the newest row per pair:
DELETE FROM QuizAnswer
WHERE rowid NOT IN (
  SELECT MAX(rowid) FROM QuizAnswer GROUP BY attemptId, questionId
);

-- Exactly what `prisma migrate diff` generates for
-- @@unique([attemptId, questionId]) + @@index([questionId]).
CREATE UNIQUE INDEX "QuizAnswer_attemptId_questionId_key" ON "QuizAnswer"("attemptId", "questionId");
CREATE INDEX "QuizAnswer_questionId_idx" ON "QuizAnswer"("questionId");
