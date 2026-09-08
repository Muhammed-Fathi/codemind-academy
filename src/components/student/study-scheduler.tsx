"use client";
import { useT } from "@/lib/i18n";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  Calendar,
  Plus,
  Clock,
  CheckCircle2,
  Circle,
  Trash2,
  ChevronLeft,
  ChevronRight,
  Loader2,
  X,
} from "lucide-react";

type Task = {
  id: string;
  title: string;
  description: string | null;
  lessonId: string | null;
  scheduledDate: string;
  durationMin: number;
  status: string;
};

// Day/month labels are i18n keys — MUST be passed through tr() before render.
// (Root-cause of the student.198…student.204 raw-key leak: headers rendered the
// key strings directly instead of translating them.)
const DAY_NAME_KEYS = [
  "student.198",
  "student.199",
  "student.200",
  "student.201",
  "student.202",
  "student.203",
  "student.204",
] as const;
const MONTH_NAME_KEYS = [
  "student.205",
  "student.206",
  "student.207",
  "student.208",
  "student.209",
  "student.210",
  "student.211",
  "student.212",
  "student.213",
  "student.214",
  "student.215",
  "student.216",
] as const;

function sameCalendarDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Local YYYY-MM-DD — locale-independent day identity for task matching. */
function localDayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function StudySchedulerView() {
  const tr = useT();
  const setView = useApp((s) => s.setView);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [currentMonth, setCurrentMonth] = React.useState(new Date());
  const [selectedDate, setSelectedDate] = React.useState<Date | null>(null);
  const [showAdd, setShowAdd] = React.useState(false);
  const [newTask, setNewTask] = React.useState({ title: "", description: "", durationMin: "60" });
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const from = new Date(year, month, 1).toISOString();
    const to = new Date(year, month + 1, 0, 23, 59, 59).toISOString();
    let cancelled = false;
    // Defer the loading flag so the effect body itself never calls setState
    // synchronously (react-hooks/set-state-in-effect).
    const tick = queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      fetch(`/api/students/me/study-plan?from=${from}&to=${to}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled) setTasks(d?.tasks || []);
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    });
    return () => {
      cancelled = true;
      // queueMicrotask has no cancel handle; the cancelled flag is enough.
      void tick;
    };
  }, [currentMonth]);

  const reload = React.useCallback(() => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const from = new Date(year, month, 1).toISOString();
    const to = new Date(year, month + 1, 0, 23, 59, 59).toISOString();
    setLoading(true);
    fetch(`/api/students/me/study-plan?from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTasks(d?.tasks || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [currentMonth]);

  const addTask = async () => {
    if (!newTask.title.trim() || !selectedDate) return;
    setSaving(true);
    try {
      const r = await fetch("/api/students/me/study-plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTask.title,
          description: newTask.description || undefined,
          scheduledDate: selectedDate.toISOString(),
          durationMin: parseInt(newTask.durationMin, 10) || 60,
        }),
      });
      if (!r.ok) {
        toast.error(tr("student.217"));
        return;
      }
      toast.success(tr("student.218"));
      setNewTask({ title: "", description: "", durationMin: "60" });
      setShowAdd(false);
      reload();
    } finally {
      setSaving(false);
    }
  };

  const toggleStatus = async (task: Task) => {
    const newStatus = task.status === "DONE" ? "PENDING" : "DONE";
    await fetch("/api/students/me/study-plan", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId: task.id, status: newStatus }),
    });
    reload();
  };

  const deleteTask = async (taskId: string) => {
    await fetch(`/api/students/me/study-plan?taskId=${encodeURIComponent(taskId)}`, {
      method: "DELETE",
    });
    toast.success(tr("student.219"));
    reload();
  };

  // Calendar grid — weekday order is Sun→Sat (Date#getDay), identical in AR/EN.
  // Only labels change with locale; cell identity stays local calendar dates.
  const year = currentMonth.getFullYear();
  const month = currentMonth.getMonth();
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const startWeekday = firstDay.getDay();
  const daysInMonth = lastDay.getDate();
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const cells: (Date | null)[] = [];
  for (let i = 0; i < startWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);

  const tasksForDate = (date: Date) => {
    const key = localDayKey(date);
    return tasks.filter((t) => localDayKey(new Date(t.scheduledDate)) === key);
  };

  const selectedTasks = selectedDate ? tasksForDate(selectedDate) : [];
  const monthLabel = `${tr(MONTH_NAME_KEYS[month])} ${year}`;
  const goPrevMonth = () => setCurrentMonth(new Date(year, month - 1, 1));
  const goNextMonth = () => setCurrentMonth(new Date(year, month + 1, 1));
  const goToday = () => {
    const now = new Date();
    setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
    setSelectedDate(new Date(now.getFullYear(), now.getMonth(), now.getDate()));
  };

  return (
    <div className="space-y-4" data-testid="study-scheduler">
      <button
        type="button"
        onClick={() => setView("student-dashboard")}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4 flip-rtl" />
        {tr("student.220")}
      </button>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="glass card-hover">
          <CardHeader className="space-y-3">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="grid place-items-center w-11 h-11 shrink-0 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg">
                  <Calendar className="w-5 h-5" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <CardTitle className="text-xl truncate">{tr("student.243")}</CardTitle>
                  <CardDescription className="truncate">
                    {tr("student.221")}
                  </CardDescription>
                </div>
              </div>
              {/* Month nav is dir=ltr so previous is always left / next always right —
                  calendar time progression stays stable across RTL and LTR. */}
              <div
                className="flex items-center justify-center gap-1 sm:gap-2"
                dir="ltr"
                role="group"
                aria-label={monthLabel}
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="min-h-9 min-w-9"
                  onClick={goPrevMonth}
                  aria-label={tr("student.244")}
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </Button>
                <div
                  className="text-sm font-bold min-w-[8.5rem] sm:min-w-[10rem] text-center tabular-nums"
                  aria-live="polite"
                >
                  {monthLabel}
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="min-h-9 min-w-9"
                  onClick={goNextMonth}
                  aria-label={tr("student.245")}
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="ms-1 min-h-9"
                  onClick={goToday}
                  aria-label={tr("student.246")}
                >
                  {tr("student.246")}
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Weekday headers — always translated via tr(); never render raw keys. */}
            <div
              className="grid grid-cols-7 gap-1 sm:gap-1.5 mb-3"
              role="row"
              aria-hidden="false"
            >
              {DAY_NAME_KEYS.map((key) => (
                <div
                  key={key}
                  role="columnheader"
                  className="text-center text-[10px] sm:text-xs font-bold text-muted-foreground py-2 truncate"
                  title={tr(key)}
                >
                  {tr(key)}
                </div>
              ))}
            </div>
            <div
              className="grid grid-cols-7 gap-1 sm:gap-1.5"
              role="grid"
              aria-label={monthLabel}
            >
              {cells.map((date, i) => {
                if (!date) {
                  return (
                    <div
                      key={`empty-${i}`}
                      role="gridcell"
                      aria-hidden="true"
                      className="aspect-square min-h-9"
                    />
                  );
                }
                const dayTasks = tasksForDate(date);
                const isToday = sameCalendarDay(date, today);
                const isSelected = selectedDate ? sameCalendarDay(selectedDate, date) : false;
                const hasDone = dayTasks.some((t) => t.status === "DONE");
                const hasPending = dayTasks.some((t) => t.status === "PENDING");
                const dayAria = [
                  tr(DAY_NAME_KEYS[date.getDay()]),
                  date.getDate(),
                  tr(MONTH_NAME_KEYS[date.getMonth()]),
                  year,
                  isToday ? tr("student.246") : "",
                  dayTasks.length
                    ? `${dayTasks.length} ${tr("student.225")}`
                    : "",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <button
                    key={localDayKey(date)}
                    type="button"
                    role="gridcell"
                    aria-label={dayAria}
                    aria-current={isToday ? "date" : undefined}
                    aria-selected={isSelected}
                    data-selected={isSelected ? "true" : undefined}
                    onClick={() => setSelectedDate(date)}
                    className={`relative aspect-square min-h-9 sm:min-h-10 rounded-lg border-2 p-1 sm:p-1.5 text-end transition-all hover:scale-[1.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 ${
                      isSelected
                        ? "border-primary bg-primary/10 shadow-sm dark:bg-primary/20"
                        : isToday
                        ? "border-amber-400/50 bg-amber-400/5 dark:border-amber-400/60 dark:bg-amber-400/10"
                        : "border-border/40 hover:border-primary/30 dark:border-border/60"
                    }`}
                  >
                    <div
                      className={`text-xs font-bold ${
                        isToday
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-foreground"
                      }`}
                    >
                      {date.getDate()}
                    </div>
                    {dayTasks.length > 0 && (
                      <div className="absolute bottom-1 start-1 flex gap-0.5" aria-hidden="true">
                        {hasDone && (
                          <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                        )}
                        {hasPending && (
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        )}
                      </div>
                    )}
                    {dayTasks.length > 0 && (
                      <div
                        className="absolute top-0.5 end-0.5 sm:top-1 sm:end-1 text-[9px] font-bold text-muted-foreground"
                        aria-hidden="true"
                      >
                        {dayTasks.length}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-3 sm:gap-4 mt-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-primary" aria-hidden="true" />
                {tr("student.222")}
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-amber-400" aria-hidden="true" />
                {tr("student.223")}
              </div>
            </div>
          </CardContent>
        </Card>
      </motion.div>

      {/* Selected date tasks */}
      {selectedDate && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="glass">
            <CardHeader>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <CardTitle className="text-base">
                    {tr(DAY_NAME_KEYS[selectedDate.getDay()])}
                    {tr("student.224")}
                    {selectedDate.getDate()}{" "}
                    {tr(MONTH_NAME_KEYS[selectedDate.getMonth()])}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {selectedTasks.length} {tr("student.225")}
                    {selectedTasks.filter((t) => t.status === "DONE").length}{" "}
                    {tr("student.222")}
                  </CardDescription>
                </div>
                <Button
                  size="sm"
                  className="self-start sm:self-auto min-h-9"
                  onClick={() => setShowAdd((s) => !s)}
                >
                  <Plus className="w-4 h-4 ms-1" aria-hidden="true" />
                  {tr("student.227")}
                </Button>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <AnimatePresence>
                {showAdd && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="space-y-2 p-3 rounded-xl bg-muted/30 border border-border/40"
                  >
                    <Input
                      value={newTask.title}
                      onChange={(e) => setNewTask({ ...newTask, title: e.target.value })}
                      placeholder={tr("student.228")}
                      autoFocus
                    />
                    <Textarea
                      value={newTask.description}
                      onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                      placeholder={tr("student.229")}
                      className="min-h-[60px] resize-none"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-4 h-4 text-muted-foreground" aria-hidden="true" />
                        <Input
                          type="number"
                          min={5}
                          max={600}
                          value={newTask.durationMin}
                          onChange={(e) => setNewTask({ ...newTask, durationMin: e.target.value })}
                          className="w-20 min-h-9"
                          aria-label={tr("student.230")}
                        />
                        <span className="text-xs text-muted-foreground">{tr("student.230")}</span>
                      </div>
                      <Button
                        type="button"
                        onClick={addTask}
                        disabled={!newTask.title.trim() || saving}
                        size="sm"
                        className="min-h-9"
                      >
                        {saving ? (
                          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                        ) : (
                          tr("student.231")
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="min-h-9 min-w-9"
                        onClick={() => setShowAdd(false)}
                        aria-label={tr("student.220")}
                      >
                        <X className="w-4 h-4" aria-hidden="true" />
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {loading ? (
                <Skeleton className="h-16" />
              ) : selectedTasks.length === 0 ? (
                <div className="text-center py-6">
                  <Calendar
                    className="w-8 h-8 text-muted-foreground/40 mx-auto mb-1.5"
                    aria-hidden="true"
                  />
                  <p className="text-xs text-muted-foreground">{tr("student.232")}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedTasks.map((task) => (
                    <motion.div
                      key={task.id}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className={`group flex items-center gap-3 p-3 rounded-lg border transition-all ${
                        task.status === "DONE"
                          ? "border-primary/30 bg-primary/5 dark:bg-primary/10"
                          : "border-border/60 hover:border-primary/30"
                      }`}
                    >
                      <button
                        type="button"
                        onClick={() => toggleStatus(task)}
                        className="shrink-0 hover:scale-110 transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 rounded-full min-h-9 min-w-9 grid place-items-center"
                        aria-label={
                          task.status === "DONE" ? tr("student.223") : tr("student.222")
                        }
                        aria-pressed={task.status === "DONE"}
                      >
                        {task.status === "DONE" ? (
                          <CheckCircle2 className="w-5 h-5 text-primary" aria-hidden="true" />
                        ) : (
                          <Circle className="w-5 h-5 text-muted-foreground" aria-hidden="true" />
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div
                          className={`text-sm font-semibold ${
                            task.status === "DONE" ? "line-through text-muted-foreground" : ""
                          }`}
                        >
                          {task.title}
                        </div>
                        {task.description && (
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">
                            {task.description}
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-[10px]">
                            <Clock className="w-2.5 h-2.5 ms-1" aria-hidden="true" />
                            {task.durationMin} {tr("student.230")}
                          </Badge>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => deleteTask(task.id)}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-all focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 min-h-9 min-w-9 grid place-items-center"
                        aria-label={tr("student.219")}
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
                      </button>
                    </motion.div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}
    </div>
  );
}
