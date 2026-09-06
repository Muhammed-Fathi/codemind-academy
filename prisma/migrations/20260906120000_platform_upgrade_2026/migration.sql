-- CodeMind Academy — Migration: platform upgrade 2026/2027
-- Date: 2026-09-06
--
-- SCOPE (additive only):
--   * New NULLABLE columns on: User, Student, Question, ExamQuestion,
--     LessonProgress, ExamAttempt, QuizAttempt.
--   * New tables: Batch, MediaAsset, SessionVideo, SessionVideoView,
--     MockExam, MockExamQuestion, UserSession, PasswordResetToken,
--     SecurityRateLimit, SecurityEvent, QuizAttemptEvidence.
--   * New indexes on existing + new tables.
--
-- SAFETY:
--   * `ALTER TABLE ... ADD COLUMN` in SQLite is metadata-only when the column
--     is nullable or has a constant DEFAULT: no table rewrite, no row rewritten.
--   * Columns with NOT NULL carry a constant DEFAULT so existing rows are valid.
--   * Contains NO DROP / DELETE / TRUNCATE statements.
--   * The only UPDATE is the idempotent backfill in §4 (User.status derived
--     from the existing User.isActive flag) — it never changes isActive itself.
--   * `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` make the new
--     objects re-runnable. The ADD COLUMN statements are guarded in the
--     documented sqlite3 procedure (docs/DATABASE_MIGRATION.md §2 Option B).

-- ============================================================
-- 1. New columns on existing tables
-- ============================================================

-- User: server-tracked account status (ACTIVE | INACTIVE | SUSPENDED_MULTI_DEVICE)
ALTER TABLE "User" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'ACTIVE';

-- Student: batch membership (school-type based distribution group)
ALTER TABLE "Student" ADD COLUMN "batchId" TEXT;

-- Question bank: school-type tag. NULL = shared bank (usable by both types).
ALTER TABLE "Question" ADD COLUMN "schoolType" TEXT;
ALTER TABLE "ExamQuestion" ADD COLUMN "schoolType" TEXT;

-- LessonProgress: server-verified video watch tracking (95% rule)
ALTER TABLE "LessonProgress" ADD COLUMN "videoDurationSec" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LessonProgress" ADD COLUMN "videoWatchedSec" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LessonProgress" ADD COLUMN "videoPercent" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "LessonProgress" ADD COLUMN "videoCompleted" BOOLEAN NOT NULL DEFAULT 0;
ALTER TABLE "LessonProgress" ADD COLUMN "videoCompletedAt" DATETIME;
ALTER TABLE "LessonProgress" ADD COLUMN "lastHeartbeatAt" DATETIME;

-- ExamAttempt: link to the persisted mock-exam definition + its bank type
ALTER TABLE "ExamAttempt" ADD COLUMN "mockExamId" TEXT;
ALTER TABLE "ExamAttempt" ADD COLUMN "schoolType" TEXT;

-- QuizAttempt: camera state recorded for the attempt
ALTER TABLE "QuizAttempt" ADD COLUMN "cameraStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED';

-- ============================================================
-- 2. New tables
-- ============================================================

CREATE TABLE IF NOT EXISTS "Batch" (
  "id"         TEXT PRIMARY KEY NOT NULL,
  "name"       TEXT NOT NULL,
  "nameAr"     TEXT NOT NULL,
  "schoolType" TEXT NOT NULL,
  "courseId"   TEXT,
  "isActive"   BOOLEAN NOT NULL DEFAULT 1,
  "createdAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Batch_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "MediaAsset" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "kind"         TEXT NOT NULL DEFAULT 'VIDEO',
  "storage"      TEXT NOT NULL DEFAULT 'EXTERNAL_URL',
  "storageKey"   TEXT,
  "externalUrl"  TEXT,
  "mimeType"     TEXT,
  "sizeBytes"    INTEGER,
  "durationSec"  INTEGER,
  "originalName" TEXT,
  "isPrivate"    BOOLEAN NOT NULL DEFAULT 0,
  "createdById"  TEXT,
  "createdAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS "SessionVideo" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "batchId"         TEXT NOT NULL,
  "lessonId"        TEXT,
  "mediaAssetId"    TEXT NOT NULL,
  "title"           TEXT NOT NULL,
  "titleAr"         TEXT NOT NULL,
  "description"     TEXT,
  "requiredPercent" INTEGER NOT NULL DEFAULT 95,
  "isPublished"     BOOLEAN NOT NULL DEFAULT 0,
  "publishedAt"     DATETIME,
  "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SessionVideo_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SessionVideo_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "SessionVideo_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "SessionVideoView" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "sessionVideoId"  TEXT NOT NULL,
  "studentId"       TEXT NOT NULL,
  "watchedSec"      INTEGER NOT NULL DEFAULT 0,
  "durationSec"     INTEGER NOT NULL DEFAULT 0,
  "percent"         INTEGER NOT NULL DEFAULT 0,
  "isCompleted"     BOOLEAN NOT NULL DEFAULT 0,
  "completedAt"     DATETIME,
  "lastHeartbeatAt" DATETIME,
  CONSTRAINT "SessionVideoView_sessionVideoId_fkey" FOREIGN KEY ("sessionVideoId") REFERENCES "SessionVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "SessionVideoView_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "MockExam" (
  "id"            TEXT PRIMARY KEY NOT NULL,
  "title"         TEXT NOT NULL,
  "titleAr"       TEXT NOT NULL,
  "description"   TEXT,
  "schoolType"    TEXT NOT NULL,
  "courseId"      TEXT,
  "questionCount" INTEGER NOT NULL DEFAULT 10,
  "durationMin"   INTEGER NOT NULL DEFAULT 30,
  "passMark"      INTEGER NOT NULL DEFAULT 60,
  "difficulty"    TEXT NOT NULL DEFAULT 'MIXED',
  "selectionMode" TEXT NOT NULL DEFAULT 'RANDOM',
  "isPublished"   BOOLEAN NOT NULL DEFAULT 0,
  "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MockExam_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "MockExamQuestion" (
  "id"             TEXT PRIMARY KEY NOT NULL,
  "mockExamId"     TEXT NOT NULL,
  "questionId"     TEXT,
  "examQuestionId" TEXT,
  "order"          INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "MockExamQuestion_mockExamId_fkey" FOREIGN KEY ("mockExamId") REFERENCES "MockExam"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MockExamQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "MockExamQuestion_examQuestionId_fkey" FOREIGN KEY ("examQuestionId") REFERENCES "ExamQuestion"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "UserSession" (
  "id"            TEXT PRIMARY KEY NOT NULL,
  "userId"        TEXT NOT NULL,
  "tokenHash"     TEXT NOT NULL,
  "deviceHash"    TEXT NOT NULL,
  "userAgent"     TEXT,
  "ipHash"        TEXT,
  "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt"    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt"     DATETIME NOT NULL,
  "revokedAt"     DATETIME,
  "revokedReason" TEXT,
  CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "PasswordResetToken" (
  "id"              TEXT PRIMARY KEY NOT NULL,
  "userId"          TEXT NOT NULL,
  "tokenHash"       TEXT NOT NULL,
  "channel"         TEXT NOT NULL DEFAULT 'EMAIL',
  "destinationMask" TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "expiresAt"       DATETIME NOT NULL,
  "usedAt"          DATETIME,
  "createdAt"       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "SecurityRateLimit" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "bucket"       TEXT NOT NULL,
  "identifier"   TEXT NOT NULL,
  "count"        INTEGER NOT NULL DEFAULT 0,
  "windowStart"  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blockedUntil" DATETIME
);

CREATE TABLE IF NOT EXISTS "SecurityEvent" (
  "id"        TEXT PRIMARY KEY NOT NULL,
  "userId"    TEXT,
  "type"      TEXT NOT NULL,
  "detail"    TEXT,
  "ipHash"    TEXT,
  "userAgent" TEXT,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "QuizAttemptEvidence" (
  "id"           TEXT PRIMARY KEY NOT NULL,
  "attemptId"    TEXT NOT NULL,
  "mediaAssetId" TEXT,
  "kind"         TEXT NOT NULL DEFAULT 'SNAPSHOT',
  "status"       TEXT,
  "capturedAt"   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retainUntil"  DATETIME,
  CONSTRAINT "QuizAttemptEvidence_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "QuizAttempt"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "QuizAttemptEvidence_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- ============================================================
-- 3. Indexes
-- ============================================================

CREATE INDEX IF NOT EXISTS "User_role_idx"   ON "User"("role");
CREATE INDEX IF NOT EXISTS "User_status_idx" ON "User"("status");

CREATE INDEX IF NOT EXISTS "Student_schoolType_idx" ON "Student"("schoolType");
CREATE INDEX IF NOT EXISTS "Student_groupId_idx"    ON "Student"("groupId");
CREATE INDEX IF NOT EXISTS "Student_batchId_idx"    ON "Student"("batchId");

CREATE INDEX IF NOT EXISTS "Question_schoolType_idx"     ON "Question"("schoolType");
CREATE INDEX IF NOT EXISTS "ExamQuestion_schoolType_idx" ON "ExamQuestion"("schoolType");

CREATE INDEX IF NOT EXISTS "LessonProgress_studentId_idx"      ON "LessonProgress"("studentId");
CREATE INDEX IF NOT EXISTS "LessonProgress_lessonId_idx"       ON "LessonProgress"("lessonId");
CREATE INDEX IF NOT EXISTS "LessonProgress_videoCompleted_idx" ON "LessonProgress"("videoCompleted");

CREATE INDEX IF NOT EXISTS "ExamAttempt_mockExamId_idx" ON "ExamAttempt"("mockExamId");
CREATE INDEX IF NOT EXISTS "QuizAttempt_studentId_idx"  ON "QuizAttempt"("studentId");

CREATE UNIQUE INDEX IF NOT EXISTS "Batch_schoolType_courseId_key" ON "Batch"("schoolType", "courseId");
CREATE INDEX IF NOT EXISTS "Batch_schoolType_idx" ON "Batch"("schoolType");

CREATE INDEX IF NOT EXISTS "MediaAsset_kind_idx"    ON "MediaAsset"("kind");
CREATE INDEX IF NOT EXISTS "MediaAsset_storage_idx" ON "MediaAsset"("storage");

CREATE INDEX IF NOT EXISTS "SessionVideo_batchId_isPublished_idx" ON "SessionVideo"("batchId", "isPublished");
CREATE INDEX IF NOT EXISTS "SessionVideo_lessonId_idx"            ON "SessionVideo"("lessonId");

CREATE UNIQUE INDEX IF NOT EXISTS "SessionVideoView_sessionVideoId_studentId_key" ON "SessionVideoView"("sessionVideoId", "studentId");
CREATE INDEX IF NOT EXISTS "SessionVideoView_studentId_idx"   ON "SessionVideoView"("studentId");
CREATE INDEX IF NOT EXISTS "SessionVideoView_isCompleted_idx" ON "SessionVideoView"("isCompleted");

CREATE INDEX IF NOT EXISTS "MockExam_schoolType_isPublished_idx" ON "MockExam"("schoolType", "isPublished");

CREATE UNIQUE INDEX IF NOT EXISTS "MockExamQuestion_mockExamId_questionId_key"     ON "MockExamQuestion"("mockExamId", "questionId");
CREATE UNIQUE INDEX IF NOT EXISTS "MockExamQuestion_mockExamId_examQuestionId_key" ON "MockExamQuestion"("mockExamId", "examQuestionId");
CREATE INDEX IF NOT EXISTS "MockExamQuestion_mockExamId_idx" ON "MockExamQuestion"("mockExamId");

CREATE UNIQUE INDEX IF NOT EXISTS "UserSession_tokenHash_key" ON "UserSession"("tokenHash");
CREATE INDEX IF NOT EXISTS "UserSession_userId_revokedAt_idx" ON "UserSession"("userId", "revokedAt");
CREATE INDEX IF NOT EXISTS "UserSession_expiresAt_idx"        ON "UserSession"("expiresAt");
CREATE INDEX IF NOT EXISTS "UserSession_deviceHash_idx"       ON "UserSession"("deviceHash");

CREATE UNIQUE INDEX IF NOT EXISTS "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_userId_usedAt_idx" ON "PasswordResetToken"("userId", "usedAt");
CREATE INDEX IF NOT EXISTS "PasswordResetToken_expiresAt_idx"     ON "PasswordResetToken"("expiresAt");

CREATE UNIQUE INDEX IF NOT EXISTS "SecurityRateLimit_bucket_identifier_key" ON "SecurityRateLimit"("bucket", "identifier");
CREATE INDEX IF NOT EXISTS "SecurityRateLimit_windowStart_idx" ON "SecurityRateLimit"("windowStart");

CREATE INDEX IF NOT EXISTS "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent"("userId", "createdAt");
CREATE INDEX IF NOT EXISTS "SecurityEvent_type_createdAt_idx"   ON "SecurityEvent"("type", "createdAt");

CREATE INDEX IF NOT EXISTS "QuizAttemptEvidence_attemptId_capturedAt_idx" ON "QuizAttemptEvidence"("attemptId", "capturedAt");
CREATE INDEX IF NOT EXISTS "QuizAttemptEvidence_retainUntil_idx"          ON "QuizAttemptEvidence"("retainUntil");

-- ============================================================
-- 4. Backfill (idempotent, derives ONLY from existing data)
-- ============================================================

-- Mirror the legacy isActive flag into the new status column.
-- Runs once meaningfully; re-running is a no-op for already-correct rows.
UPDATE "User" SET "status" = 'INACTIVE' WHERE "isActive" = 0 AND "status" = 'ACTIVE';
