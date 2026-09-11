// POST /api/admin/lessons/[id]/open — the OPEN ceremony — publish a session to the student curriculum
//
// The ceremony lives in `src/lib/session-lifecycle.ts`; this route is thin on
// purpose: authenticate as ADMIN, resolve the id, run the ceremony, map the
// outcome. Every rule (archived lessons are untouchable, a lesson must belong
// to a course, readiness must hold and the state must be READY (DRAFT can never be published directly), idempotent replay, the transactional write, the audit
// row) is enforced in the shared helper, so the endpoint cannot drift from the
// library and the library can be tested without HTTP.
//
// PHASE 17 — publication → notification fan-out.
// A SUCCESSFUL ceremony (the READY→PUBLISHED flip) is followed by the targeted
// NEW_LESSON fan-out of `src/lib/session-notifications.ts`. The exact
// semantics, in one place:
//
//   * Publication success is the LIFECYCLE transaction's success. A
//     notification problem can NEVER roll back, hide, or downgrade a
//     successful publication — and a notification code never turns a refused
//     ceremony (404/409) into a neutral one.
//   * The fan-out runs when the outcome is OK (changed) OR
//     NO_OP_ALREADY_IN_STATE (an idempotent replay IS the sanctioned retry:
//     it re-runs the same pipeline, which dedupes delivered rows, so a retry
//     can resume a PARTIAL delivery without ever duplicating a row).
//   * Refusals (LESSON_NOT_FOUND / READINESS_BLOCKED / ILLEGAL_TRANSITION /
//     LESSON_ARCHIVED / LESSON_NOT_IN_COURSE / CONCURRENT_CHANGE) run NO
//     fan-out — there is no publication to notify about.
//   * The response carries BOTH halves: `code`/`readiness`/`publication` for
//     the ceremony and `notification` for the delivery breakdown, so the
//     admin dialog shows exactly who was/wasn't told and why.

import { NextRequest } from "next/server";
import {
  ok,
  err,
  requireRole,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import { openLesson, lifecycleHttpStatus } from "@/lib/session-lifecycle";
import { emitSessionPublicationNotifications } from "@/lib/session-notifications";
import { serverLocale } from "@/lib/i18n-server";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  // Phase 20 — OPEN runs a transaction + a targeted fan-out (the most
  // expensive admin ceremony); rate limit before either so a retry loop
  // cannot bury the server in fan-outs.
  const rl = await applyRateLimit("open", user?.id ?? "anonymous-admin");
  if (!rl.allowed) return rateLimitedResponse(rl);

  const { id } = await params;
  const result = await openLesson({ lessonId: id, actorUserId: user?.id ?? null });
  const status = lifecycleHttpStatus(result.code);

  // The fan-out runs ONLY on a live publication: the fresh flip, or the
  // NO_OP replay (which is Phase 17's retry channel). Every refusal below
  // skips it.
  const ceremonyDeliveredPublication = result.ok && !!result.publication;
  let notification: Awaited<
    ReturnType<typeof emitSessionPublicationNotifications>
  > | null = null;
  if (ceremonyDeliveredPublication) {
    const locale = await serverLocale().catch(() => "ar" as const);
    try {
      notification = await emitSessionPublicationNotifications({
        lessonId: result.lessonId,
        actorUserId: user?.id ?? null,
        locale,
      });
    } catch {
      // A fan-out infrastructure error (not a chunk error — those are
      // reported as EMITTED_PARTIAL) must not turn the SUCCESSFUL publication
      // into a 500. The operator gets an explicit, retryable code and the
      // publication stays exactly what it is: published.
      notification = {
        ok: false,
        code: "EMITTED_PARTIAL",
        lessonId: result.lessonId,
        publicationId: result.publication?.id ?? null,
        courseId: null,
        trackScope: null,
        eligible: 0,
        delivered: 0,
        alreadyNotified: 0,
        skippedPreference: 0,
        skippedQuietHours: 0,
        chunksPlanned: 0,
        chunksDone: 0,
        failedChunks: [],
        link: null,
        message: "Notification fan-out failed unexpectedly; the publication is live and the delivery can be retried by re-opening",
      };
    }
  }

  const body = {
    ok: result.ok,
    code: result.code,
    action: result.action,
    changed: result.changed,
    lessonId: result.lessonId,
    from: result.from,
    to: result.to,
    message: result.message,
    // The checklist travels with the verdict: a refusal is actionable without
    // a second request, and a success shows what was verified to produce it.
    readiness: result.readiness,
    publication: result.publication,
    // Phase 17 — the delivery half of the ceremony outcome (null whenever no
    // publication exists to notify about).
    notification,
  };
  if (status === 404) return err(result.message, 404);
  return ok(body, { status });
}
