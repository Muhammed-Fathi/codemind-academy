// CodeMind Academy — Phase H: the CATCH-UP RESOLUTION write path.
//
// WHY THIS IS A SEPARATE MODULE FROM THE ENGINE
// =============================================
// `progression-engine.ts` is deliberately READ-ONLY: evaluating progression
// must never mutate the database, or two concurrent readers could disagree
// (and a GET would become a write). The one thing Phase H DOES write is the
// administrative record of "the student finished their catch-up, so the hold
// stops blocking" — and that write belongs to the Phase F absence authority.
//
// This module is the bridge:
//
//   1. ask the CANONICAL ENGINE whether the affected lesson's academic
//      requirements are actually satisfied (the same matrix as normal
//      progression — only requirements that exist are counted);
//   2. when they are, call the Phase F authority
//      (`resolveAbsenceHoldForCatchUp` in src/lib/absence-review.ts), which is
//      the ONLY code that resolves a hold;
//   3. never touch Attendance, AbsenceReview.status or any academic fact
//      (an UNEXCUSED absence stays UNEXCUSED — history is preserved).
//
// IDEMPOTENT BY CONSTRUCTION
// ==========================
// Resolution is safe to call as often as the student hits "I'm done": the
// hold is resolved at most once (a RESOLVED hold is a no-op), the audit row is
// written once, and the engine's verdict is a pure function of the rows, so a
// repeated call reports `ALREADY_RESOLVED` instead of acting again.

import { db } from "@/lib/db";
import { evaluateCatchUp, type CatchUpView } from "@/lib/progression-engine";
import { resolveAbsenceHoldForCatchUp } from "@/lib/absence-review";
import type { UnmetCode } from "@/lib/progression-requirements";

type Client = typeof db;

export type CatchUpResolution =
  | "RESOLVED"
  | "ALREADY_RESOLVED"
  | "NOT_SATISFIED"
  | "NO_HOLD";

export type CatchUpResolutionResult = {
  resolution: CatchUpResolution;
  holdId: string | null;
  lessonId: string | null;
  catchUp: CatchUpView | null;
  unmet: UnmetCode[];
};

/**
 * Evaluate and — only when the academics are genuinely done — resolve.
 *
 * `actorUserId` is null when the STUDENT's own work satisfied the catch-up
 * (no human actor to name), or the admin id when an admin triggered it.
 */
export async function resolveCatchUpIfSatisfied(params: {
  studentId: string;
  courseId?: string | null;
  actorUserId?: string | null;
  now?: Date;
  client?: Client;
}): Promise<CatchUpResolutionResult> {
  const client = (params.client ?? db) as Client;
  const now = params.now ?? new Date();

  const catchUp = await evaluateCatchUp({
    studentId: params.studentId,
    courseId: params.courseId ?? null,
    now,
    client,
  });

  if (!catchUp || !catchUp.lessonId) {
    return {
      resolution: "NO_HOLD",
      holdId: null,
      lessonId: catchUp?.lessonId ?? null,
      catchUp,
      unmet: catchUp?.unmet.map((u) => u.code) ?? [],
    };
  }
  if (!catchUp.satisfied) {
    return {
      resolution: "NOT_SATISFIED",
      holdId: null,
      lessonId: catchUp.lessonId,
      catchUp,
      unmet: catchUp.unmet.map((u) => u.code),
    };
  }

  const result = await resolveAbsenceHoldForCatchUp({
    studentId: params.studentId,
    lessonId: catchUp.lessonId,
    actorUserId: params.actorUserId ?? null,
    now,
    client,
  });

  return {
    resolution: result.resolved
      ? "RESOLVED"
      : result.alreadyResolved
        ? "ALREADY_RESOLVED"
        : "NO_HOLD",
    holdId: result.holdId,
    lessonId: catchUp.lessonId,
    catchUp,
    unmet: [],
  };
}
