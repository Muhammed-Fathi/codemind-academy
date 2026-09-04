import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Student Referral API
// Students can share their referral code, track referrals, and earn XP rewards.
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

// GET — returns student's referral code + referral stats
export async function GET() {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.140"), 403);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.141"), 404);

  // Generate a stable referral code from student ID
  const referralCode = `CM-${student.id.slice(-6).toUpperCase()}`;

  // Get referrals made by this student
  const referrals = await db.referral.findMany({
    where: { referrerId: student.id },
    include: {
      referred: {
        include: {
          user: { select: { name: true, email: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  const stats = {
    total: referrals.length,
    completed: referrals.filter((r) => r.status === "COMPLETED").length,
    rewarded: referrals.filter((r) => r.status === "REWARDED").length,
    pending: referrals.filter((r) => r.status === "PENDING").length,
    totalXpEarned: referrals
      .filter((r) => r.status === "REWARDED")
      .reduce((sum, r) => sum + r.rewardValue, 0),
  };

  return ok({
    referralCode,
    shareUrl: `${process.env.NEXT_PUBLIC_URL || "http://localhost:3000"}?ref=${referralCode}`,
    stats,
    referrals: referrals.map((r) => ({
      id: r.id,
      status: r.status,
      rewardType: r.rewardType,
      rewardValue: r.rewardValue,
      createdAt: r.createdAt,
      completedAt: r.completedAt,
      referredName: r.referred?.user?.name || "—",
      referredEmail: r.referred?.user?.email || "—",
    })),
  });
}

// POST — process a referral (called when a new student registers with a ref code)
export async function POST(req: Request) {
  const tApi = await getServerT();
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  if (user.role !== "STUDENT") return err(tApi("api.140"), 403);

  const body = await req.json().catch(() => ({}));
  const { referralCode } = body as { referralCode?: string };
  if (!referralCode) return err(tApi("api.142"), 400);

  const student = await db.student.findUnique({ where: { userId: user.id } });
  if (!student) return err(tApi("api.141"), 404);

  // Parse the referral code to find the referrer
  const code = referralCode.trim().toUpperCase();
  if (!code.startsWith("CM-")) return err(tApi("api.143"), 400);

  const suffix = code.slice(3);
  const referrer = await db.student.findFirst({
    where: { id: { contains: suffix.toLowerCase() } },
  });

  if (!referrer) return err(tApi("api.144"), 404);
  if (referrer.id === student.id) return err(tApi("api.145"), 400);

  // Check if referral already exists
  const existing = await db.referral.findUnique({
    where: { referrerId_referredId: { referrerId: referrer.id, referredId: student.id } },
  });
  if (existing) return err(tApi("api.146"), 400);

  // Create referral with BOTH XP + DISCOUNT reward
  const referral = await db.referral.create({
    data: {
      referrerId: referrer.id,
      referredId: student.id,
      rewardType: "BOTH",
      rewardValue: 50,
      status: "COMPLETED",
      completedAt: new Date(),
    },
  });

  // Auto-create a 10% discount coupon for the referrer
  const couponCode = `REF-${referrer.id.slice(-6).toUpperCase()}`;
  const existingCoupon = await db.coupon.findUnique({ where: { code: couponCode } });
  if (!existingCoupon) {
    await db.coupon.create({
      data: {
        code: couponCode,
        type: "PERCENTAGE",
        value: 10,
        maxUses: 1,
        isActive: true,
        description: tApi("api.147"),
        createdById: referrer.userId,
      },
    });
  }

  // Notify the referrer (respects notification preferences)
  const { createNotificationIfAllowed } = await import("@/lib/notify");
  await createNotificationIfAllowed({
    userId: referrer.userId,
    type: "ANNOUNCEMENT",
    title: tApi("api.148"),
    message: tApi("api.149", { p1: user.name, p2: couponCode }),
  });

  return ok({
    referral,
    message: tApi("api.150"),
    rewardCoupon: couponCode,
  });
}
