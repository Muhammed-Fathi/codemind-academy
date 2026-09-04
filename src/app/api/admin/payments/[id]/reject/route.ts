import { getServerT } from "@/lib/i18n-server";
// POST /api/admin/payments/[id]/reject — set REJECTED
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
  const payment = await db.payment.findUnique({ where: { id } });
  if (!payment) return err(tApi("api.029"), 404);

  await db.payment.update({ where: { id }, data: { status: "REJECTED" } });

  await createNotificationIfAllowed({
    userId: payment.userId,
    type: "PAYMENT_REJECTED",
    title: tApi("api.030"),
    message: tApi("api.031", { p1: payment.amount }),
    link: "dashboard",
  });

  return ok({ ok: true });
}
