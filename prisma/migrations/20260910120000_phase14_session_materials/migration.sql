-- CodeMind Academy — Migration: Phase 14 PDF & Session Materials
-- Date: 2026-09-10
-- Tables touched: Material (one new column + one index)
--
-- WHAT THIS DOES
--   1. Adds `Material.trackScope` — the content-eligibility dimension for
--      session PDFs/materials (SHARED | ARABIC | LANGUAGE), matching Lesson /
--      Quiz / Homework so a LANGUAGE student can never download ARABIC material
--      and vice versa.
--   2. Indexes `(lessonId, trackScope, isActive)` so the "one active PDF per
--      lesson × trackScope" lookup the upload route uses is cheap.
--
-- SAFETY
--   * PURELY ADDITIVE. SQLite supports `ADD COLUMN ... NOT NULL DEFAULT`
--     directly — no table rebuild, no row copy, no DROP.
--   * `DEFAULT 'SHARED'` is the correct semantic for every pre-existing row:
--     nothing was track-scoped before Phase 14, so every historical Material
--     (if any) was authored for the whole cohort.
--   * No uniqueness constraint is added on `(lessonId, trackScope)` because
--     deactivated historical rows must survive for audit/reference counting;
--     the "one ACTIVE PDF per lesson × trackScope" rule is enforced by
--     `src/lib/session-materials.ts` (deactivate-then-create) and asserted by
--     tests. A partial unique index would be SQLite-only and brittle under
--     Prisma migrations.
--   * `Lesson.pdfUrl` is NOT touched. It remains a read-only legacy carrier;
--     new uploads never write it (Phase 14 contract: zero new pdfUrl writes).

-- ---------------------------------------------------------------------------
-- 1. Track scope on Material
-- ---------------------------------------------------------------------------

ALTER TABLE "Material" ADD COLUMN "trackScope" TEXT NOT NULL DEFAULT 'SHARED';

-- ---------------------------------------------------------------------------
-- 2. Lookup index for active material resolution
-- ---------------------------------------------------------------------------

CREATE INDEX "Material_lessonId_trackScope_isActive_idx"
  ON "Material"("lessonId", "trackScope", "isActive");
