// GET /api/students/me/mock-exams
//
// Lists the admin-published mock exams the current student is eligible to
// take: same school-type bank, and either unbound or bound to the student's
// own enrolled course. Unpublished exams are never listed. The per-exam
// attempt count / best percentage cover this student's FINISHED attempts
// only — an attempt row is written at submit, always finished.
//
// Read-only: no attempt is created by listing. Starting an exam is an
// explicit GET /api/exams/mock?mockExamId=... which re-checks every rule
// below, so this list is a convenience, never a gate.

import { NextRequest } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { normalizeSchoolType } from "@/lib/school-type";
import { getEnrollment } from "@/lib/enrollment";
import { getServerT } from "@/lib/i18n-server";

export async function GET(_req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.094"), 403);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.095"), 404);

  const studentSchoolType = normalizeSchoolType(student.schoolType);
  if (!studentSchoolType) return err(tApi("api.210"), 400);

  const enrollment = await getEnrollment(student.id);
  if (!enrollment.isEnrolled || !enrollment.courseId)
    return err(tApi("api.096"), 400);

  const exams = await db.mockExam.findMany({
    where: {
      isPublished: true,
      schoolType: studentSchoolType,
      OR: [{ courseId: null }, { courseId: enrollment.courseId }],
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      title: true,
      titleAr: true,
      description: true,
      schoolType: true,
      courseId: true,
      questionCount: true,
      durationMin: true,
      passMark: true,
      difficulty: true,
      selectionMode: true,
    },
    take: 100,
  });

  // This student's own finished history per exam (one query, grouped in
  // memory — no cross-student rows are ever read).
  const history = await db.examAttempt.findMany({
    where: { studentId: student.id, finishedAt: { not: null } },
    select: { mockExamId: true, percentage: true },
  });
  const bestByExam = new Map<string, { attempts: number; best: number }>();
  for (const h of history) {
    if (!h.mockExamId) continue;
    const cur = bestByExam.get(h.mockExamId) || { attempts: 0, best: 0 };
    cur.attempts += 1;
    if (h.percentage > cur.best) cur.best = h.percentage;
    bestByExam.set(h.mockExamId, cur);
  }

  return ok({
    exams: exams.map((e) => {
      const h = bestByExam.get(e.id);
      return {
        ...e,
        attempts: h?.attempts ?? 0,
        bestPercentage: h ? h.best : null,
      };
    }),
  });
}
