// CodeMind Academy — Course Certificate Eligibility API
// Returns certificate data if student completed >= 80% of course lessons.
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { brand } from "@/lib/brand";

export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("الشهادات متاحة للطلاب فقط", 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    include: {
      group: { include: { course: true } },
    },
  });
  if (!student) return err("ملف الطالب غير موجود", 404);
  if (!student.group?.course) return err("أنت مش مشترك في كورس", 400);

  const course = student.group.course;

  // Count completed lessons
  const totalLessons = await db.lesson.count({
    where: { topic: { unit: { part: { courseId: course.id } } } },
  });
  const completedLessons = await db.lessonProgress.count({
    where: {
      studentId: student.id,
      isCompleted: true,
      lesson: { topic: { unit: { part: { courseId: course.id } } } },
    },
  });

  const pct = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
  const eligible = pct >= 80;

  // Quiz stats
  const quizAttempts = await db.quizAttempt.findMany({
    where: { studentId: student.id },
    select: { percentage: true, passed: true },
  });
  const avgQuiz = quizAttempts.length > 0
    ? Math.round(quizAttempts.reduce((s, a) => s + a.percentage, 0) / quizAttempts.length)
    : 0;

  // Attendance
  const attendanceTotal = await db.attendance.count({ where: { studentId: student.id } });
  const attendancePresent = await db.attendance.count({
    where: { studentId: student.id, status: "PRESENT" },
  });
  const attendancePct = attendanceTotal > 0
    ? Math.round((attendancePresent / attendanceTotal) * 100)
    : 0;

  return ok({
    eligible,
    progressPct: pct,
    completedLessons,
    totalLessons,
    certificate: eligible
      ? {
          studentName: user.name,
          courseName: course.nameAr || course.name,
          courseSlug: course.slug,
          completionDate: new Date().toLocaleDateString("ar-EG", {
            year: "numeric",
            month: "long",
            day: "numeric",
          }),
          academicYear: brand.academicYear,
          academyName: brand.name,
          tagline: brand.tagline,
          avgQuizScore: avgQuiz,
          attendanceRate: attendancePct,
          certificateId: `CM-${student.id.slice(-8).toUpperCase()}-${Date.now().toString(36).slice(-4).toUpperCase()}`,
        }
      : null,
  });
}
