"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useApp } from "@/lib/store";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
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
  BookOpen,
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

const DAY_NAMES = ["الأحد", "الإثنين", "الثلاثاء", "الأربعاء", "الخميس", "الجمعة", "السبت"];
const MONTH_NAMES = [
  "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
  "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
];

export function StudySchedulerView() {
  const setView = useApp((s) => s.setView);
  const [tasks, setTasks] = React.useState<Task[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [currentMonth, setCurrentMonth] = React.useState(new Date());
  const [selectedDate, setSelectedDate] = React.useState<Date | null>(null);
  const [showAdd, setShowAdd] = React.useState(false);
  const [newTask, setNewTask] = React.useState({ title: "", description: "", durationMin: "60" });
  const [saving, setSaving] = React.useState(false);

  const reload = React.useCallback(() => {
    setLoading(true);
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const from = new Date(year, month, 1).toISOString();
    const to = new Date(year, month + 1, 0, 23, 59, 59).toISOString();
    fetch(`/api/students/me/study-plan?from=${from}&to=${to}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setTasks(d?.tasks || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [currentMonth]);

  React.useEffect(() => {
    reload();
  }, [reload]);

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
        toast.error("فشل حفظ المهمة");
        return;
      }
      toast.success("اتضافت المهمة 📅");
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
    toast.success("اتمسحت المهمة");
    reload();
  };

  // Calendar grid
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

  const tasksForDate = (date: Date) =>
    tasks.filter((t) => {
      const td = new Date(t.scheduledDate);
      return (
        td.getDate() === date.getDate() &&
        td.getMonth() === date.getMonth() &&
        td.getFullYear() === date.getFullYear()
      );
    });

  const selectedTasks = selectedDate ? tasksForDate(selectedDate) : [];

  return (
    <div className="space-y-4">
      <button
        onClick={() => setView("student-dashboard")}
        className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
      >
        <ChevronLeft className="w-4 h-4 flip-rtl" />
        رجوع
      </button>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
        <Card className="glass card-hover">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2.5">
                <div className="grid place-items-center w-11 h-11 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg">
                  <Calendar className="w-5 h-5" />
                </div>
                <div>
                  <CardTitle className="text-xl">Study Scheduler</CardTitle>
                  <CardDescription>
                    خطط أيام دراستك وتابع التزامك
                  </CardDescription>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setCurrentMonth(new Date(year, month - 1, 1))}
                >
                  <ChevronRight className="w-4 h-4" />
                </Button>
                <div className="text-sm font-bold min-w-[120px] text-center">
                  {MONTH_NAMES[month]} {year}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setCurrentMonth(new Date(year, month + 1, 1))}
                >
                  <ChevronLeft className="w-4 h-4" />
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            {/* Calendar grid */}
            <div className="grid grid-cols-7 gap-1.5 mb-3">
              {DAY_NAMES.map((d) => (
                <div key={d} className="text-center text-xs font-bold text-muted-foreground py-2">
                  {d}
                </div>
              ))}
            </div>
            <div className="grid grid-cols-7 gap-1.5">
              {cells.map((date, i) => {
                if (!date) return <div key={i} />;
                const dayTasks = tasksForDate(date);
                const isToday = date.getTime() === today.getTime();
                const isSelected = selectedDate?.getTime() === date.getTime();
                const hasDone = dayTasks.some((t) => t.status === "DONE");
                const hasPending = dayTasks.some((t) => t.status === "PENDING");
                return (
                  <button
                    key={i}
                    onClick={() => setSelectedDate(date)}
                    className={`relative aspect-square rounded-lg border-2 p-1.5 text-right transition-all hover:scale-105 ${
                      isSelected
                        ? "border-primary bg-primary/10 shadow-sm"
                        : isToday
                        ? "border-amber-400/50 bg-amber-400/5"
                        : "border-border/40 hover:border-primary/30"
                    }`}
                  >
                    <div className={`text-xs font-bold ${isToday ? "text-amber-600" : ""}`}>
                      {date.getDate()}
                    </div>
                    {dayTasks.length > 0 && (
                      <div className="absolute bottom-1 left-1 flex gap-0.5">
                        {hasDone && (
                          <div className="w-1.5 h-1.5 rounded-full bg-primary" />
                        )}
                        {hasPending && (
                          <div className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                        )}
                      </div>
                    )}
                    {dayTasks.length > 0 && (
                      <div className="absolute top-1 right-1 text-[9px] font-bold text-muted-foreground">
                        {dayTasks.length}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-primary" />
                خلصت
              </div>
              <div className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-amber-400" />
                مستنية
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
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">
                    {DAY_NAMES[selectedDate.getDay()]}، {selectedDate.getDate()} {MONTH_NAMES[selectedDate.getMonth()]}
                  </CardTitle>
                  <CardDescription className="text-xs">
                    {selectedTasks.length} مهمة · {selectedTasks.filter((t) => t.status === "DONE").length} خلصت
                  </CardDescription>
                </div>
                <Button size="sm" onClick={() => setShowAdd((s) => !s)}>
                  <Plus className="w-4 h-4 ml-1" />
                  أضف مهمة
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
                      placeholder="عنوان المهمة (مثال: مراجعة Neural Networks)"
                      autoFocus
                    />
                    <Textarea
                      value={newTask.description}
                      onChange={(e) => setNewTask({ ...newTask, description: e.target.value })}
                      placeholder="تفاصيل (اختياري)"
                      className="min-h-[60px] resize-none"
                    />
                    <div className="flex items-center gap-2">
                      <div className="flex items-center gap-1.5">
                        <Clock className="w-4 h-4 text-muted-foreground" />
                        <Input
                          type="number"
                          value={newTask.durationMin}
                          onChange={(e) => setNewTask({ ...newTask, durationMin: e.target.value })}
                          className="w-20"
                        />
                        <span className="text-xs text-muted-foreground">دقيقة</span>
                      </div>
                      <Button onClick={addTask} disabled={!newTask.title.trim() || saving} size="sm">
                        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : "احفظ"}
                      </Button>
                      <Button variant="ghost" size="sm" onClick={() => setShowAdd(false)}>
                        <X className="w-4 h-4" />
                      </Button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {loading ? (
                <Skeleton className="h-16" />
              ) : selectedTasks.length === 0 ? (
                <div className="text-center py-6">
                  <Calendar className="w-8 h-8 text-muted-foreground/40 mx-auto mb-1.5" />
                  <p className="text-xs text-muted-foreground">
                    مفيش مهام في اليوم ده. اضغط "أضف مهمة" عشان تخطط.
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {selectedTasks.map((t) => (
                    <motion.div
                      key={t.id}
                      initial={{ opacity: 0, x: 10 }}
                      animate={{ opacity: 1, x: 0 }}
                      className={`group flex items-center gap-3 p-3 rounded-lg border transition-all ${
                        t.status === "DONE"
                          ? "border-primary/30 bg-primary/5"
                          : "border-border/60 hover:border-primary/30"
                      }`}
                    >
                      <button
                        onClick={() => toggleStatus(t)}
                        className="shrink-0 hover:scale-110 transition-transform"
                      >
                        {t.status === "DONE" ? (
                          <CheckCircle2 className="w-5 h-5 text-primary" />
                        ) : (
                          <Circle className="w-5 h-5 text-muted-foreground" />
                        )}
                      </button>
                      <div className="flex-1 min-w-0">
                        <div className={`text-sm font-semibold ${t.status === "DONE" ? "line-through text-muted-foreground" : ""}`}>
                          {t.title}
                        </div>
                        {t.description && (
                          <div className="text-xs text-muted-foreground mt-0.5 truncate">
                            {t.description}
                          </div>
                        )}
                        <div className="flex items-center gap-2 mt-1">
                          <Badge variant="outline" className="text-[10px]">
                            <Clock className="w-2.5 h-2.5 ml-1" />
                            {t.durationMin} دقيقة
                          </Badge>
                        </div>
                      </div>
                      <button
                        onClick={() => deleteTask(t.id)}
                        className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/5 opacity-0 group-hover:opacity-100 transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
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
