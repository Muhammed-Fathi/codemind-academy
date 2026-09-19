"use client";
import { useT , pickAuto, useLocale } from "@/lib/i18n";
// Finding 8 — the ONE mapping from NotificationType to a localized label key
// (pure module, safe in the browser). Raw enum names never reach the UI.
import { notificationTypeLabelKey } from "@/lib/notification-labels";

// ============================================================
// CodeMind Academy — Admin Dashboard
// Switches between sub-views based on useApp().view.
// All views render inside <DashboardShell> via children.
// ============================================================
import * as React from "react";
import { useApp } from "@/lib/store";
// Phase 25 PR3 — the payment review drawer is the ONLY caller of the PR2b
// approve/reject endpoints (queue columns + review workflow live in §7).
import {
  PaymentReviewDrawer,
  type AdminPaymentRow,
} from "@/components/admin/payment-review-drawer";
import { paymentMethodLabel } from "@/lib/payment-ux";
import { motion, AnimatePresence } from "framer-motion";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerDescription,
} from "@/components/ui/drawer";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import { Progress } from "@/components/ui/progress";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Users,
  GraduationCap,
  Briefcase,
  CreditCard,
  ShieldCheck,
  TrendingUp,
  CalendarDays,
  Trophy,
  Plus,
  Search,
  CheckCircle2,
  XCircle,
  Bell,
  Save,
  Send,
  BookOpen,
  Library,
  ChevronLeft,
  UserCheck,
  UserX,
  PencilLine,
  Settings,
  Ticket,
  Trash2,
  Sparkles,
  Loader2,
  Upload,
  Download,
  TrendingDown,
  Clock,
  Activity,
} from "lucide-react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip as ReTooltip,
  CartesianGrid,
  PieChart,
  Pie,
  Cell,
  LineChart,
  Line,
} from "recharts";
import { SessionVideosView } from "@/components/admin/session-videos-view";
import { ConfirmDialog } from "@/components/shared/confirm-dialog";
import { NotificationsPanel } from "@/components/shared/notifications-panel";
import { MockExamsView } from "@/components/admin/mock-exams-view";
import { QuizReviewView } from "@/components/admin/quiz-review-view";
import { SessionWorkflowView } from "@/components/admin/session-workflow-view";

const BRAND_COLORS = ["#10b981", "#14b8a6", "#f59e0b", "#0d9488", "#84cc16"];

// ============================================================
// Helpers
// ============================================================
function useApi<T>(url: string | null, deps: any[] = []) {
  const [data, setData] = React.useState<T | null>(null);
  const [loading, setLoading] = React.useState<boolean>(!!url);
  const [error, setError] = React.useState<string | null>(null);
  const reload = React.useCallback(() => {
    if (!url) return;
    setLoading(true);
    fetch(url)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("err"))))
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch(() => setError("admin.001"))
      .finally(() => setLoading(false));
  }, [url]);
  React.useEffect(() => {
    if (url) reload();
  }, [url, ...deps]);
  return { data, loading, error, reload, setData };
}

function AnimatedCounter({ value }: { value: number }) {
  const [display, setDisplay] = React.useState(0);
  const target = Math.max(0, value);
  React.useEffect(() => {
    let raf: number;
    const start = display;
    const diff = target - start;
    if (diff === 0) return;
    const duration = 800;
    const startTime = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - startTime) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(Math.round(start + diff * eased));
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target]);
  return <span>{display.toLocaleString("en-US")}</span>;
}

function LoadingBlock({ rows = 4 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}

function ErrorBlock({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const tr = useT();
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center gap-3">
      <XCircle className="w-8 h-8 text-destructive" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          {tr("admin.002")}</Button>
      )}
    </div>
  );
}

function EmptyBlock({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center gap-2">
      <div className="text-3xl">·</div>
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function statusBadge(status: string) {
  switch (status) {
    case "PENDING":
      return <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">Pending</Badge>;
    case "APPROVED":
    case "ACTIVE":
      return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">Approved</Badge>;
    case "REJECTED":
    case "CANCELLED":
      return <Badge className="bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30">Rejected</Badge>;
    case "EXPIRED":
      return <Badge variant="secondary">Expired</Badge>;
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}

function difficultyBadge(d: string) {
  switch (d) {
    case "EASY":
      return <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">EASY</Badge>;
    case "MEDIUM":
      return <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">MEDIUM</Badge>;
    case "HARD":
      return <Badge className="bg-red-500/15 text-red-700 dark:text-red-300 border-red-500/30">HARD</Badge>;
    default:
      return <Badge variant="outline">{d}</Badge>;
  }
}

function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  try {
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
  } catch {
    return "—";
  }
}

function fmtDateTime(d: string | Date | null | undefined) {
  if (!d) return "—";
  try {
    const date = typeof d === "string" ? new Date(d) : d;
    return date.toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

// ============================================================
// Main Dashboard Shell
// ============================================================
export function AdminDashboard() {
  const view = useApp((s) => s.view) as string;
  return (
    <div className="space-y-6">
      {view === "admin-overview" && <OverviewView />}
      {view === "admin-students" && <StudentsView />}
      {view === "admin-teachers" && <TeachersView />}
      {view === "admin-groups" && <GroupsView />}
      {view === "admin-courses" && <CoursesView />}
      {view === "admin-sessions" && <SessionWorkflowView />}
      {view === "admin-question-bank" && <QuestionBankView />}
      {view === "admin-session-videos" && <SessionVideosView />}
      {view === "admin-mock-exams" && <MockExamsView />}
      {view === "admin-quiz-review" && <QuizReviewView />}
      {view === "admin-payments" && <PaymentsView />}
      {view === "admin-subscriptions" && <SubscriptionsView />}
      {view === "admin-notifications" && <NotificationsView />}
      {view === "admin-coupons" && <CouponsView />}
      {view === "admin-settings" && <SettingsView />}
    </div>
  );
}

// ============================================================
// 1. Overview
// ============================================================
type OverviewData = {
  totals: {
    totalStudents: number;
    activeStudents: number;
    totalTeachers: number;
    activeGroups: number;
    pendingPayments: number;
    activeSubscriptions: number;
    revenueThisMonth: number;
    attendanceRate: number;
    avgQuizScore: number;
  };
  revenueTrend: { month: string; revenue: number }[];
  groupDistribution: { name: string; value: number }[];
  upcomingSessions: {
    id: string;
    title: string;
    startAt: string;
    groupName: string | null;
    teacherName: string | null;
  }[];
};

function OverviewView() {
  const tr = useT();
  const { data, loading, error, reload } = useApi<OverviewData>("/api/admin/overview");

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-72 rounded-xl" />
        <LoadingBlock rows={3} />
      </div>
    );
  }
  if (error || !data) {
    return <ErrorBlock message={tr(error || "admin.003")} onRetry={reload} />;
  }

  const t = data.totals;
  const cards = [
    { label: "Total Students", value: t.totalStudents, icon: GraduationCap, color: "text-emerald-500" },
    { label: "Active Students", value: t.activeStudents, icon: UserCheck, color: "text-teal-500" },
    { label: "Active Subscriptions", value: t.activeSubscriptions, icon: ShieldCheck, color: "text-amber-500" },
    { label: "Pending Payments", value: t.pendingPayments, icon: CreditCard, color: "text-red-500" },
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-6"
    >
      {/* Stat cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 stagger-in">
        {cards.map((c) => (
          <Card key={c.label} className="p-4 card-hover">
            <div className="flex items-start justify-between">
              <div>
                <div className="text-xs text-muted-foreground">{c.label}</div>
                <div className="text-2xl font-bold mt-2 text-gradient">
                  <AnimatedCounter value={c.value} />
                </div>
              </div>
              <div className={`p-2 rounded-lg bg-muted/50 ${c.color}`}>
                <c.icon className="w-5 h-5" />
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* Secondary metrics */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <TrendingUp className="w-3.5 h-3.5 text-emerald-500" />
            {tr("admin.004")}</div>
          <div className="text-2xl font-bold mt-2">
            <AnimatedCounter value={t.revenueThisMonth} />
            <span className="text-sm text-muted-foreground me-1">EGP</span>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <UserCheck className="w-3.5 h-3.5 text-teal-500" />
            Attendance Rate
          </div>
          <div className="text-2xl font-bold mt-2">
            <AnimatedCounter value={t.attendanceRate} />
            <span className="text-sm text-muted-foreground me-1">%</span>
          </div>
          <Progress value={t.attendanceRate} className="mt-2 h-1.5" />
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Trophy className="w-3.5 h-3.5 text-amber-500" />
            Avg. Quiz Score
          </div>
          <div className="text-2xl font-bold mt-2">
            <AnimatedCounter value={t.avgQuizScore} />
            <span className="text-sm text-muted-foreground me-1">%</span>
          </div>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Revenue Trend</CardTitle>
            <CardDescription>{tr("admin.005")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div dir="ltr" className="w-full h-64">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data.revenueTrend} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.91 0.01 165)" />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <ReTooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid oklch(0.91 0.01 165)",
                      fontSize: 12,
                    }}
                  />
                  <Line
                    type="monotone"
                    dataKey="revenue"
                    stroke="#10b981"
                    strokeWidth={2.5}
                    dot={{ fill: "#10b981", r: 3 }}
                    activeDot={{ r: 5 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Group Distribution</CardTitle>
            <CardDescription>{tr("admin.006")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div dir="ltr" className="w-full h-64">
              {data.groupDistribution.length === 0 ? (
                <EmptyBlock message={tr("admin.007")} />
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={data.groupDistribution}
                      dataKey="value"
                      nameKey="name"
                      innerRadius={50}
                      outerRadius={80}
                      paddingAngle={3}
                    >
                      {data.groupDistribution.map((_, i) => (
                        <Cell key={i} fill={BRAND_COLORS[i % BRAND_COLORS.length]} />
                      ))}
                    </Pie>
                    <ReTooltip
                      contentStyle={{
                        borderRadius: 8,
                        border: "1px solid oklch(0.91 0.01 165)",
                        fontSize: 12,
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Revenue Analytics Section */}
      <RevenueAnalyticsSection />

      {/* Revenue Forecast Section */}
      <RevenueForecastSection />

      {/* Upcoming sessions */}
      <Card className="p-4">
        <CardHeader className="px-0 pt-0">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarDays className="w-4 h-4 text-emerald-500" />
            Upcoming Sessions
          </CardTitle>
          <CardDescription>{tr("admin.008")}</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {data.upcomingSessions.length === 0 ? (
            <EmptyBlock message={tr("admin.009")} />
          ) : (
            <ScrollArea className="min-h-0" viewportClassName="max-h-96 overscroll-contain">
              <div className="space-y-2">
                {data.upcomingSessions.map((s) => (
                  <div
                    key={s.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-border bg-muted/30 hover:bg-muted/60 transition-colors"
                  >
                    <div className="w-10 h-10 rounded-lg bg-primary/10 text-primary flex items-center justify-center shrink-0">
                      <CalendarDays className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold truncate">{s.title}</div>
                      <div className="text-xs text-muted-foreground truncate">
                        {s.groupName || "—"} · {s.teacherName || "—"}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground shrink-0">
                      {fmtDateTime(s.startAt)}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ============================================================
// 2. Students
// ============================================================
type StudentRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  grade: string;
  schoolName: string | null;
  schoolType?: string | null;
  nationalId?: string | null;
  parentPhone?: string | null;
  studentCode?: string | null;
  enrolledAt: string;
  group: { id: string; name: string; course: { nameAr: string; name?: string } } | null;
  subscription: {
    status: string;
    endDate: string | null;
    plan: { nameAr: string; name?: string };
  } | null;
  accountStatus?: string | null;
  videoProgress?: {
    totalVideos: number;
    completedVideos: number;
    averagePercent: number;
    completionPercent: number;
  } | null;
};

type StudentsResponse = {
  students: StudentRow[];
  counts: { ARABIC: number; LANGUAGE: number; UNSPECIFIED: number };
  pagination: { page: number; totalPages: number; total: number; hasMore: boolean };
};

/**
 * School-type views (Arabic school / Language school).
 * The value is sent to the API and filtered in SQL against the real
 * `Student.schoolType` column — the classification is never hardcoded here.
 */
const STUDENT_TABS = [
  { value: "ARABIC", labelKey: "admin.200" },
  { value: "LANGUAGE", labelKey: "admin.201" },
  { value: "UNSPECIFIED", labelKey: "admin.202" },
] as const;

function StudentsView() {
  const tr = useT();
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [schoolType, setSchoolType] = React.useState<string>("ARABIC");
  const [page, setPage] = React.useState(1);
  const [openAdd, setOpenAdd] = React.useState(false);
  const [selected, setSelected] = React.useState<StudentRow | null>(null);

  // Reset to the first page whenever the view or a filter changes.
  React.useEffect(() => {
    setPage(1);
  }, [search, status, schoolType]);

  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (status !== "all") params.set("status", status);
    // Every tab is filtered in SQL, including "UNSPECIFIED" (schoolType IS
    // NULL). Filtering that case on the client would only search the current
    // page and hide matching students on later pages.
    params.set("schoolType", schoolType);
    params.set("page", String(page));
    params.set("withProgress", "1");
    return `/api/admin/students?${params.toString()}`;
  }, [search, status, schoolType, page]);

  const { data, loading, error, reload } = useApi<StudentsResponse>(query, [
    search,
    status,
    schoolType,
    page,
  ]);

  // All three views are server-filtered and paginated, so the rows are used
  // exactly as returned — no client-side narrowing that could fight pagination.
  const rows = data?.students || [];

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.010")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.011")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const r = await fetch("/api/admin/export-progress");
                if (!r.ok) {
                  toast.error(tr("admin.012"));
                  return;
                }
                const blob = await r.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `students-progress-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success(tr("admin.013"));
              } catch {
                toast.error(tr("admin.014"));
              }
            }}
          >
            <Download className="w-4 h-4 ms-2" />
            Export CSV
          </Button>
          <Button onClick={() => setOpenAdd(true)}>
            <Plus className="w-4 h-4 ms-2" />
            Add Student
          </Button>
        </div>
      </div>

      <Card className="p-4">
        {/* School-type views. Uses logical spacing so the tab order follows
            the document direction in both Arabic (RTL) and English (LTR). */}
        <div
          role="tablist"
          aria-label={tr("admin.203")}
          className="flex flex-wrap items-center gap-2 mb-4 border-b border-border/60 pb-3"
        >
          {STUDENT_TABS.map((tab) => {
            const active = schoolType === tab.value;
            const count = data?.counts?.[tab.value as keyof StudentsResponse["counts"]];
            return (
              <button
                key={tab.value}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setSchoolType(tab.value)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
              >
                <span>{tr(tab.labelKey)}</span>
                {typeof count === "number" && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                      active ? "bg-primary-foreground/20" : "bg-background"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-3 mb-4">
          <div className="field-with-icon relative flex-1 min-w-[200px]">
            <span className="field-icon">
              <Search className="w-4 h-4" />
            </span>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr("admin.015")}
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder={tr("admin.016")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("admin.016")}</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="inactive">Inactive</SelectItem>
              <SelectItem value="suspended">{tr("admin.227")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : rows.length === 0 ? (
          <EmptyBlock message={tr("admin.018")} />
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("admin.019")}</TableHead>
                  <TableHead>{tr("admin.020")}</TableHead>
                  <TableHead>{tr("admin.021")}</TableHead>
                  <TableHead>{tr("admin.022")}</TableHead>
                  <TableHead>{tr("admin.023")}</TableHead>
                  <TableHead>{tr("admin.220")}</TableHead>
                  <TableHead>{tr("admin.024")}</TableHead>
                  <TableHead>{tr("admin.025")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((s) => (
                  <TableRow
                    key={s.id}
                    className="cursor-pointer"
                    onClick={() => setSelected(s)}
                  >
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>
                      {s.studentCode ? (
                        <code className="text-xs font-mono font-bold text-primary" dir="ltr">
                          {s.studentCode}
                        </code>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.email}</TableCell>
                    <TableCell>{s.grade}</TableCell>
                    <TableCell>{s.group?.name || "—"}</TableCell>
                    <TableCell>
                      {s.videoProgress && s.videoProgress.totalVideos > 0 ? (
                        <div className="flex items-center gap-2 min-w-[120px]">
                          <Progress
                            value={s.videoProgress.completionPercent}
                            className="h-1.5 flex-1"
                          />
                          <span className="text-[11px] tabular-nums text-muted-foreground">
                            {s.videoProgress.completedVideos}/{s.videoProgress.totalVideos}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.subscription ? (
                        <span className="text-xs">
                          {pickAuto(s.subscription.plan?.nameAr, s.subscription.plan?.name)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.accountStatus === "SUSPENDED_MULTI_DEVICE" ? (
                        <Badge className="bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30">
                          {tr("admin.227")}
                        </Badge>
                      ) : s.isActive ? (
                        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">Active</Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {data?.pagination && data.pagination.totalPages > 1 && (
          <div className="flex items-center justify-between gap-2 pt-3">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              {tr("admin.232")}
            </Button>
            <span className="text-xs text-muted-foreground tabular-nums">
              {page} / {data.pagination.totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data.pagination.hasMore}
              onClick={() => setPage((p) => p + 1)}
            >
              {tr("admin.233")}
            </Button>
          </div>
        )}
      </Card>

      <AddStudentDialog open={openAdd} onOpenChange={setOpenAdd} onCreated={reload} />

      <StudentProfileDrawer
        student={selected}
        onClose={() => setSelected(null)}
        onUpdated={reload}
      />
    </motion.div>
  );
}

function AddStudentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    grade: "2nd Secondary",
    schoolName: "",
  });
  const [saving, setSaving] = React.useState(false);

  const submit = async () => {
    if (!form.name || !form.email || !form.password) {
      toast.error(tr("admin.026"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/students", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || tr("admin.003"));
      toast.success(tr("admin.028"));
      onCreated();
      onOpenChange(false);
      setForm({ name: "", email: "", password: "", phone: "", grade: "2nd Secondary", schoolName: "" });
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("admin.030")}</DialogTitle>
          <DialogDescription>{tr("admin.031")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{tr("admin.019")}</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>{tr("admin.021")}</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <Label>{tr("admin.034")}</Label>
            <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tr("admin.035")}</Label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <Label>{tr("admin.022")}</Label>
              <Input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} />
            </div>
          </div>
          <div>
            <Label>{tr("admin.037")}</Label>
            <Input value={form.schoolName} onChange={(e) => setForm({ ...form, schoolName: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tr("admin.038")}</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.040")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StudentProfileDrawer({
  student,
  onClose,
  onUpdated,
}: {
  student: StudentRow | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const tr = useT();
  // vaul anchors side drawers by physical direction; RTL opens the panel
  // from the left, so mirror the prop here. Width/max-width constraints
  // ([dir]-agnostic w-3/4 + sm:max-w-sm) stay identical for both sides.
  const locale = useLocale();
  const [groups, setGroups] = React.useState<{ id: string; name: string }[]>([]);
  const [groupId, setGroupId] = React.useState<string | undefined>(undefined);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (student) {
      setGroupId(student.group?.id || undefined);
      fetch("/api/admin/groups")
        .then((r) => r.json())
        .then((d) => setGroups(d.groups || []))
        .catch(() => {});
    }
  }, [student]);

  const toggleActive = async () => {
    if (!student) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/students/${student.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !student.isActive }),
      });
      if (!res.ok) throw new Error("err");
      toast.success(student.isActive ? tr("admin.041") : tr("admin.042"));
      onUpdated();
      onClose();
    } catch {
      toast.error(tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  const assignGroup = async () => {
    if (!student) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/students/${student.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ groupId: groupId || null }),
      });
      if (!res.ok) throw new Error("err");
      toast.success(tr("admin.044"));
      onUpdated();
      onClose();
    } catch {
      toast.error(tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={!!student} onOpenChange={(v) => !v && onClose()} direction={locale === "ar" ? "left" : "right"}>
      <DrawerContent className="w-full sm:max-w-md ms-auto h-full max-h-screen flex flex-col">
        {student && (
          <>
            <DrawerHeader className="shrink-0 border-b border-border/60 pb-3">
              <DrawerTitle className="text-lg font-bold">{student.name}</DrawerTitle>
              <DrawerDescription className="text-xs">{student.email}</DrawerDescription>
            </DrawerHeader>
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
              {student.studentCode && (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs text-muted-foreground">{tr("admin.020")}</div>
                    <code className="text-lg font-black font-mono tracking-widest text-primary" dir="ltr">
                      {student.studentCode}
                    </code>
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      try {
                        navigator.clipboard.writeText(student.studentCode || "");
                        toast.success(tr("admin.047"));
                      } catch {
                        toast.error(tr("admin.048"));
                      }
                    }}
                  >
                    {tr("admin.049")}</Button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">{tr("admin.035")}</div>
                  <div className="font-medium mt-1">{student.phone || "—"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">{tr("admin.051")}</div>
                  <div className="font-medium mt-1" dir="ltr">{student.parentPhone || "—"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">{tr("admin.052")}</div>
                  <div className="font-medium mt-1 font-mono" dir="ltr">{student.nationalId || "—"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">{tr("admin.022")}</div>
                  <div className="font-medium mt-1">{student.grade}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">{tr("admin.037")}</div>
                  <div className="font-medium mt-1">{student.schoolName || "—"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">{tr("admin.055")}</div>
                  <div className="font-medium mt-1">
                    {student.schoolType === "LANGUAGE" ? tr("admin.056") : student.schoolType === "ARABIC" ? tr("admin.057") : "—"}
                  </div>
                </div>
                <div className="rounded-lg border p-3 col-span-2">
                  <div className="text-xs text-muted-foreground">{tr("admin.058")}</div>
                  <div className="font-medium mt-1">{fmtDate(student.enrolledAt)}</div>
                </div>
              </div>

              <div className="rounded-lg border p-3 space-y-2">
                <div className="text-xs text-muted-foreground">{tr("admin.024")}</div>
                {student.subscription ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{pickAuto(student.subscription.plan?.nameAr, student.subscription.plan?.name)}</span>
                      {statusBadge(student.subscription.status)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {tr("admin.060")}{fmtDate(student.subscription.endDate)}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">{tr("admin.061")}</div>
                )}
              </div>

              <div className="rounded-lg border p-3 space-y-2">
                <div className="text-xs text-muted-foreground">{tr("admin.023")}</div>
                <Select value={groupId} onValueChange={setGroupId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={tr("admin.063")} />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Button size="sm" variant="outline" onClick={assignGroup} disabled={saving} className="w-full">
                  {tr("admin.064")}</Button>
              </div>

              <Button
                onClick={toggleActive}
                disabled={saving}
                variant={student.isActive ? "destructive" : "default"}
                className="w-full"
              >
                {student.isActive ? (
                  <>
                    <UserX className="w-4 h-4 ms-2" />
                    {tr("admin.065")}</>
                ) : (
                  <>
                    <UserCheck className="w-4 h-4 ms-2" />
                    {tr("admin.066")}</>
                )}
              </Button>
            </div>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}

// ============================================================
// 3. Teachers
// ============================================================
type TeacherRow = {
  id: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  isActive: boolean;
  bio: string | null;
  specialty: string | null;
  groups: { id: string; name: string }[];
  groupsCount: number;
};

function TeachersView() {
  const tr = useT();
  const [openAdd, setOpenAdd] = React.useState(false);
  // Post-launch lifecycle: edit profile + guarded hard delete (server refuses
  // a teacher with groups/sessions/notes — deactivation is the safe path).
  const [editing, setEditing] = React.useState<TeacherRow | null>(null);
  const [deleting, setDeleting] = React.useState<TeacherRow | null>(null);
  const { data, loading, error, reload } = useApi<{ teachers: TeacherRow[] }>("/api/admin/teachers");

  const toggleTeacherActive = async (t: TeacherRow) => {
    try {
      const res = await fetch(`/api/admin/teachers/${t.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !t.isActive }),
      });
      if (!res.ok) throw new Error("Failed");
      toast.success(t.isActive ? "Teacher deactivated" : "Teacher reactivated");
      reload();
    } catch {
      toast.error(tr("admin.001"));
    }
  };

  const deleteTeacher = async (t: TeacherRow) => {
    try {
      const res = await fetch(`/api/admin/teachers/${t.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        // The server explains WHY (assigned groups / sessions / notes) and
        // points at deactivation — surface that message verbatim.
        toast.error(j.error || tr("admin.001"));
        return;
      }
      toast.success(tr("admin.516"));
      setDeleting(null);
      reload();
    } catch {
      toast.error(tr("admin.001"));
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.067")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.068")}</p>
        </div>
        <Button onClick={() => setOpenAdd(true)}>
          <Plus className="w-4 h-4 ms-2" />
          Add Teacher
        </Button>
      </div>

      <Card className="p-4">
        {loading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : !data || data.teachers.length === 0 ? (
          <EmptyBlock message={tr("admin.069")} />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("admin.019")}</TableHead>
                  <TableHead>{tr("admin.021")}</TableHead>
                  <TableHead>Specialty</TableHead>
                  <TableHead>{tr("admin.072")}</TableHead>
                  <TableHead>{tr("admin.025")}</TableHead>
                  <TableHead>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.teachers.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center">
                          {t.name.slice(0, 2).toUpperCase()}
                        </div>
                        {t.name}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{t.email}</TableCell>
                    <TableCell>{t.specialty || "—"}</TableCell>
                    <TableCell>
                      {t.groupsCount > 0 ? (
                        <Badge variant="secondary">{t.groupsCount}</Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {t.isActive ? (
                        <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30">Active</Badge>
                      ) : (
                        <Badge variant="secondary">Inactive</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(t)} title={tr("admin.521")}>
                          <PencilLine className="w-3.5 h-3.5" />
                          <span className="ms-1">{tr("admin.521")}</span>
                        </Button>
                        <Button size="sm" variant={t.isActive ? "outline" : "default"} onClick={() => toggleTeacherActive(t)}>
                          {t.isActive ? tr("admin.298") : tr("admin.299")}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-destructive hover:text-destructive"
                          onClick={() => setDeleting(t)}
                          title={tr("admin.514")}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <AddTeacherDialog open={openAdd} onOpenChange={setOpenAdd} onCreated={reload} />

      {/* Post-launch lifecycle: profile edit */}
      <EditTeacherDialog
        teacher={editing}
        onClose={() => setEditing(null)}
        onUpdated={reload}
      />

      {/* Post-launch lifecycle: guarded hard delete (server refuses a teacher
          with groups/sessions/notes; deactivation is the safe alternative). */}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title={tr("admin.514")}
        description={
          <span>
            <span className="block font-semibold text-foreground mb-1">
              {deleting?.name} · <span dir="ltr">{deleting?.email}</span>
            </span>
            {tr("admin.515")}
          </span>
        }
        confirmLabel={tr("admin.517")}
        cancelLabel={tr("admin.038")}
        onConfirm={async () => {
          if (deleting) await deleteTeacher(deleting);
        }}
      />

      <TeacherApplicationsPanel />
    </motion.div>
  );
}

type TeacherApplicationRow = {
  id: string;
  email: string;
  name: string;
  phone: string | null;
  specialty: string | null;
  bio: string | null;
  status: "PENDING" | "APPROVED" | "REJECTED" | "ACTIVATED";
  adminNote: string | null;
  reviewedAt: string | null;
  createdAt: string;
  userId: string | null;
};

// Phase 20 — the admin review queue for the public "become a teacher" flow.
// Approval/rejection are server-authorized POSTs; nothing here can set a
// status field directly (the server ignores any client-supplied status/role).
function TeacherApplicationsPanel() {
  const tr = useT();
  const [statusFilter, setStatusFilter] = React.useState("PENDING");
  const { data, loading, error, reload } = useApi<{ applications: TeacherApplicationRow[] }>(
    `/api/admin/teacher-applications?status=${encodeURIComponent(statusFilter)}`
  );
  const [busyId, setBusyId] = React.useState<string | null>(null);

  const act = async (id: string, action: "approve" | "reject") => {
    setBusyId(id);
    try {
      const r = await fetch(`/api/admin/teacher-applications/${id}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "err");
      toast.success(action === "approve" ? "Application approved" : "Application rejected");
      reload();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setBusyId(null);
    }
  };

  const pendingCount = (data?.applications || []).filter((a) => a.status === "PENDING").length;

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h3 className="font-bold">Teacher applications</h3>
          <p className="text-xs text-muted-foreground">
            Public applicants awaiting review — approve to email an activation link.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{pendingCount} pending</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="h-8 rounded-md border border-input bg-background px-2 text-xs"
          >
            {["PENDING", "APPROVED", "REJECTED", "ACTIVATED"].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {loading ? (
        <LoadingBlock rows={3} />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data || data.applications.length === 0 ? (
        <EmptyBlock message="No applications" />
      ) : (
        <div className="max-h-[40vh] overflow-auto space-y-2">
          {data.applications.map((a) => (
            <div key={a.id} className="rounded-lg border border-border/60 p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="font-medium">{a.name}</div>
                <div className="text-xs text-muted-foreground" dir="ltr">{a.email}</div>
                <div className="text-xs text-muted-foreground">
                  {a.phone || "—"} · {a.specialty || "—"}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Badge variant={a.status === "PENDING" ? "default" : "secondary"}>{a.status}</Badge>
                {a.status === "PENDING" && (
                  <>
                    <Button size="sm" disabled={busyId === a.id} onClick={() => act(a.id, "approve")}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" disabled={busyId === a.id} onClick={() => act(a.id, "reject")}>
                      Reject
                    </Button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function AddTeacherDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    name: "",
    email: "",
    password: "",
    phone: "",
    specialty: "",
    bio: "",
  });
  const [saving, setSaving] = React.useState(false);

  const submit = async () => {
    if (!form.name || !form.email || !form.password) {
      toast.error(tr("admin.026"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/teachers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("admin.075"));
      onCreated();
      onOpenChange(false);
      setForm({ name: "", email: "", password: "", phone: "", specialty: "", bio: "" });
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("admin.077")}</DialogTitle>
          <DialogDescription>{tr("admin.078")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{tr("admin.019")}</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>{tr("admin.021")}</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <Label>{tr("admin.034")}</Label>
            <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tr("admin.035")}</Label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <Label>Specialty</Label>
              <Input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
            </div>
          </div>
          <div>
            <Label>Bio</Label>
            <Textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tr("admin.038")}</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.040")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Post-launch lifecycle — edit an existing teacher's profile. The PATCH is
// server-authorized (ADMIN) and audited; an email change revokes the
// teacher's sessions server-side so they re-authenticate with the new identity.
function EditTeacherDialog({
  teacher,
  onClose,
  onUpdated,
}: {
  teacher: TeacherRow | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    name: "",
    email: "",
    phone: "",
    specialty: "",
    bio: "",
  });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (teacher) {
      setForm({
        name: teacher.name || "",
        email: teacher.email || "",
        phone: teacher.phone || "",
        specialty: teacher.specialty || "",
        bio: teacher.bio || "",
      });
    }
  }, [teacher]);

  const submit = async () => {
    if (!teacher) return;
    if (!form.name.trim() || !form.email.trim()) {
      toast.error(tr("admin.026"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/teachers/${teacher.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          phone: form.phone.trim() || null,
          specialty: form.specialty.trim() || null,
          bio: form.bio.trim() || null,
        }),
      });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("admin.513"));
      onUpdated();
      onClose();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!teacher} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("admin.512")}</DialogTitle>
          <DialogDescription>{teacher?.name}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{tr("admin.019")}</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>{tr("admin.021")}</Label>
            <Input type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tr("admin.035")}</Label>
              <Input dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <Label>Specialty</Label>
              <Input value={form.specialty} onChange={(e) => setForm({ ...form, specialty: e.target.value })} />
            </div>
          </div>
          <div>
            <Label>Bio</Label>
            <Textarea value={form.bio} onChange={(e) => setForm({ ...form, bio: e.target.value })} rows={3} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("admin.038")}</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.044")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// 4. Groups
// ============================================================
type GroupRow = {
  id: string;
  name: string;
  courseId: string;
  courseName: string | null;
  courseColor: string | null;
  teacherId: string | null;
  teacherName: string | null;
  capacity: number;
  schedule: string;
  isActive: boolean;
  studentsCount: number;
  // Phase 26B — the group's audience (student school type). ARABIC | LANGUAGE,
  // or null while the group is still UNCLASSIFIED (fail-closed for students:
  // never listed, never enrollable, until an admin classifies it).
  trackScope: string | null;
};

function GroupsView() {
  const tr = useT();
  const [openAdd, setOpenAdd] = React.useState(false);
  const [selected, setSelected] = React.useState<GroupRow | null>(null);
  const { data, loading, error, reload } = useApi<{ groups: GroupRow[] }>("/api/admin/groups");

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.072")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.087")}</p>
        </div>
        <Button onClick={() => setOpenAdd(true)}>
          <Plus className="w-4 h-4 ms-2" />
          Create Group
        </Button>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-44 rounded-xl" />
          ))}
        </div>
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data || data.groups.length === 0 ? (
        <Card className="p-4">
          <EmptyBlock message={tr("admin.088")} />
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 stagger-in">
          {data.groups.map((g) => {
            const pct = g.capacity > 0 ? Math.min(100, (g.studentsCount / g.capacity) * 100) : 0;
            return (
              <Card
                key={g.id}
                className="p-4 card-hover cursor-pointer"
                onClick={() => setSelected(g)}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-sm font-bold truncate">{g.name}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {g.courseName || "—"}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    {/* Lifecycle state must be visible at a glance: a
                        deactivated group is hidden from students and closed
                        for new assignments. */}
                    {!g.isActive && (
                      <Badge variant="secondary" className="text-[10px]">
                        {tr("admin.298")}
                      </Badge>
                    )}
                    <div
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ background: g.courseColor || "#10b981" }}
                    />
                  </div>
                </div>
                <div className="mt-3 space-y-1.5">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Briefcase className="w-3.5 h-3.5" />
                    {g.teacherName || tr("admin.089")}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarDays className="w-3.5 h-3.5" />
                    {g.schedule}
                  </div>
                  <div className="flex items-center gap-2 text-xs">
                    <span className="text-muted-foreground">{tr("admin.318")}:</span>
                    <Badge
                      variant="outline"
                      className={
                        g.trackScope
                          ? "bg-teal-500/15 text-teal-700 dark:text-teal-300 border-teal-500/30"
                          : "bg-amber-500/15 text-amber-700 dark:text-amber-300 border-amber-500/30"
                      }
                    >
                      {g.trackScope === "ARABIC"
                        ? tr("admin.350")
                        : g.trackScope === "LANGUAGE"
                          ? tr("admin.351")
                          : tr("admin.319")}
                    </Badge>
                  </div>
                </div>
                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted-foreground">{tr("admin.010")}</span>
                    <span className="font-medium">
                      {g.studentsCount} / {g.capacity}
                    </span>
                  </div>
                  <Progress value={pct} className="h-1.5" />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <CreateGroupDialog open={openAdd} onOpenChange={setOpenAdd} onCreated={reload} />
      <ManageGroupDialog group={selected} onClose={() => setSelected(null)} onUpdated={reload} />
    </motion.div>
  );
}

function CreateGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    name: "",
    courseId: "",
    teacherId: "",
    capacity: 20,
    schedule: tr("admin.091"),
    // Phase 26B — the audience is an explicit, required choice (ARABIC or
    // LANGUAGE). Never inferred, never defaulted, SHARED not offered.
    trackScope: "",
  });
  const [courses, setCourses] = React.useState<{ id: string; nameAr: string; name?: string }[]>([]);
  const [teachers, setTeachers] = React.useState<{ id: string; name: string }[]>([]);
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      fetch("/api/admin/courses").then((r) => r.json()).then((d) => setCourses(d.courses || [])).catch(() => {});
      fetch("/api/admin/teachers").then((r) => r.json()).then((d) => setTeachers(d.teachers || [])).catch(() => {});
    }
  }, [open]);

  const submit = async () => {
    if (!form.name || !form.courseId) {
      toast.error(tr("admin.092"));
      return;
    }
    if (form.trackScope !== "ARABIC" && form.trackScope !== "LANGUAGE") {
      toast.error(tr("admin.320"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/groups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("admin.093"));
      onCreated();
      onOpenChange(false);
      setForm({ name: "", courseId: "", teacherId: "", capacity: 20, schedule: tr("admin.091"), trackScope: "" });
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("admin.096")}</DialogTitle>
          <DialogDescription>{tr("admin.097")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{tr("admin.098")}</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>{tr("admin.099")}</Label>
            <Select value={form.courseId} onValueChange={(v) => setForm({ ...form, courseId: v })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tr("admin.100")} />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{pickAuto(c.nameAr, c.name)}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{tr("admin.101")}</Label>
            <Select value={form.teacherId} onValueChange={(v) => setForm({ ...form, teacherId: v })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tr("admin.102")} />
              </SelectTrigger>
              <SelectContent>
                {teachers.map((t) => (
                  <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{tr("admin.318")}</Label>
            <Select value={form.trackScope} onValueChange={(v) => setForm({ ...form, trackScope: v })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder={tr("admin.318")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ARABIC">{tr("admin.350")}</SelectItem>
                <SelectItem value="LANGUAGE">{tr("admin.351")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground mt-1">{tr("admin.320")}</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tr("admin.103")}</Label>
              <Input
                type="number"
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label>{tr("admin.104")}</Label>
              <Input value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tr("admin.038")}</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.040")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ManageGroupDialog({
  group,
  onClose,
  onUpdated,
}: {
  group: GroupRow | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const tr = useT();
  const [teachers, setTeachers] = React.useState<{ id: string; name: string }[]>([]);
  const [teacherId, setTeacherId] = React.useState<string | undefined>();
  const [name, setName] = React.useState("");
  const [capacity, setCapacity] = React.useState(20);
  const [schedule, setSchedule] = React.useState("");
  // Phase 26B — the group's audience; "" means still UNCLASSIFIED (the server
  // keeps it unclassified until an explicit ARABIC/LANGUAGE choice is saved).
  const [trackScope, setTrackScope] = React.useState("");
  // Post-launch lifecycle — deactivation keeps all history but hides the
  // group from students and blocks new assignments (server-enforced).
  const [isActive, setIsActive] = React.useState(true);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [students, setStudents] = React.useState<StudentRow[]>([]);

  React.useEffect(() => {
    if (group) {
      setTeacherId(group.teacherId || undefined);
      setName(group.name || "");
      setCapacity(group.capacity);
      setSchedule(group.schedule);
      setTrackScope(group.trackScope || "");
      setIsActive(group.isActive);
      setConfirmDelete(false);
      fetch("/api/admin/teachers").then((r) => r.json()).then((d) => setTeachers(d.teachers || [])).catch(() => {});
      fetch("/api/admin/students").then((r) => r.json()).then((d) => {
        const all: StudentRow[] = d.students || [];
        setStudents(all.filter((s) => s.group?.id === group.id));
      }).catch(() => {});
    }
  }, [group]);

  const save = async () => {
    if (!group) return;
    if (!name.trim()) {
      toast.error(tr("admin.092"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          teacherId: teacherId || null,
          capacity,
          schedule,
          isActive,
          // Phase 26B — send the audience only once explicitly chosen; an
          // unclassified group stays unclassified otherwise. The server
          // refuses (409) an audience change that would strand members.
          ...(trackScope ? { trackScope } : {}),
        }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({} as any));
        throw new Error(j.error || "err");
      }
      toast.success(tr("admin.044"));
      onUpdated();
      onClose();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  // Hard delete — ONLY for an unused group. The server is the authority: it
  // refuses (409) when students or sessions reference the group and tells the
  // admin to deactivate instead. The confirmation dialog explains both.
  const doDelete = async () => {
    if (!group) return;
    try {
      const res = await fetch(`/api/admin/groups/${group.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        toast.error(j.error || tr("admin.001"));
        return;
      }
      toast.success(tr("admin.511"));
      setConfirmDelete(false);
      onUpdated();
      onClose();
    } catch {
      toast.error(tr("admin.001"));
    }
  };

  return (
    <Dialog open={!!group} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr("admin.110")}</DialogTitle>
          <DialogDescription>{group?.name}</DialogDescription>
        </DialogHeader>
        {group && (
          <div className="space-y-3">
            <div>
              <Label>{tr("admin.522")}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </div>
            <div>
              <Label>{tr("admin.318")}</Label>
              <Select value={trackScope} onValueChange={setTrackScope}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={tr("admin.319")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ARABIC">{tr("admin.350")}</SelectItem>
                  <SelectItem value="LANGUAGE">{tr("admin.351")}</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground mt-1">{tr("admin.320")}</p>
            </div>
            <div>
              <Label>{tr("admin.101")}</Label>
              <Select value={teacherId} onValueChange={setTeacherId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={tr("admin.102")} />
                </SelectTrigger>
                <SelectContent>
                  {teachers.map((t) => (
                    <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>{tr("admin.103")}</Label>
                <Input type="number" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
              </div>
              <div>
                <Label>{tr("admin.104")}</Label>
                <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>{tr("admin.115")}{students.length})</Label>
              <div className="max-h-40 overflow-y-auto rounded-lg border p-2 space-y-1">
                {students.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-3">{tr("admin.116")}</div>
                ) : (
                  students.map((s) => (
                    <div key={s.id} className="flex items-center justify-between text-xs px-2 py-1.5 rounded hover:bg-muted">
                      <span className="font-medium">{s.name}</span>
                      <span className="text-muted-foreground">{s.email}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* Lifecycle: deactivate keeps history, delete removes an unused
                group. Distinct controls with distinct semantics. */}
            <div className="rounded-lg border border-border/60 p-3 space-y-2">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-bold">{isActive ? tr("admin.299") : tr("admin.298")}</div>
                  <div className="text-[11px] text-muted-foreground">{tr("admin.518")}</div>
                </div>
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>
              <div className="border-t border-border/40 pt-2 flex items-center justify-between gap-2">
                <p className="text-[11px] text-muted-foreground leading-relaxed">
                  {tr("admin.510")}
                </p>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="text-destructive hover:text-destructive shrink-0"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="w-3.5 h-3.5 ms-1" />
                  {tr("admin.509")}
                </Button>
              </div>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("admin.117")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.119")}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Confirmation for the destructive action — separate from the edit
          dialog so a slip on "Save" can never delete anything. */}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={tr("admin.509")}
        description={
          <span>
            <span className="block font-semibold text-foreground mb-1">{group?.name}</span>
            {tr("admin.510")}
          </span>
        }
        confirmLabel={tr("admin.517")}
        cancelLabel={tr("admin.038")}
        onConfirm={doDelete}
      />
    </Dialog>
  );
}

// ============================================================
// 5. Courses (curriculum tree)
// ============================================================
type CourseRow = {
  id: string;
  slug: string;
  name: string;
  nameAr: string;
  description: string;
  color: string;
  partsCount: number;
  lessonsCount: number;
  activeLessonsCount?: number;
  groupsCount: number;
};

type TreeLesson = {
  id: string;
  titleAr: string;
  title?: string;
  curriculumStatus?: string;
  officialCode?: string | null;
};

type CourseTree = {
  id: string;
  nameAr: string;
  name?: string;
  parts: {
    id: string;
    titleAr: string;
    title?: string;
    units: {
      id: string;
      titleAr: string;
      title?: string;
      lessons?: TreeLesson[];
      topics: {
        id: string;
        titleAr: string;
        title?: string;
        lessons: TreeLesson[];
      }[];
    }[];
  }[];
};

function CoursesView() {
  const tr = useT();
  const { data, loading, error, reload } = useApi<{ courses: CourseRow[] }>("/api/admin/courses");
  const [tree, setTree] = React.useState<CourseTree | null>(null);
  const [treeLoading, setTreeLoading] = React.useState(false);
  const [reconciling, setReconciling] = React.useState(false);
  const [openAdd, setOpenAdd] = React.useState(false);
  // Post-launch lifecycle: metadata edit + guarded delete of an EMPTY course
  // (the server refuses while groups/parts/enrollments/exams reference it).
  const [editingCourse, setEditingCourse] = React.useState<CourseRow | null>(null);
  const [deletingCourse, setDeletingCourse] = React.useState<CourseRow | null>(null);

  const deleteCourse = async (c: CourseRow) => {
    try {
      const res = await fetch(`/api/admin/courses/${c.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        toast.error(j.error || tr("admin.001"));
        return;
      }
      toast.success(tr("admin.527"));
      setDeletingCourse(null);
      reload();
    } catch {
      toast.error(tr("admin.001"));
    }
  };

  const openTree = async (id: string) => {
    setTreeLoading(true);
    try {
      const res = await fetch(`/api/admin/courses?id=${id}`);
      const j = await res.json();
      setTree(j.course || null);
    } catch {
      toast.error(tr("admin.001"));
    } finally {
      setTreeLoading(false);
    }
  };

  // Phase 11: the legacy `{ action: "seed" }` footgun is retired (410) —
  // this button idempotently reconciles the DB with the official curriculum
  // (knowledge-model.json), archiving legacy rows instead of deleting them.
  const reconcileNow = async () => {
    setReconciling(true);
    try {
      const res = await fetch("/api/admin/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "reconcile-official" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || tr("admin.121"));
      const report = j.report || {};
      toast.success(
        tr("admin.320", {
          p1: report.officialLessonCodes?.length ?? 0,
          p2: report.archivedLessonIds?.length ?? 0,
        })
      );
      reload();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setReconciling(false);
    }
  };

  // One lesson badge for both chains: archived lessons are dimmed and tagged
  // (admins see the full catalogue), official lessons carry their code.
  const lessonBadge = (l: TreeLesson) => {
    const archived = l.curriculumStatus === "ARCHIVED";
    return (
      <Badge
        key={l.id}
        variant="outline"
        className={archived ? "text-[10px] opacity-60" : "text-[10px]"}
        title={archived ? tr("admin.321") : undefined}
      >
        {l.officialCode ? `${l.officialCode} · ` : ""}
        {pickAuto(l.titleAr, l.title)}
        {archived ? ` (${tr("admin.321")})` : ""}
      </Badge>
    );
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.125")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.126")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={reconcileNow} disabled={reconciling}>
            {reconciling ? <Loader2 className="w-4 h-4 ms-2 animate-spin" /> : <Download className="w-4 h-4 ms-2" />}
            {reconciling ? tr("admin.319") : tr("admin.318")}
          </Button>
          <Button size="sm" onClick={() => setOpenAdd(true)}>
            <Plus className="w-4 h-4 ms-2" />
            Add Course
          </Button>
        </div>
      </div>
      <AddCourseDialog open={openAdd} onOpenChange={setOpenAdd} onCreated={reload} />

      {loading ? (
        <LoadingBlock rows={3} />
      ) : error ? (
        <ErrorBlock message={error} onRetry={reload} />
      ) : !data || data.courses.length === 0 ? (
        <Card className="p-6 text-center">
          <EmptyBlock message={tr("admin.129")} />
          <Button className="mt-4" onClick={reconcileNow} disabled={reconciling}>
            {reconciling ? <Loader2 className="w-4 h-4 ms-2 animate-spin" /> : <Download className="w-4 h-4 ms-2" />}
            {reconciling ? tr("admin.319") : tr("admin.318")}
          </Button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 stagger-in">
          {data.courses.map((c) => (
            <Card key={c.id} className="p-4 card-hover">
              <div className="flex items-start gap-3">
                <div
                  className="w-12 h-12 rounded-xl flex items-center justify-center shrink-0"
                  style={{ background: `${c.color}20`, color: c.color }}
                >
                  <BookOpen className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-base font-bold truncate">{pickAuto(c.nameAr, c.name)}</div>
                  <div className="text-xs text-muted-foreground">{c.name}</div>
                  <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{c.description}</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-4 text-center">
                <div className="rounded-lg border p-2">
                  <div className="text-lg font-bold text-primary">{c.partsCount}</div>
                  <div className="text-[10px] text-muted-foreground">Parts</div>
                </div>
                <div className="rounded-lg border p-2">
                  <div className="text-lg font-bold text-primary">
                    {c.activeLessonsCount ?? c.lessonsCount}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Lessons
                    {c.activeLessonsCount !== undefined &&
                      c.activeLessonsCount !== c.lessonsCount && (
                        <span> ({c.lessonsCount} total)</span>
                      )}
                  </div>
                </div>
                <div className="rounded-lg border p-2">
                  <div className="text-lg font-bold text-primary">{c.groupsCount}</div>
                  <div className="text-[10px] text-muted-foreground">Groups</div>
                </div>
              </div>
              <div className="flex items-center gap-2 mt-4">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => openTree(c.id)}
                >
                  <BookOpen className="w-4 h-4 ms-2" />
                  {tr("admin.132")}<ChevronLeft className="w-3.5 h-3.5 me-1 flip-rtl" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setEditingCourse(c)}
                  title={tr("admin.523")}
                  aria-label={tr("admin.523")}
                >
                  <PencilLine className="w-4 h-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-destructive hover:text-destructive"
                  onClick={() => setDeletingCourse(c)}
                  title={tr("admin.525")}
                  aria-label={tr("admin.525")}
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Course metadata edit */}
      <EditCourseDialog
        course={editingCourse}
        onClose={() => setEditingCourse(null)}
        onUpdated={reload}
      />

      {/* Guarded course delete (empty courses only — server is authority) */}
      <ConfirmDialog
        open={!!deletingCourse}
        onOpenChange={(v) => !v && setDeletingCourse(null)}
        title={tr("admin.525")}
        description={
          <span>
            <span className="block font-semibold text-foreground mb-1">
              {deletingCourse ? pickAuto(deletingCourse.nameAr, deletingCourse.name) : ""}
            </span>
            {tr("admin.526")}
          </span>
        }
        confirmLabel={tr("admin.517")}
        cancelLabel={tr("admin.038")}
        onConfirm={async () => {
          if (deletingCourse) await deleteCourse(deletingCourse);
        }}
      />

      <Dialog open={!!tree} onOpenChange={(v) => !v && setTree(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{pickAuto(tree?.nameAr, tree?.name)}</DialogTitle>
            <DialogDescription>{tr("admin.133")}</DialogDescription>
          </DialogHeader>
          {treeLoading ? (
            <LoadingBlock rows={4} />
          ) : tree ? (
            <ScrollArea className="min-h-0" viewportClassName="max-h-[60vh] overscroll-contain pe-2">
              <div className="space-y-3">
                {tree.parts.map((p) => (
                  <details key={p.id} className="rounded-lg border" open>
                    <summary className="px-3 py-2 text-sm font-bold cursor-pointer hover:bg-muted/50 rounded-lg">
                      {pickAuto(p.titleAr, p.title)}
                    </summary>
                    <div className="px-3 pb-3 space-y-2">
                      {p.units.map((u) => (
                        <details key={u.id} className="rounded-md border bg-muted/30">
                          <summary className="px-3 py-2 text-xs font-semibold cursor-pointer">
                            {pickAuto(u.titleAr, u.title)}
                          </summary>
                          <div className="px-3 pb-2 space-y-1.5">
                            {(u.lessons || []).length > 0 && (
                              <div className="rounded-md border bg-card p-2">
                                <div className="text-xs font-medium mb-1">{tr("admin.322")}</div>
                                <div className="flex flex-wrap gap-1">
                                  {(u.lessons || []).map(lessonBadge)}
                                </div>
                              </div>
                            )}
                            {u.topics.map((t) => (
                              <div key={t.id} className="rounded-md border bg-card p-2">
                                <div className="text-xs font-medium mb-1">{pickAuto(t.titleAr, t.title)}</div>
                                <div className="flex flex-wrap gap-1">
                                  {t.lessons.map(lessonBadge)}
                                  {t.lessons.length === 0 && (
                                    <span className="text-[10px] text-muted-foreground">{tr("admin.134")}</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </details>
                      ))}
                    </div>
                  </details>
                ))}
              </div>
            </ScrollArea>
          ) : (
            <EmptyBlock message={tr("admin.135")} />
          )}
        </DialogContent>
      </Dialog>
    </motion.div>
  );
}

function AddCourseDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    name: "",
    nameAr: "",
    description: "",
    color: "#10b981",
  });
  const [saving, setSaving] = React.useState(false);

  const submit = async () => {
    if (!form.name.trim() || !form.nameAr.trim()) {
      toast.error(tr("admin.136"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/admin/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || tr("admin.003"));
      toast.success(tr("admin.138"));
      onCreated();
      onOpenChange(false);
      setForm({ name: "", nameAr: "", description: "", color: "#10b981" });
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("admin.140")}</DialogTitle>
          <DialogDescription>{tr("admin.141")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{tr("admin.142")}</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Programming & AI"
            />
          </div>
          <div>
            <Label>{tr("admin.143")}</Label>
            <Input
              value={form.nameAr}
              onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
              placeholder={tr("admin.144")}
            />
          </div>
          <div>
            <Label>{tr("admin.145")}</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder={tr("admin.146")}
            />
          </div>
          <div>
            <Label>{tr("admin.147")}</Label>
            <Input
              type="color"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
              className="h-10 w-20 p-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tr("admin.038")}</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.040")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Post-launch lifecycle — edit course metadata (name/nameAr/description/color).
// Structure (parts/lessons) stays reconciler-owned; the slug is not editable.
function EditCourseDialog({
  course,
  onClose,
  onUpdated,
}: {
  course: CourseRow | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({ name: "", nameAr: "", description: "", color: "#10b981" });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (course) {
      setForm({
        name: course.name || "",
        nameAr: course.nameAr || "",
        description: course.description || "",
        color: course.color || "#10b981",
      });
    }
  }, [course]);

  const submit = async () => {
    if (!course) return;
    if (!form.name.trim() || !form.nameAr.trim()) {
      toast.error(tr("admin.136"));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/courses/${course.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("admin.524"));
      onUpdated();
      onClose();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!course} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{tr("admin.523")}</DialogTitle>
          <DialogDescription>{course ? pickAuto(course.nameAr, course.name) : ""}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{tr("admin.142")}</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>{tr("admin.143")}</Label>
            <Input value={form.nameAr} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} />
          </div>
          <div>
            <Label>{tr("admin.145")}</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
            />
          </div>
          <div>
            <Label>{tr("admin.147")}</Label>
            <Input
              type="color"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
              className="h-10 w-20 p-1"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("admin.038")}</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.044")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// 6. Question Bank
// ============================================================
type QuestionRow = {
  id: string;
  type: "MCQ" | "TRUE_FALSE";
  prompt: string;
  promptAr: string | null;
  options: string;
  answer: string;
  explanation: string | null;
  difficulty: "EASY" | "MEDIUM" | "HARD";
  marks: number;
  schoolType?: "ARABIC" | "LANGUAGE" | null;
  quiz: { title: string; titleAr: string | null; lesson: { titleAr: string; title?: string } | null } | null;
};

/**
 * Question-bank views. A bank shows its own questions PLUS the shared
 * (untagged) ones, matching exactly the pool a mock exam of that type draws
 * from — so what the admin sees is what students will get.
 */
const BANK_TABS = [
  { value: "ARABIC", labelKey: "admin.200" },
  { value: "LANGUAGE", labelKey: "admin.201" },
  { value: "shared", labelKey: "admin.231" },
  { value: "all", labelKey: "admin.230" },
] as const;

function QuestionBankView() {
  const tr = useT();
  const [search, setSearch] = React.useState("");
  const [difficulty, setDifficulty] = React.useState("all");
  const [type, setType] = React.useState("all");
  const [bank, setBank] = React.useState<string>("ARABIC");
  const [openAdd, setOpenAdd] = React.useState(false);
  const [showAiGen, setShowAiGen] = React.useState(false);
  // Phase 15: the session detail deep-links here with the lesson id, so AI
  // generation starts preselected on the session the admin came from.
  const bankNavParam = useApp((s) => s.navParam);
  const [aiLesson, setAiLesson] = React.useState(bankNavParam || "");
  const [aiCount, setAiCount] = React.useState("5");
  const [aiDifficulty, setAiDifficulty] = React.useState("MIXED");
  const [aiGenerating, setAiGenerating] = React.useState(false);
  const [lessons, setLessons] = React.useState<any[]>([]);

  React.useEffect(() => {
    // NOTE: tree=1 is required — without it the API omits parts/units/topics/lessons.
    fetch("/api/admin/courses?tree=1")
      .then((r) => r.json())
      .then((d) => {
        // Both chains: canonical unit lessons AND legacy topic lessons.
        // Archived lessons are skipped (the API would 410 them anyway) and
        // dual-linked lessons are deduped by id.
        const all: any[] = [];
        const seen = new Set<string>();
        const pushLesson = (l: any, u: any) => {
          if (!l || seen.has(l.id) || l.curriculumStatus === "ARCHIVED") return;
          seen.add(l.id);
          all.push({
            id: l.id,
            title: `${pickAuto(l.titleAr, l.title)} — ${pickAuto(u.titleAr, u.title)}`,
          });
        };
        for (const c of d.courses || []) {
          for (const p of c.parts || []) {
            for (const u of p.units || []) {
              for (const l of u.lessons || []) pushLesson(l, u);
              for (const t of u.topics || []) {
                for (const l of t.lessons || []) pushLesson(l, u);
              }
            }
          }
        }
        setLessons(all);
      })
      .catch(() => {});
  }, []);

  const generateAi = async () => {
    if (!aiLesson) {
      toast.error(tr("admin.151"));
      return;
    }
    setAiGenerating(true);
    try {
      const r = await fetch("/api/admin/ai-generate-quiz", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lessonId: aiLesson,
          count: parseInt(aiCount, 10),
          difficulty: aiDifficulty,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || tr("admin.152"));
        return;
      }
      toast.success(tr("admin.153", { p1: d.generated }));
      setShowAiGen(false);
      reload();
    } catch {
      toast.error(tr("admin.154"));
    } finally {
      setAiGenerating(false);
    }
  };

  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (difficulty !== "all") params.set("difficulty", difficulty);
    if (type !== "all") params.set("type", type);
    if (bank !== "all") params.set("schoolType", bank);
    return `/api/admin/question-bank?${params.toString()}`;
  }, [search, difficulty, type, bank]);

  const { data, loading, error, reload } = useApi<{
    questions: QuestionRow[];
    counts: { ARABIC: number; LANGUAGE: number; SHARED: number };
  }>(query, [search, difficulty, type, bank]);

  // Post-launch lifecycle: a question the admin created must also be
  // editable/removable — with the SAME frozen-history guards the teacher
  // route enforces (server-side; refusals are surfaced verbatim).
  const [editingQ, setEditingQ] = React.useState<QuestionRow | null>(null);
  const [deletingQ, setDeletingQ] = React.useState<QuestionRow | null>(null);

  const deleteQuestion = async (q: QuestionRow) => {
    try {
      const res = await fetch(`/api/admin/question-bank/${q.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) {
        toast.error(j.error || tr("admin.001"));
        return;
      }
      toast.success(tr("admin.532"));
      setDeletingQ(null);
      reload();
    } catch {
      toast.error(tr("admin.001"));
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">Question Bank</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.155")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowAiGen((s) => !s)}
            className="border-primary/30 text-primary hover:bg-primary/5"
          >
            <Sparkles className="w-4 h-4 ms-2" />
            AI Generate
          </Button>
          <Button onClick={() => setOpenAdd(true)}>
            <Plus className="w-4 h-4 ms-2" />
            Add Question
          </Button>
        </div>
      </div>

      {/* AI Generation Panel */}
      <AnimatePresence>
        {showAiGen && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <Card className="glass border-primary/20 overflow-hidden">
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-teal-500 to-amber-500" />
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Sparkles className="w-5 h-5 text-primary" />
                  AI Quiz Generation
                </CardTitle>
                <CardDescription className="text-xs">
                  {tr("admin.156")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label className="text-xs">{tr("admin.157")}</Label>
                  <Select value={aiLesson} onValueChange={setAiLesson}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder={tr("admin.158")} />
                    </SelectTrigger>
                    <SelectContent className="max-h-60">
                      {lessons.map((l) => (
                        <SelectItem key={l.id} value={l.id}>
                          {l.title}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label className="text-xs">{tr("admin.159")}</Label>
                    <Select value={aiCount} onValueChange={setAiCount}>
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="3">{tr("admin.160")}</SelectItem>
                        <SelectItem value="5">{tr("admin.161")}</SelectItem>
                        <SelectItem value="7">{tr("admin.162")}</SelectItem>
                        <SelectItem value="10">{tr("admin.163")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">{tr("admin.164")}</Label>
                    <Select value={aiDifficulty} onValueChange={setAiDifficulty}>
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MIXED">{tr("admin.165")}</SelectItem>
                        <SelectItem value="EASY">{tr("admin.166")}</SelectItem>
                        <SelectItem value="MEDIUM">{tr("admin.167")}</SelectItem>
                        <SelectItem value="HARD">{tr("admin.168")}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="flex items-center gap-2 pt-2">
                  <Button
                    onClick={generateAi}
                    disabled={aiGenerating || !aiLesson}
                    className="bg-gradient-to-r from-primary to-teal-500"
                  >
                    {aiGenerating ? (
                      <>
                        <Loader2 className="w-4 h-4 ms-2 animate-spin" />
                        {tr("admin.169")}</>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 ms-2" />
                        {tr("admin.170")}</>
                    )}
                  </Button>
                  <Button variant="ghost" onClick={() => setShowAiGen(false)}>
                    {tr("admin.038")}</Button>
                </div>
                {aiGenerating && (
                  <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 text-xs text-muted-foreground">
                    {tr("admin.172")}</div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <Card className="p-4">
        {/* Question-bank selector (Arabic school / Language school / shared). */}
        <div
          role="tablist"
          aria-label={tr("admin.216")}
          className="flex flex-wrap items-center gap-2 mb-4 border-b border-border/60 pb-3"
        >
          {BANK_TABS.map((tab) => {
            const active = bank === tab.value;
            const count =
              tab.value === "ARABIC"
                ? data?.counts?.ARABIC
                : tab.value === "LANGUAGE"
                  ? data?.counts?.LANGUAGE
                  : tab.value === "shared"
                    ? data?.counts?.SHARED
                    : undefined;
            return (
              <button
                key={tab.value}
                role="tab"
                type="button"
                aria-selected={active}
                onClick={() => setBank(tab.value)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                  active
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "bg-muted/50 text-muted-foreground hover:bg-muted"
                }`}
              >
                <span>{tr(tab.labelKey)}</span>
                {typeof count === "number" && (
                  <span
                    className={`rounded-full px-1.5 py-0.5 text-[10px] tabular-nums ${
                      active ? "bg-primary-foreground/20" : "bg-background"
                    }`}
                  >
                    {count}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap gap-3 mb-4">
          <div className="field-with-icon relative flex-1 min-w-[200px]">
            <span className="field-icon">
              <Search className="w-4 h-4" />
            </span>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr("admin.173")}
            />
          </div>
          <Select value={difficulty} onValueChange={setDifficulty}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={tr("admin.016")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("admin.175")}</SelectItem>
              <SelectItem value="EASY">Easy</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
              <SelectItem value="HARD">Hard</SelectItem>
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder={tr("admin.016")} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("admin.177")}</SelectItem>
              <SelectItem value="MCQ">MCQ</SelectItem>
              <SelectItem value="TRUE_FALSE">True / False</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : !data || data.questions.length === 0 ? (
          <EmptyBlock message={tr("admin.178")} />
        ) : (
          <ScrollArea className="min-h-0" viewportClassName="max-h-[60vh] overscroll-contain">
            <div className="space-y-2">
              {data.questions.map((q) => {
                const options = (() => {
                  try { return JSON.parse(q.options) as string[]; } catch { return []; }
                })();
                return (
                  <div key={q.id} className="rounded-lg border p-3 hover:bg-muted/30 transition-colors">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium">
                          {pickAuto(q.promptAr, q.prompt)}
                        </div>
                        {q.promptAr && (
                          <div className="text-xs text-muted-foreground mt-0.5">{q.prompt}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 shrink-0">
                        {difficultyBadge(q.difficulty)}
                        <Badge variant="outline" className="text-[10px]">{q.type}</Badge>
                        <Badge variant="secondary" className="text-[10px]">
                          {q.schoolType === "ARABIC"
                            ? tr("admin.200")
                            : q.schoolType === "LANGUAGE"
                              ? tr("admin.201")
                              : tr("admin.231")}
                        </Badge>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7"
                          onClick={() => setEditingQ(q)}
                          title={tr("admin.528")}
                          aria-label={tr("admin.528")}
                        >
                          <PencilLine className="w-3.5 h-3.5" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          className="h-7 w-7 text-destructive hover:text-destructive"
                          onClick={() => setDeletingQ(q)}
                          title={tr("admin.530")}
                          aria-label={tr("admin.530")}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                    {options.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-2">
                        {options.map((opt, i) => (
                          <span
                            key={i}
                            className={`text-[10px] px-1.5 py-0.5 rounded border ${
                              String(i) === q.answer
                                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border-emerald-500/30"
                                : "bg-muted text-muted-foreground border-border"
                            }`}
                          >
                            {i + 1}. {opt}
                          </span>
                        ))}
                      </div>
                    )}
                    {q.quiz && (
                      <div className="text-[10px] text-muted-foreground mt-2 flex items-center gap-1">
                        <Library className="w-3 h-3" />
                        {pickAuto(q.quiz.titleAr, q.quiz.title)}
                        {q.quiz.lesson && ` · ${pickAuto(q.quiz.lesson.titleAr, q.quiz.lesson.title)}`}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </Card>

      <AddQuestionDialog open={openAdd} onOpenChange={setOpenAdd} onCreated={reload} />

      {/* Post-launch lifecycle: edit + guarded delete of a bank question. */}
      <EditQuestionDialog
        question={editingQ}
        onClose={() => setEditingQ(null)}
        onUpdated={reload}
      />
      <ConfirmDialog
        open={!!deletingQ}
        onOpenChange={(v) => !v && setDeletingQ(null)}
        title={tr("admin.530")}
        description={
          <span>
            <span className="block font-semibold text-foreground mb-1">
              {deletingQ ? pickAuto(deletingQ.promptAr, deletingQ.prompt) : ""}
            </span>
            {tr("admin.531")}
          </span>
        }
        confirmLabel={tr("admin.517")}
        cancelLabel={tr("admin.038")}
        onConfirm={async () => {
          if (deletingQ) await deleteQuestion(deletingQ);
        }}
      />
    </motion.div>
  );
}

function AddQuestionDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    prompt: "",
    promptAr: "",
    type: "MCQ",
    difficulty: "MEDIUM",
    answer: "0",
    options: ["", "", "", ""],
    explanation: "",
    marks: 1,
    // "" = shared question (usable by both banks).
    schoolType: "",
  });
  const [saving, setSaving] = React.useState(false);

  const updateOption = (i: number, v: string) => {
    const next = [...form.options];
    next[i] = v;
    setForm({ ...form, options: next });
  };

  const submit = async () => {
    if (!form.prompt) {
      toast.error(tr("admin.179"));
      return;
    }
    if (form.type === "MCQ" && form.options.filter((o) => o.trim()).length < 2) {
      toast.error(tr("admin.180"));
      return;
    }
    setSaving(true);
    try {
      const body: any = {
        prompt: form.prompt,
        promptAr: form.promptAr || null,
        type: form.type,
        difficulty: form.difficulty,
        explanation: form.explanation || null,
        marks: Number(form.marks),
        // null => shared question, available to both question banks.
        schoolType: form.schoolType || null,
      };
      if (form.type === "TRUE_FALSE") {
        body.answer = form.answer;
      } else {
        body.options = form.options.filter((o) => o.trim());
        body.answer = form.answer;
      }
      const res = await fetch("/api/admin/question-bank", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("admin.181"));
      onCreated();
      onOpenChange(false);
      setForm({
        prompt: "",
        promptAr: "",
        type: "MCQ",
        difficulty: "MEDIUM",
        answer: "0",
        options: ["", "", "", ""],
        explanation: "",
        marks: 1,
        schoolType: "",
      });
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr("admin.183")}</DialogTitle>
          <DialogDescription>{tr("admin.184")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{tr("admin.185")}</Label>
            <Textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={2} />
          </div>
          <div>
            <Label>{tr("admin.186")}</Label>
            <Textarea value={form.promptAr} onChange={(e) => setForm({ ...form, promptAr: e.target.value })} rows={2} />
          </div>
          {/* Which question bank this question belongs to. Left empty the
              question is SHARED and both Arabic and Language exams may use it. */}
          <div>
            <Label>{tr("admin.216")}</Label>
            <Select
              value={form.schoolType || "SHARED"}
              onValueChange={(v) =>
                setForm({ ...form, schoolType: v === "SHARED" ? "" : v })
              }
            >
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="SHARED">{tr("admin.231")}</SelectItem>
                <SelectItem value="ARABIC">{tr("admin.200")}</SelectItem>
                <SelectItem value="LANGUAGE">{tr("admin.201")}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tr("admin.187")}</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="MCQ">MCQ</SelectItem>
                  <SelectItem value="TRUE_FALSE">True / False</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{tr("admin.164")}</Label>
              <Select value={form.difficulty} onValueChange={(v) => setForm({ ...form, difficulty: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="EASY">Easy</SelectItem>
                  <SelectItem value="MEDIUM">Medium</SelectItem>
                  <SelectItem value="HARD">Hard</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.type === "MCQ" ? (
            <div>
              <Label>{tr("admin.189")}</Label>
              <div className="space-y-2">
                {form.options.map((opt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="correct"
                      checked={form.answer === String(i)}
                      onChange={() => setForm({ ...form, answer: String(i) })}
                      className="w-4 h-4"
                    />
                    <Input
                      value={opt}
                      onChange={(e) => updateOption(i, e.target.value)}
                      placeholder={`Option ${i + 1}`}
                    />
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div>
              <Label>{tr("admin.190")}</Label>
              <Select value={form.answer} onValueChange={(v) => setForm({ ...form, answer: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">True</SelectItem>
                  <SelectItem value="1">False</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div>
            <Label>{tr("admin.191")}</Label>
            <Textarea value={form.explanation} onChange={(e) => setForm({ ...form, explanation: e.target.value })} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{tr("admin.038")}</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.040")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Post-launch lifecycle — edit an existing question. PATCH is server-authorized
// (ADMIN) and honours the SAME frozen-attempt locks as the teacher route:
// grading-relevant fields are refused (409) while any attempt references the
// question; prompt/explanation/difficulty stay editable.
function EditQuestionDialog({
  question,
  onClose,
  onUpdated,
}: {
  question: QuestionRow | null;
  onClose: () => void;
  onUpdated: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    prompt: "",
    promptAr: "",
    type: "MCQ",
    difficulty: "MEDIUM",
    answer: "0",
    options: ["", "", "", ""],
    explanation: "",
    marks: 1,
    schoolType: "",
  });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (question) {
      let opts: string[] = [];
      try {
        const parsed = JSON.parse(question.options);
        if (Array.isArray(parsed)) opts = parsed.map((o) => String(o));
      } catch {
        opts = [];
      }
      setForm({
        prompt: question.prompt || "",
        promptAr: question.promptAr || "",
        type: question.type || "MCQ",
        difficulty: question.difficulty || "MEDIUM",
        answer: String(question.answer ?? "0"),
        options: opts.length ? [...opts, "", "", ""].slice(0, 4) : ["", "", "", ""],
        explanation: question.explanation || "",
        marks: question.marks ?? 1,
        schoolType: question.schoolType || "",
      });
    }
  }, [question]);

  const updateOption = (i: number, v: string) => {
    const next = [...form.options];
    next[i] = v;
    setForm({ ...form, options: next });
  };

  const submit = async () => {
    if (!question) return;
    if (!form.prompt.trim()) {
      toast.error(tr("admin.179"));
      return;
    }
    if (form.type === "MCQ" && form.options.filter((o) => o.trim()).length < 2) {
      toast.error(tr("admin.180"));
      return;
    }
    setSaving(true);
    try {
      const body: any = {
        prompt: form.prompt,
        promptAr: form.promptAr || null,
        type: form.type,
        difficulty: form.difficulty,
        explanation: form.explanation || null,
        marks: Number(form.marks),
        // Explicit decision — "" means shared (null); the server never infers.
        schoolType: form.schoolType || null,
      };
      if (form.type === "TRUE_FALSE") {
        body.answer = form.answer;
      } else {
        body.options = form.options.filter((o) => o.trim());
        body.answer = form.answer;
      }
      const res = await fetch(`/api/admin/question-bank/${question.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await res.json().catch(() => ({} as any));
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("admin.529"));
      onUpdated();
      onClose();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!question} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr("admin.528")}</DialogTitle>
          <DialogDescription>{tr("admin.531")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>{tr("admin.185")}</Label>
            <Textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={2} />
          </div>
          <div>
            <Label>{tr("admin.186")}</Label>
            <Textarea value={form.promptAr} onChange={(e) => setForm({ ...form, promptAr: e.target.value })} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tr("admin.187")}</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="MCQ">MCQ</SelectItem>
                  <SelectItem value="TRUE_FALSE">True / False</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{tr("admin.164")}</Label>
              <Select value={form.difficulty} onValueChange={(v) => setForm({ ...form, difficulty: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="EASY">Easy</SelectItem>
                  <SelectItem value="MEDIUM">Medium</SelectItem>
                  <SelectItem value="HARD">Hard</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          {form.type === "MCQ" && (
            <div className="space-y-2">
              <Label>{tr("admin.189")}</Label>
              {form.options.map((opt, i) => (
                <div key={i} className="flex items-center gap-2">
                  <input
                    type="radio"
                    name="edit-answer"
                    checked={form.answer === String(i)}
                    onChange={() => setForm({ ...form, answer: String(i) })}
                  />
                  <Input value={opt} onChange={(e) => updateOption(i, e.target.value)} />
                </div>
              ))}
            </div>
          )}
          {form.type === "TRUE_FALSE" && (
            <div>
              <Label>{tr("admin.190")}</Label>
              <Select value={form.answer} onValueChange={(v) => setForm({ ...form, answer: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="0">True</SelectItem>
                  <SelectItem value="1">False</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>{tr("admin.533")}</Label>
              <Input
                type="number"
                min={1}
                value={form.marks}
                onChange={(e) => setForm({ ...form, marks: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label>{tr("admin.231")}</Label>
              <Select value={form.schoolType || "shared"} onValueChange={(v) => setForm({ ...form, schoolType: v === "shared" ? "" : v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="shared">{tr("admin.231")}</SelectItem>
                  <SelectItem value="ARABIC">{tr("admin.200")}</SelectItem>
                  <SelectItem value="LANGUAGE">{tr("admin.201")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <div>
            <Label>{tr("admin.191")}</Label>
            <Textarea value={form.explanation} onChange={(e) => setForm({ ...form, explanation: e.target.value })} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("admin.038")}</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.044")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// 7. Payments — Phase 25 PR3 review workflow
// ============================================================
// The queue is a READ projection of the PR1 ledger; every decision goes through
// the PR2b API via the review drawer (src/components/admin/payment-review-drawer.tsx).
// This view adds the columns an operator needs to triage (sender phone,
// requested plan/group, duplicate-reference and newer-request warnings) and
// routes every approve/reject through the drawer, which is the only place the
// decision endpoints are called.
function PaymentsView() {
  const tr = useT();
  const [status, setStatus] = React.useState("all");
  const [showImport, setShowImport] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState<any>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // The drawer reads the CURRENT row from the loaded queue (by id), so a
  // post-decision reload refreshes the open drawer instead of leaving a stale
  // object on screen — and a vanished row closes it.
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    return `/api/admin/payments?${params.toString()}`;
  }, [status]);
  const { data, loading, error, reload } = useApi<{ payments: AdminPaymentRow[] }>(query, [status]);
  const selected = React.useMemo(
    () => data?.payments.find((p) => p.id === selectedId) ?? null,
    [data, selectedId]
  );

  const handleImport = async (file: File) => {
    setImporting(true);
    setImportResult(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const r = await fetch("/api/admin/payments/import", {
        method: "POST",
        body: formData,
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || tr("admin.195"));
        return;
      }
      setImportResult(d);
      toast.success(tr("admin.196", { p1: d.created }));
      reload();
    } catch {
      toast.error(tr("admin.197"));
    } finally {
      setImporting(false);
    }
  };

  const downloadTemplate = async () => {
    const r = await fetch("/api/admin/payments/import");
    const blob = await r.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "payments-template.xlsx";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{tr("shell.011")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.payments.subtitle")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowImport((s) => !s)}
            className="border-primary/30 text-primary hover:bg-primary/5"
          >
            <Upload className="w-4 h-4 ms-2" />
            {tr("pay.importBtn")}</Button>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("admin.016")}</SelectItem>
              <SelectItem value="PENDING">Pending</SelectItem>
              <SelectItem value="APPROVED">Approved</SelectItem>
              <SelectItem value="REJECTED">Rejected</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Bulk Import Panel */}
      <AnimatePresence>
        {showImport && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <Card className="glass border-primary/20 overflow-hidden">
              <div className="absolute inset-x-0 top-0 h-1 bg-gradient-to-r from-primary via-teal-500 to-amber-500" />
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Upload className="w-5 h-5 text-primary" />
                  {tr("pay.importTitle")}</CardTitle>
                <CardDescription className="text-xs">
                  {tr("pay.importDesc")}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex items-center gap-3">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".xlsx,.xls"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleImport(f);
                    }}
                    className="hidden"
                  />
                  <Button
                    onClick={() => fileInputRef.current?.click()}
                    disabled={importing}
                    className="bg-gradient-to-r from-primary to-teal-500"
                  >
                    {importing ? (
                      <>
                        <Loader2 className="w-4 h-4 ms-2 animate-spin" />
                        {tr("pay.importing")}</>
                    ) : (
                      <>
                        <Upload className="w-4 h-4 ms-2" />
                        {tr("pay.chooseFile")}</>
                    )}
                  </Button>
                  <Button variant="outline" onClick={downloadTemplate}>
                    <Download className="w-4 h-4 ms-2" />
                    {tr("pay.downloadTemplate")}</Button>
                  <Button variant="ghost" onClick={() => setShowImport(false)}>
                    {tr("admin.038")}</Button>
                </div>

                {importResult && (
                  <motion.div
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="rounded-xl bg-emerald-500/10 border border-emerald-400/30 p-4"
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                      <span className="font-bold text-emerald-700 dark:text-emerald-400">
                        {tr("pay.importResults")}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <div className="text-2xl font-bold text-emerald-600">
                          {importResult.created}
                        </div>
                        <div className="text-xs text-muted-foreground">{tr("pay.imported")}</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-amber-600">
                          {importResult.failed}
                        </div>
                        <div className="text-xs text-muted-foreground">{tr("pay.failed")}</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-muted-foreground">
                          {importResult.total}
                        </div>
                        <div className="text-xs text-muted-foreground">{tr("pay.totalRows")}</div>
                      </div>
                    </div>
                    {importResult.results?.some((r: any) => r.status === "failed") && (
                      <div className="mt-3 space-y-1 max-h-32 overflow-y-auto">
                        {importResult.results
                          .filter((r: any) => r.status === "failed")
                          .map((r: any, i: number) => (
                            <div key={i} className="text-xs text-destructive">
                              {tr("pay.row")}{r.row}: {r.userEmail} — {r.error}
                            </div>
                          ))}
                      </div>
                    )}
                  </motion.div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <Card className="p-4">
        {loading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : !data || data.payments.length === 0 ? (
          <EmptyBlock message={tr("pay.empty")} />
        ) : (
          <div className="max-h-[70vh] overflow-auto" data-testid="payments-queue">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("pay.colUser")}</TableHead>
                  <TableHead>{tr("pay.colAmount")}</TableHead>
                  <TableHead>{tr("pay.colMethod")}</TableHead>
                  <TableHead>{tr("pay.colReference")}</TableHead>
                  <TableHead>{tr("pay.colSenderPhone")}</TableHead>
                  <TableHead>{tr("pay.requestedPlan")}</TableHead>
                  <TableHead>{tr("pay.requestedGroup")}</TableHead>
                  <TableHead>{tr("pay.colDate")}</TableHead>
                  <TableHead>{tr("admin.025")}</TableHead>
                  <TableHead>{tr("pay.colActions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.payments.map((p) => (
                  <TableRow
                    key={p.id}
                    className={p.status === "PENDING" ? "bg-amber-500/5 cursor-pointer" : "cursor-pointer"}
                    onClick={() => setSelectedId(p.id)}
                    data-testid="payment-row"
                  >
                    <TableCell>
                      <div className="text-sm font-medium">{p.userName}</div>
                      <div className="text-xs text-muted-foreground">{p.userEmail}</div>
                      {p.studentContext?.groupName && (
                        <div className="text-[11px] text-muted-foreground">
                          {tr("pay.currentGroup")}: {p.studentContext.groupName}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <span className="font-bold text-primary whitespace-nowrap">
                        {p.amount.toLocaleString("en-US")} EGP
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline" className="whitespace-nowrap">
                        {paymentMethodLabel(p.method)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span dir="ltr">{p.reference || "—"}</span>
                      {p.duplicateReference && (
                        <Badge
                          variant="outline"
                          className="ms-1.5 border-amber-400/50 text-amber-600 whitespace-nowrap"
                          data-testid="duplicate-reference-badge"
                        >
                          {tr("pay.duplicateReferenceWarning")}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      <span dir="ltr">{p.senderPhone || "—"}</span>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.requestedPlan
                        ? pickAuto(p.requestedPlan.nameAr, p.requestedPlan.name)
                        : "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.requestedGroup?.name || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                      {fmtDate(p.createdAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap items-center gap-1">
                        {statusBadge(p.status)}
                        {p.isLatestPending === false && (
                          <Badge
                            variant="outline"
                            className="border-amber-400/50 text-amber-600 whitespace-nowrap"
                            data-testid="stale-badge"
                          >
                            {tr("pay.staleBadge")}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setSelectedId(p.id);
                        }}
                        aria-label={`${tr("pay.reviewOpen")} — ${p.userName}`}
                        data-testid="review-button"
                      >
                        {tr("pay.reviewOpen")}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      {/* Review drawer — the ONLY caller of the PR2b approve/reject endpoints */}
      <PaymentReviewDrawer
        payment={selected}
        onClose={() => setSelectedId(null)}
        onDecided={() => {
          // The server is the authority: re-read the queue after any outcome so
          // the row reflects committed state (approved / rejected / conflicted).
          reload();
        }}
      />
    </motion.div>
  );
}

// ============================================================
// 8. Subscriptions — plan management card (post-launch)
// ============================================================
type PlanRow = {
  id: string;
  name: string;
  nameAr: string;
  durationMonths: number;
  price: number;
  isPromo: boolean;
  isActive: boolean;
  description: string | null;
};

type PlanDependencies = {
  activeSubscriptions: number;
  totalSubscriptions: number;
  paymentReferences: number;
  deleteSafe: boolean;
};

/**
 * Admin control surface for SubscriptionPlan rows — the owner requirement
 * (Phase 26C: open/close ANY package) completed post-launch:
 *
 *   create / edit / activate / deactivate / safe-delete
 *
 * Rules implemented (the SERVER is the authority, the UI mirrors it):
 *   * a closed plan stays VISIBLE to students as "غير متاحة حاليًا"
 *     (disabled, unselectable) — it is not hidden;
 *   * deactivate stops NEW purchases only — existing ACTIVE subscriptions
 *     keep their entitlement (the entitlement policy never reads
 *     plan.isActive);
 *   * delete is offered with a confirmation that shows the dependency
 *     counts; the DELETE API refuses (409 + reason) whenever the plan has
 *     ANY subscription (active or historical) or payment reference, so the
 *     admin is told to deactivate instead. Payment/subscription history is
 *     never destroyed.
 */
function PlanManagementCard({
  plans,
  loading,
  onMutated,
}: {
  plans: PlanRow[];
  loading: boolean;
  onMutated: () => void;
}) {
  const tr = useT();
  const [editing, setEditing] = React.useState<PlanRow | "new" | null>(null);
  const [deleting, setDeleting] = React.useState<PlanRow | null>(null);
  const [deps, setDeps] = React.useState<PlanDependencies | null>(null);
  const [depsLoading, setDepsLoading] = React.useState(false);
  const [deletingBusy, setDeletingBusy] = React.useState(false);

  const patchPlan = async (id: string, body: Record<string, unknown>) => {
    const res = await fetch(`/api/admin/plans/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(j.error || tr("plan.026"));
    return j;
  };

  const togglePlanActive = async (plan: PlanRow) => {
    try {
      await patchPlan(plan.id, { isActive: !plan.isActive });
      toast.success(
        plan.isActive ? tr("plan.025") : tr("plan.024")
      );
      onMutated();
    } catch (e: any) {
      toast.error(e.message || tr("plan.026"));
    }
  };

  const openDeleteConfirm = async (plan: PlanRow) => {
    setDeleting(plan);
    setDeps(null);
    setDepsLoading(true);
    try {
      const res = await fetch(`/api/admin/plans/${plan.id}`);
      const j = await res.json().catch(() => ({}));
      if (res.ok) setDeps(j.dependencies);
    } finally {
      setDepsLoading(false);
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setDeletingBusy(true);
    try {
      const res = await fetch(`/api/admin/plans/${deleting.id}`, {
        method: "DELETE",
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        // 409 + the dependency reason — show it, do not destroy anything.
        toast.error(j.error || tr("plan.014"));
        return;
      }
      toast.success(tr("plan.011"));
      setDeleting(null);
      onMutated();
    } catch {
      toast.error(tr("plan.027"));
    } finally {
      setDeletingBusy(false);
    }
  };

  return (
    <Card className="p-4">
      <CardHeader className="px-0 pt-0">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="w-4 h-4 text-emerald-500" />
              Subscription Plans
            </CardTitle>
            <CardDescription>
              {tr("plan.022")}
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setEditing("new")}>
            <Plus className="w-3.5 h-3.5 ms-1.5" />
            {tr("plan.001")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        {loading ? (
          <LoadingBlock rows={3} />
        ) : plans.length === 0 ? (
          <EmptyBlock message={tr("plan.001")} />
        ) : (
          <div className="space-y-2">
            {plans.map((p) => (
              <div
                key={p.id}
                className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-lg border p-3 ${
                  !p.isActive ? "opacity-70 bg-muted/30 border-dashed" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-bold">
                      {pickAuto(p.nameAr, p.name)}
                    </span>
                    {p.isPromo && (
                      <Badge className="bg-amber-500/15 text-amber-700 border-amber-500/30 text-[10px]">
                        Promo
                      </Badge>
                    )}
                    <Badge
                      variant={p.isActive ? "default" : "secondary"}
                      className="text-[10px]"
                    >
                      {p.isActive ? tr("plan.024") : tr("plan.025")}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {p.durationMonths} {tr("plan.032")} · {p.price}{" "}
                    {tr("plan.033")} · {p.description || "—"}
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setEditing(p)}
                  >
                    <PencilLine className="w-3.5 h-3.5 ms-1.5" />
                    {tr("plan.002")}
                  </Button>
                  <Button
                    size="sm"
                    variant={p.isActive ? "outline" : "default"}
                    onClick={() => void togglePlanActive(p)}
                  >
                    {p.isActive ? tr("plan.025") : tr("plan.024")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive hover:bg-destructive/10"
                    onClick={() => void openDeleteConfirm(p)}
                  >
                    <Trash2 className="w-3.5 h-3.5 ms-1.5" />
                    {tr("plan.019")}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {editing && (
        <PlanFormDialog
          key={editing === "new" ? "new" : editing.id}
          plan={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onMutated();
          }}
        />
      )}

      {deleting && (
        <Dialog open onOpenChange={(v) => !v && setDeleting(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-destructive">
                <Trash2 className="w-4 h-4" />
                {tr("plan.012")}
              </DialogTitle>
              <DialogDescription>
                {tr("plan.013")}
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-1.5 text-xs">
              <div className="font-bold text-sm">
                {pickAuto(deleting.nameAr, deleting.name)}
              </div>
              {depsLoading ? (
                <div className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  …
                </div>
              ) : deps ? (
                <>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{tr("plan.015")}</span>
                    <span className="font-bold">{deps.activeSubscriptions}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{tr("plan.016")}</span>
                    <span className="font-bold">{deps.totalSubscriptions}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">{tr("plan.017")}</span>
                    <span className="font-bold">{deps.paymentReferences}</span>
                  </div>
                  {!deps.deleteSafe && (
                    <p className="text-destructive pt-1 font-semibold">
                      {tr("plan.014")}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-muted-foreground">{tr("plan.014")}</p>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="ghost"
                onClick={() => setDeleting(null)}
                disabled={deletingBusy}
              >
                {tr("plan.018")}
              </Button>
              <Button
                variant="destructive"
                onClick={() => void confirmDelete()}
                disabled={depsLoading || deletingBusy}
              >
                {deletingBusy && <Loader2 className="w-3.5 h-3.5 ms-1.5 animate-spin" />}
                {tr("plan.019")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </Card>
  );
}

/** Create / edit form — mirrors the server validation (name required,
    duration >= 1 month, price >= 0) and only the CURRENT schema fields:
    name, nameAr, durationMonths, price, isPromo, isActive, description. */
function PlanFormDialog({
  plan,
  onClose,
  onSaved,
}: {
  plan: PlanRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const tr = useT();
  const [form, setForm] = React.useState({
    name: plan?.name || "",
    nameAr: plan?.nameAr || "",
    durationMonths: plan ? String(plan.durationMonths) : "1",
    price: plan ? String(plan.price) : "",
    description: plan?.description || "",
    isPromo: plan?.isPromo || false,
    isActive: plan ? plan.isActive : true,
  });
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const name = form.name.trim();
    const nameAr = form.nameAr.trim() || name;
    const durationMonths = Number(form.durationMonths);
    const price = Number(form.price);
    if (!name) return setError(tr("plan.028"));
    if (!Number.isFinite(durationMonths) || durationMonths < 1)
      return setError(tr("plan.029"));
    if (!Number.isFinite(price) || price < 0) return setError(tr("plan.030"));

    setSaving(true);
    setError(null);
    const body = {
      name,
      nameAr,
      durationMonths: Math.floor(durationMonths),
      price,
      description: form.description.trim() || null,
      isPromo: form.isPromo,
      isActive: form.isActive,
    };
    try {
      let res: Response;
      if (plan) {
        res = await fetch(`/api/admin/plans/${plan.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      } else {
        res = await fetch("/api/admin/plans", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error || tr("plan.026"));
      toast.success(plan ? tr("plan.011") : tr("plan.010"));
      onSaved();
    } catch (e: any) {
      setError(e.message || tr("plan.026"));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && !saving && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {plan ? tr("plan.002") : tr("plan.001")}
          </DialogTitle>
          <DialogDescription>
            {tr("plan.022")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs">{tr("plan.003")}</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tr("plan.004")}</Label>
            <Input
              value={form.nameAr}
              onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
              dir="rtl"
            />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">{tr("plan.006")}</Label>
              <Input
                type="number"
                min={1}
                value={form.durationMonths}
                onChange={(e) =>
                  setForm({ ...form, durationMonths: e.target.value })
                }
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">{tr("plan.005")}</Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={form.price}
                onChange={(e) => setForm({ ...form, price: e.target.value })}
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{tr("plan.007")}</Label>
            <Textarea
              rows={2}
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </div>
          <div className="flex items-center justify-between gap-2">
            <label className="flex items-center gap-2 text-xs font-medium">
              <Switch
                checked={form.isPromo}
                onCheckedChange={(v) => setForm({ ...form, isPromo: v })}
              />
              {tr("plan.008")}
            </label>
            <label className="flex items-center gap-2 text-xs font-medium">
              <Switch
                checked={form.isActive}
                onCheckedChange={(v) => setForm({ ...form, isActive: v })}
              />
              {tr("plan.009")}
            </label>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            {tr("plan.018")}
          </Button>
          <Button onClick={() => void submit()} disabled={saving}>
            {saving && <Loader2 className="w-3.5 h-3.5 ms-1.5 animate-spin" />}
            {plan ? tr("plan.020") : tr("plan.021")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================
// 8. Subscriptions
// ============================================================
type SubscriptionRow = {
  id: string;
  studentName: string | null;
  studentEmail: string | null;
  plan: { name: string; nameAr: string; price: number; durationMonths: number } | null;
  status: string;
  startDate: string | null;
  endDate: string | null;
  createdAt: string;
  payments: { id: string; amount: number; status: string }[];
};

function SubscriptionsView() {
  const tr = useT();
  const [status, setStatus] = React.useState("all");
  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    return `/api/admin/subscriptions?${params.toString()}`;
  }, [status]);
  const { data, loading, error, reload } = useApi<{ subscriptions: SubscriptionRow[]; plans: any[] }>(query, [status]);
  const { data: plansData, loading: plansLoading, reload: reloadPlans } = useApi<{ plans: any[] }>("/api/admin/plans");

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-6">
      {/* Plans management — Phase 26C owner requirement (open/close ANY
          package) extended post-launch: create, edit, activate, deactivate,
          and safe delete (only zero-reference plans; referenced plans get
          the backend dependency reason instead of a hard delete). */}
      <PlanManagementCard
        plans={plansData?.plans || []}
        loading={plansLoading}
        onMutated={() => {
          reloadPlans();
          reload();
        }}
      />

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{tr("shell.012")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.subscriptions.subtitle")}</p>
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tr("admin.016")}</SelectItem>
            <SelectItem value="PENDING">Pending</SelectItem>
            <SelectItem value="ACTIVE">Active</SelectItem>
            <SelectItem value="EXPIRED">Expired</SelectItem>
            <SelectItem value="CANCELLED">Cancelled</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card className="p-4">
        {loading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : !data || data.subscriptions.length === 0 ? (
          <EmptyBlock message={tr("sub.empty")} />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("sub.colStudent")}</TableHead>
                  <TableHead>{tr("sub.colPlan")}</TableHead>
                  <TableHead>{tr("sub.colPrice")}</TableHead>
                  <TableHead>{tr("sub.colStart")}</TableHead>
                  <TableHead>{tr("sub.colEnd")}</TableHead>
                  <TableHead>{tr("admin.025")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.subscriptions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="text-sm font-medium">{s.studentName || "—"}</div>
                      <div className="text-xs text-muted-foreground">{s.studentEmail}</div>
                    </TableCell>
                    <TableCell>{pickAuto(s.plan?.nameAr, s.plan?.name) || "—"}</TableCell>
                    <TableCell>
                      <span className="font-bold text-primary">
                        {s.plan?.price?.toLocaleString("en-US")} EGP
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">{fmtDate(s.startDate)}</TableCell>
                    <TableCell className="text-xs">{fmtDate(s.endDate)}</TableCell>
                    <TableCell>{statusBadge(s.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>
    </motion.div>
  );
}

// ============================================================
// 9. Notifications

// ============================================================
type NotifRow = {
  id: string;
  userId: string;
  type: string;
  title: string;
  message: string;
  isRead: boolean;
  createdAt: string;
  user: { name: string; email: string };
};

function NotificationsView() {
  const tr = useT();
  const { data, loading, error, reload } = useApi<{ notifications: NotifRow[] }>("/api/admin/notifications?limit=30");

  const [form, setForm] = React.useState({
    target: "all",
    title: "",
    message: "",
    type: "ANNOUNCEMENT",
    groupId: "",
    userId: "",
  });
  const [groups, setGroups] = React.useState<{ id: string; name: string }[]>([]);
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    fetch("/api/admin/groups").then((r) => r.json()).then((d) => setGroups(d.groups || [])).catch(() => {});
  }, []);

  const submit = async () => {
    if (!form.title || !form.message) {
      toast.error(tr("notif.titleMessageRequired"));
      return;
    }
    setSending(true);
    try {
      const res = await fetch("/api/admin/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || "err");
      toast.success(tr("notif.sent", { p1: j.sent }));
      setForm({ ...form, title: "", message: "" });
      reload();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSending(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">{tr("notif.title")}</h2>
        <p className="text-xs text-muted-foreground">{tr("notif.subtitle")}</p>
      </div>

      {/* Notification Center Stats */}
      <NotificationCenterStats />

      {/* The admin's OWN notifications (the bell badge counts these).
          The shared panel is embedded without a back bar — the admin is
          already in their notifications surface. The badge and the list
          therefore stay consistent for every role. */}
      <Card className="glass">
        <CardHeader className="px-4 pt-4 pb-2">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bell className="w-4 h-4 text-primary" />
            {tr("notif.myTitle")}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          <NotificationsPanel
            homeView="admin-notifications"
            title={tr("notif.myTitle")}
            showBack={false}
          />
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Send form */}
        <Card className="p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Send className="w-4 h-4 text-emerald-500" />
              Send Notification
            </CardTitle>
            <CardDescription>{tr("notif.sendDesc")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            <div>
              <Label>{tr("notif.audience")}</Label>
              <Select value={form.target} onValueChange={(v) => setForm({ ...form, target: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tr("notif.allUsers")}</SelectItem>
                  <SelectItem value="students">{tr("admin.010")}</SelectItem>
                  <SelectItem value="parents">{tr("notif.parents")}</SelectItem>
                  <SelectItem value="teachers">{tr("admin.067")}</SelectItem>
                  <SelectItem value="group">{tr("notif.group")}</SelectItem>
                  <SelectItem value="user">{tr("notif.user")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.target === "group" && (
              <div>
                <Label>{tr("admin.023")}</Label>
                <Select value={form.groupId} onValueChange={(v) => setForm({ ...form, groupId: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={tr("notif.chooseGroup")} />
                  </SelectTrigger>
                  <SelectContent>
                    {groups.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            {form.target === "user" && (
              <div>
                <Label>User ID</Label>
                <Input
                  value={form.userId}
                  onChange={(e) => setForm({ ...form, userId: e.target.value })}
                  placeholder="user id"
                />
              </div>
            )}
            <div>
              <Label>{tr("admin.187")}</Label>
              <Select value={form.type} onValueChange={(v) => setForm({ ...form, type: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ANNOUNCEMENT">Announcement</SelectItem>
                  <SelectItem value="NEW_LESSON">New Lesson</SelectItem>
                  <SelectItem value="UPCOMING_SESSION">Upcoming Session</SelectItem>
                  <SelectItem value="MONTHLY_REPORT">Monthly Report</SelectItem>
                  <SelectItem value="SUBSCRIPTION_EXPIRATION">Subscription Expiration</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>{tr("admin.251")}</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <Label>{tr("admin.252")}</Label>
              <Textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} rows={3} />
            </div>
            <Button onClick={submit} disabled={sending} className="w-full">
              {sending ? tr("admin.253") : tr("admin.254")}
            </Button>
          </CardContent>
        </Card>

        {/* Recent list */}
        <Card className="p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Bell className="w-4 h-4 text-amber-500" />
              Recent Notifications
            </CardTitle>
            <CardDescription>{tr("admin.255")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {loading ? (
              <LoadingBlock rows={4} />
            ) : error ? (
              <ErrorBlock message={error} onRetry={reload} />
            ) : !data || data.notifications.length === 0 ? (
              <EmptyBlock message={tr("admin.256")} />
            ) : (
              <ScrollArea
                className="min-h-0"
                viewportClassName="max-h-[min(52dvh,calc(100dvh-22rem))] min-h-0 overscroll-contain"
              >
                {/* `pb-1` guarantees the last row's bottom edge is reachable
                    even with the Radix corner/scrollbar overlay. */}
                <div className="space-y-2 pb-1 pe-1">
                  {data.notifications.map((n) => (
                    <div key={n.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm font-medium">{n.title}</div>
                        <Badge variant="outline" className="text-[10px]">
                          {tr(notificationTypeLabelKey(n.type))}
                        </Badge>
                      </div>
                      <div className="text-xs text-muted-foreground mt-1">{n.message}</div>
                      <div className="flex items-center justify-between mt-2 text-[10px] text-muted-foreground">
                        <span>to: {n.user?.name || n.userId}</span>
                        <span>{fmtDateTime(n.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </CardContent>
        </Card>
      </div>
    </motion.div>
  );
}

// ============================================================
// 10. Settings
// ============================================================
const SETTING_KEYS = [
  { key: "brand_name", label: "admin.257", type: "text" },
  { key: "brand_tagline", label: "Tagline", type: "text" },
  { key: "whatsapp_teacher", label: "WhatsApp — Teacher", type: "text" },
  { key: "whatsapp_technical", label: "WhatsApp — Technical", type: "text" },
  { key: "whatsapp_subscription", label: "WhatsApp — Subscription", type: "text" },
  { key: "contact_email", label: "Contact Email", type: "text" },
  { key: "contact_phone", label: "Contact Phone", type: "text" },
  { key: "academic_year", label: "Academic Year", type: "text" },
  { key: "price_monthly", label: "Subscription — Monthly (EGP)", type: "number" },
  { key: "price_3months", label: "Subscription — 3 Months (EGP)", type: "number" },
  { key: "price_6months", label: "Subscription — 6 Months (EGP)", type: "number" },
  { key: "price_early_bird", label: "Subscription — Early Bird (EGP)", type: "number" },
];

function SettingsView() {
  const tr = useT();
  const { data, loading, error, reload } = useApi<{ settings: Record<string, string> }>("/api/admin/settings");
  const [values, setValues] = React.useState<Record<string, string>>({});
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    if (data?.settings) setValues({ ...data.settings });
  }, [data]);

  const save = async () => {
    setSaving(true);
    try {
      const items = SETTING_KEYS.map((k) => ({
        key: k.key,
        value: String(values[k.key] ?? ""),
      }));
      const res = await fetch("/api/admin/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings: items }),
      });
      if (!res.ok) throw new Error("err");
      toast.success(tr("admin.258"));
      reload();
    } catch {
      toast.error(tr("admin.001"));
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingBlock rows={6} />;
  if (error) return <ErrorBlock message={error} onRetry={reload} />;

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div>
        <h2 className="text-xl font-bold flex items-center gap-2">
          <Settings className="w-5 h-5 text-emerald-500" />
          {tr("admin.260")}</h2>
        <p className="text-xs text-muted-foreground">{tr("admin.261")}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Brand Settings</CardTitle>
            <CardDescription>{tr("admin.262")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            {SETTING_KEYS.filter((k) => k.type === "text").map((k) => (
              <div key={k.key}>
                <Label>{tr(k.label)}</Label>
                <Input
                  value={values[k.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [k.key]: e.target.value })}
                />
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Subscription Prices</CardTitle>
            <CardDescription>{tr("admin.263")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            {SETTING_KEYS.filter((k) => k.type === "number").map((k) => (
              <div key={k.key}>
                <Label>{tr(k.label)}</Label>
                <Input
                  type="number"
                  value={values[k.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [k.key]: e.target.value })}
                />
              </div>
            ))}
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
              {tr("admin.264")}</div>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving} size="lg">
          <Save className="w-4 h-4 ms-2" />
          {saving ? tr("admin.039") : tr("admin.266")}
        </Button>
      </div>
    </motion.div>
  );
}

// ============================================================
// Coupons View — manage discount codes
// ============================================================
function CouponsView() {
  const tr = useT();
  const { data, loading, reload } = useApi<{ coupons: any[] }>("/api/admin/coupons");
  const [showCreate, setShowCreate] = React.useState(false);
  const [createForm, setCreateForm] = React.useState({
    code: "",
    type: "PERCENTAGE",
    value: "",
    maxUses: "100",
    validUntil: "",
    description: "",
  });
  const [creating, setCreating] = React.useState(false);

  const create = async () => {
    setCreating(true);
    try {
      const r = await fetch("/api/admin/coupons", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: createForm.code,
          type: createForm.type,
          value: parseFloat(createForm.value),
          maxUses: parseInt(createForm.maxUses, 10),
          validUntil: createForm.validUntil || undefined,
          description: createForm.description,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        toast.error(d.error || tr("admin.267"));
        return;
      }
      toast.success(tr("admin.268"));
      setShowCreate(false);
      setCreateForm({ code: "", type: "PERCENTAGE", value: "", maxUses: "100", validUntil: "", description: "" });
      reload();
    } finally {
      setCreating(false);
    }
  };

  const toggleActive = async (id: string, current: boolean) => {
    await fetch(`/api/admin/coupons/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !current }),
    });
    toast.success(!current ? tr("admin.269") : tr("admin.270"));
    reload();
  };

  const del = async (id: string) => {
    if (!confirm(tr("admin.271"))) return;
    await fetch(`/api/admin/coupons/${id}`, { method: "DELETE" });
    toast.success(tr("admin.272"));
    reload();
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">{tr("admin.273")}</h2>
          <p className="text-sm text-muted-foreground mt-1">
            {tr("admin.274")}</p>
        </div>
        <Button onClick={() => setShowCreate((s) => !s)} className="font-bold">
          <Plus className="w-4 h-4 ms-2" />
          {tr("admin.275")}</Button>
      </div>

      {showCreate && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
        >
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base">{tr("admin.276")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{tr("admin.277")}</Label>
                  <Input
                    value={createForm.code}
                    onChange={(e) => setCreateForm({ ...createForm, code: e.target.value.toUpperCase() })}
                    placeholder="WELCOME10"
                    className="font-mono uppercase mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">{tr("admin.187")}</Label>
                  <Select
                    value={createForm.type}
                    onValueChange={(v) => setCreateForm({ ...createForm, type: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PERCENTAGE">{tr("admin.279")}</SelectItem>
                      <SelectItem value="FIXED">{tr("admin.280")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">{createForm.type === "PERCENTAGE" ? tr("admin.281") : tr("admin.282")}</Label>
                  <Input
                    type="number"
                    value={createForm.value}
                    onChange={(e) => setCreateForm({ ...createForm, value: e.target.value })}
                    placeholder={createForm.type === "PERCENTAGE" ? "10" : "50"}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">{tr("admin.283")}</Label>
                  <Input
                    type="number"
                    value={createForm.maxUses}
                    onChange={(e) => setCreateForm({ ...createForm, maxUses: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">{tr("admin.284")}</Label>
                <Input
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  placeholder={tr("admin.285")}
                  className="mt-1"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={create} disabled={creating || !createForm.code || !createForm.value}>
                  {creating ? tr("admin.286") : tr("admin.287")}
                </Button>
                <Button variant="ghost" onClick={() => setShowCreate(false)}>
                  {tr("admin.038")}</Button>
              </div>
            </CardContent>
          </Card>
        </motion.div>
      )}

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-20" />
          ))}
        </div>
      ) : !data?.coupons || data.coupons.length === 0 ? (
        <Card>
          <CardContent className="py-10 text-center">
            <Ticket className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">{tr("admin.289")}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {tr("admin.290")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {data.coupons.map((c, i) => (
            <motion.div
              key={c.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.05 }}
            >
              <Card className={`glass card-hover ${!c.isActive ? "opacity-60" : ""}`}>
                <CardContent className="p-4 flex items-center gap-4">
                  <div className="grid place-items-center w-12 h-12 rounded-xl bg-gradient-to-br from-amber-400/20 to-emerald-400/20 text-amber-600 shrink-0">
                    <Ticket className="w-6 h-6" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono font-bold text-lg">{c.code}</span>
                      <Badge variant="outline" className={
                        c.isActive ? "border-emerald-400/40 text-emerald-600" : "border-muted text-muted-foreground"
                      }>
                        {c.isActive ? tr("admin.291") : tr("admin.292")}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {c.type === "PERCENTAGE" ? tr("admin.293", { p1: c.value }) : tr("admin.294", { p1: c.value })}
                      {" · "}
                      {tr("admin.295")}{c.usedCount}/{c.maxUses} {tr("admin.296")}{" · "}
                      {c.redemptionsCount} {tr("admin.297")}</div>
                    {c.description && (
                      <div className="text-xs text-muted-foreground mt-0.5">{c.description}</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => toggleActive(c.id, c.isActive)}
                    >
                      {c.isActive ? tr("admin.298") : tr("admin.299")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      onClick={() => del(c.id)}
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </motion.div>
  );
}

// ============================================================
// Revenue Analytics Section — detailed revenue breakdown
// ============================================================
function RevenueAnalyticsSection() {
  const tr = useT();
  const { data, loading } = useApi<any>("/api/admin/revenue-analytics?months=6");

  if (loading || !data) {
    return (
      <Card className="p-4">
        <Skeleton className="h-8 w-48 mb-4" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      </Card>
    );
  }

  const ov = data.overview;
  const growthPositive = ov.revenueGrowth >= 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="space-y-4"
    >
      <div>
        <h3 className="text-lg font-bold flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-primary" />
          Revenue Analytics
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {tr("admin.300")}</p>
      </div>

      {/* Revenue stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <RevStatCard
          label="Total Revenue"
          value={`${ov.totalRevenue}`}
          unit="EGP"
          icon={CreditCard}
          color="from-emerald-400 to-teal-500"
        />
        <RevStatCard
          label="Avg Payment"
          value={`${ov.avgPaymentValue}`}
          unit="EGP"
          icon={TrendingUp}
          color="from-teal-400 to-cyan-500"
        />
        <RevStatCard
          label="Paying Users"
          value={`${ov.uniquePayingUsers}`}
          unit=""
          icon={Users}
          color="from-amber-400 to-orange-500"
        />
        <RevStatCard
          label="Pending Revenue"
          value={`${ov.pendingRevenue}`}
          unit="EGP"
          icon={Clock}
          color="from-orange-400 to-rose-500"
        />
      </div>

      {/* Growth indicator */}
      <div className={`rounded-xl p-4 border flex items-center gap-3 ${
        growthPositive
          ? "bg-emerald-500/5 border-emerald-400/30"
          : "bg-rose-500/5 border-rose-400/30"
      }`}>
        <div className={`grid place-items-center w-10 h-10 rounded-xl ${
          growthPositive ? "bg-emerald-500/15 text-emerald-500" : "bg-rose-500/15 text-rose-500"
        }`}>
          {growthPositive ? <TrendingUp className="w-5 h-5" /> : <TrendingDown className="w-5 h-5" />}
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold">
            Revenue Growth: {growthPositive ? "+" : ""}{ov.revenueGrowth}%
          </div>
          <p className="text-xs text-muted-foreground">
            {tr("admin.301")}{ov.pendingPayments} {tr("admin.302")}</p>
        </div>
        <Badge variant="outline" className={
          growthPositive
            ? "border-emerald-400/40 text-emerald-600 bg-emerald-400/10"
            : "border-rose-400/40 text-rose-600 bg-rose-400/10"
        }>
          {growthPositive ? "↑" : "↓"} {Math.abs(ov.revenueGrowth)}%
        </Badge>
      </div>

      {/* Revenue trend chart (Bar chart) */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Revenue by Month</CardTitle>
            <CardDescription>{tr("admin.303")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div dir="ltr" className="w-full h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data.monthlyData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <defs>
                    <linearGradient id="revBarGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" />
                      <stop offset="100%" stopColor="#14b8a6" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.91 0.01 165)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 12 }} />
                  <ReTooltip
                    contentStyle={{
                      borderRadius: 8,
                      border: "1px solid oklch(0.91 0.01 165)",
                      fontSize: 12,
                    }}
                    formatter={(value: any) => [`${value} EGP`, "Revenue"]}
                  />
                  <Bar dataKey="revenue" fill="url(#revBarGradient)" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Payment method breakdown */}
        <Card className="p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Payment Methods</CardTitle>
            <CardDescription>{tr("admin.304")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            {[
              { key: "INSTAPAY", label: "InstaPay", color: "bg-rose-500", count: data.methodBreakdown.INSTAPAY, revenue: data.methodRevenue.INSTAPAY },
              { key: "VODAFONE_CASH", label: "Vodafone Cash", color: "bg-red-500", count: data.methodBreakdown.VODAFONE_CASH, revenue: data.methodRevenue.VODAFONE_CASH },
              { key: "ETISALAT_CASH", label: "e& Cash", color: "bg-emerald-500", count: data.methodBreakdown.ETISALAT_CASH, revenue: data.methodRevenue.ETISALAT_CASH },
            ].map((m) => {
              const total = data.methodBreakdown.INSTAPAY + data.methodBreakdown.VODAFONE_CASH + data.methodBreakdown.ETISALAT_CASH;
              const pct = total > 0 ? Math.round((m.count / total) * 100) : 0;
              return (
                <div key={m.key}>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="font-semibold">{m.label}</span>
                    <span className="text-muted-foreground">{m.count} {tr("admin.305")}{m.revenue} EGP</span>
                  </div>
                  <div className="h-2.5 bg-muted rounded-full overflow-hidden">
                    <motion.div
                      initial={{ width: 0 }}
                      animate={{ width: `${pct}%` }}
                      transition={{ duration: 0.8, ease: "easeOut" }}
                      className={`h-full ${m.color} rounded-full`}
                    />
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{pct}%</div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </motion.div>
  );
}

function RevStatCard({
  label,
  value,
  unit,
  icon: Icon,
  color,
}: {
  label: string;
  value: string;
  unit: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
}) {
  return (
    <Card className="glass card-hover stat-glow">
      <CardContent className="p-4">
        <div className="flex items-center justify-between mb-2">
          <div className={`grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br ${color} text-white`}>
            <Icon className="w-4 h-4" />
          </div>
        </div>
        <div className="text-xl font-extrabold number-counter">
          {value}
          {unit && <span className="text-xs text-muted-foreground me-1"> {unit}</span>}
        </div>
        <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
      </CardContent>
    </Card>
  );
}

// ============================================================
// Notification Center Stats — overview of all notifications
// ============================================================
function NotificationCenterStats() {
  const tr = useT();
  const [data, setData] = React.useState<any>(null);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState("");

  const reload = React.useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filter) params.set("type", filter);
    fetch(`/api/admin/notifications-center?${params}&pageSize=10`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setData(d))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [filter]);

  React.useEffect(() => {
    reload();
  }, [reload]);

  if (loading || !data) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );
  }

  const s = data.stats;

  return (
    <div className="space-y-3">
      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Card className="glass card-hover stat-glow">
          <CardContent className="p-4">
            <div className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-emerald-400 to-teal-500 text-white mb-2">
              <Bell className="w-4 h-4" />
            </div>
            <div className="text-2xl font-extrabold number-counter">{s.total}</div>
            <div className="text-xs text-muted-foreground">Total</div>
          </CardContent>
        </Card>
        <Card className="glass card-hover stat-glow">
          <CardContent className="p-4">
            <div className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-teal-400 to-cyan-500 text-white mb-2">
              <CheckCircle2 className="w-4 h-4" />
            </div>
            <div className="text-2xl font-extrabold number-counter">{s.read}</div>
            <div className="text-xs text-muted-foreground">Read</div>
          </CardContent>
        </Card>
        <Card className="glass card-hover stat-glow">
          <CardContent className="p-4">
            <div className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-orange-500 text-white mb-2">
              <Clock className="w-4 h-4" />
            </div>
            <div className="text-2xl font-extrabold number-counter">{s.unread}</div>
            <div className="text-xs text-muted-foreground">Unread</div>
          </CardContent>
        </Card>
        <Card className="glass card-hover stat-glow">
          <CardContent className="p-4">
            <div className="grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br from-orange-400 to-rose-500 text-white mb-2">
              <TrendingUp className="w-4 h-4" />
            </div>
            <div className="text-2xl font-extrabold number-counter">{s.byType.length}</div>
            <div className="text-xs text-muted-foreground">Types</div>
          </CardContent>
        </Card>
      </div>

      {/* Type breakdown */}
      {s.byType.length > 0 && (
        <Card className="glass">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <Bell className="w-4 h-4 text-primary" />
              Notifications by Type
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-2">
              {s.byType.map((t: any) => (
                <button
                  key={t.type}
                  onClick={() => setFilter(filter === t.type ? "" : t.type)}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                    filter === t.type
                      ? "bg-primary text-primary-foreground shadow-sm"
                      : "bg-muted/50 text-muted-foreground hover:bg-primary/10 hover:text-primary"
                  }`}
                >
                  {tr(notificationTypeLabelKey(t.type))}
                  <Badge variant="outline" className="text-[10px] ms-1">
                    {t.count}
                  </Badge>
                </button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Recent notifications list */}
      <Card className="glass">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Bell className="w-4 h-4 text-amber-500" />
            All Notifications {filter && `· ${tr(notificationTypeLabelKey(filter))}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Finding 7 — Radix `ScrollArea` Root is `overflow-hidden`, so
              bounding the ROOT (`max-h-80`) did nothing: the card grew and the
              page scrolled, leaving the last rows and their actions
              unreachable. The constraint belongs on the VIEWPORT, and the inner
              padding keeps the final row clear of the scrollbar. Same pattern
              the already-fixed notification surfaces use. */}
          {data.notifications.length === 0 ? (
            <EmptyBlock message={tr("admin.306")} />
          ) : (
            <ScrollArea className="min-h-0" viewportClassName="max-h-[min(52dvh,calc(100dvh-22rem))] min-h-0 overscroll-contain">
              <div className="space-y-2 pb-1 pe-1">
                {data.notifications.map((n: any) => (
                  <div
                    key={n.id}
                    className={`rounded-lg border p-3 transition-colors ${
                      n.isRead ? "border-border/40" : "border-primary/30 bg-primary/5"
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <div className={`w-2 h-2 rounded-full shrink-0 ${
                            n.isRead ? "bg-muted-foreground/40" : "bg-primary"
                          }`} />
                          <span className="text-sm font-medium truncate">{n.title}</span>
                        </div>
                        <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{n.message}</div>
                        <div className="flex items-center gap-2 mt-2 text-[10px] text-muted-foreground">
                          <span className="font-semibold">{n.userName}</span>
                          <span>·</span>
                          <span>{n.userRole}</span>
                          <span>·</span>
                          <span>{fmtDateTime(n.createdAt)}</span>
                          {!n.isRead && (
                            <Badge className="text-[9px] bg-primary/15 text-primary">New</Badge>
                          )}
                        </div>
                      </div>
                      <Badge variant="outline" className="text-[10px] shrink-0">
                        {tr(notificationTypeLabelKey(n.type))}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// Revenue Forecast Section — predictive analytics
// ============================================================
function RevenueForecastSection() {
  const tr = useT();
  const { data, loading } = useApi<any>("/api/admin/revenue-forecast");

  if (loading || !data) {
    return (
      <Card className="p-4">
        <Skeleton className="h-8 w-48 mb-4" />
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Skeleton className="h-48" />
          <Skeleton className="h-48" />
        </div>
      </Card>
    );
  }

  const m = data.metrics;
  const trendUp = m.trendDirection === "growing";
  const trendNeutral = m.trendDirection === "stable";

  // Combine historical + forecast for chart
  const chartData = [
    ...data.historical.map((h: any) => ({ month: h.month, actual: h.revenue, forecast: null as any })),
    ...data.forecast.map((f: any) => ({ month: f.month, actual: null as any, forecast: f.predicted })),
  ];

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.3 }}
      className="space-y-4"
    >
      <div>
        <h3 className="text-lg font-bold flex items-center gap-2">
          <TrendingUp className="w-5 h-5 text-primary" />
          Revenue Forecast
        </h3>
        <p className="text-xs text-muted-foreground mt-0.5">
          {tr("admin.307")}</p>
      </div>

      {/* Trend indicator */}
      <div className={`rounded-xl p-4 border flex items-center gap-3 ${
        trendUp ? "bg-emerald-500/5 border-emerald-400/30" :
        trendNeutral ? "bg-muted/30 border-border/40" :
        "bg-rose-500/5 border-rose-400/30"
      }`}>
        <div className={`grid place-items-center w-10 h-10 rounded-xl ${
          trendUp ? "bg-emerald-500/15 text-emerald-500" :
          trendNeutral ? "bg-muted text-muted-foreground" :
          "bg-rose-500/15 text-rose-500"
        }`}>
          {trendUp ? <TrendingUp className="w-5 h-5" /> :
           trendNeutral ? <Activity className="w-5 h-5" /> :
           <TrendingDown className="w-5 h-5" />}
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold">
            {tr("admin.308")}{trendUp ? tr("admin.309") : trendNeutral ? tr("admin.310") : tr("admin.311")}
            {m.trendPercentage !== 0 && ` (${m.trendPercentage > 0 ? "+" : ""}${m.trendPercentage}%)`}
          </div>
          <p className="text-xs text-muted-foreground">
            {tr("admin.312")}{m.avgMonthlyRevenue} {tr("admin.313")}{m.monthOverMonthGrowth > 0 ? "+" : ""}{m.monthOverMonthGrowth}%
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Forecast chart */}
        <Card className="lg:col-span-2 p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Revenue Projection</CardTitle>
            <CardDescription>Historical + Predicted (3 months)</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div dir="ltr" className="w-full h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <defs>
                    <linearGradient id="actualBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" />
                      <stop offset="100%" stopColor="#14b8a6" />
                    </linearGradient>
                    <linearGradient id="forecastBar" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.8} />
                      <stop offset="100%" stopColor="#f97316" stopOpacity={0.6} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="oklch(0.91 0.01 165)" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <ReTooltip
                    contentStyle={{ borderRadius: 8, border: "1px solid oklch(0.91 0.01 165)", fontSize: 12 }}
                    formatter={(value: any, name: any) => [`${value} EGP`, name === "actual" ? "Actual" : "Predicted"]}
                  />
                  <Bar dataKey="actual" fill="url(#actualBar)" radius={[4, 4, 0, 0]} name="actual" />
                  <Bar dataKey="forecast" fill="url(#forecastBar)" radius={[4, 4, 0, 0]} name="forecast" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Forecast details */}
        <div className="space-y-3">
          <Card className="glass revenue-card">
            <CardContent className="p-4">
              <div className="text-xs text-muted-foreground mb-1">Projected Q+1 Revenue</div>
              <div className="text-2xl font-extrabold text-gradient number-counter">
                {m.projectedQuarterRevenue}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">{tr("admin.314")}</div>
            </CardContent>
          </Card>

          {/* Monthly forecasts */}
          <div className="space-y-2">
            {data.forecast.map((f: any, i: number) => (
              <Card key={i} className="glass border-amber-400/20">
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-bold">{f.month}</div>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      <Badge variant="outline" className={`text-[9px] ${
                        f.confidence === "high" ? "border-emerald-400/30 text-emerald-600" :
                        f.confidence === "medium" ? "border-amber-400/30 text-amber-600" :
                        "border-rose-400/30 text-rose-600"
                      }`}>
                        {f.confidence === "high" ? tr("admin.315") : f.confidence === "medium" ? tr("admin.316") : tr("admin.317")}
                      </Badge>
                    </div>
                  </div>
                  <div className="text-start">
                    <div className="text-lg font-bold text-amber-600">{f.predicted}</div>
                    <div className="text-[10px] text-muted-foreground">EGP</div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Subscription insights */}
          <Card className="glass">
            <CardContent className="p-3">
              <div className="text-xs font-bold mb-2 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                Subscription Insights
              </div>
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Active</span>
                  <span className="font-bold">{data.subscriptions.active}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Expiring this month</span>
                  <span className="font-bold text-amber-600">{data.subscriptions.expiringThisMonth}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Expected renewal</span>
                  <span className="font-bold text-emerald-600">{data.subscriptions.expectedRenewalRate}%</span>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>
    </motion.div>
  );
}
