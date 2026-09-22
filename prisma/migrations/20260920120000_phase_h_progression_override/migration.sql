-- ===========================================================================
-- Phase H — Canonical progression and access engine, admin override (SQLite).
--
-- ADDITIVE ONLY. One new table, three new indexes. No table is rebuilt, no
-- column is added to an existing table, no row is deleted, no default is
-- backfilled destructively. Existing production rows remain valid and
-- readable the moment this migration lands (deploy-time backfill: none).
--
-- WHY THIS TABLE EXISTS (Phase H contract)
--
--   The canonical progression engine (src/lib/progression.ts) derives
--   LOCKED / UNLOCKED / COMPLETED per student per lesson from academic facts
--   that already exist (video watch, quiz passes, homework submissions),
--   sequenced over the published track-eligible curriculum minus active
--   Phase F absence holds. That derivation needs no new state — except for
--   the ONE deliberate exception: an ADMIN may grant a named student access
--   to a named lesson as an audited expirable revocable exception, without
--   rewriting any underlying fact. That exception is this table.
--
-- WHAT IT IS NOT
--   Not a second Lesson model, not a second progression state machine, not a
--   second absence or quiz or homework lifecycle. It stores no academic fact
--   at all — only who granted whom access to what, why, when, and until when.
--
-- LIFECYCLE (evaluated at read time, never swept)
--   ACTIVE  = revokedAt IS NULL AND (expiresAt IS NULL OR expiresAt > now)
--   EXPIRED = expiresAt <= now
--   REVOKED = revokedAt IS NOT NULL (rows are never deleted)
--
-- ACTOR COLUMNS (createdByUserId / revokedByUserId) are plain TEXT columns,
-- NOT foreign keys: deleting a user must never rewrite override history (the
-- same policy as SessionPublication.publishedByUserId and the Phase F actor
-- columns). Every grant and revocation is mirrored into AuditLog.
-- ===========================================================================

CREATE TABLE "ProgressionOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedByUserId" TEXT,
    "revokeReason" TEXT,
    CONSTRAINT "ProgressionOverride_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressionOverride_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- Prisma-canonical index names, so a later drift check sees no difference.
CREATE INDEX "ProgressionOverride_studentId_idx" ON "ProgressionOverride"("studentId");
CREATE INDEX "ProgressionOverride_lessonId_idx" ON "ProgressionOverride"("lessonId");
CREATE INDEX "ProgressionOverride_studentId_lessonId_idx" ON "ProgressionOverride"("studentId", "lessonId");
