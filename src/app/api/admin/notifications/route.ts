import { getServerT } from "@/lib/i18n-server";
// POST /api/admin/notifications — send notification to a user, a group's students, or everyone
// GET /api/admin/notifications — recent notifications (admin view)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";
import { NotificationType } from "@prisma/client";

const VALID_TYPES: NotificationType[] = [
  "NEW_LESSON",
  "NEW_QUIZ",
  "QUIZ_RESULT",
  "NEW_HOMEWORK",
  "HOMEWORK_DEADLINE",
  "UPCOMING_SESSION",
  "LOW_ATTENDANCE",
  "MONTHLY_REPORT",
  "SUBSCRIPTION_EXPIRATION",
  "ANNOUNCEMENT",
  "PAYMENT_APPROVED",
  "PAYMENT_REJECTED",
];

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const limit = Math.min(Number(url.searchParams.get("limit") || 50), 200);

  const notifications = await db.notification.findMany({
    include: { user: { select: { name: true, email: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
  return ok({ notifications });
}

export async function POST(req: NextRequest) {
  const tApi = await getServerT();
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const body = await req.json().catch(() => ({}));
  const title = String(body.title || "").trim();
  const message = String(body.message || "").trim();
  const type = (VALID_TYPES.includes(body.type) ? body.type : "ANNOUNCEMENT") as NotificationType;
  const link = body.link ? String(body.link) : null;

  if (!title || !message) return err(tApi("api.023"), 400);

  const target = body.target || "all";
  const userIds: string[] = [];

  if (target === "user" && body.userId) {
    userIds.push(String(body.userId));
  } else if (target === "group" && body.groupId) {
    const students = await db.student.findMany({
      where: { groupId: String(body.groupId) },
      select: { userId: true },
    });
    userIds.push(...students.map((s) => s.userId));
  } else if (target === "students") {
    const students = await db.student.findMany({ select: { userId: true } });
    userIds.push(...students.map((s) => s.userId));
  } else if (target === "parents") {
    const parents = await db.parent.findMany({ select: { userId: true } });
    userIds.push(...parents.map((p) => p.userId));
  } else if (target === "teachers") {
    const teachers = await db.teacher.findMany({ select: { userId: true } });
    userIds.push(...teachers.map((t) => t.userId));
  } else {
    const users = await db.user.findMany({
      where: { isActive: true },
      select: { id: true },
    });
    userIds.push(...users.map((u) => u.id));
  }

  if (userIds.length === 0) return err(tApi("api.024"), 400);

  await db.notification.createMany({
    data: userIds.map((uid) => ({
      userId: uid,
      type,
      title,
      message,
      link,
    })),
  });

  return ok({ ok: true, sent: userIds.length });
}
