"use client";
import { useT , pickAuto } from "@/lib/i18n";

// ============================================================
// CodeMind Academy — Admin Dashboard
// Switches between sub-views based on useApp().view.
// All views render inside <DashboardShell> via children.
// ============================================================
import * as React from "react";
import { useApp } from "@/lib/store";
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
      {view === "admin-question-bank" && <QuestionBankView />}
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
            <ScrollArea className="max-h-96">
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
};

function StudentsView() {
  const tr = useT();
  const [search, setSearch] = React.useState("");
  const [status, setStatus] = React.useState("all");
  const [openAdd, setOpenAdd] = React.useState(false);
  const [selected, setSelected] = React.useState<StudentRow | null>(null);

  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (search) params.set("search", search);
    if (status !== "all") params.set("status", status);
    return `/api/admin/students?${params.toString()}`;
  }, [search, status]);

  const { data, loading, error, reload } = useApi<{ students: StudentRow[] }>(query, [search, status]);

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
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr("admin.015")}
              className="pe-9"
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
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : !data || data.students.length === 0 ? (
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
                  <TableHead>{tr("admin.024")}</TableHead>
                  <TableHead>{tr("admin.025")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.students.map((s) => (
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
                      {s.subscription ? (
                        <span className="text-xs">
                          {pickAuto(s.subscription.plan?.nameAr, s.subscription.plan?.name)}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell>
                      {s.isActive ? (
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
    <Drawer open={!!student} onOpenChange={(v) => !v && onClose()} direction="right">
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
  const { data, loading, error, reload } = useApi<{ teachers: TeacherRow[] }>("/api/admin/teachers");

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
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Card>

      <AddTeacherDialog open={openAdd} onOpenChange={setOpenAdd} onCreated={reload} />
    </motion.div>
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
                  <div
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ background: g.courseColor || "#10b981" }}
                  />
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
      setForm({ name: "", courseId: "", teacherId: "", capacity: 20, schedule: tr("admin.091") });
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
  const [capacity, setCapacity] = React.useState(20);
  const [schedule, setSchedule] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [students, setStudents] = React.useState<StudentRow[]>([]);

  React.useEffect(() => {
    if (group) {
      setTeacherId(group.teacherId || undefined);
      setCapacity(group.capacity);
      setSchedule(group.schedule);
      fetch("/api/admin/teachers").then((r) => r.json()).then((d) => setTeachers(d.teachers || [])).catch(() => {});
      fetch("/api/admin/students").then((r) => r.json()).then((d) => {
        const all: StudentRow[] = d.students || [];
        setStudents(all.filter((s) => s.group?.id === group.id));
      }).catch(() => {});
    }
  }, [group]);

  const save = async () => {
    if (!group) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/admin/groups/${group.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ teacherId: teacherId || null, capacity, schedule }),
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
    <Dialog open={!!group} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{tr("admin.110")}</DialogTitle>
          <DialogDescription>{group?.name}</DialogDescription>
        </DialogHeader>
        {group && (
          <div className="space-y-3">
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
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tr("admin.117")}</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? tr("admin.039") : tr("admin.119")}
          </Button>
        </DialogFooter>
      </DialogContent>
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
  groupsCount: number;
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
      topics: {
        id: string;
        titleAr: string;
        title?: string;
        lessons: { id: string; titleAr: string; title?: string }[];
      }[];
    }[];
  }[];
};

function CoursesView() {
  const tr = useT();
  const { data, loading, error, reload } = useApi<{ courses: CourseRow[] }>("/api/admin/courses");
  const [tree, setTree] = React.useState<CourseTree | null>(null);
  const [treeLoading, setTreeLoading] = React.useState(false);
  const [seeding, setSeeding] = React.useState(false);
  const [openAdd, setOpenAdd] = React.useState(false);

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

  const seedNow = async () => {
    setSeeding(true);
    try {
      const res = await fetch("/api/admin/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "seed" }),
      });
      const j = await res.json();
      if (!res.ok) throw new Error(j.error || tr("admin.121"));
      toast.success(j.created ? tr("admin.122") : tr("admin.123"));
      reload();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    } finally {
      setSeeding(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.125")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.126")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={seedNow} disabled={seeding}>
            {seeding ? <Loader2 className="w-4 h-4 ms-2 animate-spin" /> : <Download className="w-4 h-4 ms-2" />}
            {seeding ? tr("admin.127") : tr("admin.128")}
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
          <Button className="mt-4" onClick={seedNow} disabled={seeding}>
            {seeding ? <Loader2 className="w-4 h-4 ms-2 animate-spin" /> : <Download className="w-4 h-4 ms-2" />}
            {seeding ? tr("admin.127") : tr("admin.131")}
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
                  <div className="text-lg font-bold text-primary">{c.lessonsCount}</div>
                  <div className="text-[10px] text-muted-foreground">Lessons</div>
                </div>
                <div className="rounded-lg border p-2">
                  <div className="text-lg font-bold text-primary">{c.groupsCount}</div>
                  <div className="text-[10px] text-muted-foreground">Groups</div>
                </div>
              </div>
              <Button
                variant="outline"
                className="w-full mt-4"
                onClick={() => openTree(c.id)}
              >
                <BookOpen className="w-4 h-4 ms-2" />
                {tr("admin.132")}<ChevronLeft className="w-3.5 h-3.5 me-1 flip-rtl" />
              </Button>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!tree} onOpenChange={(v) => !v && setTree(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{pickAuto(tree?.nameAr, tree?.name)}</DialogTitle>
            <DialogDescription>{tr("admin.133")}</DialogDescription>
          </DialogHeader>
          {treeLoading ? (
            <LoadingBlock rows={4} />
          ) : tree ? (
            <ScrollArea className="max-h-[60vh] pe-2">
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
                            {u.topics.map((t) => (
                              <div key={t.id} className="rounded-md border bg-card p-2">
                                <div className="text-xs font-medium mb-1">{pickAuto(t.titleAr, t.title)}</div>
                                <div className="flex flex-wrap gap-1">
                                  {t.lessons.map((l) => (
                                    <Badge key={l.id} variant="outline" className="text-[10px]">
                                      {pickAuto(l.titleAr, l.title)}
                                    </Badge>
                                  ))}
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
  quiz: { title: string; titleAr: string | null; lesson: { titleAr: string; title?: string } | null } | null;
};

function QuestionBankView() {
  const tr = useT();
  const [search, setSearch] = React.useState("");
  const [difficulty, setDifficulty] = React.useState("all");
  const [type, setType] = React.useState("all");
  const [openAdd, setOpenAdd] = React.useState(false);
  const [showAiGen, setShowAiGen] = React.useState(false);
  const [aiLesson, setAiLesson] = React.useState("");
  const [aiCount, setAiCount] = React.useState("5");
  const [aiDifficulty, setAiDifficulty] = React.useState("MIXED");
  const [aiGenerating, setAiGenerating] = React.useState(false);
  const [lessons, setLessons] = React.useState<any[]>([]);

  React.useEffect(() => {
    // NOTE: tree=1 is required — without it the API omits parts/units/topics/lessons.
    fetch("/api/admin/courses?tree=1")
      .then((r) => r.json())
      .then((d) => {
        const all: any[] = [];
        for (const c of d.courses || []) {
          for (const p of c.parts || []) {
            for (const u of p.units || []) {
              for (const t of u.topics || []) {
                for (const l of t.lessons || []) {
                  all.push({
                    id: l.id,
                    title: `${pickAuto(l.titleAr, l.title)} — ${pickAuto(u.titleAr, u.title)}`,
                  });
                }
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
    return `/api/admin/question-bank?${params.toString()}`;
  }, [search, difficulty, type]);

  const { data, loading, error, reload } = useApi<{ questions: QuestionRow[] }>(query, [search, difficulty, type]);

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
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute end-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={tr("admin.173")}
              className="pe-9"
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
          <ScrollArea className="max-h-[60vh]">
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

// ============================================================
// 7. Payments
// ============================================================
type PaymentRow = {
  id: string;
  userName: string;
  userEmail: string;
  userRole: string;
  amount: number;
  method: string;
  status: string;
  reference: string | null;
  notes: string | null;
  createdAt: string;
  subscription: { id: string; status: string; plan: { nameAr: string } } | null;
};

function PaymentsView() {
  const tr = useT();
  const [status, setStatus] = React.useState("all");
  const [showImport, setShowImport] = React.useState(false);
  const [importing, setImporting] = React.useState(false);
  const [importResult, setImportResult] = React.useState<any>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const query = React.useMemo(() => {
    const params = new URLSearchParams();
    if (status !== "all") params.set("status", status);
    return `/api/admin/payments?${params.toString()}`;
  }, [status]);
  const { data, loading, error, reload } = useApi<{ payments: PaymentRow[] }>(query, [status]);

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

  const approve = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/payments/${id}/approve`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error || "err");
      }
      toast.success(tr("admin.198"));
      reload();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    }
  };

  const reject = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/payments/${id}/reject`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error || "err");
      }
      toast.success(tr("admin.200"));
      reload();
    } catch (e: any) {
      toast.error(e.message || tr("admin.001"));
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.202")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.203")}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowImport((s) => !s)}
            className="border-primary/30 text-primary hover:bg-primary/5"
          >
            <Upload className="w-4 h-4 ms-2" />
            {tr("admin.204")}</Button>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tr("admin.205")}</SelectItem>
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
                  {tr("admin.206")}</CardTitle>
                <CardDescription className="text-xs">
                  {tr("admin.207")}</CardDescription>
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
                        {tr("admin.208")}</>
                    ) : (
                      <>
                        <Upload className="w-4 h-4 ms-2" />
                        {tr("admin.209")}</>
                    )}
                  </Button>
                  <Button variant="outline" onClick={downloadTemplate}>
                    <Download className="w-4 h-4 ms-2" />
                    {tr("admin.210")}</Button>
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
                        {tr("admin.212")}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <div className="text-2xl font-bold text-emerald-600">
                          {importResult.created}
                        </div>
                        <div className="text-xs text-muted-foreground">{tr("admin.213")}</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-amber-600">
                          {importResult.failed}
                        </div>
                        <div className="text-xs text-muted-foreground">{tr("admin.214")}</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-muted-foreground">
                          {importResult.total}
                        </div>
                        <div className="text-xs text-muted-foreground">{tr("admin.215")}</div>
                      </div>
                    </div>
                    {importResult.results?.some((r: any) => r.status === "failed") && (
                      <div className="mt-3 space-y-1 max-h-32 overflow-y-auto">
                        {importResult.results
                          .filter((r: any) => r.status === "failed")
                          .map((r: any, i: number) => (
                            <div key={i} className="text-xs text-destructive">
                              {tr("admin.216")}{r.row}: {r.userEmail} — {r.error}
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
          <EmptyBlock message={tr("admin.217")} />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("admin.218")}</TableHead>
                  <TableHead>{tr("admin.219")}</TableHead>
                  <TableHead>{tr("admin.220")}</TableHead>
                  <TableHead>{tr("admin.221")}</TableHead>
                  <TableHead>{tr("admin.222")}</TableHead>
                  <TableHead>{tr("admin.025")}</TableHead>
                  <TableHead>{tr("admin.224")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.payments.map((p) => (
                  <TableRow
                    key={p.id}
                    className={p.status === "PENDING" ? "bg-amber-500/5" : ""}
                  >
                    <TableCell>
                      <div className="text-sm font-medium">{p.userName}</div>
                      <div className="text-xs text-muted-foreground">{p.userEmail}</div>
                    </TableCell>
                    <TableCell>
                      <span className="font-bold text-primary">
                        {p.amount.toLocaleString("en-US")} EGP
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">
                      <Badge variant="outline">{p.method.replace("_", " ")}</Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {p.reference || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {fmtDate(p.createdAt)}
                    </TableCell>
                    <TableCell>{statusBadge(p.status)}</TableCell>
                    <TableCell>
                      {p.status === "PENDING" ? (
                        <div className="flex items-center gap-1">
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="h-7 w-7 text-emerald-600 border-emerald-500/40 hover:bg-emerald-500/10"
                                  onClick={() => approve(p.id)}
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Approve</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Button
                                  size="icon"
                                  variant="outline"
                                  className="h-7 w-7 text-red-600 border-red-500/40 hover:bg-red-500/10"
                                  onClick={() => reject(p.id)}
                                >
                                  <XCircle className="w-3.5 h-3.5" />
                                </Button>
                              </TooltipTrigger>
                              <TooltipContent>Reject</TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>
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

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">{tr("admin.225")}</h2>
          <p className="text-xs text-muted-foreground">{tr("admin.226")}</p>
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{tr("admin.205")}</SelectItem>
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
          <EmptyBlock message={tr("admin.228")} />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tr("admin.229")}</TableHead>
                  <TableHead>{tr("admin.230")}</TableHead>
                  <TableHead>{tr("admin.231")}</TableHead>
                  <TableHead>{tr("admin.232")}</TableHead>
                  <TableHead>{tr("admin.233")}</TableHead>
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
      toast.error(tr("admin.235"));
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
      toast.success(tr("admin.236", { p1: j.sent }));
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
        <h2 className="text-xl font-bold">{tr("admin.238")}</h2>
        <p className="text-xs text-muted-foreground">{tr("admin.239")}</p>
      </div>

      {/* Notification Center Stats */}
      <NotificationCenterStats />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Send form */}
        <Card className="p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base flex items-center gap-2">
              <Send className="w-4 h-4 text-emerald-500" />
              Send Notification
            </CardTitle>
            <CardDescription>{tr("admin.240")}</CardDescription>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            <div>
              <Label>{tr("admin.241")}</Label>
              <Select value={form.target} onValueChange={(v) => setForm({ ...form, target: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{tr("admin.242")}</SelectItem>
                  <SelectItem value="students">{tr("admin.010")}</SelectItem>
                  <SelectItem value="parents">{tr("admin.244")}</SelectItem>
                  <SelectItem value="teachers">{tr("admin.067")}</SelectItem>
                  <SelectItem value="group">{tr("admin.246")}</SelectItem>
                  <SelectItem value="user">{tr("admin.247")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.target === "group" && (
              <div>
                <Label>{tr("admin.023")}</Label>
                <Select value={form.groupId} onValueChange={(v) => setForm({ ...form, groupId: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder={tr("admin.249")} />
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
              <ScrollArea className="max-h-[60vh]">
                <div className="space-y-2">
                  {data.notifications.map((n) => (
                    <div key={n.id} className="rounded-lg border p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-sm font-medium">{n.title}</div>
                        <Badge variant="outline" className="text-[10px]">{n.type.replace(/_/g, " ")}</Badge>
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
                  {t.type.replace(/_/g, " ")}
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
            All Notifications {filter && `· ${filter.replace(/_/g, " ")}`}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {data.notifications.length === 0 ? (
            <EmptyBlock message={tr("admin.306")} />
          ) : (
            <ScrollArea className="max-h-80">
              <div className="space-y-2">
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
                        {n.type.replace(/_/g, " ")}
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
