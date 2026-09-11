// CodeMind Academy — Database Seeder
// Run with: bun run scripts/seed.ts
import { randomBytes } from "crypto";
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { reconcileOfficialCurriculum } from "../src/lib/official-curriculum";

// ---------------------------------------------------------------------------
// Demo-user credentials — SECURITY CONTRACT (Security Audit Gate, pre-P21)
// ---------------------------------------------------------------------------
//
// A seeder must NEVER create an account whose password is committed to the
// repository. The previous version hardcoded one well-known password per demo
// role, and docs/DEPLOYMENT_GUIDE.md made `bun run scripts/seed.ts` a
// MANDATORY first-deploy step — so every deployment that followed the guide
// shipped a publicly-known ADMIN password (full platform compromise: every
// student record, national ID, phone number and every admin mutation).
//
// The contract is now:
//   * `SEED_ADMIN_PASSWORD` / `SEED_DEMO_PASSWORD`, when set, are used
//     verbatim and are NEVER printed back to the console.
//   * NODE_ENV=production with no value for either variable: the seeder
//     REFUSES to create the account and exits non-zero. A production admin
//     password is an operator secret, not a default.
//   * Anywhere else (development / test / a one-off script run): a
//     cryptographically random password is generated, printed ONCE, and never
//     written to disk. It is usable only on the database that was just seeded.

const IS_PRODUCTION = process.env.NODE_ENV === "production";

/** 16 random bytes → 22 chars of URL-safe text (≈128 bits of entropy). */
function generatedPassword(): string {
  return randomBytes(16).toString("base64url");
}

/**
 * Resolve the password for a seeded account.
 * Returns `null` when production requires an operator-supplied value and none
 * was given — the caller must then abort.
 */
function resolveSeedPassword(
  envKey: string,
  label: string
): { value: string; fromEnv: boolean } | null {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return { value: fromEnv, fromEnv: true };
  if (IS_PRODUCTION) {
    console.error(
      `\n❌ ${label} password is not set.\n` +
        `   This database is being seeded with NODE_ENV=production, so the seeder\n` +
        `   will not invent a credential. Set it explicitly and re-run:\n\n` +
        `       ${envKey}="$(openssl rand -hex 24)" bun run scripts/seed.ts\n\n` +
        `   Never commit the value. See docs/DEPLOYMENT_GUIDE.md §8.`
    );
    return null;
  }
  return { value: generatedPassword(), fromEnv: false };
}

async function main() {
  console.log("🌱 Seeding CodeMind Academy...");

  // Resolve BOTH passwords before touching the database, so a production run
  // with a half-configured environment aborts without leaving demo rows behind.
  const adminPassword = resolveSeedPassword("SEED_ADMIN_PASSWORD", "Admin");
  const demoPassword = resolveSeedPassword("SEED_DEMO_PASSWORD", "Demo user");
  if (!adminPassword || !demoPassword) {
    process.exit(1);
  }

  // 1. Settings / branding
  // Unified support line across the platform: +20 1147422177
  const settings = [
    ["brand_name", "CodeMind Academy"],
    ["brand_tagline", "Learn. Build. Think."],
    ["whatsapp_teacher", "+201147422177"],
    ["whatsapp_technical", "+201147422177"],
    ["whatsapp_subscription", "+201147422177"],
    ["academic_year", "2026 / 2027"],
    ["price_monthly", "200"],
    ["price_3months", "550"],
    ["price_6months", "1000"],
    ["price_early_bird", "100"],
  ];
  for (const [key, value] of settings) {
    await db.setting.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  // 2. Demo users
  const admin = await db.user.upsert({
    where: { email: "admin@codemind.academy" },
    update: {},
    create: {
      email: "admin@codemind.academy",
      name: "Admin User",
      password: hashPassword(adminPassword.value),
      role: "ADMIN",
      phone: "+201000000003",
    },
  });

  const teacherUser = await db.user.upsert({
    where: { email: "teacher@codemind.academy" },
    update: {},
    create: {
      email: "teacher@codemind.academy",
      name: "Eng. Omar Khaled",
      password: hashPassword(demoPassword.value),
      role: "TEACHER",
      phone: "+201000000004",
    },
  });
  const teacher = await db.teacher.upsert({
    where: { userId: teacherUser.id },
    update: {},
    create: {
      userId: teacherUser.id,
      bio: "خبرة 8 سنين في تدريس Programming & AI.",
      specialty: "Machine Learning",
    },
  });

  const studentUser = await db.user.upsert({
    where: { email: "student@codemind.academy" },
    update: {},
    create: {
      email: "student@codemind.academy",
      name: "Ahmed Hassan",
      password: hashPassword(demoPassword.value),
      role: "STUDENT",
      phone: "+201000000005",
    },
  });

  const parentUser = await db.user.upsert({
    where: { email: "parent@codemind.academy" },
    update: {},
    create: {
      email: "parent@codemind.academy",
      name: "Mr. Hassan",
      password: hashPassword(demoPassword.value),
      role: "PARENT",
      phone: "+201000000006",
    },
  });

  const { generateStudentCode } = await import("../src/lib/registration");
  let student = await (db as any).student.findUnique({ where: { userId: studentUser.id } });
  if (!student) {
    student = await (db as any).student.create({
      data: {
        userId: studentUser.id,
        grade: "2nd Secondary",
        schoolName: "STEM Cairo",
        schoolType: "LANGUAGE",
        nationalId: "29901010101010",
        parentPhone: "+201000000006",
        studentCode: generateStudentCode(),
      },
    });
  } else {
    // Backfill new registration fields for the demo student (idempotent).
    const patch: any = {};
    if (!student.studentCode) patch.studentCode = generateStudentCode();
    if (!student.nationalId) patch.nationalId = "29901010101010";
    if (!student.parentPhone) patch.parentPhone = "+201000000006";
    if (!student.schoolType) patch.schoolType = "LANGUAGE";
    if (Object.keys(patch).length) {
      student = await (db as any).student.update({ where: { id: student.id }, data: patch });
    }
  }

  let parent = await db.parent.findUnique({ where: { userId: parentUser.id } });
  if (!parent) {
    parent = await db.parent.create({ data: { userId: parentUser.id } });
  }

  // link parent -> student
  await db.parentStudentLink.upsert({
    where: { parentId_studentId: { parentId: parent.id, studentId: student.id } },
    update: {},
    create: { parentId: parent.id, studentId: student.id, relation: "parent" },
  });

  // 3. Course
  const course = await db.course.upsert({
    where: { slug: "programming-ai-2nd-sec" },
    update: {},
    create: {
      slug: "programming-ai-2nd-sec",
      name: "Programming & AI",
      nameAr: "البرمجة والذكاء الاصطناعي",
      description: "كورس Programming & AI لطلاب الصف الثاني الثانوي.",
      color: "#10b981",
    },
  });

  // 4. Official curriculum (Phase 11: reconciled from
  // docs/curriculum/knowledge-model.json — the legacy synthetic CURRICULUM
  // seed is retired and must never run again). Idempotent: re-running never
  // duplicates content; legacy rows are archived, never deleted.
  const reconcileReport = await reconcileOfficialCurriculum(db);
  console.log(
    `  ✓ Curriculum reconciled: ${reconcileReport.officialLessonCodes.length} official lessons ` +
      `(${reconcileReport.archivedLessonIds.length} archived)`
  );

  // Sample quiz + homework on the FIRST official lesson (code 1-1), so the
  // demo student has something to open. Guarded: re-running the seed must
  // not stack duplicate quizzes onto the lesson.
  const firstLesson = await db.lesson.findUnique({
    where: { officialCode: "1-1" },
    select: { id: true },
  });
  if (firstLesson) {
    const existingQuiz = await db.quiz.findFirst({
      where: { lessonId: firstLesson.id },
      select: { id: true },
    });
    if (!existingQuiz) {
      const quiz = await db.quiz.create({
        data: {
          lessonId: firstLesson.id,
          title: "Lesson 1 Quiz",
          titleAr: "اختبار الـLesson الأولى",
          description: "اختبار سريع على أساسيات الـIT.",
          passMark: 60,
          order: 1,
        },
      });
      await db.question.create({
        data: {
          quizId: quiz.id,
          type: "MCQ",
          prompt: "What does IT stand for?",
          promptAr: "إيه معنى IT؟",
          options: JSON.stringify([
            "Information Technology",
            "Internet Tech",
            "Internal Tool",
            "Input Type",
          ]),
          answer: "0",
          explanation: "IT = Information Technology.",
          difficulty: "EASY",
          marks: 1,
        },
      });
      await db.question.create({
        data: {
          quizId: quiz.id,
          type: "TRUE_FALSE",
          prompt: "Digital citizenship refers to responsible use of technology.",
          promptAr: "المواطنة الرقمية تعني الاستخدام المسؤول للتكنولوجيا.",
          options: JSON.stringify(["True", "False"]),
          answer: "0",
          explanation: "True — being a good digital citizen means using tech responsibly.",
          difficulty: "EASY",
          marks: 1,
        },
      });
      await db.question.create({
        data: {
          quizId: quiz.id,
          type: "MCQ",
          prompt: "Which is a cybersecurity threat?",
          promptAr: "إيه من دول يعتبر تهديد للأمن السيبراني؟",
          options: JSON.stringify(["Phishing", "Backup", "Firewall", "Encryption"]),
          answer: "0",
          explanation: "Phishing is a type of social engineering attack.",
          difficulty: "MEDIUM",
          marks: 1,
        },
      });

      // Add sample homework
      await db.homework.create({
        data: {
          lessonId: firstLesson.id,
          title: "Reflection Essay",
          titleAr: "تعبير عن الـLesson",
          instructions: "اكتب فقرة قصيرة عن أهمية الـIT في حياتك اليومية (100 كلمة على الأقل).",
          deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          maxMarks: 10,
        },
      });
    }
  }

  // 5. Group
  const group = await db.group.create({
    data: {
      name: "Group A — Sat & Tue 6PM",
      courseId: course.id,
      teacherId: teacher.id,
      capacity: 25,
      schedule: "السبت و الثلاثاء — 6:00 م",
      isActive: true,
    },
  });
  await db.student.update({
    where: { id: student.id },
    data: { groupId: group.id },
  });

  // 6. Live sessions (upcoming + past)
  const now = new Date();
  await db.liveSession.create({
    data: {
      groupId: group.id,
      teacherId: teacher.id,
      title: "Intro to IT — Live Session",
      titleAr: "مقدمة عن الـIT — حصة لايف",
      startAt: new Date(now.getTime() + 2 * 24 * 60 * 60 * 1000),
      duration: 120,
      meetingUrl: "https://meet.google.com/abc-defg-hij",
      status: "SCHEDULED",
    },
  });
  const pastSession = await db.liveSession.create({
    data: {
      groupId: group.id,
      teacherId: teacher.id,
      title: "Welcome & Orientation",
      titleAr: "ترحيب وتعريف بالكورس",
      startAt: new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000),
      duration: 90,
      recordingUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
      status: "COMPLETED",
    },
  });
  // mark attendance for the past session
  await db.attendance.create({
    data: {
      studentId: student.id,
      sessionId: pastSession.id,
      status: "PRESENT",
    },
  });

  // 7. Subscription plans
  const plans = [
    { name: "Monthly", nameAr: "شهري", durationMonths: 1, price: 200, isPromo: false },
    { name: "3 Months", nameAr: "3 شهور", durationMonths: 3, price: 550, isPromo: false },
    { name: "6 Months", nameAr: "6 شهور", durationMonths: 6, price: 1000, isPromo: false },
    { name: "Early Bird", nameAr: "Early Bird", durationMonths: 1, price: 100, isPromo: true },
  ];
  for (const p of plans) {
    await db.subscriptionPlan.create({ data: p });
  }

  // 8. Notifications
  await db.notification.create({
    data: {
      userId: studentUser.id,
      type: "NEW_LESSON",
      title: "Lesson جديدة اتضاف",
      message: "اتضافت Lesson جديدة في Part One — Information Technology and Society.",
      link: "course",
    },
  });
  await db.notification.create({
    data: {
      userId: studentUser.id,
      type: "UPCOMING_SESSION",
      title: "حصة لايف بكرة",
      message: "لايف سشن بكرة الساعة 6:00 مساءً. متنساش تتواصل!",
      link: "dashboard",
    },
  });
  await db.notification.create({
    data: {
      userId: parentUser.id,
      type: "MONTHLY_REPORT",
      title: "التقرير الشهري جاهز",
      message: "تقرير شهر أحمد الشهري جاهز دلوقتي، تقدر تتابع مستواه.",
      link: "parent-dashboard",
    },
  });

  console.log("✅ Seed complete!");
  console.log("");

  // Credentials are ONLY echoed when the seeder generated them itself (a local
  // / throw-away database). An operator-supplied password is never printed, and
  // there is no longer any default password to print.
  const generated: string[] = [];
  if (!adminPassword.fromEnv) {
    generated.push(`  Admin:    admin@codemind.academy    / ${adminPassword.value}`);
  }
  if (!demoPassword.fromEnv) {
    generated.push(
      `  Teacher:  teacher@codemind.academy  / ${demoPassword.value}`,
      `  Student:  student@codemind.academy  / ${demoPassword.value}`,
      `  Parent:   parent@codemind.academy   / ${demoPassword.value}`
    );
  }

  if (generated.length > 0) {
    console.log("Generated demo credentials (random — shown ONCE, never stored):");
    for (const line of generated) console.log(line);
  } else {
    console.log("Demo credentials: supplied via SEED_ADMIN_PASSWORD / SEED_DEMO_PASSWORD");
    console.log("(not shown — the operator already knows them).");
  }

  if (IS_PRODUCTION) {
    console.log("");
    console.log("⚠️  NODE_ENV=production: demo accounts were created. Remove them");
    console.log("   through the admin UI (or never expose this database) before go-live.");
  }
}

main()
  .then(async () => {
    await db.$disconnect();
  })
  .catch(async (e) => {
    console.error("❌ Seed error:", e);
    await db.$disconnect();
    process.exit(1);
  });
