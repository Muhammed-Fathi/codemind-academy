// CodeMind Academy — Admin Revenue Analytics API
// Returns revenue trends, growth metrics, and payment breakdowns.
import { NextRequest, NextResponse } from "next/server";
import { requireRole, ok, err } from "@/lib/api";
import { db } from "@/lib/db";
import { serverLocale } from "@/lib/i18n-server";

export async function GET(req: NextRequest) {
  const __loc = await serverLocale();
  const __dtLocale = __loc === "en" ? "en-GB" : "ar-EG";
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  const url = new URL(req.url);
  const months = parseInt(url.searchParams.get("months") || "6", 10);
  const numMonths = Math.min(Math.max(months, 1), 24);

  // Get all approved payments
  const payments = await db.payment.findMany({
    where: { status: "APPROVED" },
    select: {
      id: true,
      amount: true,
      method: true,
      createdAt: true,
      userId: true,
    },
    orderBy: { createdAt: "asc" },
  });

  // Build monthly revenue data
  const now = new Date();
  const monthlyData: any[] = [];
  for (let i = numMonths - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
    const monthPayments = payments.filter(
      (p) => p.createdAt >= monthStart && p.createdAt <= monthEnd
    );
    const revenue = monthPayments.reduce((sum, p) => sum + p.amount, 0);
    const monthName = d.toLocaleDateString(__dtLocale, { month: "short" });
    monthlyData.push({
      month: monthName,
      monthFull: d.toLocaleDateString(__dtLocale, { month: "long", year: "numeric" }),
      revenue,
      paymentCount: monthPayments.length,
      avgPayment: monthPayments.length > 0 ? Math.round(revenue / monthPayments.length) : 0,
    });
  }

  // Payment method breakdown
  const methodBreakdown = {
    INSTAPAY: payments.filter((p) => p.method === "INSTAPAY").length,
    VODAFONE_CASH: payments.filter((p) => p.method === "VODAFONE_CASH").length,
    ETISALAT_CASH: payments.filter((p) => p.method === "ETISALAT_CASH").length,
  };
  const methodRevenue = {
    INSTAPAY: payments.filter((p) => p.method === "INSTAPAY").reduce((s, p) => s + p.amount, 0),
    VODAFONE_CASH: payments.filter((p) => p.method === "VODAFONE_CASH").reduce((s, p) => s + p.amount, 0),
    ETISALAT_CASH: payments.filter((p) => p.method === "ETISALAT_CASH").reduce((s, p) => s + p.amount, 0),
  };

  // Growth metrics
  const currentMonthRevenue = monthlyData[monthlyData.length - 1]?.revenue || 0;
  const previousMonthRevenue = monthlyData[monthlyData.length - 2]?.revenue || 0;
  const revenueGrowth = previousMonthRevenue > 0
    ? Math.round(((currentMonthRevenue - previousMonthRevenue) / previousMonthRevenue) * 100)
    : currentMonthRevenue > 0 ? 100 : 0;

  // Total stats
  const totalRevenue = payments.reduce((sum, p) => sum + p.amount, 0);
  const totalPayments = payments.length;
  const avgPaymentValue = totalPayments > 0 ? Math.round(totalRevenue / totalPayments) : 0;

  // Unique paying users
  const uniqueUsers = new Set(payments.map((p) => p.userId)).size;

  // Pending payments
  const pendingPayments = await db.payment.count({ where: { status: "PENDING" } });
  const pendingRevenue = await db.payment.aggregate({
    where: { status: "PENDING" },
    _sum: { amount: true },
  });

  // Active subscriptions
  const activeSubs = await db.subscription.count({ where: { status: "ACTIVE" } });

  return ok({
    overview: {
      totalRevenue,
      totalPayments,
      avgPaymentValue,
      uniquePayingUsers: uniqueUsers,
      pendingPayments,
      pendingRevenue: pendingRevenue._sum.amount || 0,
      activeSubscriptions: activeSubs,
      revenueGrowth,
    },
    monthlyData,
    methodBreakdown,
    methodRevenue,
  });
}
