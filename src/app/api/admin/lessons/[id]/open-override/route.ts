// POST /api/admin/lessons/[id]/open-override — the Phase D EMERGENCY override
// of the OPEN ceremony (admin-only, explicit, audited).
//
// WHY THIS ROUTE EXISTS (and why it is NOT a flag on /open)
//   Publishing a readiness-blocked session is an exceptional, potentially
//   wrong act. It therefore has its own endpoint, its own input contract
//   (`{ reason }` — required, non-empty, capped), its own audit row
//   (`LESSON_OPEN_OVERRIDE`) and its own UI flow. A normal OPEN can never
//   accidentally inherit bypass semantics, and a caller can never smuggle an
//   override past the normal ceremony: /open carries no override input at
//   all, and this route refuses without a valid reason.
//
// WHAT IT DOES
//   • ADMIN only (`requireRole("ADMIN")`). Teachers, students and parents
//     are refused before any lesson state is touched — the override never
//     becomes a privilege escalator.
//   • The reason is validated SERVER-SIDE (`normalizeOverrideReason`): a
//     missing/blank reason is a 400 `OVERRIDE_REASON_REQUIRED`; an oversized
//     one is a 400 `OVERRIDE_REASON_TOO_LONG`. Both refusals are audited as
//     `LESSON_OPEN_OVERRIDE_REJECTED` so repeated attempts stay traceable.
//   • The ceremony itself (`openLessonWithOverride` in
//     `src/lib/session-lifecycle.ts`) re-checks everything from live rows:
//     archived / orphan / concurrency rules still refuse; if readiness
//     actually passes, the NORMAL ceremony runs (`override.used: false`).
//     Only a genuinely blocked readiness is bypassed, and only to PUBLISHED
//     through the audited DRAFT→READY→PUBLISHED staging.
//   • A successful override publication fans out the Phase 17 NEW_LESSON
//     notification exactly like the normal OPEN route: the lesson entered
//     the student universe, so the same delivery rules apply.
//
// WHAT IT NEVER DOES
//   No permission bypass, no progression bypass (students still unlock by
//   prerequisites), no MARK_READY / UNPUBLISH variant, no teacher/student
//   access, no silent success.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  ok,
  err,
  requireRole,
  applyRateLimit,
  rateLimitedResponse,
} from "@/lib/api";
import {
  openLessonWithOverride,
  normalizeOverrideReason,
  lifecycleHttpStatus,
} from "@/lib/session-lifecycle";
import { emitSessionPublicationNotifications } from "@/lib/session-notifications";
import { serverLocale } from "@/lib/i18n-server";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;

  // The override is the most sensitive publishing act; rate limit it with
  // the same limiter the OPEN ceremony uses (a retry loop must not be able
  // to bury the server in ceremonies or fan-outs).
  const rl = await applyRateLimit("open", user?.id ?? "anonymous-admin");
  if (!rl.allowed) return rateLimitedResponse(rl);

  const { id } = await params;

  const body = await req.json().catch(() => null);
  const reasonParsed = normalizeOverrideReason(
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).reason
      : body
  );
  if (!reasonParsed.ok) {
    // Repeated override ATTEMPTS must remain traceable even when refused:
    // the rejection is audited (best effort — an audit failure never masks
    // the 400 the caller is about to get).
    if (user?.id) {
      await db.auditLog
        .create({
          data: {
            userId: user.id,
            action: "LESSON_OPEN_OVERRIDE_REJECTED",
            entity: "Lesson",
            entityId: id,
            details: JSON.stringify({ code: reasonParsed.code }).slice(0, 1000),
          },
        })
        .catch(() => undefined);
    }
    return err(reasonParsed.code, 400);
  }

  const result = await openLessonWithOverride({
    lessonId: id,
    actorUserId: user?.id ?? null,
    reason: reasonParsed.reason,
  });
  const status = lifecycleHttpStatus(result.code);

  // Phase 17 fan-out: an override publication is a publication — the same
  // delivery pipeline runs, with the same "never rolls back the ceremony"
  // semantics as the normal OPEN route.
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
        message:
          "Notification fan-out failed unexpectedly; the publication is live and the delivery can be retried by re-opening",
      };
    }
  }

  const responseBody = {
    ok: result.ok,
    code: result.code,
    action: result.action,
    changed: result.changed,
    lessonId: result.lessonId,
    from: result.from,
    to: result.to,
    message: result.message,
    // The checklist travels with the verdict: the override UI shows exactly
    // which requirements were missing (and now bypassed) or why the refusal.
    readiness: result.readiness,
    publication: result.publication,
    // Phase D — the override half of the outcome (`used: true` only when
    // readiness was genuinely bypassed).
    override: result.override ?? null,
    notification,
  };
  if (status === 404) return err(result.message, 404);
  if (status === 400) return err(result.message, 400);
  return ok(responseBody, { status });
}
