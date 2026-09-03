import { NextResponse } from "next/server";
import { ok } from "@/lib/api";
import { db } from "@/lib/db";

// Public-facing settings (no auth needed) — only safe keys are exposed.
const PUBLIC_KEYS = [
  "brand_name",
  "brand_tagline",
  "whatsapp_teacher",
  "whatsapp_technical",
  "whatsapp_subscription",
  "academic_year",
  "price_monthly",
  "price_3months",
  "price_6months",
  "price_early_bird",
];

export async function GET() {
  const rows = await db.setting.findMany({
    where: { key: { in: PUBLIC_KEYS } },
  });
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  return ok({ settings });
}
