import { PrismaClient, Role } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";
import readline from "node:readline";

// CodeMind Academy — Production Database Setup (Phase 21 revision).
//
// ONE-TIME initial-production reset: empties a database that currently holds
// demo/test/development data, then creates ONE real Admin interactively.
// Preserved: Settings, SubscriptionPlans.
//
// Phase 21 changes vs the previous version:
//   * Covers EVERY table added by Phases 11-20 (videos, mock exams,
//     enrollments, materials, publications, Teacher Applications, activation
//     tokens, sessions, reset tokens, rate limits, security events, evidence).
//     The old script left MockExam / SessionVideo / MediaAsset / Batch /
//     security rows behind (stale production state).
//   * Deletion order is safe on BOTH SQLite and PostgreSQL. Several relations
//     have NO database cascade (e.g. Student.groupId -> Group,
//     Payment.userId -> User), so children are deleted before parents
//     explicitly instead of relying on cascades.
//   * Provider-aware: prints the datasource provider + redacted URL and a
//     per-table count summary BEFORE asking for confirmation, and supports
//     --dry-run (report only, change nothing).
//   * Still creates NO teacher: teacher provisioning happens ONLY through the
//     Phase 20 application -> approval -> activation flow. No hardcoded
//     passwords anywhere; the admin password is prompted and hashed.
//
// OWNERSHIP: Phase 22 owns the final production baseline cleanup and
// allowlist. This script is the TOOL Phase 22 will use; Phase 21 only makes
// it complete and provider-safe. Do NOT run it against a live production
// database as part of Phase 21.

const prisma = new PrismaClient();

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function redactUrl(url: string | undefined): string {
  if (!url) return "(unset)";
  if (url.startsWith("file:") || url.endsWith(".db")) return url;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return "(unparseable)";
  }
}

async function tableCounts(): Promise<{ table: string; rows: number }[]> {
  // Every model in dependency-irrelevant order (counts only).
  const delegates: [string, { count: () => Promise<number> }][] = [
    ["User", prisma.user],
    ["Student", prisma.student],
    ["Parent", prisma.parent],
    ["ParentStudentLink", prisma.parentStudentLink],
    ["Teacher", prisma.teacher],
    ["StudentBadge", prisma.studentBadge],
    ["Track", prisma.track],
    ["Enrollment", prisma.enrollment],
    ["Course", prisma.course],
    ["Part", prisma.part],
    ["Unit", prisma.unit],
    ["Topic", prisma.topic],
    ["Lesson", prisma.lesson],
    ["SessionPublication", prisma.sessionPublication],
    ["Group", prisma.group],
    ["Batch", prisma.batch],
    ["Material", prisma.material],
    ["LiveSession", prisma.liveSession],
    ["Attendance", prisma.attendance],
    ["Quiz", prisma.quiz],
    ["Question", prisma.question],
    ["QuizAttempt", prisma.quizAttempt],
    ["QuizAnswer", prisma.quizAnswer],
    ["QuizAttemptEvidence", prisma.quizAttemptEvidence],
    ["Homework", prisma.homework],
    ["HomeworkSubmission", prisma.homeworkSubmission],
    ["ExamQuestion", prisma.examQuestion],
    ["ExamAttempt", prisma.examAttempt],
    ["MockExam", prisma.mockExam],
    ["MockExamQuestion", prisma.mockExamQuestion],
    ["MediaAsset", prisma.mediaAsset],
    ["SessionVideo", prisma.sessionVideo],
    ["SessionVideoView", prisma.sessionVideoView],
    ["LessonProgress", prisma.lessonProgress],
    ["LessonBookmark", prisma.lessonBookmark],
    ["LessonNote", prisma.lessonNote],
    ["StudyTask", prisma.studyTask],
    ["TeacherNote", prisma.teacherNote],
    ["LessonPlanTemplate", prisma.lessonPlanTemplate],
    ["SubscriptionPlan", prisma.subscriptionPlan],
    ["Subscription", prisma.subscription],
    ["Payment", prisma.payment],
    ["Coupon", prisma.coupon],
    ["CouponRedemption", prisma.couponRedemption],
    ["Referral", prisma.referral],
    ["Notification", prisma.notification],
    ["NotificationPreference", prisma.notificationPreference],
    ["AuditLog", prisma.auditLog],
    ["Setting", prisma.setting],
    ["UserSession", prisma.userSession],
    ["PasswordResetToken", prisma.passwordResetToken],
    ["TeacherApplication", prisma.teacherApplication],
    ["TeacherActivationToken", prisma.teacherActivationToken],
    ["SecurityRateLimit", prisma.securityRateLimit],
    ["SecurityEvent", prisma.securityEvent],
  ];
  const out: { table: string; rows: number }[] = [];
  for (const [table, delegate] of delegates) {
    try {
      out.push({ table, rows: await delegate.count() });
    } catch {
      out.push({ table, rows: -1 });
    }
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");

  console.log("\n========================================");
  console.log("   CodeMind Production Database Setup");
  console.log("========================================\n");

  const dbUrl = process.env.DATABASE_URL || "";
  const provider = dbUrl.startsWith("postgres")
    ? "postgresql"
    : dbUrl.startsWith("file:") || dbUrl.endsWith(".db")
      ? "sqlite"
      : "unknown";
  console.log(`Provider : ${provider}`);
  console.log(`Target   : ${redactUrl(dbUrl)}`);

  const before = await tableCounts();
  const total = before.reduce((a, r) => a + Math.max(0, r.rows), 0);
  console.log(`\nCurrent rows: ${total} across ${before.length} tables (non-empty):`);
  for (const r of before) {
    if (r.rows > 0) console.log(`  ${r.table}: ${r.rows}`);
  }

  if (dryRun) {
    console.log("\n--dry-run: nothing was changed.");
    return;
  }

  console.log("\nThis will:");
  console.log("- Delete demo/test data (ALL tables below)");
  console.log("- Delete all existing users");
  console.log("- Delete Teacher Applications, activation tokens, sessions,");
  console.log("  reset tokens, rate limits, security events, evidence");
  console.log("- Delete videos, mock exams, enrollments, materials, publications");
  console.log("- Create ONE real Admin (interactive, no hardcoded password)");
  console.log("- Preserve Settings");
  console.log("- Preserve SubscriptionPlans\n");

  const confirmation = await ask('Type "CLEAN" to continue: ');

  if (confirmation.trim() !== "CLEAN") {
    console.log("\nCancelled. Nothing was changed.");
    return;
  }

  console.log("\nCleaning database...\n");

  // ========================================
  // 1. Assessment leaves (children first — explicit, cascade-independent)
  // ========================================

  await prisma.quizAnswer.deleteMany();
  await prisma.quizAttemptEvidence.deleteMany();
  await prisma.quizAttempt.deleteMany();

  await prisma.examAttempt.deleteMany();
  await prisma.mockExamQuestion.deleteMany();
  await prisma.mockExam.deleteMany();
  await prisma.examQuestion.deleteMany();

  await prisma.homeworkSubmission.deleteMany();
  await prisma.homework.deleteMany();

  await prisma.question.deleteMany();
  await prisma.quiz.deleteMany();

  await prisma.lessonProgress.deleteMany();
  await prisma.lessonBookmark.deleteMany();
  await prisma.lessonNote.deleteMany();
  await prisma.studyTask.deleteMany();

  // ========================================
  // 2. Videos / materials / publications (Phase 14/17 media graph)
  // ========================================
  // SessionVideo.mediaAssetId is Restrict: videos go before assets.

  await prisma.sessionVideoView.deleteMany();
  await prisma.sessionVideo.deleteMany();
  await prisma.material.deleteMany();
  await prisma.sessionPublication.deleteMany();

  // ========================================
  // 3. Live sessions / attendance
  // ========================================

  await prisma.attendance.deleteMany();
  await prisma.liveSession.deleteMany();

  // ========================================
  // 4. Teacher workflow rows
  // ========================================

  await prisma.teacherNote.deleteMany();
  await prisma.lessonPlanTemplate.deleteMany();

  // ========================================
  // 5. Money / engagement (before users — Payment has no DB cascade)
  // ========================================
  // SubscriptionPlans are intentionally preserved.

  await prisma.payment.deleteMany();
  await prisma.subscription.deleteMany();

  await prisma.couponRedemption.deleteMany();
  await prisma.coupon.deleteMany();
  await prisma.referral.deleteMany();

  // ========================================
  // 6. Notifications / audit / security persistence
  // ========================================
  // Security/audit rows are deleted here ONLY because this is a full initial
  // reset of demo data. This is not a retention policy (see Phase 22).

  await prisma.notification.deleteMany();
  await prisma.notificationPreference.deleteMany();
  await prisma.auditLog.deleteMany();

  await prisma.securityEvent.deleteMany();
  await prisma.securityRateLimit.deleteMany();
  await prisma.passwordResetToken.deleteMany();
  await prisma.userSession.deleteMany();

  await prisma.teacherActivationToken.deleteMany();
  await prisma.teacherApplication.deleteMany();

  // ========================================
  // 7. Enrollment graph (NO-cascade edges: Student.groupId, Group.*)
  // ========================================

  await prisma.enrollment.deleteMany();
  await prisma.studentBadge.deleteMany();
  await prisma.parentStudentLink.deleteMany();

  await prisma.student.deleteMany();
  await prisma.group.deleteMany();
  await prisma.batch.deleteMany();
  await prisma.parent.deleteMany();
  await prisma.teacher.deleteMany();

  // ========================================
  // 8. Curriculum tree
  // ========================================

  await prisma.lesson.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.unit.deleteMany();
  await prisma.part.deleteMany();
  await prisma.course.deleteMany();
  await prisma.track.deleteMany();

  // ========================================
  // 9. Media bytes index (rows only — files are operator-managed)
  // ========================================
  // MediaAsset rows are deleted last: every pointer (videos, materials,
  // evidence) is already gone, so no Restrict edge can fire. The private
  // FILES under MEDIA_STORAGE_PATH are NOT deleted by this script — wiping a
  // volume is a separate, deliberate operator step (see the runbook).

  await prisma.mediaAsset.deleteMany();

  // ========================================
  // 10. Remove all existing users
  // ========================================

  await prisma.user.deleteMany();

  console.log("✓ Demo/test data deleted.");
  console.log("✓ Existing users deleted.");
  console.log("✓ Teacher Applications / activation state deleted.");
  console.log("✓ Sessions / tokens / rate limits / security events deleted.");
  console.log("✓ Videos / mock exams / materials / publications deleted.");
  console.log("✓ Settings preserved.");
  console.log("✓ SubscriptionPlans preserved.");

  // ========================================
  // 11. Create the real Admin
  // ========================================
  // No teacher is created here — EVER. Teacher provisioning happens only
  // through the Phase 20 flow (public application -> admin approval ->
  // applicant activation with their own password). There is no code path in
  // this script that creates role=TEACHER, and no password is hardcoded.

  const email = "mudiifathii@gmail.com";

  const password = await ask("\nEnter Admin password: ");

  // Security Audit Gate (pre-P21): the platform minimum is 8 characters
  // (password reset, teacher activation, registration). A production admin
  // must not be provisioned with a 6-character password.
  if (!password || password.length < 8) {
    throw new Error("Admin password must be at least 8 characters.");
  }

  const name = await ask("Enter Admin name: ");

  const admin = await prisma.user.create({
    data: {
      email,
      password: hashPassword(password),
      name: name.trim() || "System Administrator",
      role: Role.ADMIN,
      isActive: true,
    },
  });

  // ========================================
  // 12. Final verification
  // ========================================

  const after = await tableCounts();
  const leftover = after.filter(
    (r) =>
      r.rows > 0 &&
      r.table !== "User" &&
      r.table !== "Setting" &&
      r.table !== "SubscriptionPlan"
  );

  const adminCount = await prisma.user.count({ where: { role: Role.ADMIN } });
  const teacherCount = await prisma.user.count({ where: { role: Role.TEACHER } });
  const studentCount = await prisma.user.count({ where: { role: Role.STUDENT } });
  const parentCount = await prisma.user.count({ where: { role: Role.PARENT } });
  const groupCount = await prisma.group.count();
  const appCount = await prisma.teacherApplication.count();
  const sessionCount = await prisma.userSession.count();
  const eventCount = await prisma.securityEvent.count();

  console.log("\n========================================");
  console.log("       Production Setup Complete");
  console.log("========================================");

  console.log(`\nAdmin email : ${admin.email}`);
  console.log(`Admin role  : ${admin.role}`);
  console.log("Password    : saved as secure hash");

  console.log("\nDatabase verification:");
  console.log(`  Admins              : ${adminCount}`);
  console.log(`  Teachers            : ${teacherCount} (must be 0 — Phase 20 flow only)`);
  console.log(`  Students            : ${studentCount}`);
  console.log(`  Parents             : ${parentCount}`);
  console.log(`  Groups              : ${groupCount}`);
  console.log(`  TeacherApplications : ${appCount} (must be 0)`);
  console.log(`  UserSessions        : ${sessionCount} (must be 0)`);
  console.log(`  SecurityEvents      : ${eventCount} (must be 0)`);

  console.log("\nPreserved:");
  console.log("  Settings           : YES");
  console.log("  SubscriptionPlans  : YES");

  if (teacherCount !== 0 || appCount !== 0 || sessionCount !== 0 || eventCount !== 0 || leftover.length) {
    console.log("\n⚠ UNEXPECTED LEFTOVER ROWS:");
    for (const r of leftover) console.log(`  ${r.table}: ${r.rows}`);
    throw new Error("Setup verification failed: leftover rows detected.");
  }

  console.log("\n========================================\n");
}

main()
  .catch((error) => {
    console.error("\nSetup failed:");
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
