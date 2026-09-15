// GET /api/admin/quiz-attempts — Phase 26D attempt inspection (ADMIN).
//
// The global oversight surface: every Lesson Quiz attempt on the platform,
// filterable, newest first, with enough of the record to answer "who took what,
// when, how did they score, and was this attempt permitted by a retry grant?".
//
// Answer keys are NOT in this list — only in the per-attempt detail, and only
// once the attempt is terminal. A list endpoint that shipped answer keys would
// put every key in one response.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, requireRole } from "@/lib/api";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const studentId = url.searchParams.get("studentId")?.trim() || "";
  const quizId = url.searchParams.get("quizId")?.trim() || "";
  const status = url.searchParams.get("status")?.trim() || "";
  const retriedOnly = url.searchParams.get("retried") === "1";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(
    200,
    Math.max(1, parseInt(url.searchParams.get("pageSize") || "50", 10))
  );

  const where: Record<string, unknown> = {};
  if (studentId) where.studentId = studentId;
  if (quizId) where.quizId = quizId;
  if (status === "OPEN" || status === "SUBMITTED" || status === "EXPIRED") {
    where.status = status;
  }
  if (retriedOnly) where.retryGrantId = { not: null };

  const [total, attempts] = await Promise.all([
    db.quizAttempt.count({ where }),
    db.quizAttempt.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: {
        id: true,
        attemptNumber: true,
        status: true,
        startedAt: true,
        finishedAt: true,
        score: true,
        totalMarks: true,
        percentage: true,
        passed: true,
        retryGrantId: true,
        studentId: true,
        student: { select: { id: true, user: { select: { name: true, email: true } } } },
        quizId: true,
        quiz: {
          select: {
            id: true,
            title: true,
            titleAr: true,
            lesson: { select: { id: true, title: true, titleAr: true } },
          },
        },
        retryGrant: {
          select: {
            id: true,
            grantedAt: true,
            consumedAt: true,
            grantedBy: { select: { name: true } },
          },
        },
      },
    }),
  ]);

  return ok({
    total,
    page,
    pageSize,
    attempts: attempts.map((a) => ({
      id: a.id,
      student: {
        id: a.student.id,
        name: a.student.user.name,
        email: a.student.user.email,
      },
      quiz: {
        id: a.quiz.id,
        title: a.quiz.titleAr || a.quiz.title,
        lessonId: a.quiz.lesson?.id ?? null,
        lessonTitle: a.quiz.lesson ? a.quiz.lesson.titleAr || a.quiz.lesson.title : null,
      },
      attemptNumber: a.attemptNumber,
      status: a.status,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      score: a.score,
      totalMarks: a.totalMarks,
      percentage: a.percentage,
      passed: a.passed,
      /** Retry lineage, when this attempt needed a grant to exist. */
      retryGrant: a.retryGrant
        ? {
            id: a.retryGrant.id,
            grantedAt: a.retryGrant.grantedAt,
            grantedByName: a.retryGrant.grantedBy?.name ?? null,
            consumedAt: a.retryGrant.consumedAt,
          }
        : null,
    })),
  });
}
