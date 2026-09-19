-- Phase G camera policy: additive, legacy quizzes remain optional.
ALTER TABLE "Quiz" ADD COLUMN "cameraPolicy" TEXT NOT NULL DEFAULT 'OPTIONAL';
