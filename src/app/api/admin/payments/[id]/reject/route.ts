// POST /api/admin/payments/[id]/reject — set REJECTED
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { createNotificationIfAllowed } from "@/lib/notify";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const { id } = await params;
  const payment = await db.payment.findUnique({ where: { id } });
  if (!payment) return err("الدفعة غير موجودة", 404);

  await db.payment.update({ where: { id }, data: { status: "REJECTED" } });

  await createNotificationIfAllowed({
    userId: payment.userId,
    type: "PAYMENT_REJECTED",
    title: "تم رفض الدفع",
    message: `للأسف اترفضت دفعتك بقيمة ${payment.amount} EGP. لو فيه مشكلة، تواصل معانا على WhatsApp.`,
    link: "dashboard",
  });

  return ok({ ok: true });
}
