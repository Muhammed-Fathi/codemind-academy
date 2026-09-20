// CodeMind Academy — Phase H: the student's CATCH-UP surface.
//
//   GET  /api/students/me/catch-up
//        The absence hold that concerns this student and EXACTLY what its
//        catch-up needs — only requirements that actually exist (a lesson with
//        no quiz never asks for a quiz pass), never attendance.
//   POST /api/students/me/catch-up
//        Resolve the hold once the catch-up is genuinely complete. Idempotent:
//        repeated calls report ALREADY_RESOLVED instead of acting again, so a
//        double-click can never duplicate the resolution or its audit row.
//
// The resolution itself is performed by the Phase F authority
// (`resolveAbsenceHoldForCatchUp` in src/lib/absence-review.ts) — Phase H
// decides WHETHER the academics are done, Phase F owns the hold.
//
// STUDENT ONLY: a student may only ever resolve their OWN catch-up. There is no
// studentId parameter, so no other student's hold can be named or touched.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireUser, getStudentProfile, applyRateLimit, rateLimitedResponse } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";
import { evaluateCatchUp, evaluateCourseProgression, toCourseProgressionPayload } from "@/lib/progression-engine";
import { resolveCatchUpIfSatisfied } from "@/lib/progression-catchup";

export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  const row = await db.student.findUnique({
    where: { id: student.id },
    select: { group: { select: { courseId: true } } },
  });
  const courseId = row?.group?.courseId ?? null;
  if (!courseId) return ok({ hold: null, catchUp: null, boundary: null });

  const progression = toCourseProgressionPayload(
    await evaluateCourseProgression({ studentId: student.id, courseId }),
    tApi
  );

  return ok({
    hold: progression.hold,
    catchUp: progression.catchUp ?? progression.hold?.catchUp ?? null,
    boundary: progression.boundary,
    currentLessonId: progression.currentLessonId,
  });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  // Phase 20 — a write surface behind a button; rate limited before any
  // academic evaluation so a stuck client cannot hammer the engine.
  const rl = await applyRateLimit("progress", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  const body = await req.json().catch(() => ({}));
  const courseId =
    typeof body?.courseId === "string" && body.courseId.trim()
      ? body.courseId.trim()
      : null;

  const before = await evaluateCatchUp({ studentId: student.id, courseId });
  const result = await resolveCatchUpIfSatisfied({
    studentId: student.id,
    courseId,
    // No human actor: the student's OWN completed work is what resolves the
    // hold, and inventing an actor would corrupt the audit trail.
    actorUserId: null,
  });

  return ok({
    resolution: result.resolution,
    holdId: result.holdId,
    lessonId: result.lessonId,
    catchUp: result.catchUp,
    before,
    message:
      result.resolution === "RESOLVED"
        ? tApi("progression.catchup.resolved")
        : result.resolution === "ALREADY_RESOLVED"
          ? tApi("progression.catchup.alreadyResolved")
          : result.resolution === "NOT_SATISFIED"
            ? tApi("progression.catchup.notSatisfied")
            : tApi("progression.catchup.noHold"),
  });
}
