// CodeMind Academy — Coupon Validation API
// Validates a coupon code and returns the discount if valid.
import { NextRequest, NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function POST(req: NextRequest) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const { code, originalPrice } = body as { code?: string; originalPrice?: number };
  if (!code) return err("كود الخصم مطلوب", 400);

  const upperCode = code.trim().toUpperCase();
  const coupon = await db.coupon.findUnique({
    where: { code: upperCode },
    include: { redemptions: { where: { userId: user.id } } },
  });

  if (!coupon) return err("الكود ده مش موجود", 404);
  if (!coupon.isActive) return err("الكود ده مش شغال دلوقتي", 400);
  if (coupon.usedCount >= coupon.maxUses) return err("الكود ده خلص استخدامه", 400);
  if (coupon.validUntil && new Date() > coupon.validUntil)
    return err("الكود ده انتهت صلاحيته", 400);
  if (coupon.redemptions.length > 0)
    return err("أنت استخدمت الكود ده قبل كده", 400);

  const price = originalPrice || 200;
  let discount = 0;
  let finalPrice = price;
  if (coupon.type === "PERCENTAGE") {
    discount = Math.round((price * coupon.value) / 100);
    finalPrice = price - discount;
  } else {
    discount = Math.min(coupon.value, price);
    finalPrice = price - discount;
  }

  return ok({
    valid: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      type: coupon.type,
      value: coupon.value,
    },
    originalPrice: price,
    discount,
    finalPrice,
  });
}
