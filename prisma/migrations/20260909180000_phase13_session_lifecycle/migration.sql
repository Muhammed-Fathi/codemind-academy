-- CodeMind Academy — Migration: Phase 13 Session Lifecycle & Publishing Core
-- Date: 2026-09-09
-- Tables touched: Lesson (one new column + one index + a data-only backfill),
--                 SessionPublication (new, empty)
--
-- WHAT THIS DOES
--   1. Adds `Lesson.status` — the administrative lifecycle
--      (`DRAFT` → `READY` → `PUBLISHED`), which replaces `isPublished` as the
--      thing every visibility / progression / authorization path reads.
--   2. Backfills it deterministically from `Lesson.isPublished`
--      (`true` → PUBLISHED, `false` → DRAFT) so NO lesson changes its
--      student-visible state on upgrade: today's published set is exactly
--      tomorrow's PUBLISHED set.
--   3. Creates `SessionPublication`, the OPEN ceremony's publication anchor
--      (idempotency key + the state Phase 17's notifications will consume).
--
-- SAFETY
--   * PURELY ADDITIVE. SQLite supports `ADD COLUMN ... NOT NULL DEFAULT`
--     directly, so unlike the Phase 12 column additions this needs NO table
--     rebuild, NO row copy and NO DROP. No row is deleted, no column is
--     dropped or retyped, and no historical migration is edited.
--   * Every pre-existing row keeps its id, its relations and all columns
--     written verbatim by the copy — there is no copy step at all here.
--   * `NOT NULL DEFAULT 'DRAFT'` fails CLOSED: a row inserted by raw SQL that
--     does not name `status` is DRAFT, i.e. invisible to students, rather
--     than visible. The same default is what the Prisma client applies.
--   * `Lesson.isPublished` is NOT dropped. It becomes a compatibility mirror
--     written only by `src/lib/session-lifecycle.ts`; its column DDL (and
--     therefore its `DEFAULT true`) is left untouched, because rewriting the
--     table to change an inert default would be pure risk. The default is
--     unreachable from Prisma writes: every writer sets the mirror explicitly.
--   * `isLocked` is left exactly as it is: it is already inert and stays
--     inert. Nothing in this migration reads or rewrites it.
--
-- WHY THE BACKFILL GUARDS ON `status = 'DRAFT'`
--   The `WHERE "status" = 'DRAFT'` clause is what makes this statement
--   idempotent, not just a one-shot UPDATE: re-applying the migration (or
--   replaying it on a restored backup) can never resurrect a lesson an admin
--   has meanwhile unpublished. A lesson whose lifecycle has been spoken about
--   by the ceremony is authoritative and stays as the ceremony left it.

-- ---------------------------------------------------------------------------
-- 1. The lifecycle column
-- ---------------------------------------------------------------------------

ALTER TABLE "Lesson" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'DRAFT';

-- ---------------------------------------------------------------------------
-- 2. Deterministic backfill from the legacy flag
-- ---------------------------------------------------------------------------
-- The mapping is the one the phase specifies — `isPublished = true` means the
-- lesson was already in the student universe, `false` means it was not:
--
--   isPublished true  → PUBLISHED   (already visible; must stay visible)
--   isPublished false → DRAFT       (already invisible; stays invisible)
--
-- `COALESCE(CAST(... AS INTEGER), 0) = 1` is the deliberate, fail-closed form
-- of "is published": SQLite stores the Prisma Boolean as 0/1, and anything
-- that is not exactly a truthy 1 (NULL, an empty string, text written by a
-- hand-made row) resolves to DRAFT — i.e. unseen by students — rather than
-- silently publishing content nobody staged.
--
-- The `false` branch needs no statement: the column default is already DRAFT,
-- so every row the UPDATE above does not touch is DRAFT by construction. It is
-- spelled out here so the mapping is fully explicit and reviewable, and is
-- asserted by tests/session-lifecycle-phase13.test.js (backfill matrix).

UPDATE "Lesson" SET "status" = 'PUBLISHED'
WHERE "status" = 'DRAFT'
  AND COALESCE(CAST("isPublished" AS INTEGER), 0) = 1;

-- ARCHIVED lessons are excluded from the ACTIVE curriculum by
-- `curriculumStatus` (Phase 11), independently of `status`. A backfilled
-- `ARCHIVED + PUBLISHED` row is therefore still not student-visible — the
-- universe requires BOTH clauses — and the OPEN ceremony refuses to touch an
-- archived lesson at all. No special case is needed in the data, and none is
-- invented here (silently rewriting archived rows would fabricate lifecycle
-- history that never happened).

-- ---------------------------------------------------------------------------
-- 3. Lifecycle index
-- ---------------------------------------------------------------------------
-- Every student-facing universe query in the platform now filters lessons by
-- `status` (progression universe, course tree, dashboards, certificates,
-- parent reports), so the column earns its index. One index only — the
-- roadmap's "one field, one index".

CREATE INDEX "Lesson_status_idx" ON "Lesson"("status");

-- ---------------------------------------------------------------------------
-- 4. The publication anchor
-- ---------------------------------------------------------------------------
-- Empty on creation: it only ever gains rows through the OPEN ceremony. The
-- backfilled PUBLISHED lessons above deliberately get NO row — their
-- publication predates the ceremony and there is no honest timestamp or actor
-- to record for them. Creating fake `publishedAt = createdAt` rows would
-- fabricate audit data, which is worse than an acknowledged gap (documented in
-- docs/PHASE_13_SESSION_LIFECYCLE.md §"Backfill").

CREATE TABLE "SessionPublication" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "lessonId" TEXT NOT NULL,
    "segment" TEXT NOT NULL DEFAULT 'SHARED',
    "publishedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByUserId" TEXT,
    CONSTRAINT "SessionPublication_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- `lessonId` UNIQUE is the idempotency key: one publication per lesson, which
-- is also what keeps publishing from becoming per-track state
-- (`PUBLISHED_ARABIC` / `PUBLISHED_LANGUAGE` are not a thing in this model).
CREATE UNIQUE INDEX "SessionPublication_lessonId_key" ON "SessionPublication"("lessonId");
CREATE INDEX "SessionPublication_publishedAt_idx" ON "SessionPublication"("publishedAt");

-- ---------------------------------------------------------------------------
-- 5. Post-migration invariants
-- ---------------------------------------------------------------------------
-- ASSERTED OUTSIDE THIS FILE (SQLite has no `RAISE()` outside a trigger body,
-- so a migration cannot fail itself):
--   23 official lessons, 2 Parts, 7 Units, `officialCode` 1-1..7-3 unique
--     (Phase 11 intact — this migration touches none of those columns)
--   0 rows with `status NOT IN ('DRAFT','READY','PUBLISHED')`
--   0 rows where (`status` = 'PUBLISHED') <> (`isPublished` truthy)
--   0 rows where (`status` = 'PUBLISHED') AND `curriculumStatus` = 'ARCHIVED'
--     is *permitted*, and asserted to remain non-student-visible via the
--     `curriculumStatus` clause instead
--   row counts of Lesson / LessonProgress / QuizAttempt / HomeworkSubmission
--     identical before and after (proved on real rows, not an empty DB — see
--     scripts/verify-phase13-db.mjs and docs/PHASE_13_SESSION_LIFECYCLE.md)
-- Note that SQLite maps a Prisma enum to plain TEXT with no CHECK constraint
-- (Phase 12 finding), so enum validity is enforced by the client and by the
-- tests, not by the DDL.
