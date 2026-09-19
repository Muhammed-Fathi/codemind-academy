-- ===========================================================================
-- Phase F — Live-session lifecycle, attendance lock, absence review, absence
-- hold (PostgreSQL edition).
--
-- This is the PostgreSQL twin of the SQLite migration of the same name. The two
-- files are NOT copies: SQLite stores enums as TEXT, PostgreSQL has real enum
-- types, and DATETIME does not exist here (the Phase 26D production deploy
-- failed on exactly that). What the two editions must agree on is the LOGICAL
-- result: the same columns, the same tables, the same constraints and the same
-- index names. `prisma/postgres/migrations/0_init` is frozen and is never
-- touched; this file is applied after Phase 26D.
--
-- ADDITIVE ONLY. No table is rebuilt, no column is dropped, no row is deleted,
-- no default is backfilled destructively. Every added column is nullable or has
-- a constant default, so existing production rows stay valid at apply time.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- 1. LiveSession — scheduling provenance, lifecycle stamps, reschedule trail,
--    session-scoped substitute, and the attendance lock.
-- ---------------------------------------------------------------------------
ALTER TABLE "LiveSession" ADD COLUMN "createdByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "statusChangedAt" TIMESTAMPTZ(3);
ALTER TABLE "LiveSession" ADD COLUMN "statusChangedByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "conductedAt" TIMESTAMPTZ(3);
ALTER TABLE "LiveSession" ADD COLUMN "endedAt" TIMESTAMPTZ(3);
ALTER TABLE "LiveSession" ADD COLUMN "cancelledAt" TIMESTAMPTZ(3);
ALTER TABLE "LiveSession" ADD COLUMN "cancelledByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "cancelReason" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "rescheduleCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LiveSession" ADD COLUMN "lastRescheduledAt" TIMESTAMPTZ(3);
ALTER TABLE "LiveSession" ADD COLUMN "rescheduledByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "originalStartAt" TIMESTAMPTZ(3);
ALTER TABLE "LiveSession" ADD COLUMN "substituteTeacherId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "substituteAssignedAt" TIMESTAMPTZ(3);
ALTER TABLE "LiveSession" ADD COLUMN "substituteAssignedByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "attendanceFinalizedAt" TIMESTAMPTZ(3);
ALTER TABLE "LiveSession" ADD COLUMN "attendanceFinalizedByUserId" TEXT;
ALTER TABLE "LiveSession" ADD COLUMN "updatedAt" TIMESTAMPTZ(3);
-- The substitute is a SESSION-scoped teacher reference. SET NULL keeps the
-- session row (and its history) alive if the substitute account is ever
-- removed; the permanent teacherId is untouched.
ALTER TABLE "LiveSession" ADD CONSTRAINT "LiveSession_substituteTeacherId_fkey"
  FOREIGN KEY ("substituteTeacherId") REFERENCES "Teacher"("id") ON UPDATE CASCADE ON DELETE SET NULL;

-- ---------------------------------------------------------------------------
-- 2. Attendance — attribution of every mark (UNMARKED stays "no row").
-- ---------------------------------------------------------------------------
ALTER TABLE "Attendance" ADD COLUMN "markedByUserId" TEXT;
ALTER TABLE "Attendance" ADD COLUMN "markedAt" TIMESTAMPTZ(3);
ALTER TABLE "Attendance" ADD COLUMN "updatedAt" TIMESTAMPTZ(3);

-- ---------------------------------------------------------------------------
-- 3. Notification — session linkage + idempotency key. `sessionId` is a plain
--    column (no FK) on purpose: notification rows are delivery history and must
--    survive a session deletion.
-- ---------------------------------------------------------------------------
ALTER TABLE "Notification" ADD COLUMN "sessionId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "dedupeKey" TEXT;

-- ---------------------------------------------------------------------------
-- 4. New enum types for the absence workflow. They are separate from
--    AttendanceStatus because "what happened" and "what we decided about it"
--    are different facts.
-- ---------------------------------------------------------------------------
CREATE TYPE "AbsenceReviewStatus" AS ENUM ('PENDING_REASON', 'PENDING_REVIEW', 'EXCUSED', 'UNEXCUSED', 'NO_ACTION_REQUIRED');
CREATE TYPE "AbsenceHoldStatus" AS ENUM ('ACTIVE', 'RESOLVED');

-- ---------------------------------------------------------------------------
-- 5. AttendanceCorrection — append-only admin correction of a locked register.
-- ---------------------------------------------------------------------------
CREATE TABLE "AttendanceCorrection" (
  "id" TEXT NOT NULL,
  "attendanceId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "previousStatus" "AttendanceStatus" NOT NULL,
  "newStatus" "AttendanceStatus" NOT NULL,
  "reason" TEXT NOT NULL,
  "correctedByUserId" TEXT NOT NULL,
  "correctedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AttendanceCorrection_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AttendanceCorrection_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "AttendanceCorrection_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 6. AbsenceReview — one administrative case per finalized ABSENT row.
--    `attendanceId` is UNIQUE: the database-level idempotency key of the whole
--    workflow. `lessonId`/`teacherId` are denormalized plain columns (no FK) so
--    a later re-link of the LiveSession never rewrites open cases.
-- ---------------------------------------------------------------------------
CREATE TABLE "AbsenceReview" (
  "id" TEXT NOT NULL,
  "attendanceId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "lessonId" TEXT,
  "teacherId" TEXT,
  "status" "AbsenceReviewStatus" NOT NULL DEFAULT 'PENDING_REASON',
  "reason" TEXT,
  "reasonSubmittedAt" TIMESTAMPTZ(3),
  "reasonSubmittedByUserId" TEXT,
  "reasonSubmittedByRole" TEXT,
  "decidedByUserId" TEXT,
  "decidedAt" TIMESTAMPTZ(3),
  "decisionNote" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3),
  CONSTRAINT "AbsenceReview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AbsenceReview_attendanceId_key" UNIQUE ("attendanceId"),
  CONSTRAINT "AbsenceReview_attendanceId_fkey" FOREIGN KEY ("attendanceId") REFERENCES "Attendance" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "AbsenceReview_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "AbsenceReview_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "AbsenceReview_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 7. AbsenceReasonSubmission — append-only reason trail.
-- ---------------------------------------------------------------------------
CREATE TABLE "AbsenceReasonSubmission" (
  "id" TEXT NOT NULL,
  "absenceReviewId" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "submittedByUserId" TEXT NOT NULL,
  "submittedByRole" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AbsenceReasonSubmission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AbsenceReasonSubmission_absenceReviewId_fkey" FOREIGN KEY ("absenceReviewId") REFERENCES "AbsenceReview" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 8. AbsenceHold — the Phase F output state (no enforcement in Phase F).
-- ---------------------------------------------------------------------------
CREATE TABLE "AbsenceHold" (
  "id" TEXT NOT NULL,
  "absenceReviewId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "status" "AbsenceHoldStatus" NOT NULL DEFAULT 'ACTIVE',
  "reason" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "resolvedAt" TIMESTAMPTZ(3),
  "resolvedByUserId" TEXT,
  "resolution" TEXT,
  CONSTRAINT "AbsenceHold_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AbsenceHold_absenceReviewId_key" UNIQUE ("absenceReviewId"),
  CONSTRAINT "AbsenceHold_absenceReviewId_fkey" FOREIGN KEY ("absenceReviewId") REFERENCES "AbsenceReview" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "AbsenceHold_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- ---------------------------------------------------------------------------
-- 9. Indexes and uniqueness (Prisma-canonical names).
-- ---------------------------------------------------------------------------
-- PRE-EXISTING DIVERGENCE, CLOSED ADDITIVELY: `Attendance` has declared
-- `@@index([sessionId])` since Phase 13, but the PostgreSQL baseline (0_init)
-- never created it, so a database built from this migration chain could not
-- reproduce `prisma/postgres/schema.prisma`. Verified against the generated
-- baseline before this line was added (see the Phase F report): the only other
-- structural difference was Phase F's own objects. Additive, no data change.
CREATE INDEX IF NOT EXISTS "Attendance_sessionId_idx" ON "Attendance" ("sessionId");
CREATE INDEX "LiveSession_teacherId_startAt_idx" ON "LiveSession" ("teacherId", "startAt");
CREATE INDEX "LiveSession_substituteTeacherId_idx" ON "LiveSession" ("substituteTeacherId");
CREATE INDEX "LiveSession_status_startAt_idx" ON "LiveSession" ("status", "startAt");
CREATE INDEX "Notification_sessionId_idx" ON "Notification" ("sessionId");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_dedupeKey_key" UNIQUE ("userId", "dedupeKey");
CREATE INDEX "AttendanceCorrection_attendanceId_idx" ON "AttendanceCorrection" ("attendanceId");
CREATE INDEX "AttendanceCorrection_sessionId_idx" ON "AttendanceCorrection" ("sessionId");
CREATE INDEX "AbsenceReview_status_idx" ON "AbsenceReview" ("status");
CREATE INDEX "AbsenceReview_studentId_status_idx" ON "AbsenceReview" ("studentId", "status");
CREATE INDEX "AbsenceReview_sessionId_idx" ON "AbsenceReview" ("sessionId");
CREATE INDEX "AbsenceReview_groupId_idx" ON "AbsenceReview" ("groupId");
CREATE INDEX "AbsenceReasonSubmission_absenceReviewId_createdAt_idx" ON "AbsenceReasonSubmission" ("absenceReviewId", "createdAt");
CREATE INDEX "AbsenceHold_studentId_status_idx" ON "AbsenceHold" ("studentId", "status");
CREATE INDEX "AbsenceHold_sessionId_idx" ON "AbsenceHold" ("sessionId");

-- ---------------------------------------------------------------------------
-- 10. NotificationType gains the nine Phase F events. Appended in the schema's
--     declared order: the enum's value order is asserted against the generated
--     baseline, so the order here matters.
-- ---------------------------------------------------------------------------
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SESSION_SCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SESSION_LINK';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SESSION_RESCHEDULED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'SESSION_CANCELLED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_FINALIZED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_REASON_SUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_EXCUSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_UNEXCUSED';
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'ABSENCE_REMINDER';
