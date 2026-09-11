// GET /api/admin/settings — returns all settings as key-value
// POST /api/admin/settings — body { settings: {key,value}[] } upserts each
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  // Phase 20 — `session:` keys are historical garbage from the pre-UserSession
  // era (the read-time fallback that used them was removed in Phase 20). They
  // are excluded from the admin view and can be purged with
  // scripts/audit-legacy-sessions.mjs --purge.
  const rows = await db.setting.findMany({
    where: { NOT: { key: { startsWith: "session:" } } },
  });
  const settings: Record<string, string> = {};
  for (const r of rows) settings[r.key] = r.value;
  return ok({ settings });
}

export async function POST(req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const items: { key: string; value: string }[] = Array.isArray(body.settings)
    ? body.settings
    : [];

  for (const item of items) {
    if (!item.key || typeof item.value !== "string") continue;
    await db.setting.upsert({
      where: { key: item.key },
      update: { value: item.value },
      create: { key: item.key, value: item.value },
    });
  }

  return ok({ ok: true, updated: items.length });
}
