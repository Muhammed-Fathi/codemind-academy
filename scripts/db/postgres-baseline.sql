-- CodeMind Academy — Phase 21 PostgreSQL baseline DDL.
-- GENERATED from prisma/schema.prisma by scripts/db/pg-lib.mjs — DO NOT EDIT.
-- Regenerate: node scripts/db/make-postgres-schema.mjs --emit-ddl
-- The offline suite (tests/production-storage-phase21.test.js) fails if this
-- file drifts from what the emitter produces for the current schema.
--
-- Cutover use (engines available): prefer `prisma db push` on an empty
-- database and baseline the migration history; use THIS file when the
-- Prisma engines are unreachable or for byte-reviewable disaster recovery.
-- See docs/POSTGRES_CUTOVER_RUNBOOK.md.

-- 1. Enums (native PostgreSQL enums; SQLite stores the same values as TEXT).
CREATE TYPE "LessonStatus" AS ENUM ('DRAFT', 'READY', 'PUBLISHED');
CREATE TYPE "CurriculumStatus" AS ENUM ('OFFICIAL', 'LEGACY', 'ARCHIVED');
CREATE TYPE "EnrollmentStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'CANCELLED');
CREATE TYPE "MaterialKind" AS ENUM ('GENERATED', 'ADMIN_UPLOADED');
CREATE TYPE "SchoolType" AS ENUM ('ARABIC', 'LANGUAGE');
CREATE TYPE "TrackScope" AS ENUM ('SHARED', 'ARABIC', 'LANGUAGE');
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'SUSPENDED_MULTI_DEVICE');
CREATE TYPE "MediaKind" AS ENUM ('VIDEO', 'IMAGE', 'DOCUMENT');
CREATE TYPE "MediaStorage" AS ENUM ('EXTERNAL_URL', 'LOCAL_PRIVATE', 'S3');
CREATE TYPE "Role" AS ENUM ('STUDENT', 'PARENT', 'TEACHER', 'ADMIN');
CREATE TYPE "TeacherApplicationStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'ACTIVATED');
CREATE TYPE "SessionStatus" AS ENUM ('SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED');
CREATE TYPE "AttendanceStatus" AS ENUM ('PRESENT', 'ABSENT', 'LATE', 'EXCUSED');
CREATE TYPE "QuestionType" AS ENUM ('MCQ', 'TRUE_FALSE');
CREATE TYPE "Difficulty" AS ENUM ('EASY', 'MEDIUM', 'HARD');
CREATE TYPE "HomeworkStatus" AS ENUM ('PENDING', 'SUBMITTED', 'GRADED', 'LATE');
CREATE TYPE "ExamType" AS ENUM ('UNIT', 'MONTHLY', 'MOCK', 'FINAL');
CREATE TYPE "SubscriptionStatus" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'CANCELLED');
CREATE TYPE "PaymentMethod" AS ENUM ('INSTAPAY', 'VODAFONE_CASH', 'ETISALAT_CASH');
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE "NotificationType" AS ENUM ('NEW_LESSON', 'NEW_QUIZ', 'QUIZ_RESULT', 'NEW_HOMEWORK', 'HOMEWORK_DEADLINE', 'UPCOMING_SESSION', 'LOW_ATTENDANCE', 'MONTHLY_REPORT', 'SUBSCRIPTION_EXPIRATION', 'ANNOUNCEMENT', 'PAYMENT_APPROVED', 'PAYMENT_REJECTED');

-- 2. Tables, parents before children (migration order).
CREATE TABLE "Coupon" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'PERCENTAGE',
  "value" DOUBLE PRECISION NOT NULL,
  "maxUses" INTEGER NOT NULL DEFAULT 100,
  "usedCount" INTEGER NOT NULL DEFAULT 0,
  "validFrom" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validUntil" TIMESTAMPTZ(3),
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "description" TEXT,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Coupon_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Coupon_code_key" UNIQUE ("code")
);

CREATE TABLE "CouponRedemption" (
  "id" TEXT NOT NULL,
  "couponId" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "paymentId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CouponRedemption_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CouponRedemption_couponId_userId_key" UNIQUE ("couponId", "userId"),
  CONSTRAINT "CouponRedemption_couponId_fkey" FOREIGN KEY ("couponId") REFERENCES "Coupon" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "MediaAsset" (
  "id" TEXT NOT NULL,
  "kind" "MediaKind" NOT NULL DEFAULT 'VIDEO',
  "storage" "MediaStorage" NOT NULL DEFAULT 'EXTERNAL_URL',
  "storageKey" TEXT,
  "externalUrl" TEXT,
  "mimeType" TEXT,
  "sizeBytes" INTEGER,
  "durationSec" INTEGER,
  "originalName" TEXT,
  "isPrivate" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdById" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "NotificationPreference" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "newLesson" BOOLEAN NOT NULL DEFAULT TRUE,
  "newQuiz" BOOLEAN NOT NULL DEFAULT TRUE,
  "quizResult" BOOLEAN NOT NULL DEFAULT TRUE,
  "newHomework" BOOLEAN NOT NULL DEFAULT TRUE,
  "homeworkDeadline" BOOLEAN NOT NULL DEFAULT TRUE,
  "upcomingSession" BOOLEAN NOT NULL DEFAULT TRUE,
  "lowAttendance" BOOLEAN NOT NULL DEFAULT TRUE,
  "monthlyReport" BOOLEAN NOT NULL DEFAULT TRUE,
  "subscriptionExpiration" BOOLEAN NOT NULL DEFAULT TRUE,
  "announcements" BOOLEAN NOT NULL DEFAULT TRUE,
  "emailEnabled" BOOLEAN NOT NULL DEFAULT FALSE,
  "pushEnabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "quietHoursStart" TEXT,
  "quietHoursEnd" TEXT,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "NotificationPreference_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "NotificationPreference_userId_key" UNIQUE ("userId")
);

CREATE TABLE "SecurityRateLimit" (
  "id" TEXT NOT NULL,
  "bucket" TEXT NOT NULL,
  "identifier" TEXT NOT NULL,
  "count" INTEGER NOT NULL DEFAULT 0,
  "windowStart" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "blockedUntil" TIMESTAMPTZ(3),
  CONSTRAINT "SecurityRateLimit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityRateLimit_bucket_identifier_key" UNIQUE ("bucket", "identifier")
);

CREATE TABLE "Setting" (
  "id" TEXT NOT NULL,
  "key" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Setting_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Setting_key_key" UNIQUE ("key")
);

CREATE TABLE "SubscriptionPlan" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "durationMonths" INTEGER NOT NULL,
  "price" DOUBLE PRECISION NOT NULL,
  "isPromo" BOOLEAN NOT NULL DEFAULT FALSE,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "description" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SubscriptionPlan_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TeacherApplication" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "specialty" TEXT,
  "bio" TEXT,
  "status" "TeacherApplicationStatus" NOT NULL DEFAULT 'PENDING',
  "adminNote" TEXT,
  "reviewedByUserId" TEXT,
  "reviewedAt" TIMESTAMPTZ(3),
  "userId" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "TeacherApplication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeacherApplication_email_key" UNIQUE ("email"),
  CONSTRAINT "TeacherApplication_userId_key" UNIQUE ("userId")
);

CREATE TABLE "TeacherActivationToken" (
  "id" TEXT NOT NULL,
  "applicationId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeacherActivationToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeacherActivationToken_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "TeacherActivationToken_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "TeacherApplication" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Track" (
  "id" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Track_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Track_code_key" UNIQUE ("code")
);

CREATE TABLE "Course" (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "description" TEXT NOT NULL,
  "iconUrl" TEXT,
  "color" TEXT NOT NULL DEFAULT '#10b981',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  "trackId" TEXT,
  CONSTRAINT "Course_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Course_slug_key" UNIQUE ("slug"),
  CONSTRAINT "Course_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE "Batch" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "nameAr" TEXT NOT NULL,
  "schoolType" "SchoolType" NOT NULL,
  "courseId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Batch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Batch_schoolType_courseId_key" UNIQUE ("schoolType", "courseId"),
  CONSTRAINT "Batch_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE "MockExam" (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "description" TEXT,
  "schoolType" "SchoolType" NOT NULL,
  "courseId" TEXT,
  "questionCount" INTEGER NOT NULL DEFAULT 10,
  "durationMin" INTEGER NOT NULL DEFAULT 30,
  "passMark" INTEGER NOT NULL DEFAULT 60,
  "difficulty" TEXT NOT NULL DEFAULT 'MIXED',
  "selectionMode" TEXT NOT NULL DEFAULT 'RANDOM',
  "isPublished" BOOLEAN NOT NULL DEFAULT FALSE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "MockExam_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MockExam_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE "Part" (
  "id" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "description" TEXT,
  CONSTRAINT "Part_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Part_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Unit" (
  "id" TEXT NOT NULL,
  "partId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "icon" TEXT,
  CONSTRAINT "Unit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Unit_partId_fkey" FOREIGN KEY ("partId") REFERENCES "Part" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Topic" (
  "id" TEXT NOT NULL,
  "unitId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  CONSTRAINT "Topic_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Topic_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Lesson" (
  "id" TEXT NOT NULL,
  "topicId" TEXT,
  "unitId" TEXT,
  "officialCode" TEXT,
  "curriculumStatus" "CurriculumStatus" NOT NULL DEFAULT 'LEGACY',
  "trackScope" "TrackScope" NOT NULL DEFAULT 'SHARED',
  "status" "LessonStatus" NOT NULL DEFAULT 'DRAFT',
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "order" INTEGER NOT NULL,
  "description" TEXT,
  "summary" TEXT,
  "duration" INTEGER NOT NULL DEFAULT 90,
  "isLocked" BOOLEAN NOT NULL DEFAULT FALSE,
  "isPublished" BOOLEAN NOT NULL DEFAULT TRUE,
  "videoUrl" TEXT,
  "pdfUrl" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Lesson_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Lesson_officialCode_key" UNIQUE ("officialCode"),
  CONSTRAINT "Lesson_topicId_fkey" FOREIGN KEY ("topicId") REFERENCES "Topic" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "Lesson_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE "ExamQuestion" (
  "id" TEXT NOT NULL,
  "lessonId" TEXT,
  "examType" "ExamType" NOT NULL DEFAULT 'UNIT',
  "prompt" TEXT NOT NULL,
  "promptAr" TEXT,
  "options" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "explanation" TEXT,
  "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
  "marks" INTEGER NOT NULL DEFAULT 2,
  "schoolType" "SchoolType",
  CONSTRAINT "ExamQuestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExamQuestion_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Homework" (
  "id" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "trackScope" "TrackScope" NOT NULL DEFAULT 'SHARED',
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "instructions" TEXT,
  "deadline" TIMESTAMPTZ(3) NOT NULL,
  "maxMarks" INTEGER NOT NULL DEFAULT 10,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Homework_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Homework_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Material" (
  "id" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "kind" "MaterialKind" NOT NULL DEFAULT 'GENERATED',
  "title" TEXT NOT NULL,
  "storageKey" TEXT,
  "mediaAssetId" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "trackScope" "TrackScope" NOT NULL DEFAULT 'SHARED',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Material_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Material_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "Material_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE "Quiz" (
  "id" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "trackScope" "TrackScope" NOT NULL DEFAULT 'SHARED',
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "description" TEXT,
  "passMark" INTEGER NOT NULL DEFAULT 60,
  "timeLimit" INTEGER,
  "order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "Quiz_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Quiz_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Question" (
  "id" TEXT NOT NULL,
  "quizId" TEXT,
  "type" "QuestionType" NOT NULL DEFAULT 'MCQ',
  "prompt" TEXT NOT NULL,
  "promptAr" TEXT,
  "options" TEXT NOT NULL,
  "answer" TEXT NOT NULL,
  "explanation" TEXT,
  "difficulty" "Difficulty" NOT NULL DEFAULT 'MEDIUM',
  "marks" INTEGER NOT NULL DEFAULT 1,
  "schoolType" "SchoolType",
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Question_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Question_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "MockExamQuestion" (
  "id" TEXT NOT NULL,
  "mockExamId" TEXT NOT NULL,
  "questionId" TEXT,
  "examQuestionId" TEXT,
  "order" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "MockExamQuestion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MockExamQuestion_mockExamId_questionId_key" UNIQUE ("mockExamId", "questionId"),
  CONSTRAINT "MockExamQuestion_mockExamId_examQuestionId_key" UNIQUE ("mockExamId", "examQuestionId"),
  CONSTRAINT "MockExamQuestion_mockExamId_fkey" FOREIGN KEY ("mockExamId") REFERENCES "MockExam" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "MockExamQuestion_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "MockExamQuestion_examQuestionId_fkey" FOREIGN KEY ("examQuestionId") REFERENCES "ExamQuestion" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "SessionPublication" (
  "id" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "segment" "TrackScope" NOT NULL DEFAULT 'SHARED',
  "publishedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "publishedByUserId" TEXT,
  "notifiedCount" INTEGER NOT NULL DEFAULT 0,
  "notifiedAt" TIMESTAMPTZ(3),
  CONSTRAINT "SessionPublication_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SessionPublication_lessonId_key" UNIQUE ("lessonId"),
  CONSTRAINT "SessionPublication_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "SessionVideo" (
  "id" TEXT NOT NULL,
  "batchId" TEXT NOT NULL,
  "lessonId" TEXT,
  "mediaAssetId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "description" TEXT,
  "requiredPercent" INTEGER NOT NULL DEFAULT 95,
  "isPublished" BOOLEAN NOT NULL DEFAULT FALSE,
  "publishedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "SessionVideo_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SessionVideo_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "SessionVideo_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "SessionVideo_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "role" "Role" NOT NULL DEFAULT 'STUDENT',
  "avatarUrl" TEXT,
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "User_email_key" UNIQUE ("email")
);

CREATE TABLE "AuditLog" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "entity" TEXT,
  "entityId" TEXT,
  "details" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AuditLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Notification" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "type" "NotificationType" NOT NULL,
  "title" TEXT NOT NULL,
  "message" TEXT NOT NULL,
  "isRead" BOOLEAN NOT NULL DEFAULT FALSE,
  "link" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Notification_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Parent" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Parent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Parent_userId_key" UNIQUE ("userId"),
  CONSTRAINT "Parent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "PasswordResetToken" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "channel" TEXT NOT NULL DEFAULT 'EMAIL',
  "destinationMask" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "usedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PasswordResetToken_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "PasswordResetToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "SecurityEvent" (
  "id" TEXT NOT NULL,
  "userId" TEXT,
  "type" TEXT NOT NULL,
  "detail" TEXT,
  "ipHash" TEXT,
  "userAgent" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SecurityEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE "Teacher" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "bio" TEXT,
  "specialty" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Teacher_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Teacher_userId_key" UNIQUE ("userId"),
  CONSTRAINT "Teacher_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Group" (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "teacherId" TEXT,
  "capacity" INTEGER NOT NULL DEFAULT 20,
  "schedule" TEXT NOT NULL DEFAULT 'Sat & Tue, 6:00 PM',
  "isActive" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Group_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Group_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher" ("id") ON UPDATE CASCADE,
  CONSTRAINT "Group_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON UPDATE CASCADE
);

CREATE TABLE "LessonPlanTemplate" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT,
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "description" TEXT,
  "duration" INTEGER NOT NULL DEFAULT 90,
  "objectives" TEXT NOT NULL,
  "materials" TEXT NOT NULL,
  "activities" TEXT NOT NULL,
  "homework" TEXT,
  "assessment" TEXT,
  "isPublic" BOOLEAN NOT NULL DEFAULT TRUE,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "LessonPlanTemplate_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LessonPlanTemplate_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "LiveSession" (
  "id" TEXT NOT NULL,
  "groupId" TEXT NOT NULL,
  "teacherId" TEXT,
  "lessonId" TEXT,
  "title" TEXT NOT NULL,
  "titleAr" TEXT NOT NULL,
  "description" TEXT,
  "startAt" TIMESTAMPTZ(3) NOT NULL,
  "duration" INTEGER NOT NULL DEFAULT 120,
  "meetingUrl" TEXT,
  "recordingUrl" TEXT,
  "status" "SessionStatus" NOT NULL DEFAULT 'SCHEDULED',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LiveSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LiveSession_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE,
  CONSTRAINT "LiveSession_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher" ("id") ON UPDATE CASCADE,
  CONSTRAINT "LiveSession_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Student" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "grade" TEXT NOT NULL DEFAULT '2nd Secondary',
  "schoolName" TEXT,
  "schoolType" "SchoolType",
  "nationalId" TEXT,
  "parentPhone" TEXT,
  "studentCode" TEXT,
  "groupId" TEXT,
  "batchId" TEXT,
  "enrolledAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Student_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Student_userId_key" UNIQUE ("userId"),
  CONSTRAINT "Student_nationalId_key" UNIQUE ("nationalId"),
  CONSTRAINT "Student_studentCode_key" UNIQUE ("studentCode"),
  CONSTRAINT "Student_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON UPDATE CASCADE,
  CONSTRAINT "Student_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "Batch" ("id") ON UPDATE CASCADE ON DELETE SET NULL,
  CONSTRAINT "Student_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Attendance" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "status" "AttendanceStatus" NOT NULL DEFAULT 'PRESENT',
  "note" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Attendance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Attendance_studentId_sessionId_key" UNIQUE ("studentId", "sessionId"),
  CONSTRAINT "Attendance_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "LiveSession" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "Attendance_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Enrollment" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "courseId" TEXT NOT NULL,
  "trackId" TEXT NOT NULL,
  "status" "EnrollmentStatus" NOT NULL DEFAULT 'ACTIVE',
  "startsAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endsAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Enrollment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Enrollment_studentId_courseId_trackId_key" UNIQUE ("studentId", "courseId", "trackId"),
  CONSTRAINT "Enrollment_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "Enrollment_courseId_fkey" FOREIGN KEY ("courseId") REFERENCES "Course" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "Enrollment_trackId_fkey" FOREIGN KEY ("trackId") REFERENCES "Track" ("id") ON UPDATE CASCADE ON DELETE RESTRICT
);

CREATE TABLE "ExamAttempt" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "mockExamId" TEXT,
  "schoolType" "SchoolType",
  "examType" TEXT NOT NULL DEFAULT 'MOCK',
  "questionCount" INTEGER NOT NULL,
  "durationMin" INTEGER NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "totalMarks" INTEGER NOT NULL DEFAULT 0,
  "percentage" INTEGER NOT NULL DEFAULT 0,
  "passed" BOOLEAN NOT NULL DEFAULT FALSE,
  "answers" TEXT NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(3),
  CONSTRAINT "ExamAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ExamAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "ExamAttempt_mockExamId_fkey" FOREIGN KEY ("mockExamId") REFERENCES "MockExam" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE "HomeworkSubmission" (
  "id" TEXT NOT NULL,
  "homeworkId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "content" TEXT,
  "fileUrl" TEXT,
  "submittedAt" TIMESTAMPTZ(3),
  "grade" INTEGER,
  "feedback" TEXT,
  "status" "HomeworkStatus" NOT NULL DEFAULT 'PENDING',
  CONSTRAINT "HomeworkSubmission_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "HomeworkSubmission_homeworkId_studentId_key" UNIQUE ("homeworkId", "studentId"),
  CONSTRAINT "HomeworkSubmission_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "HomeworkSubmission_homeworkId_fkey" FOREIGN KEY ("homeworkId") REFERENCES "Homework" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "LessonBookmark" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LessonBookmark_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LessonBookmark_studentId_lessonId_key" UNIQUE ("studentId", "lessonId"),
  CONSTRAINT "LessonBookmark_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "LessonBookmark_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "LessonNote" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "color" TEXT NOT NULL DEFAULT 'amber',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "LessonNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LessonNote_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "LessonNote_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "LessonProgress" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "lessonId" TEXT NOT NULL,
  "progress" INTEGER NOT NULL DEFAULT 0,
  "isCompleted" BOOLEAN NOT NULL DEFAULT FALSE,
  "lastViewedAt" TIMESTAMPTZ(3),
  "videoDurationSec" INTEGER NOT NULL DEFAULT 0,
  "videoWatchedSec" INTEGER NOT NULL DEFAULT 0,
  "videoPercent" INTEGER NOT NULL DEFAULT 0,
  "videoCompleted" BOOLEAN NOT NULL DEFAULT FALSE,
  "videoCompletedAt" TIMESTAMPTZ(3),
  "lastHeartbeatAt" TIMESTAMPTZ(3),
  CONSTRAINT "LessonProgress_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LessonProgress_studentId_lessonId_key" UNIQUE ("studentId", "lessonId"),
  CONSTRAINT "LessonProgress_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "Lesson" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "LessonProgress_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "ParentStudentLink" (
  "id" TEXT NOT NULL,
  "parentId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "relation" TEXT NOT NULL DEFAULT 'parent',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ParentStudentLink_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ParentStudentLink_parentId_studentId_key" UNIQUE ("parentId", "studentId"),
  CONSTRAINT "ParentStudentLink_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "ParentStudentLink_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Parent" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "QuizAttempt" (
  "id" TEXT NOT NULL,
  "quizId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "score" INTEGER NOT NULL DEFAULT 0,
  "totalMarks" INTEGER NOT NULL DEFAULT 0,
  "percentage" INTEGER NOT NULL DEFAULT 0,
  "passed" BOOLEAN NOT NULL DEFAULT FALSE,
  "startedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt" TIMESTAMPTZ(3),
  "cameraStatus" TEXT NOT NULL DEFAULT 'NOT_REQUESTED',
  CONSTRAINT "QuizAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuizAttempt_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "QuizAttempt_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "Quiz" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "QuizAnswer" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "questionId" TEXT NOT NULL,
  "selected" TEXT NOT NULL,
  "isCorrect" BOOLEAN NOT NULL DEFAULT FALSE,
  CONSTRAINT "QuizAnswer_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuizAnswer_attemptId_questionId_key" UNIQUE ("attemptId", "questionId"),
  CONSTRAINT "QuizAnswer_questionId_fkey" FOREIGN KEY ("questionId") REFERENCES "Question" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "QuizAnswer_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "QuizAttempt" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "QuizAttemptEvidence" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "mediaAssetId" TEXT,
  "kind" TEXT NOT NULL DEFAULT 'SNAPSHOT',
  "status" TEXT,
  "capturedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retainUntil" TIMESTAMPTZ(3),
  CONSTRAINT "QuizAttemptEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "QuizAttemptEvidence_attemptId_fkey" FOREIGN KEY ("attemptId") REFERENCES "QuizAttempt" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "QuizAttemptEvidence_mediaAssetId_fkey" FOREIGN KEY ("mediaAssetId") REFERENCES "MediaAsset" ("id") ON UPDATE CASCADE ON DELETE SET NULL
);

CREATE TABLE "Referral" (
  "id" TEXT NOT NULL,
  "referrerId" TEXT NOT NULL,
  "referredId" TEXT NOT NULL,
  "rewardType" TEXT NOT NULL DEFAULT 'XP',
  "rewardValue" INTEGER NOT NULL DEFAULT 50,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMPTZ(3),
  CONSTRAINT "Referral_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Referral_referrerId_referredId_key" UNIQUE ("referrerId", "referredId"),
  CONSTRAINT "Referral_referredId_fkey" FOREIGN KEY ("referredId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "Referral_referrerId_fkey" FOREIGN KEY ("referrerId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "SessionVideoView" (
  "id" TEXT NOT NULL,
  "sessionVideoId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "watchedSec" INTEGER NOT NULL DEFAULT 0,
  "durationSec" INTEGER NOT NULL DEFAULT 0,
  "percent" INTEGER NOT NULL DEFAULT 0,
  "isCompleted" BOOLEAN NOT NULL DEFAULT FALSE,
  "completedAt" TIMESTAMPTZ(3),
  "lastHeartbeatAt" TIMESTAMPTZ(3),
  CONSTRAINT "SessionVideoView_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SessionVideoView_sessionVideoId_studentId_key" UNIQUE ("sessionVideoId", "studentId"),
  CONSTRAINT "SessionVideoView_sessionVideoId_fkey" FOREIGN KEY ("sessionVideoId") REFERENCES "SessionVideo" ("id") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "SessionVideoView_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "StudentBadge" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "earnedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StudentBadge_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudentBadge_studentId_code_key" UNIQUE ("studentId", "code"),
  CONSTRAINT "StudentBadge_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "StudyTask" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "description" TEXT,
  "lessonId" TEXT,
  "scheduledDate" TIMESTAMPTZ(3) NOT NULL,
  "durationMin" INTEGER NOT NULL DEFAULT 60,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "StudyTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "StudyTask_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Subscription" (
  "id" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "planId" TEXT NOT NULL,
  "status" "SubscriptionStatus" NOT NULL DEFAULT 'PENDING',
  "startDate" TIMESTAMPTZ(3),
  "endDate" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Subscription_studentId_key" UNIQUE ("studentId"),
  CONSTRAINT "Subscription_planId_fkey" FOREIGN KEY ("planId") REFERENCES "SubscriptionPlan" ("id") ON UPDATE CASCADE,
  CONSTRAINT "Subscription_studentId_fkey" FOREIGN KEY ("studentId") REFERENCES "Student" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "Payment" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "subscriptionId" TEXT,
  "amount" DOUBLE PRECISION NOT NULL,
  "method" "PaymentMethod" NOT NULL,
  "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
  "reference" TEXT,
  "notes" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "Payment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Payment_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "Subscription" ("id") ON UPDATE CASCADE,
  CONSTRAINT "Payment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE
);

CREATE TABLE "TeacherNote" (
  "id" TEXT NOT NULL,
  "teacherId" TEXT NOT NULL,
  "studentId" TEXT NOT NULL,
  "note" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TeacherNote_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "TeacherNote_teacherId_fkey" FOREIGN KEY ("teacherId") REFERENCES "Teacher" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

CREATE TABLE "UserSession" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "deviceHash" TEXT NOT NULL,
  "userAgent" TEXT,
  "ipHash" TEXT,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMPTZ(3) NOT NULL,
  "revokedAt" TIMESTAMPTZ(3),
  "revokedReason" TEXT,
  CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "UserSession_tokenHash_key" UNIQUE ("tokenHash"),
  CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON UPDATE CASCADE ON DELETE CASCADE
);

-- 3. Secondary indexes (@@index). Unique constraints are inline above.
CREATE INDEX "CouponRedemption_userId_idx" ON "CouponRedemption" ("userId");
CREATE INDEX "MediaAsset_kind_idx" ON "MediaAsset" ("kind");
CREATE INDEX "MediaAsset_storage_idx" ON "MediaAsset" ("storage");
CREATE INDEX "SecurityRateLimit_windowStart_idx" ON "SecurityRateLimit" ("windowStart");
CREATE INDEX "TeacherApplication_status_createdAt_idx" ON "TeacherApplication" ("status", "createdAt");
CREATE INDEX "TeacherActivationToken_applicationId_usedAt_idx" ON "TeacherActivationToken" ("applicationId", "usedAt");
CREATE INDEX "TeacherActivationToken_expiresAt_idx" ON "TeacherActivationToken" ("expiresAt");
CREATE INDEX "Batch_schoolType_idx" ON "Batch" ("schoolType");
CREATE INDEX "MockExam_schoolType_isPublished_idx" ON "MockExam" ("schoolType", "isPublished");
CREATE INDEX "Part_courseId_idx" ON "Part" ("courseId");
CREATE INDEX "Unit_partId_idx" ON "Unit" ("partId");
CREATE INDEX "Topic_unitId_idx" ON "Topic" ("unitId");
CREATE INDEX "Lesson_topicId_idx" ON "Lesson" ("topicId");
CREATE INDEX "Lesson_unitId_order_idx" ON "Lesson" ("unitId", "order");
CREATE INDEX "Lesson_status_idx" ON "Lesson" ("status");
CREATE INDEX "ExamQuestion_lessonId_idx" ON "ExamQuestion" ("lessonId");
CREATE INDEX "ExamQuestion_schoolType_idx" ON "ExamQuestion" ("schoolType");
CREATE INDEX "Homework_lessonId_idx" ON "Homework" ("lessonId");
CREATE INDEX "Material_lessonId_isActive_idx" ON "Material" ("lessonId", "isActive");
CREATE INDEX "Material_lessonId_trackScope_isActive_idx" ON "Material" ("lessonId", "trackScope", "isActive");
CREATE INDEX "Quiz_lessonId_idx" ON "Quiz" ("lessonId");
CREATE INDEX "Question_quizId_idx" ON "Question" ("quizId");
CREATE INDEX "Question_schoolType_idx" ON "Question" ("schoolType");
CREATE INDEX "MockExamQuestion_mockExamId_idx" ON "MockExamQuestion" ("mockExamId");
CREATE INDEX "SessionPublication_publishedAt_idx" ON "SessionPublication" ("publishedAt");
CREATE INDEX "SessionVideo_batchId_isPublished_idx" ON "SessionVideo" ("batchId", "isPublished");
CREATE INDEX "SessionVideo_lessonId_idx" ON "SessionVideo" ("lessonId");
CREATE INDEX "User_role_idx" ON "User" ("role");
CREATE INDEX "User_status_idx" ON "User" ("status");
CREATE INDEX "AuditLog_userId_idx" ON "AuditLog" ("userId");
CREATE INDEX "Notification_userId_isRead_idx" ON "Notification" ("userId", "isRead");
CREATE INDEX "PasswordResetToken_userId_usedAt_idx" ON "PasswordResetToken" ("userId", "usedAt");
CREATE INDEX "PasswordResetToken_expiresAt_idx" ON "PasswordResetToken" ("expiresAt");
CREATE INDEX "SecurityEvent_userId_createdAt_idx" ON "SecurityEvent" ("userId", "createdAt");
CREATE INDEX "SecurityEvent_type_createdAt_idx" ON "SecurityEvent" ("type", "createdAt");
CREATE INDEX "Group_courseId_idx" ON "Group" ("courseId");
CREATE INDEX "LiveSession_groupId_idx" ON "LiveSession" ("groupId");
CREATE INDEX "LiveSession_startAt_idx" ON "LiveSession" ("startAt");
CREATE INDEX "Student_schoolType_idx" ON "Student" ("schoolType");
CREATE INDEX "Student_groupId_idx" ON "Student" ("groupId");
CREATE INDEX "Student_batchId_idx" ON "Student" ("batchId");
CREATE INDEX "Attendance_studentId_idx" ON "Attendance" ("studentId");
CREATE INDEX "Enrollment_courseId_trackId_status_idx" ON "Enrollment" ("courseId", "trackId", "status");
CREATE INDEX "ExamAttempt_studentId_examType_idx" ON "ExamAttempt" ("studentId", "examType");
CREATE INDEX "ExamAttempt_finishedAt_idx" ON "ExamAttempt" ("finishedAt");
CREATE INDEX "ExamAttempt_mockExamId_idx" ON "ExamAttempt" ("mockExamId");
CREATE INDEX "HomeworkSubmission_studentId_idx" ON "HomeworkSubmission" ("studentId");
CREATE INDEX "LessonBookmark_studentId_idx" ON "LessonBookmark" ("studentId");
CREATE INDEX "LessonNote_studentId_idx" ON "LessonNote" ("studentId");
CREATE INDEX "LessonProgress_studentId_idx" ON "LessonProgress" ("studentId");
CREATE INDEX "LessonProgress_lessonId_idx" ON "LessonProgress" ("lessonId");
CREATE INDEX "LessonProgress_videoCompleted_idx" ON "LessonProgress" ("videoCompleted");
CREATE INDEX "QuizAttempt_quizId_studentId_idx" ON "QuizAttempt" ("quizId", "studentId");
CREATE INDEX "QuizAttempt_studentId_idx" ON "QuizAttempt" ("studentId");
CREATE INDEX "QuizAnswer_attemptId_idx" ON "QuizAnswer" ("attemptId");
CREATE INDEX "QuizAnswer_questionId_idx" ON "QuizAnswer" ("questionId");
CREATE INDEX "QuizAttemptEvidence_attemptId_capturedAt_idx" ON "QuizAttemptEvidence" ("attemptId", "capturedAt");
CREATE INDEX "QuizAttemptEvidence_retainUntil_idx" ON "QuizAttemptEvidence" ("retainUntil");
CREATE INDEX "Referral_referrerId_idx" ON "Referral" ("referrerId");
CREATE INDEX "SessionVideoView_studentId_idx" ON "SessionVideoView" ("studentId");
CREATE INDEX "SessionVideoView_isCompleted_idx" ON "SessionVideoView" ("isCompleted");
CREATE INDEX "StudentBadge_studentId_idx" ON "StudentBadge" ("studentId");
CREATE INDEX "StudyTask_studentId_scheduledDate_idx" ON "StudyTask" ("studentId", "scheduledDate");
CREATE INDEX "Subscription_status_idx" ON "Subscription" ("status");
CREATE INDEX "UserSession_userId_revokedAt_idx" ON "UserSession" ("userId", "revokedAt");
CREATE INDEX "UserSession_expiresAt_idx" ON "UserSession" ("expiresAt");
CREATE INDEX "UserSession_deviceHash_idx" ON "UserSession" ("deviceHash");
