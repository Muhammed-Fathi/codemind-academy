// CodeMind Academy — Phase H: catch-up RESOLUTION (act), split from evaluation.
//
// `evaluateStudentCatchup` (read-only eligibility) lives in the canonical
// engine (`src/lib/progression.ts`); the functions HERE carry out the
// resolution THROUGH the Phase F authority (`resolveHoldForCatchup` — the
// hold row, the audit row, nothing else).
//
// The split is a compile-graph boundary, not a second lifecycle: the Phase F
// module carries the notification graph, and the engine's read paths —
// compiled into many strict test closures and every progression reader —
// must not pull it in. Only learning-action routes import this module, and
// only for the post-action sweep.

import { db } from "@/lib/db";
import { resolveHoldForCatchup } from "@/lib/absence-review";
import {
  evaluateStudentCatchup,
  type ProgressionUnmetCode,
} from "@/lib/progression";

export type ResolveCatchupsResult = {
  results: {
    holdId: string;
    reviewId: string;
    eligible: boolean;
    resolved: boolean;
    alreadyResolved: boolean;
    unmet: ProgressionUnmetCode[];
    reason: string | null;
  }[];
  resolvedCount: number;
};

/**
 * Resolve every catch-up-eligible hold THROUGH the Phase F authority.
 * Idempotent: re-running resolves nothing twice and audits nothing twice,
 * because the Phase F function itself is idempotent.
 */
export async function resolveEligibleCatchups(
  studentId: string,
  actorUserId: string,
  opts: { now?: Date } = {}
): Promise<ResolveCatchupsResult> {
  const now = opts.now ?? new Date();
  const { holds } = await evaluateStudentCatchup(studentId, { now });
  if (holds.length === 0) return { results: [], resolvedCount: 0 };
  const results: ResolveCatchupsResult["results"] = [];
  for (const hold of holds) {
    if (!hold.eligible) {
      results.push({
        holdId: hold.holdId,
        reviewId: hold.reviewId,
        eligible: false,
        resolved: false,
        alreadyResolved: false,
        unmet: hold.unmet,
        reason: hold.reason,
      });
      continue;
    }
    const outcome = await resolveHoldForCatchup({
      reviewId: hold.reviewId,
      actorUserId,
      now,
      client: db,
    });
    results.push({
      holdId: hold.holdId,
      reviewId: hold.reviewId,
      eligible: true,
      resolved: outcome.resolved,
      alreadyResolved: outcome.alreadyResolved,
      unmet: [],
      reason: null,
    });
  }
  return {
    results,
    resolvedCount: results.filter((r) => r.resolved).length,
  };
}

/**
 * Best-effort catch-up sweep after a learning action (quiz submit, homework
 * submit, video completion). NEVER throws: a sync failure must not fail the
 * learning action it follows. Returns the summary for logging/tests.
 */
export async function maybeResolveCatchup(
  studentId: string,
  actorUserId: string
): Promise<ResolveCatchupsResult> {
  try {
    return await resolveEligibleCatchups(studentId, actorUserId);
  } catch {
    return { results: [], resolvedCount: 0 };
  }
}
