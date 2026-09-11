// CodeMind Academy — Phase 21: production-shaped rehearsal fixtures.
//
// Builds a SCRATCH SQLite database (OS temp dir — never the real DB) at the
// CURRENT migration head (base DDL derived from prisma/schema.prisma + every
// real migration.sql in order, via scripts/lib/migrate-sqlite.mjs), then
// inserts a deterministic, production-shaped row set covering ALL 55 tables:
//   * official curriculum (Course/Part/Unit/Lesson OFFICIAL+PUBLISHED) + legacy
//   * users in every role, students in both school types, parent linkage
//   * progress, quiz attempts + answers, homework, mock-exam attempts
//   * media metadata (external + private), session videos + views, materials
//   * notifications, subscriptions, payments, coupons, referrals
//   * Teacher Applications in all four lifecycle states + activation tokens
//   * security/audit history (UserSession, PasswordResetToken,
//     SecurityRateLimit, SecurityEvent, AuditLog)
//   * quiz camera evidence (expired / live / status-only) for retention tests
//
// IDs are fixed readable strings (proving verbatim ID preservation) and
// timestamps are fixed, except where a test needs a relative date (those are
// computed from Date.now() and documented at the row).
//
// Two rows deliberately use NON-canonical SQLite DateTime encodings (a naive
// "YYYY-MM-DD HH:MM:SS" string and an INTEGER millisecond epoch) to prove the
// migrator's tolerant UTC parsing. Everything else uses ISO-8601 UTC.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { baseSchemaDdl, applyMigrations, assertColumnsMatchSchema } from "../lib/migrate-sqlite.mjs";
import { parseSchema, migrationOrder, scalarFields } from "./pg-lib.mjs";

const T0 = "2026-08-01T10:00:00.000Z";
const T1 = "2026-08-15T12:30:00.000Z";
const T2 = "2026-09-01T09:00:00.000Z";
const T3 = "2026-09-10T18:45:00.000Z";
const FUTURE = "2027-06-01T00:00:00.000Z";
const PAST = "2026-01-15T00:00:00.000Z";
// Deliberately non-canonical encodings (same instants as T2 / a fixed epoch).
const NAIVE_T2 = "2026-09-01 09:00:00";
const MS_T1 = Date.parse(T1);

export function buildFixtureSqlite(dbPath = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cm-p21-src-"));
  const file = dbPath || path.join(dir, "source.db");
  const db = new DatabaseSync(file);
  try {
    for (const stmt of splitSql(baseSchemaDdl())) db.exec(stmt);
    const applied = applyMigrations(db, { label: "[fixtures] ", withBaseSchema: false });
    void applied;
    // Prove the scratch source is EXACTLY the current schema before fixtures.
    const { models } = parseSchema();
    const tables = [...models.keys()];
    const mism = assertColumnsMatchSchema(db, tables).filter((r) => r.missing?.length || r.extra?.length);
    if (mism.length) {
      throw new Error(`fixtures: scratch schema mismatch: ${JSON.stringify(mism.slice(0, 3))}`);
    }
    db.exec("PRAGMA foreign_keys = ON");
    insertFixtures(db);
    const counts = {};
    for (const t of tables) {
      counts[t] = db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get().n;
    }
    return { file, dir, counts };
  } finally {
    db.close();
  }
}

function splitSql(sql) {
  // Base DDL is machine-generated (no exotic literals); a small splitter suffices.
  return sql.split(";").map((s) => s.trim()).filter(Boolean);
}

function insertFixtures(db) {
  const run = (sql, ...params) => db.prepare(sql).run(...params);

  // ---- identity: 6 users (admin, 2 teachers, 2 students, 1 parent) ----
  const users = [
    ["p21-u-admin", "admin@example.com", "salt:hash-admin", "Admin User", "ADMIN"],
    ["p21-u-t1", "teacher1@example.com", "salt:hash-t1", "Teacher One", "TEACHER"],
    ["p21-u-t2", "activated-teacher@example.com", "salt:hash-t2", "Activated Teacher", "TEACHER"],
    ["p21-u-s1", "student1@example.com", "salt:hash-s1", "Student One", "STUDENT"],
    ["p21-u-s2", "student2@example.com", "salt:hash-s2", "Student Two", "STUDENT"],
    ["p21-u-p1", "parent1@example.com", "salt:hash-p1", "Parent One", "PARENT"],
  ];
  for (const [id, email, pw, name, role] of users) {
    run(`INSERT INTO "User" ("id","email","password","name","role","isActive","status","createdAt","updatedAt")
         VALUES (?,?,?,?,?,1,'ACTIVE',?,?)`, id, email, pw, name, role, T0, T0);
  }
  run(`INSERT INTO "Teacher" ("id","userId","bio","specialty","createdAt","updatedAt")
       VALUES ('p21-t1','p21-u-t1','Physics teacher','Physics',?,?)`, T0, T0);
  run(`INSERT INTO "Teacher" ("id","userId","bio","specialty","createdAt","updatedAt")
       VALUES ('p21-t2','p21-u-t2','AI teacher','AI',?,?)`, T2, T2);
  run(`INSERT INTO "Parent" ("id","userId","createdAt","updatedAt") VALUES ('p21-p1','p21-u-p1',?,?)`, T0, T0);

  // ---- curriculum: 1 course, 1 part, 1 unit, 1 topic, 3 lessons ----
  run(`INSERT INTO "Course" ("id","slug","name","nameAr","description","color","createdAt","updatedAt")
       VALUES ('p21-c1','programming-ai-2nd-sec','Programming & AI','البرمجة والذكاء الاصطناعي','Official course','#10b981',?,?)`, T0, T0);
  run(`INSERT INTO "Part" ("id","courseId","title","titleAr","order") VALUES ('p21-part1','p21-c1','Part 1','الجزء الأول',1)`);
  run(`INSERT INTO "Unit" ("id","partId","title","titleAr","order") VALUES ('p21-unit1','p21-part1','Unit 1','الوحدة الأولى',1)`);
  run(`INSERT INTO "Topic" ("id","unitId","title","titleAr","order") VALUES ('p21-topic1','p21-unit1','Legacy topic','موضوع قديم',1)`);
  // Two official PUBLISHED sessions + one legacy row (never in the universe).
  run(`INSERT INTO "Lesson" ("id","unitId","officialCode","curriculumStatus","trackScope","status","title","titleAr","order","duration","isLocked","isPublished","createdAt","updatedAt")
       VALUES ('p21-l1','p21-unit1','1-1','OFFICIAL','SHARED','PUBLISHED','Intro to AI','مقدمة في الذكاء الاصطناعي',1,90,0,1,?,?)`, T0, T1);
  run(`INSERT INTO "Lesson" ("id","unitId","officialCode","curriculumStatus","trackScope","status","title","titleAr","order","duration","isLocked","isPublished","createdAt","updatedAt")
       VALUES ('p21-l2','p21-unit1','1-2','OFFICIAL','LANGUAGE','PUBLISHED','Data Basics','أساسيات البيانات',2,90,0,1,?,?)`, T0, T1);
  run(`INSERT INTO "Lesson" ("id","topicId","curriculumStatus","trackScope","status","title","titleAr","order","duration","isLocked","isPublished","createdAt","updatedAt")
       VALUES ('p21-llegacy','p21-topic1','LEGACY','SHARED','DRAFT','What is IT?','ما هي تقنية المعلومات؟',99,90,1,0,?,?)`, T0, T0);
  run(`INSERT INTO "SessionPublication" ("id","lessonId","segment","publishedAt","publishedByUserId","notifiedCount","notifiedAt")
       VALUES ('p21-pub1','p21-l1','SHARED',?,?,2,?)`, T1, "p21-u-admin", T2);

  // ---- dead schema (Phase 12 verdict): still preserved 1:1 ----
  run(`INSERT INTO "Track" ("id","code","name","nameAr","isActive","createdAt","updatedAt")
       VALUES ('p21-tr1','ARABIC','Arabic track','المسار العربي',1,?,?)`, T0, T0);

  // ---- groups, batches, students ----
  run(`INSERT INTO "Group" ("id","name","courseId","teacherId","capacity","schedule","isActive","createdAt","updatedAt")
       VALUES ('p21-g1','Group A','p21-c1','p21-t1',20,'Sat & Tue, 6:00 PM',1,?,?)`, T0, T0);
  run(`INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt")
       VALUES ('p21-b-ar','Batch AR','دفعة عربي','ARABIC','p21-c1',1,?,?)`, T0, T0);
  run(`INSERT INTO "Batch" ("id","name","nameAr","schoolType","courseId","isActive","createdAt","updatedAt")
       VALUES ('p21-b-lang','Batch LANG','دفعة لغات','LANGUAGE','p21-c1',1,?,?)`, T0, T0);
  run(`INSERT INTO "Student" ("id","userId","grade","schoolType","nationalId","parentPhone","studentCode","groupId","batchId","enrolledAt","createdAt","updatedAt")
       VALUES ('p21-s1','p21-u-s1','2nd Secondary','ARABIC','29001011234567','01011112222','CM-000001','p21-g1','p21-b-ar',?,?,?)`, T0, T0, T0);
  run(`INSERT INTO "Student" ("id","userId","grade","schoolType","nationalId","parentPhone","studentCode","groupId","batchId","enrolledAt","createdAt","updatedAt")
       VALUES ('p21-s2','p21-u-s2','2nd Secondary','LANGUAGE','29002021234568','01222223333','CM-000002','p21-g1','p21-b-lang',?,?,?)`, T0, T0, T0);
  run(`INSERT INTO "ParentStudentLink" ("id","parentId","studentId","relation","createdAt")
       VALUES ('p21-link1','p21-p1','p21-s1','parent',?)`, T0);
  run(`INSERT INTO "Enrollment" ("id","studentId","courseId","trackId","status","startsAt","createdAt")
       VALUES ('p21-enr1','p21-s1','p21-c1','p21-tr1','ACTIVE',?,?)`, T0, T0);

  // ---- progress, quizzes, homework, mock exams ----
  run(`INSERT INTO "LessonProgress" ("id","studentId","lessonId","progress","isCompleted","videoDurationSec","videoWatchedSec","videoPercent","videoCompleted","videoCompletedAt")
       VALUES ('p21-lp1','p21-s1','p21-l1',100,1,600,600,100,1,?)`, T2);
  run(`INSERT INTO "LessonProgress" ("id","studentId","lessonId","progress","isCompleted","videoDurationSec","videoWatchedSec","videoPercent","videoCompleted")
       VALUES ('p21-lp2','p21-s2','p21-l1',40,0,600,240,40,0)`);
  run(`INSERT INTO "Quiz" ("id","lessonId","trackScope","title","titleAr","passMark","order")
       VALUES ('p21-q1','p21-l1','SHARED','Session 1 quiz','اختبار الحصة الأولى',60,1)`);
  const OPTS = JSON.stringify([" ram ", "CPU", "GPU", "SSD"]);
  run(`INSERT INTO "Question" ("id","quizId","type","prompt","promptAr","options","answer","difficulty","marks","createdAt")
       VALUES ('p21-qn1','p21-q1','MCQ','What runs programs?','ما الذي يشغّل البرامج؟',?,'CPU','EASY',1,?)`, OPTS, T0);
  run(`INSERT INTO "Question" ("id","quizId","type","prompt","options","answer","difficulty","marks","schoolType","createdAt")
       VALUES ('p21-qn2','p21-q1','MCQ','What stores data long-term?','["RAM","CPU","SSD","Cache"]','SSD','MEDIUM',2,'ARABIC',?)`, T0);
  run(`INSERT INTO "Question" ("id","quizId","type","prompt","options","answer","difficulty","marks","createdAt")
       VALUES ('p21-qn3','p21-q1','TRUE_FALSE','AI can learn from data.','["True","False"]','True','EASY',1,?)`, T0);
  run(`INSERT INTO "QuizAttempt" ("id","quizId","studentId","score","totalMarks","percentage","passed","startedAt","finishedAt","cameraStatus")
       VALUES ('p21-att1','p21-q1','p21-s1',3,4,75,1,?,?, 'COMPLETED')`, T2, T3);
  run(`INSERT INTO "QuizAttempt" ("id","quizId","studentId","score","totalMarks","percentage","passed","startedAt","cameraStatus")
       VALUES ('p21-att2','p21-q1','p21-s2',0,0,0,0,?,'IN_PROGRESS')`, T3);
  run(`INSERT INTO "QuizAnswer" ("id","attemptId","questionId","selected","isCorrect")
       VALUES ('p21-ans1','p21-att1','p21-qn1','CPU',1)`);
  run(`INSERT INTO "QuizAnswer" ("id","attemptId","questionId","selected","isCorrect")
       VALUES ('p21-ans2','p21-att1','p21-qn2','SSD',1)`);
  run(`INSERT INTO "QuizAnswer" ("id","attemptId","questionId","selected","isCorrect")
       VALUES ('p21-ans3','p21-att2','p21-qn1','0',0)`);
  run(`INSERT INTO "Homework" ("id","lessonId","trackScope","title","titleAr","deadline","maxMarks","createdAt")
       VALUES ('p21-hw1','p21-l1','SHARED','Worksheet 1','ورقة عمل 1',?,10,?)`, FUTURE, T1);
  run(`INSERT INTO "HomeworkSubmission" ("id","homeworkId","studentId","content","submittedAt","status")
       VALUES ('p21-hws1','p21-hw1','p21-s1','My answers…',?,'SUBMITTED')`, T3);
  run(`INSERT INTO "ExamQuestion" ("id","lessonId","examType","prompt","options","answer","difficulty","marks","schoolType")
       VALUES ('p21-eq1','p21-l1','UNIT','Unit review Q1','["A","B","C","D"]','B','MEDIUM',2,'ARABIC')`);
  run(`INSERT INTO "MockExam" ("id","title","titleAr","schoolType","courseId","questionCount","durationMin","passMark","difficulty","selectionMode","isPublished","createdAt","updatedAt")
       VALUES ('p21-mock1','Mock 1','امتحان تجريبي 1','ARABIC','p21-c1',10,30,60,'MIXED','FIXED',1,?,?)`, T1, T1);
  run(`INSERT INTO "MockExamQuestion" ("id","mockExamId","questionId","order") VALUES ('p21-mq1','p21-mock1','p21-qn1',0)`);
  run(`INSERT INTO "MockExamQuestion" ("id","mockExamId","examQuestionId","order") VALUES ('p21-mq2','p21-mock1','p21-eq1',1)`);
  const ANSWERS = JSON.stringify([{ q: "p21-qn1", selected: "CPU", correct: true }]);
  run(`INSERT INTO "ExamAttempt" ("id","studentId","mockExamId","schoolType","examType","questionCount","durationMin","score","totalMarks","percentage","passed","answers","startedAt","finishedAt")
       VALUES ('p21-ex1','p21-s1','p21-mock1','ARABIC','MOCK',1,30,2,2,100,1,?,?,?)`, ANSWERS, T2, T3);
  run(`INSERT INTO "ExamAttempt" ("id","studentId","examType","questionCount","durationMin","score","totalMarks","percentage","passed","answers","startedAt","finishedAt")
       VALUES ('p21-ex2','p21-s2','MOCK',1,30,0,2,0,0,'[]',?,?)`, T2, T3);

  // ---- media: external URL + private uploads ----
  run(`INSERT INTO "MediaAsset" ("id","kind","storage","externalUrl","isPrivate","createdAt")
       VALUES ('p21-ma-ext','VIDEO','EXTERNAL_URL','https://www.youtube.com/watch?v=dQw4w9WgXcQ',0,?)`, T1);
  run(`INSERT INTO "MediaAsset" ("id","kind","storage","storageKey","mimeType","sizeBytes","originalName","isPrivate","createdById","createdAt")
       VALUES ('p21-ma-pdf','DOCUMENT','LOCAL_PRIVATE','materials/p21-l1.pdf','application/pdf',18432,'session-1-1.pdf',1,'p21-u-admin',?)`, T1);
  run(`INSERT INTO "MediaAsset" ("id","kind","storage","storageKey","mimeType","sizeBytes","originalName","isPrivate","createdAt")
       VALUES ('p21-ma-img','IMAGE','LOCAL_PRIVATE','evidence/p21-e1.jpg','image/jpeg',48210,'snapshot.jpg',1,?)`, T3);
  run(`INSERT INTO "SessionVideo" ("id","batchId","lessonId","mediaAssetId","title","titleAr","requiredPercent","isPublished","publishedAt","createdAt","updatedAt")
       VALUES ('p21-sv1','p21-b-ar','p21-l1','p21-ma-ext','Session 1 video','فيديو الحصة الأولى',95,1,?,?,?)`, T2, T1, T2);
  run(`INSERT INTO "SessionVideoView" ("id","sessionVideoId","studentId","watchedSec","durationSec","percent","isCompleted","completedAt","lastHeartbeatAt")
       VALUES ('p21-svv1','p21-sv1','p21-s1',600,600,100,1,?,?)`, T3, T3);
  run(`INSERT INTO "Material" ("id","lessonId","kind","title","storageKey","mediaAssetId","isActive","trackScope","createdAt","updatedAt")
       VALUES ('p21-mat1','p21-l1','ADMIN_UPLOADED','Session 1 PDF','materials/p21-l1.pdf','p21-ma-pdf',1,'SHARED',?,?)`, T1, T1);
  run(`INSERT INTO "Material" ("id","lessonId","kind","title","isActive","trackScope","createdAt","updatedAt")
       VALUES ('p21-mat2','p21-l2','GENERATED','Generated notes',1,'LANGUAGE',?,?)`, T1, T1);

  // ---- sessions, attendance, teacher workflow ----
  run(`INSERT INTO "LiveSession" ("id","groupId","teacherId","lessonId","title","titleAr","startAt","duration","status","createdAt")
       VALUES ('p21-ls1','p21-g1','p21-t1','p21-l1','Live Q&A','لقاء مباشر',?,120,'SCHEDULED',?)`, FUTURE, T2);
  run(`INSERT INTO "Attendance" ("id","studentId","sessionId","status","createdAt")
       VALUES ('p21-at1','p21-s1','p21-ls1','PRESENT',?)`, T3);
  run(`INSERT INTO "TeacherNote" ("id","teacherId","studentId","note","createdAt")
       VALUES ('p21-tn1','p21-t1','p21-s1','Excellent progress',?)`, T3);
  run(`INSERT INTO "LessonPlanTemplate" ("id","teacherId","title","titleAr","duration","objectives","materials","activities","isPublic","createdAt","updatedAt")
       VALUES ('p21-tpl1','p21-t1','AI intro plan','خطة مقدمة الذكاء',90,'Objectives','Materials','Activities',1,?,?)`, T0, T0);

  // ---- engagement: badges, bookmarks, notes, tasks, referrals, coupons ----
  run(`INSERT INTO "StudentBadge" ("id","studentId","code","earnedAt") VALUES ('p21-bdg1','p21-s1','first-lesson',?)`, T2);
  run(`INSERT INTO "LessonBookmark" ("id","studentId","lessonId","createdAt") VALUES ('p21-bm1','p21-s1','p21-l1',?)`, T2);
  run(`INSERT INTO "LessonNote" ("id","studentId","lessonId","content","color","createdAt","updatedAt")
       VALUES ('p21-ln1','p21-s1','p21-l1','Remember: CPU runs programs','amber',?,?)`, T2, T2);
  run(`INSERT INTO "StudyTask" ("id","studentId","title","lessonId","scheduledDate","durationMin","status","createdAt","updatedAt")
       VALUES ('p21-st1','p21-s1','Revise session 1','p21-l1',?,60,'PENDING',?,?)`, FUTURE, T2, T2);
  run(`INSERT INTO "StudyTask" ("id","studentId","title","scheduledDate","durationMin","status","createdAt","updatedAt")
       VALUES ('p21-st2','p21-s2','Mock exam practice',?,90,'DONE',?,?)`, T3, T2, T3);
  run(`INSERT INTO "Referral" ("id","referrerId","referredId","rewardType","rewardValue","status","createdAt")
       VALUES ('p21-ref1','p21-s1','p21-s2','XP',50,'COMPLETED',?)`, T2);
  run(`INSERT INTO "Coupon" ("id","code","type","value","maxUses","usedCount","validFrom","isActive","createdAt","updatedAt")
       VALUES ('p21-cpn1','SAVE10','PERCENTAGE',10,100,1,?,1,?,?)`, T0, T0, T0);
  run(`INSERT INTO "CouponRedemption" ("id","couponId","userId","createdAt") VALUES ('p21-cpnr1','p21-cpn1','p21-u-s1',?)`, T2);

  // ---- money: plans, subscriptions, payments ----
  run(`INSERT INTO "SubscriptionPlan" ("id","name","nameAr","durationMonths","price","isPromo","isActive","createdAt")
       VALUES ('p21-plan1','Monthly','شهري',1,299.0,0,1,?)`, T0);
  run(`INSERT INTO "Subscription" ("id","studentId","planId","status","startDate","endDate","createdAt","updatedAt")
       VALUES ('p21-sub1','p21-s1','p21-plan1','ACTIVE',?,?,?,?)`, T1, FUTURE, T1, T1);
  run(`INSERT INTO "Payment" ("id","userId","subscriptionId","amount","method","status","reference","createdAt","updatedAt")
       VALUES ('p21-pay1','p21-u-s1','p21-sub1',299.0,'INSTAPAY','APPROVED','TXN-1',?,?)`, T1, T1);
  run(`INSERT INTO "Payment" ("id","userId","amount","method","status","createdAt","updatedAt")
       VALUES ('p21-pay2','p21-u-s2',299.0,'VODAFONE_CASH','PENDING',?,?)`, T3, T3);

  // ---- notifications + preferences ----
  run(`INSERT INTO "Notification" ("id","userId","type","title","message","isRead","link","createdAt")
       VALUES ('p21-n1','p21-u-s1','NEW_LESSON','New session','Session 1-1 is open',0,'lesson/p21-l1',?)`, T2);
  run(`INSERT INTO "Notification" ("id","userId","type","title","message","isRead","createdAt")
       VALUES ('p21-n2','p21-u-s1','ANNOUNCEMENT','Welcome','Welcome to CodeMind',1,?)`, T0);
  run(`INSERT INTO "Notification" ("id","userId","type","title","message","isRead","createdAt")
       VALUES ('p21-n3','p21-u-admin','PAYMENT_APPROVED','Payment approved','TXN-1 approved',0,?)`, T1);
  run(`INSERT INTO "NotificationPreference" ("id","userId","newLesson","newQuiz","quizResult","newHomework","homeworkDeadline","upcomingSession","lowAttendance","monthlyReport","subscriptionExpiration","announcements","emailEnabled","pushEnabled","updatedAt")
       VALUES ('p21-np1','p21-u-s1',1,1,1,1,1,1,1,1,1,1,0,1,?)`, T0);

  // ---- audit + settings ----
  // NOTE: p21-al1 uses the NAIVE datetime encoding on purpose (tolerant-parse proof).
  run(`INSERT INTO "AuditLog" ("id","userId","action","entity","entityId","details","createdAt")
       VALUES ('p21-al1','p21-u-admin','LESSON_OPEN','Lesson','p21-l1','{}',?)`, NAIVE_T2);
  run(`INSERT INTO "AuditLog" ("id","userId","action","entity","entityId","createdAt")
       VALUES ('p21-al2','p21-u-admin','TEACHER_APPROVE','TeacherApplication','p21-ap-ok',?)`, T2);
  run(`INSERT INTO "AuditLog" ("id","userId","action","createdAt")
       VALUES ('p21-al3','p21-u-s1','LOGIN',?)`, T2);
  run(`INSERT INTO "Setting" ("id","key","value","updatedAt") VALUES ('p21-set1','brand_name','CodeMind',?)`, T0);
  run(`INSERT INTO "Setting" ("id","key","value","updatedAt") VALUES ('p21-set2','academic_year','2026/2027',?)`, T0);

  // ---- Phase 20 security persistence ----
  run(`INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","userAgent","createdAt","lastSeenAt","expiresAt")
       VALUES ('p21-sess1','p21-u-s1','${"a".repeat(64)}','devicehashs1','Mozilla/5.0',?,?,?)`, T3, T3, FUTURE);
  run(`INSERT INTO "UserSession" ("id","userId","tokenHash","deviceHash","createdAt","lastSeenAt","expiresAt","revokedAt","revokedReason")
       VALUES ('p21-sess2','p21-u-s2','${"b".repeat(64)}','devicehashs2',?,?,?,?,'MULTI_DEVICE')`, T2, T2, FUTURE, T3);
  run(`INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","channel","destinationMask","attempts","expiresAt","createdAt")
       VALUES ('p21-prt1','p21-u-s1','${"c".repeat(64)}','EMAIL','s***@example.com',0,?,?)`, FUTURE, T3);
  run(`INSERT INTO "PasswordResetToken" ("id","userId","tokenHash","channel","attempts","expiresAt","usedAt","createdAt")
       VALUES ('p21-prt2','p21-u-s2','${"d".repeat(64)}','EMAIL',1,?,?,?)`, FUTURE, T3, T2);
  run(`INSERT INTO "SecurityRateLimit" ("id","bucket","identifier","count","windowStart")
       VALUES ('p21-rl1','login:id','idhashs1',3,?)`, T3);
  run(`INSERT INTO "SecurityRateLimit" ("id","bucket","identifier","count","windowStart","blockedUntil")
       VALUES ('p21-rl2','teacherApply','emailhash1',5,?,?)`, T3, FUTURE);
  // NOTE: p21-se5 uses INTEGER-ms createdAt on purpose (tolerant-parse proof).
  const events = [
    ["p21-se1", "p21-u-s1", "LOGIN_SUCCESS", "email", T2],
    ["p21-se2", null, "TEACHER_APPLICATION_SUBMITTED", "email=pending@example.com", T2],
    ["p21-se3", null, "RATE_LIMITED", "limiter=teacherApply", T3],
    ["p21-se4", "p21-u-t2", "TEACHER_ACTIVATION_COMPLETED", "application=p21-ap-act", T2],
    ["p21-se5", "p21-u-admin", "MATERIAL_ACCESSED", "material=p21-mat1", MS_T1],
  ];
  for (const [id, userId, type, detail, createdAt] of events) {
    run(`INSERT INTO "SecurityEvent" ("id","userId","type","detail","createdAt") VALUES (?,?,?,?,?)`,
      id, userId, type, detail, createdAt);
  }

  // ---- Teacher Applications: all four lifecycle states ----
  run(`INSERT INTO "TeacherApplication" ("id","email","name","phone","specialty","bio","status","createdAt","updatedAt")
       VALUES ('p21-ap-pending','pending@example.com','Pending Applicant','01000000001','Math','Bio', 'PENDING',?,?)`, T3, T3);
  run(`INSERT INTO "TeacherApplication" ("id","email","name","status","adminNote","reviewedByUserId","reviewedAt","createdAt","updatedAt")
       VALUES ('p21-ap-rej','rejected@example.com','Rejected Applicant','REJECTED','Incomplete profile','p21-u-admin',?,?,?)`, T2, T2, T2);
  run(`INSERT INTO "TeacherApplication" ("id","email","name","status","reviewedByUserId","reviewedAt","createdAt","updatedAt")
       VALUES ('p21-ap-ok','approved@example.com','Approved Applicant','APPROVED','p21-u-admin',?,?,?)`, T2, T2, T2);
  run(`INSERT INTO "TeacherApplication" ("id","email","name","status","reviewedByUserId","reviewedAt","userId","createdAt","updatedAt")
       VALUES ('p21-ap-act','activated-teacher@example.com','Activated Teacher','ACTIVATED','p21-u-admin',?,'p21-u-t2',?,?)`, T2, T1, T2);
  // Rejected: token rescinded (usedAt set). Approved: one LIVE token.
  // Activated: token consumed (usedAt set).
  run(`INSERT INTO "TeacherActivationToken" ("id","applicationId","tokenHash","expiresAt","usedAt","createdAt")
       VALUES ('p21-tok-rej','p21-ap-rej','${"e".repeat(64)}',?,?,?)`, FUTURE, T2, T2);
  run(`INSERT INTO "TeacherActivationToken" ("id","applicationId","tokenHash","expiresAt","createdAt")
       VALUES ('p21-tok-ok','p21-ap-ok','${"f".repeat(64)}',?,?)`, FUTURE, T2);
  run(`INSERT INTO "TeacherActivationToken" ("id","applicationId","tokenHash","expiresAt","usedAt","createdAt")
       VALUES ('p21-tok-act','p21-ap-act','${"9".repeat(64)}',?,?,?)`, FUTURE, T2, T1);

  // ---- quiz camera evidence: expired / live / status-only ----
  run(`INSERT INTO "QuizAttemptEvidence" ("id","attemptId","mediaAssetId","kind","capturedAt","retainUntil")
       VALUES ('p21-ev-expired','p21-att1','p21-ma-img','SNAPSHOT',?,?)`, T2, PAST);
  run(`INSERT INTO "QuizAttemptEvidence" ("id","attemptId","mediaAssetId","kind","capturedAt","retainUntil")
       VALUES ('p21-ev-live','p21-att1','p21-ma-img','SNAPSHOT',?,?)`, T3, FUTURE);
  run(`INSERT INTO "QuizAttemptEvidence" ("id","attemptId","kind","status","capturedAt")
       VALUES ('p21-ev-status','p21-att2','STATUS','NO_CAMERA',?)`, T3);
}

export { T0, T1, T2, T3, FUTURE, PAST };
