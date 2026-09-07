-- Phase 3: additive domain foundation.
-- Safe for existing SQLite data: nullable columns only; no DROP/DELETE/UPDATE.
--
-- PHASE 3 CORRECTION (2026-09-07, ADR-004) — semantics unchanged:
--   * Boolean defaults now use Prisma-canonical literals (true/false) matching
--     `prisma db push` / `migrate diff` output.
--   * `updatedAt` on the new tables Track/Material no longer carries a SQL
--     default (`@updatedAt` is maintained by the Prisma client).
--   * The missing FK constraints for `Course.trackId` and `Lesson.unitId` are
--     reconciled in 20260907130000_phase3_fk_reconciliation (SQLite cannot add
--     FKs via ALTER TABLE, and this file deliberately contains no table
--     rewrites).
ALTER TABLE "Course" ADD COLUMN "trackId" TEXT;
ALTER TABLE "Lesson" ADD COLUMN "unitId" TEXT;
ALTER TABLE "Lesson" ADD COLUMN "officialCode" TEXT;
ALTER TABLE "Lesson" ADD COLUMN "curriculumStatus" TEXT NOT NULL DEFAULT 'LEGACY';

CREATE TABLE "Track" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL
);
CREATE UNIQUE INDEX "Track_code_key" ON "Track"("code");

CREATE TABLE "Enrollment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "studentId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "trackId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "startsAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" DATETIME,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Enrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Enrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Enrollment_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Enrollment_studentId_courseId_trackId_key" ON "Enrollment"("studentId","courseId","trackId");
CREATE INDEX "Enrollment_courseId_trackId_status_idx" ON "Enrollment"("courseId","trackId","status");

CREATE TABLE "Material" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "lessonId" TEXT NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'GENERATED',
  "title" TEXT NOT NULL,
  "storageKey" TEXT,
  "mediaAssetId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "Material_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "Material_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE
);
CREATE INDEX "Material_lessonId_isActive_idx" ON "Material"("lessonId","isActive");
CREATE INDEX "Course_trackId_idx" ON "Course"("trackId");
CREATE INDEX "Lesson_unitId_order_idx" ON "Lesson"("unitId","order");
CREATE UNIQUE INDEX "Lesson_officialCode_key" ON "Lesson"("officialCode");
