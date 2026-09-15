// POST /api/admin/payments/[id]/reject — Phase 25 PR2b: reject a PENDING
// payment through the shared decision service (`src/lib/payment-transitions`).
//
// This route only (1) authenticates the ADMIN, (2) validates the REQUIRED
// rejection reason, and (3) maps the service's domain errors to HTTP. The
// atomic decision — strict PENDING-only transition, reviewer audit fields,
// coupon release (reversing the submission-time consumption), audit log —
// lives in the shared service; no route carries a second copy of the rules.
//
// The rejection NEVER touches the student's entitlement (no groupId, no
// Subscription row, no dates) — grandfathered students keep their legacy
// access, active renewals keep their live entitlement, byte-for-byte.
//
// Post-commit (failure-tolerant): the rejection notification includes the
// admin's reason where the notification architecture supports it (free-text
// message — the existing PAYMENT_REJECTED channel). A notification failure
// never rolls back the committed rejection.
//
// SECURITY: the reviewer identity comes from the authenticated session ONLY.
// The reason is the sole client input; everything else is derived server-
// side from the Payment row.

import { getServerT } from "@/lib/i18n-server";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { err, requireRole } from "@/lib/api";
import { createNotificationIfAllowed } from "@/lib/notify";
import {
  normalizeRejectionReason,
  rejectPayment,
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

  // Rejection reason is REQUIRED (non-empty after trim, ≤ 500 chars) —
  // validated with the shared normalizer so the route and the service can
  // never disagree about what a valid reason is.
  const body = (await req.json().catch(() => ({}))) as {
    reason?: unknown;
  };
  if (normalizeRejectionReason(body?.reason) === null) {
    return NextResponse.json(
      { error: tApi("api.278"), code: "INVALID_REJECTION_REASON" },
      { status: 400 }
    );
  }

  try {
    const result = await rejectPayment({
      db,
      paymentId: id,
      reviewerUserId: user.id,
      reason: String(body.reason),
    });

    // POST-COMMIT: rejection notification with the reason (spec §26).
    // Failure-tolerant — the rejection stays committed regardless.
    try {
      await createNotificationIfAllowed({
        userId: result.payment.userId,
        type: "PAYMENT_REJECTED",
        title: tApi("api.030"),
        message: tApi("api.283", { p1: result.payment.rejectionReason }),
        // Phase 26B: NULL per the validated deep-link scheme — the literal
        // "dashboard" was never a navigable value (see the approve route).
        link: null,
      });
    } catch (notifyErr) {
      console.error(
        "[payment-rejection] post-commit notification failed:",
        notifyErr
      );
    }

    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    const decision = transitionErrorDecision(tApi, e);
    return NextResponse.json(
      { error: decision.message, code: decision.code },
      { status: decision.status }
    );
  }
}
