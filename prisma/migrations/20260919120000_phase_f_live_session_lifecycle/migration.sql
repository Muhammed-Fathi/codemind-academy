-- ===========================================================================
-- Phase F — Live-session lifecycle, attendance lock, absence review, absence
-- hold (SQLite edition).
--
-- ADDITIVE ONLY. No table is rebuilt, no column is dropped, no row is deleted,
-- no default is backfilled destructively. Every added column is nullable or has
-- a constant default, so existing production rows remain valid and readable
-- the moment this migration lands (deploy-time backfill: none required).
--
-- WHY EACH PIECE EXISTS (Phase F contract)
--
--   LiveSession — the scheduled event that is deliberately NOT the academic
--   Lesson. Phase F extends the existing row rather than introducing a second
--   session concept:
--     * createdByUserId / statusChanged* / conductedAt / endedAt / cancelled*
--       make the lifecycle auditable (who scheduled, who changed state, when).
--     * originalStartAt holds the FIRST instant a session was scheduled to
--       start and is never overwritten, so a reschedule preserves history while
--       startAt always describes the current instant.
--     * rescheduleCount / lastRescheduledAt / rescheduledByUserId record the
--       reschedule trail; the row itself is never cloned.
--     * substituteTeacherId is SESSION-scoped: an admin may hand one occurrence
--       to another teacher without transferring the Group or the Course. The
--       permanent teacherId is never overwritten.
--     * attendanceFinalizedAt / attendanceFinalizedByUserId are the lock. After
--       this instant the register is immutable to teachers and correctable only
--       by an admin through AttendanceCorrection.
--
--   Attendance — marks who and (new) WHO marked it and WHEN, so a register is
--   attributable. UNMARKED is still expressed as the ABSENCE of a row: the
--   migration deliberately does not add an UNMARKED status value, because that
--   would let "the teacher forgot" be read as "the student was absent".
--
--   AttendanceCorrection — append-only. One row per admin change of a locked
--   register: previous status, new status, mandatory reason, admin identity,
--   timestamp.
--
--   AbsenceReview — the administrative interpretation of a finalized ABSENT
--   attendance row (attendanceId is UNIQUE: one case per absence). The review
--   state machine never touches the attendance fact itself.
--
--   AbsenceReasonSubmission — append-only reason history (student or linked
--   parent). Replacing a reason adds a row; nothing is overwritten.
--
--   AbsenceHold — the Phase F output state of an unexcused absence. Phase F
--   creates, manages and resolves it and exposes it to authorized consumers; it
--   gates NOTHING here (enforcement is Phase H by explicit decision).
--
--   Notification — sessionId links a notification to the LIVE session (a
--   meeting URL is never stored in a notification). dedupeKey + UNIQUE(userId,
--   dedupeKey) make emission idempotent: a retry can never fan out duplicates.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. LiveSession — scheduling provenance, lifecycle stamps, reschedule trail,
--    session-scoped substitute, and the attendance lock.
-- ---------------------------------------------------------------------------
ALTER TABLE "LiveSession" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "statusChangedAt" DATETIME;
ALTER TABLE "LiveSession" ADD COLUMN "statusChangedByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "conductedAt" DATETIME;
ALTER TABLE "LiveSession" ADD COLUMN "endedAt" DATETIME;
ALTER TABLE "LiveSession" ADD COLUMN "cancelledAt" DATETIME;
ALTER TABLE "LiveSession" ADD COLUMN "cancelledByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "rescheduleCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LiveSession" ADD COLUMN "lastRescheduledAt" DATETIME;
ALTER TABLE "LiveSession" ADD COLUMN "rescheduledByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "originalStartAt" DATETIME;
ALTER TABLE "LiveSession" ADD COLUMN "substituteTeacherId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "substituteAssignedAt" DATETIME;
ALTER TABLE "LiveSession" ADD COLUMN "substituteAssignedByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "attendanceFinalizedAt" DATETIME;
ALTER TABLE "LiveSession" ADD COLUMN "attendanceFinalizedByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "updatedAt" DATETIME;

-- ---------------------------------------------------------------------------
-- 2. Attendance — attribution of every mark (UNMARKED stays "no row").
-- ---------------------------------------------------------------------------
ALTER TABLE "Attendance" ADD COLUMN "markedByUserId" TEXT;
ALTER TABLE "Attendance" ADD COLUMN "markedAt" DATETIME;
ALTER TABLE "Attendance" ADD COLUMN "updatedAt" DATETIME;

-- ---------------------------------------------------------------------------
-- 3. Notification — session linkage + idempotency key.
-- ---------------------------------------------------------------------------
ALTER TABLE "Notification" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

-- ---------------------------------------------------------------------------
-- 4. AttendanceCorrection — append-only admin correction of a locked register.
--    No relation to Student/User: the ids are plain columns, exactly like the
--    rest of the platform's history tables, so a future user deletion can never
--    cascade into the correction trail.
-- ---------------------------------------------------------------------------
CREATE TABLE "AttendanceCorrection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attendanceId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "previousStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "correctedByUserId" TEXT NOT NULL,
    "correctedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AttendanceCorrection_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AttendanceCorrection_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 5. AbsenceReview — one administrative case per finalized ABSENT row.
--    `attendanceId` is UNIQUE: the database-level idempotency key of the whole
--    workflow. `lessonId`/`teacherId` are denormalized plain columns (no
--    relation) so a later re-link of the LiveSession never rewrites open cases.
-- ---------------------------------------------------------------------------
CREATE TABLE "AbsenceReview" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "attendanceId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "groupId" TEXT NOT NULL,
    "lessonId" TEXT,
    "teacherId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING_REASON',
    "reason" TEXT,
    "reasonSubmittedAt" DATETIME,
    "reasonSubmittedByUserId" TEXT,
    "reasonSubmittedByRole" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" DATETIME,
    "decisionNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME,
    CONSTRAINT "AbsenceReview_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AbsenceReview_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AbsenceReview_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AbsenceReview_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 6. AbsenceReasonSubmission — append-only reason trail (nothing overwritten;
--    a replacement is a new row carrying the new text).
-- ---------------------------------------------------------------------------
CREATE TABLE "AbsenceReasonSubmission" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "absenceReviewId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "submittedByUserId" TEXT NOT NULL,
    "submittedByRole" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AbsenceReasonSubmission_absenceReviewId_fkey" FOREIGN KEY ("absenceReviewId") REFERENCES "AbsenceReview" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 7. AbsenceHold — the Phase F output state (created/managed/resolved here,
--    enforced nowhere in Phase F; Phase H consumes it).
-- ---------------------------------------------------------------------------
CREATE TABLE "AbsenceHold" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "absenceReviewId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedByUserId" TEXT,
    "resolution" TEXT,
    CONSTRAINT "AbsenceHold_absenceReviewId_fkey" FOREIGN KEY ("absenceReviewId") REFERENCES "AbsenceReview" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "AbsenceHold_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- ---------------------------------------------------------------------------
-- 8. Indexes and uniqueness (names are the Prisma-canonical names, so a later
--    `migrate dev` / drift check sees no difference).
-- ---------------------------------------------------------------------------
-- PRE-EXISTING DIVERGENCE, CLOSED ADDITIVELY: `Attendance` has declared
-- `@@index([sessionId])` since Phase 13, but the historical SQLite migrations
-- never created it. Additive, no data change.
CREATE INDEX IF NOT EXISTS "Attendance_sessionId_idx" ON "Attendance"("sessionId");
CREATE INDEX "LiveSession_teacherId_startAt_idx" ON "LiveSession"("teacherId", "startAt");
CREATE INDEX "LiveSession_substituteTeacherId_idx" ON "LiveSession"("substituteTeacherId");
CREATE INDEX "LiveSession_status_startAt_idx" ON "LiveSession"("status", "startAt");
CREATE INDEX "Notification_sessionId_idx" ON "Notification"("sessionId");
CREATE UNIQUE INDEX "Notification_userId_dedupeKey_key" ON "Notification"("userId", "dedupeKey");
CREATE INDEX "AttendanceCorrection_attendanceId_idx" ON "AttendanceCorrection"("attendanceId");
CREATE INDEX "AttendanceCorrection_sessionId_idx" ON "AttendanceCorrection"("sessionId");
CREATE UNIQUE INDEX "AbsenceReview_attendanceId_key" ON "AbsenceReview"("attendanceId");
CREATE INDEX "AbsenceReview_status_idx" ON "AbsenceReview"("status");
CREATE INDEX "AbsenceReview_studentId_status_idx" ON "AbsenceReview"("studentId", "status");
CREATE INDEX "AbsenceReview_sessionId_idx" ON "AbsenceReview"("sessionId");
CREATE INDEX "AbsenceReview_groupId_idx" ON "AbsenceReview"("groupId");
CREATE INDEX "AbsenceReasonSubmission_absenceReviewId_createdAt_idx" ON "AbsenceReasonSubmission"("absenceReviewId", "createdAt");
CREATE UNIQUE INDEX "AbsenceHold_absenceReviewId_key" ON "AbsenceHold"("absenceReviewId");
CREATE INDEX "AbsenceHold_studentId_status_idx" ON "AbsenceHold"("studentId", "status");
CREATE INDEX "AbsenceHold_sessionId_idx" ON "AbsenceHold"("sessionId");

-- ---------------------------------------------------------------------------
-- 9. PROVIDER ASYMMETRY (documented, not hidden). The PostgreSQL edition also
--    adds the `LiveSession_substituteTeacherId_fkey` FOREIGN KEY. SQLite can
--    only attach a foreign key to an EXISTING table by rebuilding it, and this
--    migration deliberately does not rebuild `LiveSession` (a rebuild would
--    rewrite a table that production rows reference from Attendance /
--    SessionPublication / …). The substitute reference is therefore an indexed
--    plain column here; the constraint itself is enforced in PostgreSQL (the
--    production provider) and re-created by any future `migrate dev` on SQLite.
--
-- 10. New NotificationType values. SQLite stores enums as TEXT, so there is no
--    type to alter — the values are documented here for the record:
--      SESSION_SCHEDULED, SESSION_LINK, SESSION_RESCHEDULED, SESSION_CANCELLED,
--      ABSENCE_FINALIZED, ABSENCE_REASON_SUBMITTED, ABSENCE_EXCUSED,
--      ABSENCE_UNEXCUSED, ABSENCE_REMINDER
--    and the two new absences enums AbsenceReviewStatus / AbsenceHoldStatus.
-- ---------------------------------------------------------------------------
