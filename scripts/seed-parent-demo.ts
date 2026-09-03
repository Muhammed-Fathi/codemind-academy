// CodeMind Academy — Supplementary seed for Parent Dashboard (Task 3)
// Adds demo analytics data for the existing demo student so the Parent
// Dashboard has meaningful content during verification.
//
// Idempotent: safe to re-run. Looks up existing demo parent/student/course/quiz.
//
// Run with: bun run scripts/seed-parent-demo.ts
import { db } from "../src/lib/db";

async function main() {
  console.log("🌱 Seeding Parent Dashboard demo data...");

  // 1. Locate demo student + parent
  const studentUser = await db.user.findUnique({
    where: { email: "student@codemind.academy" },
    include: {
      student: {
        include: {
          group: { include: { course: true, teacher: true } },
        },
      },
    },
  });
  if (!studentUser?.student) {
    throw new Error("Demo student not found. Run `bun run scripts/seed.ts` first.");
  }
  const student = studentUser.student;
  const group = student.group;
  if (!group || !group.course) {
    throw new Error("Demo student has no group/course.");
  }
  const teacher = group.teacher;
  console.log(`  ✓ Student: ${studentUser.name} (group: ${group.name})`);

  // 2. Lessons in course (ordered)
  const lessons = await db.lesson.findMany({
    where: { topic: { unit: { part: { courseId: group.course.id } } } },
    orderBy: { order: "asc" },
    include: { topic: { select: { titleAr: true, title: true } } },
  });
  console.log(`  ✓ Lessons in course: ${lessons.length}`);

  // 3. LessonProgress for the first ~6 lessons (varied completion)
  for (let i = 0; i < Math.min(6, lessons.length); i++) {
    const lesson = lessons[i];
    const progress = i === 0 ? 100 : i === 1 ? 100 : i === 2 ? 60 : i === 3 ? 30 : 10;
    const isCompleted = progress === 100;
    const lastViewedAt = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
    await db.lessonProgress.upsert({
      where: {
        studentId_lessonId: { studentId: student.id, lessonId: lesson.id },
      },
      update: {},
      create: {
        studentId: student.id,
        lessonId: lesson.id,
        progress,
        isCompleted,
        lastViewedAt,
      },
    });
  }
  console.log(`  ✓ LessonProgress for ${Math.min(6, lessons.length)} lessons`);

  // 4. Quiz attempts (6 attempts, varying scores across last 6 weeks)
  const quiz = await db.quiz.findFirst({
    where: { lessonId: lessons[0]?.id },
  });
  if (!quiz) {
    console.log("  ! No quiz found in first lesson — skipping quiz attempts");
  } else {
    const attemptsData = [
      { pct: 33, days: 42, passed: false },
      { pct: 67, days: 35, passed: true },
      { pct: 100, days: 28, passed: true },
      { pct: 67, days: 21, passed: true },
      { pct: 100, days: 14, passed: true },
      { pct: 100, days: 4, passed: true },
    ];
    // Clear old demo attempts for this quiz+student to avoid duplication on reruns
    await db.quizAttempt.deleteMany({
      where: { studentId: student.id, quizId: quiz.id },
    });
    for (const a of attemptsData) {
      const startedAt = new Date(Date.now() - a.days * 24 * 60 * 60 * 1000);
      const finishedAt = new Date(startedAt.getTime() + 15 * 60 * 1000);
      const score = Math.round((a.pct / 100) * 3);
      await db.quizAttempt.create({
        data: {
          quizId: quiz.id,
          studentId: student.id,
          score,
          totalMarks: 3,
          percentage: a.pct,
          passed: a.passed,
          startedAt,
          finishedAt,
        },
      });
    }
    console.log(`  ✓ Created ${attemptsData.length} quiz attempts`);
  }

  // 5. Homework submission for the first lesson's homework
  const homework = await db.homework.findFirst({
    where: { lessonId: lessons[0]?.id },
  });
  if (homework) {
    await db.homeworkSubmission.upsert({
      where: {
        homeworkId_studentId: { homeworkId: homework.id, studentId: student.id },
      },
      update: {},
      create: {
        homeworkId: homework.id,
        studentId: student.id,
        content:
          "الـIT هو اختصار لـ Information Technology. بتشمل كل الأدوات والأنظمة اللي بنستخدمها عشان ندير المعلومات. في حياتي اليومية الـIT بتساعدني في الدراسة والتواصل مع أصحابي وكمان في تنفيذ مشاريع البرمجة بتاعتي.",
        fileUrl: null,
        submittedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        grade: 9,
        feedback: "شغل ممتاز يا أحمد! التعبير واضح ومنظم. خليك على ده المستوى.",
        status: "GRADED",
      },
    });
    console.log(`  ✓ Homework submission (GRADED 9/10)`);
  }

  // 6. Past live sessions across last 6 months + attendance records
  //    (creates a few more sessions for the attendance monthly chart)
  const now = new Date();
  const pastSessionsData = [
    { days: 5, status: "PRESENT" as const },
    { days: 12, status: "LATE" as const },
    { days: 19, status: "PRESENT" as const },
    { days: 26, status: "ABSENT" as const },
    { days: 40, status: "PRESENT" as const },
    { days: 55, status: "PRESENT" as const },
    { days: 75, status: "PRESENT" as const },
    { days: 95, status: "EXCUSED" as const },
    { days: 120, status: "PRESENT" as const },
    { days: 150, status: "PRESENT" as const },
  ];
  // Delete existing demo "extra" sessions by title pattern
  await db.liveSession.deleteMany({
    where: { title: { startsWith: "[Parent Demo]" } },
  });
  for (const ps of pastSessionsData) {
    const startAt = new Date(now.getTime() - ps.days * 24 * 60 * 60 * 1000);
    const session = await db.liveSession.create({
      data: {
        groupId: group.id,
        teacherId: teacher?.id || null,
        title: `[Parent Demo] Live Session`,
        titleAr: `[Parent Demo] حصة لايف`,
        startAt,
        duration: 120,
        status: "COMPLETED",
      },
    });
    await db.attendance.create({
      data: {
        studentId: student.id,
        sessionId: session.id,
        status: ps.status,
      },
    });
  }
  console.log(`  ✓ Created ${pastSessionsData.length} past sessions + attendance`);

  // 7. Subscription (ACTIVE, started 2 months ago, 6-month plan)
  const plan = await db.subscriptionPlan.findFirst({
    where: { durationMonths: 6 },
  });
  if (plan) {
    const startDate = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
    const endDate = new Date(startDate.getTime() + plan.durationMonths * 30 * 24 * 60 * 60 * 1000);
    await db.subscription.upsert({
      where: { studentId: student.id },
      update: {
        planId: plan.id,
        status: "ACTIVE",
        startDate,
        endDate,
      },
      create: {
        studentId: student.id,
        planId: plan.id,
        status: "ACTIVE",
        startDate,
        endDate,
      },
    });
    console.log(`  ✓ Subscription (ACTIVE, 6-month plan)`);
  }

  // 8. Teacher notes (3 notes)
  if (teacher) {
    await db.teacherNote.deleteMany({
      where: { studentId: student.id, teacherId: teacher.id },
    });
    const notes = [
      {
        note:
          "أحمد طالب متميز. شغوف في الـProgramming ومشارك قوي في الحصص. يستاهل التقدير.",
        days: 3,
      },
      {
        note:
          "محتاج يراجع درس الـCybersecurity تاني. كويز النهاردة كان أقل من مستواه المعتاد.",
        days: 10,
      },
      {
        note:
          "اتميز في حل الـHomework الأخير. اتقدم بشكل ملحوظ في فهم الـData Structures.",
        days: 21,
      },
    ];
    for (const n of notes) {
      await db.teacherNote.create({
        data: {
          teacherId: teacher.id,
          studentId: student.id,
          note: n.note,
          createdAt: new Date(now.getTime() - n.days * 24 * 60 * 60 * 1000),
        },
      });
    }
    console.log(`  ✓ Created ${notes.length} teacher notes`);
  }

  // 9. Extra notification for the parent
  const parentUser = await db.user.findUnique({
    where: { email: "parent@codemind.academy" },
  });
  if (parentUser) {
    await db.notification.create({
      data: {
        userId: parentUser.id,
        type: "LOW_ATTENDANCE",
        title: "تنبيه: غياب ابنك",
        message: "ابنك غاب في آخر حصة. تواصل معاه عشان يعوض الدرس.",
        link: "parent-dashboard",
      },
    });
    console.log(`  ✓ Added parent notification`);
  }

  console.log("✅ Parent dashboard demo data seeded!");
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
