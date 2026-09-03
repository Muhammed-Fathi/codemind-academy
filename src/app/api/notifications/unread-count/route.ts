import { NextResponse } from "next/server";
import { requireUser } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const user = await requireUser();
  if (!user) return NextResponse.json({ count: 0 });
  const count = await db.notification.count({
    where: { userId: user.id, isRead: false },
  });
  return NextResponse.json({ count });
}
