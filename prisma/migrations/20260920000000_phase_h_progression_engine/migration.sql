-- Phase H — canonical progression & access engine + admin override.
-- ADDITIVE ONLY. No table rebuild, no column drop, no data deletion.
-- New table ProgressionOverride is the auditable admin exception overlay.
-- Existing LessonProgress, QuizAttempt, HomeworkSubmission, AbsenceHold
-- remain untouched; progression semantics move to server-authoritative
-- canonical engine in src/lib/progression-engine.ts which reuses all
-- existing lifecycle authorities.

CREATE TABLE "ProgressionOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "studentId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "courseId" TEXT,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "revokedByUserId" TEXT,
    CONSTRAINT "ProgressionOverride_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressionOverride_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressionOverride_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressionOverride_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ProgressionOverride_studentId_idx" ON "ProgressionOverride"("studentId");
CREATE INDEX "ProgressionOverride_lessonId_idx" ON "ProgressionOverride"("lessonId");
CREATE INDEX "ProgressionOverride_studentId_lessonId_idx" ON "ProgressionOverride"("studentId", "lessonId");
CREATE INDEX "ProgressionOverride_expiresAt_idx" ON "ProgressionOverride"("expiresAt");
