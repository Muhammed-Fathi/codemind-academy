-- ===========================================================================
-- Phase G — Quiz / Homework operational workflow (SQLite edition).
--
-- ADDITIVE ONLY. No table is rebuilt, no column is dropped, no row is deleted,
-- no default is backfilled destructively. Every added column is nullable or
-- has a constant default, so existing production rows remain valid and
-- readable the moment this migration lands (deploy-time backfill: none).
--
-- WHY EACH PIECE EXISTS (Phase G contract)
--
--   Quiz.status / Quiz.publishedAt — the authoring lifecycle. Before Phase G a
--   quiz was student-visible the instant it existed; there was no draft, no
--   publish validation and no preview. `status` is stored as TEXT ('DRAFT' |
--   'PUBLISHED'), the SAME convention `Quiz.quizMode` and `QuizAttempt.status`
--   already use — no new enum, no client-visible contract. The default is
--   'PUBLISHED' ON PURPOSE: every pre-Phase-G row keeps exactly the behaviour
--   it always had; the teacher create route writes 'DRAFT' explicitly for new
--   quizzes. `publishedAt` stamps the first successful publish.
--
--   Homework.status / Homework.publishedAt — the assignment lifecycle
--   'DRAFT' → 'PUBLISHED' → 'CLOSED' (TEXT, server-authoritative transitions,
--   audited). Same default reasoning as Quiz: pre-Phase-G rows stay
--   'PUBLISHED', new teacher-created assignments start 'DRAFT'.
--
--   Homework.attachmentId — the teacher's assignment file (PDF/DOCX/PPTX/ZIP,
--   ≤25 MB) linked through the ONE existing private MediaAsset stack.
--   ON DELETE SET NULL: removing an asset never destroys the assignment.
--
--   HomeworkSubmission.attachmentId — the student's submitted file
--   (PDF/DOCX/JPG/PNG/ZIP, ≤25 MB) in the same stack, same SET NULL rule.
--
--   HomeworkSubmission.gradedById / gradedAt — grader identity and instant,
--   attributable grades (server-enforced 0 ≤ grade ≤ maxMarks). Nullable:
--   pre-Phase-G grades exist without them, and a teacher may pre-grade a
--   student who never submitted.
--
-- PROVIDER ASYMMETRY (documented, not hidden — same rule as the Phase F
-- LiveSession.substituteTeacherId precedent): the PostgreSQL edition adds the
-- three new FOREIGN KEY constraints. SQLite can only attach a foreign key to
-- an EXISTING table by rebuilding it, and this migration deliberately rebuilds
-- nothing (a rebuild would rewrite tables that production rows reference).
-- The new references are therefore plain columns here; the constraints are
-- enforced in PostgreSQL (the production provider) and re-created by any
-- future `migrate dev` on SQLite. Application code authorizes every read and
-- write of these links regardless of provider.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. Quiz — lifecycle.
-- ---------------------------------------------------------------------------
ALTER TABLE "Quiz" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "Quiz" ADD COLUMN "publishedAt" DATETIME;

-- ---------------------------------------------------------------------------
-- 2. Homework — lifecycle + teacher attachment.
-- ---------------------------------------------------------------------------
ALTER TABLE "Homework" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'PUBLISHED';
ALTER TABLE "Homework" ADD COLUMN "publishedAt" DATETIME;
ALTER TABLE "Homework" ADD COLUMN "attachmentId" TEXT;

-- ---------------------------------------------------------------------------
-- 3. HomeworkSubmission — student file + grader identity.
-- ---------------------------------------------------------------------------
ALTER TABLE "HomeworkSubmission" ADD COLUMN "attachmentId" TEXT;
ALTER TABLE "HomeworkSubmission" ADD COLUMN "gradedById" TEXT;
ALTER TABLE "HomeworkSubmission" ADD COLUMN "gradedAt" DATETIME;
