import { getServerT, serverLocale } from "@/lib/i18n-server";
// CodeMind Academy — Course Certificate Eligibility API
// Returns certificate data if student completed >= 80% of course lessons.
import { NextResponse } from "next/server";
import { createHmac } from "crypto";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { getSecurityHashSecret } from "@/lib/env";
import { brand } from "@/lib/brand";
import { fmtDate } from "@/lib/i18n-core";
import {
  studentAcademicContext,
  studentLessonUniverse,
  studentQuizAttemptUniverse,
} from "@/lib/student-universe";

/**
 * M4.1 — a STABLE, secret-keyed certificate reference.
 *
 * The previous id embedded `Date.now()`, so it changed on every request and
 * was structurally guessable (the student's own id suffix + 4 base-36 chars of
 * the clock). This derives the reference from the student and the course with
 * the repository's existing stable-identifier pattern — the same
 * `createHmac("sha256", getSecurityHashSecret())` construction the mock-exam
 * pool uses for its non-guessable seeds. Same student + same course ⇒ same id,
 * and the secret means it cannot be computed by a client.
 *
 * Scope note (owner decision): this is a reference for the CURRENT course
 * certificate; nothing persists it, so no migration or backfill is involved.
 */
function certificateReference(studentId: string, courseId: string): string {
  const digest = createHmac("sha256", getSecurityHashSecret())
    .update(`certificate-v1|${studentId}|${courseId}`)
    .digest("hex")
    .toUpperCase();
  return `CM-${digest.slice(0, 8)}-${digest.slice(8, 12)}`;
}

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
  // M4.1 — the lesson universe is composed by the shared student-side helper
  // (same PUBLISHED + not-ARCHIVED + OWN-TRACK + dual-chain predicate the
  // dashboard uses — `student.schoolType` is what carries the track slice), so
  // the certificate denominator/numerator can never drift from the progress
  // ring, and a school-type change cannot leave a completion counting toward a
  // certificate the student is no longer entitled to.
  const lessonUniverse = studentLessonUniverse(course.id, student.schoolType);
  // Phase 13: the denominator is the student universe, so it requires
  // PUBLISHED exactly like the engine does. Counting a staged lesson here
  // would demand 80% of sessions the student can never reach.
  const totalLessons = await db.lesson.count({ where: lessonUniverse });
  const completedLessons = await db.lessonProgress.count({
    where: {
      studentId: student.id,
      isCompleted: true,
      lesson: lessonUniverse,
    },
  });

  const pct = totalLessons > 0 ? Math.round((completedLessons / totalLessons) * 100) : 0;
  const eligible = pct >= 80;

  // M4.1 — the STUDENT-level authority (`Student.academicLevel`), exposed
  // alongside the course-level one below and never substituted for it.
  const academic = studentAcademicContext(student);

  // Quiz stats
  // M4.1 — CURRENT COURSE only: the certificate names this course, so its
  // quiz average must not carry attempts from a course/level the student has
  // left (the same universe as the denominator above).
  const quizAttempts = await db.quizAttempt.findMany({
    where: { studentId: student.id, ...studentQuizAttemptUniverse(course.id, student.schoolType) },
    select: { percentage: true, passed: true },
  });
  const avgQuiz = quizAttempts.length > 0
    ? Math.round(quizAttempts.reduce((s, a) => s + a.percentage, 0) / quizAttempts.length)
    : 0;

  // Attendance
  // M4.1 — CURRENT COURSE only: attendance belongs to a session, a session to
  // a group, and a group to one course; the course relation is the identity.
  const attendanceWhere = { studentId: student.id, session: { group: { courseId: course.id } } };
  const attendanceTotal = await db.attendance.count({ where: attendanceWhere });
  const attendancePresent = await db.attendance.count({
    where: { ...attendanceWhere, status: "PRESENT" },
  });
  const attendancePct = attendanceTotal > 0
    ? Math.round((attendancePresent / attendanceTotal) * 100)
    : 0;

  return ok({
    eligible,
    progressPct: pct,
    completedLessons,
    totalLessons,
    // M4.1 — Student-level authority, read from the student's own column.
    studentAcademicLevel: academic.studentAcademicLevel,
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
          // M4.1 — COURSE-level authority on the course artifact.
          academicLevel: academic.courseAcademicLevel,
          // M4.1 — documents that these two aggregates are this course's.
          metricsScope: "CURRENT_COURSE",
          avgQuizScore: avgQuiz,
          attendanceRate: attendancePct,
          // M4.1 — stable, secret-keyed (see `certificateReference`).
          certificateId: certificateReference(student.id, course.id),
        }
      : null,
  });
}
