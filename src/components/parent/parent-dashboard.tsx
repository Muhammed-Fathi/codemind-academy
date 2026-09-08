"use client";
import { useT, translate, useLocale, pickAuto } from "@/lib/i18n";
import { useApp } from "@/lib/store";

// ============================================================
// CodeMind Academy — Parent Dashboard (Task 3)
// Egyptian Arabic-first RTL UI answering "ابني مستواه عامل إزاي؟"
// Renders inside <DashboardShell> (children) — does not render its own sidebar.
// ============================================================
import * as React from "react";
import { motion } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { MonthlyReportView } from "@/components/parent/monthly-report";
import {
  describeParentSubscription,
  type ParentSubscriptionPayload,
} from "@/lib/parent-subscription";
import { NotificationPreferences } from "@/components/shared/notification-preferences";
import { ParentAnalyticsView } from "@/components/parent/analytics-view";
import { WeeklyReportView } from "@/components/parent/weekly-report";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Progress } from "@/components/ui/progress";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Tooltip as RTooltip,
  ResponsiveContainer,
  LineChart,
  Line,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Cell,
} from "recharts";

import {
  Trophy,
  CalendarDays,
  FileText,
  BookOpen,
  CreditCard,
  TrendingUp,
  MessageSquare,
  Download,
  Clock,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Sparkles,
  Video,
  GraduationCap,
  Award,
  ArrowDownRight,
  ArrowUpRight,
  RefreshCw,
  Bell,
  ChevronLeft,
} from "lucide-react";

// ---------- Types (match GET /api/parents/me/dashboard payload) ----------
type Child = {
  id: string;
  linkId: string;
  relation: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  grade: string;
  schoolName: string | null;
  schoolType?: string | null;
  nationalId?: string | null;
  parentPhone?: string | null;
  studentCode?: string | null;
  enrolledAt: string;
  group: {
    id: string;
    name: string;
    schedule: string;
    course: {
      id: string;
      slug: string;
      name: string;
      nameAr: string;
      color: string;
      iconUrl: string | null;
    } | null;
  } | null;
  courseProgress: { completed: number; total: number; pct: number };
  attendance: {
    pct: number;
    present: number;
    total: number;
    byMonth: { month: string; pct: number; present: number; total: number }[];
  };
  quizzes: {
    average: number;
    attempts: number;
    passed: number;
    failed: number;
    recent: {
      id: string;
      quizId: string;
      quizTitle: string;
      score: number;
      totalMarks: number;
      percentage: number;
      passed: boolean;
      finishedAt: string;
    }[];
  };
  performanceTrend: {
    label: string;
    title: string;
    pct: number;
    date: string;
  }[];
  homework: {
    total: number;
    submitted: number;
    pending: number;
    completionPct: number;
    recent: {
      id: string;
      title: string;
      status: string;
      grade: number | null;
      maxGrade: number;
      deadline: string;
      submittedAt: string | null;
      feedback: string | null;
    }[];
  };
  teacherNotes: {
    id: string;
    note: string;
    teacherName: string;
    createdAt: string;
  }[];
  nextSession: {
    id: string;
    title: string;
    startAt: string;
    duration: number;
    meetingUrl: string | null;
    teacherName: string;
    lessonTitle: string | null;
  } | null;
  // null when the student registered but has not enrolled in a plan yet.
  subscription: ParentSubscriptionPayload | null;
  strongTopics: { id: string; title: string; avgPct: number }[];
  weakTopics: { id: string; title: string; avgPct: number }[];
  recentActivity: {
    type: "quiz" | "homework" | "attendance" | "lesson";
    title: string;
    description: string;
    time: string;
    kind: "good" | "neutral" | "warn";
  }[];
  // Finished mock exams only, kept separate from session quizzes (Phase 7).
  mockExams?: {
    attempts: number;
    average: number;
    best: number | null;
    passed: number;
    failed: number;
    recent: {
      id: string;
      examType: string;
      mockExamTitle: string;
      questionCount: number;
      score: number;
      totalMarks: number;
      percentage: number;
      passed: boolean;
      finishedAt: string;
    }[];
  };
  // Session unlock state from the Phase 4 engine; null when unenrolled.
  sessionProgress?: {
    total: number;
    completed: number;
    unlocked: number;
    locked: number;
    currentLessonId: string | null;
    currentLessonTitle: string | null;
  } | null;
};

type DashboardPayload = {
  parent: {
    id: string;
    name: string;
    email: string;
    phone: string | null;
    avatarUrl: string | null;
  };
  children: Child[];
};

// ---------- Animation variants ----------
const containerVariants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.06 },
  },
};
const itemVariants = {
  hidden: { opacity: 0, y: 12 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.4, ease: "easeOut" as const },
  },
};

// ---------- Helpers ----------
const curLocale = () => (useApp.getState().locale === "en" ? "en" : "ar");
const dtLocale = () => (curLocale() === "en" ? "en-GB" : "ar-EG");
function timeAgoAr(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diff = Date.now() - d.getTime();
  const day = 24 * 60 * 60 * 1000;
  const hour = 60 * 60 * 1000;
  const min = 60 * 1000;
  if (diff < min) return translate(curLocale(), "parent.043");
  if (diff < hour) return translate(curLocale(), "parent.044");
  if (diff < day) return translate(curLocale(), "parent.045");
  if (diff < 30 * day) return translate(curLocale(), "parent.046");
  return d.toLocaleDateString(dtLocale(), { day: "numeric", month: "short" });
}

function formatDateAr(date: string | Date): string {
  const d = typeof date === "string" ? new Date(date) : date;
  return d.toLocaleDateString(dtLocale(), {
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ---------- Main ----------
export function ParentDashboard() {
  const tr = useT();
  const locale = useLocale();
  const { data, isLoading, isError, refetch } = useQuery({
    queryKey: ["parent-dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/parents/me/dashboard", { cache: "no-store" });
      if (!r.ok) throw new Error("failed to load dashboard");
      return (await r.json()) as DashboardPayload;
    },
  });

  const [activeChildId, setActiveChildId] = React.useState<string | null>(null);
  const [showReport, setShowReport] = React.useState(false);
  const [showPrefs, setShowPrefs] = React.useState(false);
  const [showAnalytics, setShowAnalytics] = React.useState(false);
  const [showWeekly, setShowWeekly] = React.useState(false);
  React.useEffect(() => {
    if (data?.children?.length && !activeChildId) {
      setActiveChildId(data.children[0].id);
    }
  }, [data, activeChildId]);

  if (showReport) {
    // Phase 7: the report covers the SELECTED child, not children[0].
    return (
      <MonthlyReportView
        onClose={() => setShowReport(false)}
        studentId={activeChildId}
      />
    );
  }

  if (showAnalytics) {
    return (
      <ParentAnalyticsView
        onClose={() => setShowAnalytics(false)}
        initialStudentId={activeChildId}
      />
    );
  }

  if (showWeekly) {
    return <WeeklyReportView onClose={() => setShowWeekly(false)} />;
  }

  if (showPrefs) {
    return (
      <div className="space-y-4">
        <button
          onClick={() => setShowPrefs(false)}
          className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
        >
          <ChevronLeft className="w-4 h-4 flip-rtl" />
          {tr("parent.047")}</button>
        <NotificationPreferences />
      </div>
    );
  }

  if (isLoading) return <DashboardSkeleton />;
  if (isError || !data) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 text-center">
        <AlertTriangle className="w-10 h-10 text-amber-500" />
        <div>
          <p className="text-lg font-bold">{tr("parent.048")}</p>
          <p className="text-sm text-muted-foreground mt-1">
            {tr("parent.049")}</p>
        </div>
        <Button onClick={() => refetch()} variant="outline">
          <RefreshCw className="w-4 h-4 ms-2" />
          {tr("parent.050")}</Button>
      </div>
    );
  }

  if (!data.children.length) {
    return <EmptyParentState parentName={data.parent.name} />;
  }

  const child =
    data.children.find((c) => c.id === activeChildId) || data.children[0];

  return (
    <motion.div
      variants={containerVariants}
      initial="hidden"
      animate="show"
      className="space-y-6"
    >
      {/* Welcome header */}
      <motion.div
        variants={itemVariants}
        className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3"
      >
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
            {tr("parent.051")}<span className="text-gradient">{data.parent.name}</span> 👋
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            {tr("parent.052")}</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowAnalytics(true)}
          >
            <TrendingUp className="w-4 h-4 ms-2" />
            Analytics
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowWeekly(true)}
            className="border-primary/30 text-primary hover:bg-primary/5"
          >
            <CalendarDays className="w-4 h-4 ms-2" />
            Weekly Report
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowReport(true)}
          >
            <Download className="w-4 h-4 ms-2" />
            Monthly Report
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowPrefs(true)}
          >
            <Bell className="w-4 h-4 ms-2" />
            {tr("parent.053")}</Button>
          <LinkStudentButton />
        </div>
      </motion.div>

      {/* Student selector (tabs) */}
      {data.children.length > 1 && (
        <motion.div variants={itemVariants}>
          <Tabs value={child.id} onValueChange={setActiveChildId}>
            <TabsList>
              {data.children.map((c) => (
                <TabsTrigger key={c.id} value={c.id} className="gap-1.5">
                  <GraduationCap className="w-3.5 h-3.5" />
                  {c.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </motion.div>
      )}

      {/* Child summary banner */}
      <motion.div variants={itemVariants}>
        <ChildSummaryCard child={child} />
      </motion.div>

      {/* Analytics grid (6 cards) */}
      <motion.div
        variants={itemVariants}
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4"
      >
        <ProgressRingCard
          pct={child.courseProgress.pct}
          sub={`${child.courseProgress.completed}/${child.courseProgress.total} Lessons`}
          session={child.sessionProgress}
        />
        <AttendanceCard attendance={child.attendance} />
        <QuizAverageCard
          average={child.quizzes.average}
          attempts={child.quizzes.attempts}
          passed={child.quizzes.passed}
        />
        <HomeworkCard homework={child.homework} />
        <MonthlyExamCard mockExams={child.mockExams} />
        <SubscriptionCard subscription={child.subscription} />
      </motion.div>

      {/* Strong / Weak Topics row */}
      <motion.div
        variants={itemVariants}
        className="grid grid-cols-1 lg:grid-cols-2 gap-4"
      >
        <TopicsCard kind="strong" topics={child.strongTopics} />
        <TopicsCard kind="weak" topics={child.weakTopics} />
      </motion.div>

      {/* Performance Trend + Next Session */}
      <motion.div
        variants={itemVariants}
        className="grid grid-cols-1 lg:grid-cols-3 gap-4"
      >
        <Card className="glass card-hover lg:col-span-2 p-6">
          <CardHeader className="px-0 pt-0">
            <div className="flex items-center justify-between">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-primary" />
                  Performance Trend
                </CardTitle>
                <CardDescription className="mt-1">
                  {tr("parent.054")}</CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent className="px-0">
            <PerformanceTrendChart data={child.performanceTrend} />
          </CardContent>
        </Card>
        <NextSessionCard session={child.nextSession} />
      </motion.div>

      {/* Teacher Notes + Recent Activity */}
      <motion.div
        variants={itemVariants}
        className="grid grid-cols-1 lg:grid-cols-2 gap-4"
      >
        <TeacherNotesCard notes={child.teacherNotes} />
        <RecentActivityCard activities={child.recentActivity} />
      </motion.div>

      {/* Footer note */}
      <motion.div
        variants={itemVariants}
        className="text-center text-xs text-muted-foreground pt-2 pb-1"
      >
        {tr("parent.055")}</motion.div>
    </motion.div>
  );
}

// ============================================================
// Child Summary Card
// ============================================================
function ChildSummaryCard({ child }: { child: Child }) {
  const tr = useT();
  const course = child.group?.course;
  return (
    <Card className="glass-strong card-hover p-6 overflow-hidden relative">
      <div className="absolute -top-12 -start-12 w-48 h-48 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-16 -end-12 w-56 h-56 rounded-full bg-amber-300/10 blur-3xl pointer-events-none" />
      <div className="relative flex flex-col sm:flex-row sm:items-center gap-4">
        <Avatar className="w-16 h-16 ring-2 ring-primary/20">
          <AvatarFallback className="bg-primary/10 text-primary text-lg font-bold">
            {child.name.slice(0, 2).toUpperCase()}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h2 className="text-xl font-bold">{child.name}</h2>
            <Badge variant="secondary" className="text-[11px]">
              {child.grade}
            </Badge>
            {child.studentCode && (
              <Badge variant="outline" className="text-[11px] font-mono font-bold text-primary border-primary/30" dir="ltr">
                {child.studentCode}
              </Badge>
            )}
          </div>
          <p className="text-sm text-muted-foreground mt-0.5">
            {pickAuto(course?.nameAr, course?.name) || "—"}
            {child.schoolName ? ` · ${child.schoolName}` : ""}
            {child.studentCode ? tr("parent.056", { p1: child.studentCode }) : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <div className="flex flex-col items-center px-3 py-1.5 rounded-lg bg-primary/5">
            <span className="font-bold text-lg text-primary">
              {child.attendance.pct}%
            </span>
            <span className="text-muted-foreground text-[10px]">Attendance</span>
          </div>
          <div className="flex flex-col items-center px-3 py-1.5 rounded-lg bg-amber-400/5">
            <span className="font-bold text-lg text-amber-600 dark:text-amber-400">
              {child.quizzes.average}%
            </span>
            <span className="text-muted-foreground text-[10px]">Quiz Avg</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

// ============================================================
// Card 1: Animated Progress Ring
// ============================================================
function ProgressRingCard({
  pct,
  sub,
  session,
}: {
  pct: number;
  sub: string;
  session?: Child["sessionProgress"];
}) {
  const tr = useT();
  const radius = 52;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (pct / 100) * circumference;
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
          <BookOpen className="w-4 h-4 text-primary" />
          Course Progress
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 flex items-center justify-between gap-3">
        {/* The progress ring is a geometric figure, so it must not mirror in
            RTL. `dir` is applied to the wrapper, not the <svg> element. */}
        <div className="relative w-[120px] h-[120px]" dir="ltr">
          <svg width="120" height="120" viewBox="0 0 120 120">
            <circle
              cx="60"
              cy="60"
              r={radius}
              stroke="currentColor"
              strokeWidth="10"
              fill="none"
              className="text-muted/40"
            />
            <motion.circle
              cx="60"
              cy="60"
              r={radius}
              stroke="url(#progressGradient)"
              strokeWidth="10"
              strokeLinecap="round"
              fill="none"
              transform="rotate(-90 60 60)"
              initial={{ strokeDashoffset: circumference }}
              animate={{ strokeDashoffset: offset }}
              transition={{ duration: 1.2, ease: "easeOut" }}
            />
            <defs>
              <linearGradient
                id="progressGradient"
                x1="0%"
                y1="0%"
                x2="100%"
                y2="100%"
              >
                <stop offset="0%" stopColor="var(--chart-1)" />
                <stop offset="50%" stopColor="var(--chart-3)" />
                <stop offset="100%" stopColor="var(--chart-2)" />
              </linearGradient>
            </defs>
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl font-extrabold text-gradient">{pct}%</span>
          </div>
        </div>
        <div className="text-end">
          <div className="text-xs text-muted-foreground">{tr("parent.057")}</div>
          <div className="text-sm font-bold">{sub}</div>
          <div className="text-[11px] text-muted-foreground mt-2">
            {pct >= 75
              ? tr("parent.058")
              : pct >= 40
              ? tr("parent.059")
              : tr("parent.060")}
          </div>
          {session?.currentLessonTitle ? (
            <div className="text-[11px] mt-2 leading-snug">
              <span className="text-muted-foreground">Current: </span>
              <span className="font-semibold">{session.currentLessonTitle}</span>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Card 2: Attendance with mini bar chart
// ============================================================
function AttendanceCard({ attendance }: { attendance: Child["attendance"] }) {
  const tr = useT();
  const data = attendance.byMonth.map((b) => ({ month: b.month, pct: b.pct }));
  const tone =
    attendance.pct >= 80
      ? "text-primary"
      : attendance.pct >= 50
      ? "text-amber-600 dark:text-amber-400"
      : "text-destructive";
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
          <CalendarDays className="w-4 h-4 text-primary" />
          Attendance
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="flex items-end justify-between mb-3">
          <div>
            <div className={`text-3xl font-extrabold ${tone}`}>
              {attendance.pct}%
            </div>
            <div className="text-[11px] text-muted-foreground">
              {attendance.present} {tr("parent.061")}{attendance.total} {tr("parent.062")}</div>
          </div>
          <div className="text-[10px] text-muted-foreground">{tr("parent.063")}</div>
        </div>
        <div dir="ltr" className="h-16 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="month"
                tick={{ fontSize: 9, fill: "var(--muted-foreground)" }}
                tickLine={false}
                axisLine={false}
              />
              <Bar dataKey="pct" radius={[3, 3, 0, 0]}>
                {data.map((entry, i) => (
                  <Cell
                    key={i}
                    fill={
                      entry.pct >= 80
                        ? "var(--chart-1)"
                        : entry.pct >= 50
                        ? "var(--chart-2)"
                        : entry.pct > 0
                        ? "var(--chart-5)"
                        : "var(--muted)"
                    }
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Card 3: Quiz Average
// ============================================================
function QuizAverageCard({
  average,
  attempts,
  passed,
}: {
  average: number;
  attempts: number;
  passed: number;
}) {
  const tr = useT();
  const tone =
    average >= 80
      ? "text-primary"
      : average >= 60
      ? "text-amber-600 dark:text-amber-400"
      : "text-destructive";
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
          <Trophy className="w-4 h-4 text-amber-500" />
          Latest Quiz Average
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        {attempts === 0 ? (
          <EmptyMini text={tr("parent.064")} />
        ) : (
          <>
            <div className={`text-4xl font-extrabold ${tone}`}>{average}%</div>
            <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Award className="w-3 h-3 text-primary" />
                {passed} {tr("parent.065")}</span>
              <span className="inline-flex items-center gap-1">
                <AlertTriangle className="w-3 h-3 text-amber-500" />
                {attempts - passed} {tr("parent.066")}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Card 4: Homework Completion
// ============================================================
function HomeworkCard({ homework }: { homework: Child["homework"] }) {
  const tr = useT();
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
          <FileText className="w-4 h-4 text-primary" />
          Homework
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 space-y-3">
        {homework.total === 0 ? (
          <EmptyMini text={tr("parent.067")} />
        ) : (
          <>
            <div className="flex items-baseline gap-2">
              <span className="text-3xl font-extrabold">
                {homework.submitted}
                <span className="text-base text-muted-foreground">
                  /{homework.total}
                </span>
              </span>
              <Badge variant="secondary" className="text-[11px]">
                {homework.completionPct}%
              </Badge>
            </div>
            <Progress value={homework.completionPct} className="h-2" />
            <div className="flex items-center justify-between text-[11px] text-muted-foreground">
              <span>{tr("parent.068")}{homework.submitted}</span>
              <span>{tr("parent.069")}{homework.pending}</span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Card 5: Monthly Exam (placeholder)
// ============================================================
function MonthlyExamCard({
  mockExams,
}: {
  mockExams?: Child["mockExams"];
}) {
  const tr = useT();
  // No finished mock exams → keep the existing "coming soon" placeholder.
  if (!mockExams || mockExams.attempts === 0) {
    return (
      <Card className="glass card-hover p-6 border-dashed">
        <CardHeader className="px-0 pt-0">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
            <Award className="w-4 h-4 text-amber-500" />
            Monthly Exam
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <div className="flex flex-col items-start gap-2">
            <Badge
              variant="outline"
              className="bg-amber-400/10 text-amber-700 dark:text-amber-300"
            >
              {tr("parent.070")}</Badge>
            <p className="text-xs text-muted-foreground leading-relaxed">
              {tr("parent.071")}</p>
          </div>
        </CardContent>
      </Card>
    );
  }
  // Finished mock-exam history exists: show the server-graded summary
  // (strictly separate from the session-quiz card).
  const latest = mockExams.recent[0];
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
          <Award className="w-4 h-4 text-amber-500" />
          Mock Exams
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="flex items-end justify-between gap-3">
          <div>
            <div className="text-3xl font-extrabold text-gradient">
              {mockExams.average}%
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              {mockExams.passed}/{mockExams.attempts} passed
              {mockExams.best !== null ? ` · best ${mockExams.best}%` : ""}
            </div>
          </div>
          <Badge
            variant="outline"
            className={
              mockExams.average >= 60
                ? "border-emerald-400/30 text-emerald-600"
                : "border-amber-400/30 text-amber-600"
            }
          >
            {mockExams.attempts} exams
          </Badge>
        </div>
        {latest ? (
          <div className="text-[11px] text-muted-foreground mt-3 truncate">
            Latest: {latest.mockExamTitle} — {latest.percentage}%
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Card 6: Subscription Status
// ============================================================
function SubscriptionCard({
  subscription,
}: {
  subscription: Child["subscription"];
}) {
  const tr = useT();
  if (!subscription) {
    return (
      <Card className="glass card-hover p-6">
        <CardHeader className="px-0 pt-0">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
            <CreditCard className="w-4 h-4 text-primary" />
            Subscription
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <Badge variant="destructive" className="mb-2">
            {tr("parent.072")}</Badge>
          <p className="text-xs text-muted-foreground">
            {tr("parent.073")}</p>
        </CardContent>
      </Card>
    );
  }
  const info = describeParentSubscription(subscription);
  const daysLeft = subscription.daysLeft;
  let variant: "default" | "secondary" | "destructive" = "default";
  const label = info.label;
  let tone = "text-primary";
  let helper = "";
  if (info.state === "EXPIRING") {
    variant = "secondary";
    tone = "text-amber-600 dark:text-amber-400";
    helper = tr("parent.074", { p1: daysLeft });
  } else if (info.state === "ACTIVE") {
    variant = "default";
    helper = daysLeft != null ? tr("parent.075", { p1: daysLeft }) : tr("parent.076");
  } else if (info.state === "EXPIRED") {
    variant = "destructive";
    tone = "text-destructive";
    helper = tr("parent.077");
  } else if (info.state === "PENDING") {
    variant = "secondary";
    tone = "text-amber-600 dark:text-amber-400";
    helper = tr("parent.078");
  } else {
    variant = "secondary";
    helper = info.title;
  }
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
          <CreditCard className="w-4 h-4 text-primary" />
          Subscription
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0">
        <div className="flex items-center gap-2 mb-2">
          <Badge variant={variant}>{label}</Badge>
          <span className="text-xs text-muted-foreground">
            {subscription.planName}
          </span>
        </div>
        <div className={`text-xl font-bold ${tone}`}>{helper}</div>
        <div className="text-[11px] text-muted-foreground mt-1">
          {subscription.price} EGP · {subscription.durationMonths} {tr("parent.079")}</div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Topics Card (Strong / Weak)
// ============================================================
function TopicsCard({
  kind,
  topics,
}: {
  kind: "strong" | "weak";
  topics: { id: string; title: string; avgPct: number }[];
}) {
  const tr = useT();
  const isStrong = kind === "strong";
  const Icon = isStrong ? ArrowUpRight : ArrowDownRight;
  const accent = isStrong
    ? "text-primary"
    : "text-amber-600 dark:text-amber-400";
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2">
          {isStrong ? (
            <Sparkles className="w-4 h-4 text-primary" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-500" />
          )}
          {isStrong ? "Strong Topics" : "Weak Topics"}
          <span className="text-muted-foreground text-[11px] font-normal">
            {tr("parent.080")}</span>
        </CardTitle>
        <CardDescription>
          {isStrong
            ? tr("parent.081")
            : tr("parent.082")}
        </CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {topics.length === 0 ? (
          <EmptyMini text={tr("parent.083")} />
        ) : (
          <ul className="space-y-2 max-h-96 overflow-y-auto pe-1">
            {topics.map((t, i) => (
              <li
                key={t.id}
                className="flex items-center gap-3 p-2 rounded-lg bg-muted/40 hover:bg-muted/70 transition-colors"
              >
                <div
                  className={`flex items-center justify-center w-7 h-7 rounded-md ${
                    isStrong ? "bg-primary/10" : "bg-amber-400/10"
                  } text-[11px] font-bold ${accent}`}
                >
                  #{i + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{t.title}</div>
                  <Progress value={t.avgPct} className="h-1.5 mt-1" />
                </div>
                <div className={`text-sm font-bold ${accent}`}>{t.avgPct}%</div>
                <Icon className={`w-3.5 h-3.5 ${accent}`} />
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Performance Trend Chart
// ============================================================
function PerformanceTrendChart({
  data,
}: {
  data: Child["performanceTrend"];
}) {
  const tr = useT();
  if (!data || data.length === 0) {
    return <EmptyMini text={tr("parent.084")} />;
  }
  const chartData = data.map((d) => ({
    label: d.label,
    pct: d.pct,
    title: d.title,
  }));
  return (
    <div dir="ltr" className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: -8 }}>
          <defs>
            <linearGradient id="lineGradient" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--chart-1)" />
              <stop offset="100%" stopColor="var(--chart-2)" />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            domain={[0, 100]}
            tick={{ fontSize: 10, fill: "var(--muted-foreground)" }}
            tickLine={false}
            axisLine={false}
          />
          <RTooltip
            contentStyle={{
              background: "var(--popover)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              fontSize: 12,
              color: "var(--popover-foreground)",
            }}
            formatter={(v: number) => [`${v}%`, tr("parent.085")]}
            labelFormatter={(
              _label: string,
              payload: Array<{ payload?: { title?: string } }>
            ) => payload?.[0]?.payload?.title || ""}
          />
          <Line
            type="monotone"
            dataKey="pct"
            stroke="url(#lineGradient)"
            strokeWidth={3}
            dot={{ r: 4, fill: "var(--chart-1)", strokeWidth: 0 }}
            activeDot={{ r: 6, fill: "var(--chart-2)" }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ============================================================
// Next Session Card
// ============================================================
function NextSessionCard({
  session,
}: {
  session: Child["nextSession"];
}) {
  const tr = useT();
  return (
    <Card className="glass card-hover p-6 flex flex-col">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground">
          <Video className="w-4 h-4 text-primary" />
          Next Live Session
        </CardTitle>
      </CardHeader>
      <CardContent className="px-0 flex-1">
        {!session ? (
          <EmptyMini text={tr("parent.086")} />
        ) : (
          <div className="space-y-3">
            <div>
              <div className="font-bold text-base leading-snug">
                {session.title}
              </div>
              {session.lessonTitle && (
                <div className="text-[11px] text-muted-foreground mt-0.5">
                  Lesson: {session.lessonTitle}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="w-3.5 h-3.5 text-primary" />
              {formatDateAr(session.startAt)}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <GraduationCap className="w-3.5 h-3.5 text-primary" />
              {session.teacherName}
            </div>
            {session.meetingUrl ? (
              <Button asChild size="sm" className="w-full mt-1">
                <a href={session.meetingUrl} target="_blank" rel="noreferrer">
                  <Video className="w-3.5 h-3.5 ms-2" />
                  {tr("parent.087")}</a>
              </Button>
            ) : (
              <div className="text-[11px] text-muted-foreground bg-muted/40 rounded-md p-2 text-center mt-1">
                {tr("parent.088")}</div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Teacher Notes Card
// ============================================================
function TeacherNotesCard({
  notes,
}: {
  notes: Child["teacherNotes"];
}) {
  const tr = useT();
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <MessageSquare className="w-4 h-4 text-primary" />
          Teacher Notes
        </CardTitle>
        <CardDescription>{tr("parent.089")}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {notes.length === 0 ? (
          <EmptyMini text={tr("parent.090")} />
        ) : (
          <ul className="space-y-3 max-h-96 overflow-y-auto pe-1">
            {notes.slice(0, 3).map((n) => (
              <li
                key={n.id}
                className="p-3 rounded-lg bg-muted/40 border border-border/40"
              >
                <div className="flex items-start gap-2">
                  <div className="w-7 h-7 rounded-full bg-primary/10 text-primary flex items-center justify-center text-[10px] font-bold shrink-0">
                    {n.teacherName.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold truncate">
                        {n.teacherName}
                      </span>
                      <span className="text-[10px] text-muted-foreground shrink-0">
                        {timeAgoAr(n.createdAt)}
                      </span>
                    </div>
                    <p className="text-xs leading-relaxed mt-1 text-foreground/90">
                      {n.note}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Recent Activity Timeline
// ============================================================
function RecentActivityCard({
  activities,
}: {
  activities: Child["recentActivity"];
}) {
  const tr = useT();
  const iconFor = (t: string, kind: string) => {
    if (t === "quiz") return kind === "good" ? Trophy : AlertTriangle;
    if (t === "homework") return FileText;
    if (t === "attendance")
      return kind === "good" ? CheckCircle2 : AlertTriangle;
    return BookOpen;
  };
  const colorFor = (kind: string) =>
    kind === "good"
      ? "text-primary bg-primary/10"
      : kind === "warn"
      ? "text-amber-600 dark:text-amber-400 bg-amber-400/10"
      : "text-muted-foreground bg-muted/40";
  return (
    <Card className="glass card-hover p-6">
      <CardHeader className="px-0 pt-0">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" />
          Recent Activity
        </CardTitle>
        <CardDescription>{tr("parent.091")}</CardDescription>
      </CardHeader>
      <CardContent className="px-0">
        {activities.length === 0 ? (
          <EmptyMini text={tr("parent.092")} />
        ) : (
          <ol className="relative max-h-96 overflow-y-auto pe-3 border-s border-border/60 space-y-3">
            {activities.map((a, i) => {
              const Icon = iconFor(a.type, a.kind);
              return (
                <li key={i} className="relative pe-4">
                  <span
                    className={`absolute -end-[7px] top-1 w-3 h-3 rounded-full ring-2 ring-background ${
                      a.kind === "good"
                        ? "bg-primary"
                        : a.kind === "warn"
                        ? "bg-amber-500"
                        : "bg-muted-foreground/40"
                    }`}
                  />
                  <div className="flex items-start gap-2">
                    <div
                      className={`w-7 h-7 rounded-md flex items-center justify-center ${colorFor(
                        a.kind
                      )}`}
                    >
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold leading-snug">
                        {a.title}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {a.description}
                      </div>
                      <div className="text-[10px] text-muted-foreground/80 mt-0.5">
                        {timeAgoAr(a.time)}
                      </div>
                    </div>
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </Card>
  );
}

// ============================================================
// Link Student Dialog (uses POST /api/parents/me/link-student)
// ============================================================
function LinkStudentButton() {
  const tr = useT();
  const [open, setOpen] = React.useState(false);
  const [nationalId, setNationalId] = React.useState("");
  const [parentPhone, setParentPhone] = React.useState("");
  const [studentCode, setStudentCode] = React.useState("");
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationFn: async (payload: { studentNationalId: string; parentPhone: string; studentCode: string }) => {
      const r = await fetch("/api/parents/me/link-student", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || tr("parent.048"));
      return json;
    },
    onSuccess: () => {
      toast.success(tr("parent.094"));
      setNationalId("");
      setParentPhone("");
      setStudentCode("");
      setOpen(false);
      qc.invalidateQueries({ queryKey: ["parent-dashboard"] });
    },
    onError: (e: Error) =>
      toast.error(e?.message || tr("parent.048")),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Plus className="w-4 h-4 ms-2" />
          {tr("parent.096")}</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("parent.097")}</DialogTitle>
          <DialogDescription>
            {tr("parent.098")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div>
            <label className="text-xs font-semibold">{tr("parent.099")}</label>
            <Input
              dir="ltr"
              placeholder={tr("parent.100")}
              value={nationalId}
              onChange={(e) => setNationalId(e.target.value)}
              disabled={mutation.isPending}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-semibold">{tr("parent.101")}</label>
            <Input
              dir="ltr"
              placeholder="01147422177"
              value={parentPhone}
              onChange={(e) => setParentPhone(e.target.value)}
              disabled={mutation.isPending}
              className="mt-1"
            />
          </div>
          <div>
            <label className="text-xs font-semibold">{tr("parent.102")}</label>
            <Input
              dir="ltr"
              placeholder="CM-XXXXXX"
              value={studentCode}
              onChange={(e) => setStudentCode(e.target.value.toUpperCase())}
              disabled={mutation.isPending}
              className="mt-1 font-mono uppercase"
            />
          </div>
          <p className="text-[11px] text-muted-foreground">
            {tr("parent.103")}</p>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={mutation.isPending}
          >
            {tr("parent.104")}</Button>
          <Button
            onClick={() =>
              mutation.mutate({
                studentNationalId: nationalId.trim(),
                parentPhone: parentPhone.trim(),
                studentCode: studentCode.trim().toUpperCase(),
              })
            }
            disabled={mutation.isPending || !nationalId || !parentPhone || !studentCode}
          >
            {mutation.isPending ? tr("parent.105") : tr("parent.106")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// Empty parent state (no children linked)
// ============================================================
function EmptyParentState({ parentName }: { parentName: string }) {
  const tr = useT();
  const [nationalId, setNationalId] = React.useState("");
  const [parentPhone, setParentPhone] = React.useState("");
  const [studentCode, setStudentCode] = React.useState("");
  const mutation = useMutation({
    mutationFn: async (payload: { studentNationalId: string; parentPhone: string; studentCode: string }) => {
      const r = await fetch("/api/parents/me/link-student", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json?.error || tr("parent.048"));
      return json;
    },
    onSuccess: () => {
      toast.success(tr("parent.108"));
      setTimeout(() => window.location.reload(), 800);
    },
    onError: (e: Error) =>
      toast.error(e?.message || tr("parent.048")),
  });
  return (
    <div className="flex flex-col items-center justify-center min-h-[70vh] gap-5 text-center max-w-md mx-auto">
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center">
        <GraduationCap className="w-8 h-8 text-primary" />
      </div>
      <div>
        <h1 className="text-2xl font-bold">
          {tr("parent.051")}<span className="text-gradient">{parentName}</span> 👋
        </h1>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {tr("parent.111")}</p>
      </div>
      <div className="w-full space-y-2">
        <Input
          dir="ltr"
          placeholder={tr("parent.112")}
          value={nationalId}
          onChange={(e) => setNationalId(e.target.value)}
          disabled={mutation.isPending}
          className="text-center"
        />
        <Input
          dir="ltr"
          placeholder={tr("parent.113")}
          value={parentPhone}
          onChange={(e) => setParentPhone(e.target.value)}
          disabled={mutation.isPending}
          className="text-center"
        />
        <Input
          dir="ltr"
          placeholder={tr("parent.114")}
          value={studentCode}
          onChange={(e) => setStudentCode(e.target.value.toUpperCase())}
          disabled={mutation.isPending}
          className="text-center font-mono uppercase"
        />
        <Button
          className="w-full"
          onClick={() =>
            mutation.mutate({
              studentNationalId: nationalId.trim(),
              parentPhone: parentPhone.trim(),
              studentCode: studentCode.trim().toUpperCase(),
            })
          }
          disabled={mutation.isPending || !nationalId || !parentPhone || !studentCode}
        >
          {mutation.isPending ? tr("parent.105") : tr("parent.116")}
        </Button>
      </div>
    </div>
  );
}

// ============================================================
// Empty mini text + Skeletons
// ============================================================
function EmptyMini({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-muted-foreground">
      <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/40" />
      {text}
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-48" />
        </div>
        <Skeleton className="h-9 w-32" />
      </div>
      <Skeleton className="h-24 w-full rounded-xl" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-36 rounded-xl" />
        ))}
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Skeleton className="h-64 rounded-xl lg:col-span-2" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}
