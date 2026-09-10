import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Student: Export own progress as CSV
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.132"), 403);

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
        // Phase 19: official lessons are UNIT-linked (topicId = null) — the
        // CSV's "Topic/Lesson" column fell permanently blank for them. The
        // unit title now travels as the canonical fallback.
        include: {
          lesson: {
            select: {
              titleAr: true,
              title: true,
              topic: { select: { titleAr: true, title: true } },
              unit: { select: { titleAr: true, title: true } },
            },
          },
        },
        orderBy: { lastViewedAt: "desc" },
      },
    },
  });
  if (!student) return err(tApi("api.133"), 404);

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
      // Canonical curriculum group: topic for legacy rows, unit for official.
      lp.lesson.topic?.titleAr ||
        lp.lesson.topic?.title ||
        lp.lesson.unit?.titleAr ||
        lp.lesson.unit?.title ||
        "",
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
