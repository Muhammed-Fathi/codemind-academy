import { PrismaClient, Role } from "@prisma/client";
import { hashPassword } from "../src/lib/auth";
import readline from "node:readline";

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

async function main() {
  console.log("\n========================================");
  console.log("   CodeMind Production Database Setup");
  console.log("========================================\n");

  console.log("This will:");
  console.log("- Delete demo/test data");
  console.log("- Delete all existing users");
  console.log("- Create ONE real Admin");
  console.log("- Preserve Settings");
  console.log("- Preserve SubscriptionPlans\n");

  const confirmation = await ask(
    'Type "CLEAN" to continue: '
  );

  if (confirmation.trim() !== "CLEAN") {
    console.log("\nCancelled. Nothing was changed.");
    return;
  }

  console.log("\nCleaning database...\n");

  // ========================================
  // 1. Quiz / Homework / Progress data
  // ========================================

  await prisma.quizAnswer.deleteMany();
  await prisma.quizAttempt.deleteMany();

  await prisma.homeworkSubmission.deleteMany();

  await prisma.lessonBookmark.deleteMany();
  await prisma.lessonNote.deleteMany();
  await prisma.lessonProgress.deleteMany();

  await prisma.examAttempt.deleteMany();
  await prisma.examQuestion.deleteMany();

  // ========================================
  // 2. Attendance / Live Sessions
  // ========================================

  await prisma.attendance.deleteMany();
  await prisma.liveSession.deleteMany();

  // ========================================
  // 3. Teacher-related data
  // ========================================

  await prisma.teacherNote.deleteMany();
  await prisma.lessonPlanTemplate.deleteMany();

  // ========================================
  // 4. Groups
  // ========================================

  await prisma.group.deleteMany();

  // ========================================
  // 5. Course content
  // ========================================

  await prisma.question.deleteMany();
  await prisma.quiz.deleteMany();
  await prisma.homework.deleteMany();

  await prisma.lesson.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.unit.deleteMany();
  await prisma.part.deleteMany();
  await prisma.course.deleteMany();

  // ========================================
  // 6. Payments / Subscriptions
  // ========================================
  // SubscriptionPlans are intentionally preserved.

  await prisma.payment.deleteMany();
  await prisma.subscription.deleteMany();

  // ========================================
  // 7. Coupons / Referrals
  // ========================================

  await prisma.couponRedemption.deleteMany();
  await prisma.referral.deleteMany();
  await prisma.coupon.deleteMany();

  // ========================================
  // 8. User-related data
  // ========================================

  await prisma.notification.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.notificationPreference.deleteMany();

  await prisma.parentStudentLink.deleteMany();
  await prisma.studentBadge.deleteMany();

  await prisma.studyTask.deleteMany();

  // ========================================
  // 9. Remove all existing users
  // ========================================

  await prisma.user.deleteMany();

  console.log("✓ Demo/test data deleted.");
  console.log("✓ Existing users deleted.");
  console.log("✓ Settings preserved.");
  console.log("✓ SubscriptionPlans preserved.");

  // ========================================
  // 10. Create the real Admin
  // ========================================

  const email = "mudiifathii@gmail.com";

  const password = await ask(
    "\nEnter Admin password: "
  );

  // Security Audit Gate (pre-P21): the platform minimum is 8 characters
  // (password reset, teacher activation, registration). A production admin
  // must not be provisioned with a 6-character password.
  if (!password || password.length < 8) {
    throw new Error(
      "Admin password must be at least 8 characters."
    );
  }

  const name = await ask(
    "Enter Admin name: "
  );

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
  // 11. Final verification
  // ========================================

  const adminCount = await prisma.user.count({
    where: {
      role: Role.ADMIN,
    },
  });

  const teacherCount = await prisma.user.count({
    where: {
      role: Role.TEACHER,
    },
  });

  const studentCount = await prisma.user.count({
    where: {
      role: Role.STUDENT,
    },
  });

  const parentCount = await prisma.user.count({
    where: {
      role: Role.PARENT,
    },
  });

  const groupCount = await prisma.group.count();

  console.log("\n========================================");
  console.log("       Production Setup Complete");
  console.log("========================================");

  console.log(`\nAdmin email : ${admin.email}`);
  console.log(`Admin role  : ${admin.role}`);
  console.log("Password    : saved as secure hash");

  console.log("\nDatabase verification:");
  console.log(`  Admins       : ${adminCount}`);
  console.log(`  Teachers     : ${teacherCount}`);
  console.log(`  Students     : ${studentCount}`);
  console.log(`  Parents      : ${parentCount}`);
  console.log(`  Groups       : ${groupCount}`);

  console.log("\nPreserved:");
  console.log("  Settings           : YES");
  console.log("  SubscriptionPlans  : YES");

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