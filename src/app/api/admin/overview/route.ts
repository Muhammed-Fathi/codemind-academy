// GET /api/admin/overview — full admin dashboard stats
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { ok, err, requireRole } from "@/lib/api";

export async function GET(_req: NextRequest) {
  const { user, error } = await requireRole("ADMIN");
  if (error) return error;
  if (!user) return err("Unauthorized", 401);

  const now = new Date();
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const inSevenDays = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  // Totals
  const [totalStudents, activeStudents, totalTeachers, activeGroups, pendingPayments, activeSubscriptions] =
    await Promise.all([
      db.student.count(),
      db.student.count({
        where: { user: { isActive: true } },
      }),
      db.teacher.count({ where: { user: { isActive: true } } }),
      db.group.count({ where: { isActive: true } }),
      db.payment.count({ where: { status: "PENDING" } }),
      db.subscription.count({ where: { status: "ACTIVE" } }),
    ]);

  // Revenue (approved payments, this month)
  const monthPayments = await db.payment.findMany({
    where: { status: "APPROVED", createdAt: { gte: startOfMonth } },
    select: { amount: true },
  });
  const revenueThisMonth = monthPayments.reduce((s, p) => s + p.amount, 0);

  // Revenue trend (last 6 months)
  const trend: { month: string; revenue: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 1);
    const rows = await db.payment.findMany({
      where: { status: "APPROVED", createdAt: { gte: d, lt: end } },
      select: { amount: true },
    });
    const total = rows.reduce((s, p) => s + p.amount, 0);
    trend.push({
      month: d.toLocaleDateString("en-US", { month: "short" }),
      revenue: total,
    });
  }

  // Group distribution (groups per course)
  const groups = await db.group.findMany({
    where: { isActive: true },
    select: { name: true, courseId: true, course: { select: { nameAr: true } } },
  });
  const groupDist: Record<string, number> = {};
  for (const g of groups) {
    const key = g.course?.nameAr || "—";
    groupDist[key] = (groupDist[key] || 0) + 1;
  }
  const groupDistribution = Object.entries(groupDist).map(([name, value]) => ({ name, value }));

  // Attendance rate across all groups
  const attendanceRows = await db.attendance.groupBy({
    by: ["status"],
    _count: { _all: true },
  });
  const totalAtt = attendanceRows.reduce((s, r) => s + r._count._all, 0);
  const presentAtt =
    attendanceRows.find((r) => r.status === "PRESENT")?._count._all || 0;
  const attendanceRate = totalAtt > 0 ? Math.round((presentAtt / totalAtt) * 100) : 0;

  // Average quiz score across all attempts
  const avg = await db.quizAttempt.aggregate({ _avg: { percentage: true } });
  const avgQuizScore = avg._avg.percentage ? Math.round(avg._avg.percentage) : 0;

  // Upcoming sessions (next 7 days)
  const upcomingSessions = await db.liveSession.findMany({
    where: { startAt: { gte: now, lte: inSevenDays }, status: "SCHEDULED" },
    include: {
      group: { select: { name: true } },
      teacher: { select: { user: { select: { name: true } } } },
      lesson: { select: { titleAr: true } },
    },
    orderBy: { startAt: "asc" },
    take: 6,
  });

  return ok({
    totals: {
      totalStudents,
      activeStudents,
      totalTeachers,
      activeGroups,
      pendingPayments,
      activeSubscriptions,
      revenueThisMonth,
      attendanceRate,
      avgQuizScore,
    },
    revenueTrend: trend,
    groupDistribution,
    upcomingSessions: upcomingSessions.map((s) => ({
      id: s.id,
      title: s.titleAr || s.title,
      startAt: s.startAt,
      groupName: s.group?.name,
      teacherName: s.teacher?.user?.name,
    })),
  });
}
