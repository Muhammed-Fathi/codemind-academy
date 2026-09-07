// PATCH /api/teacher/homework/[id]/grade
//   body: { studentId, grade: number, feedback: string }
//   Updates the HomeworkSubmission for that homework + student, sets
//   status=GRADED. Returns the updated submission.
import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const homeworkId = id;
  const body = await req.json().catch(() => ({}));
  const studentId = String(body.studentId || "");
  const gradeNum = Number(body.grade);
  const feedback = body.feedback ? String(body.feedback) : null;

  if (!studentId) return err(tApi("api.168"), 400);
  if (Number.isNaN(gradeNum)) return err(tApi("api.169"), 400);
  if (gradeNum < 0 || gradeNum > 100)
    return err(tApi("api.170"), 400);

  // Verify the homework belongs to one of the teacher's courses
  const hw = await db.homework.findUnique({
    where: { id: homeworkId },
    include: {
      lesson: {
        select: {
          topic: {
            select: {
              unit: { select: { part: { select: { courseId: true } } } },
            },
          },
        },
      },
    },
  });
  if (!hw) return err(tApi("api.171"), 404);
  const teacherCourseIds = teacher.groups.map((g) => g.courseId);
  const hwCourseId = hw.lesson.topic?.unit.part.courseId;
  if (!hwCourseId || !teacherCourseIds.includes(hwCourseId)) {
    return err(tApi("api.172"), 403);
  }

  // Find or create the submission row
  const existing = await db.homeworkSubmission.findUnique({
    where: { homeworkId_studentId: { homeworkId, studentId } },
  });

  let updated;
  if (existing) {
    updated = await db.homeworkSubmission.update({
      where: { id: existing.id },
      data: {
        grade: gradeNum,
        feedback,
        status: "GRADED",
        submittedAt: existing.submittedAt || new Date(),
      },
      include: {
        student: {
          include: { user: { select: { name: true, email: true } } },
        },
      },
    });
  } else {
    // No submission yet — create a GRADED record anyway (teacher pre-grades)
    updated = await db.homeworkSubmission.create({
      data: {
        homeworkId,
        studentId,
        grade: gradeNum,
        feedback,
        status: "GRADED",
        submittedAt: new Date(),
      },
      include: {
        student: {
          include: { user: { select: { name: true, email: true } } },
        },
      },
    });
  }

  // Send QUIZ_RESULT-style notification to the student's user
  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { userId: true },
  });
  if (student) {
    await db.notification
      .create({
        data: {
          userId: student.userId,
          type: "QUIZ_RESULT",
          title: tApi("api.173", { p1: hw.titleAr || hw.title }),
          message: tApi("api.174", {
            p1: gradeNum,
            p2: hw.maxMarks,
            p3: feedback ? tApi("api.175", { p1: feedback }) : "",
          }),
          link: "student-homework",
        },
      })
      .catch(() => {});
  }

  return ok({
    submission: {
      id: updated.id,
      homeworkId: updated.homeworkId,
      studentId: updated.studentId,
      grade: updated.grade,
      feedback: updated.feedback,
      status: updated.status,
      submittedAt: updated.submittedAt,
      student: {
        id: updated.student.id,
        name: updated.student.user.name,
        email: updated.student.user.email,
      },
    },
  });
}
