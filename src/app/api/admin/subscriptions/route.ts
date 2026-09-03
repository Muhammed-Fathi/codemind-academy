// GET /api/admin/subscriptions?status=&page=1&pageSize=20 — list subscriptions + plans
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

export async function GET(req: NextRequest) {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const status = url.searchParams.get("status")?.trim() || "";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
  const pageSize = Math.min(100, Math.max(1, parseInt(url.searchParams.get("pageSize") || "20", 10)));

  const where: any = {};
  if (status === "PENDING" || status === "ACTIVE" || status === "EXPIRED" || status === "CANCELLED") {
    where.status = status;
  }

  const [total, subs] = await Promise.all([
    db.subscription.count({ where }),
    db.subscription.findMany({
      where,
      include: {
        student: { include: { user: { select: { name: true, email: true } } } },
        plan: true,
        payments: { select: { id: true, amount: true, status: true, createdAt: true } },
      },
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ]);

  const plans = await db.subscriptionPlan.findMany({ orderBy: { price: "asc" } });

  return ok({
    subscriptions: subs.map((s) => ({
      id: s.id,
      studentId: s.studentId,
      studentName: s.student?.user?.name,
      studentEmail: s.student?.user?.email,
      plan: s.plan,
      status: s.status,
      startDate: s.startDate,
      endDate: s.endDate,
      createdAt: s.createdAt,
      payments: s.payments,
    })),
    plans,
    pagination: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      hasMore: page * pageSize < total,
    },
  });
}
