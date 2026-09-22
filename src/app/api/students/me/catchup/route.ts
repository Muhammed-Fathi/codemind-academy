// POST /api/students/me/catchup
//
// Academic catch-up resolution for absence holds (Phase H).
//
// A student under an ACTIVE absence hold completes the missed lesson's own
// academic requirements (required video ≥ threshold, every required quiz
// PASSED, every required homework SUBMITTED) and then calls this endpoint.
// The route evaluates catch-up eligibility DETERMINISTICALLY through the
// canonical engine and resolves each eligible hold THROUGH the Phase F
// authority (`resolveHoldForCatchup` — the hold row + the audit row, never
// the review row, never a progression write).
//
// Idempotent: re-calling resolves nothing twice and audits nothing twice.
// Ineligible holds are reported with their Arabic reason + structured unmet
// requirements so the student sees the exact recovery action.

import { NextRequest } from "next/server";
import {
  ok,
  err,
  requireUser,
  getStudentProfile,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import {
  evaluateStudentCatchup,
  toCatchupHoldView,
} from "@/lib/progression";
import { resolveEligibleCatchups } from "@/lib/catchup";

export async function POST(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const rl = await applyRateLimit("progress", user.id);
  if (!rl.allowed) return rateLimitedResponse(rl);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  // Read-only eligibility first, so the response always explains every hold —
  // eligible or not — even when nothing was resolved.
  const { holds } = await evaluateStudentCatchup(student.id);
  if (holds.length === 0) {
    return ok({ holds: [], resolvedCount: 0 });
  }

  const { results, resolvedCount } = await resolveEligibleCatchups(
    student.id,
    user.id
  );

  return ok({
    holds: results.map((r) => {
      const plan = holds.find((h) => h.holdId === r.holdId);
      return {
        holdId: r.holdId,
        reviewId: r.reviewId,
        sessionId: plan?.sessionId ?? null,
        lessonId: plan?.lessonId ?? null,
        lessonTitle: plan?.lessonTitle ?? null,
        courseId: plan?.courseId ?? null,
        inUniverse: plan?.inUniverse ?? false,
        requirements: plan?.requirements ?? null,
        eligible: r.eligible,
        resolved: r.resolved,
        alreadyResolved: r.alreadyResolved,
        unmet: r.eligible ? [] : r.unmet,
        reason: r.eligible ? null : r.reason,
      };
    }),
    resolvedCount,
  });
}

// GET /api/students/me/catchup — read-only catch-up plan (same evaluation,
// no resolution). The dashboard and the hold banner render from this.
export async function GET(_req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("Forbidden", 403);

  const student = await getStudentProfile(user.id);
  if (!student) return err("Student profile not found", 404);

  const { holds } = await evaluateStudentCatchup(student.id);
  return ok({
    holds: holds.map(toCatchupHoldView),
  });
}
