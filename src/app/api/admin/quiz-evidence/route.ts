// GET /api/admin/quiz-evidence?quizId=&studentId=&page=
//
// ADMIN-ONLY review of quiz camera evidence. Returns attempt metadata plus
// authorized stream URLs for the stored snapshots. The media itself is served
// by /api/media/[id], which independently re-checks the ADMIN role.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, requireRole } from "@/lib/api";
import { logSecurityEvent } from "@/lib/security";

export async function GET(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const quizId = url.searchParams.get("quizId");
  const studentId = url.searchParams.get("studentId");
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(
    50,
    Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10))
  );

  const where: any = { evidence: { some: {} } };
  if (quizId) where.quizId = quizId;
  if (studentId) where.studentId = studentId;

  const [total, attempts] = await Promise.all([
    db.quizAttempt.count({ where }),
    db.quizAttempt.findMany({
      where,
      orderBy: { startedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        student: { select: { id: true, studentCode: true, user: { select: { name: true, email: true } } } },
        quiz: { select: { id: true, title: true, titleAr: true } },
        evidence: {
          orderBy: { capturedAt: "asc" },
          select: {
            id: true,
            kind: true,
            status: true,
            capturedAt: true,
            retainUntil: true,
            mediaAssetId: true,
          },
        },
      },
    }),
  ]);

  await logSecurityEvent({
    userId: user?.id,
    type: "QUIZ_EVIDENCE_ACCESSED",
    detail: `Listed evidence for ${attempts.length} attempt(s)`,
  });

  return ok({
    attempts: attempts.map((a) => ({
      attemptId: a.id,
      startedAt: a.startedAt,
      finishedAt: a.finishedAt,
      percentage: a.percentage,
      cameraStatus: a.cameraStatus,
      student: {
        id: a.student.id,
        name: a.student.user.name,
        email: a.student.user.email,
        studentCode: a.student.studentCode,
      },
      quiz: a.quiz,
      evidence: a.evidence.map((e) => ({
        id: e.id,
        kind: e.kind,
        status: e.status,
        capturedAt: e.capturedAt,
        retainUntil: e.retainUntil,
        // Private, authorization-checked URL. Never a public path.
        url: e.mediaAssetId ? `/api/media/${e.mediaAssetId}` : null,
      })),
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    },
  });
}
