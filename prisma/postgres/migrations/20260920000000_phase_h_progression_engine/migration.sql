-- Phase H — canonical progression & access engine + admin override (PostgreSQL).
-- ADDITIVE ONLY. Mirrors the SQLite edition with PostgreSQL types.

CREATE TABLE "ProgressionOverride" (
    "id" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "courseId" TEXT,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(3),
    "revokedAt" TIMESTAMPTZ(3),
    "revokedByUserId" TEXT,
    CONSTRAINT "ProgressionOverride_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProgressionOverride_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressionOverride_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressionOverride_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ProgressionOverride_revokedByUserId_fkey" FOREIGN KEY ("revokedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "ProgressionOverride_studentId_idx" ON "ProgressionOverride"("studentId");
CREATE INDEX "ProgressionOverride_lessonId_idx" ON "ProgressionOverride"("lessonId");
CREATE INDEX "ProgressionOverride_studentId_lessonId_idx" ON "ProgressionOverride"("studentId", "lessonId");
CREATE INDEX "ProgressionOverride_expiresAt_idx" ON "ProgressionOverride"("expiresAt");
