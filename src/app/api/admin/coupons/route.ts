import { getServerT } from "@/lib/i18n-server";
// CodeMind Academy — Admin Coupons API
import { NextRequest, NextResponse } from "next/server";
import { requireRole, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

// GET /api/admin/coupons — list all coupons
export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const coupons = await db.coupon.findMany({
    include: {
      _count: { select: { redemptions: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return ok({
    coupons: coupons.map((c) => ({
      id: c.id,
      code: c.code,
      type: c.type,
      value: c.value,
      maxUses: c.maxUses,
      usedCount: c.usedCount,
      redemptionsCount: c._count.redemptions,
      validFrom: c.validFrom,
      validUntil: c.validUntil,
      isActive: c.isActive,
      description: c.description,
      createdAt: c.createdAt,
    })),
  });
}

// POST /api/admin/coupons — create coupon
export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const { code, type, value, maxUses, validUntil, description } = body as {
    code?: string;
    type?: string;
    value?: number;
    maxUses?: number;
    validUntil?: string;
    description?: string;
  };

  if (!code || !type || value === undefined)
    return err(tApi("api.014"), 400);

  const upperCode = code.trim().toUpperCase();
  if (upperCode.length < 3) return err(tApi("api.015"), 400);

  const exists = await db.coupon.findUnique({ where: { code: upperCode } });
  if (exists) return err(tApi("api.016"), 409);

  const coupon = await db.coupon.create({
    data: {
      code: upperCode,
      type: type === "FIXED" ? "FIXED" : "PERCENTAGE",
      value: parseFloat(String(value)),
      maxUses: parseInt(String(maxUses || 100), 10),
      validUntil: validUntil ? new Date(validUntil) : null,
      description: description || null,
      createdById: user.id,
    },
  });

  return ok({ coupon });
}
