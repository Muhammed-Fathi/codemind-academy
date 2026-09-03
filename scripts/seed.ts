// CodeMind Academy — Database Seeder
// Run with: bun run scripts/seed.ts
import { db } from "../src/lib/db";
import { hashPassword } from "../src/lib/auth";
import { CURRICULUM } from "../src/lib/curriculum";

async function main() {
  console.log("🌱 Seeding CodeMind Academy...");

  // 1. Settings / branding
  const settings = [
    ["brand_name", "CodeMind Academy"],
    ["brand_tagline", "Learn. Build. Think."],
    ["whatsapp_teacher", "+201000000000"],
    ["whatsapp_technical", "+201000000001"],
    ["whatsapp_subscription", "+201000000002"],
    ["academic_year", "2024 / 2025"],
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
      password: hashPassword("admin123"),
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
      password: hashPassword("teacher123"),
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
      password: hashPassword("student123"),
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
      password: hashPassword("parent123"),
      role: "PARENT",
      phone: "+201000000006",
    },
  });

  let student = await db.student.findUnique({ where: { userId: studentUser.id } });
  if (!student) {
    student = await db.student.create({
      data: { userId: studentUser.id, grade: "2nd Secondary", schoolName: "STEM Cairo" },
    });
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

  // 4. Curriculum parts/units/topics/lessons
  for (let pIdx = 0; pIdx < CURRICULUM.length; pIdx++) {
    const partData = CURRICULUM[pIdx];
    const part = await db.part.create({
      data: {
        courseId: course.id,
        title: partData.title,
        titleAr: partData.titleAr,
        description: partData.description,
        order: pIdx + 1,
      },
    });
    for (let uIdx = 0; uIdx < partData.units.length; uIdx++) {
      const unitData = partData.units[uIdx];
      const unit = await db.unit.create({
        data: {
          partId: part.id,
          title: unitData.title,
          titleAr: unitData.titleAr,
          icon: unitData.icon,
          order: uIdx + 1,
        },
      });
      for (let tIdx = 0; tIdx < unitData.topics.length; tIdx++) {
        const topicData = unitData.topics[tIdx];
        const topic = await db.topic.create({
          data: {
            unitId: unit.id,
            title: topicData.title,
            titleAr: topicData.titleAr,
            order: tIdx + 1,
          },
        });
        for (let lIdx = 0; lIdx < topicData.lessons.length; lIdx++) {
          const lessonData = topicData.lessons[lIdx];
          const lesson = await db.lesson.create({
            data: {
              topicId: topic.id,
              title: lessonData.title,
              titleAr: lessonData.titleAr,
              description: lessonData.description || "",
              duration: lessonData.duration,
              order: lIdx + 1,
              isLocked: lIdx > 0, // first lesson open
              videoUrl: lIdx === 0 ? "https://www.youtube.com/embed/dQw4w9WgXcQ" : null,
              pdfUrl: lIdx === 0 ? "#" : null,
              summary: lIdx === 0
                ? "في الـLesson دي هنتعرف على الأساسيات ونفهم المفاهيم الرئيسية بطريقة بسيطة وعملية."
                : null,
            },
          });

          // Add sample quiz to first lesson of first topic
          if (pIdx === 0 && uIdx === 0 && tIdx === 0 && lIdx === 0) {
            const quiz = await db.quiz.create({
              data: {
                lessonId: lesson.id,
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
                lessonId: lesson.id,
                title: "Reflection Essay",
                titleAr: "تعبير عن الـLesson",
                instructions: "اكتب فقرة قصيرة عن أهمية الـIT في حياتك اليومية (100 كلمة على الأقل).",
                deadline: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
                maxMarks: 10,
              },
            });
          }
        }
      }
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
  console.log("Demo credentials:");
  console.log("  Admin:    admin@codemind.academy    / admin123");
  console.log("  Teacher:  teacher@codemind.academy  / teacher123");
  console.log("  Student:  student@codemind.academy  / student123");
  console.log("  Parent:   parent@codemind.academy   / parent123");
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
