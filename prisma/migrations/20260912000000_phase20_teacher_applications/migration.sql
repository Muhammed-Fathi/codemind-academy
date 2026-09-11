-- Phase 20 (Security Hardening II) — Teacher Application & Admin Approval.
--
-- Purely ADDITIVE: two new tables. Nothing is removed, modified, or
-- backfilled. The public "become a teacher" flow writes only PENDING
-- `TeacherApplication` rows; the `User` (role TEACHER) is created later by
-- the applicant through a single-use `TeacherActivationToken` minted when an
-- Admin approves.

CREATE TABLE IF NOT EXISTS "TeacherApplication" (
  "id"               TEXT NOT NULL PRIMARY KEY,
  "email"            TEXT NOT NULL,
  "name"             TEXT NOT NULL,
  "phone"            TEXT,
  "specialty"        TEXT,
  "bio"              TEXT,
  "status"           TEXT NOT NULL DEFAULT 'PENDING',
  "adminNote"        TEXT,
  "reviewedByUserId" TEXT,
  "reviewedAt"       DATETIME,
  "userId"           TEXT,
  "createdAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"        DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeacherApplication_email_key"
  ON "TeacherApplication"("email");
CREATE UNIQUE INDEX IF NOT EXISTS "TeacherApplication_userId_key"
  ON "TeacherApplication"("userId");
CREATE INDEX IF NOT EXISTS "TeacherApplication_status_createdAt_idx"
  ON "TeacherApplication"("status", "createdAt");

CREATE TABLE IF NOT EXISTS "TeacherActivationToken" (
  "id"            TEXT NOT NULL PRIMARY KEY,
  "applicationId" TEXT NOT NULL,
  "tokenHash"     TEXT NOT NULL,
  "expiresAt"     DATETIME NOT NULL,
  "usedAt"        DATETIME,
  "createdAt"     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "TeacherActivationToken_tokenHash_key"
  ON "TeacherActivationToken"("tokenHash");
CREATE INDEX IF NOT EXISTS "TeacherActivationToken_applicationId_usedAt_idx"
  ON "TeacherActivationToken"("applicationId", "usedAt");
CREATE INDEX IF NOT EXISTS "TeacherActivationToken_expiresAt_idx"
  ON "TeacherActivationToken"("expiresAt");
