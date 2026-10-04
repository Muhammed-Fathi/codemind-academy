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
  /**
   * Phase M4.4 — the canonical curriculum-container ID is the identity of a
   * strong/weak row (the container titles are reused across curricula, so a
   * title is not a key), and `academicLevel` is the level context of the course
   * these rows were measured in. Both are ADDITIVE: the titles and the average
   * math are unchanged.
   */
  strongTopics: { id: string; title: string; avgPct: number; academicLevel?: string | null }[];
  weakTopics: { id: string; title: string; avgPct: number; academicLevel?: string | null }[];
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
          /* Phase M4.5 — the strip SCROLLS instead of overflowing the viewport
             (audit M4-F7: it used to be a plain `flex gap-2`, so three or more
             children pushed the page sideways at phone widths). `snap-x` +
             `shrink-0` keep every tab reachable and legible with long names;
             the label is capped and truncated so one long child cannot stretch
             the row. Identity stays the CANONICAL studentId (key + state). */
          className="flex gap-2 overflow-x-auto pb-1 -mb-1 snap-x"
          role="tablist"
          aria-label={tr("parent.switcher.label")}
        >
          {registry.map((c) => (
            <button
              key={c.studentId}
              type="button"
              role="tab"
              onClick={() => setSelectedId(c.studentId)}
              aria-selected={selectedId === c.studentId}
              className={`snap-start shrink-0 max-w-[15rem] text-start px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
                selectedId === c.studentId
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "bg-muted/50 text-muted-foreground hover:bg-primary/10 hover:text-primary"
              }`}
            >
              <span className="block truncate">{c.name}</span>
              <span className="block truncate text-[10px] font-normal opacity-80">
                {academicLevelLabelFor(tr, c.academicLevel)}
                {c.course ? ` · ${c.course}` : ""}
              </span>
            </button>
          ))}
        </div>
      )}

      {/* Overview stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {/* Phase M4.5 — every label comes from the dictionary (they were
            hard-coded English on an Arabic-first screen: audit M4-F7). */}
        <AnalyticsStat
          icon={CheckCircle2}
          label={tr("parent.report.courseProgress")}
          value={`${child.completionPct}%`}
          sub={tr("parent.report.lessonsCount", {
            p1: child.completedLessons,
            p2: child.totalLessons,
          })}
          color="from-emerald-400 to-teal-500"
        />
        <AnalyticsStat
          icon={CalendarDays}
          label={tr("parent.report.attendance")}
          value={`${child.attendancePct}%`}
          sub={tr("parent.004")}
          color="from-teal-400 to-cyan-500"
        />
        <AnalyticsStat
          icon={Trophy}
          label={tr("parent.report.quizAverage")}
          value={`${child.avgQuizPct}%`}
          sub={tr("parent.analytics.quizzesCount", { p1: child.totalQuizzes })}
          color="from-amber-400 to-orange-500"
        />
        <AnalyticsStat
          icon={BookOpen}
          label={tr("parent.report.homework")}
          value={`${child.homeworkGraded}`}
          sub={tr("parent.analytics.avgGrade", { p1: child.homeworkAvgGrade })}
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
              {tr("parent.analytics.quizTrend")}
            </CardTitle>
            <CardDescription className="text-xs">{tr("parent.005")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div dir="ltr" data-dir="chart" className="w-full h-56">
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
                    formatter={(v: any) => [`${v}%`, tr("parent.028")]}
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
              {tr("parent.analytics.attendanceByMonth")}
            </CardTitle>
            <CardDescription className="text-xs">{tr("parent.004")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div dir="ltr" data-dir="chart" className="w-full h-56">
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
                    formatter={(v: any) => [`${v}%`, tr("parent.report.attendance")]}
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
              {tr("parent.dashboard.strongTopics")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {child.strongTopics.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tr("parent.007")}</p>
            ) : (
              child.strongTopics.map((t) => (
                <div key={t.id} className="flex items-center gap-3 p-2 rounded-lg bg-emerald-500/5 border border-emerald-400/20">
                  <div className="grid place-items-center w-7 h-7 rounded-md bg-emerald-500/10 text-emerald-600 text-xs font-bold">
                    {t.avgPct}%
                  </div>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{t.title}</span>
                    {/* Canonical level context of the course these rows belong
                        to — the vocabulary shared with every other surface. */}
                    <span className="block text-[10px] text-muted-foreground">
                      {academicLevelLabelFor(tr, t.academicLevel)}
                    </span>
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2 text-amber-600">
              <AlertTriangle className="w-5 h-5" />
              {tr("parent.dashboard.weakTopics")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {child.weakTopics.length === 0 ? (
              <p className="text-xs text-muted-foreground">{tr("parent.007")}</p>
            ) : (
              child.weakTopics.map((t) => (
                <div key={t.id} className="flex items-center gap-3 p-2 rounded-lg bg-amber-500/5 border border-amber-400/20">
                  <div className="grid place-items-center w-7 h-7 rounded-md bg-amber-500/10 text-amber-600 text-xs font-bold">
                    {t.avgPct}%
                  </div>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm truncate">{t.title}</span>
                    <span className="block text-[10px] text-muted-foreground">
                      {academicLevelLabelFor(tr, t.academicLevel)}
                    </span>
                  </span>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      {/* Progress ring */}
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base">{tr("parent.analytics.courseCompletion")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center justify-center">
          <div dir="ltr" data-dir="chart" className="w-48 h-48">
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
            <div className="text-xs text-muted-foreground">
              {tr("parent.report.lessonsCount", {
                p1: child.completedLessons,
                p2: child.totalLessons,
              })}
            </div>
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
