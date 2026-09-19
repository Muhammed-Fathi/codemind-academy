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
    // Phase F — `sessionId` is the STRUCTURED part of a session
    // notification: the client renders the Join / Copy-link actions for it and
    // resolves the URL through the authorized join endpoint. The meeting URL
    // itself is never part of a notification (neither stored nor returned).
    // `dedupeKey` is intentionally NOT returned: it is delivery bookkeeping.
    select: {
      id: true,
      type: true,
      title: true,
      message: true,
      isRead: true,
      link: true,
      sessionId: true,
      createdAt: true,
    },
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
