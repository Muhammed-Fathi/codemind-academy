"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  CalendarDays,
  BookOpen,
  Trophy,
  ClipboardList,
  CheckCircle2,
  Clock,
  TrendingUp,
  ChevronLeft,
  Activity,
} from "lucide-react";

type WeeklyReport = {
  studentId: string;
  name: string;
  course: string;
  groupName: string;
  weekRange: { from: string; to: string };
  summary: {
    lessonsViewed: number;
    quizzesTaken: number;
    homeworkSubmitted: number;
    attendanceSessions: number;
    attendancePct: number;
    bestQuizScore: number;
    avgQuizScore: number;
    activeDays: number;
    completionPct: number;
  };
  dailyActivity: {
    day: string;
    date: string;
    lessons: number;
    quizzes: number;
    homework: number;
    attendance: string | null;
  }[];
  recentQuizzes: { title: string; percentage: number; passed: boolean; date: string }[];
  recentHomework: { title: string; status: string; grade: number | null; date: string }[];
};

export function WeeklyReportView({ onClose }: { onClose: () => void }) {
  const [data, setData] = React.useState<{ reports: WeeklyReport[] } | null>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    fetch("/api/parents/me/weekly-report")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => toast.error("حصلت مشكلة"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  if (!data || data.reports.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <CalendarDays className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">مفيش بيانات متاحة</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={onClose}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← رجوع للـDashboard
      </button>

      {data.reports.map((report, ri) => (
        <motion.div
          key={report.studentId}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: ri * 0.1 }}
          className="space-y-4"
        >
          {/* Header */}
          <Card className="glass card-hover overflow-hidden relative">
            <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-amber-500" />
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <div className="grid place-items-center w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg">
                  <CalendarDays className="w-6 h-6" />
                </div>
                <div>
                  <h2 className="text-lg font-bold">Weekly Report — {report.name}</h2>
                  <p className="text-xs text-muted-foreground">
                    {report.weekRange.from} ← {report.weekRange.to}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Summary stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <WeekStat
              icon={BookOpen}
              label="Lessons Viewed"
              value={report.summary.lessonsViewed}
              color="from-emerald-400 to-teal-500"
            />
            <WeekStat
              icon={Trophy}
              label="Quizzes Taken"
              value={report.summary.quizzesTaken}
              sub={`avg ${report.summary.avgQuizScore}%`}
              color="from-amber-400 to-orange-500"
            />
            <WeekStat
              icon={ClipboardList}
              label="Homework Submitted"
              value={report.summary.homeworkSubmitted}
              color="from-teal-400 to-cyan-500"
            />
            <WeekStat
              icon={Activity}
              label="Active Days"
              value={`${report.summary.activeDays}/7`}
              color="from-orange-400 to-rose-500"
            />
          </div>

          {/* Daily activity heatmap */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base">Daily Activity (Last 7 Days)</CardTitle>
              <CardDescription className="text-xs">نشاط يوم بيوم</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-7 gap-2">
                {report.dailyActivity.map((day, i) => {
                  const hasActivity = day.lessons > 0 || day.quizzes > 0 || day.homework > 0;
                  const totalActivity = day.lessons + day.quizzes + day.homework;
                  const intensity = totalActivity === 0 ? 0 : Math.min(100, totalActivity * 30);
                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: i * 0.05 }}
                      className="text-center"
                    >
                      <div className="text-[10px] font-bold text-muted-foreground mb-1">
                        {day.day}
                      </div>
                      <div
                        className="aspect-square rounded-lg border-2 transition-all flex flex-col items-center justify-center p-1"
                        style={{
                          background: hasActivity
                            ? `oklch(0.62 0.15 162 / ${intensity / 100 + 0.05})`
                            : "transparent",
                          borderColor: hasActivity ? "oklch(0.62 0.15 162 / 30%)" : "oklch(0.91 0.01 165)",
                        }}
                      >
                        {hasActivity ? (
                          <div className="text-[9px] font-bold text-primary">
                            {totalActivity}
                          </div>
                        ) : (
                          <div className="text-[9px] text-muted-foreground/40">—</div>
                        )}
                        {day.attendance === "PRESENT" && (
                          <CheckCircle2 className="w-3 h-3 text-emerald-500 mt-0.5" />
                        )}
                        {day.attendance === "ABSENT" && (
                          <div className="w-2 h-2 rounded-full bg-rose-500 mt-0.5" />
                        )}
                      </div>
                      <div className="text-[8px] text-muted-foreground mt-0.5">{day.date}</div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Recent quizzes + homework */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-amber-500" />
                  Quizzes this week
                </CardTitle>
              </CardHeader>
              <CardContent>
                {report.recentQuizzes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">مفيش Quizzes هذا الأسبوع</p>
                ) : (
                  <div className="space-y-2">
                    {report.recentQuizzes.map((q, i) => (
                      <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                        <div className={`grid place-items-center w-8 h-8 rounded-lg ${
                          q.passed ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"
                        }`}>
                          {q.passed ? <CheckCircle2 className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold truncate">{q.title}</div>
                          <div className="text-[10px] text-muted-foreground">{q.date}</div>
                        </div>
                        <Badge variant="outline" className={`text-[10px] ${
                          q.passed ? "border-emerald-400/30 text-emerald-600" : "border-amber-400/30 text-amber-600"
                        }`}>
                          {q.percentage}%
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-teal-500" />
                  Homework this week
                </CardTitle>
              </CardHeader>
              <CardContent>
                {report.recentHomework.length === 0 ? (
                  <p className="text-xs text-muted-foreground">مفيش واجبات هذا الأسبوع</p>
                ) : (
                  <div className="space-y-2">
                    {report.recentHomework.map((h, i) => (
                      <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                        <div className="grid place-items-center w-8 h-8 rounded-lg bg-teal-500/10 text-teal-600">
                          <ClipboardList className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold truncate">{h.title}</div>
                          <div className="text-[10px] text-muted-foreground">{h.date}</div>
                        </div>
                        <Badge variant="outline" className={`text-[10px] ${
                          h.status === "GRADED" ? "border-emerald-400/30 text-emerald-600" :
                          h.status === "SUBMITTED" ? "border-amber-400/30 text-amber-600" :
                          "border-muted text-muted-foreground"
                        }`}>
                          {h.status === "GRADED" ? `${h.grade}/10` : h.status}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

function WeekStat({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  sub?: string;
  color: string;
}) {
  return (
    <Card className="glass card-hover stat-glow">
      <CardContent className="p-4">
        <div className={`grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br ${color} text-white mb-2`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="text-xl font-extrabold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}
