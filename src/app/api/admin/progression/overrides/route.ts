// CodeMind Academy — Phase H: the ADMIN progression-override surface.
//
//   GET  /api/admin/progression/overrides?studentId=…
//        The student's overrides (history included) + the lesson options with
//        their canonical state, so the admin picks a boundary they can see.
//   POST /api/admin/progression/overrides
//        { studentId, lessonId, reason, expiresAt? } — issue an override.
//
// ADMIN ONLY, enforced here AND inside the write path
// (`createProgressionOverride` re-checks `actorRole`), so a future route that
// forgets the guard still cannot write. A teacher, a parent and a student are
// refused with 403 — Phase H deliberately gives NO other role manual-unlock
// authority of any kind.
//
// The override is an EXCEPTION OVERLAY: it never fabricates a quiz pass, a
// homework submission, a video completion or an attendance fact, never
// resolves an AbsenceHold and never rewrites a historical COMPLETED state.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import {
  createProgressionOverride,
  loadStudentOverrides,
  toOverrideView,
  ProgressionOverrideError,
} from "@/lib/progression-overrides";
import {
  evaluateCourseProgression,
  toCourseProgressionPayload,
} from "@/lib/progression-engine";
import { loadCourseLessonUniverse } from "@/lib/progression-universe";
import { loadStudentHolds } from "@/lib/progression-holds";

export async function GET(req: NextRequest) {
  const tApi = await getServerT();
  // The repo's ADMIN gate (`requireRole`) — the same one every other admin
  // endpoint uses — PLUS the authority's own role re-check below.
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const studentId = req.nextUrl.searchParams.get("studentId")?.trim() ?? "";
  if (!studentId) return err(tApi("admin.progression.studentRequired"), 400);

  const student = await db.student.findUnique({
    where: { id: studentId },
    select: {
      id: true,
      schoolType: true,
      group: { select: { courseId: true, isActive: true } },
      user: { select: { name: true, email: true } },
    },
  });
  if (!student) return err(tApi("api.211"), 404);

  const now = new Date();
  const [overrides, holds] = await Promise.all([
    loadStudentOverrides(studentId),
    loadStudentHolds(studentId),
  ]);

  const courseId = student.group?.courseId ?? null;
  const lessonOptions = courseId
    ? (await loadCourseLessonUniverse({ courseId, schoolType: student.schoolType })).map(
        (l) => ({ id: l.id, order: l.order })
      )
    : [];
  const titles = lessonOptions.length
    ? await db.lesson.findMany({
        where: { id: { in: lessonOptions.map((l) => l.id) } },
        select: { id: true, title: true, titleAr: true, order: true, officialCode: true },
        orderBy: { order: "asc" },
      })
    : [];

  // The canonical verdict, when the student is currently entitled — the same
  // evaluation the student's own screens read, never a staff-only variant.
  const progression = courseId
    ? toCourseProgressionPayload(
        await evaluateCourseProgression({ studentId, courseId, now }),
        tApi
      )
    : null;
  const stateByLesson = new Map(
    (progression?.lessons ?? []).map((l) => [l.lessonId, l])
  );

  // Auditability: every override names its author, so the console renders
  // "by <name>" from the platform's own User rows instead of an unreadable id.
  // Read-only and best-effort — a missing user row never hides the decision.
  const actorIds = [
    ...new Set(
      overrides.flatMap((o) => [o.createdByUserId, o.revokedByUserId]).filter(
        (id): id is string => typeof id === "string" && id.length > 0
      )
    ),
  ];
  const actors: Record<string, string> = {};
  if (actorIds.length) {
    const users = await db.user.findMany({
      where: { id: { in: actorIds } },
      select: { id: true, name: true, email: true },
    });
    for (const u of users) actors[u.id] = u.name || u.email || u.id;
  }

  return ok({
    student: {
      id: student.id,
      name: student.user?.name ?? null,
      email: student.user?.email ?? null,
      courseId,
    },
    overrides: overrides.map((o) => toOverrideView(o, now)),
    actors,
    holds: holds.map((h) => ({
      id: h.id,
      status: h.status,
      lessonId: h.lessonId,
      sessionId: h.sessionId,
      reviewStatus: h.reviewStatus,
    })),
    lessons: titles.map((l) => {
      const row = stateByLesson.get(l.id);
      return {
        id: l.id,
        title: l.title,
        titleAr: l.titleAr,
        order: l.order,
        officialCode: l.officialCode ?? null,
        state: row?.state ?? null,
        reason: row?.reason ?? null,
      };
    }),
    progression: progression
      ? {
          currentLessonId: progression.currentLessonId,
          boundary: progression.boundary,
          hold: progression.hold,
          catchUp: progression.catchUp,
        }
      : null,
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  const body = await req.json().catch(() => ({}));
  const studentId = typeof body?.studentId === "string" ? body.studentId.trim() : "";
  const lessonId = typeof body?.lessonId === "string" ? body.lessonId.trim() : "";
  if (!studentId || !lessonId) return err(tApi("admin.progression.studentRequired"), 400);

  // The affected lesson must exist, and the course it belongs to is recorded
  // for scoping/audit — resolved SERVER-side, never taken from the request.
  const lesson = await db.lesson.findUnique({
    where: { id: lessonId },
    select: { id: true, unitId: true, topicId: true },
  });
  if (!lesson) return err(tApi("admin.progression.lessonNotFound"), 404);

  const student = await db.student.findUnique({
    where: { id: studentId },
    select: { id: true, group: { select: { courseId: true } } },
  });
  if (!student) return err(tApi("api.211"), 404);

  try {
    const result = await createProgressionOverride({
      studentId,
      lessonId,
      courseId: student.group?.courseId ?? null,
      reason: body?.reason,
      expiresAt: body?.expiresAt,
      actorUserId: user.id,
      actorRole: user.role,
    });
    return ok({
      override: toOverrideView(result.override, new Date()),
      created: result.created,
    });
  } catch (error) {
    if (error instanceof ProgressionOverrideError) {
      const message =
        error.code === "NOT_AUTHORIZED"
          ? tApi("admin.progression.adminOnly")
          : error.code === "REASON_REQUIRED" ||
              error.code === "REASON_TOO_SHORT" ||
              error.code === "REASON_TOO_LONG"
            ? tApi("admin.progression.reasonRequired")
            : tApi("admin.progression.expiryInvalid");
      return err(message, error.status);
    }
    return err(tApi("admin.001"), 500);
  }
}
