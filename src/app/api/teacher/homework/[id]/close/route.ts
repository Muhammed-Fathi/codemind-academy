// POST /api/teacher/homework/[id]/close — Phase G
//
// The ONLY path by which an assignment stops accepting submissions:
//   PUBLISHED → CLOSED
// CLOSED stays historically visible: existing submissions and grades remain
// readable; the student list keeps the assignment (read-only); the
// progression requirement is unchanged (Phase H owns progression).
//
// Server-authoritative + audited (`HOMEWORK_CLOSED`). No notification: closing
// is a teacher-side operational act, and the deadline already told students
// when the assignment ends.
//
// AUTHORIZATION: identical to the publish route.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getTeacherProfile } from "@/lib/api";
import {
  LESSON_PLACEMENT_SELECT,
  lessonPlacement,
  teacherCourseIds,
  type ChainLesson,
} from "@/lib/teacher-content";
import { canTransitionHomework } from "@/lib/homework-lifecycle";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const tApi = await getServerT();
  const { id } = await params;
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "TEACHER") return err("Forbidden", 403);

  const teacher = await getTeacherProfile(user.id);
  if (!teacher) return err("Teacher profile not found", 404);

  const existing = await db.homework.findUnique({
    where: { id },
    include: { lesson: { select: LESSON_PLACEMENT_SELECT } },
  });
  if (!existing) return err(tApi("api.238"), 404);

  const placement = lessonPlacement(existing.lesson as ChainLesson | null);
  if (!placement || !teacherCourseIds(teacher).includes(placement.courseId)) {
    return err(tApi("api.180"), 403);
  }

  // Idempotent replay.
  if (existing.status === "CLOSED") {
    return ok({ homework: { id: existing.id, status: existing.status }, alreadyClosed: true });
  }

  if (!canTransitionHomework(existing.status, "CLOSED")) {
    // A DRAFT cannot be closed — it was never open. Publish first.
    return err(tApi("api.351"), 409);
  }

  const updated = await db.homework.update({
    where: { id },
    data: { status: "CLOSED" },
  });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "HOMEWORK_CLOSED",
        entity: "Homework",
        entityId: id,
        details: JSON.stringify({ submissions: undefined }),
      },
    })
    .catch(() => {});

  return ok({ homework: { id: updated.id, status: updated.status } });
}
