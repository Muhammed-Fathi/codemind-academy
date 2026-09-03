// GET /api/teacher/homework — list homework assigned (filter by teacher's groups' course lessons)
//   Include submissions per homework with student info + grade + status.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";

export async function GET(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const url = new URL(req.url);
  const groupId = url.searchParams.get("groupId") || "";
  const courseIds = teacher.groups
    .filter((g) => !groupId || g.id === groupId)
    .map((g) => g.courseId);

  if (courseIds.length === 0) return ok({ homework: [] });

  const lessons = await db.lesson.findMany({
    where: { topic: { unit: { part: { courseId: { in: courseIds } } } } },
    select: { id: true },
  });
  const lessonIds = lessons.map((l) => l.id);

  const homework = lessonIds.length
    ? await db.homework.findMany({
        where: { lessonId: { in: lessonIds } },
        orderBy: { deadline: "asc" },
        include: {
          lesson: {
            select: {
              id: true,
              title: true,
              titleAr: true,
              topic: {
                select: {
                  unit: {
                    select: {
                      part: {
                        select: {
                          course: { select: { id: true, name: true, nameAr: true } },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
          submissions: {
            include: {
              student: {
                include: {
                  user: { select: { name: true, email: true, avatarUrl: true } },
                },
              },
            },
          },
        },
      })
    : [];

  // Group students for each homework's group (the lesson course may have
  // multiple groups). We compute per-homework stats:
  //   - total students in course groups
  //   - submittedCount, gradedCount, pendingCount
  const homeworkPayload = homework.map((hw) => {
    const submitted = hw.submissions.filter(
      (s) => s.status === "SUBMITTED" || s.status === "GRADED" || s.status === "LATE"
    ).length;
    const graded = hw.submissions.filter((s) => s.status === "GRADED").length;
    const pending = hw.submissions.filter((s) => s.status === "PENDING").length;
    return {
      id: hw.id,
      title: hw.titleAr || hw.title,
      titleAr: hw.titleAr,
      titleRaw: hw.title,
      instructions: hw.instructions,
      deadline: hw.deadline,
      maxMarks: hw.maxMarks,
      createdAt: hw.createdAt,
      lesson: hw.lesson
        ? {
            id: hw.lesson.id,
            title: hw.lesson.titleAr || hw.lesson.title,
            course: hw.lesson.topic.unit.part.course
              ? {
                  id: hw.lesson.topic.unit.part.course.id,
                  name:
                    hw.lesson.topic.unit.part.course.nameAr ||
                    hw.lesson.topic.unit.part.course.name,
                }
              : null,
          }
        : null,
      stats: {
        submitted,
        graded,
        pending,
        totalSubmissions: hw.submissions.length,
      },
      submissions: hw.submissions.map((s) => ({
        id: s.id,
        status: s.status,
        content: s.content,
        fileUrl: s.fileUrl,
        submittedAt: s.submittedAt,
        grade: s.grade,
        feedback: s.feedback,
        student: {
          id: s.student.id,
          name: s.student.user.name,
          email: s.student.user.email,
          avatarUrl: s.student.user.avatarUrl,
          grade: s.student.grade,
        },
      })),
    };
  });

  return ok({ homework: homeworkPayload });
}
