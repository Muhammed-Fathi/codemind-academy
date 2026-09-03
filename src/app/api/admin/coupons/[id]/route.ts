// CodeMind Academy — Admin Coupon by ID API
import { NextRequest, NextResponse } from "next/server";
import { requireRole, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  const body = await req.json().catch(() => ({}));
  const data: any = {};
  if (body.isActive !== undefined) data.isActive = body.isActive;
  if (body.maxUses !== undefined) data.maxUses = parseInt(body.maxUses, 10);
  if (body.validUntil !== undefined) {
    data.validUntil = body.validUntil ? new Date(body.validUntil) : null;
  }
  if (body.description !== undefined) data.description = body.description;

  const coupon = await db.coupon.update({
    where: { id },
    data,
  });
  return ok({ coupon });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const { id } = await params;
  await db.coupon.delete({ where: { id } });
  return ok({ ok: true });
}
