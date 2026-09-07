import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";
import { getCourseSessionProgress } from "@/lib/session-progress";

// GET /api/students/me/homework
// Lists all homeworks for the student's course group, with the student's
// submissions attached.
//
// SECURITY: only assignments of sessions the student may actually open are
// listed. Previously every homework of the whole course was returned —
// including full `instructions` for sessions still locked — which both leaked
// upcoming content and let a student submit against a future session (which
// would then count towards that session's completion requirements).
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

  // Resolve which sessions are unlocked for this student, then drop the rest.
  const courseId = s.group?.courseId;
  const unlocked = new Set<string>();
  if (courseId) {
    const progress = await getCourseSessionProgress(s.id, courseId);
    for (const row of progress.sessions) {
      if (row.unlocked) unlocked.add(row.lessonId);
    }
  }

  const visible = homeworks.filter((h) => unlocked.has(h.lesson.id));

  const items = visible.map((h) => {
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
