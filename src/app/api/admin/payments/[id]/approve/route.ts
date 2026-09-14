// POST /api/admin/payments/[id]/approve — Phase 25 PR2b: approve a PENDING
// payment through the shared decision service (`src/lib/payment-transitions`).
//
// This route only (1) authenticates the ADMIN, (2) extracts the ONE optional
// client input — a validated group override — and (3) maps the service's
// domain errors to HTTP. The decision itself (strict PENDING-only
// transitions, stale-payment guard, plan/group resolution, capacity under
// the per-group advisory lock, the atomic Subscription singleton
// activation/creation, group assignment, reviewer audit fields, audit log)
// lives in the shared service so no route ever carries a second copy of
// the decision rules.
//
// Post-commit (NEVER inside the business transaction): the Phase 12 batch
// reconciliation and the truthful post-decision notification. Both are
// failure-tolerant: a failure here logs + reports a warning but can never
// un-commit the approved payment (the business truth stays).
//
// SECURITY: the reviewer identity comes from the authenticated session ONLY
// — nothing in the body selects a reviewer, a student, a user, a
// subscription or an entitlement value. A body carrying any of those is
// ignored on purpose (the service derives everything from the Payment row).

import { getServerT, serverLocale } from "@/lib/i18n-server";
// Phase 25 PR2b — the decision layer (see module header).
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { err, requireRole } from "@/lib/api";
import { fmtDate } from "@/lib/i18n-core";
import { createNotificationIfAllowed } from "@/lib/notify";
import { reconcileStudentBatch } from "@/lib/enrollment";
import {
  approvePayment,
  runApprovalPostCommitEffects,
  transitionErrorDecision,
} from "@/lib/payment-transitions";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;

  // The ONLY client-controlled input: an optional group override (the
  // API-level recovery path for GROUP_REQUIRED / a dangling requested
  // group — spec §21). Admin-only by the role gate above; the service
  // validates it fully (existence, activity, course context, capacity).
  const body = (await req.json().catch(() => ({}))) as {
    groupId?: unknown;
  };
  const overrideGroupId =
    typeof body?.groupId === "string" && body.groupId.trim()
      ? body.groupId.trim()
      : null;

  try {
    const result = await approvePayment({
      db,
      paymentId: id,
      reviewerUserId: user.id,
      overrideGroupId,
    });

    // POST-COMMIT (strictly after the transaction settles, spec §25/§26):
    // Phase 12 batch reconciliation, then the TRUTHFUL post-decision
    // notification:
    //   ACTIVATED — no valid entitlement before (first / reactivation):
    //     "subscription activated / content available";
    //   RENEWED   — a valid ACTIVE entitlement before:
    //     "renewed / valid until …" (never "course opened");
    //   CONFIRMED — grandfathered access before (legacy student):
    //     "confirmed / valid until …" (access already existed).
    // Both are failure-tolerant inside the shared helper: a failure logs +
    // warns but never un-commits or falsifies the committed decision.
    const warnings = await runApprovalPostCommitEffects({
      studentId: result.student.id,
      reconcile: (studentId) => reconcileStudentBatch(studentId),
      notify: async () => {
        const loc = await serverLocale();
        const validUntil = fmtDate(result.subscription.endDate, loc);
        const message =
          result.accessNotification === "ACTIVATED"
            ? tApi("api.280")
            : result.accessNotification === "RENEWED"
              ? tApi("api.281", { p1: validUntil })
              : tApi("api.282", { p1: validUntil });
        return createNotificationIfAllowed({
          userId: result.payment.userId,
          type: "PAYMENT_APPROVED",
          title: tApi("api.027"),
          message,
          link: "dashboard",
        });
      },
    });

    return NextResponse.json({ ok: true, ...result, warnings });
  } catch (e) {
    // Domain errors → deterministic status + `code` + localized message;
    // transient DB conflict → 409 "retry"; unknown → generic 500 (the raw
    // error is logged, never leaked).
    const decision = transitionErrorDecision(tApi, e);
    return NextResponse.json(
      { error: decision.message, code: decision.code },
      { status: decision.status }
    );
  }
}
