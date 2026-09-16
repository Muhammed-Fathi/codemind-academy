import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Student Referral API
// Students can share their referral code, track referrals, and earn XP rewards.
import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
// Phase 26G: the shareable referral link comes from the validated application
// origin (src/lib/app-url.ts) instead of an inline
// `process.env.NEXT_PUBLIC_URL || "http://localhost:3000"` fallback.
import { appUrl } from "@/lib/app-url";

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
    shareUrl: appUrl(`/?ref=${encodeURIComponent(referralCode)}`),
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

  // Parse the referral code to find the referrer.
  //
  // Phase 26F IDOR FIX — the referrer was originally resolved with
  // `id: { contains: suffix }`, a SUBSTRING match, then a suffix match that
  // was exact in direction but still not UNIQUE: `Student.id` is a cUID
  // string, and its final six characters are not guaranteed to be unique, so
  // `findFirst` over a suffix predicate could still pick ONE of several
  // students whenever the scan was genuinely ambiguous — misattributing the
  // referral XP and minting the REF- discount coupon for the wrong actor.
  //
  // A referral code can therefore only be honoured when it maps to EXACTLY ONE
  // student, or not at all. Resolution is exact and FAIL-CLOSED:
  //
  //   * the code must be `CM-` + exactly six [A-Za-z0-9] characters — the
  //     format GET returns (`CM-${id.slice(-6).toUpperCase()}`), kept intact
  //     for legacy compatibility;
  //   * EVERY student whose id ENDS in the suffix is read
  //     (`findMany`, never `findFirst` on a non-unique predicate);
  //   * 0 matches  → 404 (the code names nobody);
  //   * 1 match    → continue (the uniquely-identified referrer);
  //   * >1 matches → 404 fail-closed: nothing is awarded, no referral row is
  //     written, no REF- coupon is minted and no notification is sent. An
  //     ambiguous code can neither misplace a reward nor be probed to learn
  //     that a collision exists.
  const code = referralCode.trim().toUpperCase();
  if (!code.startsWith("CM-")) return err(tApi("api.143"), 400);

  const suffix = code.slice(3);
  if (!/^[a-z0-9]{6}$/.test(suffix.toLowerCase())) return err(tApi("api.144"), 404);

  const candidates = await db.student.findMany({
    where: { id: { endsWith: suffix.toLowerCase() } },
    take: 2,
  });
  if (candidates.length === 0) return err(tApi("api.144"), 404);
  if (candidates.length > 1) return err(tApi("api.144"), 404);

  const referrer = candidates[0];
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
