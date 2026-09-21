-- ===========================================================================
-- SessionVideo requirement modes + absence-linked recordings (SQLite).
--
-- ADDITIVE ONLY. Two new columns (one with a static default), one covering
-- index. No table is rebuilt, no row is deleted, and the single UPDATE below
-- writes ONLY the brand-new column — it preserves meaning, never rewrites it:
--
--   * `requirementMode` defaults to OPTIONAL, so every pre-existing row keeps
--     the exact historical engine behaviour (optional recordings are never
--     progression inputs) — EXCEPT rows whose legacy
--     `isRequiredForProgression` flag is true, which the UPDATE maps to
--     ALL_STUDENTS. That mapping is meaning-preserving: under the old model
--     "required" meant "required for every eligible student", which is
--     precisely what ALL_STUDENTS means. The legacy flag column is KEPT
--     (deprecated, dual-written) for backward compatibility.
--   * `liveSessionId` is NULL for every pre-existing row: no absence link is
--     invented for historical recordings (ABSENT_STUDENTS is only expressible
--     with an explicit admin-chosen session on new writes).
--
-- WHAT IT IS
--   The per-video progression requirement MODE the canonical engine reads
--   (OPTIONAL / ALL_STUDENTS / ABSENT_STUDENTS) plus the explicit LiveSession
--   FK an ABSENT_STUDENTS recording covers. Present / excused / unmarked
--   students are EXEMPT from absent-mode recordings; unexcused finalized
--   absentees must satisfy watchPercent >= requiredPercent.
--
-- WHAT IT IS NOT
--   Not a second requirement model: requiredness stays one gate on the row
--   the engine already joins, enforced through the existing publication /
--   track / batch / storage gates. EXTERNAL_URL (untrackable) rows can never
--   carry a non-OPTIONAL mode — refused at every write path, never silently
--   converted. Attendance is never guessed: UNMARKED (no row) is not ABSENT,
--   and only a FINALIZED register feeds applicability.
-- ===========================================================================

ALTER TABLE "SessionVideo" ADD COLUMN "requirementMode" TEXT NOT NULL DEFAULT 'OPTIONAL';
ALTER TABLE "SessionVideo" ADD COLUMN "liveSessionId" TEXT;
-- Meaning-preserving backfill of the NEW column only: legacy "required for
-- everyone" rows become ALL_STUDENTS ("required for everyone").
UPDATE "SessionVideo" SET "requirementMode" = 'ALL_STUDENTS' WHERE "isRequiredForProgression" = 1;
CREATE INDEX "SessionVideo_liveSessionId_idx" ON "SessionVideo"("liveSessionId");
