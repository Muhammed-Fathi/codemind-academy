import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err("الباقات متاحة للطلاب فقط", 403);

  const body = await req.json().catch(() => ({}));
  const { courseId, groupId, planId, method, reference, couponCode } = body as {
    courseId?: string;
    groupId?: string;
    planId?: string;
    method?: string;
    reference?: string;
    couponCode?: string;
  };
  if (!courseId || !groupId || !planId || !method)
    return err("كل البيانات مطلوبة", 400);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err("ملف الطالب غير موجود", 404);

  const plan = await db.subscriptionPlan.findUnique({ where: { id: planId } });
  if (!plan) return err("الباقة مش موجودة", 404);

  const group = await db.group.findUnique({ where: { id: groupId } });
  if (!group || !group.isActive) return err("المجموعة مش متاحة", 404);
  const filled = await db.student.count({ where: { groupId } });
  if (filled >= group.capacity) return err("المجموعة مكتملة", 400);

  // Validate coupon if provided
  let coupon: any = null;
  let finalAmount = plan.price;
  let discount = 0;
  if (couponCode) {
    const upperCode = couponCode.trim().toUpperCase();
    coupon = await db.coupon.findUnique({
      where: { code: upperCode },
      include: { redemptions: { where: { userId: user.id } } },
    });
    if (!coupon) return err("كود الخصم مش موجود", 404);
    if (!coupon.isActive) return err("كود الخصم مش شغال", 400);
    if (coupon.usedCount >= coupon.maxUses) return err("كود الخصم خلص استخدامه", 400);
    if (coupon.validUntil && new Date() > coupon.validUntil)
      return err("كود الخصم انتهت صلاحيته", 400);
    if (coupon.redemptions.length > 0) return err("أنت استخدمت الكود ده قبل كده", 400);

    if (coupon.type === "PERCENTAGE") {
      discount = Math.round((plan.price * coupon.value) / 100);
    } else {
      discount = Math.min(coupon.value, plan.price);
    }
    finalAmount = plan.price - discount;
  }

  // Create subscription (pending), payment (pending), assign group.
  // Use a transaction to keep data consistent.
  const result = await db.$transaction(async (tx) => {
    // Cancel any existing pending subscription for this student
    await tx.subscription.updateMany({
      where: { studentId: student.id, status: "PENDING" },
      data: { status: "CANCELLED" },
    });

    const sub = await tx.subscription.create({
      data: {
        studentId: student.id,
        planId: plan.id,
        status: "PENDING",
      },
    });

    const payment = await tx.payment.create({
      data: {
        userId: user.id,
        subscriptionId: sub.id,
        amount: finalAmount,
        method: method as any,
        status: "PENDING",
        reference: reference || null,
        notes: coupon ? `Coupon: ${coupon.code} (-${discount} EGP)` : null,
      },
    });

    // Redeem coupon if used
    if (coupon) {
      await tx.couponRedemption.create({
        data: {
          couponId: coupon.id,
          userId: user.id,
          paymentId: payment.id,
        },
      });
      await tx.coupon.update({
        where: { id: coupon.id },
        data: { usedCount: { increment: 1 } },
      });
    }

    // Assign group to student
    await tx.student.update({
      where: { id: student.id },
      data: { groupId },
    });

    // Notify all admins
    const admins = await tx.user.findMany({ where: { role: "ADMIN" } });
    if (admins.length > 0) {
      await tx.notification.createMany({
        data: admins.map((a) => ({
          userId: a.id,
          type: "ANNOUNCEMENT",
          title: "طلب اشتراك جديد",
          message: `${user.name} (طالب) عمل طلب اشتراك جديد — انتظر التأكيد.`,
          link: "admin-payments",
        })),
      });
    }

    return { subscription: sub, payment };
  });

  return ok(result);
}
