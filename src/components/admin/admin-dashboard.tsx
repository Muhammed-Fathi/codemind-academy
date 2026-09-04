"use client";

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
      .catch(() => setError("حصلت مشكلة. حاول تاني."))
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
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center gap-3">
      <XCircle className="w-8 h-8 text-destructive" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {onRetry && (
        <Button size="sm" variant="outline" onClick={onRetry}>
          حاول تاني
        </Button>
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
    return <ErrorBlock message={error || "حصلت مشكلة"} onRetry={reload} />;
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
            Revenue (هذا الشهر)
          </div>
          <div className="text-2xl font-bold mt-2">
            <AnimatedCounter value={t.revenueThisMonth} />
            <span className="text-sm text-muted-foreground mr-1">EGP</span>
          </div>
        </Card>
        <Card className="p-4">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <UserCheck className="w-3.5 h-3.5 text-teal-500" />
            Attendance Rate
          </div>
          <div className="text-2xl font-bold mt-2">
            <AnimatedCounter value={t.attendanceRate} />
            <span className="text-sm text-muted-foreground mr-1">%</span>
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
            <span className="text-sm text-muted-foreground mr-1">%</span>
          </div>
        </Card>
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="lg:col-span-2 p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Revenue Trend</CardTitle>
            <CardDescription>آخر 6 شهور</CardDescription>
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
            <CardDescription>حسب الكورس</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            <div dir="ltr" className="w-full h-64">
              {data.groupDistribution.length === 0 ? (
                <EmptyBlock message="مفيش مجموعات لسه" />
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
          <CardDescription>السبعة أيام الجايين</CardDescription>
        </CardHeader>
        <CardContent className="px-0">
          {data.upcomingSessions.length === 0 ? (
            <EmptyBlock message="مفيش Sessions مجدولة دلوقتي" />
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
  group: { id: string; name: string; course: { nameAr: string } } | null;
  subscription: {
    status: string;
    endDate: string | null;
    plan: { nameAr: string };
  } | null;
};

function StudentsView() {
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
          <h2 className="text-xl font-bold">الطلاب</h2>
          <p className="text-xs text-muted-foreground">إدارة كل الطلاب المسجلين في الأكاديمية</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={async () => {
              try {
                const r = await fetch("/api/admin/export-progress");
                if (!r.ok) {
                  toast.error("فشل التصدير");
                  return;
                }
                const blob = await r.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `students-progress-${new Date().toISOString().slice(0, 10)}.csv`;
                a.click();
                URL.revokeObjectURL(url);
                toast.success("اتنزّل ملف التقدم ✅");
              } catch {
                toast.error("حصلت مشكلة في التصدير");
              }
            }}
          >
            <Download className="w-4 h-4 ml-2" />
            Export CSV
          </Button>
          <Button onClick={() => setOpenAdd(true)}>
            <Plus className="w-4 h-4 ml-2" />
            Add Student
          </Button>
        </div>
      </div>

      <Card className="p-4">
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث بالاسم أو الإيميل..."
              className="pr-9"
            />
          </div>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="الكل" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">الكل</SelectItem>
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
          <EmptyBlock message="مفيش طلاب لسه. ابدأ بإضافة طالب جديد." />
        ) : (
          <div className="max-h-[60vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الاسم</TableHead>
                  <TableHead>كود الطالب</TableHead>
                  <TableHead>الإيميل</TableHead>
                  <TableHead>الصف</TableHead>
                  <TableHead>المجموعة</TableHead>
                  <TableHead>الاشتراك</TableHead>
                  <TableHead>الحالة</TableHead>
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
                          {s.subscription.plan?.nameAr}
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
      toast.error("الاسم والإيميل والباسورد مطلوبين");
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
      if (!res.ok) throw new Error(j.error || "حصلت مشكلة");
      toast.success("اتضاف الطالب بنجاح");
      onCreated();
      onOpenChange(false);
      setForm({ name: "", email: "", password: "", phone: "", grade: "2nd Secondary", schoolName: "" });
    } catch (e: any) {
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>إضافة طالب جديد</DialogTitle>
          <DialogDescription>اتسجل بيانات الطالب وهيحصل له User و Student تلقائياً.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>الاسم</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>الإيميل</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <Label>كلمة السر</Label>
            <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>التليفون</Label>
              <Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </div>
            <div>
              <Label>الصف</Label>
              <Input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} />
            </div>
          </div>
          <div>
            <Label>المدرسة</Label>
            <Input value={form.schoolName} onChange={(e) => setForm({ ...form, schoolName: e.target.value })} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>إلغاء</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "جارٍ الحفظ..." : "حفظ"}
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
      toast.success(student.isActive ? "اتوقف الطالب" : "اتفعّل الطالب");
      onUpdated();
      onClose();
    } catch {
      toast.error("حصلت مشكلة. حاول تاني.");
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
      toast.success("اتحدّثت المجموعة");
      onUpdated();
      onClose();
    } catch {
      toast.error("حصلت مشكلة. حاول تاني.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Drawer open={!!student} onOpenChange={(v) => !v && onClose()} direction="right">
      <DrawerContent className="w-full sm:max-w-md ml-auto">
        {student && (
          <>
            <DrawerHeader>
              <DrawerTitle>{student.name}</DrawerTitle>
              <DrawerDescription>{student.email}</DrawerDescription>
            </DrawerHeader>
            <div className="px-4 pb-6 space-y-4">
              {student.studentCode && (
                <div className="rounded-xl border border-primary/30 bg-primary/5 p-3 flex items-center justify-between">
                  <div>
                    <div className="text-xs text-muted-foreground">كود الطالب</div>
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
                        toast.success("اتنسخ الكود ✅");
                      } catch {
                        toast.error("انسخ الكود يدويًا");
                      }
                    }}
                  >
                    نسخ
                  </Button>
                </div>
              )}
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">التليفون</div>
                  <div className="font-medium mt-1">{student.phone || "—"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">تليفون ولي الأمر</div>
                  <div className="font-medium mt-1" dir="ltr">{student.parentPhone || "—"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">الرقم القومي</div>
                  <div className="font-medium mt-1 font-mono" dir="ltr">{student.nationalId || "—"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">الصف</div>
                  <div className="font-medium mt-1">{student.grade}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">المدرسة</div>
                  <div className="font-medium mt-1">{student.schoolName || "—"}</div>
                </div>
                <div className="rounded-lg border p-3">
                  <div className="text-xs text-muted-foreground">نوع المدرسة</div>
                  <div className="font-medium mt-1">
                    {student.schoolType === "LANGUAGE" ? "لغات" : student.schoolType === "ARABIC" ? "عربي" : "—"}
                  </div>
                </div>
                <div className="rounded-lg border p-3 col-span-2">
                  <div className="text-xs text-muted-foreground">تاريخ التسجيل</div>
                  <div className="font-medium mt-1">{fmtDate(student.enrolledAt)}</div>
                </div>
              </div>

              <div className="rounded-lg border p-3 space-y-2">
                <div className="text-xs text-muted-foreground">الاشتراك</div>
                {student.subscription ? (
                  <>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">{student.subscription.plan?.nameAr}</span>
                      {statusBadge(student.subscription.status)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      ينتهي: {fmtDate(student.subscription.endDate)}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">مفيش اشتراك</div>
                )}
              </div>

              <div className="rounded-lg border p-3 space-y-2">
                <div className="text-xs text-muted-foreground">المجموعة</div>
                <Select value={groupId} onValueChange={setGroupId}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="اختر مجموعة" />
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
                  حفظ المجموعة
                </Button>
              </div>

              <Button
                onClick={toggleActive}
                disabled={saving}
                variant={student.isActive ? "destructive" : "default"}
                className="w-full"
              >
                {student.isActive ? (
                  <>
                    <UserX className="w-4 h-4 ml-2" />
                    إيقاف الطالب
                  </>
                ) : (
                  <>
                    <UserCheck className="w-4 h-4 ml-2" />
                    تفعيل الطالب
                  </>
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
  const [openAdd, setOpenAdd] = React.useState(false);
  const { data, loading, error, reload } = useApi<{ teachers: TeacherRow[] }>("/api/admin/teachers");

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">المعلمون</h2>
          <p className="text-xs text-muted-foreground">إدارة فريق المعلمين والمجموعات بتاعتهم</p>
        </div>
        <Button onClick={() => setOpenAdd(true)}>
          <Plus className="w-4 h-4 ml-2" />
          Add Teacher
        </Button>
      </div>

      <Card className="p-4">
        {loading ? (
          <LoadingBlock rows={5} />
        ) : error ? (
          <ErrorBlock message={error} onRetry={reload} />
        ) : !data || data.teachers.length === 0 ? (
          <EmptyBlock message="مفيش معلمين لسه." />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الاسم</TableHead>
                  <TableHead>الإيميل</TableHead>
                  <TableHead>Specialty</TableHead>
                  <TableHead>المجموعات</TableHead>
                  <TableHead>الحالة</TableHead>
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
      toast.error("الاسم والإيميل والباسورد مطلوبين");
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
      toast.success("اتضاف المعلم بنجاح");
      onCreated();
      onOpenChange(false);
      setForm({ name: "", email: "", password: "", phone: "", specialty: "", bio: "" });
    } catch (e: any) {
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>إضافة معلم جديد</DialogTitle>
          <DialogDescription>هيحصل User بالـ TEACHER role.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>الاسم</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>الإيميل</Label>
            <Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          </div>
          <div>
            <Label>كلمة السر</Label>
            <PasswordInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="••••••••" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>التليفون</Label>
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>إلغاء</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "جارٍ الحفظ..." : "حفظ"}
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
  const [openAdd, setOpenAdd] = React.useState(false);
  const [selected, setSelected] = React.useState<GroupRow | null>(null);
  const { data, loading, error, reload } = useApi<{ groups: GroupRow[] }>("/api/admin/groups");

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold">المجموعات</h2>
          <p className="text-xs text-muted-foreground">كل المجموعات الدراسية</p>
        </div>
        <Button onClick={() => setOpenAdd(true)}>
          <Plus className="w-4 h-4 ml-2" />
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
          <EmptyBlock message="مفيش مجموعات لسه. ابدأ بإنشاء مجموعة جديدة." />
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
                    {g.teacherName || "مفيش معلم"}
                  </div>
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <CalendarDays className="w-3.5 h-3.5" />
                    {g.schedule}
                  </div>
                </div>
                <div className="mt-4">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-muted-foreground">الطلاب</span>
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
  const [form, setForm] = React.useState({
    name: "",
    courseId: "",
    teacherId: "",
    capacity: 20,
    schedule: "السبت و الثلاثاء — 6:00 م",
  });
  const [courses, setCourses] = React.useState<{ id: string; nameAr: string }[]>([]);
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
      toast.error("الاسم والكورس مطلوبين");
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
      toast.success("اتعملت المجموعة بنجاح");
      onCreated();
      onOpenChange(false);
      setForm({ name: "", courseId: "", teacherId: "", capacity: 20, schedule: "السبت و الثلاثاء — 6:00 م" });
    } catch (e: any) {
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>إنشاء مجموعة جديدة</DialogTitle>
          <DialogDescription>المجموعة هيتم ربطها بالكورس والمعلم.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>اسم المجموعة</Label>
            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </div>
          <div>
            <Label>الكورس</Label>
            <Select value={form.courseId} onValueChange={(v) => setForm({ ...form, courseId: v })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="اختر الكورس" />
              </SelectTrigger>
              <SelectContent>
                {courses.map((c) => (
                  <SelectItem key={c.id} value={c.id}>{c.nameAr}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>المعلم</Label>
            <Select value={form.teacherId} onValueChange={(v) => setForm({ ...form, teacherId: v })}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="اختر المعلم" />
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
              <Label>السعة</Label>
              <Input
                type="number"
                value={form.capacity}
                onChange={(e) => setForm({ ...form, capacity: Number(e.target.value) })}
              />
            </div>
            <div>
              <Label>الميعاد</Label>
              <Input value={form.schedule} onChange={(e) => setForm({ ...form, schedule: e.target.value })} />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>إلغاء</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "جارٍ الحفظ..." : "حفظ"}
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
      toast.success("اتحدّثت المجموعة");
      onUpdated();
      onClose();
    } catch {
      toast.error("حصلت مشكلة. حاول تاني.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!group} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>إدارة المجموعة</DialogTitle>
          <DialogDescription>{group?.name}</DialogDescription>
        </DialogHeader>
        {group && (
          <div className="space-y-3">
            <div>
              <Label>المعلم</Label>
              <Select value={teacherId} onValueChange={setTeacherId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="اختر المعلم" />
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
                <Label>السعة</Label>
                <Input type="number" value={capacity} onChange={(e) => setCapacity(Number(e.target.value))} />
              </div>
              <div>
                <Label>الميعاد</Label>
                <Input value={schedule} onChange={(e) => setSchedule(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>الطلاب المسجلين ({students.length})</Label>
              <div className="max-h-40 overflow-y-auto rounded-lg border p-2 space-y-1">
                {students.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-3">مفيش طلاب</div>
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
          <Button variant="outline" onClick={onClose}>إغلاق</Button>
          <Button onClick={save} disabled={saving}>
            {saving ? "جارٍ الحفظ..." : "حفظ التغييرات"}
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
  parts: {
    id: string;
    titleAr: string;
    units: {
      id: string;
      titleAr: string;
      topics: {
        id: string;
        titleAr: string;
        lessons: { id: string; titleAr: string }[];
      }[];
    }[];
  }[];
};

function CoursesView() {
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
      toast.error("حصلت مشكلة. حاول تاني.");
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
      if (!res.ok) throw new Error(j.error || "فشل استعادة المنهج");
      toast.success(j.created ? "اتستعاد المنهج بنجاح ✅" : "المنهج موجود بالفعل ✅");
      reload();
    } catch (e: any) {
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    } finally {
      setSeeding(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div>
          <h2 className="text-xl font-bold">الكورسات</h2>
          <p className="text-xs text-muted-foreground">استعراض الـCurriculum الشامل</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={seedNow} disabled={seeding}>
            {seeding ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <Download className="w-4 h-4 ml-2" />}
            {seeding ? "جارٍ الاستعادة…" : "استعادة المنهج"}
          </Button>
          <Button size="sm" onClick={() => setOpenAdd(true)}>
            <Plus className="w-4 h-4 ml-2" />
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
          <EmptyBlock message="مفيش كورسات لسه. دوس «استعادة المنهج» عشان نرجّع بيانات curriculum.ts." />
          <Button className="mt-4" onClick={seedNow} disabled={seeding}>
            {seeding ? <Loader2 className="w-4 h-4 ml-2 animate-spin" /> : <Download className="w-4 h-4 ml-2" />}
            {seeding ? "جارٍ الاستعادة…" : "استعادة المنهج من curriculum.ts"}
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
                  <div className="text-base font-bold truncate">{c.nameAr}</div>
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
                <BookOpen className="w-4 h-4 ml-2" />
                فتح الـCurriculum
                <ChevronLeft className="w-3.5 h-3.5 mr-1 flip-rtl" />
              </Button>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!tree} onOpenChange={(v) => !v && setTree(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{tree?.nameAr}</DialogTitle>
            <DialogDescription>شجرة الـCurriculum — Parts → Units → Topics → Lessons</DialogDescription>
          </DialogHeader>
          {treeLoading ? (
            <LoadingBlock rows={4} />
          ) : tree ? (
            <ScrollArea className="max-h-[60vh] pr-2">
              <div className="space-y-3">
                {tree.parts.map((p) => (
                  <details key={p.id} className="rounded-lg border" open>
                    <summary className="px-3 py-2 text-sm font-bold cursor-pointer hover:bg-muted/50 rounded-lg">
                      {p.titleAr}
                    </summary>
                    <div className="px-3 pb-3 space-y-2">
                      {p.units.map((u) => (
                        <details key={u.id} className="rounded-md border bg-muted/30">
                          <summary className="px-3 py-2 text-xs font-semibold cursor-pointer">
                            {u.titleAr}
                          </summary>
                          <div className="px-3 pb-2 space-y-1.5">
                            {u.topics.map((t) => (
                              <div key={t.id} className="rounded-md border bg-card p-2">
                                <div className="text-xs font-medium mb-1">{t.titleAr}</div>
                                <div className="flex flex-wrap gap-1">
                                  {t.lessons.map((l) => (
                                    <Badge key={l.id} variant="outline" className="text-[10px]">
                                      {l.titleAr}
                                    </Badge>
                                  ))}
                                  {t.lessons.length === 0 && (
                                    <span className="text-[10px] text-muted-foreground">مفيش Lessons</span>
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
            <EmptyBlock message="مفيش بيانات" />
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
  const [form, setForm] = React.useState({
    name: "",
    nameAr: "",
    description: "",
    color: "#10b981",
  });
  const [saving, setSaving] = React.useState(false);

  const submit = async () => {
    if (!form.name.trim() || !form.nameAr.trim()) {
      toast.error("اسم الكورس (عربي + إنجليزي) مطلوب");
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
      if (!res.ok) throw new Error(j.error || "حصلت مشكلة");
      toast.success("اتضاف الكورس بنجاح ✅");
      onCreated();
      onOpenChange(false);
      setForm({ name: "", nameAr: "", description: "", color: "#10b981" });
    } catch (e: any) {
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>إضافة كورس جديد</DialogTitle>
          <DialogDescription>ادخل بيانات الكورس الأساسية.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>الاسم بالإنجليزية</Label>
            <Input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="Programming & AI"
            />
          </div>
          <div>
            <Label>الاسم بالعربية</Label>
            <Input
              value={form.nameAr}
              onChange={(e) => setForm({ ...form, nameAr: e.target.value })}
              placeholder="البرمجة والذكاء الاصطناعي"
            />
          </div>
          <div>
            <Label>الوصف</Label>
            <Textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="وصف مختصر للكورس"
            />
          </div>
          <div>
            <Label>اللون</Label>
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
            إلغاء
          </Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "جارٍ الحفظ..." : "حفظ"}
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
  quiz: { title: string; titleAr: string | null; lesson: { titleAr: string } | null } | null;
};

function QuestionBankView() {
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
                    title: `${l.titleAr || l.title} — ${u.titleAr || u.title}`,
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
      toast.error("اختار Lesson الأول");
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
        toast.error(d.error || "فشل توليد الأسئلة");
        return;
      }
      toast.success(`اتولّدت ${d.generated} أسئلة بالـAI 🤖`);
      setShowAiGen(false);
      reload();
    } catch {
      toast.error("حصلت مشكلة في الاتصال بالـAI");
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
          <p className="text-xs text-muted-foreground">كل الأسئلة المتاحة في النظام</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setShowAiGen((s) => !s)}
            className="border-primary/30 text-primary hover:bg-primary/5"
          >
            <Sparkles className="w-4 h-4 ml-2" />
            AI Generate
          </Button>
          <Button onClick={() => setOpenAdd(true)}>
            <Plus className="w-4 h-4 ml-2" />
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
                  خلّي الـAI يولّد أسئلة من محتوى أي Lesson — بيستخدم z-ai-web-dev-sdk
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <div>
                  <Label className="text-xs">اختار Lesson</Label>
                  <Select value={aiLesson} onValueChange={setAiLesson}>
                    <SelectTrigger className="mt-1">
                      <SelectValue placeholder="اختار Lesson..." />
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
                    <Label className="text-xs">عدد الأسئلة</Label>
                    <Select value={aiCount} onValueChange={setAiCount}>
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="3">3 أسئلة</SelectItem>
                        <SelectItem value="5">5 أسئلة</SelectItem>
                        <SelectItem value="7">7 أسئلة</SelectItem>
                        <SelectItem value="10">10 أسئلة</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label className="text-xs">الصعوبة</Label>
                    <Select value={aiDifficulty} onValueChange={setAiDifficulty}>
                      <SelectTrigger className="mt-1">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="MIXED">متنوعة</SelectItem>
                        <SelectItem value="EASY">سهل</SelectItem>
                        <SelectItem value="MEDIUM">متوسط</SelectItem>
                        <SelectItem value="HARD">صعب</SelectItem>
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
                        <Loader2 className="w-4 h-4 ml-2 animate-spin" />
                        جارٍ التوليد... (30 ثانية)
                      </>
                    ) : (
                      <>
                        <Sparkles className="w-4 h-4 ml-2" />
                        ولّد الأسئلة
                      </>
                    )}
                  </Button>
                  <Button variant="ghost" onClick={() => setShowAiGen(false)}>
                    إلغاء
                  </Button>
                </div>
                {aiGenerating && (
                  <div className="rounded-lg bg-primary/5 border border-primary/20 p-3 text-xs text-muted-foreground">
                    💡 الـAI بيدرس محتوى الـLesson وبيولّد أسئلة متنوعة مع شروحات.
                    ده ممكن ياخد حوالي 30 ثانية.
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      <Card className="p-4">
        <div className="flex flex-wrap gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="بحث في نص السؤال..."
              className="pr-9"
            />
          </div>
          <Select value={difficulty} onValueChange={setDifficulty}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="الكل" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الصعوبات</SelectItem>
              <SelectItem value="EASY">Easy</SelectItem>
              <SelectItem value="MEDIUM">Medium</SelectItem>
              <SelectItem value="HARD">Hard</SelectItem>
            </SelectContent>
          </Select>
          <Select value={type} onValueChange={setType}>
            <SelectTrigger className="w-36">
              <SelectValue placeholder="الكل" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الأنواع</SelectItem>
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
          <EmptyBlock message="مفيش أسئلة لسه. ابدأ بإضافة سؤال جديد." />
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
                          {q.promptAr || q.prompt}
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
                        {q.quiz.titleAr || q.quiz.title}
                        {q.quiz.lesson && ` · ${q.quiz.lesson.titleAr}`}
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
      toast.error("نص السؤال مطلوب");
      return;
    }
    if (form.type === "MCQ" && form.options.filter((o) => o.trim()).length < 2) {
      toast.error("لازم على الأقل خيارين للسؤال");
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
      toast.success("اتضاف السؤال بنجاح");
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
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>إضافة سؤال جديد</DialogTitle>
          <DialogDescription>السؤال هيكون متاح في الـQuestion Bank.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label>نص السؤال (English)</Label>
            <Textarea value={form.prompt} onChange={(e) => setForm({ ...form, prompt: e.target.value })} rows={2} />
          </div>
          <div>
            <Label>نص السؤال (عربي)</Label>
            <Textarea value={form.promptAr} onChange={(e) => setForm({ ...form, promptAr: e.target.value })} rows={2} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label>النوع</Label>
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
              <Label>الصعوبة</Label>
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
              <Label>الخيارات (الإجابة الصحيحة محددة)</Label>
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
              <Label>الإجابة الصحيحة</Label>
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
            <Label>الشرح (اختياري)</Label>
            <Textarea value={form.explanation} onChange={(e) => setForm({ ...form, explanation: e.target.value })} rows={2} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>إلغاء</Button>
          <Button onClick={submit} disabled={saving}>
            {saving ? "جارٍ الحفظ..." : "حفظ"}
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
        toast.error(d.error || "فشل الاستيراد");
        return;
      }
      setImportResult(d);
      toast.success(`اتاستورد ${d.created} دفعة بنجاح 📊`);
      reload();
    } catch {
      toast.error("حصلت مشكلة في قراءة الملف");
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
      toast.success("اتعمل Approve للدفعة");
      reload();
    } catch (e: any) {
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    }
  };

  const reject = async (id: string) => {
    try {
      const res = await fetch(`/api/admin/payments/${id}/reject`, { method: "POST" });
      if (!res.ok) {
        const j = await res.json();
        throw new Error(j.error || "err");
      }
      toast.success("اترفضت الدفعة");
      reload();
    } catch (e: any) {
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold">المدفوعات</h2>
          <p className="text-xs text-muted-foreground">مراجعة وتأكيد دفعات الطلاب</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowImport((s) => !s)}
            className="border-primary/30 text-primary hover:bg-primary/5"
          >
            <Upload className="w-4 h-4 ml-2" />
            استيراد xlsx
          </Button>
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">كل الحالات</SelectItem>
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
                  استيراد مدفوعات بالجملة (xlsx)
                </CardTitle>
                <CardDescription className="text-xs">
                  ارفع ملف Excel بالمدفوعات. الأعمدة: userEmail, amount, method, reference, status, notes
                </CardDescription>
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
                        <Loader2 className="w-4 h-4 ml-2 animate-spin" />
                        جارٍ الاستيراد...
                      </>
                    ) : (
                      <>
                        <Upload className="w-4 h-4 ml-2" />
                        اختار ملف Excel
                      </>
                    )}
                  </Button>
                  <Button variant="outline" onClick={downloadTemplate}>
                    <Download className="w-4 h-4 ml-2" />
                    تحميل Template
                  </Button>
                  <Button variant="ghost" onClick={() => setShowImport(false)}>
                    إلغاء
                  </Button>
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
                        نتائج الاستيراد
                      </span>
                    </div>
                    <div className="grid grid-cols-3 gap-3 text-sm">
                      <div>
                        <div className="text-2xl font-bold text-emerald-600">
                          {importResult.created}
                        </div>
                        <div className="text-xs text-muted-foreground">اتاستوردت</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-amber-600">
                          {importResult.failed}
                        </div>
                        <div className="text-xs text-muted-foreground">فشلت</div>
                      </div>
                      <div>
                        <div className="text-2xl font-bold text-muted-foreground">
                          {importResult.total}
                        </div>
                        <div className="text-xs text-muted-foreground">إجمالي الصفوف</div>
                      </div>
                    </div>
                    {importResult.results?.some((r: any) => r.status === "failed") && (
                      <div className="mt-3 space-y-1 max-h-32 overflow-y-auto">
                        {importResult.results
                          .filter((r: any) => r.status === "failed")
                          .map((r: any, i: number) => (
                            <div key={i} className="text-xs text-destructive">
                              صف {r.row}: {r.userEmail} — {r.error}
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
          <EmptyBlock message="مفيش مدفوعات لسه." />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>المستخدم</TableHead>
                  <TableHead>المبلغ</TableHead>
                  <TableHead>الطريقة</TableHead>
                  <TableHead>المرجع</TableHead>
                  <TableHead>التاريخ</TableHead>
                  <TableHead>الحالة</TableHead>
                  <TableHead className="text-left">إجراءات</TableHead>
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
          <h2 className="text-xl font-bold">الاشتراكات</h2>
          <p className="text-xs text-muted-foreground">كل اشتراكات الطلاب</p>
        </div>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">كل الحالات</SelectItem>
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
          <EmptyBlock message="مفيش اشتراكات لسه." />
        ) : (
          <div className="max-h-[70vh] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>الطالب</TableHead>
                  <TableHead>الباقة</TableHead>
                  <TableHead>السعر</TableHead>
                  <TableHead>البداية</TableHead>
                  <TableHead>النهاية</TableHead>
                  <TableHead>الحالة</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.subscriptions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>
                      <div className="text-sm font-medium">{s.studentName || "—"}</div>
                      <div className="text-xs text-muted-foreground">{s.studentEmail}</div>
                    </TableCell>
                    <TableCell>{s.plan?.nameAr || "—"}</TableCell>
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
      toast.error("العنوان والرسالة مطلوبين");
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
      toast.success(`اترسل الإشعار لـ ${j.sent} مستخدم`);
      setForm({ ...form, title: "", message: "" });
      reload();
    } catch (e: any) {
      toast.error(e.message || "حصلت مشكلة. حاول تاني.");
    } finally {
      setSending(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div>
        <h2 className="text-xl font-bold">الإشعارات</h2>
        <p className="text-xs text-muted-foreground">إرسال إشعارات للمستخدمين ومتابعة الأحدث</p>
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
            <CardDescription>اختر الجمهور واكتب الرسالة</CardDescription>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            <div>
              <Label>الجمهور</Label>
              <Select value={form.target} onValueChange={(v) => setForm({ ...form, target: v })}>
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">كل المستخدمين</SelectItem>
                  <SelectItem value="students">الطلاب</SelectItem>
                  <SelectItem value="parents">أولياء الأمور</SelectItem>
                  <SelectItem value="teachers">المعلمون</SelectItem>
                  <SelectItem value="group">مجموعة محددة</SelectItem>
                  <SelectItem value="user">مستخدم محدد</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {form.target === "group" && (
              <div>
                <Label>المجموعة</Label>
                <Select value={form.groupId} onValueChange={(v) => setForm({ ...form, groupId: v })}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="اختر المجموعة" />
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
              <Label>النوع</Label>
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
              <Label>العنوان</Label>
              <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div>
              <Label>الرسالة</Label>
              <Textarea value={form.message} onChange={(e) => setForm({ ...form, message: e.target.value })} rows={3} />
            </div>
            <Button onClick={submit} disabled={sending} className="w-full">
              {sending ? "جارٍ الإرسال..." : "إرسال"}
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
            <CardDescription>آخر 30 إشعار اتبعتوا</CardDescription>
          </CardHeader>
          <CardContent className="px-0">
            {loading ? (
              <LoadingBlock rows={4} />
            ) : error ? (
              <ErrorBlock message={error} onRetry={reload} />
            ) : !data || data.notifications.length === 0 ? (
              <EmptyBlock message="مفيش إشعارات لسه." />
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
  { key: "brand_name", label: "اسم الأكاديمية", type: "text" },
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
      toast.success("اتحفظت الإعدادات");
      reload();
    } catch {
      toast.error("حصلت مشكلة. حاول تاني.");
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
          الإعدادات
        </h2>
        <p className="text-xs text-muted-foreground">إدارة بيانات الـBrand والأسعار والإعدادات العامة</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-4">
          <CardHeader className="px-0 pt-0">
            <CardTitle className="text-base">Brand Settings</CardTitle>
            <CardDescription>بيانات الأكاديمية والتواصل</CardDescription>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            {SETTING_KEYS.filter((k) => k.type === "text").map((k) => (
              <div key={k.key}>
                <Label>{k.label}</Label>
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
            <CardDescription>أسعار الباقات بالـEGP</CardDescription>
          </CardHeader>
          <CardContent className="px-0 space-y-3">
            {SETTING_KEYS.filter((k) => k.type === "number").map((k) => (
              <div key={k.key}>
                <Label>{k.label}</Label>
                <Input
                  type="number"
                  value={values[k.key] ?? ""}
                  onChange={(e) => setValues({ ...values, [k.key]: e.target.value })}
                />
              </div>
            ))}
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-muted-foreground">
              ملاحظة: تغيير الأسعار بيأثر على الباقات الجديدة بس، اللي موجود بالفعل مش بيتغيّر.
            </div>
          </CardContent>
        </Card>
      </div>

      <div className="flex justify-end">
        <Button onClick={save} disabled={saving} size="lg">
          <Save className="w-4 h-4 ml-2" />
          {saving ? "جارٍ الحفظ..." : "حفظ الإعدادات"}
        </Button>
      </div>
    </motion.div>
  );
}

// ============================================================
// Coupons View — manage discount codes
// ============================================================
function CouponsView() {
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
        toast.error(d.error || "فشل إنشاء الكود");
        return;
      }
      toast.success("اتعمل الكود بنجاح 🎉");
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
    toast.success(!current ? "اتفعل الكود" : "اتوقف الكود");
    reload();
  };

  const del = async (id: string) => {
    if (!confirm("متأكد تمسح الكود ده؟")) return;
    await fetch(`/api/admin/coupons/${id}`, { method: "DELETE" });
    toast.success("اتمسح الكود");
    reload();
  };

  return (
    <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold">أكواد الخصم</h2>
          <p className="text-sm text-muted-foreground mt-1">
            إدارة أكواد الخصم والـCoupons
          </p>
        </div>
        <Button onClick={() => setShowCreate((s) => !s)} className="font-bold">
          <Plus className="w-4 h-4 ml-2" />
          كود جديد
        </Button>
      </div>

      {showCreate && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
        >
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base">إنشاء كود خصم جديد</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">الكود</Label>
                  <Input
                    value={createForm.code}
                    onChange={(e) => setCreateForm({ ...createForm, code: e.target.value.toUpperCase() })}
                    placeholder="WELCOME10"
                    className="font-mono uppercase mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">النوع</Label>
                  <Select
                    value={createForm.type}
                    onValueChange={(v) => setCreateForm({ ...createForm, type: v })}
                  >
                    <SelectTrigger className="mt-1">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="PERCENTAGE">نسبة مئوية %</SelectItem>
                      <SelectItem value="FIXED">مبلغ ثابت EGP</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="text-xs">{createForm.type === "PERCENTAGE" ? "النسبة (%)" : "المبلغ (EGP)"}</Label>
                  <Input
                    type="number"
                    value={createForm.value}
                    onChange={(e) => setCreateForm({ ...createForm, value: e.target.value })}
                    placeholder={createForm.type === "PERCENTAGE" ? "10" : "50"}
                    className="mt-1"
                  />
                </div>
                <div>
                  <Label className="text-xs">أقصى استخدام</Label>
                  <Input
                    type="number"
                    value={createForm.maxUses}
                    onChange={(e) => setCreateForm({ ...createForm, maxUses: e.target.value })}
                    className="mt-1"
                  />
                </div>
              </div>
              <div>
                <Label className="text-xs">وصف (اختياري)</Label>
                <Input
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  placeholder="خصم الترحيب بالطلاب الجدد"
                  className="mt-1"
                />
              </div>
              <div className="flex items-center gap-2">
                <Button onClick={create} disabled={creating || !createForm.code || !createForm.value}>
                  {creating ? "جارٍ..." : "احفظ الكود"}
                </Button>
                <Button variant="ghost" onClick={() => setShowCreate(false)}>
                  إلغاء
                </Button>
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
            <p className="text-sm text-muted-foreground">مفيش أكواد خصم لسه</p>
            <p className="text-xs text-muted-foreground mt-1">
              اضغط "كود جديد" عشان تعمل أول كود
            </p>
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
                        {c.isActive ? "شغال" : "متوقف"}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {c.type === "PERCENTAGE" ? `${c.value}% خصم` : `${c.value} EGP خصم`}
                      {" · "}
                      استُخدم {c.usedCount}/{c.maxUses} مرة
                      {" · "}
                      {c.redemptionsCount} طالب استخدمه
                    </div>
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
                      {c.isActive ? "إيقاف" : "تفعيل"}
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
          تحليل تفصيلي للإيرادات والمدفوعات
        </p>
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
            مقارنة بالشهر اللي فات — {ov.pendingPayments} دفعة مستنية المراجعة
          </p>
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
            <CardDescription>آخر 6 شهور — بالـBar Chart</CardDescription>
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
            <CardDescription>توزيع طرق الدفع</CardDescription>
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
                    <span className="text-muted-foreground">{m.count} دفعة · {m.revenue} EGP</span>
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
          {unit && <span className="text-xs text-muted-foreground mr-1"> {unit}</span>}
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
                  <Badge variant="outline" className="text-[10px] ml-1">
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
            <EmptyBlock message="مفيش إشعارات لسه" />
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
          توقعات الإيرادات للـ3 شهور الجاية بناءً على الاتجاه الحالي
        </p>
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
            الاتجاه: {trendUp ? "نامي ↑" : trendNeutral ? "مستقر →" : "تنازلي ↓"}
            {m.trendPercentage !== 0 && ` (${m.trendPercentage > 0 ? "+" : ""}${m.trendPercentage}%)`}
          </div>
          <p className="text-xs text-muted-foreground">
            متوسط الإيراد الشهري: {m.avgMonthlyRevenue} EGP · نمو الشهر ده: {m.monthOverMonthGrowth > 0 ? "+" : ""}{m.monthOverMonthGrowth}%
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
              <div className="text-xs text-muted-foreground mt-0.5">EGP (3 شهور قادمة)</div>
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
                        {f.confidence === "high" ? "ثقة عالية" : f.confidence === "medium" ? "ثقة متوسطة" : "ثقة منخفضة"}
                      </Badge>
                    </div>
                  </div>
                  <div className="text-left">
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
