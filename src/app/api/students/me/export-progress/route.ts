// CodeMind Academy — Student: Export own progress as CSV
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Export متاح للطلاب فقط", 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    include: {
      user: { select: { name: true, email: true } },
      group: { select: { name: true, course: { select: { nameAr: true } } } },
      attendances: {
        include: { session: { select: { titleAr: true, title: true, startAt: true } } },
        orderBy: { createdAt: "desc" },
      },
      quizAttempts: {
        include: { quiz: { select: { titleAr: true, title: true, lesson: { select: { titleAr: true } } } } },
        orderBy: { finishedAt: "desc" },
      },
      homeworkSubmits: {
        include: { homework: { select: { titleAr: true, title: true, lesson: { select: { titleAr: true } } } } },
        orderBy: { submittedAt: "desc" },
      },
      lessonProgress: {
        include: { lesson: { select: { titleAr: true, title: true, topic: { select: { titleAr: true } } } } },
        orderBy: { lastViewedAt: "desc" },
      },
    },
  });
  if (!student) return err("ملف الطالب غير موجود", 404);

  const headers = [
    "Type",
    "Title",
    "Topic/Lesson",
    "Date",
    "Score/Status",
    "Details",
  ];

  const rows: any[] = [];

  // Lessons
  student.lessonProgress.forEach((lp) => {
    rows.push([
      "Lesson",
      lp.lesson.titleAr || lp.lesson.title,
      lp.lesson.topic?.titleAr || "",
      lp.lastViewedAt ? lp.lastViewedAt.toLocaleDateString("en-GB") : "",
      lp.isCompleted ? "Completed" : "In Progress",
      `${lp.progress}%`,
    ]);
  });

  // Quizzes
  student.quizAttempts.forEach((qa) => {
    rows.push([
      "Quiz",
      qa.quiz?.titleAr || qa.quiz?.title || "",
      qa.quiz?.lesson?.titleAr || "",
      qa.finishedAt ? qa.finishedAt.toLocaleDateString("en-GB") : "",
      qa.passed ? "Passed" : "Failed",
      `${qa.percentage}% (${qa.score}/${qa.totalMarks})`,
    ]);
  });

  // Homework
  student.homeworkSubmits.forEach((hw) => {
    rows.push([
      "Homework",
      hw.homework?.titleAr || hw.homework?.title || "",
      hw.homework?.lesson?.titleAr || "",
      hw.submittedAt ? hw.submittedAt.toLocaleDateString("en-GB") : "",
      hw.status,
      hw.grade ? `${hw.grade}/10` : "",
    ]);
  });

  // Attendance
  student.attendances.forEach((att) => {
    rows.push([
      "Attendance",
      att.session?.titleAr || att.session?.title || "",
      "",
      att.session?.startAt ? att.session.startAt.toLocaleDateString("en-GB") : "",
      att.status,
      att.note || "",
    ]);
  });

  const csv = [headers, ...rows]
    .map((row) => row.map((cell) => `"${String(cell || "").replace(/"/g, '""')}"`).join(","))
    .join("\n");

  return new NextResponse("\uFEFF" + csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-progress-${user.name.replace(/\s/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
