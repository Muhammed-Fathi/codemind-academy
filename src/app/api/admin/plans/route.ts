// GET /api/admin/plans — list ALL plans (active + inactive) for admin
// POST /api/admin/plans — create plan
// Phase 26C — owner requirement: Admin must be able to open/close ANY package
// from sale at any time. isActive controls the public availability flag
// (the student endpoint keeps closed plans visible as inactive). This route is
// the admin authority for that.

import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { getServerT } from "@/lib/i18n-server";

export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const plans = await db.subscriptionPlan.findMany({
    orderBy: [{ isActive: "desc" }, { price: "asc" }],
  });

  return ok({ plans });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const name = String(body.name || "").trim();
  const nameAr = String(body.nameAr || name).trim();
  const durationMonths = Number(body.durationMonths);
  const price = Number(body.price);
  const isPromo = body.isPromo === true;
  const isActive = body.isActive !== undefined ? body.isActive === true : true;
  const description = body.description ? String(body.description) : null;

  if (!name || !nameAr) return err(tApi("api.021"), 400);
  if (!Number.isFinite(durationMonths) || durationMonths <= 0) return err("Invalid duration", 400);
  if (!Number.isFinite(price) || price < 0) return err("Invalid price", 400);

  const plan = await db.subscriptionPlan.create({
    data: {
      name,
      nameAr,
      durationMonths: Math.floor(durationMonths),
      price,
      isPromo,
      isActive,
      description,
    },
  });

  if (user.id) {
    await db.auditLog
      .create({
        data: {
          userId: user.id,
          action: "PLAN_CREATE",
          entity: "SubscriptionPlan",
          entityId: plan.id,
          details: JSON.stringify({
            name,
            durationMonths,
            price,
            isPromo,
            isActive,
          }).slice(0, 1000),
        },
      })
      .catch(() => undefined);
  }

  return ok({ plan }, { status: 201 });
}
