// CodeMind Academy — Admin Notification Center API
// List all notifications across all users, with filtering + stats.
import { NextRequest, NextResponse } from "next/server";
import { requireRole, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const type = url.searchParams.get("type")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(50, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const where: any = {};
  if (type) where.type = type;

  const [total, notifications, stats] = await Promise.all([
    db.notification.count({ where }),
    db.notification.findMany({
      where,
      include: {
        user: { select: { id: true, name: true, email: true, role: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    // Notification type stats
    db.notification.groupBy({
      by: ["type"],
      _count: { type: true },
      orderBy: { _count: { type: "desc" } },
    }),
  ]);

  // Read/unread stats
  const [totalRead, totalUnread] = await Promise.all([
    db.notification.count({ where: { isRead: true } }),
    db.notification.count({ where: { isRead: false } }),
  ]);

  return ok({
    notifications: notifications.map((n) => ({
      id: n.id,
      userId: n.userId,
      userName: n.user?.name || "—",
      userEmail: n.user?.email || "—",
      userRole: n.user?.role || "—",
      type: n.type,
      title: n.title,
      message: n.message,
      isRead: n.isRead,
      link: n.link,
      createdAt: n.createdAt,
    })),
    stats: {
      total,
      read: totalRead,
      unread: totalUnread,
      byType: stats.map((s) => ({ type: s.type, count: s._count.type })),
    },
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    },
  });
}
