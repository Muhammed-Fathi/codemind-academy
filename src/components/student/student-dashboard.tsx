"use client";
import { useT, translate , pickAuto } from "@/lib/i18n";

import * as React from "react";
import { motion } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { useApp } from "@/lib/store";
import { brand } from "@/lib/brand";
import { toast } from "sonner";
import { GamificationPanel } from "@/components/student/gamification-panel";
import {
  PlayCircle,
  CalendarClock,
  Video,
  Flame,
  CheckCircle2,
  ClipboardList,
  CreditCard,
  AlertTriangle,
  Trophy,
  ArrowLeft,
  Activity,
  Bell,
  BookOpen,
  ChevronLeft,
  Sparkles,
  Clock,
  FileText,
  RefreshCw,
  CircleDashed,
  TrendingUp,
  Download,
} from "lucide-react";

// ============================================================
// Types
// ============================================================
type ActivityItem = {
  type: "lesson" | "quiz" | "homework";
  title: string;
  detail: string;
  date: string;
  meta?: Record<string, unknown>;
};

type DashboardData = {
  student: {
    id: string;
    name: string;
    firstName: string;
    email: string;
    grade: string;
    schoolName: string | null;
    schoolType?: string | null;
    nationalId?: string | null;
    parentPhone?: string | null;
    studentCode?: string | null;
  };
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
    };
    teacher: { name: string; specialty: string | null } | null;
  } | null;
  courseProgress: {
    totalLessons: number;
    completedLessons: number;
    percentage: number;
  };
  continueLesson: {
    id: string;
    title: string;
    part: string;
    unit: string;
    topic: string;
    progress: number;
    isCompleted: boolean;
    videoUrl: string | null;
    courseSlug: string;
  } | null;
  nextSession: {
    id: string;
    title: string;
    startAt: string;
    duration: number;
    meetingUrl: string | null;
    groupName: string;
    teacherName: string;
  } | null;
  attendance: {
    total: number;
    present: number;
    percentage: number;
  };
  latestQuizResult: {
    attemptId: string;
    quizId: string;
    quizTitle: string;
    lessonTitle: string;
    score: number;
    totalMarks: number;
    percentage: number;
    passed: boolean;
  } | null;
  pendingHomework: {
    count: number;
    items: {
      id: string;
      title: string;
      deadline: string;
      lessonTitle: string;
      maxMarks: number;
    }[];
  };
  subscription: {
    status: "ACTIVE" | "EXPIRING" | "EXPIRED" | "NONE";
    endDate: string | null;
    daysToExpiry: number;
    planName: string | null;
  };
  recentActivity: ActivityItem[];
};

// ============================================================
// Helpers
// ============================================================
const curLocale = () => (useApp.getState().locale === "en" ? "en" : "ar");
const dtLocale = () => (curLocale() === "en" ? "en-GB" : "ar-EG");
function timeAgo(dateStr: string): string {
  const d = new Date(dateStr).getTime();
  const diff = Date.now() - d;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return translate(curLocale(), "student.110");
  if (minutes < 60) return translate(curLocale(), "student.111");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return translate(curLocale(), "student.112");
  const days = Math.floor(hours / 24);
  if (days < 7) return translate(curLocale(), "student.113");
  return new Intl.DateTimeFormat(dtLocale(), {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(new Date(dateStr));
}

function formatSessionDate(startAt: string): {
  date: string;
  time: string;
  countdown: string;
} {
  const d = new Date(startAt);
  const dateStr = new Intl.DateTimeFormat(dtLocale(), {
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(d);
  const timeStr = new Intl.DateTimeFormat(dtLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  const diff = d.getTime() - Date.now();
  const days = Math.max(0, Math.floor(diff / (1000 * 60 * 60 * 24)));
  const hours = Math.max(
    0,
    Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60))
  );
  const countdown = translate(
    curLocale(),
    days > 0 ? "student.114" : "student.115"
  );
  return { date: dateStr, time: timeStr, countdown };
}

// ============================================================
// Main
// ============================================================
export function StudentDashboard() {
  const t = useT();
  const view = useApp((s) => s.view);
  const user = useApp((s) => s.user);

  const [data, setData] = React.useState<DashboardData | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetch("/api/students/me/dashboard")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("fail"))))
      .then((d) => setData(d))
      .catch(() => {
        setError(t("student.116"));
        toast.error(t("student.116"));
      })
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (view === "student-homework") {
    return <HomeworkView />;
  }
  if (view === "student-notifications") {
    return <NotificationsView />;
  }
  if (view === "student-progress") {
    return (
      <ProgressView
        data={data}
        loading={loading}
        error={error}
        onRetry={reload}
      />
    );
  }

  return (
    <DashboardHome
      data={data}
      loading={loading}
      error={error}
      onRetry={reload}
      userName={user?.name || ""}
    />
  );
}

// ============================================================
// Dashboard home
// ============================================================
function DashboardHome({
  data,
  loading,
  error,
  onRetry,
}: {
  data: DashboardData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  userName: string;
}) {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const setNavParam = useApp((s) => s.setNavParam);

  if (loading) return <DashboardSkeleton />;
  if (error || !data)
    return <ErrorState message={error || t("student.118")} onRetry={onRetry} />;

  const todayLabel = new Intl.DateTimeFormat(
    useApp.getState().locale === "en" ? "en-GB" : "ar-EG",
    { weekday: "long", day: "numeric", month: "long" }
  ).format(new Date());

  const openLesson = (lessonId: string) => {
    setView("student-lesson");
    setNavParam(lessonId);
  };

  const openCourse = () => {
    setView("student-course");
    if (data.group) {
      setNavParam(data.group.course.slug);
    }
  };

  return (
    <div className="space-y-6">
      {/* ===== Welcome header ===== */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="flex flex-col md:flex-row md:items-center md:justify-between gap-3"
      >
        <div>
          <h1 className="text-2xl md:text-3xl font-bold">
            {t("student.119")}<span className="text-gradient">{data.student.firstName}</span>{" "}
            <span className="inline-block animate-float-slow">👋</span>
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {todayLabel} · {brand.academicYear}
          </p>
          {data.student.studentCode && (
            <div className="mt-2 inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-1.5">
              <span className="text-[11px] text-muted-foreground">{t("student.120")}</span>
              <code className="text-sm font-black font-mono tracking-widest text-primary" dir="ltr">
                {data.student.studentCode}
              </code>
              <button
                onClick={() => {
                  try {
                    navigator.clipboard.writeText(data.student.studentCode || "");
                    toast.success(t("student.121"));
                  } catch {
                    toast.error(t("student.122"));
                  }
                }}
                className="text-[11px] text-primary hover:underline font-bold"
              >
                {t("student.123")}</button>
            </div>
          )}
        </div>
        <SubscriptionPill
          status={data.subscription.status}
          daysToExpiry={data.subscription.daysToExpiry}
          planName={data.subscription.planName}
          onRenew={() => setView("enroll")}
        />
      </motion.div>

      {/* ===== Top grid: Continue Learning + Progress Ring ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Continue Learning */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05 }}
          className="lg:col-span-2"
        >
          <Card className="glass card-hover h-full">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                  <PlayCircle className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Continue Learning</CardTitle>
                  <CardDescription className="text-xs">
                    {t("student.124")}</CardDescription>
                </div>
              </div>
              {data.group && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs"
                  onClick={openCourse}
                >
                  {t("student.125")}<ChevronLeft className="w-3.5 h-3.5 flip-rtl" />
                </Button>
              )}
            </CardHeader>
            <CardContent>
              {data.continueLesson ? (
                <div className="space-y-4">
                  <div>
                    <div className="text-xs text-muted-foreground mb-1">
                      {data.continueLesson.part} · {data.continueLesson.unit} ·{" "}
                      {data.continueLesson.topic}
                    </div>
                    <div className="text-lg font-semibold leading-snug">
                      {data.continueLesson.title}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">
                        {data.continueLesson.isCompleted ? t("student.126") : "Progress"}
                      </span>
                      <span className="font-semibold">
                        {data.continueLesson.progress}%
                      </span>
                    </div>
                    <Progress value={data.continueLesson.progress} />
                  </div>
                  <Button
                    className="w-full"
                    onClick={() => openLesson(data.continueLesson!.id)}
                  >
                    <PlayCircle className="w-4 h-4 ms-1" />
                    {data.continueLesson.progress > 0 ? t("student.127") : t("student.128")}
                  </Button>
                </div>
              ) : (
                <EmptyState
                  icon={<BookOpen className="w-5 h-5" />}
                  title={t("student.129")}
                  hint={t("student.130")}
                  actionLabel={t("student.131")}
                  onAction={openCourse}
                />
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Course Progress Ring */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.1 }}
        >
          <Card className="glass card-hover h-full">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                  <TrendingUp className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Course Progress</CardTitle>
                  <CardDescription className="text-xs">
                    {data.courseProgress.completedLessons} {t("student.132")}{" "}
                    {data.courseProgress.totalLessons} Lessons
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col items-center justify-center pt-2 pb-4">
              <ProgressRing percentage={data.courseProgress.percentage} />
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* ===== 3-column row ===== */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Next Live Session */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.15 }}
        >
          <Card className="glass card-hover h-full overflow-hidden relative">
            <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-l from-primary via-amber-400 to-primary" />
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="grid place-items-center w-9 h-9 rounded-lg bg-amber-400/15 text-amber-500">
                    <CalendarClock className="w-5 h-5" />
                  </div>
                  <div>
                    <CardTitle className="text-base">Next Live Session</CardTitle>
                    <CardDescription className="text-xs">
                      {t("student.133")}</CardDescription>
                  </div>
                </div>
                {data.nextSession && (
                  <Badge
                    variant="outline"
                    className="bg-amber-400/10 text-amber-600 border-amber-400/30"
                  >
                    <Clock className="w-3 h-3 ms-1" />
                    {formatSessionDate(data.nextSession.startAt).countdown}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent>
              {data.nextSession ? (
                <div className="space-y-3">
                  <div className="text-base font-semibold leading-snug">
                    {data.nextSession.title}
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <Meta
                      label={t("student.134")}
                      value={formatSessionDate(data.nextSession.startAt).date}
                    />
                    <Meta
                      label={t("student.135")}
                      value={formatSessionDate(data.nextSession.startAt).time}
                    />
                    <Meta label={t("student.136")} value={data.nextSession.groupName} />
                    <Meta label={t("student.137")} value={data.nextSession.teacherName} />
                  </div>
                  {data.nextSession.meetingUrl ? (
                    <a
                      href={data.nextSession.meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center justify-center w-full"
                    >
                      <Button className="w-full">
                        <Video className="w-4 h-4 ms-1.5" />
                        {t("student.138")}</Button>
                    </a>
                  ) : (
                    <Button variant="secondary" disabled className="w-full">
                      {t("student.139")}</Button>
                  )}
                </div>
              ) : (
                <EmptyState
                  icon={<CalendarClock className="w-5 h-5" />}
                  title={t("student.140")}
                  hint={t("student.141")}
                />
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Attendance */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.2 }}
        >
          <Card className="glass card-hover h-full">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                  <CheckCircle2 className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Attendance</CardTitle>
                  <CardDescription className="text-xs">
                    {t("student.142")}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-end gap-2">
                <div className="text-4xl font-bold text-gradient">
                  {data.attendance.percentage}%
                </div>
                <div className="text-xs text-muted-foreground pb-1.5">
                  {data.attendance.present}/{data.attendance.total} {t("student.143")}</div>
              </div>
              <MiniBars percentage={data.attendance.percentage} />
              <p className="text-xs text-muted-foreground">
                {data.attendance.percentage >= 75
                  ? t("student.144")
                  : t("student.145")}
              </p>
            </CardContent>
          </Card>
        </motion.div>

        {/* Latest quiz */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.25 }}
        >
          <Card className="glass card-hover h-full">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                  <Trophy className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Latest Quiz</CardTitle>
                  <CardDescription className="text-xs">
                    {t("student.146")}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {data.latestQuizResult ? (
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-semibold leading-snug">
                      {data.latestQuizResult.quizTitle}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {data.latestQuizResult.lessonTitle}
                    </div>
                  </div>
                  <div className="flex items-end gap-2">
                    <div
                      className={`text-4xl font-bold ${
                        data.latestQuizResult.passed
                          ? "text-gradient"
                          : "text-amber-500"
                      }`}
                    >
                      {data.latestQuizResult.percentage}%
                    </div>
                    <div className="text-xs text-muted-foreground pb-1.5">
                      {data.latestQuizResult.score}/
                      {data.latestQuizResult.totalMarks}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={
                      data.latestQuizResult.passed
                        ? "border-primary/30 text-primary bg-primary/10"
                        : "border-amber-400/30 text-amber-600 bg-amber-400/10"
                    }
                  >
                    {data.latestQuizResult.passed
                      ? t("student.147")
                      : t("student.148")}
                  </Badge>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => {
                      setView("student-quiz");
                      setNavParam(data.latestQuizResult!.quizId);
                    }}
                  >
                    <RefreshCw className="w-4 h-4 ms-1.5" />
                    {t("student.149")}</Button>
                </div>
              ) : (
                <EmptyState
                  icon={<Trophy className="w-5 h-5" />}
                  title={t("student.150")}
                  hint={t("student.151")}
                />
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* ===== Bottom row ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Pending Homework */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.3 }}
        >
          <Card className="glass card-hover h-full">
            <CardHeader className="flex-row items-center justify-between space-y-0">
              <div className="flex items-center gap-2">
                <div className="grid place-items-center w-9 h-9 rounded-lg bg-amber-400/15 text-amber-500">
                  <ClipboardList className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Pending Homework</CardTitle>
                  <CardDescription className="text-xs">
                    {t("student.152")}</CardDescription>
                </div>
              </div>
              <div className="text-3xl font-bold text-gradient">
                {data.pendingHomework.count}
              </div>
            </CardHeader>
            <CardContent>
              {data.pendingHomework.count === 0 ? (
                <EmptyState
                  icon={<Sparkles className="w-5 h-5" />}
                  title={t("student.153")}
                  hint={t("student.154")}
                />
              ) : (
                <div className="space-y-3">
                  <ScrollArea className="max-h-48 overflow-y-auto pe-2">
                    <ul className="space-y-2">
                      {data.pendingHomework.items.slice(0, 4).map((h) => {
                        const days = Math.max(
                          0,
                          Math.ceil(
                            (new Date(h.deadline).getTime() - Date.now()) /
                              (1000 * 60 * 60 * 24)
                          )
                        );
                        return (
                          <li
                            key={h.id}
                            className="flex items-center gap-2 text-sm py-2 border-b border-border/60 last:border-0"
                          >
                            <FileText className="w-4 h-4 text-amber-500 shrink-0" />
                            <div className="flex-1 min-w-0">
                              <div className="truncate font-medium">
                                {h.title}
                              </div>
                              <div className="text-[11px] text-muted-foreground truncate">
                                {h.lessonTitle}
                              </div>
                            </div>
                            <Badge
                              variant="outline"
                              className={
                                days <= 2
                                  ? "border-destructive/30 text-destructive bg-destructive/10"
                                  : "border-border text-muted-foreground"
                              }
                            >
                              {days === 0
                                ? t("student.155")
                                : days === 1
                                ? t("student.156")
                                : t("student.114", { p1: days })}
                            </Badge>
                          </li>
                        );
                      })}
                    </ul>
                  </ScrollArea>
                  <Button
                    variant="outline"
                    className="w-full"
                    onClick={() => setView("student-homework")}
                  >
                    {t("student.158")}<ChevronLeft className="w-4 h-4 flip-rtl" />
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>

        {/* Recent Activity */}
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.35 }}
        >
          <Card className="glass card-hover h-full">
            <CardHeader>
              <div className="flex items-center gap-2">
                <div className="grid place-items-center w-9 h-9 rounded-lg bg-primary/10 text-primary">
                  <Activity className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-base">Recent Activity</CardTitle>
                  <CardDescription className="text-xs">
                    {t("student.159")}</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {data.recentActivity.length === 0 ? (
                <EmptyState
                  icon={<CircleDashed className="w-5 h-5" />}
                  title={t("student.160")}
                  hint={t("student.161")}
                />
              ) : (
                <ScrollArea className="max-h-72 overflow-y-auto pe-2">
                  <ol className="relative space-y-3">
                    {data.recentActivity.map((a, i) => (
                      <ActivityRow
                        key={i}
                        item={a}
                        isLast={i === data.recentActivity.length - 1}
                      />
                    ))}
                  </ol>
                </ScrollArea>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </div>

      {/* ===== Gamification: Level + Badges ===== */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <GamificationPanel />
        <motion.div
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.4 }}
          className="space-y-4"
        >
          {/* Streak / motivational banner */}
          <Card className="glass card-hover overflow-hidden relative">
            <div className="absolute inset-0 bg-gradient-to-br from-orange-500/10 via-amber-500/5 to-transparent" />
            <CardContent className="relative p-5 flex items-center gap-4">
              <div className="grid place-items-center w-14 h-14 rounded-2xl bg-gradient-to-br from-orange-500 to-rose-500 text-white shadow-lg shrink-0">
                <Flame className="w-7 h-7" />
              </div>
              <div className="flex-1">
                <div className="text-sm font-bold">
                  {t("student.162")}</div>
                <p className="text-xs text-muted-foreground mt-0.5 leading-relaxed">
                  {t("student.163")}</p>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      </div>
    </div>
  );
}

// ============================================================
// Sub-components
// ============================================================
function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
        <Skeleton className="h-8 w-32 rounded-full" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Skeleton className="h-48 lg:col-span-2 rounded-xl" />
        <Skeleton className="h-48 rounded-xl" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
        <Skeleton className="h-56 rounded-xl" />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <Card className="glass">
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <AlertTriangle className="w-10 h-10 text-amber-500 mb-3" />
        <p className="text-base font-semibold mb-1">{message}</p>
        <p className="text-xs text-muted-foreground mb-4">
          {t("student.164")}</p>
        <Button onClick={onRetry} variant="outline">
          <RefreshCw className="w-4 h-4 ms-2" />
          {t("student.165")}</Button>
      </CardContent>
    </Card>
  );
}

function EmptyState({
  icon,
  title,
  hint,
  actionLabel,
  onAction,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-6 text-center">
      <div className="grid place-items-center w-10 h-10 rounded-full bg-muted text-muted-foreground mb-2">
        {icon}
      </div>
      <div className="text-sm font-medium">{title}</div>
      {hint && (
        <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>
      )}
      {actionLabel && onAction && (
        <Button size="sm" variant="outline" className="mt-3" onClick={onAction}>
          {actionLabel}
        </Button>
      )}
    </div>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/50 px-2 py-1.5">
      <div className="text-[10px] text-muted-foreground">{label}</div>
      <div className="text-xs font-semibold truncate">{value}</div>
    </div>
  );
}

function ProgressRing({ percentage }: { percentage: number }) {
  const t = useT();
  const radius = 56;
  const stroke = 10;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (percentage / 100) * circumference;

  return (
    <div className="relative w-[140px] h-[140px]">
      <svg width="140" height="140" className="-rotate-90">
        <circle
          cx="70"
          cy="70"
          r={radius}
          stroke="currentColor"
          strokeWidth={stroke}
          fill="none"
          className="text-muted"
        />
        <motion.circle
          cx="70"
          cy="70"
          r={radius}
          stroke="url(#ring-grad)"
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={circumference}
          initial={{ strokeDashoffset: circumference }}
          animate={{ strokeDashoffset: offset }}
          transition={{ duration: 1.1, ease: "easeOut" }}
        />
        <defs>
          <linearGradient id="ring-grad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#10b981" />
            <stop offset="60%" stopColor="#14b8a6" />
            <stop offset="100%" stopColor="#f59e0b" />
          </linearGradient>
        </defs>
      </svg>
      <div className="absolute inset-0 grid place-items-center">
        <div className="text-center">
          <div className="text-3xl font-bold text-gradient">{percentage}%</div>
          <div className="text-[10px] text-muted-foreground">{t("student.166")}</div>
        </div>
      </div>
    </div>
  );
}

function MiniBars({ percentage }: { percentage: number }) {
  const total = 10;
  const filled = Math.round((percentage / 100) * total);
  return (
    <div className="flex items-end gap-1 h-12">
      {Array.from({ length: total }).map((_, i) => {
        const active = i < filled;
        const h = 30 + Math.round(Math.sin(i * 0.9) * 14 + 14);
        return (
          <motion.div
            key={i}
            initial={{ height: 4, opacity: 0.4 }}
            animate={{ height: h, opacity: 1 }}
            transition={{ duration: 0.4, delay: 0.05 * i }}
            className={`flex-1 rounded-sm ${
              active
                ? "bg-gradient-to-t from-primary to-amber-400"
                : "bg-muted"
            }`}
            style={{ height: h }}
          />
        );
      })}
    </div>
  );
}

function ActivityRow({
  item,
  isLast,
}: {
  item: ActivityItem;
  isLast: boolean;
}) {
  const icon =
    item.type === "lesson" ? (
      <PlayCircle className="w-3.5 h-3.5" />
    ) : item.type === "quiz" ? (
      <Trophy className="w-3.5 h-3.5" />
    ) : (
      <FileText className="w-3.5 h-3.5" />
    );
  const accent =
    item.type === "lesson"
      ? "bg-primary text-primary-foreground"
      : item.type === "quiz"
      ? "bg-amber-500 text-white"
      : "bg-teal-600 text-white";
  return (
    <li className="flex gap-3">
      <div className="flex flex-col items-center">
        <div
          className={`grid place-items-center w-7 h-7 rounded-full ${accent} shrink-0`}
        >
          {icon}
        </div>
        {!isLast && <div className="w-px flex-1 bg-border my-1" />}
      </div>
      <div className="flex-1 pb-1">
        <div className="text-sm font-medium leading-snug">{item.title}</div>
        <div className="text-[11px] text-muted-foreground">{item.detail}</div>
        <div className="text-[10px] text-muted-foreground/70 mt-0.5">
          {timeAgo(item.date)}
        </div>
      </div>
    </li>
  );
}

function SubscriptionPill({
  status,
  daysToExpiry,
  planName,
  onRenew,
}: {
  status: "ACTIVE" | "EXPIRING" | "EXPIRED" | "NONE";
  daysToExpiry: number;
  planName: string | null;
  onRenew: () => void;
}) {
  const t = useT();
  if (status === "NONE") {
    return (
      <Button size="sm" onClick={onRenew}>
        <CreditCard className="w-4 h-4 ms-1.5" />
        {t("student.167")}</Button>
    );
  }
  if (status === "ACTIVE") {
    return (
      <Badge
        variant="outline"
        className="border-primary/30 text-primary bg-primary/10 px-3 py-1 text-xs"
      >
        <CheckCircle2 className="w-3.5 h-3.5 ms-1" />
        Active
        {planName && <span className="opacity-70">· {planName}</span>}
      </Badge>
    );
  }
  if (status === "EXPIRING") {
    return (
      <button onClick={onRenew} className="group">
        <Badge
          variant="outline"
          className="border-amber-400/40 text-amber-600 bg-amber-400/10 px-3 py-1 text-xs hover:bg-amber-400/20 transition-colors"
        >
          <AlertTriangle className="w-3.5 h-3.5 ms-1" />
          {t("student.168")}{daysToExpiry} {t("student.169")}</Badge>
      </button>
    );
  }
  return (
    <Button size="sm" variant="destructive" onClick={onRenew}>
      <AlertTriangle className="w-4 h-4 ms-1.5" />
      {t("student.170")}</Button>
  );
}

// ============================================================
// Sub-views
// ============================================================
/**
 * Minimal in-place assignment submission.
 *
 * The progression rule ("assignment submitted" is one of the three gates that
 * unlock the next session) was unreachable before: the API had no way for a
 * student to record a submission at all. This posts the student's own answer
 * to POST /api/students/me/homework, which re-checks the session gate and
 * writes the HomeworkSubmission server-side.
 */
function HomeworkSubmitForm({
  homeworkId,
  onSubmitted,
}: {
  homeworkId: string;
  onSubmitted: () => void;
}) {
  const t = useT();
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  const submit = async () => {
    const content = value.trim();
    if (!content || busy) return;
    setBusy(true);
    try {
      const r = await fetch("/api/students/me/homework", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ homeworkId, content }),
      });
      const data = await r.json().catch(() => null);
      if (!r.ok) {
        toast.error(data?.error || t("student.116"));
        return;
      }
      toast.success(data?.message || t("api.225"));
      setValue("");
      onSubmitted();
    } catch {
      toast.error(t("student.116"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full flex items-start gap-2 pt-1">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder={t("student.240")}
        rows={2}
        className="min-h-14 text-xs resize-y"
      />
      <Button
        size="sm"
        variant="outline"
        disabled={busy || !value.trim()}
        onClick={submit}
        className="shrink-0"
      >
        {busy ? t("student.242") : t("student.241")}
      </Button>
    </div>
  );
}

function HomeworkView() {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const setNavParam = useApp((s) => s.setNavParam);
  const [items, setItems] = React.useState<any[] | null>(null);
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(() => {
    setLoading(true);
    fetch("/api/students/me/homework")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setItems(d?.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  return (
    <div className="space-y-4">
      <BackBar
        title="Pending Homework"
        onBack={() => setView("student-dashboard")}
      />
      <Card className="glass">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ClipboardList className="w-5 h-5 text-amber-500" />
            {t("student.171")}</CardTitle>
          <CardDescription>
            {t("student.172")}</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : !items || items.length === 0 ? (
            <EmptyState
              icon={<Sparkles className="w-5 h-5" />}
              title={t("student.153")}
              hint={t("student.174")}
            />
          ) : (
            <ScrollArea className="max-h-96 overflow-y-auto pe-2">
              <ul className="space-y-2">
                {items.map((h) => {
                  const days = Math.max(
                    0,
                    Math.ceil(
                      (new Date(h.deadline).getTime() - Date.now()) /
                        (1000 * 60 * 60 * 24)
                    )
                  );
                  const sub = h.submission;
                  const isGraded = sub?.status === "GRADED";
                  const isSubmitted = sub?.status === "SUBMITTED";
                  const isLate = sub?.status === "LATE";
                  const isPending = !sub || sub?.status === "PENDING";
                  return (
                    <li
                      key={h.id}
                      className="flex items-center gap-3 p-3 rounded-lg border border-border/60 hover:bg-muted/40 hover:border-primary/30 transition-all group"
                    >
                      <div className="grid place-items-center w-9 h-9 rounded-lg bg-amber-400/15 text-amber-500 shrink-0 group-hover:scale-105 transition-transform">
                        <FileText className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-semibold truncate">
                          {h.title}
                        </div>
                        <div className="text-xs text-muted-foreground truncate">
                          {h.lessonTitle}
                        </div>
                        {isGraded && (
                          <div className="text-[11px] mt-1 text-primary flex items-center gap-1">
                            <CheckCircle2 className="w-3 h-3" />
                            {t("student.175")}{sub.grade}/{h.maxMarks}
                            {sub.feedback && (
                              <span className="text-muted-foreground truncate">
                                — {sub.feedback}
                              </span>
                            )}
                          </div>
                        )}
                        {isSubmitted && (
                          <div className="text-[11px] mt-1 text-amber-600 dark:text-amber-400 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {t("student.176")}</div>
                        )}
                        {isLate && (
                          <div className="text-[11px] mt-1 text-destructive flex items-center gap-1">
                            <AlertTriangle className="w-3 h-3" />
                            {t("student.177")}</div>
                        )}
                        {isPending && (
                          <div className="text-[11px] mt-1 text-muted-foreground">
                            {t("student.178")}</div>
                        )}
                      </div>
                      <div className="flex flex-col items-end gap-1.5">
                        <Badge
                          variant="outline"
                          className={
                            days <= 2 && isPending
                              ? "border-destructive/30 text-destructive bg-destructive/10"
                              : "border-border text-muted-foreground"
                          }
                        >
                          {days === 0
                            ? t("student.179")
                            : days === 1
                            ? t("student.156")
                            : t("student.114", { p1: days })}
                        </Badge>
                        {isGraded && (
                          <Badge className="bg-primary/10 text-primary hover:bg-primary/15 text-[10px]">
                            {sub.grade}/{h.maxMarks}
                          </Badge>
                        )}
                      </div>
                      {h.lessonId && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setView("student-lesson");
                            setNavParam(h.lessonId);
                          }}
                        >
                          {t("student.182")}<ChevronLeft className="w-3.5 h-3.5 flip-rtl" />
                        </Button>
                      )}
                      {!isGraded && (
                        <HomeworkSubmitForm
                          homeworkId={h.id}
                          onSubmitted={reload}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function NotificationsView() {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const [items, setItems] = React.useState<any[] | null>(null);
  const [loading, setLoading] = React.useState(true);

  const reload = React.useCallback(() => {
    setLoading(true);
    fetch("/api/notifications")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setItems(d?.notifications || d?.items || []))
      .catch(() => setItems([]))
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const markAll = async () => {
    await fetch("/api/notifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markAllRead: true }),
    });
    reload();
    toast.success(t("student.183"));
  };

  return (
    <div className="space-y-4">
      <BackBar
        title={t("student.184")}
        onBack={() => setView("student-dashboard")}
        action={
          <Button variant="ghost" size="sm" onClick={markAll}>
            <CheckCircle2 className="w-4 h-4 ms-1.5" />
            {t("student.185")}</Button>
        }
      />
      <Card className="glass">
        <CardContent className="p-0">
          {loading ? (
            <div className="p-6 space-y-2">
              {[1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-14" />
              ))}
            </div>
          ) : !items || items.length === 0 ? (
            <EmptyState
              icon={<Bell className="w-5 h-5" />}
              title={t("student.186")}
              hint={t("student.187")}
            />
          ) : (
            <ScrollArea className="max-h-[70vh] overflow-y-auto">
              <ul>
                {items.map((n: any) => (
                  <li
                    key={n.id}
                    className={`flex gap-3 px-4 py-3 border-b border-border/60 last:border-0 hover:bg-muted/40 transition-colors ${
                      !n.isRead ? "bg-primary/5" : ""
                    }`}
                  >
                    <div
                      className={`grid place-items-center w-8 h-8 rounded-full shrink-0 ${
                        n.isRead
                          ? "bg-muted text-muted-foreground"
                          : "bg-primary text-primary-foreground"
                      }`}
                    >
                      <Bell className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold">{n.title}</div>
                      <div className="text-xs text-muted-foreground">
                        {n.message}
                      </div>
                      <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                        {timeAgo(n.createdAt)}
                      </div>
                    </div>
                    {!n.isRead && (
                      <span className="w-2 h-2 rounded-full bg-primary mt-2" />
                    )}
                  </li>
                ))}
              </ul>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProgressView({
  data,
  loading,
  error,
  onRetry,
}: {
  data: DashboardData | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  const t = useT();
  const setView = useApp((s) => s.setView);
  const exportProgress = async () => {
    try {
      const r = await fetch("/api/students/me/export-progress");
      if (!r.ok) {
        toast.error(t("student.188"));
        return;
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `my-progress-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t("student.189"));
    } catch {
      toast.error(t("student.190"));
    }
  };
  return (
    <div className="space-y-4">
      <BackBar
        title={t("student.191")}
        onBack={() => setView("student-dashboard")}
        action={
          <Button variant="outline" size="sm" onClick={exportProgress}>
            <Download className="w-4 h-4 ms-1.5" />
            Export CSV
          </Button>
        }
      />
      {loading ? (
        <DashboardSkeleton />
      ) : error || !data ? (
        <ErrorState message={error || t("student.118")} onRetry={onRetry} />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base">Course Progress</CardTitle>
            </CardHeader>
            <CardContent className="flex justify-center pt-2 pb-4">
              <ProgressRing percentage={data.courseProgress.percentage} />
            </CardContent>
          </Card>
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base">Attendance</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="text-3xl font-bold text-gradient">
                {data.attendance.percentage}%
              </div>
              <MiniBars percentage={data.attendance.percentage} />
              <div className="text-xs text-muted-foreground">
                {data.attendance.present} {t("student.132")}{data.attendance.total} {t("student.143")}</div>
            </CardContent>
          </Card>
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base">Lessons</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <Stat
                label={t("student.195")}
                value={data.courseProgress.completedLessons}
                icon={<CheckCircle2 className="w-4 h-4 text-primary" />}
              />
              <Stat
                label={t("student.196")}
                value={data.courseProgress.totalLessons}
                icon={<BookOpen className="w-4 h-4 text-muted-foreground" />}
              />
              <Stat
                label="Pending Homework"
                value={data.pendingHomework.count}
                icon={<ClipboardList className="w-4 h-4 text-amber-500" />}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  icon,
}: {
  label: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      {icon}
      <div className="text-sm text-muted-foreground flex-1">{label}</div>
      <div className="text-lg font-bold">{value}</div>
    </div>
  );
}

function BackBar({
  title,
  onBack,
  action,
}: {
  title: string;
  onBack: () => void;
  action?: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="flex items-center justify-between">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft className="w-4 h-4 ms-1.5 flip-rtl" />
        {t("student.197")}</Button>
      <h1 className="text-lg font-bold">{title}</h1>
      <div className="min-w-20 flex justify-end">{action}</div>
    </div>
  );
}
