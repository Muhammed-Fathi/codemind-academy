// GET /api/subscription-plans — public pricing catalogue.
//
// Post-launch change: CLOSED (inactive) plans are no longer hidden — they
// stay in the catalogue flagged `isActive: false`, so the enrolment UI can
// render them as "غير متاحة حاليًا" with a disabled CTA (visible, clearly
// unavailable, unselectable) instead of them vanishing. Ordering keeps
// active plans first (promo among them last) so the sale never gets buried.
//
// AVAILABILITY IS STILL ENFORCED SERVER-SIDE — the flag is presentation,
// not authorization:
//   * /api/enroll refuses an inactive plan at SUBMISSION (api.276);
//   * the approval transition refuses it again (PLAN_NOT_FOUND) — a plan the
//     admin closes between submission and approval can never activate.
// The public API also strips nothing: no internal fields travel.

import { NextResponse } from "next/server";
import { ok } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const plans = await db.subscriptionPlan.findMany({
    orderBy: [{ isActive: "desc" }, { isPromo: "desc" }, { price: "asc" }],
  });
  return ok({ plans });
}
