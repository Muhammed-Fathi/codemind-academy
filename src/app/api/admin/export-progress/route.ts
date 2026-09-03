// CodeMind Academy — Admin: Export all students' progress as CSV
import { NextRequest, NextResponse } from "next/server";
import { requireRole, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const students = await db.student.findMany({
    include: {
      user: { select: { name: true, email: true, phone: true } },
      group: { select: { name: true, course: { select: { nameAr: true } } } },
      attendances: { select: { status: true } },
      quizAttempts: { select: { percentage: true, passed: true } },
      homeworkSubmits: { select: { status: true, grade: true } },
      lessonProgress: { select: { isCompleted: true } },
      subscription: {
        select: {
          status: true,
          endDate: true,
          plan: { select: { nameAr: true } },
        },
      },
    },
    orderBy: { enrolledAt: "desc" },
  });

  // Build CSV
  const headers = [
    "Name",
    "Email",
    "Phone",
    "Group",
    "Course",
    "Enrolled At",
    "Lessons Completed",
    "Total Lessons",
    "Completion %",
    "Attendance %",
    "Quizzes Taken",
    "Quizzes Passed",
    "Avg Quiz Score",
    "Homework Submitted",
    "Homework Graded",
    "Subscription Status",
    "Subscription Plan",
    "Subscription End Date",
  ];

  const rows = students.map((s) => {
    const lessonsCompleted = s.lessonProgress.filter((l) => l.isCompleted).length;
    const totalLessons = s.lessonProgress.length;
    const completionPct = totalLessons > 0 ? Math.round((lessonsCompleted / totalLessons) * 100) : 0;
    const attendanceTotal = s.attendances.length;
    const attendancePresent = s.attendances.filter((a) => a.status === "PRESENT").length;
    const attendancePct = attendanceTotal > 0 ? Math.round((attendancePresent / attendanceTotal) * 100) : 0;
    const quizzesTaken = s.quizAttempts.length;
    const quizzesPassed = s.quizAttempts.filter((q) => q.passed).length;
    const avgQuiz = quizzesTaken > 0
      ? Math.round(s.quizAttempts.reduce((sum, q) => sum + q.percentage, 0) / quizzesTaken)
      : 0;
    const hwSubmitted = s.homeworkSubmits.filter((h) => h.status !== "PENDING").length;
    const hwGraded = s.homeworkSubmits.filter((h) => h.status === "GRADED").length;

    return [
      s.user.name,
      s.user.email,
      s.user.phone || "",
      s.group?.name || "",
      s.group?.course?.nameAr || "",
      s.enrolledAt.toLocaleDateString("en-GB"),
      lessonsCompleted,
      totalLessons,
      completionPct,
      attendancePct,
      quizzesTaken,
      quizzesPassed,
      avgQuiz,
      hwSubmitted,
      hwGraded,
      s.subscription?.status || "NONE",
      s.subscription?.plan?.nameAr || "",
      s.subscription?.endDate ? s.subscription.endDate.toLocaleDateString("en-GB") : "",
    ];
  });

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(","))
    .join("\n");

  return new NextResponse("\uFEFF" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="students-progress-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
