// POST /api/quizzes/[id]/start
//
// Opens (or resumes) an unfinished QuizAttempt for the current student and
// returns its id. The attempt row must exist BEFORE the quiz begins so that
// camera evidence captured during the attempt has something to attach to.
//
// Security notes:
//   * Students only, and only for their own profile — the attempt's studentId
//     comes from the session, never from the request body.
//   * Resuming is idempotent: repeated calls (refresh, remount) return the
//     same open attempt instead of spawning duplicates.
//   * `cameraStatus` is recorded here as the student's up-front decision; the
//     evidence route may later refine it (DENIED, INTERRUPTED, ...).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile } from "@/lib/api";

const ALLOWED_STATUSES = new Set([
  "NOT_REQUESTED",
  "GRANTED",
  "DENIED",
  "UNAVAILABLE",
  "INTERRUPTED",
  "DECLINED",
]);

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  const quiz = await db.quiz.findUnique({ where: { id }, select: { id: true } });
  if (!quiz) return err("Quiz not found", 404);

  const body = await req.json().catch(() => ({}));
  const requested = String(body.cameraStatus || "NOT_REQUESTED");
  const cameraStatus = ALLOWED_STATUSES.has(requested) ? requested : "NOT_REQUESTED";

  // Resume an already-open attempt rather than creating a second one.
  const existing = await db.quizAttempt.findFirst({
    where: { quizId: id, studentId: student.id, finishedAt: null },
    orderBy: { startedAt: "desc" },
    select: { id: true },
  });

  if (existing) {
    await db.quizAttempt.update({
      where: { id: existing.id },
      data: { cameraStatus },
    });
    return ok({ attemptId: existing.id, resumed: true });
  }

  const attempt = await db.quizAttempt.create({
    data: {
      quizId: id,
      studentId: student.id,
      score: 0,
      totalMarks: 0,
      percentage: 0,
      passed: false,
      cameraStatus,
      // finishedAt stays null: the attempt is in progress.
    },
    select: { id: true },
  });

  return ok({ attemptId: attempt.id, resumed: false });
}
