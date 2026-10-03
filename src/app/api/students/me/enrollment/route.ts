// GET /api/students/me/enrollment
// Returns ONLY the course the student is actually enrolled in.
// An unenrolled student receives `{ isEnrolled: false, course: null }` — the
// UI then shows an explicit "not enrolled" message instead of placeholder
// course content.

import { requireUser, ok, err, getStudentProfile } from "@/lib/api";
import { db } from "@/lib/db";
import { getEnrollment } from "@/lib/enrollment";
import { studentAcademicContext } from "@/lib/student-universe";
import { getVideoProgressForStudent } from "@/lib/progress";
import { getCourseSessionProgress } from "@/lib/session-progress";

export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  const enrollment = await getEnrollment(student.id);

  // M4.1 — the STUDENT-level authority (`Student.academicLevel`). It is the
  // student's own column, never `Student.grade` and never a derived guess; the
  // course-level authority travels on the course object below.
  const academic = studentAcademicContext(student);

  if (!enrollment.isEnrolled || !enrollment.courseId) {
    return ok({
      isEnrolled: false,
      studentAcademicLevel: academic.studentAcademicLevel,
      course: null,
      schoolType: enrollment.schoolType,
      subscriptionStatus: enrollment.subscriptionStatus,
      videoProgress: null,
      currentLessonId: null,
    });
  }

  const [course, videoProgress, sessionProgress] = await Promise.all([
    db.course.findUnique({
      where: { id: enrollment.courseId },
      select: {
        id: true,
        slug: true,
        name: true,
        nameAr: true,
        description: true,
        color: true,
        // M4.1 — the COURSE-level authority (`Course.academicLevel`).
        academicLevel: true,
      },
    }),
    getVideoProgressForStudent(student.id),
    getCourseSessionProgress(student.id, enrollment.courseId),
  ]);

  return ok({
    isEnrolled: true,
    studentAcademicLevel: academic.studentAcademicLevel,
    course,
    groupId: enrollment.groupId,
    batchId: enrollment.batchId,
    schoolType: enrollment.schoolType,
    subscriptionStatus: enrollment.subscriptionStatus,
    videoProgress,
    currentLessonId: sessionProgress.currentLessonId,
    sessions: sessionProgress.sessions,
  });
}
