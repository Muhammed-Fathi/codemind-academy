import { getServerT } from "@/lib/i18n-server";
// POST /api/admin/payments/[id]/approve — set APPROVED, activate linked subscription
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { createNotificationIfAllowed } from "@/lib/notify";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const payment = await db.payment.findUnique({
    where: { id },
    include: { subscription: { include: { plan: true } } },
  });
  if (!payment) return err(tApi("api.025"), 404);
  if (payment.status === "APPROVED") return err(tApi("api.026"), 400);

  await db.payment.update({ where: { id }, data: { status: "APPROVED" } });

  // Activate linked subscription if any
  if (payment.subscription) {
    const sub = payment.subscription;
    const start = new Date();
    const end = new Date();
    end.setMonth(end.getMonth() + (sub.plan?.durationMonths || 1));
    await db.subscription.update({
      where: { id: sub.id },
      data: {
        status: "ACTIVE",
        startDate: start,
        endDate: end,
      },
    });
    // Notify user (respects notification preferences)
    await createNotificationIfAllowed({
      userId: payment.userId,
      type: "PAYMENT_APPROVED",
      title: tApi("api.027"),
      message: tApi("api.028", { p1: payment.amount }),
      link: "dashboard",
    });
  }

  return ok({ ok: true });
}
