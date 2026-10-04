"use client";
import { useT , pickAuto } from "@/lib/i18n";
import { academicLevelLabelFor } from "@/lib/academic-level-labels";

import * as React from "react";
import { motion } from "framer-motion";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { toast } from "sonner";
import {
  CalendarDays,
  BookOpen,
  Trophy,
  ClipboardList,
  CheckCircle2,
  Clock,
  TrendingUp,
  ChevronLeft,
  Activity,
} from "lucide-react";

type WeeklyReport = {
  /** Canonical identity of the child this card belongs to. */
  studentId: string;
  name: string;
  course: string;
  groupName: string;
  /**
   * Phase M4.3 — the canonical Academic Level (course chain first, then the
   * assignment), so every card identifies its child even when two children
   * share the course display name. Still ALL-CHILDREN by default (owner
   * decision D5); no metric is re-scoped here.
   */
  academicLevel?: string | null;
  weekRange: { from: string; to: string };
  summary: {
    lessonsViewed: number;
    quizzesTaken: number;
    homeworkSubmitted: number;
    attendanceSessions: number;
    attendancePct: number;
    bestQuizScore: number;
    avgQuizScore: number;
    activeDays: number;
    completionPct: number;
  };
  dailyActivity: {
    day: string;
    date: string;
    lessons: number;
    quizzes: number;
    homework: number;
    attendance: string | null;
  }[];
  recentQuizzes: { title: string; percentage: number; passed: boolean; date: string }[];
  recentHomework: { title: string; status: string; grade: number | null; date: string }[];
};

export function WeeklyReportView({
  onClose,
  studentId,
}: {
  onClose: () => void;
  /**
   * Phase I — the linked child the report covers (defaults to every linked
   * child). It is sent as `?studentId=`, which the server verifies against
   * this parent's ParentStudentLink rows before answering.
   */
  studentId?: string | null;
}) {
  const t = useT();
  /**
   * Phase M4.3 — the payload is STAMPED with the child it was fetched for and
   * only the stamp matching the CURRENT selection renders. Switching the child
   * therefore drops the previous cards by construction, the in-flight request
   * is aborted and a late response/error from the child we just left is
   * dropped by the sequence guard.
   */
  const requestKey = studentId ?? "__all__";
  const [loaded, setLoaded] = React.useState<{
    key: string;
    data: { reports: WeeklyReport[] } | null;
  } | null>(null);
  const requestSeq = React.useRef(0);

  React.useEffect(() => {
    const controller = new AbortController();
    const seq = ++requestSeq.current;
    const url = studentId
      ? `/api/parents/me/weekly-report?studentId=${encodeURIComponent(studentId)}`
      : "/api/parents/me/weekly-report";
    fetch(url, { cache: "no-store", signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (seq !== requestSeq.current) return; // superseded by a newer child
        setLoaded({ key: requestKey, data: d ?? null });
      })
      .catch(() => {
        if (seq === requestSeq.current && !controller.signal.aborted) {
          toast.error(t("parent.117"));
          // The fetch failed for THIS child: settle on the empty state instead
          // of a skeleton that would never resolve.
          setLoaded({ key: requestKey, data: null });
        }
      });
    return () => controller.abort();
  }, [requestKey, studentId, t]);

  const isCurrent = loaded !== null && loaded.key === requestKey;
  const data = isCurrent ? loaded.data : null;
  const loading = !isCurrent;

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }

  if (!data || data.reports.length === 0) {
    return (
      <Card>
        <CardContent className="py-10 text-center">
          <CalendarDays className="w-10 h-10 text-muted-foreground/40 mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">{t("parent.118")}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <button
        onClick={onClose}
        className="text-sm text-muted-foreground hover:text-foreground"
      >
        {t("parent.119")}</button>

      {data.reports.map((report, ri) => (
        <motion.div
          key={report.studentId}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: ri * 0.1 }}
          className="space-y-4"
        >
          {/* Header */}
          <Card className="glass card-hover overflow-hidden relative">
            <div className="absolute inset-x-0 top-0 h-1.5 bg-gradient-to-r from-emerald-500 via-teal-500 to-amber-500" />
            <CardContent className="p-5">
              <div className="flex items-center gap-3">
                <div className="grid place-items-center w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 text-white shadow-lg">
                  <CalendarDays className="w-6 h-6" />
                </div>
                <div className="min-w-0">
                  {/* Phase M4.3 — every card names its child by canonical id
                      (the key above) and prints name · Academic Level ·
                      course, so two children who share a course display name
                      are still unambiguous. */}
                  {/* Phase M4.5 — the heading is localized (audit M4-F13:
                      it was the last hard-coded English heading on a Parent
                      surface) and long child/course names WRAP instead of
                      stretching the card. */}
                  <h2 className="text-lg font-bold break-words">
                    {t("parent.weekly.titleFor", { p1: report.name })}
                  </h2>
                  <p className="text-xs text-muted-foreground break-words">
                    {academicLevelLabelFor(t, report.academicLevel)}
                    {report.course ? ` · ${report.course}` : ""}
                    {report.groupName ? ` · ${report.groupName}` : ""}
                  </p>
                  {/* The range reads in the locale's own order; both bounds are
                      server-formatted with the request locale already. */}
                  <p className="text-[11px] text-muted-foreground/80">
                    {t("parent.weekly.range", {
                      p1: report.weekRange.from,
                      p2: report.weekRange.to,
                    })}
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Summary stats */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <WeekStat
              icon={BookOpen}
              label={t("parent.weekly.lessonsViewed")}
              value={report.summary.lessonsViewed}
              color="from-emerald-400 to-teal-500"
            />
            <WeekStat
              icon={Trophy}
              label={t("parent.weekly.quizzesTaken")}
              value={report.summary.quizzesTaken}
              sub={t("parent.weekly.avgScore", { p1: report.summary.avgQuizScore })}
              color="from-amber-400 to-orange-500"
            />
            <WeekStat
              icon={ClipboardList}
              label={t("parent.weekly.homeworkSubmitted")}
              value={report.summary.homeworkSubmitted}
              color="from-teal-400 to-cyan-500"
            />
            <WeekStat
              icon={Activity}
              label={t("parent.weekly.activeDays")}
              value={`${report.summary.activeDays}/7`}
              color="from-orange-400 to-rose-500"
            />
          </div>

          {/* Daily activity heatmap */}
          <Card className="glass">
            <CardHeader>
              <CardTitle className="text-base">{t("parent.weekly.dailyActivity")}</CardTitle>
              <CardDescription className="text-xs">{t("parent.120")}</CardDescription>
            </CardHeader>
            <CardContent>
              {/* Phase M4.5 — 7 bounded columns (minmax(0,1fr)) with a
                  phone-sized gap, so the Arabic short weekday labels never
                  widen the card at 360px. */}
              <div className="grid grid-cols-7 gap-1 sm:gap-2">
                {report.dailyActivity.map((day, i) => {
                  const hasActivity = day.lessons > 0 || day.quizzes > 0 || day.homework > 0;
                  const totalActivity = day.lessons + day.quizzes + day.homework;
                  const intensity = totalActivity === 0 ? 0 : Math.min(100, totalActivity * 30);
                  return (
                    <motion.div
                      key={i}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: i * 0.05 }}
                      className="text-center min-w-0"
                    >
                      <div className="text-[10px] font-bold text-muted-foreground mb-1 min-w-0 leading-tight">
                        {day.day}
                      </div>
                      <div
                        className="aspect-square rounded-lg border-2 transition-all flex flex-col items-center justify-center p-1"
                        style={{
                          background: hasActivity
                            ? `oklch(0.62 0.15 162 / ${intensity / 100 + 0.05})`
                            : "transparent",
                          borderColor: hasActivity ? "oklch(0.62 0.15 162 / 30%)" : "oklch(0.91 0.01 165)",
                        }}
                      >
                        {hasActivity ? (
                          <div className="text-[9px] font-bold text-primary">
                            {totalActivity}
                          </div>
                        ) : (
                          <div className="text-[9px] text-muted-foreground/40">—</div>
                        )}
                        {day.attendance === "PRESENT" && (
                          <CheckCircle2 className="w-3 h-3 text-emerald-500 mt-0.5" />
                        )}
                        {day.attendance === "ABSENT" && (
                          <div className="w-2 h-2 rounded-full bg-rose-500 mt-0.5" />
                        )}
                      </div>
                      <div className="text-[8px] text-muted-foreground mt-0.5">{day.date}</div>
                    </motion.div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* Recent quizzes + homework */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Trophy className="w-4 h-4 text-amber-500" />
                  {t("parent.weekly.quizzesWeek")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {report.recentQuizzes.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("parent.121")}</p>
                ) : (
                  <div className="space-y-2">
                    {report.recentQuizzes.map((q, i) => (
                      <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                        <div className={`grid place-items-center w-8 h-8 rounded-lg ${
                          q.passed ? "bg-emerald-500/10 text-emerald-600" : "bg-amber-500/10 text-amber-600"
                        }`}>
                          {q.passed ? <CheckCircle2 className="w-4 h-4" /> : <Clock className="w-4 h-4" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold truncate" title={q.title}>{q.title}</div>
                          <div className="text-[10px] text-muted-foreground">{q.date}</div>
                        </div>
                        <Badge variant="outline" className={`text-[10px] ${
                          q.passed ? "border-emerald-400/30 text-emerald-600" : "border-amber-400/30 text-amber-600"
                        }`}>
                          {q.percentage}%
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="glass">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <ClipboardList className="w-4 h-4 text-teal-500" />
                  {t("parent.weekly.homeworkWeek")}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {report.recentHomework.length === 0 ? (
                  <p className="text-xs text-muted-foreground">{t("parent.122")}</p>
                ) : (
                  <div className="space-y-2">
                    {report.recentHomework.map((h, i) => (
                      <div key={i} className="flex items-center gap-3 p-2 rounded-lg bg-muted/30">
                        <div className="grid place-items-center w-8 h-8 rounded-lg bg-teal-500/10 text-teal-600">
                          <ClipboardList className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-xs font-semibold truncate" title={h.title}>{h.title}</div>
                          <div className="text-[10px] text-muted-foreground">{h.date}</div>
                        </div>
                        <Badge variant="outline" className={`text-[10px] ${
                          h.status === "GRADED" ? "border-emerald-400/30 text-emerald-600" :
                          h.status === "SUBMITTED" ? "border-amber-400/30 text-amber-600" :
                          "border-muted text-muted-foreground"
                        }`}>
                          {hwStatusLabel(t, h.status, h.grade)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </motion.div>
      ))}
    </div>
  );
}

/**
 * Phase M4.5 — a homework status is UI chrome, not data: the raw enum
 * ("SUBMITTED"/"LATE"/"PENDING") no longer leaks into the card. A graded row
 * keeps its mark exactly as before; every other status maps to the SAME
 * dictionary vocabulary the academic follow-up card already uses.
 */
function hwStatusLabel(
  t: (key: string, params?: Record<string, unknown>) => string,
  status: string,
  grade: number | null | undefined
): string {
  switch (status) {
    case "GRADED":
      return `${grade ?? 0}/10`;
    case "SUBMITTED":
      return t("parent.hw.submitted");
    case "LATE":
      return t("parent.hw.submittedLate");
    case "PENDING":
      return t("parent.hw.notSubmittedYet");
    default:
      return status;
  }
}

function WeekStat({
  icon: Icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: number | string;
  sub?: string;
  color: string;
}) {
  return (
    <Card className="glass card-hover stat-glow">
      <CardContent className="p-4">
        <div className={`grid place-items-center w-9 h-9 rounded-xl bg-gradient-to-br ${color} text-white mb-2`}>
          <Icon className="w-4 h-4" />
        </div>
        <div className="text-xl font-extrabold">{value}</div>
        <div className="text-xs text-muted-foreground">{label}</div>
        {sub && <div className="text-[10px] text-muted-foreground mt-0.5">{sub}</div>}
      </CardContent>
    </Card>
  );
}
