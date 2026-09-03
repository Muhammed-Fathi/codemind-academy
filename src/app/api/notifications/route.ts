import { NextResponse } from "next/server";
import { requireUser, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const notifications = await db.notification.findMany({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return ok({ notifications });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return err("Unauthorized", 401);
  const body = await req.json().catch(() => ({}));
  if (body.markAllRead) {
    await db.notification.updateMany({
      where: { userId: user.id, isRead: false },
      data: { isRead: true },
    });
    return ok({ ok: true });
  }
  const id = String(body.id || "");
  if (id) {
    await db.notification.updateMany({
      where: { id, userId: user.id },
      data: { isRead: true },
    });
  }
  return ok({ ok: true });
}
