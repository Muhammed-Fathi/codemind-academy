import { getServerT, serverLocale } from "@/lib/i18n-server";
// CodeMind Academy — Course Certificate Eligibility API
// Returns certificate data if student completed >= 80% of course lessons.
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { EXCLUDE_ARCHIVED_LESSON, lessonCourseChainOr } from "@/lib/session-progress";
import { LESSON_STUDENT_STATUS_FILTER } from "@/lib/session-lifecycle";
import { trackScopeWhere } from "@/lib/track-scope";
import { brand } from "@/lib/brand";
import { fmtDate } from "@/lib/i18n-core";

export async function GET() {
  const tApi = await getServerT();
  const loc = await serverLocale();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.122"), 403);

  const student = await db.student.findUnique({
    where: { userId: user.id },
    include: {
      group: { include: { course: true } },
    },
  });
  if (!student) return err(tApi("api.123"), 404);
  if (!student.group?.course) return err(tApi("api.124"), 400);

  const course = student.group.course;

  // Eligibility runs over the ACTIVE curriculum universe (both chains,
  // archived history excluded): official lessons are unit-linked, and legacy
  // history rows stay readable but no longer count toward the 80%.
  //
  // Phase 12: the universe is also sliced to the student's own track. Without
  // this the DENOMINATOR counts lessons of the other school type that this
  // student can never open, so the 80% threshold would be unreachable for
  // anyone in a course that carries both ARABIC- and LANGUAGE-only sessions.
  // The numerator is filtered for the same reason — a progress row left behind
  // by a school-type change must not count toward a certificate the student is
  // no longer entitled to.
  const studentTrack = trackScopeWhere(student.schoolType);
  // Phase 13: the denominator is the student universe, so it requires
  // PUBLISHED exactly like the engine does. Counting a staged lesson here
  // would demand 80% of sessions the student can never reach.
  const totalLessons = await db.lesson.count({
    where: {
      ...LESSON_STUDENT_STATUS_FILTER,
      ...EXCLUDE_ARCHIVED_LESSON,
      ...studentTrack,
      OR: lessonCourseChainOr(course.id),
    },
  });
  const completedLessons = await db.lessonProgress.count({
    where: {
      studentId: student.id,
      isCompleted: true,
      lesson: {
        ...LESSON_STUDENT_STATUS_FILTER,
        ...EXCLUDE_ARCHIVED_LESSON,
        ...studentTrack,
        OR: lessonCourseChainOr(course.id),
      },
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
          completionDate: fmtDate(new Date(), loc, {
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
