"use client";

import * as React from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import {
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip as ReTooltip,
  RadialBarChart,
  RadialBar,
} from "recharts";
import { toast } from "sonner";
import {
  TrendingUp,
  TrendingDown,
  Trophy,
  AlertTriangle,
  CheckCircle2,
  Clock,
  BookOpen,
  CalendarDays,
  BarChart3,
} from "lucide-react";

type ChildAnalytics = {
  studentId: string;
  name: string;
  email: string;
  course: string;
  groupName: string;
  quizTrend: { title: string; percentage: number; passed: boolean; date: string }[];
  attendanceByMonth: { month: string; pct: number; present: number; total: number }[];
  strongTopics: { title: string; avgPct: number }[];
  weakTopics: { title: string; avgPct: number }[];
  completionPct: number;
  completedLessons: number;
  totalLessons: number;
  homeworkSubmitted: number;
  homeworkGraded: number;
  homeworkAvgGrade: number;
  totalQuizzes: number;
  avgQuizPct: number;
  attendancePct: number;
};

export function ParentAnalyticsView({ onClose }: { onClose: () => void }) {
  const [data, setData] = React.useState<{ children: ChildAnalytics[] } | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [activeChild, setActiveChild] = React.useState(0);

  React.useEffect(() => {
    fetch("/api/parents/me/analytics")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => toast.error("حصلت مشكلة في تحميل التحليلات"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  if (!data || data.children.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <BarChart3 className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">مفيش بيانات تحليلية متاحة</p>
        </CardContent>
      </Card>
    );
  }

  const child = data.children[activeChild];

  return (
    <div className="space-y-4">
      <button
        onClick={onClose}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        ← رجوع للـDashboard
      </button>

      {/* Child selector */}
      {data.children.length > 1 && (
        <div className="flex gap-2">
          {data.children.map((c, i) => (
            <button
              key={c.studentId}
              onClick={() => setActiveChild(i)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                activeChild === i
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted/50 text-muted-foreground hover:bg-primary/10 hover:text-primary"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
      )}

      {/* Overview stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <AnalyticsStat
          icon={CheckCircle2}
          label="Course Progress"
          value={`${child.completionPct}%`}
          sub={`${child.completedLessons}/${child.totalLessons} Lessons`}
          color="from-emerald-400 to-teal-500"
        />
        <AnalyticsStat
          icon={CalendarDays}
          label="Attendance"
          value={`${child.attendancePct}%`}
          sub="آخر 6 شهور"
          color="from-teal-400 to-cyan-500"
        />
        <AnalyticsStat
          icon={Trophy}
          label="Avg Quiz Score"
          value={`${child.avgQuizPct}%`}
          sub={`${child.totalQuizzes} quizzes`}
          color="from-amber-400 to-orange-500"
        />
        <AnalyticsStat
          icon={BookOpen}
          label="Homework"
          value={`${child.homeworkGraded}`}
          sub={`avg ${child.homeworkAvgGrade}/10`}
          color="from-orange-400 to-rose-500"
        />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Quiz Performance Trend */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="w-5 h-5 text-primary" />
              Quiz Performance Trend
            </CardTitle>
            <CardDescription className="text-xs">آخر 10 Quizzes</CardDescription>
          </CardHeader>
          <CardContent>
            <div dir="ltr" className="w-full h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={child.quizTrend.map((q, i) => ({ name: `Q${i + 1}`, pct: q.percentage }))}>
                  <defs>
                    <linearGradient id="quizLineGrad" x1="0" y1="0" x2="1" y2="0">
                      <stop offset="0%" stopColor="#10b981" />
                      <stop offset="100%" stopColor="#f59e0b" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.91 0.01 165)" vertical={false} />
                  <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <ReTooltip
                    contentStyle={{ borderRadius: 8, border: "1px solid oklch(0.91 0.01 165)", fontSize: 12 }}
                    formatter={(v: any) => [`${v}%`, "Score"]}
                  />
                  <Line type="monotone" dataKey="pct" stroke="url(#quizLineGrad)" strokeWidth={2.5} dot={{ fill: "#10b981", r: 3 }} activeDot={{ r: 5 }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Attendance by Month */}
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarDays className="w-5 h-5 text-teal-500" />
              Attendance by Month
            </CardTitle>
            <CardDescription className="text-xs">آخر 6 شهور</CardDescription>
          </CardHeader>
          <CardContent>
            <div dir="ltr" className="w-full h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={child.attendanceByMonth}>
                  <defs>
                    <linearGradient id="attBarGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#14b8a6" />
                      <stop offset="100%" stopColor="#10b981" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.91 0.01 165)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <ReTooltip
                    contentStyle={{ borderRadius: 8, border: "1px solid oklch(0.91 0.01 165)", fontSize: 12 }}
                    formatter={(v: any) => [`${v}%`, "Attendance"]}
                  />
                  <Bar dataKey="pct" fill="url(#attBarGrad)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Strong / Weak Topics */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-emerald-600">
              <TrendingUp className="w-5 h-5" />
              Strong Topics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {child.strongTopics.length === 0 ? (
              <p className="text-xs text-muted-foreground">مفيش بيانات كفاية</p>
            ) : (
              child.strongTopics.map((t) => (
                <div key={t.title} className="flex items-center gap-3 p-2 rounded-lg bg-emerald-500/5 border border-emerald-400/20">
                  <div className="grid place-items-center w-7 h-7 rounded-md bg-emerald-500/10 text-emerald-600 text-xs font-bold">
                    {t.avgPct}%
                  </div>
                  <span className="flex-1 text-sm truncate">{t.title}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              Weak Topics
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {child.weakTopics.length === 0 ? (
              <p className="text-xs text-muted-foreground">مفيش بيانات كفاية</p>
            ) : (
              child.weakTopics.map((t) => (
                <div key={t.title} className="flex items-center gap-3 p-2 rounded-lg bg-amber-500/5 border border-amber-400/20">
                  <div className="grid place-items-center w-7 h-7 rounded-md bg-amber-500/10 text-amber-600 text-xs font-bold">
                    {t.avgPct}%
                  </div>
                  <span className="flex-1 text-sm truncate">{t.title}</span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Progress ring */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base">Course Completion</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center">
          <div dir="ltr" className="w-48 h-48">
            <ResponsiveContainer width="100%" height="100%">
              <RadialBarChart
                innerRadius="70%"
                outerRadius="100%"
                data={[{ value: child.completionPct, fill: "#10b981" }]}
                startAngle={90}
                endAngle={-270}
              >
                <RadialBar background dataKey="value" cornerRadius={10} />
              </RadialBarChart>
            </ResponsiveContainer>
          </div>
          <div className="absolute text-center">
            <div className="text-3xl font-extrabold text-gradient">{child.completionPct}%</div>
            <div className="text-xs text-muted-foreground">{child.completedLessons}/{child.totalLessons} Lessons</div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function AnalyticsStat({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <Card className="glass card-hover stat-glow">
      <CardContent className="p-4">
        <div className={`grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br ${color} text-white mb-2`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="text-2xl font-extrabold number-counter">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>
      </CardContent>
    </Card>
  );
}
