// POST /api/teacher/homework/[id]/publish — Phase G
//
// The ONLY path by which an assignment becomes student-visible:
//   DRAFT  → PUBLISHED (first publish)
//   CLOSED → PUBLISHED (re-open; submissions accepted again)
// PUBLISHED → PUBLISHED is an idempotent no-op (double publish is safe).
//
// Server-authoritative + audited (`HOMEWORK_PUBLISHED`). On a transition
// (not on the idempotent replay) eligible students get the preference-aware
// NEW_HOMEWORK notification with a deduped deep link.
//
// AUTHORIZATION: TEACHER role → homework → lesson → course, canonical chain
// first, course must be one of the teacher's own (never a request parameter).

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
import { notifyAssessmentPublished } from "@/lib/assessment-notifications";

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

  // Idempotent replay — a second click (or a double request) is a safe no-op,
  // never a 409 and never a duplicate notification fan-out.
  if (existing.status === "PUBLISHED") {
    return ok({
      homework: {
        id: existing.id,
        status: existing.status,
        publishedAt: existing.publishedAt,
      },
      alreadyPublished: true,
    });
  }

  if (!canTransitionHomework(existing.status, "PUBLISHED")) {
    return err(tApi("api.350"), 409);
  }

  const now = new Date();
  const updated = await db.homework.update({
    where: { id },
    data: { status: "PUBLISHED", publishedAt: now },
  });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "HOMEWORK_PUBLISHED",
        entity: "Homework",
        entityId: id,
        details: JSON.stringify({ from: existing.status }),
      },
    })
    .catch(() => {});

  const notified = await notifyAssessmentPublished({
    kind: "HOMEWORK",
    id,
    title: tApi("api.352", { p1: updated.titleAr || updated.title }),
    message: tApi("api.353"),
    courseId: placement.courseId,
    trackScope: updated.trackScope,
  });

  return ok({
    homework: {
      id: updated.id,
      status: updated.status,
      publishedAt: updated.publishedAt,
    },
    notified,
  });
}
