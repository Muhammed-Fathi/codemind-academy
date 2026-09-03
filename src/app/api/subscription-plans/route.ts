import { NextResponse } from "next/server";
import { ok } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const plans = await db.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: [{ isPromo: "desc" }, { price: "asc" }],
  });
  return ok({ plans });
}
