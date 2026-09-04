"use client";
import { useT, translate , pickAuto } from "@/lib/i18n";

// ============================================================
// CodeMind Academy — Teacher Dashboard (Task 4)
// Egyptian Arabic-first RTL UI. Renders inside <DashboardShell>.
// Switches between 4 tabs based on useApp().view:
//   teacher-dashboard  → Overview
//   teacher-attendance → Attendance
//   teacher-quizzes    → Quizzes
//   teacher-homework   → Homework
// Tech terms (Quiz, Homework, Attendance, Group, Session,
// Student, Teacher, Dashboard, Grade) stay in English.
// ============================================================
import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

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
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

import { useApp, type ViewKey } from "@/lib/store";
import { brand } from "@/lib/brand";

import {
  LayoutDashboard,
  CalendarDays,
  Trophy,
  ClipboardList,
  Users,
  Clock,
  Sparkles,
  TrendingUp,
  CheckCircle2,
  AlertTriangle,
  Plus,
  Trash2,
  ChevronDown,
  ChevronLeft,
  RefreshCw,
  GraduationCap,
  Award,
  Activity,
  FileText,
  ListChecks,
  Save,
  X,
  Target,
  BarChart3,
  CircleCheck,
  CircleX,
  CircleAlert,
  CircleDashed,
  Pencil,
  ClipboardCheck,
} from "lucide-react";

// ============================================================
// Date helpers
// ============================================================
const curLocale = () => (useApp.getState().locale === "en" ? "en" : "ar");
const dtLocale = () => (curLocale() === "en" ? "en-GB" : "ar-EG");
const arDateFmt = () =>
  new Intl.DateTimeFormat(dtLocale(), {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
const arDateShortFmt = () =>
  new Intl.DateTimeFormat(dtLocale(), {
    weekday: "short",
    day: "numeric",
    month: "short",
  });
const arTimeFmt = () =>
  new Intl.DateTimeFormat(dtLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });

function fmtDate(d: string | Date) {
  return arDateFmt().format(new Date(d));
}
function fmtDateShort(d: string | Date) {
  return arDateShortFmt().format(new Date(d));
}
function fmtTime(d: string | Date) {
  return arTimeFmt().format(new Date(d));
}
function timeAgo(d: string | Date) {
  const t = new Date(d).getTime();
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return translate(curLocale(), "teacher.001");
  if (m < 60) return translate(curLocale(), "teacher.002");
  const h = Math.floor(m / 60);
  if (h < 24) return translate(curLocale(), "teacher.003");
  const days = Math.floor(h / 24);
  if (days < 7) return translate(curLocale(), "teacher.004");
  return arDateShortFmt().format(new Date(d));
}

// ============================================================
// Types (mirror API payloads)
// ============================================================
type TeacherInfo = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  bio: string | null;
  specialty: string | null;
};

type GroupInfo = {
  id: string;
  name: string;
  schedule: string;
  capacity: number;
  courseId: string;
  course: {
    id: string;
    slug: string;
    name: string;
    nameAr: string;
    color: string;
  } | null;
  studentsCount: number;
  students: Array<{
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    grade: string;
    studentCode?: string | null;
  }>;
  stats: {
    attendancePct: number;
    avgQuizScore: number;
    pendingHomework: number;
    totalSessions: number;
  };
  nextSession: {
    id: string;
    startAt: string;
    title: string;
  } | null;
};

type UpcomingSession = {
  id: string;
  title: string;
  startAt: string;
  duration: number;
  status: string;
  meetingUrl: string | null;
  group: { id: string; name: string };
  lesson: { id: string; title: string } | null;
};

type ActivityItem = {
  type: "homework-graded" | "quiz-attempt";
  title: string;
  description: string;
  studentName: string;
  time: string;
  kind: "good" | "neutral" | "warn";
};

type DashboardPayload = {
  teacher: TeacherInfo;
  groups: GroupInfo[];
  upcomingSessions: UpcomingSession[];
  recentActivity: ActivityItem[];
  pendingHomeworkCount: number;
};

type AttendanceStatus = "PRESENT" | "ABSENT" | "LATE" | "EXCUSED";

type AttendanceStudent = {
  id: string;
  name: string;
  email: string;
  avatarUrl: string | null;
  grade: string;
  studentCode?: string | null;
  status: AttendanceStatus | null;
  note: string | null;
  attendancePct: number;
  attendanceTotal: number;
};

type AttendanceSession = {
  id: string;
  title: string;
  startAt: string;
  duration: number;
  status: string;
  isPast: boolean;
};

type AttendancePayload = {
  group: { id: string; name: string; schedule: string };
  sessions: AttendanceSession[];
  students: AttendanceStudent[];
};

type QuizListItem = {
  id: string;
  title: string;
  titleRaw: string;
  titleAr: string;
  description: string | null;
  passMark: number;
  timeLimit: number | null;
  lesson: {
    id: string;
    title: string;
    course: { id: string; name: string } | null;
  } | null;
  questionCount: number;
  totalMarks: number;
  attemptsCount: number;
  avgScore: number;
  passedCount: number;
};

type LessonNode = {
  id: string;
  title: string;
  titleAr: string;
};
type TopicNode = {
  id: string;
  title: string;
  titleAr: string;
  lessons: LessonNode[];
};
type UnitNode = {
  id: string;
  title: string;
  titleAr: string;
  topics: TopicNode[];
};
type PartNode = {
  id: string;
  title: string;
  titleAr: string;
  units: UnitNode[];
};
type CourseNode = {
  id: string;
  name: string;
  parts: PartNode[];
};

type QuestionDraft = {
  type: "MCQ" | "TRUE_FALSE";
  prompt: string;
  promptAr: string;
  options: string[];
  answer: string;
  explanation: string;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
};

type HomeworkSubmission = {
  id: string;
  status: string;
  content: string | null;
  fileUrl: string | null;
  submittedAt: string | null;
  grade: number | null;
  feedback: string | null;
  student: {
    id: string;
    name: string;
    email: string;
    avatarUrl: string | null;
    grade: string;
  };
};

type HomeworkListItem = {
  id: string;
  title: string;
  titleAr: string;
  titleRaw: string;
  instructions: string | null;
  deadline: string;
  maxMarks: number;
  createdAt: string;
  lesson: {
    id: string;
    title: string;
    course: { id: string; name: string } | null;
  } | null;
  stats: {
    submitted: number;
    graded: number;
    pending: number;
    totalSubmissions: number;
  };
  submissions: HomeworkSubmission[];
};

// ============================================================
// Main component — routes between 4 sub-views by useApp().view
// ============================================================
export function TeacherDashboard() {
  const view = useApp((s) => s.view) as ViewKey;
  const setView = useApp((s) => s.setView);

  // Map view → tab id
  const tabValue: string = view.startsWith("teacher-attendance")
    ? "attendance"
    : view.startsWith("teacher-quizzes")
    ? "quizzes"
    : view.startsWith("teacher-homework")
    ? "homework"
    : view.startsWith("teacher-templates")
    ? "templates"
    : view.startsWith("teacher-analytics")
    ? "analytics"
    : "overview";

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="space-y-6"
    >
      {/* Tabs header */}
      <Tabs
        value={tabValue}
        onValueChange={(v) => {
          const next: ViewKey =
            v === "attendance"
              ? "teacher-attendance"
              : v === "quizzes"
              ? "teacher-quizzes"
              : v === "homework"
              ? "teacher-homework"
              : v === "templates"
              ? "teacher-templates"
              : v === "analytics"
              ? "teacher-analytics"
              : "teacher-dashboard";
          setView(next);
        }}
        className="w-full"
      >
        <TabsList className="w-full sm:w-auto h-auto flex-wrap justify-start">
          <TabsTrigger value="overview" className="gap-2">
            <LayoutDashboard className="w-4 h-4" />
            <span>Overview</span>
          </TabsTrigger>
          <TabsTrigger value="attendance" className="gap-2">
            <CalendarDays className="w-4 h-4" />
            <span>Attendance</span>
          </TabsTrigger>
          <TabsTrigger value="quizzes" className="gap-2">
            <Trophy className="w-4 h-4" />
            <span>Quizzes</span>
          </TabsTrigger>
          <TabsTrigger value="homework" className="gap-2">
            <ClipboardList className="w-4 h-4" />
            <span>Homework</span>
          </TabsTrigger>
          <TabsTrigger value="templates" className="gap-2">
            <FileText className="w-4 h-4" />
            <span>Templates</span>
          </TabsTrigger>
          <TabsTrigger value="analytics" className="gap-2">
            <BarChart3 className="w-4 h-4" />
            <span>Analytics</span>
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <AnimatePresence mode="wait">
        <motion.div
          key={tabValue}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.18 }}
        >
          {tabValue === "overview" && <OverviewView />}
          {tabValue === "attendance" && <AttendanceView />}
          {tabValue === "quizzes" && <QuizzesView />}
          {tabValue === "homework" && <HomeworkView />}
          {tabValue === "templates" && <TemplatesView />}
          {tabValue === "analytics" && <AnalyticsView />}
        </motion.div>
      </AnimatePresence>
    </motion.div>
  );
}

// ============================================================
// Common: Section header
// ============================================================
function SectionHeader({
  title,
  subtitle,
  icon: Icon,
  action,
}: {
  title: string;
  subtitle?: string;
  icon: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-xl bg-primary/10 text-primary flex items-center justify-center shrink-0">
          <Icon className="w-5 h-5" />
        </div>
        <div>
          <h2 className="text-lg sm:text-xl font-bold tracking-tight">
            {title}
          </h2>
          {subtitle && (
            <p className="text-xs sm:text-sm text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {action}
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry?: () => void }) {
  const tr = useT();
  return (
    <Card className="p-8 border-destructive/30">
      <div className="flex flex-col items-center text-center gap-3">
        <div className="w-12 h-12 rounded-full bg-destructive/10 text-destructive flex items-center justify-center">
          <AlertTriangle className="w-6 h-6" />
        </div>
        <p className="text-sm font-medium">
          {tr("teacher.005")}</p>
        {onRetry && (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="w-3.5 h-3.5 ms-1.5" />
            {tr("teacher.006")}</Button>
        )}
      </div>
    </Card>
  );
}

function EmptyState({
  message,
  emoji = "🎉",
  hint,
}: {
  message: string;
  emoji?: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-12 px-4">
      <div className="text-4xl mb-2">{emoji}</div>
      <p className="text-sm font-medium">{message}</p>
      {hint && (
        <p className="text-xs text-muted-foreground mt-1">{hint}</p>
      )}
    </div>
  );
}

// ============================================================
// OVERVIEW TAB
// ============================================================
function OverviewView() {
  const tr = useT();
  const setView = useApp((s) => s.setView);
  const { data, isLoading, isError, refetch } = useQuery<DashboardPayload>({
    queryKey: ["teacher-dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/teacher/dashboard");
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as DashboardPayload;
    },
  });

  if (isLoading) return <OverviewSkeleton />;
  if (isError || !data) {
    return (
      <ErrorState
        onRetry={() => {
          refetch();
        }}
      />
    );
  }

  const firstName = data.teacher.name.split(" ")[0] || data.teacher.name;

  return (
    <div className="space-y-6">
      {/* Welcome header */}
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative overflow-hidden rounded-2xl p-6 bg-mesh glass-strong"
      >
        <div className="absolute -top-12 -start-12 w-48 h-48 rounded-full bg-primary/10 blur-3xl pointer-events-none" />
        <div className="absolute -bottom-12 -end-12 w-48 h-48 rounded-full bg-amber-400/10 blur-3xl pointer-events-none" />
        <div className="relative flex items-start justify-between gap-4 flex-wrap">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground">
              {arDateFmt().format(new Date())} · {brand.academicYear}
            </div>
            <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              {tr("teacher.007")}<span className="text-gradient">{firstName}</span> 👋
            </h1>
            <p className="text-sm text-muted-foreground">
              {data.teacher.specialty
                ? `${data.teacher.specialty} · `
                : ""}
              {data.groups.length} Group · {data.upcomingSessions.length}{" "}
              {tr("teacher.008")}</p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setView("teacher-attendance")}
            >
              <CalendarDays className="w-4 h-4 ms-1.5" />
              Attendance
            </Button>
            <Button
              size="sm"
              onClick={() => setView("teacher-quizzes")}
            >
              <Plus className="w-4 h-4 ms-1.5" />
              {tr("teacher.009")}</Button>
          </div>
        </div>
      </motion.div>

      {/* Quick stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <StatCard
          icon={Users}
          label={tr("teacher.010")}
          value={String(data.groups.length)}
          accent="emerald"
          hint={`${data.groups.reduce(
            (s, g) => s + g.studentsCount,
            0
          )} Student`}
        />
        <StatCard
          icon={CalendarDays}
          label={tr("teacher.011")}
          value={String(data.upcomingSessions.length)}
          accent="teal"
          hint={tr("teacher.012")}
        />
        <StatCard
          icon={ClipboardList}
          label={tr("teacher.013")}
          value={String(data.pendingHomeworkCount)}
          accent="amber"
          hint={tr("teacher.014")}
        />
        <StatCard
          icon={TrendingUp}
          label="Avg Quiz Score"
          value={`${
            data.groups.length > 0
              ? Math.round(
                  data.groups.reduce((s, g) => s + g.stats.avgQuizScore, 0) /
                    data.groups.length
                )
              : 0
          }%`}
          accent="emerald"
          hint={tr("teacher.015")}
        />
      </div>

      {/* My Groups grid */}
      <div className="space-y-3">
        <SectionHeader
          title={tr("teacher.016")}
          subtitle={tr("teacher.017")}
          icon={Users}
        />
        {data.groups.length === 0 ? (
          <Card className="p-6">
            <EmptyState
              message={tr("teacher.018")}
              emoji="👥"
              hint={tr("teacher.019")}
            />
          </Card>
        ) : (
          <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
            {data.groups.map((g, i) => (
              <motion.div
                key={g.id}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.04 * i }}
              >
                <GroupCard group={g} />
              </motion.div>
            ))}
          </div>
        )}
      </div>

      {/* Upcoming sessions + Recent activity */}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card className="card-hover p-5">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <CalendarDays className="w-4 h-4 text-primary" />
              {tr("teacher.020")}</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {data.upcomingSessions.length === 0 ? (
              <EmptyState
                message={tr("teacher.021")}
                emoji="🗓️"
              />
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto ps-1">
                {data.upcomingSessions.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-muted/40 transition-colors"
                  >
                    <div className="flex flex-col items-center justify-center w-12 h-12 rounded-lg bg-primary/10 text-primary shrink-0">
                      <span className="text-[10px] font-bold leading-none">
                        {fmtDateShort(s.startAt).split(" ")[1]}
                      </span>
                      <span className="text-sm font-extrabold leading-none mt-0.5">
                        {new Date(s.startAt).getDate()}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">
                        {s.title}
                      </div>
                      <div className="text-xs text-muted-foreground flex items-center gap-1.5 mt-0.5">
                        <Clock className="w-3 h-3" />
                        {fmtTime(s.startAt)}
                        <span className="opacity-50">·</span>
                        <span className="truncate">{s.group.name}</span>
                      </div>
                    </div>
                    {s.meetingUrl ? (
                      <a
                        href={s.meetingUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs font-bold text-primary hover:underline shrink-0"
                      >
                        {tr("teacher.022")}</a>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        {tr("teacher.023")}</Badge>
                    )}
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        <Card className="card-hover p-5">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Activity className="w-4 h-4 text-primary" />
              {tr("teacher.024")}</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {data.recentActivity.length === 0 ? (
              <EmptyState
                message={tr("teacher.025")}
                emoji="📈"
              />
            ) : (
              <div className="space-y-2 max-h-96 overflow-y-auto ps-1">
                {data.recentActivity.map((a, i) => (
                  <ActivityRow key={i} item={a} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string;
  hint?: string;
  accent: "emerald" | "amber" | "teal";
}) {
  const colorMap = {
    emerald: "bg-primary/10 text-primary",
    amber: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    teal: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  } as const;
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="card-hover"
    >
      <Card className="p-4 h-full">
        <div className="flex items-start justify-between gap-2">
          <div
            className={`w-9 h-9 rounded-lg flex items-center justify-center ${colorMap[accent]}`}
          >
            <Icon className="w-4 h-4" />
          </div>
        </div>
        <div className="mt-3 text-2xl font-extrabold tracking-tight">
          {value}
        </div>
        <div className="text-xs font-semibold text-muted-foreground mt-0.5">
          {label}
        </div>
        {hint && (
          <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>
        )}
      </Card>
    </motion.div>
  );
}

function GroupCard({ group }: { group: GroupInfo }) {
  const tr = useT();
  const capacityPct =
    group.capacity > 0
      ? Math.min(100, Math.round((group.studentsCount / group.capacity) * 100))
      : 0;
  return (
    <Card className="card-hover h-full p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <div
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: group.course?.color || "#10b981" }}
            />
            <h3 className="font-bold text-base truncate">{group.name}</h3>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            {pickAuto(group.course?.nameAr, group.course?.name) || tr("teacher.026")}
          </p>
        </div>
        <Badge
          variant="secondary"
          className="bg-primary/10 text-primary border-0 shrink-0"
        >
          {group.studentsCount}/{group.capacity} Student
        </Badge>
      </div>

      {/* Schedule */}
      <div className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
        <Clock className="w-3 h-3" />
        <span className="truncate">{group.schedule}</span>
      </div>

      {/* Capacity progress */}
      <div className="mt-3">
        <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
          <span>{tr("teacher.027")}</span>
          <span>{capacityPct}%</span>
        </div>
        <Progress value={capacityPct} className="h-1.5" />
      </div>

      {/* Stats grid */}
      <div className="mt-4 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-muted/50 p-2">
          <div className="text-[10px] text-muted-foreground">Attendance</div>
          <div className="text-sm font-bold text-primary">
            {group.stats.attendancePct}%
          </div>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <div className="text-[10px] text-muted-foreground">Avg Quiz</div>
          <div className="text-sm font-bold text-amber-600 dark:text-amber-400">
            {group.stats.avgQuizScore}%
          </div>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <div className="text-[10px] text-muted-foreground">Homework</div>
          <div className="text-sm font-bold text-teal-600 dark:text-teal-400">
            {group.stats.pendingHomework}
          </div>
        </div>
      </div>

      {/* Next session */}
      {group.nextSession && (
        <div className="mt-3 p-2.5 rounded-lg bg-primary/5 border border-primary/10">
          <div className="text-[10px] text-muted-foreground">{tr("teacher.028")}</div>
          <div className="text-xs font-semibold mt-0.5 truncate">
            {group.nextSession.title}
          </div>
          <div className="text-[10px] text-muted-foreground mt-0.5">
            {fmtDateShort(group.nextSession.startAt)} ·{" "}
            {fmtTime(group.nextSession.startAt)}
          </div>
        </div>
      )}
    </Card>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const colorMap = {
    good: "bg-primary/10 text-primary",
    neutral: "bg-muted text-muted-foreground",
    warn: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  } as const;
  const IconMap = {
    "homework-graded": CheckCircle2,
    "quiz-attempt": Trophy,
  } as const;
  const Icon = IconMap[item.type];
  return (
    <div className="flex items-start gap-3 p-2.5 rounded-lg hover:bg-muted/40 transition-colors">
      <div
        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${colorMap[item.kind]}`}
      >
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold truncate">{item.title}</div>
        <div className="text-[11px] text-muted-foreground truncate">
          {item.studentName} · {item.description}
        </div>
      </div>
      <div className="text-[10px] text-muted-foreground shrink-0 mt-1">
        {timeAgo(item.time)}
      </div>
    </div>
  );
}

function OverviewSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-32 rounded-2xl" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-28 rounded-xl" />
        ))}
      </div>
      <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-72 rounded-xl" />
        ))}
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

// ============================================================
// ATTENDANCE TAB
// ============================================================
function AttendanceView() {
  const tr = useT();
  const queryClient = useQueryClient();

  // 1. Get dashboard just for the groups list (so we don't duplicate call)
  const dashQuery = useQuery<DashboardPayload>({
    queryKey: ["teacher-dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/teacher/dashboard");
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as DashboardPayload;
    },
  });

  const groups = dashQuery.data?.groups ?? [];
  const [groupId, setGroupId] = React.useState<string>("");
  const [sessionId, setSessionId] = React.useState<string>("");

  // Default-select first group
  React.useEffect(() => {
    if (!groupId && groups.length > 0) {
      setGroupId(groups[0].id);
    }
  }, [groups, groupId]);

  // Reset session when group changes
  React.useEffect(() => {
    setSessionId("");
  }, [groupId]);

  // Fetch sessions + students for the group (without per-session attendance).
  const groupQuery = useQuery<AttendancePayload>({
    queryKey: ["teacher-attendance-group", groupId],
    queryFn: async () => {
      const r = await fetch(
        `/api/teacher/attendance?groupId=${encodeURIComponent(groupId)}`
      );
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as AttendancePayload;
    },
    enabled: !!groupId,
  });

  // Fetch per-session attendance records for the selected session.
  const sessionAttQuery = useQuery<AttendancePayload>({
    queryKey: ["teacher-attendance-session", groupId, sessionId],
    queryFn: async () => {
      const r = await fetch(
        `/api/teacher/attendance?groupId=${encodeURIComponent(
          groupId
        )}&sessionId=${encodeURIComponent(sessionId)}`
      );
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as AttendancePayload;
    },
    enabled: !!groupId && !!sessionId,
  });

  // Default-select past session if no session selected
  React.useEffect(() => {
    if (
      groupQuery.data &&
      !sessionId &&
      groupQuery.data.sessions.length > 0
    ) {
      // Prefer the most recent past session, otherwise the next upcoming one
      const past = groupQuery.data.sessions.filter((s) => s.isPast);
      const first = past[0] || groupQuery.data.sessions[0];
      setSessionId(first.id);
    }
  }, [groupQuery.data, sessionId]);

  // Local draft state for attendance rows
  const [draft, setDraft] = React.useState<
    Record<string, AttendanceStatus>
  >({});
  const [notesDraft, setNotesDraft] = React.useState<Record<string, string>>(
    {}
  );

  // Reset draft when session changes — pull from sessionAttQuery (which
  // contains per-session attendance records).
  React.useEffect(() => {
    // Use sessionAttQuery data if available, else fall back to groupQuery
    // (which has status=null for all students).
    const src = sessionAttQuery.data || groupQuery.data;
    if (!src) return;
    const next: Record<string, AttendanceStatus> = {};
    const notes: Record<string, string> = {};
    src.students.forEach((s) => {
      if (s.status) next[s.id] = s.status;
      if (s.note) notes[s.id] = s.note;
    });
    setDraft(next);
    setNotesDraft(notes);
  }, [sessionAttQuery.data, groupQuery.data, sessionId]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const attendance = Object.entries(draft).map(([studentId, status]) => ({
        studentId,
        status,
        note: notesDraft[studentId] || undefined,
      }));
      const r = await fetch("/api/teacher/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId, attendance }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return (await r.json()) as { summary: any };
    },
    onSuccess: (data) => {
      toast.success(
        tr("teacher.029", { p1: data.summary.present, p2: data.summary.absent, p3: data.summary.late })
      );
      queryClient.invalidateQueries({ queryKey: ["teacher-attendance-group", groupId] });
      queryClient.invalidateQueries({ queryKey: ["teacher-attendance-session", groupId, sessionId] });
      queryClient.invalidateQueries({ queryKey: ["teacher-dashboard"] });
    },
    onError: (e: Error) => {
      toast.error(e.message || tr("teacher.030"));
    },
  });

  const setStatus = (studentId: string, status: AttendanceStatus) => {
    setDraft((d) => ({ ...d, [studentId]: status }));
  };

  // Summary counts from current draft
  const summary = React.useMemo(() => {
    const values = Object.values(draft);
    return {
      present: values.filter((v) => v === "PRESENT").length,
      absent: values.filter((v) => v === "ABSENT").length,
      late: values.filter((v) => v === "LATE").length,
      excused: values.filter((v) => v === "EXCUSED").length,
      total: values.length,
    };
  }, [draft]);

  if (dashQuery.isLoading || (dashQuery.isFetching && !dashQuery.data))
    return <AttendanceSkeleton />;
  if (dashQuery.isError || !dashQuery.data)
    return (
      <ErrorState
        onRetry={() => {
          dashQuery.refetch();
        }}
      />
    );

  if (groups.length === 0)
    return (
      <Card className="p-6">
        <EmptyState
          message={tr("teacher.018")}
          emoji="👥"
          hint={tr("teacher.019")}
        />
      </Card>
    );

  return (
    <div className="space-y-4">
      <SectionHeader
        title={tr("teacher.033")}
        subtitle={tr("teacher.034")}
        icon={CalendarDays}
      />

      {/* Selectors */}
      <Card className="p-4 sm:p-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Group</Label>
            <Select value={groupId} onValueChange={setGroupId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tr("teacher.035")} />
              </SelectTrigger>
              <SelectContent>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs text-muted-foreground">Session</Label>
            <Select
              value={sessionId}
              onValueChange={setSessionId}
              disabled={!groupQuery.data && !sessionAttQuery.data}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tr("teacher.036")} />
              </SelectTrigger>
              <SelectContent>
                {(groupQuery.data?.sessions ?? sessionAttQuery.data?.sessions ?? []).map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {s.isPast ? "✓ " : "📅 "}
                    {fmtDateShort(s.startAt)} · {s.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </Card>

      {!sessionId ? (
        <Card className="p-6">
          <EmptyState
            message={tr("teacher.037")}
            emoji="📅"
          />
        </Card>
      ) : groupQuery.isLoading || (sessionId && sessionAttQuery.isLoading) ? (
        <AttendanceSkeleton />
      ) : (groupQuery.isError && !sessionAttQuery.data) || !groupQuery.data ? (
        <ErrorState
          onRetry={() => {
            groupQuery.refetch();
          }}
        />
      ) : (groupQuery.data.students.length === 0 &&
          (sessionAttQuery.data?.students.length === 0 ||
            !sessionAttQuery.data)) ? (
        <Card className="p-6">
          <EmptyState
            message={tr("teacher.038")}
            emoji="👥"
            hint={tr("teacher.039")}
          />
        </Card>
      ) : (
        <>
          {/* Summary bar */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <SummaryPill
              icon={CheckCircle2}
              label={tr("teacher.040")}
              value={summary.present}
              color="bg-primary/10 text-primary"
            />
            <SummaryPill
              icon={X}
              label={tr("teacher.041")}
              value={summary.absent}
              color="bg-destructive/10 text-destructive"
            />
            <SummaryPill
              icon={Clock}
              label={tr("teacher.042")}
              value={summary.late}
              color="bg-amber-500/10 text-amber-600 dark:text-amber-400"
            />
            <SummaryPill
              icon={CircleAlert}
              label={tr("teacher.043")}
              value={summary.excused}
              color="bg-teal-500/10 text-teal-600 dark:text-teal-400"
            />
          </div>

          {/* Attendance table */}
          <Card className="p-0 overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40 hover:bg-muted/40">
                  <TableHead>Student</TableHead>
                  <TableHead className="text-center w-[120px] sm:w-[160px]">
                    {tr("teacher.040")}</TableHead>
                  <TableHead className="text-center w-[120px] sm:w-[160px]">
                    {tr("teacher.041")}</TableHead>
                  <TableHead className="text-center w-[120px] sm:w-[160px]">
                    {tr("teacher.042")}</TableHead>
                  <TableHead className="text-center w-[120px] sm:w-[160px]">
                    {tr("teacher.043")}</TableHead>
                  <TableHead className="text-center w-[80px] hidden md:table-cell">
                    %
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(sessionAttQuery.data?.students ?? groupQuery.data?.students ?? []).map((s) => {
                  const cur = draft[s.id];
                  return (
                    <TableRow key={s.id} className="hover:bg-muted/30">
                      <TableCell className="font-medium">
                        <div className="flex items-center gap-2.5">
                          <Avatar className="w-8 h-8">
                            <AvatarFallback className="bg-primary/10 text-primary text-[10px] font-bold">
                              {s.name.slice(0, 2).toUpperCase()}
                            </AvatarFallback>
                          </Avatar>
                          <div className="min-w-0">
                            <div className="text-sm font-semibold truncate">
                              {s.name}
                              {(s as any).studentCode && (
                                <code className="ms-2 text-[10px] font-mono font-bold text-primary" dir="ltr">
                                  {(s as any).studentCode}
                                </code>
                              )}
                            </div>
                            <div className="text-[10px] text-muted-foreground truncate">
                              {s.email}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusButton
                          active={cur === "PRESENT"}
                          onClick={() => setStatus(s.id, "PRESENT")}
                          variant="present"
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusButton
                          active={cur === "ABSENT"}
                          onClick={() => setStatus(s.id, "ABSENT")}
                          variant="absent"
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusButton
                          active={cur === "LATE"}
                          onClick={() => setStatus(s.id, "LATE")}
                          variant="late"
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        <StatusButton
                          active={cur === "EXCUSED"}
                          onClick={() => setStatus(s.id, "EXCUSED")}
                          variant="excused"
                        />
                      </TableCell>
                      <TableCell className="text-center hidden md:table-cell">
                        <span
                          className={`text-xs font-bold ${
                            s.attendancePct >= 75
                              ? "text-primary"
                              : s.attendancePct >= 50
                              ? "text-amber-600 dark:text-amber-400"
                              : "text-destructive"
                          }`}
                        >
                          {s.attendancePct}%
                        </span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="text-xs text-muted-foreground">
              {tr("teacher.048")}{summary.total} {tr("teacher.049")}{(sessionAttQuery.data?.students.length ?? groupQuery.data?.students.length ?? 0)} {tr("teacher.050")}</div>
            <Button
              onClick={() => saveMutation.mutate()}
              disabled={saveMutation.isPending || summary.total === 0}
            >
              {saveMutation.isPending ? (
                <>
                  <RefreshCw className="w-4 h-4 ms-2 animate-spin" />
                  {tr("teacher.051")}</>
              ) : (
                <>
                  <Save className="w-4 h-4 ms-2" />
                  {tr("teacher.052")}</>
              )}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}

function StatusButton({
  active,
  onClick,
  variant,
}: {
  active: boolean;
  onClick: () => void;
  variant: "present" | "absent" | "late" | "excused";
}) {
  const Icon = {
    present: CircleCheck,
    absent: CircleX,
    late: Clock,
    excused: CircleAlert,
  }[variant];
  const activeCls = {
    present:
      "bg-primary text-primary-foreground border-primary",
    absent:
      "bg-destructive text-destructive-foreground border-destructive",
    late: "bg-amber-500 text-white border-amber-500",
    excused:
      "bg-teal-500 text-white border-teal-500",
  }[variant];
  const idleCls =
    "bg-transparent text-muted-foreground/50 border-transparent hover:bg-muted hover:text-foreground";
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-8 h-8 sm:w-9 sm:h-9 rounded-lg border-2 inline-flex items-center justify-center transition-all ${
        active ? activeCls : idleCls
      }`}
      aria-pressed={active}
    >
      <Icon className="w-4 h-4 sm:w-5 sm:h-5" />
    </button>
  );
}

function SummaryPill({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div className={`rounded-xl p-3 flex items-center gap-3 ${color}`}>
      <Icon className="w-5 h-5 shrink-0" />
      <div>
        <div className="text-lg font-extrabold leading-none">{value}</div>
        <div className="text-[10px] opacity-80 mt-0.5">{label}</div>
      </div>
    </div>
  );
}

function AttendanceSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-24 rounded-xl" />
      <Skeleton className="h-64 rounded-xl" />
      <Skeleton className="h-32 rounded-xl" />
    </div>
  );
}

// ============================================================
// QUIZZES TAB
// ============================================================
function QuizzesView() {
  const tr = useT();
  const queryClient = useQueryClient();
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [filterGroupId, setFilterGroupId] = React.useState<string>("");

  const dashQuery = useQuery<DashboardPayload>({
    queryKey: ["teacher-dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/teacher/dashboard");
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as DashboardPayload;
    },
  });
  const groups = dashQuery.data?.groups ?? [];

  const quizzesQuery = useQuery<{ quizzes: QuizListItem[] }>({
    queryKey: ["teacher-quizzes", filterGroupId],
    queryFn: async () => {
      const q = filterGroupId
        ? `?groupId=${encodeURIComponent(filterGroupId)}`
        : "";
      const r = await fetch(`/api/teacher/quizzes${q}`);
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as { quizzes: QuizListItem[] };
    },
  });

  const lessonsQuery = useQuery<{ grouped: CourseNode[] }>({
    queryKey: ["teacher-lessons"],
    queryFn: async () => {
      const r = await fetch("/api/teacher/lessons");
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as { grouped: CourseNode[] };
    },
  });

  const createMutation = useMutation({
    mutationFn: async (payload: {
      lessonId: string;
      title: string;
      titleAr: string;
      description: string;
      passMark: number;
      questions: QuestionDraft[];
    }) => {
      const r = await fetch("/api/teacher/quizzes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.053"));
      queryClient.invalidateQueries({ queryKey: ["teacher-quizzes"] });
      setDialogOpen(false);
    },
    onError: (e: Error) => {
      toast.error(e.message || tr("teacher.030"));
    },
  });

  if (dashQuery.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );

  if (groups.length === 0)
    return (
      <Card className="p-6">
        <EmptyState
          message={tr("teacher.018")}
          emoji="👥"
          hint={tr("teacher.019")}
        />
      </Card>
    );

  return (
    <div className="space-y-4">
      <SectionHeader
        title={tr("teacher.057")}
        subtitle={tr("teacher.058")}
        icon={Trophy}
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="w-4 h-4 ms-2" />
            {tr("teacher.059")}</Button>
        }
      />

      {/* Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">{tr("teacher.060")}</span>
        <Select
          value={filterGroupId || "__all__"}
          onValueChange={(v) => setFilterGroupId(v === "__all__" ? "" : v)}
        >
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue placeholder={tr("teacher.061")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{tr("teacher.061")}</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Quizzes list */}
      {quizzesQuery.isLoading ? (
        <div className="grid sm:grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-40 rounded-xl" />
          ))}
        </div>
      ) : quizzesQuery.isError || !quizzesQuery.data ? (
        <ErrorState
          onRetry={() => {
            quizzesQuery.refetch();
          }}
        />
      ) : quizzesQuery.data.quizzes.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            message={tr("teacher.063")}
            emoji="📝"
            hint={tr("teacher.064")}
          />
        </Card>
      ) : (
        <div className="grid sm:grid-cols-2 gap-4">
          {quizzesQuery.data.quizzes.map((q, i) => (
            <motion.div
              key={q.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.03 * i }}
            >
              <QuizCard quiz={q} />
            </motion.div>
          ))}
        </div>
      )}

      {/* Create quiz dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Plus className="w-5 h-5 text-primary" />
              {tr("teacher.059")}</DialogTitle>
            <DialogDescription>
              {tr("teacher.066")}</DialogDescription>
          </DialogHeader>
          <QuizEditor
            lessons={lessonsQuery.data?.grouped ?? []}
            lessonsLoading={lessonsQuery.isLoading}
            onSubmit={(payload) => createMutation.mutate(payload)}
            submitting={createMutation.isPending}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function QuizCard({ quiz }: { quiz: QuizListItem }) {
  const tr = useT();
  const [expanded, setExpanded] = React.useState(false);
  return (
    <Card className="card-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <Trophy className="w-4 h-4 text-amber-500 shrink-0" />
            <h3 className="font-bold text-base truncate">{quiz.title}</h3>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {quiz.lesson?.title || "Lesson"}
            {quiz.lesson?.course ? ` · ${quiz.lesson.course.name}` : ""}
          </p>
        </div>
        <Badge
          variant="secondary"
          className="bg-primary/10 text-primary border-0 shrink-0"
        >
          {quiz.attemptsCount} {tr("teacher.067")}</Badge>
      </div>

      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-muted/50 p-2">
          <div className="text-[10px] text-muted-foreground">{tr("teacher.068")}</div>
          <div className="text-sm font-bold">{quiz.questionCount}</div>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <div className="text-[10px] text-muted-foreground">{tr("teacher.069")}</div>
          <div className="text-sm font-bold">{quiz.totalMarks} {tr("teacher.070")}</div>
        </div>
        <div className="rounded-lg bg-muted/50 p-2">
          <div className="text-[10px] text-muted-foreground">{tr("teacher.071")}</div>
          <div
            className={`text-sm font-bold ${
              quiz.avgScore >= quiz.passMark
                ? "text-primary"
                : "text-amber-600 dark:text-amber-400"
            }`}
          >
            {quiz.avgScore}%
          </div>
        </div>
      </div>

      {quiz.description && (
        <p className="text-xs text-muted-foreground mt-3 line-clamp-2">
          {quiz.description}
        </p>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <Award className="w-3 h-3" />
          <span>
            {tr("teacher.072")}{quiz.passedCount} / {quiz.attemptsCount} · Pass {quiz.passMark}%
          </span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? tr("teacher.073") : tr("teacher.074")}
          <ChevronDown
            className={`w-3.5 h-3.5 me-1 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </Button>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 pt-3 border-t border-border space-y-2 text-xs">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Pass Mark</span>
                <span className="font-semibold">{quiz.passMark}%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Time Limit</span>
                <span className="font-semibold">
                  {quiz.timeLimit ? tr("teacher.075", { p1: quiz.timeLimit }) : "—"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Title (EN)</span>
                <span className="font-mono">{quiz.titleRaw}</span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function QuizEditor({
  lessons,
  lessonsLoading,
  onSubmit,
  submitting,
}: {
  lessons: CourseNode[];
  lessonsLoading: boolean;
  onSubmit: (payload: {
    lessonId: string;
    title: string;
    titleAr: string;
    description: string;
    passMark: number;
    questions: QuestionDraft[];
  }) => void;
  submitting: boolean;
}) {
  const tr = useT();
  const [lessonId, setLessonId] = React.useState("");
  const [title, setTitle] = React.useState("");
  const [titleAr, setTitleAr] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [passMark, setPassMark] = React.useState(60);
  const [questions, setQuestions] = React.useState<QuestionDraft[]>([
    {
      type: "MCQ",
      prompt: "",
      promptAr: "",
      options: ["", "", "", ""],
      answer: "0",
      explanation: "",
      difficulty: "MEDIUM",
      marks: 1,
    },
  ]);

  const addQuestion = () => {
    setQuestions((q) => [
      ...q,
      {
        type: "MCQ",
        prompt: "",
        promptAr: "",
        options: ["", "", "", ""],
        answer: "0",
        explanation: "",
        difficulty: "MEDIUM",
        marks: 1,
      },
    ]);
  };
  const removeQuestion = (idx: number) => {
    setQuestions((q) => q.filter((_, i) => i !== idx));
  };
  const updateQ = (idx: number, patch: Partial<QuestionDraft>) => {
    setQuestions((q) =>
      q.map((x, i) => (i === idx ? { ...x, ...patch } : x))
    );
  };

  const handleSubmit = () => {
    if (!lessonId) {
      toast.error(tr("teacher.076"));
      return;
    }
    if (!title.trim()) {
      toast.error(tr("teacher.077"));
      return;
    }
    if (questions.length === 0) {
      toast.error(tr("teacher.078"));
      return;
    }
    // Normalize TRUE_FALSE questions to have options ["True","False"]
    const normalized = questions.map((q) => {
      if (q.type === "TRUE_FALSE") {
        return {
          ...q,
          options: ["True", "False"],
          answer: q.answer === "1" ? "1" : "0",
        };
      }
      return {
        ...q,
        options: q.options.filter((o) => o.trim() !== ""),
        answer: q.answer || "0",
      };
    });
    // Validate MCQ
    for (let i = 0; i < normalized.length; i++) {
      const q = normalized[i];
      if (!q.prompt.trim()) {
        toast.error(tr("teacher.079", { p1: i + 1 }));
        return;
      }
      if (q.type === "MCQ" && q.options.length < 2) {
        toast.error(tr("teacher.080", { p1: i + 1 }));
        return;
      }
    }
    onSubmit({
      lessonId,
      title: title.trim(),
      titleAr: titleAr.trim() || title.trim(),
      description: description.trim(),
      passMark,
      questions: normalized,
    });
  };

  return (
    <div className="space-y-4 mt-2">
      {/* Lesson selector */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">
          Lesson <span className="text-destructive">*</span>
        </Label>
        {lessonsLoading ? (
          <Skeleton className="h-9 w-full" />
        ) : (
          <Select value={lessonId} onValueChange={setLessonId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder={tr("teacher.081")} />
            </SelectTrigger>
            <SelectContent>
              {lessons.map((c) => (
                <SelectGroup key={c.id}>
                  <SelectLabel className="font-bold text-primary">
                    {c.name}
                  </SelectLabel>
                  {c.parts.map((p) => (
                    <SelectGroup key={p.id}>
                      <SelectLabel className="text-xs ps-3 opacity-80">
                        {p.title}
                      </SelectLabel>
                      {p.units.map((u) =>
                        u.topics.map((t) =>
                          t.lessons.map((l) => (
                            <SelectItem
                              key={l.id}
                              value={l.id}
                              className="text-xs"
                            >
                              {t.title} · {l.title}
                            </SelectItem>
                          ))
                        )
                      )}
                    </SelectGroup>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Title + titleAr */}
      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            Title (EN) <span className="text-destructive">*</span>
          </Label>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Lesson 2 Quiz"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">{tr("teacher.082")}</Label>
          <Input
            value={titleAr}
            onChange={(e) => setTitleAr(e.target.value)}
            placeholder={tr("teacher.083")}
            dir="rtl"
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{tr("teacher.084")}</Label>
        <Textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={tr("teacher.085")}
          rows={2}
        />
      </div>

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Pass Mark (%)</Label>
          <Input
            type="number"
            min={0}
            max={100}
            value={passMark}
            onChange={(e) => setPassMark(Number(e.target.value) || 0)}
          />
        </div>
      </div>

      {/* Questions */}
      <div className="space-y-3 pt-3 border-t border-border">
        <div className="flex items-center justify-between">
          <Label className="text-sm font-bold">
            {tr("teacher.086")}{questions.length})
          </Label>
          <Button size="sm" variant="outline" onClick={addQuestion}>
            <Plus className="w-3.5 h-3.5 ms-1.5" />
            {tr("teacher.087")}</Button>
        </div>

        <div className="space-y-3 max-h-[40vh] overflow-y-auto ps-1">
          {questions.map((q, idx) => (
            <QuestionEditor
              key={idx}
              index={idx}
              question={q}
              onChange={(patch) => updateQ(idx, patch)}
              onRemove={() => removeQuestion(idx)}
              canRemove={questions.length > 1}
            />
          ))}
        </div>
      </div>

      <DialogFooter>
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? (
            <>
              <RefreshCw className="w-4 h-4 ms-2 animate-spin" />
              {tr("teacher.051")}</>
          ) : (
            <>
              <Save className="w-4 h-4 ms-2" />
              {tr("teacher.089")}</>
          )}
        </Button>
      </DialogFooter>
    </div>
  );
}

function QuestionEditor({
  index,
  question,
  onChange,
  onRemove,
  canRemove,
}: {
  index: number;
  question: QuestionDraft;
  onChange: (patch: Partial<QuestionDraft>) => void;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const tr = useT();
  const setOption = (i: number, val: string) => {
    const next = [...question.options];
    next[i] = val;
    onChange({ options: next });
  };
  const addOption = () => {
    onChange({ options: [...question.options, ""] });
  };
  const removeOption = (i: number) => {
    if (question.options.length <= 2) return;
    const next = question.options.filter((_, idx) => idx !== i);
    let answer = question.answer;
    if (answer === String(i)) answer = "0";
    else if (Number(answer) > i)
      answer = String(Number(answer) - 1);
    onChange({ options: next, answer });
  };

  return (
    <div className="rounded-xl border border-border p-3 space-y-3 bg-muted/20">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-bold text-muted-foreground">
          {tr("teacher.090")}{index + 1}
        </div>
        <div className="flex items-center gap-2">
          <Select
            value={question.type}
            onValueChange={(v) =>
              onChange({
                type: v as "MCQ" | "TRUE_FALSE",
                options:
                  v === "TRUE_FALSE" ? ["True", "False"] : question.options,
                answer: v === "TRUE_FALSE" ? "0" : question.answer || "0",
              })
            }
          >
            <SelectTrigger size="sm" className="w-32 h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="MCQ">{tr("teacher.091")}</SelectItem>
              <SelectItem value="TRUE_FALSE">{tr("teacher.092")}</SelectItem>
            </SelectContent>
          </Select>
          {canRemove && (
            <Button
              variant="ghost"
              size="icon"
              className="w-7 h-7 text-destructive hover:text-destructive"
              onClick={onRemove}
              aria-label={tr("teacher.093")}
            >
              <Trash2 className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">
          {tr("teacher.094")}<span className="text-destructive">*</span>
        </Label>
        <Textarea
          value={question.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          placeholder="e.g. What does CPU stand for?"
          rows={2}
          className="text-sm"
        />
      </div>

      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">
          {tr("teacher.095")}</Label>
        <Textarea
          value={question.promptAr}
          onChange={(e) => onChange({ promptAr: e.target.value })}
          placeholder={tr("teacher.096")}
          rows={2}
          dir="rtl"
          className="text-sm"
        />
      </div>

      {/* Options (MCQ only) */}
      {question.type === "MCQ" && (
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">
            {tr("teacher.097")}</Label>
          <RadioGroupLike>
            {question.options.map((opt, i) => (
              <div
                key={i}
                className="flex items-center gap-2"
              >
                <button
                  type="button"
                  onClick={() => onChange({ answer: String(i) })}
                  className={`w-5 h-5 rounded-full border-2 shrink-0 inline-flex items-center justify-center transition-colors ${
                    question.answer === String(i)
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-input bg-transparent hover:border-primary/50"
                  }`}
                  aria-label={tr("teacher.098", { p1: i + 1 })}
                >
                  {question.answer === String(i) && (
                    <span className="w-2 h-2 rounded-full bg-primary-foreground" />
                  )}
                </button>
                <Input
                  value={opt}
                  onChange={(e) => setOption(i, e.target.value)}
                  placeholder={tr("teacher.099", { p1: i + 1 })}
                  className="text-sm h-8"
                />
                <button
                  type="button"
                  onClick={() => removeOption(i)}
                  disabled={question.options.length <= 2}
                  className="text-muted-foreground hover:text-destructive disabled:opacity-30 shrink-0 p-1"
                  aria-label={tr("teacher.100")}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </RadioGroupLike>
          <Button
            variant="ghost"
            size="sm"
            className="text-xs h-7"
            onClick={addOption}
          >
            <Plus className="w-3 h-3 ms-1" />
            {tr("teacher.101")}</Button>
        </div>
      )}

      {question.type === "TRUE_FALSE" && (
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">
            {tr("teacher.102")}</Label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onChange({ answer: "0" })}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-bold border-2 transition-colors ${
                question.answer === "0"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input hover:border-primary/50"
              }`}
            >
              True
            </button>
            <button
              type="button"
              onClick={() => onChange({ answer: "1" })}
              className={`flex-1 px-3 py-1.5 rounded-md text-xs font-bold border-2 transition-colors ${
                question.answer === "1"
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-input hover:border-primary/50"
              }`}
            >
              False
            </button>
          </div>
        </div>
      )}

      <div className="grid sm:grid-cols-3 gap-2">
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">Difficulty</Label>
          <Select
            value={question.difficulty}
            onValueChange={(v) =>
              onChange({ difficulty: v as "EASY" | "MEDIUM" | "HARD" })
            }
          >
            <SelectTrigger size="sm" className="h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="EASY">{tr("teacher.103")}</SelectItem>
              <SelectItem value="MEDIUM">{tr("teacher.104")}</SelectItem>
              <SelectItem value="HARD">{tr("teacher.105")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-[10px] text-muted-foreground">Marks</Label>
          <Input
            type="number"
            min={1}
            value={question.marks}
            onChange={(e) =>
              onChange({ marks: Number(e.target.value) || 1 })
            }
            className="h-8 text-xs"
          />
        </div>
        <div className="space-y-1.5 sm:col-span-1">
          <Label className="text-[10px] text-muted-foreground">Answer</Label>
          <div className="h-8 px-3 flex items-center text-xs font-bold text-primary bg-primary/5 rounded-md border border-primary/20">
            #{Number(question.answer) + 1}
          </div>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-[10px] text-muted-foreground">
          {tr("teacher.106")}</Label>
        <Textarea
          value={question.explanation}
          onChange={(e) => onChange({ explanation: e.target.value })}
          placeholder={tr("teacher.107")}
          rows={2}
          dir="rtl"
          className="text-sm"
        />
      </div>
    </div>
  );
}

// Tiny utility — just so we don't import RadioGroup here.
function RadioGroupLike({
  children,
}: {
  children: React.ReactNode;
}) {
  return <div className="space-y-1.5">{children}</div>;
}

// ============================================================
// HOMEWORK TAB
// ============================================================
function HomeworkView() {
  const tr = useT();
  const queryClient = useQueryClient();
  const [filterGroupId, setFilterGroupId] = React.useState<string>("");
  const [gradingFor, setGradingFor] = React.useState<{
    homeworkId: string;
    homeworkTitle: string;
    maxMarks: number;
    submission?: HomeworkSubmission;
  } | null>(null);

  const dashQuery = useQuery<DashboardPayload>({
    queryKey: ["teacher-dashboard"],
    queryFn: async () => {
      const r = await fetch("/api/teacher/dashboard");
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as DashboardPayload;
    },
  });
  const groups = dashQuery.data?.groups ?? [];

  const homeworkQuery = useQuery<{ homework: HomeworkListItem[] }>({
    queryKey: ["teacher-homework", filterGroupId],
    queryFn: async () => {
      const q = filterGroupId
        ? `?groupId=${encodeURIComponent(filterGroupId)}`
        : "";
      const r = await fetch(`/api/teacher/homework${q}`);
      if (!r.ok) throw new Error("fail");
      return (await r.json()) as { homework: HomeworkListItem[] };
    },
  });

  const gradeMutation = useMutation({
    mutationFn: async (payload: {
      homeworkId: string;
      studentId: string;
      grade: number;
      feedback: string;
    }) => {
      const r = await fetch(
        `/api/teacher/homework/${payload.homeworkId}/grade`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            studentId: payload.studentId,
            grade: payload.grade,
            feedback: payload.feedback,
          }),
        }
      );
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error || "fail");
      }
      return r.json();
    },
    onSuccess: () => {
      toast.success(tr("teacher.108"));
      queryClient.invalidateQueries({ queryKey: ["teacher-homework"] });
      setGradingFor(null);
    },
    onError: (e: Error) => {
      toast.error(e.message || tr("teacher.030"));
    },
  });

  if (dashQuery.isLoading)
    return (
      <div className="space-y-4">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );

  if (groups.length === 0)
    return (
      <Card className="p-6">
        <EmptyState
          message={tr("teacher.018")}
          emoji="👥"
          hint={tr("teacher.019")}
        />
      </Card>
    );

  return (
    <div className="space-y-4">
      <SectionHeader
        title={tr("teacher.112")}
        subtitle={tr("teacher.113")}
        icon={ClipboardList}
      />

      {/* Filter */}
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground">{tr("teacher.060")}</span>
        <Select
          value={filterGroupId || "__all__"}
          onValueChange={(v) => setFilterGroupId(v === "__all__" ? "" : v)}
        >
          <SelectTrigger className="h-8 w-48 text-xs">
            <SelectValue placeholder={tr("teacher.061")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{tr("teacher.061")}</SelectItem>
            {groups.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Homework list */}
      {homeworkQuery.isLoading ? (
        <div className="grid lg:grid-cols-2 gap-4">
          {[0, 1].map((i) => (
            <Skeleton key={i} className="h-56 rounded-xl" />
          ))}
        </div>
      ) : homeworkQuery.isError || !homeworkQuery.data ? (
        <ErrorState
          onRetry={() => {
            homeworkQuery.refetch();
          }}
        />
      ) : homeworkQuery.data.homework.length === 0 ? (
        <Card className="p-6">
          <EmptyState
            message={tr("teacher.117")}
            hint={tr("teacher.118")}
          />
        </Card>
      ) : (
        <div className="grid lg:grid-cols-2 gap-4">
          {homeworkQuery.data.homework.map((hw, i) => (
            <motion.div
              key={hw.id}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.03 * i }}
            >
              <HomeworkCard
                hw={hw}
                onGrade={(submission) =>
                  setGradingFor({
                    homeworkId: hw.id,
                    homeworkTitle: hw.title,
                    maxMarks: hw.maxMarks,
                    submission,
                  })
                }
              />
            </motion.div>
          ))}
        </div>
      )}

      {/* Grading dialog */}
      <Dialog
        open={!!gradingFor}
        onOpenChange={(o) => !o && setGradingFor(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ClipboardCheck className="w-5 h-5 text-primary" />
              {tr("teacher.119")}</DialogTitle>
            <DialogDescription>
              {gradingFor?.homeworkTitle}
              {gradingFor?.submission ? (
                <>
                  {" · "}
                  {gradingFor.submission.student.name}
                </>
              ) : (
                ""
              )}
            </DialogDescription>
          </DialogHeader>
          {gradingFor && (
            <GradeForm
              maxMarks={gradingFor.maxMarks}
              initialGrade={gradingFor.submission?.grade ?? null}
              initialFeedback={gradingFor.submission?.feedback ?? ""}
              content={gradingFor.submission?.content ?? null}
              submittedAt={gradingFor.submission?.submittedAt ?? null}
              studentName={gradingFor.submission?.student.name ?? ""}
              submitting={gradeMutation.isPending}
              onSubmit={(grade, feedback) =>
                gradeMutation.mutate({
                  homeworkId: gradingFor.homeworkId,
                  studentId:
                    gradingFor.submission?.student.id ??
                    "",
                  grade,
                  feedback,
                })
              }
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function HomeworkCard({
  hw,
  onGrade,
}: {
  hw: HomeworkListItem;
  onGrade: (sub: HomeworkSubmission) => void;
}) {
  const tr = useT();
  const [expanded, setExpanded] = React.useState(false);
  const deadline = new Date(hw.deadline);
  const isOverdue = deadline.getTime() < Date.now();
  const pendingCount = hw.stats.pending;
  const submittedCount = hw.stats.submitted;
  const gradedCount = hw.stats.graded;

  return (
    <Card className="card-hover p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <FileText className="w-4 h-4 text-primary shrink-0" />
            <h3 className="font-bold text-base truncate">{hw.title}</h3>
          </div>
          <p className="text-xs text-muted-foreground mt-1 truncate">
            {hw.lesson?.title || "Lesson"}
            {hw.lesson?.course ? ` · ${hw.lesson.course.name}` : ""}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <Badge
            variant={isOverdue ? "destructive" : "secondary"}
            className={`text-[10px] ${
              isOverdue
                ? ""
                : "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-0"
            }`}
          >
            <Clock className="w-3 h-3 ms-1" />
            {fmtDateShort(deadline)}
          </Badge>
          <span className="text-[10px] text-muted-foreground">
            {hw.maxMarks} {tr("teacher.120")}</span>
        </div>
      </div>

      {/* Stats */}
      <div className="mt-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-lg bg-amber-500/5 p-2">
          <div className="text-[10px] text-muted-foreground">{tr("teacher.121")}</div>
          <div className="text-sm font-bold text-amber-600 dark:text-amber-400">
            {pendingCount}
          </div>
        </div>
        <div className="rounded-lg bg-primary/5 p-2">
          <div className="text-[10px] text-muted-foreground">{tr("teacher.122")}</div>
          <div className="text-sm font-bold text-primary">
            {submittedCount}
          </div>
        </div>
        <div className="rounded-lg bg-teal-500/5 p-2">
          <div className="text-[10px] text-muted-foreground">{tr("teacher.123")}</div>
          <div className="text-sm font-bold text-teal-600 dark:text-teal-400">
            {gradedCount}
          </div>
        </div>
      </div>

      {hw.instructions && (
        <p className="text-xs text-muted-foreground mt-3 line-clamp-2">
          {hw.instructions}
        </p>
      )}

      {/* Toggle submissions */}
      <div className="mt-3 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
          <ListChecks className="w-3 h-3" />
          <span>{hw.submissions.length} Submissions</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          className="text-xs"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? tr("teacher.073") : tr("teacher.125")}
          <ChevronDown
            className={`w-3.5 h-3.5 me-1 transition-transform ${
              expanded ? "rotate-180" : ""
            }`}
          />
        </Button>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div className="mt-3 pt-3 border-t border-border space-y-2 max-h-64 overflow-y-auto ps-1">
              {hw.submissions.length === 0 ? (
                <p className="text-xs text-muted-foreground text-center py-3">
                  {tr("teacher.126")}</p>
              ) : (
                hw.submissions.map((sub) => (
                  <SubmissionRow
                    key={sub.id}
                    sub={sub}
                    maxMarks={hw.maxMarks}
                    onGrade={() => onGrade(sub)}
                  />
                ))
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

function SubmissionRow({
  sub,
  maxMarks,
  onGrade,
}: {
  sub: HomeworkSubmission;
  maxMarks: number;
  onGrade: () => void;
}) {
  const tr = useT();
  const badge = statusBadge(sub.status);
  return (
    <div className="flex items-center gap-2 p-2 rounded-lg hover:bg-muted/40 transition-colors">
      <Avatar className="w-7 h-7">
        <AvatarFallback className="bg-primary/10 text-primary text-[10px] font-bold">
          {sub.student.name.slice(0, 2).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold truncate">
          {sub.student.name}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {sub.submittedAt ? timeAgo(sub.submittedAt) : tr("teacher.127")}
        </div>
      </div>
      <Badge
        variant="secondary"
        className={`text-[10px] border-0 ${badge.cls}`}
      >
        {badge.label}
      </Badge>
      {sub.grade !== null && (
        <span className="text-xs font-bold text-primary">
          {sub.grade}/{maxMarks}
        </span>
      )}
      <TooltipProvider delayDuration={150}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="w-7 h-7"
              onClick={onGrade}
            >
              <Pencil className="w-3.5 h-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{tr("teacher.128")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    </div>
  );
}

function statusBadge(status: string): { label: string; cls: string } {
  switch (status) {
    case "PENDING":
      return { label: translate(curLocale(), "teacher.121"), cls: "bg-amber-500/15 text-amber-700 dark:text-amber-300" };
    case "SUBMITTED":
      return { label: translate(curLocale(), "teacher.122"), cls: "bg-primary/15 text-primary" };
    case "GRADED":
      return { label: translate(curLocale(), "teacher.123"), cls: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300" };
    case "LATE":
      return { label: translate(curLocale(), "teacher.042"), cls: "bg-destructive/15 text-destructive" };
    default:
      return { label: status, cls: "bg-muted text-muted-foreground" };
  }
}

function GradeForm({
  maxMarks,
  initialGrade,
  initialFeedback,
  content,
  submittedAt,
  studentName,
  submitting,
  onSubmit,
}: {
  maxMarks: number;
  initialGrade: number | null;
  initialFeedback: string;
  content: string | null;
  submittedAt: string | null;
  studentName: string;
  submitting: boolean;
  onSubmit: (grade: number, feedback: string) => void;
}) {
  const tr = useT();
  const [grade, setGrade] = React.useState<string>(
    initialGrade !== null ? String(initialGrade) : ""
  );
  const [feedback, setFeedback] = React.useState(initialFeedback);

  React.useEffect(() => {
    setGrade(initialGrade !== null ? String(initialGrade) : "");
    setFeedback(initialFeedback);
  }, [initialGrade, initialFeedback]);

  const handleSubmit = () => {
    const g = Number(grade);
    if (Number.isNaN(g)) {
      toast.error(tr("teacher.133"));
      return;
    }
    if (g < 0 || g > maxMarks) {
      toast.error(tr("teacher.134", { p1: maxMarks }));
      return;
    }
    onSubmit(g, feedback.trim());
  };

  return (
    <div className="space-y-4 mt-2">
      {/* Student info + content */}
      {content && (
        <div className="rounded-lg bg-muted/40 p-3 space-y-1">
          <div className="text-xs font-semibold text-muted-foreground">
            {studentName} ·{" "}
            {submittedAt ? tr("teacher.135", { p1: timeAgo(submittedAt) }) : tr("teacher.127")}
          </div>
          <p className="text-sm leading-relaxed whitespace-pre-wrap">
            {content}
          </p>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">
            {tr("teacher.137")}{maxMarks}) <span className="text-destructive">*</span>
          </Label>
          <Input
            type="number"
            min={0}
            max={maxMarks}
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            placeholder={`0 - ${maxMarks}`}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">{tr("teacher.138")}</Label>
        <Textarea
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder={tr("teacher.139")}
          rows={4}
          dir="rtl"
        />
      </div>

      <DialogFooter>
        <Button onClick={handleSubmit} disabled={submitting}>
          {submitting ? (
            <>
              <RefreshCw className="w-4 h-4 ms-2 animate-spin" />
              {tr("teacher.051")}</>
          ) : (
            <>
              <Save className="w-4 h-4 ms-2" />
              {tr("teacher.141")}</>
          )}
        </Button>
      </DialogFooter>
    </div>
  );
}

// ============================================================
// Templates View — Lesson Plan Templates
// ============================================================
function TemplatesView() {
  const tr = useT();
  const [templates, setTemplates] = React.useState<any[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [showCreate, setShowCreate] = React.useState(false);
  const [expanded, setExpanded] = React.useState<string | null>(null);

  const reload = React.useCallback(() => {
    setLoading(true);
    fetch("/api/teacher/templates")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTemplates(d?.templates || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  React.useEffect(() => {
    reload();
  }, [reload]);

  const del = async (id: string) => {
    if (!confirm(tr("teacher.142"))) return;
    await fetch(`/api/teacher/templates/${id}`, { method: "DELETE" });
    toast.success(tr("teacher.143"));
    reload();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Lesson Plan Templates</h2>
          <p className="text-xs text-muted-foreground">
            {tr("teacher.144")}</p>
        </div>
        <Button onClick={() => setShowCreate((s) => !s)}>
          <Plus className="w-4 h-4 ms-2" />
          {tr("teacher.145")}</Button>
      </div>

      {showCreate && (
        <CreateTemplateForm
          onDone={() => {
            setShowCreate(false);
            reload();
          }}
        />
      )}

      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <FileText className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{tr("teacher.146")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {templates.map((t, i) => (
            <motion.div
              key={t.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Card className="glass card-hover overflow-hidden">
                <div
                  className="p-4 cursor-pointer"
                  onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                >
                  <div className="flex items-start gap-3">
                    <div className="grid place-items-center w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500/15 to-amber-400/15 text-primary shrink-0">
                      <FileText className="w-5 h-5" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-base">{pickAuto(t.titleAr, t.title)}</h3>
                        <Badge variant="outline" className="text-[10px]">
                          {t.duration} {tr("teacher.147")}</Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">
                        {t.description}
                      </p>
                    </div>
                    <ChevronDown
                      className={`w-4 h-4 text-muted-foreground transition-transform shrink-0 ${
                        expanded === t.id ? "rotate-180" : ""
                      }`}
                    />
                  </div>
                </div>

                <AnimatePresence>
                  {expanded === t.id && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      className="overflow-hidden"
                    >
                      <div className="px-4 pb-4 space-y-3 border-t border-border/40 pt-3">
                        {/* Objectives */}
                        {t.objectives?.length > 0 && (
                          <div>
                            <div className="text-xs font-bold mb-1.5 flex items-center gap-1.5">
                              <Target className="w-3.5 h-3.5 text-primary" />
                              {tr("teacher.148")}</div>
                            <ul className="space-y-1">
                              {t.objectives.map((o: string, i: number) => (
                                <li key={i} className="text-xs text-muted-foreground flex items-start gap-1.5">
                                  <CheckCircle2 className="w-3 h-3 text-primary mt-0.5 shrink-0" />
                                  {o}
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Activities */}
                        {t.activities?.length > 0 && (
                          <div>
                            <div className="text-xs font-bold mb-1.5 flex items-center gap-1.5">
                              <Clock className="w-3.5 h-3.5 text-amber-500" />
                              {tr("teacher.149")}</div>
                            <div className="space-y-1.5">
                              {t.activities.map((a: any, i: number) => (
                                <div key={i} className="flex items-start gap-2 p-2 rounded-lg bg-muted/30">
                                  <span className="text-xs font-bold text-primary shrink-0">
                                    {i + 1}.
                                  </span>
                                  <div className="flex-1">
                                    <div className="text-xs font-semibold">{a.title}</div>
                                    <div className="text-xs text-muted-foreground">{a.description}</div>
                                  </div>
                                  <Badge variant="outline" className="text-[10px]">
                                    {a.duration} {tr("teacher.150")}</Badge>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Homework */}
                        {t.homework && (
                          <div>
                            <div className="text-xs font-bold mb-1 flex items-center gap-1.5">
                              <ClipboardList className="w-3.5 h-3.5 text-amber-500" />
                              {tr("teacher.151")}</div>
                            <p className="text-xs text-muted-foreground p-2 rounded-lg bg-muted/30">
                              {t.homework}
                            </p>
                          </div>
                        )}

                        <div className="flex justify-end pt-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            onClick={() => del(t.id)}
                          >
                            <Trash2 className="w-3.5 h-3.5 ms-1" />
                            {tr("teacher.152")}</Button>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}

function CreateTemplateForm({ onDone }: { onDone: () => void }) {
  const tr = useT();
  const [title, setTitle] = React.useState("");
  const [titleAr, setTitleAr] = React.useState("");
  const [description, setDescription] = React.useState("");
  const [duration, setDuration] = React.useState("90");
  const [objectives, setObjectives] = React.useState("");
  const [homework, setHomework] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const save = async () => {
    if (!titleAr.trim()) {
      toast.error(tr("teacher.153"));
      return;
    }
    setSaving(true);
    try {
      const r = await fetch("/api/teacher/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: titleAr,
          titleAr,
          description,
          duration: parseInt(duration, 10),
          objectives: objectives.split("\n").filter(Boolean),
          materials: [],
          activities: [],
          homework,
        }),
      });
      if (!r.ok) {
        toast.error(tr("teacher.154"));
        return;
      }
      toast.success(tr("teacher.155"));
      onDone();
    } finally {
      setSaving(false);
    }
  };

  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "auto" }}
      exit={{ opacity: 0, height: 0 }}
    >
      <Card className="glass border-primary/20">
        <CardHeader>
          <CardTitle className="text-base">{tr("teacher.145")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <Label className="text-xs">{tr("teacher.157")}</Label>
            <Input
              value={titleAr}
              onChange={(e) => setTitleAr(e.target.value)}
              placeholder={tr("teacher.158")}
              className="mt-1"
            />
          </div>
          <div>
            <Label className="text-xs">{tr("teacher.159")}</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tr("teacher.160")}
              className="mt-1"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">{tr("teacher.161")}</Label>
              <Input
                type="number"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>
          <div>
            <Label className="text-xs">{tr("teacher.162")}</Label>
            <Textarea
              value={objectives}
              onChange={(e) => setObjectives(e.target.value)}
              placeholder={tr("teacher.163")}
              className="mt-1 min-h-[80px]"
            />
          </div>
          <div>
            <Label className="text-xs">{tr("teacher.151")}</Label>
            <Input
              value={homework}
              onChange={(e) => setHomework(e.target.value)}
              placeholder={tr("teacher.165")}
              className="mt-1"
            />
          </div>
          <div className="flex items-center gap-2">
            <Button onClick={save} disabled={saving}>
              {saving ? tr("teacher.166") : tr("teacher.167")}
            </Button>
            <Button variant="ghost" onClick={onDone}>
              {tr("teacher.168")}</Button>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ============================================================
// Analytics View — Teacher Performance Dashboard
// ============================================================
function AnalyticsView() {
  const tr = useT();
  const [data, setData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    setLoading(true);
    fetch("/api/teacher/analytics")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => toast.error(tr("teacher.169")))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <Skeleton className="h-64" />
      </div>
    );
  }

  if (!data) return null;

  const { overview, groups } = data;

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-bold flex items-center gap-2">
          <BarChart3 className="w-5 h-5 text-primary" />
          Analytics
        </h2>
        <p className="text-xs text-muted-foreground mt-1">
          {tr("teacher.170")}</p>
      </div>

      {/* Overview stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <OverviewStat
          icon={Users}
          label="Total Students"
          value={overview.totalStudents}
          color="from-emerald-400 to-teal-500"
        />
        <OverviewStat
          icon={CalendarDays}
          label="Avg Attendance"
          value={`${overview.avgAttendance}%`}
          color="from-teal-400 to-cyan-500"
        />
        <OverviewStat
          icon={Trophy}
          label="Avg Quiz Score"
          value={`${overview.avgQuizScore}%`}
          color="from-amber-400 to-orange-500"
        />
        <OverviewStat
          icon={CheckCircle2}
          label="Quiz Pass Rate"
          value={`${overview.quizPassRate}%`}
          color="from-orange-400 to-rose-500"
        />
      </div>

      {/* Per-group analytics */}
      {groups.map((g: any, gi: number) => (
        <motion.div
          key={g.groupId}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: gi * 0.1 }}
        >
          <Card className="glass card-hover">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">{g.groupName}</CardTitle>
                  <CardDescription className="text-xs">
                    {g.courseName} · {g.totalStudents} {tr("teacher.171")}</CardDescription>
                </div>
                <Badge variant="outline" className="bg-primary/5">
                  {g.totalStudents} students
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Metrics bars */}
              <div className="grid grid-cols-2 gap-4">
                <MetricBar label="Attendance" value={g.avgAttendance} color="bg-emerald-500" />
                <MetricBar label="Avg Quiz Score" value={g.avgQuizScore} color="bg-amber-500" />
                <MetricBar label="Quiz Pass Rate" value={g.quizPassRate} color="bg-teal-500" />
                <MetricBar label="Homework Done" value={g.homeworkCompletion} color="bg-orange-500" />
              </div>

              {/* Top students */}
              {g.topStudents?.length > 0 && (
                <div>
                  <div className="text-xs font-bold mb-2 flex items-center gap-1.5 text-emerald-600">
                    <Trophy className="w-3.5 h-3.5" />
                    Top Students
                  </div>
                  <div className="space-y-1.5">
                    {g.topStudents.map((s: any, i: number) => (
                      <div
                        key={s.studentId}
                        className="flex items-center gap-2 p-2 rounded-lg bg-emerald-500/5 border border-emerald-400/20"
                      >
                        <div className="grid place-items-center w-6 h-6 rounded-full bg-emerald-500/15 text-emerald-600 text-xs font-bold">
                          {i + 1}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold truncate">{s.name}</div>
                        </div>
                        <Badge variant="outline" className="text-[10px]">
                          Quiz: {s.quizAvg}%
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          Att: {s.attendancePct}%
                        </Badge>
                        <div className="text-sm font-bold text-emerald-600 shrink-0">
                          {s.performanceScore}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Struggling students */}
              {g.strugglingStudents?.length > 0 && (
                <div>
                  <div className="text-xs font-bold mb-2 flex items-center gap-1.5 text-amber-600">
                    <AlertTriangle className="w-3.5 h-3.5" />
                    {tr("teacher.172")}</div>
                  <div className="space-y-1.5">
                    {g.strugglingStudents.map((s: any) => (
                      <div
                        key={s.studentId}
                        className="flex items-center gap-2 p-2 rounded-lg bg-amber-500/5 border border-amber-400/20"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-semibold truncate">{s.name}</div>
                        </div>
                        <Badge variant="outline" className="text-[10px]">
                          Quiz: {s.quizAvg}%
                        </Badge>
                        <Badge variant="outline" className="text-[10px]">
                          Att: {s.attendancePct}%
                        </Badge>
                        <div className="text-sm font-bold text-amber-600 shrink-0">
                          {s.performanceScore}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      ))}

      {groups.length === 0 && (
        <Card>
          <CardContent className="py-10 text-center">
            <BarChart3 className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{tr("teacher.018")}</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function OverviewStat({
  icon: Icon,
  label,
  value,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  color: string;
}) {
  return (
    <Card className="glass card-hover">
      <CardContent className="p-4">
        <div className={`grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br ${color} text-white mb-2`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="text-2xl font-extrabold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
      </CardContent>
    </Card>
  );
}

function MetricBar({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-bold">{value}%</span>
      </div>
      <div className="h-2 bg-muted rounded-full overflow-hidden">
        <motion.div
          initial={{ width: 0 }}
          animate={{ width: `${value}%` }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className={`h-full ${color} rounded-full`}
        />
      </div>
    </div>
  );
}
