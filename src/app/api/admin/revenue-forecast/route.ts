// CodeMind Academy — Admin Revenue Forecast API
// Predicts future revenue based on historical trends using linear regression.
import { NextResponse } from "next/server";
import { requireRole, ok, err } from "@/lib/api";
import { db } from "@/lib/db";

export async function GET() {
  const { error } = await requireRole("ADMIN");
  if (error) return error;

  // Get all approved payments
  const payments = await db.payment.findMany({
    where: { status: "APPROVED" },
    select: { amount: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  // Build monthly revenue data (last 6 months)
  const now = new Date();
  const monthlyRevenue: { month: string; revenue: number; count: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const monthStart = new Date(d.getFullYear(), d.getMonth(), 1);
    const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59);
    const monthPayments = payments.filter(
      (p) => p.createdAt >= monthStart && p.createdAt <= monthEnd
    );
    monthlyRevenue.push({
      month: d.toLocaleDateString("ar-EG", { month: "short" }),
      revenue: monthPayments.reduce((sum, p) => sum + p.amount, 0),
      count: monthPayments.length,
    });
  }

  // Simple linear regression for forecasting
  // y = mx + b, where x = month index, y = revenue
  const n = monthlyRevenue.length;
  const xValues = Array.from({ length: n }, (_, i) => i);
  const yValues = monthlyRevenue.map((m) => m.revenue);

  const sumX = xValues.reduce((a, b) => a + b, 0);
  const sumY = yValues.reduce((a, b) => a + b, 0);
  const sumXY = xValues.reduce((sum, x, i) => sum + x * yValues[i], 0);
  const sumX2 = xValues.reduce((sum, x) => sum + x * x, 0);

  const slope = n > 0 && (n * sumX2 - sumX * sumX) !== 0
    ? (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX)
    : 0;
  const intercept = n > 0 ? (sumY - slope * sumX) / n : 0;

  // Forecast next 3 months
  const forecast: { month: string; predicted: number; confidence: "low" | "medium" | "high" }[] = [];
  for (let i = 1; i <= 3; i++) {
    const predicted = Math.max(0, Math.round(slope * (n + i - 1) + intercept));
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    // Confidence based on data quality (more months = higher confidence)
    const confidence: "low" | "medium" | "high" = n >= 4 ? "high" : n >= 2 ? "medium" : "low";
    forecast.push({
      month: d.toLocaleDateString("ar-EG", { month: "short" }),
      predicted,
      confidence,
    });
  }

  // Calculate trend direction
  const avgRevenue = n > 0 ? Math.round(sumY / n) : 0;
  const trendDirection = slope > 0 ? "growing" : slope < 0 ? "declining" : "stable";
  const trendPercentage = avgRevenue > 0 ? Math.round((slope / avgRevenue) * 100) : 0;

  // Key metrics
  const lastMonthRevenue = monthlyRevenue[n - 1]?.revenue || 0;
  const prevMonthRevenue = monthlyRevenue[n - 2]?.revenue || 0;
  const monthOverMonthGrowth = prevMonthRevenue > 0
    ? Math.round(((lastMonthRevenue - prevMonthRevenue) / prevMonthRevenue) * 100)
    : lastMonthRevenue > 0 ? 100 : 0;

  // Projected Q+1 (next quarter) revenue
  const projectedQuarterRevenue = forecast.reduce((sum, f) => sum + f.predicted, 0);

  // Active subscription renewal rate (how many will renew next month)
  const activeSubs = await db.subscription.count({ where: { status: "ACTIVE" } });
  const expiringThisMonth = await db.subscription.count({
    where: {
      status: "ACTIVE",
      endDate: {
        gte: new Date(),
        lte: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59),
      },
    },
  });

  return ok({
    historical: monthlyRevenue,
    forecast,
    metrics: {
      avgMonthlyRevenue: avgRevenue,
      trendDirection,
      trendPercentage,
      monthOverMonthGrowth,
      projectedQuarterRevenue,
      slope: Math.round(slope),
      intercept: Math.round(intercept),
    },
    subscriptions: {
      active: activeSubs,
      expiringThisMonth,
      expectedRenewalRate: activeSubs > 0 ? Math.round(((activeSubs - expiringThisMonth) / activeSubs) * 100) : 100,
    },
  });
}
