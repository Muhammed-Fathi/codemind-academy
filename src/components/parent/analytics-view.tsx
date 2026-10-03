"use client";
import { useT , pickAuto } from "@/lib/i18n";
import { academicLevelLabelFor } from "@/lib/academic-level-labels";
import { useApp } from "@/lib/store";

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
  /** Canonical identity — never matched by name. */
  studentId: string;
  name: string;
  email: string;
  course: string;
  groupName: string;
  /**
   * Phase M4.3 — the child's canonical Academic Level (course chain first,
   * then the assignment). The child TAB is labelled with it; nothing on the
   * client derives a level from a course/group name or from `Student.grade`.
   */
  academicLevel?: string | null;
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

export function ParentAnalyticsView({
  onClose,
  initialStudentId,
}: {
  onClose: () => void;
  /** Linked child to select first (defaults to the first linked child). */
  initialStudentId?: string | null;
}) {
  const tr = useT();
  const storedChildId = useApp((st) => st.parentChildId);
  const setStoredChildId = useApp((st) => st.setParentChildId);

  /**
   * Phase M4.3 — the analytics surface reuses the SHARED Parent child context
   * (`parentChildId`, seeded by the dashboard) and keys every request by the
   * canonical `studentId` it resolves to.
   *
   * `registry` is identity + context only (id, name, level, course) and is
   * read once from the linked-children payload; `rows` caches the analytics of
   * each child BY canonical id, so a late response for child A can never be
   * rendered for child B — the map is keyed, not positional.
   */
  const [registry, setRegistry] = React.useState<ChildAnalytics[] | null>(null);
  const [rows, setRows] = React.useState<Record<string, ChildAnalytics>>({});
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState(false);
  // Monotonic request sequence: only the newest request may write state, so a
  // slow response for a child the parent has switched away from is dropped.
  const requestSeq = React.useRef(0);

  // One linked-children read: the tab list must not shrink when a scoped
  // request narrows the payload to the selected child alone.
  React.useEffect(() => {
    const controller = new AbortController();
    const seq = ++requestSeq.current;
    fetch("/api/parents/me/analytics", { cache: "no-store", signal: controller.signal })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (seq !== requestSeq.current) return; // superseded
        const list: ChildAnalytics[] = d?.children ?? [];
        // Identity + context ONLY: the tab list is built from this read, but
        // the NUMBERS below are never taken from it — each child's row is
        // populated by that child's own keyed request, so a switch can never
        // paint one child's numbers against another child's name.
        setRegistry(list.map((c) => ({ ...c })));
        // Selection order: the id this view was opened with (the dashboard's
        // child), then the SHARED context, then the first linked child — always
        // an id from the server payload, never a name or an array index.
        setSelectedId((current) => {
          if (current && list.some((c) => c.studentId === current)) return current;
          for (const candidate of [initialStudentId, storedChildId]) {
            if (candidate && list.some((c) => c.studentId === candidate)) return candidate;
          }
          return list[0]?.studentId ?? null;
        });
      })
      .catch(() => {
        if (seq === requestSeq.current && !controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
    return () => controller.abort();
    // Mount-only on purpose: the linked-children read builds the tab list once
    // (it must not shrink when a scoped request narrows the payload). The
    // SHARED context is read at mount and every switch writes it back.
  }, []);

  // Every child SWITCH is a request keyed by the canonical id — the server
  // re-verifies the ParentStudentLink and answers 404 for anything else. The
  // in-flight request is aborted, and the sequence guard drops any late
  // response/error from the child we just left.
  const loadedIds = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
    if (!selectedId) return;
    setStoredChildId(selectedId);
    // A row already loaded for THIS child is its own data (keyed by id), not a
    // stale neighbour — a re-visit serves it; a first visit fetches it.
    if (loadedIds.current.has(selectedId)) return;
    // The new child starts EMPTY: its row must come from its own request.
    setRows((prev) => {
      if (!(selectedId in prev)) return prev;
      const next = { ...prev };
      delete next[selectedId];
      return next;
    });
    const controller = new AbortController();
    const seq = ++requestSeq.current;
    fetch(`/api/parents/me/analytics?studentId=${encodeURIComponent(selectedId)}`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (seq !== requestSeq.current) return; // a newer child won
        const list: ChildAnalytics[] = d?.children ?? [];
        if (list.length === 0) return;
        loadedIds.current.add(selectedId);
        setRows((prev) => {
          const next = { ...prev };
          // Keyed by the id the SERVER returned — never by array position, so
          // a late response can only ever write its own child's slot.
          for (const c of list) next[c.studentId] = c;
          return next;
        });
        // The registry never loses a child the parent can still switch to.
        setRegistry((prev) => {
          if (prev && prev.some((c) => c.studentId === selectedId)) return prev;
          return [...(prev ?? []), ...list];
        });
      })
      .catch(() => {
        if (seq === requestSeq.current && !controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [selectedId, setStoredChildId]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  if (error || !registry || registry.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <BarChart3 className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">{tr("parent.002")}</p>
        </CardContent>
      </Card>
    );
  }

  // The rendered child is resolved BY ID. Until that child's own row has
  // arrived, the body is a skeleton — the previous child's numbers are never
  // shown against the new selection.
  const child = selectedId ? rows[selectedId] : undefined;
  if (!child) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={onClose}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        {tr("parent.003")}</button>

      {/* Child selector — keyed by canonical studentId, labelled with the
          child's name AND canonical Academic Level (name alone cannot tell two
          same-named children, or two children in identically-named courses,
          apart). */}
      {registry.length > 1 && (
        <div
          className="flex gap-2 overflow-x-auto pb-1"
          role="tablist"
          aria-label={tr("parent.003")}
        >
          {registry.map((c) => (
            <button
              key={c.studentId}
              type="button"
              role="tab"
              onClick={() => setSelectedId(c.studentId)}
              aria-selected={selectedId === c.studentId}
              className={`px-4 py-2 rounded-lg text-sm font-semibold transition-all shrink-0 ${
                selectedId === c.studentId
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted/50 text-muted-foreground hover:bg-primary/10 hover:text-primary"
              }`}
            >
              {c.name}
              <span className="block text-[10px] font-normal opacity-80">
                {academicLevelLabelFor(tr, c.academicLevel)}
                {c.course ? ` · ${c.course}` : ""}
              </span>
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
          sub={tr("parent.004")}
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
            <CardDescription className="text-xs">{tr("parent.005")}</CardDescription>
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
            <CardDescription className="text-xs">{tr("parent.004")}</CardDescription>
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
              <p className="text-xs text-muted-foreground">{tr("parent.007")}</p>
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
              <p className="text-xs text-muted-foreground">{tr("parent.007")}</p>
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
