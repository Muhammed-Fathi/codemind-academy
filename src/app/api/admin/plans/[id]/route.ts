// PATCH /api/admin/plans/[id] — update plan (enable/disable sales, price, promo flag)
// DELETE /api/admin/plans/[id] — delete plan (only when no active subscriptions use it)
// Phase 26C — owner requirement: Admin must be able to open/close ANY package
// from sale at any time. Toggling isActive controls student listing
// (/api/subscription-plans filters isActive=true) and purchase rejection
// (/api/enroll checks plan.isActive). Existing ACTIVE students keep entitlement
// (the subscription row is independent of the plan's active flag).

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const existing = await db.subscriptionPlan.findUnique({ where: { id } });
  if (!existing) return err(tApi("api.025"), 404);

  const body = await req.json().catch(() => ({}));

  const data: any = {};
  if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
  if (typeof body.nameAr === "string" && body.nameAr.trim()) data.nameAr = body.nameAr.trim();
  if (typeof body.durationMonths === "number" && Number.isFinite(body.durationMonths) && body.durationMonths > 0) {
    data.durationMonths = Math.floor(body.durationMonths);
  }
  if (typeof body.price === "number" && Number.isFinite(body.price) && body.price >= 0) {
    data.price = body.price;
  }
  if (typeof body.isPromo === "boolean") data.isPromo = body.isPromo;
  if (typeof body.isActive === "boolean") data.isActive = body.isActive;
  if (body.description !== undefined) {
    data.description = body.description ? String(body.description) : null;
  }

  if (Object.keys(data).length === 0) return err("No fields to update", 400);

  const updated = await db.subscriptionPlan.update({
    where: { id },
    data,
  });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: body.isActive !== undefined ? (body.isActive ? "PLAN_ENABLED" : "PLAN_DISABLED") : "PLAN_UPDATE",
        entity: "SubscriptionPlan",
        entityId: id,
        details: JSON.stringify({
          before: { isActive: existing.isActive, isPromo: existing.isPromo, price: existing.price },
          after: data,
        }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return ok({ plan: updated });
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const existing = await db.subscriptionPlan.findUnique({ where: { id } });
  if (!existing) return err("Plan not found", 404);

  // Preferred operational model: normal retirement = isActive false.
  // Hard DELETE allowed only if ZERO business/history references exist —
  // otherwise we would destroy payment/subscription history.
  const [activeCount, anySubCount, paymentRefCount] = await Promise.all([
    db.subscription.count({ where: { planId: id, status: "ACTIVE" } }),
    db.subscription.count({ where: { planId: id } }),
    db.payment.count({ where: { requestedPlanId: id } }),
  ]);
  if (activeCount > 0) {
    return err("Cannot delete plan with active subscriptions — disable sale instead (isActive=false)", 409);
  }
  if (anySubCount > 0 || paymentRefCount > 0) {
    return err(
      `Cannot hard-delete plan with history: ${anySubCount} subscription(s), ${paymentRefCount} payment reference(s) — disable sale instead`,
      409
    );
  }

  await db.subscriptionPlan.delete({ where: { id } });

  await db.auditLog
    .create({
      data: {
        userId: user.id,
        action: "PLAN_DELETE",
        entity: "SubscriptionPlan",
        entityId: id,
        details: JSON.stringify({ name: existing.name, price: existing.price }).slice(0, 1000),
      },
    })
    .catch(() => undefined);

  return ok({ ok: true });
}
