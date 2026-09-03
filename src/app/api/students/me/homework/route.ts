import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";

// GET /api/students/me/homework
// Lists all homeworks for the student's course group, with the student's
// submissions attached.
export async function GET(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const s = await getStudentProfile(user.id);
  if (!s) return err("Student profile not found", 404);

  const homeworks = await db.homework.findMany({
    where: {
      lesson: {
        topic: {
          unit: { part: { course: { groups: { some: { id: s.groupId || "_" } } } } },
        },
      },
    },
    include: {
      lesson: { select: { id: true, titleAr: true, title: true } },
      submissions: { where: { studentId: s.id } },
    },
    orderBy: { deadline: "asc" },
  });

  const items = homeworks.map((h) => {
    const sub = h.submissions[0];
    return {
      id: h.id,
      title: h.titleAr || h.title,
      instructions: h.instructions,
      deadline: h.deadline,
      maxMarks: h.maxMarks,
      lessonId: h.lesson.id,
      lessonTitle: h.lesson.titleAr || h.lesson.title,
      submission: sub
        ? {
            status: sub.status,
            grade: sub.grade,
            feedback: sub.feedback,
            submittedAt: sub.submittedAt,
          }
        : null,
    };
  });

  return ok({ items });
}
